import {
  Catch,
  HttpException,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FinancialApplicationError } from '../../../application/errors/financial-application.error.js';
import { PersistenceError } from '../../../application/ports/persistence.error.js';
import { FinancialDiagnostics } from '../financial-diagnostics.js';
import { financialErrorContext } from '../financial-error-context.js';

export function financialHttpError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (error instanceof FinancialApplicationError) {
    switch (error.code) {
      case 'INVALID_INPUT':
      case 'CONTEXT_MISMATCH':
        return {
          statusCode: 400,
          code: error.code,
          message: 'Invalid financial request',
        };
      case 'WALLET_NOT_FOUND':
      case 'TRANSACTION_NOT_FOUND':
        return {
          statusCode: 404,
          code: error.code,
          message: 'Resource not found',
        };
      case 'WALLET_CONFLICT':
      case 'IDEMPOTENCY_CONFLICT':
      case 'EXTERNAL_IDENTITY_CONFLICT':
      case 'INBOX_CONFLICT':
        return {
          statusCode: 409,
          code: error.code,
          message: 'Financial identity conflict',
        };
      case 'TRANSIENT_FAILURE':
        return {
          statusCode: 503,
          code: error.code,
          message: 'Service temporarily unavailable',
        };
      case 'PERMANENT_FAILURE':
        return {
          statusCode: 500,
          code: error.code,
          message: 'Internal processing failure',
        };
    }
  }
  if (error instanceof PersistenceError) {
    return error.category === 'transient'
      ? {
          statusCode: 503,
          code: 'TRANSIENT_FAILURE',
          message: 'Service temporarily unavailable',
        }
      : {
          statusCode: 500,
          code: 'PERMANENT_FAILURE',
          message: 'Internal processing failure',
        };
  }
  if (error instanceof HttpException) {
    const statusCode = error.getStatus();
    return {
      statusCode,
      code:
        statusCode === 400
          ? 'INVALID_INPUT'
          : statusCode === 404
            ? 'NOT_FOUND'
            : 'HTTP_ERROR',
      message:
        statusCode === 400
          ? 'Invalid request'
          : statusCode === 404
            ? 'Resource not found'
            : 'Request failed',
    };
  }
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal processing failure',
  };
}

@Catch()
export class FinancialExceptionFilter implements ExceptionFilter {
  constructor(private readonly diagnostics: FinancialDiagnostics) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    if (
      /^\/health(?:\/|$)/.test(request.path) &&
      error instanceof HttpException
    ) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    const mapped = financialHttpError(error);
    const correlationId = String(
      response.getHeader('x-correlation-id') ?? crypto.randomUUID(),
    );
    const operationId =
      error instanceof FinancialApplicationError &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        error.operationId ?? '',
      )
        ? error.operationId
        : undefined;
    if (mapped.statusCode >= 400) {
      this.diagnostics.record({
        level: 'error',
        event: 'http_request_failed',
        statusCode: mapped.statusCode,
        code: mapped.code,
        correlationId,
        ...financialErrorContext(response),
        ...(operationId === undefined ? {} : { operationId }),
      });
    }
    response.status(mapped.statusCode).json({ ...mapped, correlationId });
  }
}
