import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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
export class WageringTransactionsController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly process: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly get: GetWagerTransactionUseCase,
  ) {}

  @Post()
  async create(
    @Body(httpValidation(ProcessWagerTransactionDto))
    body: ProcessWagerTransactionDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReturnType<typeof processingResponse>> {
    const idempotencyKey = requestHeader(request, 'idempotency-key', true);
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
      correlationId: String(
        response.getHeader('x-correlation-id') ?? crypto.randomUUID(),
      ),
    });
    response.status(processingStatus(result.status));
    return processingResponse(result);
  }

  @Get(':transactionId')
  async find(
    @Param('transactionId', new ParseUUIDPipe({ version: 'all' }))
    transactionId: string,
  ): Promise<ReturnType<typeof wagerResponse>> {
    return wagerResponse(await this.get.execute(transactionId));
  }
}
