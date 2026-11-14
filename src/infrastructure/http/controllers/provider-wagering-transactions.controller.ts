import {
  Controller,
  UseGuards,
  Res,
  Get,
  Param,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { GetProviderWagerTransactionUseCase } from '../../../application/use-cases/get-provider-wager-transaction.use-case.js';
import { wagerResponse } from '../mappers/wager-transaction-response.mapper.js';
import type { Response } from 'express';
import { FinancialAuthGuard } from '../financial-auth.guard.js';
import { setFinancialErrorContext } from '../financial-error-context.js';

@Controller('providers')
@UseGuards(FinancialAuthGuard)
export class ProviderWageringTransactionsController {
  constructor(
    @Inject(GetProviderWagerTransactionUseCase)
    private readonly get: GetProviderWagerTransactionUseCase,
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReturnType<typeof wagerResponse>> {
    if (
      [providerId, externalId].some(
        (value) =>
          !value.trim() ||
          Array.from(value).length > 256 ||
          value.includes('\0'),
      )
    ) {
      throw new BadRequestException();
    }
    setFinancialErrorContext(response, { providerId });
    return wagerResponse(await this.get.execute(providerId, externalId));
  }
}
