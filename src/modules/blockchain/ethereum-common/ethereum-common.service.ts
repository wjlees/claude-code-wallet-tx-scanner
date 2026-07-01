import { Logger, OnModuleInit } from '@nestjs/common';
import Web3 from 'web3';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import {
  getConfirmationThreshold,
  getMaxDepositScanRange,
  getNodeUrlByPath,
} from '../parameter-store';
import {
  EthereumBasedAssetType,
  ethereumBasedAssets,
} from './ethereum-based-assets';

/** 한 JSON-RPC batch 페이로드에 담는 최대 요청 수. */
const BATCH_CHUNK = 100;

function numberToHex(n: number): string {
  return '0x' + n.toString(16);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태 (네트워크 설정 + 노드 핸들). */
interface EthereumCommonState {
  config: EthereumBasedAssetType;
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  web3?: Web3;
  /** 노드 URL (JSON-RPC batch 직접 호출용). onModuleInit 에서 저장. */
  nodeUrl?: string;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
  /** 스캔 안전 마진: 스캔 끝을 head-confirmationThreshold 로 캡(reorg 제외). 미설정 0. */
  confirmationThreshold?: number;
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
    this.state.confirmationThreshold = await getConfirmationThreshold(
      this.state.config.path,
    );
    this.state.nodeUrl = url;
    this.state.web3 = new Web3(url);
    this.logger.log(
      `web3 initialized @ ${this.networkName} (maxDepositScanRange=${range}, confirmationThreshold=${this.state.confirmationThreshold})`,
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
    const { web3, nodeUrl, maxDepositScanRange, confirmationThreshold } =
      this.state;
    if (!web3 || !nodeUrl || maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, this.state.config.path);
      return { txs: [], nextCursor: cursor };
    }

    const head = await this.getBlockHeight();
    // confirmationThreshold 만큼 뒤처진 지점까지만 스캔(reorg 로 뒤집힐 최근 블록 제외).
    const safeHead = Math.max(head - (confirmationThreshold ?? 0), 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) {
      // 아직 새로 확정된 블록 없음
      return { txs: [], nextCursor: String(safeHead) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, safeHead);

    const watch = new Set(addresses.map((a) => a.toLowerCase()));

    // 1) 블록 범위를 hydrated(fullTransactions)로 fetch (usingBatchRequest 에 따라 batch/promise).
    const blockNumbers: number[] = [];
    for (let n = from; n <= to; n++) blockNumbers.push(n);
    const blocks = await this.getBlocks(blockNumbers);

    // 2) from/to 매칭 + value>0(0금액/피싱 제외) 후보 수집. (blockNumber 는 요청값으로)
    const candidates: { tx: any; blockNumber: number }[] = [];
    blockNumbers.forEach((bn, i) => {
      const block = blocks[i];
      if (!block) return;
      for (const tx of block.transactions ?? []) {
        if (typeof tx === 'string') continue;
        const value = tx.value != null ? BigInt(tx.value) : 0n;
        if (value <= 0n) continue;
        const fromA = tx.from ? String(tx.from).toLowerCase() : undefined;
        const toA = tx.to ? String(tx.to).toLowerCase() : undefined;
        if ((fromA && watch.has(fromA)) || (toA && watch.has(toA))) {
          candidates.push({ tx, blockNumber: bn });
        }
      }
    });

    // 3) 후보 tx 만 receipt fetch → status===1(성공)만 채택.
    const receipts = await this.getReceipts(candidates.map((c) => c.tx.hash));
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

  /**
   * 블록 범위를 hydrated(fullTransactions)로 조회. `usingBatchRequest` 에 따라
   * JSON-RPC batch(한 페이로드) 또는 web3 개별 호출 Promise.all 병렬.
   * 반환은 요청 순서와 동일.
   */
  private async getBlocks(numbers: number[]): Promise<any[]> {
    if (this.state.config.usingBatchRequest) {
      return this.jsonRpcBatch(
        numbers.map((n) => ({
          method: 'eth_getBlockByNumber',
          params: [numberToHex(n), true],
        })),
      );
    }
    const web3 = this.state.web3!;
    return Promise.all(numbers.map((n) => web3.eth.getBlock(n, true)));
  }

  /** 후보 tx 의 receipt 조회. batch/promise 모드는 getBlocks 와 동일 정책. */
  private async getReceipts(hashes: string[]): Promise<any[]> {
    if (hashes.length === 0) return [];
    if (this.state.config.usingBatchRequest) {
      return this.jsonRpcBatch(
        hashes.map((h) => ({
          method: 'eth_getTransactionReceipt',
          params: [h],
        })),
      );
    }
    const web3 = this.state.web3!;
    return Promise.all(hashes.map((h) => web3.eth.getTransactionReceipt(h)));
  }

  /**
   * JSON-RPC batch: 요청을 청크로 나눠 각 청크를 배열 페이로드 1회로 보내고(왕복↓),
   * 청크들은 Promise.all 로 병렬 전송. 결과는 입력 순서대로 정렬.
   */
  private async jsonRpcBatch(
    calls: { method: string; params: unknown[] }[],
  ): Promise<any[]> {
    if (calls.length === 0) return [];
    const url = this.state.nodeUrl!;
    const perChunk = await Promise.all(
      chunk(calls, BATCH_CHUNK).map(async (group) => {
        const body = group.map((c, i) => ({
          jsonrpc: '2.0',
          id: i,
          method: c.method,
          params: c.params,
        }));
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`JSON-RPC batch HTTP ${res.status}`);
        }
        const json = (await res.json()) as { id: number; result?: any }[];
        const byId = new Map(json.map((j) => [j.id, j.result]));
        return group.map((_, i) => byId.get(i));
      }),
    );
    return perChunk.flat();
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
