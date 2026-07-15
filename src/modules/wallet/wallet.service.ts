import { Injectable } from '@nestjs/common';
import { AssetId, TokenTypeId } from '../blockchain/constants';
import { ScanTarget } from '../blockchain/interfaces/scan.types';
import { Wallet } from './wallet.types';

/**
 * 스캔 대상 지갑(주소 묶음)을 제공한다.
 *
 * NOTE: 현재는 DB 연동 전 껍데기 구현이다. 실제로는 DB에서 조회하며,
 * DB 연동 시 이 클래스의 내부 구현만 교체하면 된다(시그니처 유지).
 */
@Injectable()
export class WalletService {
  // TODO(DB): DB 연동 시 제거. EVM 은 동일 주소가 konet/klay/cross/base 공통.
  private readonly stubWallets: Wallet[] = [
    {
      assetIds: [AssetId.KONET, AssetId.KLAY, AssetId.CROSS, AssetId.BASE],
      addresses: [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ],
    },
  ];

  /** 전체 스캔 대상 지갑 묶음 */
  async getWallets(): Promise<Wallet[]> {
    console.log('[WalletService] getWallets() - stub (DB not wired yet)');
    return this.stubWallets;
  }

  /**
   * UTXO 계열 자산(§23): **유저 입금주소 전체**가 스캔 대상에 포함돼야 한다.
   * 비-UTXO 체인은 입금이 즉시 핫월렛으로 포워딩되지만, UTXO 는 포워딩 없이
   * 유저 입금주소에 UTXO 가 머물고 출금도 그 UTXO 들을 vin 으로 직접 조합한다
   * (핫월렛 경유 없음) — 그래서 핫/콜드만 보면 입금·출금 모두 누락된다.
   */
  private readonly utxoAssetIds: number[] = [AssetId.BTC, AssetId.BCH];

  /**
   * 스캔 대상(`ScanTarget`)의 감지 주소 목록.
   * target → assetId 목록으로 해석한 뒤, 그 자산에 속한 지갑들의 주소를 모으고,
   * UTXO 자산이면 유저 입금주소 전체를 합친다(§23).
   */
  async getScanAddresses(target: ScanTarget): Promise<string[]> {
    const assetIds = await this.resolveAssetIds(target);
    const addresses = new Set(
      this.stubWallets
        .filter((w) => w.assetIds.some((id) => assetIds.includes(id)))
        .flatMap((w) => w.addresses),
    );
    for (const assetId of assetIds) {
      if (!this.utxoAssetIds.includes(assetId)) continue;
      for (const addr of await this.getUserDepositAddresses(assetId)) {
        addresses.add(addr);
      }
    }
    console.log(
      `[WalletService] getScanAddresses(${JSON.stringify(target)}) → assetIds=[${assetIds}] → ${addresses.size} addr (stub)`,
    );
    return [...addresses];
  }

  /**
   * 유저 입금주소 전체(UTXO 백필·스캔용).
   * NOTE: 실제로는 유저 입금주소 테이블(crypto_deposit_wallet 류) 조회 —
   *   주소 수가 크므로 monorepo 는 캐싱(예: 30s) 권장. 현재는 stub.
   */
  // TODO(DB): 유저 입금주소 테이블 조회로 교체.
  private async getUserDepositAddresses(assetId: number): Promise<string[]> {
    console.log(
      `[WalletService] getUserDepositAddresses(${assetId}) - stub (DB not wired yet)`,
    );
    return [];
  }

  /**
   * `ScanTarget` 을 **주소 조회용** assetId 목록으로 해석한다.
   * - 코인(`assetId`): 그대로 포함.
   * - 토큰(`tokenTypeId`): 그 토큰이 올라간 **기반 체인** assetId 들을 포함(주소는 기반 체인 지갑 주소).
   *   토큰의 `tokenAssetId`(토큰 자체 id)는 저장 키일 뿐 지갑 주소 키가 아니므로 여기서 쓰지 않는다.
   */
  private async resolveAssetIds(target: ScanTarget): Promise<number[]> {
    const ids = new Set<number>();
    if (target.assetId !== undefined) {
      ids.add(target.assetId);
    }
    if (target.tokenTypeId !== undefined) {
      for (const id of this.assetIdsOfToken(target.tokenTypeId)) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  // TODO(DB): 실제로는 token→asset 매핑을 DB(main.token) 에서 조회. 현재는 기반 체인 stub.
  private assetIdsOfToken(tokenTypeId: number): number[] {
    switch (tokenTypeId) {
      case TokenTypeId.KIP7:
        return [AssetId.KLAY];
      case TokenTypeId.KONETTOKEN:
        return [AssetId.KONET];
      case TokenTypeId.BASETOKEN:
        return [AssetId.BASE];
      case TokenTypeId.SPL:
        return [AssetId.SOL];
      case TokenTypeId.TRC20:
        return [AssetId.TRX];
      default:
        return [];
    }
  }
}
