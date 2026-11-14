import {
  Body,
  Controller,
  UseGuards,
  Get,
  Post,
  Param,
  Query,
  Res,
  Inject,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  OpenWalletUseCase,
  type OpenWalletResult,
} from '../../../application/use-cases/open-wallet.use-case.js';
import { GetWalletUseCase } from '../../../application/use-cases/get-wallet.use-case.js';
import { ListWalletLedgerUseCase } from '../../../application/use-cases/list-wallet-ledger.use-case.js';
import {
  ReconcileWalletUseCase,
  type ReconciliationResult,
} from '../../../application/use-cases/reconcile-wallet.use-case.js';
import { CreateWalletDto } from '../dtos/create-wallet.dto.js';
import { ListWalletLedgerQueryDto } from '../dtos/list-wallet-ledger-query.dto.js';
import { httpValidation } from '../validation.js';
import { walletResponse } from '../mappers/wallet-response.mapper.js';
import { ledgerResponse } from '../mappers/wallet-ledger-response.mapper.js';
import { FinancialAuthGuard } from '../financial-auth.guard.js';
import { setFinancialErrorContext } from '../financial-error-context.js';

@Controller('wallets')
@UseGuards(FinancialAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly open: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly get: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase)
    private readonly list: ListWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  create(
    @Body(httpValidation(CreateWalletDto)) body: CreateWalletDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpenWalletResult> {
    return this.open.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: String(
        response.getHeader('x-correlation-id') ?? crypto.randomUUID(),
      ),
    });
  }

  @Get(':walletId')
  async find(
    @Param('walletId', new ParseUUIDPipe({ version: 'all' })) walletId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpenWalletResult> {
    setFinancialErrorContext(response, { walletId });
    return walletResponse(await this.get.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe({ version: 'all' })) walletId: string,
    @Query(httpValidation(ListWalletLedgerQueryDto))
    query: ListWalletLedgerQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{
    items: ReturnType<typeof ledgerResponse>[];
    nextCursor: string | null;
  }> {
    setFinancialErrorContext(response, { walletId });
    const page = await this.list.execute(
      walletId,
      query.limit === undefined ? 50 : Number(query.limit),
      query.cursor,
    );
    return {
      items: page.items.map(ledgerResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  async reconciliation(
    @Param('walletId', new ParseUUIDPipe({ version: 'all' })) walletId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReconciliationResult> {
    setFinancialErrorContext(response, { walletId });
    response.status(200);
    return this.reconcile.execute(
      walletId,
      String(response.getHeader('x-correlation-id') ?? crypto.randomUUID()),
    );
  }
}
