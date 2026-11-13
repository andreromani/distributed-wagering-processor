import {
  Controller,
  Get,
  Param,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { GetProviderWagerTransactionUseCase } from '../../../application/use-cases/get-provider-wager-transaction.use-case.js';
import { wagerResponse } from '../mappers/wager-transaction-response.mapper.js';

@Controller('providers')
export class ProviderWageringTransactionsController {
  constructor(
    @Inject(GetProviderWagerTransactionUseCase)
    private readonly get: GetProviderWagerTransactionUseCase,
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
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
    return wagerResponse(await this.get.execute(providerId, externalId));
  }
}
