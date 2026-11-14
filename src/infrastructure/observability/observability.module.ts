import { Module } from '@nestjs/common';
import { OperationalMetrics } from './operational-metrics.js';

@Module({
  providers: [
    { provide: OperationalMetrics, useFactory: () => new OperationalMetrics() },
  ],
  exports: [OperationalMetrics],
})
export class ObservabilityModule {}
