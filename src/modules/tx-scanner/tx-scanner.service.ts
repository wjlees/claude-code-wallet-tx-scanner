import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BlockchainService } from '../blockchain/blockchain.service';
import { AssetId, TokenTypeId } from '../blockchain/constants';
import { AssetService } from '../blockchain/interfaces/asset.interface';
import { TokenService } from '../blockchain/interfaces/token.interface';
import { DetectedTx, ScanTarget } from '../blockchain/interfaces/scan.types';
import { WalletService } from '../wallet/wallet.service';
import { toSatoshi } from '../blockchain/crypto-util';
import {
  DETECTED_TRANSACTIONS_REPOSITORY,
  DetectedTransactionsRepository,
  InsertDetectedTransactionParams,
} from './detected-transactions.repository';
import {
  WALLET_SCANNER_ASSET_REPOSITORY,
  WalletScannerAssetRepository,
} from './wallet-scanner-asset.repository';
import {
  TOKEN_REPOSITORY,
  TokenRepository,
  TokenRow,
} from './token.repository';
import { UNSPENTS_REPOSITORY, UnspentsRepository } from './unspents.repository';
import { ScanRunner } from './scan-runner';

/** 워치독 점검 주기(ms). */
const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * **통합 러너 쌍(§22)** — 감지 메커니즘이 같아 코인+토큰을 한 루프로 도는 조합.
 * 러너를 어떻게 구성할지는 tx-scanner 의 책임이라 여기(내부 상수)에 둔다 —
 * blockchain 층은 "코인 서비스가 contractAddresses 를 받을 수 있다"는 능력만 제공.
 * SOL+SPL: 블록(getParsedBlock) 하나에 native delta(pre/postBalances)와 SPL delta
 * (pre/postTokenBalances)가 함께 있어 한 번 파싱으로 둘 다 얻는다(블록 이중 다운로드 방지).
 * (EVM 은 감지 RPC 가 달라 — native=블록/receipt, erc20=getLogs — 합칠 수 없음)
 */
const UNIFIED_SCAN_PAIRS: { assetId: number; tokenTypeId: number }[] = [
  { assetId: AssetId.SOL, tokenTypeId: TokenTypeId.SPL },
];

/**
 * 대상 주소의 모든 in/out tx 를 감지하여 저장하는 스캐너.
 *
 * 루프 전략: **대상별 독립 무한 루프(평소) + 워치독(안전망)**.
 *  - 대상마다 노드·스캔 방식·속도가 달라 대상별 ScanRunner 를 하나씩 돌린다(HOL blocking 방지).
 *  - 워치독은 죽은/정체 루프를 점검·재시작한다. **`@Cron` 을 쓰지 않고** `setInterval` 로
 *    주기 호출한다(monorepo 는 scheduler_manager 가 watchdog 를 등록·주기 호출 — 매핑 §6 참고).
 *  - 각 루프는 진행 지점을 `WalletScannerAssetRepository`(wallet_scanner_asset.start_block_number)에
 *    영속화하므로 재시작/재가동 후 마지막 지점부터 이어서 스캔한다(at-least-once).
 *  - 감지 tx 는 `DetectedTransactionsRepository`(detected_transactions)에 직접 저장한다
 *    (DetectedTx ≈ DB 컬럼이라 별도 매퍼 없이 그대로 매핑).
 */
@Injectable()
export class TxScannerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxScannerService.name);
  private runners: ScanRunner[] = [];
  private watchdogTimer?: NodeJS.Timeout;

  constructor(
    private readonly blockchain: BlockchainService,
    private readonly wallets: WalletService,
    @Inject(DETECTED_TRANSACTIONS_REPOSITORY)
    private readonly detectedRepository: DetectedTransactionsRepository,
    @Inject(WALLET_SCANNER_ASSET_REPOSITORY)
    private readonly scannerAssetRepository: WalletScannerAssetRepository,
    @Inject(TOKEN_REPOSITORY)
    private readonly tokenRepository: TokenRepository,
    @Inject(UNSPENTS_REPOSITORY)
    private readonly unspentsRepository: UnspentsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const assetServices = this.blockchain.getAllAssetServices();
    const tokenServices = this.blockchain.getAllTokenServices();

    // 통합 러너 쌍(§22 — SOL+SPL 등): 코인/토큰 개별 러너 대신 both-set 러너 1개.
    const unifiedAssetIds = new Set(UNIFIED_SCAN_PAIRS.map((p) => p.assetId));
    const unifiedTokenTypeIds = new Set(
      UNIFIED_SCAN_PAIRS.map((p) => p.tokenTypeId),
    );

    // 코인(네이티브 자산): 자산당 러너 1개.
    for (const service of assetServices) {
      if (unifiedAssetIds.has(service.getAssetId())) continue; // 통합 러너가 담당
      this.runners.push(this.createAssetRunner(service));
    }

    // 토큰: 한 토큰 서비스(=token_type)당 러너 1개. main.token 에서 그 타입의 토큰 목록
    // [(assetId, contractAddress)] 을 받아 **한 루프**로 스캔하고, 결과 tx 를 contractAddress
    // 로 분류해 각 토큰의 asset_id 로 저장한다. 진행지점은 그 토큰 행들이 함께 갱신된다.
    for (const service of tokenServices) {
      if (unifiedTokenTypeIds.has(service.getTokenTypeId())) continue; // 통합 러너가 담당
      const tokens = await this.tokenRepository.getTokensByType(
        service.getTokenTypeId(),
      );
      if (tokens.length === 0) {
        continue; // 추적할 토큰이 없으면 러너를 만들지 않는다.
      }
      this.runners.push(this.createTokenRunner(service, tokens));
    }

    // 통합 러너: 코인 서비스가 contractAddresses 를 받아 native+token 행을 한 파싱에 생성.
    for (const pair of UNIFIED_SCAN_PAIRS) {
      const service = assetServices.find(
        (s) => s.getAssetId() === pair.assetId,
      );
      if (!service) continue;
      const tokens = await this.tokenRepository.getTokensByType(
        pair.tokenTypeId,
      );
      this.runners.push(
        this.createUnifiedRunner(service, pair.tokenTypeId, tokens),
      );
    }

    this.runners.forEach((r) => r.start());
    this.logger.log(`started ${this.runners.length} independent scan loop(s)`);

    // 워치독 주기 호출 (monorepo 에선 scheduler_manager 가 담당)
    this.watchdogTimer = setInterval(
      () => this.watchdog(),
      WATCHDOG_INTERVAL_MS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    await Promise.all(this.runners.map((r) => r.stop()));
  }

  /** 코인 러너: 자산 1개. 저장/진행지점 키 = 코인 assetId. */
  private createAssetRunner(service: AssetService): ScanRunner {
    const assetId = service.getAssetId();
    const rawDecimal = service.getRawDecimal();
    const target: ScanTarget = { assetId };
    return new ScanRunner(
      target,
      service,
      [], // 코인은 컨트랙트 목록 없음
      () => this.wallets.getScanAddresses(target),
      (txs) => this.saveDetected(assetId, rawDecimal, txs),
      () => this.scannerAssetRepository.getStartBlockNumber(assetId),
      (sbn) => this.scannerAssetRepository.updateStartBlockNumber(assetId, sbn),
      this.logger,
    );
  }

  /**
   * 토큰 러너: token_type 1개(여러 토큰을 한 루프로). contractAddress→assetId 맵으로 분류 저장하고,
   * 진행지점은 이 타입의 토큰 행들을 **모두 같은 값으로** 갱신한다(같이 도므로).
   */
  private createTokenRunner(
    service: TokenService,
    tokens: TokenRow[],
  ): ScanRunner {
    const target: ScanTarget = { tokenTypeId: service.getTokenTypeId() };
    const contractAddresses = tokens.map((t) => t.contractAddress);
    // contractAddress → { assetId, rawDecimal }. (토큰 decimals = main.token.token_decimal)
    const infoByContract = new Map(
      tokens.map((t) => [
        t.contractAddress,
        { assetId: t.assetId, rawDecimal: t.rawDecimal },
      ]),
    );
    const assetIds = tokens.map((t) => t.assetId);
    return new ScanRunner(
      target,
      service,
      contractAddresses,
      () => this.wallets.getScanAddresses(target),
      (txs) => this.saveDetectedTokens(infoByContract, txs),
      // 같은 타입의 토큰 행은 값이 같으므로 대표(첫 토큰) 행에서 로드.
      () => this.scannerAssetRepository.getStartBlockNumber(assetIds[0]),
      // 이 타입의 모든 토큰 행을 같은 값으로 갱신.
      async (sbn) => {
        for (const id of assetIds) {
          await this.scannerAssetRepository.updateStartBlockNumber(id, sbn);
        }
      },
      this.logger,
    );
  }

  /**
   * 통합 러너(§22): 코인+토큰을 한 루프로. 저장은 행의 `contractAddress` 유무로 분리 —
   * 없으면 코인(assetId), 있으면 토큰(contractAddress→asset_id 분류). 진행지점은
   * 코인 행 + 이 token_type 의 토큰 행들을 **모두 같은 값으로** 갱신(같이 도므로 §10).
   */
  private createUnifiedRunner(
    service: AssetService,
    tokenTypeId: number,
    tokens: TokenRow[],
  ): ScanRunner {
    const assetId = service.getAssetId();
    const rawDecimal = service.getRawDecimal();
    const target: ScanTarget = { assetId, tokenTypeId };
    const contractAddresses = tokens.map((t) => t.contractAddress);
    const infoByContract = new Map(
      tokens.map((t) => [
        t.contractAddress,
        { assetId: t.assetId, rawDecimal: t.rawDecimal },
      ]),
    );
    const tokenAssetIds = tokens.map((t) => t.assetId);
    return new ScanRunner(
      target,
      service,
      contractAddresses,
      () => this.wallets.getScanAddresses(target),
      async (txs) => {
        const coinTxs = txs.filter((t) => !t.contractAddress);
        const tokenTxs = txs.filter((t) => t.contractAddress);
        if (coinTxs.length > 0) {
          await this.saveDetected(assetId, rawDecimal, coinTxs);
        }
        if (tokenTxs.length > 0) {
          await this.saveDetectedTokens(infoByContract, tokenTxs);
        }
      },
      // 코인 행을 대표로 로드(토큰 행들도 같은 값으로 유지되므로 동일).
      () => this.scannerAssetRepository.getStartBlockNumber(assetId),
      async (sbn) => {
        await this.scannerAssetRepository.updateStartBlockNumber(assetId, sbn);
        for (const id of tokenAssetIds) {
          await this.scannerAssetRepository.updateStartBlockNumber(id, sbn);
        }
      },
      this.logger,
    );
  }

  /**
   * DetectedTx → InsertParams.
   * - `amount` = `toSatoshi(raw, rawDecimal)`(자산 decimals), 원본은 `rawAmount`.
   * - `feeAmount` = `toSatoshi(feeRaw, feeRawDecimal)`. **수수료는 항상 native(base) 자산**이라
   *   base 자산 decimals 기준. 코인=자기 rawDecimal, 토큰=기반 체인 코인 rawDecimal.
   *   `feeRawDecimal` 없으면 fee 환산 skip(rawFeeAmount 만 보존).
   */
  private toInsertParams(
    assetId: number,
    rawDecimal: number,
    tx: DetectedTx,
    feeRawDecimal?: number,
  ): InsertDetectedTransactionParams {
    return {
      assetId,
      fromAddress: tx.fromAddress,
      toAddress: tx.toAddress,
      txId: tx.txHash,
      txIndex: tx.txIndex ?? 0,
      blockNumber: tx.blockNumber,
      amount: tx.amount != null ? toSatoshi(tx.amount, rawDecimal) : '0',
      rawAmount: tx.amount,
      feeAmount:
        tx.feeAmount != null && feeRawDecimal != null
          ? toSatoshi(tx.feeAmount, feeRawDecimal)
          : undefined,
      rawFeeAmount: tx.feeAmount,
      note: tx.memoId,
      status: tx.status ?? 1, // 체인 성공여부(1 성공/0 실패). 미설정이면 성공.
    };
  }

  /** 코인 DetectedTx 저장. amount·fee 모두 코인 rawDecimal(native)로 사토시 환산. */
  private async saveDetected(
    assetId: number,
    rawDecimal: number,
    txs: DetectedTx[],
  ): Promise<void> {
    for (const tx of txs) {
      await this.detectedRepository.insertDetectedTransactions(
        this.toInsertParams(assetId, rawDecimal, tx, rawDecimal),
      );
      await this.maintainUnspents(assetId, tx);
    }
  }

  /**
   * UTXO 원장(wallet_scanner_unspents, §17) 유지 — UTXO 계열 행에만 부가정보(utxo)가 있다.
   * 수신(created): UTXO INSERT(usable=1). 소비(spentOutpoints): usable=0 + spent_tx_id.
   * (재스캔은 유니크 키/미존재 무시로 멱등.)
   */
  private async maintainUnspents(
    assetId: number,
    tx: DetectedTx,
  ): Promise<void> {
    if (!tx.utxo) return;
    if (tx.utxo.created && tx.toAddress && tx.amount != null) {
      await this.unspentsRepository.insertUnspent({
        assetId,
        address: tx.toAddress,
        txId: tx.txHash,
        txIndex: tx.txIndex ?? 0,
        amount: tx.amount, // UTXO 는 blockchain 층에서 이미 satoshi 정수
        blockNumber: tx.blockNumber,
      });
    }
    if (tx.utxo.spentOutpoints?.length) {
      await this.unspentsRepository.markSpent(
        assetId,
        tx.utxo.spentOutpoints,
        tx.txHash,
        tx.blockNumber,
      );
    }
  }

  /**
   * 토큰 DetectedTx 저장: 각 tx 의 `contractAddress` 로 어느 토큰(assetId·rawDecimal)인지 분류해
   * 그 토큰 rawDecimal 로 사토시 환산 후 그 asset_id 로 insert(한 token_type 루프가 여러 토큰 처리).
   */
  private async saveDetectedTokens(
    infoByContract: Map<string, { assetId: number; rawDecimal: number }>,
    txs: DetectedTx[],
  ): Promise<void> {
    for (const tx of txs) {
      // 정확 매칭 우선, 실패 시 lowercase fallback(EVM 체크섬 대응; SPL/TRC20 base58 은 정확 매칭에서 끝남).
      const info = tx.contractAddress
        ? (infoByContract.get(tx.contractAddress) ??
          infoByContract.get(tx.contractAddress.toLowerCase()))
        : undefined;
      if (info === undefined) {
        continue; // 추적 대상 토큰이 아니면 skip
      }
      // feeRawDecimal 생략: 토큰 수수료는 기반 체인 코인이라 그 코인 rawDecimal 이 필요.
      // 현재 토큰은 fee 미산출(receipt 미조회) → fee 환산 skip. (token fee 추가 시 base coin decimal 전달)
      await this.detectedRepository.insertDetectedTransactions(
        this.toInsertParams(info.assetId, info.rawDecimal, tx),
      );
    }
  }

  /**
   * §17/§23 UTXO 백필(일회성 프로비저닝): 감시 주소들의 **현재 살아있는 UTXO 전부**를
   * scantxoutset 으로 조회해 `wallet_scanner_unspents` 에 적재한다.
   * 용도: 이미 잔고가 있는 주소(기존 유저 입금주소 등)를 감시 목록에 추가할 때 —
   * forward 스캔은 추가 시점 이후의 UTXO 만 잡으므로 과거분은 이걸로 채운다.
   * 유니크 키 `(asset_id, tx_id, tx_index)` 로 멱등(재실행 안전). 스캔 루프와 분리된
   * 수동 트리거 — monorepo 는 HTTP 프로비저닝 엔드포인트에서 호출.
   */
  async backfillUnspents(
    assetId: number,
    addresses?: string[],
  ): Promise<{ scannedAddresses: number; utxos: number }> {
    const service = this.blockchain.getAssetService(assetId) as {
      listLiveUtxos?: (addrs: string[]) => Promise<
        {
          txId: string;
          txIndex: number;
          address: string;
          amountSat: string;
          height: number;
        }[]
      >;
    };
    if (typeof service.listLiveUtxos !== 'function') {
      throw new Error(`asset#${assetId} does not support UTXO backfill`);
    }
    const targets =
      addresses ?? (await this.wallets.getScanAddresses({ assetId }));
    if (targets.length === 0) {
      return { scannedAddresses: 0, utxos: 0 };
    }
    const utxos = await service.listLiveUtxos(targets);
    for (const u of utxos) {
      await this.unspentsRepository.insertUnspent({
        assetId,
        address: u.address,
        txId: u.txId,
        txIndex: u.txIndex,
        amount: u.amountSat,
        blockNumber: u.height,
      });
    }
    this.logger.log(
      `[backfill] asset#${assetId}: ${targets.length} addr → ${utxos.length} live UTXO(s) loaded`,
    );
    return { scannedAddresses: targets.length, utxos: utxos.length };
  }

  /**
   * 워치독: 죽었거나 오래 정체된 루프를 감지해 재시작한다. (스캔은 하지 않음)
   * `@Cron` 이 아니라 setInterval 로 주기 호출된다(monorepo 는 scheduler_manager).
   */
  watchdog(): void {
    for (const runner of this.runners) {
      if (!runner.isRunning()) {
        this.logger.warn(`[${runner.label}] not running → restart`);
        runner.start();
        continue;
      }
      // 기대 간격의 10배(최소 1분) 넘게 진행이 없으면 정체로 간주.
      const threshold = Math.max(runner.expectedIntervalMs * 10, 60_000);
      if (runner.msSinceActivity() > threshold) {
        this.logger.warn(
          `[${runner.label}] stalled for ${runner.msSinceActivity()}ms (no progress) — check node/RPC`,
        );
        // NOTE: 강제 재시작은 hung RPC await 를 끊지 못하므로 경고만 한다.
      }
    }
  }
}
