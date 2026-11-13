import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { environment } from '../../config/environment.js';
import { SqsLifecycle } from './sqs-lifecycle.js';

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          ...environment().sqs,
          maxAttempts: 2,
          requestHandler: {
            connectionTimeout: 1000,
            requestTimeout:
              environment().workers.longPollSeconds * 1000 +
              environment().workers.externalTimeoutMs +
              1000,
          },
        }),
    },
    SqsLifecycle,
  ],
  exports: [SQSClient],
})
export class SqsModule {}
