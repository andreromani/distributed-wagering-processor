import { Injectable, Inject, type OnModuleDestroy } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsLifecycle implements OnModuleDestroy {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onModuleDestroy() {
    this.client.destroy();
  }
}
