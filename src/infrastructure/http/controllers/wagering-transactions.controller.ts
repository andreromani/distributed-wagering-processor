import {
  Body,
  Controller,
  UseGuards,
  Get,
  Post,
  Param,
  Req,
  Res,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FinancialDiagnostics } from '../financial-diagnostics.js';
import { FinancialAuthGuard } from '../financial-auth.guard.js';
import { setFinancialErrorContext } from '../financial-error-context.js';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from '../../../application/use-cases/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionDto } from '../dtos/process-wager-transaction.dto.js';
import { httpValidation } from '../validation.js';
import { requestHeader } from '../headers.js';
import {
  processingResponse,
  processingStatus,
  wagerResponse,
} from '../mappers/wager-transaction-response.mapper.js';

@Controller('wagering/transactions')
@UseGuards(FinancialAuthGuard)
export class WageringTransactionsController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly process: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly get: GetWagerTransactionUseCase,
    @Inject(FinancialDiagnostics)
    private readonly diagnostics: FinancialDiagnostics,
  ) {}

  @Post()
  async create(
    @Body(httpValidation(ProcessWagerTransactionDto))
    body: ProcessWagerTransactionDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReturnType<typeof processingResponse>> {
    setFinancialErrorContext(response, {
      providerId: body.providerId,
      walletId: body.walletId,
    });
    const idempotencyKey = requestHeader(request, 'idempotency-key', true);
    const started = performance.now();
    if (idempotencyKey === undefined) {
      throw new Error('Validated idempotency header is missing');
    }
    const result = await this.process.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      idempotencyKey,
      source: 'http',
      correlationId: String(
        response.getHeader('x-correlation-id') ?? crypto.randomUUID(),
      ),
    });
    response.status(processingStatus(result.status));
    this.diagnostics.processing(result, {
      externalTransactionId: body.externalTransactionId,
      kind: body.kind,
      durationMs: performance.now() - started,
      providerId: body.providerId,
      walletId: body.walletId,
      correlationId: String(response.getHeader('x-correlation-id')),
    });
    return processingResponse(result);
  }

  @Get(':transactionId')
  async find(
    @Param('transactionId', new ParseUUIDPipe({ version: 'all' }))
    transactionId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReturnType<typeof wagerResponse>> {
    setFinancialErrorContext(response, { transactionId });
    return wagerResponse(await this.get.execute(transactionId));
  }
}
