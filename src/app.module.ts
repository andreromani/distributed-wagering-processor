import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { SqsModule } from './infrastructure/messaging/sqs/sqs.module.js';
import { HealthController } from './infrastructure/http/health.controller.js';

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController],
})
export class AppModule {}
