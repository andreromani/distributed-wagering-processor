import { createHash } from 'node:crypto';
import { Money } from '../../domain/value-objects/money.js';
import type { WagerPayload } from '../ports/wager-payload.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }

  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
        .join(',') +
      '}'
    );
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Unsupported canonical JSON value');
  }

  return serialized;
}

export function canonicalPayloadHash(payload: WagerPayload): string {
  const fields = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    walletId: payload.walletId,
    playerId: payload.playerId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };

  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
