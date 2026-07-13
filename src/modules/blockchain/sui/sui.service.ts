import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
// ESM 전용 패키지의 타입을 CJS 에서 참조 — resolution-mode attribute(TS 5.3+, monorepo 동일 방식).
// eslint-disable-next-line prettier/prettier
import type { SuiGrpcClient } from '@mysten/sui/grpc' with {
  'resolution-mode': 'import',
};
import { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { Inject } from '@nestjs/common';
import { ASSET_REPOSITORY, AssetRepository } from '../asset.repository';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getMaxDepositScanRange,
  getNodeUrlByPath,
  getRawDecimal,
} from '../parameter-store';

const SUI_PATH = 'sui';
/** GetCheckpoint 동시 요청 상한(청크 내 병렬, 청크 간 순차) — 429/노드 과부하 완화. */
const CHECKPOINT_CHUNK = 25;

/**
 * native SUI coin type 판별. ⚠️ gRPC 응답의 coinType 은 **풀 주소형**
 * (`0x0000…0002::sui::SUI`)이라 `'0x2::sui::SUI'` 문자열 비교는 절대 매치 안 됨(라이브 확인).
 * 주소부를 BigInt 로 정규화해 비교한다. (그 외 coin_type = sui 토큰 — 추후 contractAddress)
 */
function isNativeSui(coinType?: string): boolean {
  if (!coinType) return false;
  const [addr, mod, name] = coinType.split('::');
  if (mod !== 'sui' || name !== 'SUI') return false;
  try {
    return BigInt(addr) === 2n;
  } catch {
    return false;
  }
}

/**
 * ⚠️ `@mysten/sui` 는 ESM 전용인데 빌드가 CJS 라 TS 가 `import()` 를 `require()` 로
 * 변환해 ERR_REQUIRE_ESM 이 난다 → Function 생성자로 native dynamic import 를 보존.
 * (monorepo 도 CJS 변환 빌드면 동일 트릭 필요 — 번들러가 import() 를 보존하면 불필요)
 */
const importEsm = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<any>;

/** gRPC GasCostSummary(bigint 필드) → 총 수수료(raw MIST). fee = computation + storage − rebate. */
function calcGasFee(gasUsed: {
  computationCost?: bigint;
  storageCost?: bigint;
  storageRebate?: bigint;
}): bigint {
  return (
    (gasUsed.computationCost ?? 0n) +
    (gasUsed.storageCost ?? 0n) -
    (gasUsed.storageRebate ?? 0n)
  );
}

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface SuiState {
  /** onModuleInit 에서 초기화(ESM dynamic import). 노드 미설정이면 undefined(스캔 skip). */
  grpcClient?: SuiGrpcClient;
  /** 1회 스캔 checkpoint 수. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** checkpoint 는 BFT 최종이라 보통 0. */
  confirmationThreshold?: number;
  /** 원본 최소단위 자릿수(MIST=9). 사토시 환산용. */
  rawDecimal?: number;
}

/**
 * Sui (SUI). 네이티브 코인.
 *
 * 노드: **gRPC 단독**(fullnode 직접 서빙 — JSON-RPC 는 2026-07 종료, GraphQL 은 별도
 *   인덱서 스택이라 bare fullnode 에 없음). `SuiGrpcClient`(@mysten/sui/grpc) +
 *   `GrpcTransport`(@protobuf-ts/grpc-transport, @grpc/grpc-js).
 * 스캔: cursor=checkpoint sequence number. **forward checkpoint 스캔** —
 *   `LedgerService.GetCheckpoint(n)` 응답의 `transactions[].balanceChanges` 가 인라인이라
 *   주소별 질의·per-digest 조회 불필요. 범위 RPC(구 getCheckpoints)는 gRPC 에 없어
 *   GetCheckpoint 를 **병렬(Promise.all)** 로 요청(HTTP/2 멀티플렉싱).
 * 금액: balance_changes 의 native(0x2::sui::SUI) delta — 최대 감소=from,
 *   **양수 delta 각각을 수신자 행으로**(한 tx 다중 수신 대응 — SOL 과 동일 §20).
 *   fee-payer(≈최대 감소 주소)∈watch 일 때만 fee(§14).
 */
@Injectable()
export class SuiService implements AssetService, OnModuleInit {
  readonly symbol = 'sui';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('SuiService');
  private readonly state: SuiState = {};

  constructor(
    @Inject(ASSET_REPOSITORY)
    private readonly assetRepository: AssetRepository,
  ) {}

  getAssetId(): number {
    return AssetId.SUI;
  }

  getRawDecimal(): number {
    return this.state.rawDecimal ?? 8;
  }

  async onModuleInit(): Promise<void> {
    const url = await getNodeUrlByPath(SUI_PATH);
    if (!url) {
      return; // 노드 미설정 → 스캔 skip
    }
    const range = await getMaxDepositScanRange(SUI_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${SUI_PATH}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.confirmationThreshold =
      await this.assetRepository.getConfirmThresholdById(this.getAssetId());
    this.state.rawDecimal = await getRawDecimal(SUI_PATH);

    // ESM 전용 패키지 → dynamic import(위 트릭)로 로드.
    const { SuiGrpcClient } = await importEsm('@mysten/sui/grpc');
    const transport = new GrpcTransport({
      host: url.replace(/^https:\/\//, ''),
      channelCredentials: ChannelCredentials.createSsl(),
    });
    this.state.grpcClient = new SuiGrpcClient({
      network: 'mainnet',
      transport,
    });
    this.logger.log(
      `gRPC client initialized (maxDepositScanRange=${range}, confirmationThreshold=${this.state.confirmationThreshold})`,
    );
  }

  /**
   * balance_changes 에서 native SUI 이동 파싱: 최대 감소=from(gas 포함이라 fee-payer 근사),
   * **양수 delta 전부=수신자 목록**(한 tx 다중 수신 대응 §20 — '최대 증가 1명=to' 는
   * 배치 전송에서 누락 유발). 수신자는 주소 정렬 — txIndex 가 응답 순서·watch 구성과
   * 무관하게 결정적이도록.
   */
  private parseNativeBalanceChanges(
    balanceChanges: { address?: string; coinType?: string; amount?: string }[],
  ): {
    fromAddress?: string;
    recipients: { address: string; amount: bigint }[];
  } {
    let fromAddress: string | undefined;
    let minDelta = 0n;
    const recipients: { address: string; amount: bigint }[] = [];
    for (const change of balanceChanges) {
      if (!isNativeSui(change.coinType) || !change.address) continue;
      const delta = BigInt(change.amount ?? 0);
      if (delta < minDelta) {
        minDelta = delta;
        fromAddress = change.address;
      }
      if (delta > 0n) {
        recipients.push({ address: change.address, amount: delta });
      }
    }
    recipients.sort((a, b) => (a.address < b.address ? -1 : 1));
    return { fromAddress, recipients };
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { grpcClient, maxDepositScanRange, confirmationThreshold } =
      this.state;
    if (!grpcClient || maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, SUI_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const info = await grpcClient.ledgerService.getServiceInfo({});
    const head = Number(info.response.checkpointHeight ?? 0n);
    const safeHead = Math.max(head - (confirmationThreshold ?? 0), 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, safeHead);

    // 범위 RPC 없음(구 getCheckpoints 폐지) → GetCheckpoint 병렬. balance_changes 인라인 요청.
    // ⚠️ getServiceInfo 의 checkpointHeight 가 노드가 실제 서빙하는 것보다 앞설 수 있어(서빙 랙,
    //   라이브 확인) 실패 checkpoint 는 null 처리 후 **연속 성공 구간까지만** 진행(다음 사이클 재시도).
    // SUI 는 checkpoint 생성이 빠르다(~4.5/s ≈ 45개/10s) → range 는 생성 속도보다 커야
    // 뒤처지지 않음(권장 100 = 2x 여유). 429/과부하를 피하려고 **청크 단위 병렬**로 요청
    // (청크 내 Promise.all, 청크 간 순차 — EVM BATCH_CHUNK 와 동일 패턴). 청크에서 실패가
    // 나오면 이후 청크는 요청하지 않는다(연속 성공 구간 전진이라 어차피 버려짐).
    const seqs: number[] = [];
    for (let n = from; n <= to; n++) seqs.push(n);
    type CpResult = Awaited<
      ReturnType<typeof grpcClient.ledgerService.getCheckpoint>
    >;
    const results: (CpResult | null)[] = [];
    for (let i = 0; i < seqs.length; i += CHECKPOINT_CHUNK) {
      const chunk = seqs.slice(i, i + CHECKPOINT_CHUNK);
      const part = await Promise.all(
        chunk.map((n) =>
          grpcClient.ledgerService
            .getCheckpoint({
              checkpointId: {
                oneofKind: 'sequenceNumber',
                sequenceNumber: BigInt(n),
              },
              readMask: {
                paths: [
                  'sequence_number',
                  'transactions.digest',
                  'transactions.effects',
                  'transactions.balance_changes',
                ],
              },
            })
            .then(
              (r) => r,
              () => null,
            ),
        ),
      );
      results.push(...part);
      if (part.includes(null)) break; // 실패 발견 → 이후 청크 요청 생략(429/서빙랙 완화)
    }
    let okCount = results.findIndex((r) => r === null);
    if (okCount === -1) okCount = results.length;
    if (okCount === 0) {
      return { txs: [], nextCursor: cursor }; // 노드가 아직 head 못 따라옴 → 다음 사이클
    }
    const effectiveTo = from + okCount - 1;

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];
    results.slice(0, okCount).forEach((r, i) => {
      const n = seqs[i];
      for (const tx of r!.response.checkpoint?.transactions ?? []) {
        const status = tx.effects?.status?.success === false ? 0 : 1;
        const { fromAddress, recipients } = this.parseNativeBalanceChanges(
          tx.balanceChanges ?? [],
        );
        // 실패 tx 는 gas 차감만 남아 최대 감소 주소=fee-payer → §14 from∈watch 감지가 그대로 동작.
        const isFrom = !!fromAddress && watch.has(fromAddress);
        if (!isFrom && status !== 1) continue; // 수신은 성공 tx 만

        const feeAmount =
          isFrom && tx.effects?.gasUsed
            ? calcGasFee(tx.effects.gasUsed).toString()
            : undefined;
        // §20: 수신자별 행 분리. originate 면 전 수신자, 수신이면 watch 수신자만.
        // txIndex=전체(정렬) 수신자 인덱스 — watch 구성과 무관해 재스캔에도 멱등 키 안정.
        let emitted = 0;
        recipients.forEach((rc, txIndex) => {
          if (!isFrom && !watch.has(rc.address)) return;
          txs.push({
            txHash: tx.digest ?? '',
            fromAddress,
            toAddress: rc.address,
            amount: (status === 1 ? rc.amount : 0n).toString(),
            feeAmount: emitted === 0 ? feeAmount : undefined, // fee 중복 합산 방지
            status,
            blockNumber: n,
            txIndex,
            raw: { digest: tx.digest },
          });
          emitted++;
        });
        // 우리가 originate 했는데 수신 행이 없으면(실패 tx=gas 만 소모) fee 기록용 단독 행.
        if (isFrom && emitted === 0) {
          txs.push({
            txHash: tx.digest ?? '',
            fromAddress,
            amount: '0',
            feeAmount,
            status,
            blockNumber: n,
            txIndex: 0,
            raw: { digest: tx.digest },
          });
        }
      }
    });

    this.logger.log(
      `scanned checkpoints ${from}~${effectiveTo} (SUI, safeHead=${safeHead}) → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(effectiveTo) };
  }

  async getBalance(address: string): Promise<string> {
    const { grpcClient } = this.state;
    if (!grpcClient) {
      warnMissingNode(this.logger, SUI_PATH);
      return '0';
    }
    // coinType 생략 = native SUI(SDK 기본값 0x2::sui::SUI)
    const { balance } = await grpcClient.getBalance({ owner: address });
    return balance.balance;
  }

  async getBlockHeight(): Promise<number> {
    const { grpcClient } = this.state;
    if (!grpcClient) {
      warnMissingNode(this.logger, SUI_PATH);
      return 0;
    }
    const info = await grpcClient.ledgerService.getServiceInfo({});
    return Number(info.response.checkpointHeight ?? 0n);
  }
}
