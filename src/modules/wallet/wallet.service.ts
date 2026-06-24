import { Injectable } from '@nestjs/common';
import { Wallet, WalletType } from './wallet.types';

/**
 * 스캔 대상 지갑(hotwallet/coldwallet)을 제공한다.
 *
 * NOTE: 현재는 DB 연동 전 껍데기 구현이다.
 * 실제로는 DB에서 지갑 목록을 조회해야 하며, 지금은 무조건 고정된 주소를 반환한다.
 * DB 연동 시 이 클래스의 내부 구현만 교체하면 된다.
 */
@Injectable()
export class WalletService {
  // TODO(DB): DB 연동 시 제거. 현재는 고정 stub 데이터.
  private readonly stubWallets: Wallet[] = [
    {
      id: 'stub-hot-eth',
      address: '0x0000000000000000000000000000000000000001',
      symbol: 'ETH',
      type: WalletType.HOT,
    },
    {
      id: 'stub-cold-eth',
      address: '0x0000000000000000000000000000000000000002',
      symbol: 'ETH',
      type: WalletType.COLD,
    },
  ];

  /** 전체 스캔 대상 지갑 목록 */
  async getWallets(): Promise<Wallet[]> {
    console.log('[WalletService] getWallets() - returning stub wallets (DB not wired yet)');
    return this.stubWallets;
  }

  /**
   * 특정 심볼(자산/토큰)에 대해 스캔할 대상 주소 목록.
   * NOTE: DB 미연동 stub — 심볼과 무관하게 고정 stub 주소를 돌려준다.
   * 실제로는 해당 체인의 hot/cold 주소만 골라 반환해야 한다.
   */
  async getScanAddresses(symbol: string): Promise<string[]> {
    console.log(`[WalletService] getScanAddresses(${symbol}) - stub (fixed addresses)`);
    return this.stubWallets.map((w) => w.address);
  }

  /** 지갑 종류로 필터링 */
  async getWalletsByType(type: WalletType): Promise<Wallet[]> {
    console.log(`[WalletService] getWalletsByType(${type})`);
    return this.stubWallets.filter((w) => w.type === type);
  }

  /** 심볼로 필터링 */
  async getWalletsBySymbol(symbol: string): Promise<Wallet[]> {
    console.log(`[WalletService] getWalletsBySymbol(${symbol})`);
    return this.stubWallets.filter((w) => w.symbol === symbol);
  }
}
