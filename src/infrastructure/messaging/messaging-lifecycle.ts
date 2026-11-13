import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { WagerTransactionConsumer } from './consumers/wager-transaction.consumer.js';
import { OutboxPublisher } from './publishers/outbox.publisher.js';
import type { WorkerOptions } from '../config/worker-options.js';
import type { PendingReferenceWorker } from './consumers/pending-reference.worker.js';

export class MessagingLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  constructor(
    private readonly consumer: WagerTransactionConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly options: WorkerOptions,
    private readonly pendingReference?: Pick<
      PendingReferenceWorker,
      'start' | 'stop'
    >,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.consumerEnabled) {
      this.consumer.start();
    }
    if (this.options.publisherEnabled) {
      this.publisher.start();
    }

    if (this.options.pendingReferenceEnabled) {
      this.pendingReference?.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const stopping: Promise<void>[] = [];
    if (this.options.consumerEnabled) {
      stopping.push(this.consumer.stop());
    }
    if (this.options.publisherEnabled) {
      stopping.push(this.publisher.stop());
    }

    if (this.options.pendingReferenceEnabled && this.pendingReference) {
      stopping.push(this.pendingReference.stop());
    }
    await Promise.all(stopping);
  }
}
