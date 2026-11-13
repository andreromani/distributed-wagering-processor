import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { requestHeader } from './headers.js';
import { FinancialDiagnostics } from './financial-diagnostics.js';
import { FinancialExceptionFilter } from './filters/financial-exception.filter.js';

export function configureHttp(app: INestApplication): void {
  const filter = new FinancialExceptionFilter(app.get(FinancialDiagnostics));
  app.useGlobalFilters(filter);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const generated = crypto.randomUUID();
    response.setHeader('x-correlation-id', generated);
    try {
      const correlationId =
        requestHeader(request, 'x-correlation-id', false) ?? generated;
      response.setHeader('x-correlation-id', correlationId);
      next();
    } catch {
      // Middleware runs before Nest's controller exception boundary.
      const mapped = {
        statusCode: 400,
        code: 'INVALID_INPUT',
        message: 'Invalid correlation header',
        correlationId: generated,
      };
      response.status(400).json(mapped);
    }
  });
}
