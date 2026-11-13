import {
  Body,
  Controller,
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

@Controller('wallets')
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
  ): Promise<OpenWalletResult> {
    return walletResponse(await this.get.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe({ version: 'all' })) walletId: string,
    @Query(httpValidation(ListWalletLedgerQueryDto))
    query: ListWalletLedgerQueryDto,
  ): Promise<{
    items: ReturnType<typeof ledgerResponse>[];
    nextCursor: string | null;
  }> {
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
    response.status(200);
    return this.reconcile.execute(
      walletId,
      String(response.getHeader('x-correlation-id') ?? crypto.randomUUID()),
    );
  }
}
