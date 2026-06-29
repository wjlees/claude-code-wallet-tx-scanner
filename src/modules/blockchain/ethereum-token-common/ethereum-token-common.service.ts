import { Logger, OnModuleInit } from '@nestjs/common';
import { EthereumCommonService } from '../ethereum-common/ethereum-common.service';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getMaxScanRange } from '../parameter-store';
import {
  EthereumBasedTokenType,
  ethereumBasedTokens,
} from './ethereum-based-tokens';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** 주소를 32바이트 topic 으로 패딩 */
function toTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface EthereumTokenCommonState {
  config: EthereumBasedTokenType;
  /** 기반 EVM 자산 서비스(노드 web3 재사용). 없으면 스캔 skip. */
  baseAssetService?: EthereumCommonService;
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회(필수, 누락 시 throw). */
  maxScanRange?: number;
}

/**
 * 하나의 토큰 타입(tokenTypeId: ERC20 / KIP7 ...)을 담당.
 *
 * 기반 EVM 자산(baseAssetId)의 `EthereumCommonService` 를 재사용해 같은 노드(web3)로
 * eth_getLogs 를 호출한다(새 노드를 만들지 않음). cursor=마지막 스캔 블록번호.
 * Transfer 이벤트에서 from/to(topic1/topic2)가 대상 주소면 in/out 으로 수집.
 */
export class EthereumTokenCommonService implements TokenService, OnModuleInit {
  private readonly logger: Logger;
  private readonly state: EthereumTokenCommonState;

  readonly scanIntervalMs = 2000;

  constructor(
    private readonly tokenTypeId: number,
    ethereumCommonServices: EthereumCommonService[],
  ) {
    const config = ethereumBasedTokens[tokenTypeId];
    const baseAssetService = ethereumCommonServices.find(
      (s) => s.getAssetId() === config.baseAssetId,
    );
    this.state = { config, baseAssetService };
    this.logger = new Logger(`EthereumTokenCommonService:${config.tokenName}`);
    if (!baseAssetService) {
      this.logger.warn(
        `no base EthereumCommonService for baseAssetId=${config.baseAssetId}`,
      );
    }
  }

  /** 기반 노드(web3)가 있으면 scan range 를 ParamStore 로 조회(필수, 누락 시 throw). */
  async onModuleInit(): Promise<void> {
    if (this.state.baseAssetService?.getWeb3()) {
      this.state.maxScanRange = await getMaxScanRange(
        `${this.networkName.toUpperCase()}_MAX_SCAN_RANGE`,
      );
    }
  }

  getTokenTypeId(): number {
    return this.tokenTypeId;
  }

  get symbol(): string {
    return this.state.config.tokenName;
  }

  get networkName(): string {
    return this.state.config.networkName;
  }

  private get nodeEnvKey(): string {
    return `${this.networkName.toUpperCase()}_NODE_URL`;
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { baseAssetService } = this.state;
    const web3 = baseAssetService?.getWeb3();
    if (!web3) {
      warnMissingNode(this.logger, this.nodeEnvKey);
      return { txs: [], nextCursor: cursor };
    }

    const head = await baseAssetService!.getBlockHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.state.maxScanRange! - 1, head);

    const topics = addresses.map(toTopic);
    const txs: DetectedTx[] = [];

    // 들어오는 전송: topic2(to) 가 대상 주소
    const incoming = await web3.eth.getPastLogs({
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, null, topics],
    } as any);
    for (const log of incoming as any[]) {
      txs.push(this.toDetected(log, 'in'));
    }

    // 나가는 전송: topic1(from) 이 대상 주소
    const outgoing = await web3.eth.getPastLogs({
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, topics],
    } as any);
    for (const log of outgoing as any[]) {
      txs.push(this.toDetected(log, 'out'));
    }

    this.logger.log(
      `scanned ${this.symbol} logs ${from}~${to} @ ${this.networkName} → ${txs.length} transfer`,
    );
    return { txs, nextCursor: String(to) };
  }

  private toDetected(log: any, direction: 'in' | 'out'): DetectedTx {
    const fromAddr = log.topics?.[1]
      ? '0x' + String(log.topics[1]).slice(26)
      : undefined;
    const toAddr = log.topics?.[2]
      ? '0x' + String(log.topics[2]).slice(26)
      : undefined;
    const self = direction === 'in' ? toAddr : fromAddr;
    const counterparty = direction === 'in' ? fromAddr : toAddr;
    return {
      txHash: String(log.transactionHash),
      direction,
      address: self ?? '',
      counterparty,
      amount: log.data ? BigInt(log.data).toString() : undefined,
      raw: log,
    };
  }

  async getTokenBalance(
    address: string,
    tokenAddress: string,
  ): Promise<string> {
    // TODO(RPC): ERC20 balanceOf(address) eth_call. 현재는 기반 노드 유무만 점검.
    this.logger.log(`getTokenBalance(${address}, ${tokenAddress})`);
    return '0';
  }

  async getTokenMetadata(tokenAddress: string): Promise<unknown> {
    // TODO(RPC): name()/symbol()/decimals() eth_call.
    this.logger.log(`getTokenMetadata(${tokenAddress})`);
    return null;
  }
}
