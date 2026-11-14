import type { PendingReferenceReader } from '../../../application/ports/pending-reference-reader.js';
import type { ReprocessPendingReferenceUseCase } from '../../../application/use-cases/reprocess-pending-reference.use-case.js';
import { defaultReferenceRetryPolicy } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionStatus as Status } from '../../../domain/financial.types.js';
import {
  shutdownDrainMs,
  type WorkerOptions,
} from '../../config/worker-options.js';
import { transactionCancellation } from '../../database/transaction-cancellation.js';
import { MessagingDiagnostics } from '../messaging-diagnostics.js';
import { retryDelay, waitForWorker } from '../retry-delay.js';
import { classifyMessageError } from './message-error-classifier.js';

export class PendingReferenceWorker {
  readonly #poll = new AbortController();
  readonly #work = new AbortController();
  #stopping = false;
  #loop: Promise<void> | undefined;

  constructor(
    private readonly reader: PendingReferenceReader,
    private readonly reprocess: Pick<
      ReprocessPendingReferenceUseCase,
      'execute'
    >,
    private readonly options: WorkerOptions,
    private readonly diagnostics: MessagingDiagnostics,
    private readonly now: () => Date = () => new Date(),
    private readonly wait = waitForWorker,
  ) {}

  start(): void {
    if (this.#loop || this.#stopping) {
      return;
    }

    this.diagnostics.event('pending_reference_worker_started');
    this.#loop = this.run();
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.#stopping) {
      try {
        await this.processBatch(
          AbortSignal.any([
            this.#work.signal,
            AbortSignal.timeout(this.options.processingTimeoutMs),
          ]),
        );
        failures = 0;
      } catch {
        failures = Math.min(31, failures + 1);
        if (!this.#stopping) {
          this.diagnostics.increment('pendingReferenceFailures');
          this.diagnostics.event('pending_reference_poll_failed');
        }
      }

      await this.wait(
        failures === 0
          ? this.options.pendingReferencePollMs
          : retryDelay(
              failures,
              Math.max(
                this.options.pendingReferencePollMs,
                this.options.retryBaseSeconds * 1000,
              ),
              Math.max(
                this.options.pendingReferencePollMs,
                this.options.retryMaxSeconds * 1000,
              ),
            ),
        this.#poll.signal,
      );
    }
  }

  async processBatch(
    signal: AbortSignal = AbortSignal.timeout(this.options.processingTimeoutMs),
  ): Promise<number> {
    if (this.#stopping) {
      return 0;
    }

    signal.throwIfAborted();
    const now = this.now();
    const candidates = await this.reader.findDue(
      now,
      new Date(now.getTime() - defaultReferenceRetryPolicy.ttlMs),
      this.options.pendingReferenceBatchSize,
    );
    let processed = 0;
    for (const candidate of candidates) {
      if (this.#stopping) {
        break;
      }

      signal.throwIfAborted();
      const fields = {
        transactionId: candidate.transactionId,
        correlationId: candidate.transactionId,
        walletId: candidate.walletId,
        providerId: candidate.providerId,
        attempt: candidate.referenceAttempts + 1,
      };
      const started = performance.now();
      try {
        const result = await transactionCancellation.run(signal, () =>
          this.reprocess.execute(candidate.transactionId, {
            correlationId: candidate.transactionId,
          }),
        );
        if (result.idempotentReplay) {
          continue;
        }

        const outcome =
          result.status === Status.Processed
            ? 'resolved'
            : result.status === Status.PendingReference
              ? 'pending'
              : 'rejected';
        const metric =
          outcome === 'resolved'
            ? 'pendingReferenceResolved'
            : outcome === 'pending'
              ? 'pendingReferenceRescheduled'
              : 'pendingReferenceRejected';
        this.diagnostics.increment(metric);
        this.diagnostics.processing(result, 'reference');
        this.diagnostics.event('pending_reference_' + outcome, {
          ...fields,
          status: result.status,
          failureCode: result.failureCode,
        });
        processed += 1;
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }

        this.diagnostics.increment('pendingReferenceFailures');
        this.diagnostics.event('pending_reference_processing_failed', {
          ...fields,
          failureCode: classifyMessageError(error).code,
        });
      } finally {
        this.diagnostics.duration(
          (performance.now() - started) / 1000,
          'reference',
        );
      }
    }
    return processed;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#poll.abort();
    const timer = setTimeout(
      () =>
        this.#work.abort(
          new DOMException('Pending reference shutdown deadline', 'AbortError'),
        ),
      shutdownDrainMs(this.options),
    );
    try {
      await this.#loop;
    } finally {
      clearTimeout(timer);
      this.diagnostics.event('pending_reference_worker_stopped');
    }
  }
}
