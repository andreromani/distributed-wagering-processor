import { FinancialApplicationError } from '../errors/financial-application.error.js';

export interface LedgerPosition {
  createdAt: string;
  id: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeLedgerCursor(
  walletId: string,
  position: LedgerPosition,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, walletId, ...position }),
  ).toString('base64url');
}

export function decodeLedgerCursor(
  cursor: string,
  walletId: string,
): LedgerPosition {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('Invalid encoding');
    }
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) {
      throw new Error('Invalid encoding');
    }
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid structure');
    }
    if (
      !('version' in value) ||
      value.version !== 1 ||
      !('walletId' in value) ||
      value.walletId !== walletId ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id) ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt) ||
      Object.keys(value).length !== 4
    ) {
      throw new Error('Invalid position');
    }
    const date = new Date(value.createdAt);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !== value.createdAt.slice(0, 23) + 'Z'
    ) {
      throw new Error('Invalid timestamp');
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new FinancialApplicationError('INVALID_INPUT');
  }
}
