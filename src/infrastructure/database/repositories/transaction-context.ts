import type { EntityManager } from 'typeorm';

export function requireTransaction(manager: EntityManager): void {
  if (
    !manager.queryRunner?.isTransactionActive ||
    manager.queryRunner.isReleased
  )
    throw new Error('An active transaction is required');
}
