import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { FinancialHttpModule } from './infrastructure/http/financial-http.module.js';
import { FinancialApplicationModule } from './infrastructure/financial-application.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { SqsModule } from './infrastructure/messaging/sqs/sqs.module.js';
import { HealthController } from './infrastructure/http/health.controller.js';
import { MetricsController } from './infrastructure/http/metrics.controller.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';

@Module({
  imports: [
    ObservabilityModule,
    MessagingModule,
    DatabaseModule,
    SqsModule,
    FinancialApplicationModule,
    FinancialHttpModule,
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
