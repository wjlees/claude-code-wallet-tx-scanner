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
  // TODO(DB): DB 연동 시 제거. EVM 은 동일 주소가 ETH/POLYGON/KLAY/KONET 공통.
  private readonly stubWallets: Wallet[] = [
    {
      assetIds: [AssetId.ETH, AssetId.POLYGON, AssetId.KLAY, AssetId.KONET],
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
   * 스캔 대상(`ScanTarget`)의 감지 주소 목록.
   * target → assetId 목록으로 해석한 뒤, 그 자산에 속한 지갑들의 주소를 모아 반환한다.
   */
  async getScanAddresses(target: ScanTarget): Promise<string[]> {
    const assetIds = await this.resolveAssetIds(target);
    const addresses = this.stubWallets
      .filter((w) => w.assetIds.some((id) => assetIds.includes(id)))
      .flatMap((w) => w.addresses);
    console.log(
      `[WalletService] getScanAddresses(${JSON.stringify(target)}) → assetIds=[${assetIds}] → ${addresses.length} addr (stub)`,
    );
    return addresses;
  }

  /**
   * `ScanTarget` 을 assetId 목록으로 해석한다.
   * - assetId: 그대로 포함
   * - tokenTypeId: 그 토큰이 올라간 기반 assetId 들을 조회해 포함
   * - 둘 다: 합집합 (한 번에 자산+토큰을 함께 스캔하는 통합 대상)
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

  // TODO(DB): 실제로는 token→asset 매핑을 DB 에서 조회. 현재는 고정 stub.
  private assetIdsOfToken(tokenTypeId: number): number[] {
    switch (tokenTypeId) {
      case TokenTypeId.ERC20:
        return [AssetId.ETH];
      case TokenTypeId.KIP7:
        return [AssetId.KLAY];
      case TokenTypeId.SPL:
        return [AssetId.SOL];
      case TokenTypeId.TRC20:
        return [AssetId.TRX];
      default:
        return [];
    }
  }
}
