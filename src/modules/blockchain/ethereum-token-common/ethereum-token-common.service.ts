import { Logger, OnModuleInit } from '@nestjs/common';
import { EthereumCommonService } from '../ethereum-common/ethereum-common.service';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { TokenService } from '../interfaces/token.interface';
import { warnMissingNode } from '../node-config';
import { getMaxDepositScanRange } from '../parameter-store';
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
  /** 1회 스캔 블록 수. onModuleInit 에서 ParamStore 로 조회. 미설정이면 핸들 미초기화→스캔 skip. */
  maxDepositScanRange?: number;
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

  readonly scanIntervalMs = 10000;

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

  /** 기반 노드(web3)가 있을 때 scan range 를 ParamStore(토큰 자체 path)로 조회. 없으면 log+skip. */
  async onModuleInit(): Promise<void> {
    if (!this.state.baseAssetService?.getWeb3()) {
      return;
    }
    const range = await getMaxDepositScanRange(this.state.config.path);
    if (range === undefined) {
      this.logger.log(
        `no maxDepositScanRange for "${this.state.config.path}" — scan skipped`,
      );
      return;
    }
    this.state.maxDepositScanRange = range;
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

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
    contractAddresses: string[],
  ): Promise<ScanResult> {
    const { baseAssetService, maxDepositScanRange } = this.state;
    const web3 = baseAssetService?.getWeb3();
    if (!web3 || maxDepositScanRange === undefined) {
      warnMissingNode(this.logger, this.state.config.path);
      return { txs: [], nextCursor: cursor };
    }

    const head = await baseAssetService!.getBlockHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + maxDepositScanRange - 1, head);

    const topics = addresses.map(toTopic);

    // 이 token_type 의 토큰들(contractAddresses)의 Transfer 만: address 로 컨트랙트들을 한정하고
    // to(topic2) 또는 from(topic1) 이 감시 주소인 로그 수집 후 dedupe.
    // (각 tx 는 toDetected 에서 log.address 로 contractAddress 가 채워져 토큰 분류 가능)
    const incoming = await web3.eth.getPastLogs({
      address: contractAddresses,
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, null, topics],
    } as any);
    const outgoing = await web3.eth.getPastLogs({
      address: contractAddresses,
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, topics],
    } as any);

    const byKey = new Map<string, DetectedTx>();
    for (const log of [...(incoming as any[]), ...(outgoing as any[])]) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (!byKey.has(key)) byKey.set(key, this.toDetected(log));
    }
    const txs = [...byKey.values()];

    this.logger.log(
      `scanned ${this.symbol} logs ${from}~${to} @ ${this.networkName} → ${txs.length} transfer`,
    );
    return { txs, nextCursor: String(to) };
  }

  private toDetected(log: any): DetectedTx {
    return {
      txHash: String(log.transactionHash),
      fromAddress: log.topics?.[1]
        ? '0x' + String(log.topics[1]).slice(26)
        : undefined,
      toAddress: log.topics?.[2]
        ? '0x' + String(log.topics[2]).slice(26)
        : undefined,
      // EVM 주소는 대소문자 무관(체크섬) → lowercase 로 정규화해 contractAddress→asset_id 분류 일치.
      contractAddress: log.address
        ? String(log.address).toLowerCase()
        : undefined,
      amount: log.data ? BigInt(log.data).toString() : undefined,
      blockNumber:
        log.blockNumber !== undefined ? Number(log.blockNumber) : undefined,
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
