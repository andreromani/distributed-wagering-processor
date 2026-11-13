import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { httpValidation } from '../../src/infrastructure/http/validation.js';
import { CreateWalletDto } from '../../src/infrastructure/http/dtos/create-wallet.dto.js';
import { ProcessWagerTransactionDto } from '../../src/infrastructure/http/dtos/process-wager-transaction.dto.js';
import { ListWalletLedgerQueryDto } from '../../src/infrastructure/http/dtos/list-wallet-ledger-query.dto.js';
import { financialHttpError } from '../../src/infrastructure/http/filters/financial-exception.filter.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import { PersistenceError } from '../../src/application/ports/persistence.error.js';
import { processingStatus } from '../../src/infrastructure/http/mappers/wager-transaction-response.mapper.js';
import { WagerTransactionStatus as Status } from '../../src/domain/financial.types.js';
import { requestHeader } from '../../src/infrastructure/http/headers.js';
import {
  encodeLedgerCursor,
  decodeLedgerCursor,
} from '../../src/application/services/ledger-cursor.js';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import { FinancialDiagnostics } from '../../src/infrastructure/http/financial-diagnostics.js';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case.js';
import { GetWagerTransactionUseCase } from '../../src/application/use-cases/get-wager-transaction.use-case.js';
import { GetProviderWagerTransactionUseCase } from '../../src/application/use-cases/get-provider-wager-transaction.use-case.js';
import { ListWalletLedgerUseCase } from '../../src/application/use-cases/list-wallet-ledger.use-case.js';
import { MemoryFinancialTransaction } from '../support/memory-financial-transaction.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';

const id = '0192f291-27dd-7d3f-8071-5f8685deef37';
const wallet = {
  playerId: id,
  initialBalance: { amount: '100.00', currency: 'BRL' },
};

for (const initialBalance of [
  { amount: 1, currency: 'BRL' },
  { amount: '1.001', currency: 'BRL' },
  { amount: '-1.00', currency: 'BRL' },
  { amount: '1.00', currency: 'ZZZ' },
  { amount: '1.00', currency: 'BRL', extra: true },
  null,
  [],
]) {
  test(
    'DTO rejects invalid nested money ' + JSON.stringify(initialBalance),
    async () => {
      await rejected(
        httpValidation(CreateWalletDto).transform(
          { ...wallet, initialBalance },
          { type: 'body' },
        ),
      );
    },
  );
}

for (const change of [
  { playerId: 'bad' },
  { playerId: undefined },
  { extra: true },
]) {
  test(
    'wallet DTO rejects structural changes ' + JSON.stringify(change),
    async () => {
      await rejected(
        httpValidation(CreateWalletDto).transform(
          { ...wallet, ...change },
          { type: 'body' },
        ),
      );
    },
  );
}

test('DTO accepts exact money strings and rejects internal or unknown kinds', async () => {
  const dto = await httpValidation(CreateWalletDto).transform(wallet, {
    type: 'body',
  });
  expect(dto.initialBalance.amount).toBe('100.00');
  const input = {
    walletId: id,
    playerId: id,
    providerId: 'provider',
    externalTransactionId: 'external',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  };
  for (const kind of ['OPENING', 'other', undefined]) {
    await rejected(
      httpValidation(ProcessWagerTransactionDto).transform(
        { ...input, kind },
        { type: 'body' },
      ),
    );
  }
});

for (const query of [
  { limit: '0' },
  { limit: '101' },
  { limit: '1.5' },
  { limit: ['2', '3'] },
  { limit: '1e1' },
  { cursor: '' },
  { extra: 'x' },
]) {
  test('pagination DTO rejects ' + JSON.stringify(query), async () => {
    await rejected(
      httpValidation(ListWalletLedgerQueryDto).transform(query, {
        type: 'query',
      }),
    );
  });
}

for (const [code, status] of [
  ['INVALID_INPUT', 400],
  ['CONTEXT_MISMATCH', 400],
  ['WALLET_NOT_FOUND', 404],
  ['TRANSACTION_NOT_FOUND', 404],
  ['WALLET_CONFLICT', 409],
  ['IDEMPOTENCY_CONFLICT', 409],
  ['EXTERNAL_IDENTITY_CONFLICT', 409],
  ['INBOX_CONFLICT', 409],
  ['TRANSIENT_FAILURE', 503],
  ['PERMANENT_FAILURE', 500],
] as const) {
  test('HTTP maps application error ' + code, () => {
    expect(
      financialHttpError(new FinancialApplicationError(code)),
    ).toMatchObject({ code, statusCode: status });
  });
}

test('HTTP distinguishes results, transient persistence and unexpected errors', () => {
  expect(processingStatus(Status.Processed)).toBe(200);
  expect(processingStatus(Status.PendingReference)).toBe(202);
  expect(processingStatus(Status.Rejected)).toBe(422);
  expect(processingStatus(Status.Failed)).toBe(500);
  expect(financialHttpError(new PersistenceError('transient')).statusCode).toBe(
    503,
  );
  expect(financialHttpError(new Error('SQL password secret'))).toEqual({
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal processing failure',
  });
});

for (const rawHeaders of [
  [],
  ['Idempotency-Key', ''],
  ['Idempotency-Key', 'a', 'idempotency-key', 'b'],
  ['Idempotency-Key', 'a,b'],
  ['Idempotency-Key', 'a'.repeat(257)],
]) {
  test(
    'idempotency header rejects missing or ambiguous content ' +
      JSON.stringify(rawHeaders),
    () => {
      expect(() =>
        requestHeader({ rawHeaders }, 'idempotency-key', true),
      ).toThrow(BadRequestException);
    },
  );
}

test('headers accept arbitrary key and validate correlation', () => {
  expect(
    requestHeader(
      { rawHeaders: ['Idempotency-Key', 'arbitrary key'] },
      'idempotency-key',
      true,
    ),
  ).toBe('arbitrary key');
  expect(
    requestHeader({ rawHeaders: [] }, 'x-correlation-id', false),
  ).toBeUndefined();
  expect(() =>
    requestHeader(
      { rawHeaders: ['x-correlation-id', 'bad value'] },
      'x-correlation-id',
      false,
    ),
  ).toThrow();
});

const position = { createdAt: '2026-11-13T12:00:00.123456Z', id };
test('cursor round trip preserves PostgreSQL microseconds and wallet scope', () => {
  const cursor = encodeLedgerCursor(id, position);
  expect(decodeLedgerCursor(cursor, id)).toEqual(position);
  expect(() => decodeLedgerCursor(cursor, crypto.randomUUID())).toThrow();
});

for (const value of [
  null,
  [],
  { version: 2, walletId: id, ...position },
  { version: 1, walletId: id, ...position, id: 'bad' },
  {
    version: 1,
    walletId: id,
    ...position,
    createdAt: '2026-02-30T12:00:00.123456Z',
  },
  { version: 1, walletId: id, ...position, createdAt: 'invalid' },
  { version: 1, walletId: id, ...position, extra: true },
]) {
  test('cursor rejects malformed structure ' + JSON.stringify(value), () => {
    expect(() =>
      decodeLedgerCursor(
        Buffer.from(JSON.stringify(value)).toString('base64url'),
        id,
      ),
    ).toThrow();
  });
}

test('cursor rejects invalid encoding', () => {
  for (const value of ['', '***', 'abcd=', 'e30']) {
    expect(() => decodeLedgerCursor(value, id)).toThrow();
  }
});

for (const difference of ['0.00', '-10.00', '10.00']) {
  test(
    'reconciliation maps signed amounts and records divergences ' + difference,
    async () => {
      const logs: Readonly<Record<string, unknown>>[] = [];
      const observer = new FinancialDiagnostics((record) => logs.push(record));
      const reader = {
        read: async () => ({
          walletId: id,
          currency: 'BRL',
          storedBalance: '100.00',
          calculatedBalance:
            difference === '-10.00'
              ? '110.00'
              : difference === '10.00'
                ? '90.00'
                : '100.00',
          difference,
          checkedEntries: 3,
        }),
      };

      const result = await new ReconcileWalletUseCase(reader, observer).execute(
        id,
        'correlation',
      );

      expect(result.difference.amount).toBe(difference);
      expect(result.checkedEntries).toBe(3);
      expect(result.consistent).toBe(difference === '0.00');
      expect(observer.reconciliationDivergences).toBe(
        difference === '0.00' ? 0 : 1,
      );
      expect(logs).toHaveLength(difference === '0.00' ? 0 : 1);
      if (difference !== '0.00') {
        expect(logs[0]).toMatchObject({
          event: 'wallet_reconciliation_divergence',
          walletId: id,
          correlationId: 'correlation',
        });
      }
    },
  );
}

test('read use cases distinguish absent resources and empty ledger', async () => {
  const memory = new MemoryFinancialTransaction();
  const get = new GetWalletUseCase(memory);
  await rejected(get.execute(id), 'WALLET_NOT_FOUND');
  await rejected(
    new GetWagerTransactionUseCase(memory).execute(id),
    'TRANSACTION_NOT_FOUND',
  );
  await rejected(
    new GetProviderWagerTransactionUseCase(memory).execute(
      'provider',
      'external',
    ),
    'TRANSACTION_NOT_FOUND',
  );
  await rejected(
    new ReconcileWalletUseCase(
      { read: async () => undefined },
      { divergence: () => {} },
    ).execute(id, 'correlation'),
    'WALLET_NOT_FOUND',
  );
  const created = await new OpenWalletUseCase(memory).execute({
    playerId: id,
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });

  expect((await get.execute(created.id)).balance.toString()).toBe('0.00');
  expect(await new ListWalletLedgerUseCase(memory).execute(created.id)).toEqual(
    { items: [], nextCursor: null },
  );
  await rejected(
    new ListWalletLedgerUseCase(memory).execute(created.id, 101),
    'INVALID_INPUT',
  );
});

async function rejected(work: Promise<unknown>, code?: string): Promise<void> {
  let failure: unknown;
  try {
    await work;
  } catch (error) {
    failure = error;
  }
  if (code) {
    expect(failure).toBeInstanceOf(FinancialApplicationError);
    expect(failure).toHaveProperty('code', code);
  } else {
    expect(failure).toBeInstanceOf(BadRequestException);
  }
}

test('reconciliation preserves a negative calculated balance from an exact signed snapshot', async () => {
  const result = await new ReconcileWalletUseCase(
    {
      read: async () => ({
        walletId: id,
        currency: 'BRL',
        storedBalance: '0.00',
        calculatedBalance: '-10.00',
        difference: '10.00',
        checkedEntries: 1,
      }),
    },
    { divergence: () => {} },
  ).execute(id, 'correlation');

  expect(result.calculatedBalance).toEqual({
    amount: '-10.00',
    currency: 'BRL',
  });
  expect(result.difference.amount).toBe('10.00');
  expect(result.consistent).toBe(false);
});

test('transaction queries preserve the original snapshot after another operation changes the wallet', async () => {
  const { ProcessWagerTransactionUseCase } =
    await import('../../src/application/use-cases/process-wager-transaction.use-case.js');
  const { WagerTransactionKind } =
    await import('../../src/domain/financial.types.js');
  const memory = new MemoryFinancialTransaction();
  const w = await new OpenWalletUseCase(memory).execute({
    playerId: id,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const process = new ProcessWagerTransactionUseCase(memory);
  const input = {
    walletId: w.id,
    playerId: id,
    providerId: 'provider',
    externalTransactionId: 'bet',
    idempotencyKey: 'bet-key',
    roundId: 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
  const original = await process.execute(input);
  await process.execute({
    ...input,
    externalTransactionId: 'win',
    idempotencyKey: 'win-key',
    kind: WagerTransactionKind.Win,
    money: { amount: '20.00', currency: 'BRL' },
  });

  const byId = await new GetWagerTransactionUseCase(memory).execute(
    original.transactionId,
  );
  const byExternal = await new GetProviderWagerTransactionUseCase(
    memory,
  ).execute('provider', 'bet');

  expect(byId.transaction.id).toBe(original.transactionId);
  expect(byExternal.transaction.id).toBe(original.transactionId);
  expect(byId.result?.balance.toString()).toBe('90.00');
  expect(byId.result?.version).toBe(2);
  expect(
    (await new GetWalletUseCase(memory).execute(w.id)).balance.toString(),
  ).toBe('110.00');
});
