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

@Module({
  imports: [FinancialApplicationModule, DatabaseModule, SqsModule],
  providers: [
    {
      provide: MessagingDiagnostics,
      useFactory: () => new MessagingDiagnostics(),
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
      ],
      useFactory: (
        process: ProcessWagerTransactionUseCase,
        queue: SqsTransport,
        diagnostics: MessagingDiagnostics,
      ) =>
        new WagerMessageHandler(
          process,
          queue,
          environment().workers,
          diagnostics,
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
      inject: [TypeOrmOutboxDeliveryStore, SqsTransport, MessagingDiagnostics],
      useFactory: (
        store: TypeOrmOutboxDeliveryStore,
        publisher: SqsTransport,
        diagnostics: MessagingDiagnostics,
      ) =>
        new OutboxPublisher(
          store,
          publisher,
          environment().workers,
          diagnostics,
        ),
    },
    {
      provide: MessagingLifecycle,
      inject: [WagerTransactionConsumer, OutboxPublisher],
      useFactory: (
        consumer: WagerTransactionConsumer,
        publisher: OutboxPublisher,
      ) => {
        const options = environment().workers;
        const lifecycleOptions =
          process.env.NODE_ENV === 'test'
            ? { ...options, consumerEnabled: false, publisherEnabled: false }
            : options;
        return new MessagingLifecycle(consumer, publisher, lifecycleOptions);
      },
    },
  ],
  exports: [WagerTransactionConsumer, OutboxPublisher, MessagingDiagnostics],
})
export class MessagingModule {}
