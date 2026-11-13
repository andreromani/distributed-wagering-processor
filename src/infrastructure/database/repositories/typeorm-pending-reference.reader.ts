import { DataSource } from 'typeorm';
import type {
  PendingReferenceCandidate,
  PendingReferenceReader,
} from '../../../application/ports/pending-reference-reader.js';
import { ensureDatabaseConnection } from '../database-connection.js';

export class TypeOrmPendingReferenceReader implements PendingReferenceReader {
  constructor(private readonly source: DataSource) {}

  async findDue(
    now: Date,
    expiredBefore: Date,
    limit: number,
  ): Promise<PendingReferenceCandidate[]> {
    await ensureDatabaseConnection(this.source);
    return this.source.query<PendingReferenceCandidate[]>(
      `SELECT id AS "transactionId", reference_attempts AS "referenceAttempts"
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1 OR created_at <= $2)
       ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC
       LIMIT $3`,
      [now, expiredBefore, limit],
    );
  }
}
