import { shutdownDrainMs } from '../../config/worker-options.js';
import type { WagerQueue, WagerDelivery } from '../sqs/wager-queue.js';
import type { WorkerOptions } from '../../config/worker-options.js';
import {
  WagerMessageHandler,
  WAGER_CONSUMER_NAME,
} from './wager-message-handler.js';
import { MessageLease } from './message-lease.js';
import { MessagingDiagnostics } from '../messaging-diagnostics.js';
import { retryDelay, waitForWorker } from '../retry-delay.js';

export class WagerTransactionConsumer {
  readonly #poll = new AbortController();
  readonly #work = new AbortController();
  #stopping = false;
  #loop: Promise<void> | undefined;

  constructor(
    private readonly queue: WagerQueue,
    private readonly handler: WagerMessageHandler,
    private readonly options: WorkerOptions,
    private readonly diagnostics: MessagingDiagnostics,
    private readonly wait = waitForWorker,
  ) {}

  start(): void {
    if (this.#loop || this.#stopping) {
      return;
    }
    this.diagnostics.event('consumer_started');
    this.#loop = this.run();
  }

  private async run(): Promise<void> {
    let verified = false;
    let failures = 0;
    while (!this.#stopping) {
      try {
        if (!verified) {
          await this.queue.verify?.();
          verified = true;
        }
        if (this.#stopping) {
          break;
        }
        const messages = await this.queue.receive(
          Math.min(this.options.sqsBatchSize, this.options.concurrency),
          this.#poll.signal,
        );
        failures = 0;
        await this.processBatch(messages, this.#work.signal);
        if (messages.length === 0) {
          await this.wait(100, this.#poll.signal);
        }
      } catch {
        if (!this.#stopping) {
          failures = Math.min(31, failures + 1);
          this.diagnostics.event('consumer_poll_failed', { attempt: failures });
          await this.wait(
            retryDelay(
              failures,
              this.options.retryBaseSeconds * 1000,
              this.options.retryMaxSeconds * 1000,
            ),
            this.#poll.signal,
          );
        }
      }
    }
  }

  async processBatch(
    messages: WagerDelivery[],
    signal: AbortSignal = this.#work.signal,
  ): Promise<void> {
    const groups = new Map<
      string,
      { message: WagerDelivery; lease: MessageLease }[]
    >();
    for (const message of messages) {
      this.diagnostics.increment('received');
      this.diagnostics.event('message_received', {
        consumerName: WAGER_CONSUMER_NAME,
        sqsMessageId: message.sqsMessageId,
        attempt: message.receiveCount,
      });
      const item = {
        message,
        lease: new MessageLease(
          message,
          this.queue,
          this.options,
          this.diagnostics,
          signal,
        ),
      };
      const group = groups.get(message.groupId) ?? [];
      group.push(item);
      groups.set(message.groupId, group);
    }
    const entries = [...groups.values()];
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < entries.length) {
        const group = entries[index++];
        if (!group) {
          break;
        }
        let blocked = false;
        let delay = 0;
        for (const { message, lease } of group) {
          try {
            if (this.#stopping || blocked || lease.signal.aborted) {
              await lease.close();
              await this.queue.visibility(message, delay);
              this.diagnostics.event('message_deferred', {
                consumerName: WAGER_CONSUMER_NAME,
                sqsMessageId: message.sqsMessageId,
                delaySeconds: delay,
              });
              continue;
            }
            const result = await this.handler.handle(
              message,
              lease.signal,
              () => lease.close(),
            );
            blocked = !result.continueGroup;
            delay = Math.min(43200, result.retrySeconds + 1);
          } catch {
            blocked = true;
            delay = this.options.visibilitySeconds;
            this.diagnostics.event('consumer_delivery_failed', {
              sqsMessageId: message.sqsMessageId,
            });
          } finally {
            await lease.close();
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.options.concurrency, entries.length) },
        worker,
      ),
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#poll.abort();
    this.diagnostics.event('consumer_stopping');
    const timer = setTimeout(() => {
      this.diagnostics.event('consumer_drain_deadline');
      this.#work.abort(
        new DOMException('Consumer shutdown deadline', 'AbortError'),
      );
    }, shutdownDrainMs(this.options));
    try {
      await this.#loop;
    } finally {
      clearTimeout(timer);
      this.diagnostics.event('consumer_stopped');
    }
  }
}
