import type { Wallet } from '../../../domain/entities/wallet.js';
import type { OpenWalletResult } from '../../../application/use-cases/open-wallet.use-case.js';

export function walletResponse(wallet: Wallet): OpenWalletResult {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
