import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';
import { FinancialApplicationModule } from '../financial-application.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SqsModule } from './sqs/sqs.module.js';
import { environment } from '../config/environment.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { TypeOrmOutboxDeliveryStore } from '../database/repositories/typeorm-outbox-delivery.store.js';
import { SqsTransport } from './sqs/sqs-transport.js';
import { MessagingDiagnostics } from './messaging-diagnostics.js';
import { WagerMessageHandler } from './consumers/wager-message-handler.js';
import { WagerTransactionConsumer } from './consumers/wager-transaction.consumer.js';
import { OutboxPublisher } from './publishers/outbox.publisher.js';
import { MessagingLifecycle } from './messaging-lifecycle.js';
import { PendingReferenceWorker } from './consumers/pending-reference.worker.js';
import { TypeOrmPendingReferenceReader } from '../database/repositories/typeorm-pending-reference.reader.js';
import { ReprocessPendingReferenceUseCase } from '../../application/use-cases/reprocess-pending-reference.use-case.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { OperationalMetrics } from '../observability/operational-metrics.js';
import { DistributedTestBarrier } from './distributed-test-barrier.js';

@Module({
  imports: [
    FinancialApplicationModule,
    DatabaseModule,
    SqsModule,
    ObservabilityModule,
  ],
  providers: [
    {
      provide: DistributedTestBarrier,
      useFactory: () => new DistributedTestBarrier(),
    },
    {
      provide: TypeOrmPendingReferenceReader,
      inject: [DataSource],
      useFactory: (source: DataSource) =>
        new TypeOrmPendingReferenceReader(source),
    },
    {
      provide: PendingReferenceWorker,
      inject: [
        TypeOrmPendingReferenceReader,
        ReprocessPendingReferenceUseCase,
        MessagingDiagnostics,
      ],
      useFactory: (
        reader: TypeOrmPendingReferenceReader,
        reprocess: ReprocessPendingReferenceUseCase,
        diagnostics: MessagingDiagnostics,
      ) =>
        new PendingReferenceWorker(
          reader,
          reprocess,
          environment().workers,
          diagnostics,
        ),
    },
    {
      provide: MessagingDiagnostics,
      inject: [OperationalMetrics],
      useFactory: (metrics: OperationalMetrics) =>
        new MessagingDiagnostics(undefined, metrics),
    },
    {
      provide: SqsTransport,
      inject: [SQSClient],
      useFactory: (client: SQSClient) =>
        new SqsTransport(client, environment(), environment().workers),
    },
    {
      provide: TypeOrmOutboxDeliveryStore,
      inject: [DataSource],
      useFactory: (source: DataSource) =>
        new TypeOrmOutboxDeliveryStore(source),
    },
    {
      provide: WagerMessageHandler,
      inject: [
        ProcessWagerTransactionUseCase,
        SqsTransport,
        MessagingDiagnostics,
        DistributedTestBarrier,
      ],
      useFactory: (
        process: ProcessWagerTransactionUseCase,
        queue: SqsTransport,
        diagnostics: MessagingDiagnostics,
        barrier: DistributedTestBarrier,
      ) =>
        new WagerMessageHandler(
          process,
          queue,
          environment().workers,
          diagnostics,
          barrier,
        ),
    },
    {
      provide: WagerTransactionConsumer,
      inject: [SqsTransport, WagerMessageHandler, MessagingDiagnostics],
      useFactory: (
        queue: SqsTransport,
        handler: WagerMessageHandler,
        diagnostics: MessagingDiagnostics,
      ) =>
        new WagerTransactionConsumer(
          queue,
          handler,
          environment().workers,
          diagnostics,
        ),
    },
    {
      provide: OutboxPublisher,
      inject: [
        TypeOrmOutboxDeliveryStore,
        SqsTransport,
        MessagingDiagnostics,
        DistributedTestBarrier,
      ],
      useFactory: (
        store: TypeOrmOutboxDeliveryStore,
        publisher: SqsTransport,
        diagnostics: MessagingDiagnostics,
        barrier: DistributedTestBarrier,
      ) =>
        new OutboxPublisher(
          store,
          publisher,
          environment().workers,
          diagnostics,
          undefined,
          undefined,
          barrier,
        ),
    },
    {
      provide: MessagingLifecycle,
      inject: [
        WagerTransactionConsumer,
        OutboxPublisher,
        PendingReferenceWorker,
        MessagingDiagnostics,
        DataSource,
      ],
      useFactory: (
        consumer: WagerTransactionConsumer,
        publisher: OutboxPublisher,
        pendingReference: PendingReferenceWorker,
        diagnostics: MessagingDiagnostics,
        source: DataSource,
      ) => {
        const options = environment().workers;
        const lifecycleOptions =
          process.env.NODE_ENV === 'test'
            ? {
                ...options,
                consumerEnabled: false,
                publisherEnabled: false,
                pendingReferenceEnabled: false,
              }
            : options;
        return new MessagingLifecycle(
          consumer,
          publisher,
          lifecycleOptions,
          pendingReference,
          diagnostics,
          source,
        );
      },
    },
  ],
  exports: [
    WagerTransactionConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
    MessagingDiagnostics,
  ],
})
export class MessagingModule {}
