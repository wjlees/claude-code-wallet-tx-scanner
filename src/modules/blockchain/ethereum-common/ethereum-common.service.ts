import { Logger, OnModuleInit } from '@nestjs/common';
import Web3 from 'web3';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getNodeUrl } from '../parameter-store';
import {
  EthereumBasedAssetType,
  ethereumBasedAssets,
} from './ethereum-based-assets';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태 (네트워크 설정 + 노드 핸들). */
interface EthereumCommonState {
  config: EthereumBasedAssetType;
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  web3?: Web3;
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

  readonly scanIntervalMs = 2000;
  private readonly batchSize = 1000;

  constructor(private readonly assetId: number) {
    const config = ethereumBasedAssets[assetId];
    this.state = { config };
    this.logger = new Logger(`EthereumCommonService:${config.assetName}`);
  }

  /** 노드 핸들(web3) 초기화. URL 조회가 async 라서 생성자가 아닌 여기서 await 한다. */
  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (url) {
      this.state.web3 = new Web3(url);
      this.logger.log(`web3 initialized @ ${this.networkName}`);
    }
  }

  /** 노드 URL 조회. parameter.json(→env) 에서 async 로 가져온다(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getNodeUrl(this.state.config.networkName);
  }

  private get nodeEnvKey(): string {
    return `${this.networkName.toUpperCase()}_NODE_URL`;
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
      warnMissingNode(this.logger, this.nodeEnvKey);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.getBlockHeight();
    // cursor 없으면 현재 head 부터 추적 시작(전체 히스토리 여부는 운영 정책 — TODO).
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.batchSize - 1, head);

    const watch = new Set(addresses.map((a) => a.toLowerCase()));
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const block = await web3.eth.getBlock(n, true);
      const blockTxs = (block?.transactions ?? []) as any[];
      for (const tx of blockTxs) {
        if (typeof tx === 'string') continue; // hydrated=true 면 객체여야 함
        const txFrom = tx.from ? String(tx.from).toLowerCase() : undefined;
        const txTo = tx.to ? String(tx.to).toLowerCase() : undefined;
        if (txTo && watch.has(txTo)) {
          txs.push(this.toDetected(tx, 'in', tx.to, tx.from));
        }
        if (txFrom && watch.has(txFrom)) {
          txs.push(this.toDetected(tx, 'out', tx.from, tx.to));
        }
      }
    }

    this.logger.log(
      `scanned blocks ${from}~${to} @ ${this.networkName} → ${txs.length} tx`,
    );
    return { txs, nextCursor: String(to) };
  }

  private toDetected(
    tx: any,
    direction: 'in' | 'out',
    address: string,
    counterparty?: string,
  ): DetectedTx {
    return {
      txHash: String(tx.hash),
      direction,
      address,
      counterparty: counterparty ? String(counterparty) : undefined,
      amount: tx.value !== undefined ? String(tx.value) : undefined,
      raw: tx,
    };
  }

  async getBalance(address: string): Promise<string> {
    const { web3 } = this.state;
    if (!web3) {
      warnMissingNode(this.logger, this.nodeEnvKey);
      return '0';
    }
    const wei = await web3.eth.getBalance(address);
    return wei.toString();
  }

  async getBlockHeight(): Promise<number> {
    const { web3 } = this.state;
    if (!web3) {
      warnMissingNode(this.logger, this.nodeEnvKey);
      return 0;
    }
    return Number(await web3.eth.getBlockNumber());
  }
}
