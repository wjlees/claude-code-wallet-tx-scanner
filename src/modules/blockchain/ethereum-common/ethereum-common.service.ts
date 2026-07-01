import { Logger, OnModuleInit } from '@nestjs/common';
import Web3 from 'web3';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getConfirmations,
  getMaxDepositScanRange,
  getNodeUrlByPath,
} from '../parameter-store';
import { jsonRpcBatch, numberToHex } from './evm-batch';
import {
  EthereumBasedAssetType,
  ethereumBasedAssets,
} from './ethereum-based-assets';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태 (네트워크 설정 + 노드 핸들). */
interface EthereumCommonState {
  config: EthereumBasedAssetType;
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  web3?: Web3;
  /** 노드 URL (JSON-RPC batch 직접 호출용). onModuleInit 에서 저장. */
  nodeUrl?: string;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 스캔 안전 마진: 스캔 끝을 head-confirmations 로 캡(reorg 제외). 미설정 0. */
  confirmations?: number;
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
    this.state.confirmations = await getConfirmations(this.state.config.path);
    this.state.nodeUrl = url;
    this.state.web3 = new Web3(url);
    this.logger.log(
      `web3 initialized @ ${this.networkName} (maxDepositScanRange=${range}, confirmations=${this.state.confirmations})`,
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
    const { web3, nodeUrl, maxDepositScanRange, confirmations } = this.state;
    if (!web3 || !nodeUrl || maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, this.state.config.path);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.getBlockHeight();
    // confirmations 만큼 뒤처진 지점까지만 스캔(reorg 로 뒤집힐 최근 블록 제외).
    const safeHead = Math.max(head - (confirmations ?? 0), 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      // 아직 새로 확정된 블록 없음
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, safeHead);

    const watch = new Set(addresses.map((a) => a.toLowerCase()));

    // 1) 블록 범위를 hydrated(fullTransactions)로 batch+병렬 fetch.
    const blockNumbers: number[] = [];
    for (let n = from; n <= to; n++) blockNumbers.push(n);
    const blocks = await jsonRpcBatch(
      nodeUrl,
      blockNumbers.map((n) => ({
        method: 'eth_getBlockByNumber',
        params: [numberToHex(n), true],
      })),
    );

    // 2) from/to 매칭 + value>0(0금액/피싱 제외) 후보 수집.
    const candidates: { tx: any; blockNumber: number }[] = [];
    for (const block of blocks) {
      if (!block) continue;
      const bn = Number(block.number);
      for (const tx of block.transactions ?? []) {
        if (typeof tx === 'string') continue;
        const value = tx.value ? BigInt(tx.value) : 0n;
        if (value <= 0n) continue;
        const fromA = tx.from ? String(tx.from).toLowerCase() : undefined;
        const toA = tx.to ? String(tx.to).toLowerCase() : undefined;
        if ((fromA && watch.has(fromA)) || (toA && watch.has(toA))) {
          candidates.push({ tx, blockNumber: bn });
        }
      }
    }

    // 3) 후보 tx 만 receipt batch → status===1(성공)만 채택.
    const receipts = await jsonRpcBatch(
      nodeUrl,
      candidates.map((c) => ({
        method: 'eth_getTransactionReceipt',
        params: [c.tx.hash],
      })),
    );
    const txs: DetectedTx[] = [];
    candidates.forEach((c, i) => {
      const receipt = receipts[i];
      if (!receipt || BigInt(receipt.status ?? 0) !== 1n) return; // 실패 tx 제외
      txs.push({
        txHash: String(c.tx.hash),
        fromAddress: c.tx.from ? String(c.tx.from).toLowerCase() : undefined,
        toAddress: c.tx.to ? String(c.tx.to).toLowerCase() : undefined,
        amount: BigInt(c.tx.value).toString(),
        blockNumber: c.blockNumber,
        txIndex: 0, // 네이티브 전송은 tx 자체가 1건 → 위치 0
        raw: c.tx,
      });
    });

    this.logger.log(
      `scanned blocks ${from}~${to} @ ${this.networkName} (safeHead=${safeHead}) → ${txs.length} tx`,
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
