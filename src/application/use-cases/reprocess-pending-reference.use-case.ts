import type { EventContext } from '../services/financial-events.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerResult,
} from './process-wager-transaction.use-case.js';

export class ReprocessPendingReferenceUseCase {
  constructor(private readonly process: ProcessWagerTransactionUseCase) {}

  execute(
    transactionId: string,
    context: EventContext = {},
  ): Promise<ProcessWagerResult> {
    return this.process.reprocess(transactionId, context);
  }
}
