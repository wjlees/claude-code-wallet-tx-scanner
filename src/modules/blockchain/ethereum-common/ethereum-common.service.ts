import { Logger, OnModuleInit } from '@nestjs/common';
import Web3 from 'web3';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getMaxDepositScanRange, getNodeUrlByPath } from '../parameter-store';
import {
  EthereumBasedAssetType,
  ethereumBasedAssets,
} from './ethereum-based-assets';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태 (네트워크 설정 + 노드 핸들). */
interface EthereumCommonState {
  config: EthereumBasedAssetType;
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  web3?: Web3;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
}

/**
 * 하나의 EVM 네트워크(assetId 단위: ETH / POLYGON / KLAY / KONET ...)를 담당.
 *
 * 노드: web3 (네트워크별 *_NODE_URL). 노드 핸들은 `onModuleInit` 에서 초기화한다 —
 *       URL 조회를 async 로 두어(지금은 env, 추후 DB/원격 설정 가능) await 할 수 있게.
 * 스캔: cursor=마지막 스캔 블록번호. cursor 다음 블록부터 head 까지 블록을 받아
 *       tx.from/to 가 대상 주소면 DetectedTx(in/out) 로 수집.
 */
export class EthereumCommonService implements AssetService, OnModuleInit {
  private readonly logger: Logger;
  /** 런타임 상태는 흩뿌리지 말고 한곳(state)에 모은다. */
  private readonly state: EthereumCommonState;

  readonly scanIntervalMs = 10000;

  constructor(private readonly assetId: number) {
    const config = ethereumBasedAssets[assetId];
    this.state = { config };
    this.logger = new Logger(`EthereumCommonService:${config.assetName}`);
  }

  /** 노드 핸들(web3) 초기화. URL 조회가 async 라서 생성자가 아닌 여기서 await 한다. */
  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (!url) {
      return; // 노드 미설정 → 스캔 skip (range 도 불필요)
    }
    // maxDepositScanRange 미설정 → 노드 미설정과 동일하게 log 후 skip (throw 안 함, 부팅은 계속)
    const range = await getMaxDepositScanRange(this.state.config.path);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${this.state.config.path}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
    this.state.web3 = new Web3(url);
    this.logger.log(
      `web3 initialized @ ${this.networkName} (maxDepositScanRange=${range})`,
    );
  }

  /** 노드 URL 조회. ParamStore path 기준 async 조회(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrlByPath(this.state.config.path);
  }

  getAssetId(): number {
    return this.assetId;
  }

  get symbol(): string {
    return this.state.config.assetName;
  }

  get networkName(): string {
    return this.state.config.networkName;
  }

  /** 토큰 서비스(ethereum-token-common)가 같은 노드를 재사용하도록 노출. */
  getWeb3(): Web3 | undefined {
    return this.state.web3;
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { web3 } = this.state;
    if (!web3) {
      warnMissingNode(this.logger, this.state.config.path);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.getBlockHeight();
    // cursor 없으면 현재 head 부터 추적 시작(전체 히스토리 여부는 운영 정책 — TODO).
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxDepositScanRange! - 1, head);

    const watch = new Set(addresses.map((a) => a.toLowerCase()));
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await web3.eth.getBlock(n, true);
      const blockTxs = (block?.transactions ?? []) as any[];
      for (const tx of blockTxs) {
        if (typeof tx === 'string') continue; // hydrated=true 면 객체여야 함
        const fromAddress = tx.from ? String(tx.from).toLowerCase() : undefined;
        const toAddress = tx.to ? String(tx.to).toLowerCase() : undefined;
        // from/to 중 하나라도 감시 주소면 기록(in/out 의미부여는 저장 단계에서)
        if (
          (fromAddress && watch.has(fromAddress)) ||
          (toAddress && watch.has(toAddress))
        ) {
          txs.push({
            txHash: String(tx.hash),
            fromAddress,
            toAddress,
            amount: tx.value !== undefined ? String(tx.value) : undefined,
            blockNumber: n,
            raw: tx,
          });
        }
      }
    }

    this.logger.log(
      `scanned blocks ${from}~${to} @ ${this.networkName} → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  async getBalance(address: string): Promise<string> {
    const { web3 } = this.state;
    if (!web3) {
      warnMissingNode(this.logger, this.state.config.path);
      return '0';
    }
    const wei = await web3.eth.getBalance(address);
    return wei.toString();
  }

  async getBlockHeight(): Promise<number> {
    const { web3 } = this.state;
    if (!web3) {
      warnMissingNode(this.logger, this.state.config.path);
      return 0;
    }
    return Number(await web3.eth.getBlockNumber());
  }
}
