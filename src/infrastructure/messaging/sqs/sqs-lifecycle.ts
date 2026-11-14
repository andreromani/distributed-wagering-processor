import { Injectable, Inject, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { instanceId } from '../../config/instance-id.js';

@Injectable()
export class SqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
    console.log(
      JSON.stringify({
        event: 'sqs_client_destroyed',
        instanceId: instanceId(),
      }),
    );
  }
}
