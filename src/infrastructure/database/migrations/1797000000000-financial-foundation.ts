import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialFoundation1797000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE TABLE wallets (
 id text PRIMARY KEY, player_id text NOT NULL, currency text NOT NULL,
 balance numeric(30,2) NOT NULL, version integer NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CONSTRAINT uq_wallet_player_currency UNIQUE(player_id,currency),
 CONSTRAINT uq_wallet_context UNIQUE(id,player_id,currency),
 CONSTRAINT ck_wallet_balance CHECK(balance >= 0 AND balance <> 'NaN'::numeric),
 CONSTRAINT ck_wallet_currency CHECK(currency IN ('BRL','USD')),
 CONSTRAINT ck_wallet_version CHECK(version >= 1)
);
CREATE TABLE wager_transactions (
 id text PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
 idempotency_key text NOT NULL, payload_hash text NOT NULL,
 wallet_id text NOT NULL, player_id text NOT NULL, round_id text NOT NULL, game_id text NOT NULL,
 kind text NOT NULL, amount numeric(30,2) NOT NULL, currency text NOT NULL,
 reference_external_transaction_id text, reference_transaction_id text,
 status text NOT NULL, failure_code text, created_at timestamptz NOT NULL, processed_at timestamptz,
 result_balance numeric(30,2), result_version integer,
 reference_attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz,
 CONSTRAINT uq_wager_provider_external UNIQUE(provider_id,external_transaction_id),
 CONSTRAINT uq_wager_idempotency UNIQUE(idempotency_key),
 CONSTRAINT fk_wager_wallet FOREIGN KEY(wallet_id,player_id,currency) REFERENCES wallets(id,player_id,currency),
 CONSTRAINT fk_wager_reference FOREIGN KEY(reference_transaction_id) REFERENCES wager_transactions(id),
 CONSTRAINT ck_wager_kind CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 CONSTRAINT ck_wager_status CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 CONSTRAINT ck_wager_amount CHECK(amount >= 0 AND amount <> 'NaN'::numeric AND (kind = 'LOSS' OR amount > 0)),
 CONSTRAINT ck_wager_reference CHECK(kind NOT IN ('REFUND','ROLLBACK') OR NULLIF(btrim(reference_external_transaction_id),'') IS NOT NULL),
 CONSTRAINT ck_wager_processed_reference CHECK(status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
 CONSTRAINT ck_wager_reversal_reference CHECK(status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
 CONSTRAINT ck_wager_pending_reference CHECK(status <> 'PENDING_REFERENCE' OR NULLIF(btrim(reference_external_transaction_id),'') IS NOT NULL),
 CONSTRAINT ck_wager_failure CHECK(
   (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL AND failure_code IN (
    'INSUFFICIENT_FUNDS','INSUFFICIENT_REVERSAL_FUNDS','CURRENCY_MISMATCH','INVALID_AMOUNT','INVALID_REFERENCE',
    'INVALID_REFERENCE_KIND','REFERENCE_CONTEXT_MISMATCH','REFERENCE_AMOUNT_MISMATCH','REFERENCE_NOT_FOUND',
    'INVALID_KIND','EXTERNAL_OPENING_FORBIDDEN','INVALID_LEDGER','INVALID_TIMESTAMP','PERMANENT_INFRASTRUCTURE_FAILURE'))
   OR (status NOT IN ('REJECTED','FAILED') AND failure_code IS NULL)),
 CONSTRAINT ck_wager_result CHECK(
   (status = 'PROCESSED' AND processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_version IS NOT NULL)
   OR (status <> 'PROCESSED' AND processed_at IS NULL AND result_balance IS NULL AND result_version IS NULL)),
 CONSTRAINT ck_wager_result_value CHECK(result_balance >= 0 AND result_balance <> 'NaN'::numeric AND result_version >= 1),
 CONSTRAINT ck_wager_retry CHECK(reference_attempts >= 0),
 CONSTRAINT ck_wager_internal_identity CHECK(
   (kind = 'OPENING' AND provider_id = 'internal' AND game_id = 'internal' AND external_transaction_id = id AND idempotency_key = 'opening:' || wallet_id)
   OR (kind <> 'OPENING' AND provider_id <> 'internal' AND idempotency_key NOT LIKE 'opening:%'))
);
CREATE UNIQUE INDEX uq_wager_processed_reversal ON wager_transactions(reference_transaction_id,kind)
 WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX ix_wager_pending_reference ON wager_transactions(next_attempt_at,created_at,id)
 WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_wager_wallet ON wager_transactions(wallet_id);
CREATE INDEX ix_wager_reference ON wager_transactions(reference_transaction_id);
CREATE TABLE wallet_ledger_entries (
 id text PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets(id),
 transaction_id text NOT NULL REFERENCES wager_transactions(id),
 direction text NOT NULL, amount numeric(30,2) NOT NULL, currency text NOT NULL,
 balance_before numeric(30,2) NOT NULL, balance_after numeric(30,2) NOT NULL,
 created_at timestamptz NOT NULL,
 CONSTRAINT uq_ledger_wallet_transaction UNIQUE(wallet_id,transaction_id),
 CONSTRAINT ck_ledger_direction CHECK(direction IN ('DEBIT','CREDIT')),
 CONSTRAINT ck_ledger_amount CHECK(amount > 0 AND amount <> 'NaN'::numeric),
 CONSTRAINT ck_ledger_balances CHECK(balance_before >= 0 AND balance_after >= 0 AND balance_before <> 'NaN'::numeric AND balance_after <> 'NaN'::numeric),
 CONSTRAINT ck_ledger_arithmetic CHECK(
 (direction = 'DEBIT' AND balance_before - amount = balance_after) OR
 (direction = 'CREDIT' AND balance_before + amount = balance_after))
);
CREATE INDEX ix_ledger_wallet_cursor ON wallet_ledger_entries(wallet_id,created_at,id);
CREATE INDEX ix_ledger_transaction ON wallet_ledger_entries(transaction_id);
CREATE TABLE inbox_messages (
 consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
 received_at timestamptz NOT NULL, processed_at timestamptz,
 PRIMARY KEY(consumer_name,message_id)
);
CREATE TABLE outbox_messages (
 id text PRIMARY KEY, aggregate_id text NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
 occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_at timestamptz, published_at timestamptz
);
CREATE INDEX ix_outbox_pending ON outbox_messages(next_attempt_at,occurred_at,id) WHERE published_at IS NULL;

CREATE FUNCTION guard_wager() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref wager_transactions%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
   RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_terminal';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
   RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_terminal';
  END IF;
  IF ROW(NEW.id,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,NEW.reference_external_transaction_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,OLD.reference_external_transaction_id,OLD.created_at) THEN
   RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_identity';
  END IF;
 END IF;
 IF NEW.reference_transaction_id IS NOT NULL AND NEW.status = 'PROCESSED' THEN
  SELECT * INTO ref FROM wager_transactions WHERE id = NEW.reference_transaction_id;
  IF NOT FOUND OR ref.id = NEW.id OR ref.status <> 'PROCESSED'
    OR ROW(ref.provider_id,ref.external_transaction_id,ref.wallet_id,ref.player_id,ref.currency,ref.round_id)
       IS DISTINCT FROM ROW(NEW.provider_id,NEW.reference_external_transaction_id,NEW.wallet_id,NEW.player_id,NEW.currency,NEW.round_id)
    OR (NEW.kind IN ('WIN','REFUND') AND ref.kind <> 'BET')
    OR (NEW.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND'))
    OR (NEW.kind IN ('REFUND','ROLLBACK') AND ref.amount <> NEW.amount) THEN
   RAISE EXCEPTION 'invalid processed reference' USING ERRCODE = '23514', CONSTRAINT = 'ck_wager_reference_context';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_wager BEFORE INSERT OR UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION guard_wager();

CREATE FUNCTION guard_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx wager_transactions%ROWTYPE;
DECLARE expected text;
BEGIN
 SELECT * INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
 IF NOT FOUND OR tx.status <> 'PROCESSED' OR tx.kind = 'LOSS'
 OR ROW(tx.wallet_id,tx.currency,tx.amount) IS DISTINCT FROM ROW(NEW.wallet_id,NEW.currency,NEW.amount) THEN
  RAISE EXCEPTION 'ledger context mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ck_ledger_context';
 END IF;
 expected := CASE WHEN tx.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
 IF tx.kind = 'ROLLBACK' THEN
  SELECT CASE WHEN kind = 'BET' THEN 'CREDIT' ELSE 'DEBIT' END INTO expected FROM wager_transactions WHERE id = tx.reference_transaction_id;
 END IF;
 IF NEW.direction <> expected THEN
  RAISE EXCEPTION 'ledger direction mismatch' USING ERRCODE = '23514', CONSTRAINT = 'ck_ledger_context';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_ledger_insert BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_ledger_insert();
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is immutable' USING ERRCODE = '23514', CONSTRAINT = 'ck_ledger_immutable'; END $$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER immutable_ledger_truncate BEFORE TRUNCATE ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
DROP TABLE outbox_messages;
DROP TABLE inbox_messages;
DROP TABLE wallet_ledger_entries;
DROP FUNCTION reject_ledger_mutation();
DROP FUNCTION guard_ledger_insert();
DROP TABLE wager_transactions;
DROP FUNCTION guard_wager();
DROP TABLE wallets;
`);
  }
}
