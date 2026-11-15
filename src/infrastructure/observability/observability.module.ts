import { Module } from '@nestjs/common';
import { OperationalMetrics } from './operational-metrics.js';
import { FinancialObservationLogger } from './financial-observation.js';

@Module({
  providers: [
    {
      provide: FinancialObservationLogger,
      useFactory: () => new FinancialObservationLogger(),
    },
    { provide: OperationalMetrics, useFactory: () => new OperationalMetrics() },
  ],
  exports: [OperationalMetrics, FinancialObservationLogger],
})
export class ObservabilityModule {}
