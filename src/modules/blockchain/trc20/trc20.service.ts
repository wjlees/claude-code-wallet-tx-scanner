import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TokenTypeId } from '../constants';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getConfirmations, getMaxDepositScanRange } from '../parameter-store';
import { TrxService } from '../trx/trx.service';

/** TRC20 transfer(address,uint256) 메서드 셀렉터 */
const TRANSFER_SELECTOR = 'a9059cbb';
/** 노드는 TRX(tron) 공유, scan range 는 토큰 자체 path(trc20) */
const TRC20_PATH = 'trc20';

/**
 * Tron TRC20 토큰.
 *
 * 기반 자산 TRX(TrxService)의 tronweb 노드를 재사용한다(새 connection 만들지 않음).
 * 스캔: cursor=마지막 스캔 블록번호. 블록의 TriggerSmartContract 중 transfer 호출을 디코드해
 *       **이 토큰(contractAddress)** 의 to/owner 가 대상 주소면 in/out 으로 수집한다.
 */
@Injectable()
export class Trc20Service implements TokenService, OnModuleInit {
  readonly symbol = 'trc20';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('Trc20Service');
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  private maxDepositScanRange?: number;
  /** reorg 안전 마진(스캔 끝 = head-confirmations). 미설정 0. */
  private confirmations = 0;

  constructor(private readonly trx: TrxService) {}

  /** 기반 TRX 노드가 있을 때 scan range 조회. 없으면 log+skip. */
  async onModuleInit(): Promise<void> {
    if (!this.trx.getTronWeb()) {
      return;
    }
    const range = await getMaxDepositScanRange(TRC20_PATH);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${TRC20_PATH}" — scan skipped`,
      );
      return;
    }
    this.maxDepositScanRange = range;
    this.confirmations = await getConfirmations(TRC20_PATH);
  }

  getTokenTypeId(): number {
    return TokenTypeId.TRC20;
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
    contractAddresses: string[],
  ): Promise<ScanResult> {
    const tronWeb = this.trx.getTronWeb();
    if (!tronWeb || this.maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, TRC20_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.trx.getBlockHeight();
    // confirmations 만큼 뒤처진 지점까지만(reorg 제외).
    const safeHead = Math.max(head - this.confirmations, 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + this.maxDepositScanRange - 1, safeHead);

    const watch = new Set(addresses);
    const contracts = new Set(contractAddresses); // 이 token_type 의 토큰 컨트랙트들
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await tronWeb.trx.getBlock(n);
      for (const tx of (block as any).transactions ?? []) {
        // status: 컨트랙트 실행 성공만. TRC20 은 로그가 아니라 call data 디코드라
        // 실패한 호출도 잡히므로 contractRet 체크가 필수(EVM 토큰과 대비).
        if (tx.ret?.[0]?.contractRet && tx.ret[0].contractRet !== 'SUCCESS') {
          continue;
        }
        const contract = tx.raw_data?.contract?.[0];
        if (!contract || contract.type !== 'TriggerSmartContract') continue;
        const v = contract.parameter?.value ?? {};
        const data: string = v.data ?? '';
        if (!data.startsWith(TRANSFER_SELECTOR)) continue;

        // transfer(address to, uint256 amount): 4byte selector + 32byte to + 32byte amount
        const toHex = '41' + data.slice(32, 72); // 마지막 20바이트 → Tron 주소(41 prefix)
        const toAddress = tronWeb.address.fromHex(toHex);
        const fromAddress = v.owner_address
          ? tronWeb.address.fromHex(v.owner_address)
          : undefined;
        const amount =
          data.length >= 136 ? BigInt('0x' + data.slice(72, 136)) : 0n;
        if (amount <= 0n) continue; // 0금액 제외
        const contractAddr = v.contract_address
          ? tronWeb.address.fromHex(v.contract_address)
          : undefined;
        // 이 token_type 에 속한 토큰 컨트랙트의 transfer 만.
        if (!contractAddr || !contracts.has(contractAddr)) continue;

        if (watch.has(toAddress) || (fromAddress && watch.has(fromAddress))) {
          txs.push({
            txHash: tx.txID,
            fromAddress,
            toAddress,
            contractAddress: contractAddr,
            amount: amount.toString(),
            blockNumber: n,
            raw: { txID: tx.txID },
          });
        }
      }
    }

    this.logger.log(
      `scanned blocks ${from}~${to} (TRC20) → ${txs.length} transfer`,
    );
    return { txs, nextCursor: String(to) };
  }

  async getTokenBalance(
    address: string,
    tokenAddress: string,
  ): Promise<string> {
    // TODO(RPC): TRC20 balanceOf(address) triggerConstantContract. 현재는 노드 유무만 점검.
    this.logger.log(`getTokenBalance(${address}, ${tokenAddress})`);
    return '0';
  }

  async getTokenMetadata(tokenAddress: string): Promise<unknown> {
    // TODO(RPC): name()/symbol()/decimals() triggerConstantContract.
    this.logger.log(`getTokenMetadata(${tokenAddress})`);
    return null;
  }
}
