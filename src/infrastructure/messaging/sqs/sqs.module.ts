import {
  Module,
  Injectable,
  Inject,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { environment } from '../../config/environment.js';
@Injectable()
class SqsLifecycle implements OnModuleDestroy {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}
  onModuleDestroy() {
    this.client.destroy();
  }
}
@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          ...environment().sqs,
          maxAttempts: 2,
          requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
        }),
    },
    SqsLifecycle,
  ],
  exports: [SQSClient],
})
export class SqsModule {}
