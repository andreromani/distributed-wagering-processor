import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RejectedSnapshots1797000001000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_result;
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_result CHECK (
 (status = 'PROCESSED' AND processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_version IS NOT NULL)
 OR (status IN ('REJECTED','FAILED') AND processed_at IS NULL
     AND ((result_balance IS NULL AND result_version IS NULL) OR (result_balance IS NOT NULL AND result_version IS NOT NULL)))
 OR (status IN ('PENDING','PENDING_REFERENCE') AND processed_at IS NULL AND result_balance IS NULL AND result_version IS NULL)
);
`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
ALTER TABLE wager_transactions DISABLE TRIGGER guard_wager;
UPDATE wager_transactions SET result_balance = NULL, result_version = NULL WHERE status IN ('REJECTED','FAILED');
ALTER TABLE wager_transactions ENABLE TRIGGER guard_wager;
ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_result;
ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_result CHECK (
 (status = 'PROCESSED' AND processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_version IS NOT NULL)
 OR (status <> 'PROCESSED' AND processed_at IS NULL AND result_balance IS NULL AND result_version IS NULL)
);
`);
  }
}
