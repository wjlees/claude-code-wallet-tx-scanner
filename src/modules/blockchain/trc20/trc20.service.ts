import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TokenTypeId } from '../constants';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange } from '../parameter-store';
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
 *       to/owner 가 대상 주소면 in/out 으로 수집한다.
 *
 * NOTE: 추적할 개별 TRC20 컨트랙트 주소는 DB 에서 가져온다(현재는 전체 transfer 매칭).
 */
@Injectable()
export class Trc20Service implements TokenService, OnModuleInit {
  readonly symbol = 'trc20';
  readonly scanIntervalMs = 10000;
  private readonly logger = new Logger('Trc20Service');
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  private maxScanRange?: number;

  constructor(private readonly trx: TrxService) {}

  /** 기반 TRX 노드가 있을 때 scan range 조회. 없으면 log+skip. */
  async onModuleInit(): Promise<void> {
    if (!this.trx.getTronWeb()) {
      return;
    }
    const range = await getMaxScanRange(TRC20_PATH);
    if (range === undefined) {
      this.logger.log(`no maxScanRange for "${TRC20_PATH}" — scan skipped`);
      return;
    }
    this.maxScanRange = range;
  }

  getTokenTypeId(): number {
    return TokenTypeId.TRC20;
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const tronWeb = this.trx.getTronWeb();
    if (!tronWeb || this.maxScanRange === undefined) {
      warnMissingNode(this.logger, TRC20_PATH);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.trx.getBlockHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.maxScanRange - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await tronWeb.trx.getBlock(n);
      for (const tx of (block as any).transactions ?? []) {
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
        const contractAddr = v.contract_address
          ? tronWeb.address.fromHex(v.contract_address)
          : undefined;

        if (watch.has(toAddress) || (fromAddress && watch.has(fromAddress))) {
          txs.push({
            txHash: tx.txID,
            fromAddress,
            toAddress,
            amount: amount.toString(),
            blockNumber: n,
            // NOTE: contractAddr 는 추후 token assetId 해석(§5-6)에 사용 예정
            raw: { txID: tx.txID, contract: contractAddr },
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
