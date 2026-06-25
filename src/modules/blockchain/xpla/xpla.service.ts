import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LCDClient } from '@xpla/xpla.js';
import { AssetId } from '../constants';
import { AssetService } from '../interfaces/asset.interface';
import { DetectedTx, ScanResult } from '../interfaces/scan.types';
import { warnMissingNode } from '../node-config';
import { getParameter } from '../parameter-store';

const XPLA_LCD_ENV = 'XPLA_LCD_URL';
/** XPLA 네이티브 denom */
const XPLA_DENOM = 'axpla';

/** 이 인스턴스가 도는 동안 유지하는 런타임 상태. */
interface XplaState {
  /** onModuleInit 에서 초기화. 노드 미설정이면 undefined(스캔 skip). */
  lcd?: LCDClient;
}

/**
 * XPLA Chain (XPLA). Cosmos SDK 기반 독립 체인.
 *
 * 노드: @xpla/xpla.js LCDClient (XPLA_LCD_URL + XPLA_CHAIN_ID). 핸들은 onModuleInit 에서 초기화.
 * 스캔: cursor=마지막 스캔 블록 높이. 블록별 tx 를 받아 Cosmos `transfer` 이벤트의
 *       recipient/sender 가 대상 주소면 in/out 으로 수집. memo 는 입금 식별용(memoId).
 */
@Injectable()
export class XplaService implements AssetService, OnModuleInit {
  readonly symbol = 'xpla';
  readonly scanIntervalMs = 3000;
  private readonly batchSize = 10;
  private readonly logger = new Logger('XplaService');
  private readonly state: XplaState = {};

  getAssetId(): number {
    return AssetId.XPLA;
  }

  async onModuleInit(): Promise<void> {
    const url = await this.resolveNodeUrl();
    if (url) {
      const chainID = (await getParameter('XPLA_CHAIN_ID')) ?? 'dimension_37-1';
      this.state.lcd = new LCDClient({ URL: url, chainID });
      this.logger.log('LCDClient initialized');
    }
  }

  /** 노드 URL 조회. parameter.json(→env) 에서 async 로 가져온다(추후 DB/원격 설정 교체 가능). */
  private async resolveNodeUrl(): Promise<string | undefined> {
    return getParameter(XPLA_LCD_ENV);
  }

  async scanTransactions(
    addresses: string[],
    cursor: string | null,
  ): Promise<ScanResult> {
    const { lcd } = this.state;
    if (!lcd) {
      warnMissingNode(this.logger, XPLA_LCD_ENV);
      return { txs: [], nextCursor: cursor };
    }

    const head = await lcd.latestHeight();
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) {
      return { txs: [], nextCursor: String(head) };
    }
    const to = Math.min(from + this.batchSize - 1, head);

    const watch = new Set(addresses);
    const txs: DetectedTx[] = [];

    for (let n = from; n <= to; n++) {
      const infos = await lcd.tx.txInfosByHeight(n);
      for (const info of infos) {
        const memo = (info.tx as any)?.body?.memo || undefined;
        const recipients = info.getEventAttributeValues(
          'transfer',
          'recipient',
        );
        const senders = info.getEventAttributeValues('transfer', 'sender');
        const amounts = info.getEventAttributeValues('transfer', 'amount');
        for (let i = 0; i < recipients.length; i++) {
          const recipient = recipients[i];
          const sender = senders[i];
          const amount = amounts[i];
          if (watch.has(recipient)) {
            txs.push(
              this.toDetected(
                info.txhash,
                'in',
                recipient,
                sender,
                amount,
                memo,
              ),
            );
          }
          if (sender && watch.has(sender)) {
            txs.push(
              this.toDetected(
                info.txhash,
                'out',
                sender,
                recipient,
                amount,
                memo,
              ),
            );
          }
        }
      }
    }

    this.logger.log(`scanned blocks ${from}~${to} (XPLA) → ${txs.length} tx`);
    return { txs, nextCursor: String(to) };
  }

  private toDetected(
    txhash: string,
    direction: 'in' | 'out',
    address: string,
    counterparty: string | undefined,
    amount: string | undefined,
    memoId: string | undefined,
  ): DetectedTx {
    return {
      txHash: txhash,
      direction,
      address,
      counterparty,
      amount,
      memoId,
      raw: { txhash },
    };
  }

  async getBalance(address: string): Promise<string> {
    const { lcd } = this.state;
    if (!lcd) {
      warnMissingNode(this.logger, XPLA_LCD_ENV);
      return '0';
    }
    const [coins] = await lcd.bank.balance(address);
    return coins.get(XPLA_DENOM)?.amount.toString() ?? '0';
  }

  async getBlockHeight(): Promise<number> {
    const { lcd } = this.state;
    if (!lcd) {
      warnMissingNode(this.logger, XPLA_LCD_ENV);
      return 0;
    }
    return lcd.latestHeight();
  }
}
