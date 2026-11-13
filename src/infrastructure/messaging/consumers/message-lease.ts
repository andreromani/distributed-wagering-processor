import type { WagerQueue, WagerDelivery } from '../sqs/wager-queue.js';
import type { WorkerOptions } from '../../config/worker-options.js';
import { MessagingDiagnostics } from '../messaging-diagnostics.js';

export interface LeaseScheduler {
  deadline(callback: () => void, milliseconds: number): () => void;

  interval(callback: () => void, milliseconds: number): () => void;
}

const systemScheduler: LeaseScheduler = {
  deadline: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
  interval: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  },
};

export class MessageLease {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly #deadline: () => void;
  readonly #interval: () => void;
  #renewal: Promise<void> | undefined;

  constructor(
    message: WagerDelivery,
    queue: WagerQueue,
    options: WorkerOptions,
    diagnostics: MessagingDiagnostics,
    parent: AbortSignal,
    scheduler: LeaseScheduler = systemScheduler,
  ) {
    this.signal = AbortSignal.any([parent, this.#controller.signal]);
    this.#deadline = scheduler.deadline(
      () =>
        this.#controller.abort(
          new DOMException('Message processing deadline', 'AbortError'),
        ),
      options.processingTimeoutMs,
    );
    this.#interval = scheduler.interval(
      () => {
        if (this.signal.aborted || this.#renewal) {
          return;
        }
        this.#renewal = queue
          .visibility(message, options.visibilitySeconds)
          .catch(() => {
            diagnostics.increment('visibilityFailures');
            diagnostics.event('visibility_renewal_failed', {
              sqsMessageId: message.sqsMessageId,
            });
            this.#controller.abort(
              new DOMException('Visibility renewal failed', 'AbortError'),
            );
          })
          .finally(() => {
            this.#renewal = undefined;
          });
      },
      Math.max(100, Math.floor((options.visibilitySeconds * 1000) / 3)),
    );
  }

  async close(): Promise<void> {
    this.#deadline();
    this.#interval();
    await this.#renewal;
  }
}
