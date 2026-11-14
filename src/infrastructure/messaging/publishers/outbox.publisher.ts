import { shutdownDrainMs } from '../../config/worker-options.js';
import type { IntegrationEventPublisher } from '../../../application/ports/integration-event-publisher.js';
import type { OutboxDeliveryStore } from '../../../application/ports/outbox-delivery-store.js';
import type { WorkerOptions } from '../../config/worker-options.js';
import { MessagingDiagnostics } from '../messaging-diagnostics.js';
import { retryDelay, waitForWorker } from '../retry-delay.js';
import type { DistributedTestBarrier } from '../distributed-test-barrier.js';

export class OutboxPublisher {
  readonly #poll = new AbortController();
  readonly #work = new AbortController();
  #stopping = false;
  #loop: Promise<void> | undefined;

  constructor(
    private readonly store: OutboxDeliveryStore,
    private readonly publisher: IntegrationEventPublisher,
    private readonly options: WorkerOptions,
    private readonly diagnostics: MessagingDiagnostics,
    private readonly now: () => Date = () => new Date(),
    private readonly wait = waitForWorker,
    private readonly barrier?: DistributedTestBarrier,
  ) {}

  start(): void {
    if (this.#loop || this.#stopping) {
      return;
    }
    this.diagnostics.event('outbox_publisher_started');
    this.#loop = this.run();
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.#stopping) {
      try {
        await this.publishBatch(
          AbortSignal.any([
            this.#work.signal,
            AbortSignal.timeout(this.options.processingTimeoutMs),
          ]),
        );
        if (!this.#stopping) {
          this.diagnostics.pending(await this.store.countPending());
        }
        failures = 0;
      } catch {
        failures = Math.min(31, failures + 1);
        if (!this.#stopping) {
          this.diagnostics.event('outbox_poll_failed');
        }
      }
      await this.wait(
        retryDelay(
          failures,
          this.options.outboxPollMs,
          Math.max(this.options.outboxPollMs, this.options.outboxRetryMaxMs),
        ),
        this.#poll.signal,
      );
    }
  }

  async publishBatch(
    signal: AbortSignal = AbortSignal.timeout(this.options.processingTimeoutMs),
  ): Promise<number> {
    let processed = 0;
    for (
      let i = 0;
      i < this.options.outboxBatchSize && !this.#stopping;
      i += 1
    ) {
      signal.throwIfAborted();
      const found = await this.store.processNext(
        this.now(),
        async (message) => {
          const data = message.payload.data;
          const identifiers = data && typeof data === 'object' ? data : {};
          const fields = {
            eventId: message.id,
            eventType: message.eventType,
            walletId: message.aggregateId,
            correlationId: message.payload.correlationId,
            causationId: message.payload.causationId,
            attempt: message.attempts + 1,
            transactionId:
              'transactionId' in identifiers &&
              typeof identifiers.transactionId === 'string'
                ? identifiers.transactionId
                : undefined,
            providerId:
              'providerId' in identifiers &&
              typeof identifiers.providerId === 'string'
                ? identifiers.providerId
                : undefined,
          };
          try {
            await this.barrier?.wait(
              'publisher-before-send',
              message.id,
              signal,
            );
            await this.publisher.publish(message, signal);
            await this.barrier?.wait(
              'publisher-after-send',
              message.id,
              signal,
            );
            signal.throwIfAborted();
            message.markPublished(this.now());
            this.diagnostics.increment('published');
            this.diagnostics.event('outbox_event_published', fields);
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            message.scheduleRetry(
              this.now(),
              retryDelay(
                message.attempts + 1,
                this.options.outboxRetryBaseMs,
                this.options.outboxRetryMaxMs,
              ),
            );
            this.diagnostics.increment('publishFailures');
            this.diagnostics.event('outbox_publish_failed', fields);
          }
        },
        signal,
      );
      if (!found) {
        break;
      }
      processed += 1;
    }
    return processed;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#poll.abort();
    this.diagnostics.event('outbox_publisher_stopping');
    const timer = setTimeout(
      () =>
        this.#work.abort(
          new DOMException('Publisher shutdown deadline', 'AbortError'),
        ),
      shutdownDrainMs(this.options),
    );
    try {
      await this.#loop;
    } finally {
      clearTimeout(timer);
      this.diagnostics.event('outbox_publisher_stopped');
    }
  }
}
