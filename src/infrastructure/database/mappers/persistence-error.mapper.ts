import { PersistenceError } from '../../../application/ports/persistence.error.js';

export function persistenceError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (
    error.message === 'Query read timeout' ||
    error.message === 'timeout exceeded when trying to connect'
  ) {
    return new PersistenceError('transient');
  }

  const driver: unknown = 'driverError' in error ? error.driverError : error;
  if (
    driver === null ||
    typeof driver !== 'object' ||
    !('code' in driver) ||
    typeof driver.code !== 'string'
  ) {
    return error;
  }

  if (
    !/^[0-9A-Z]{5}$/.test(driver.code) &&
    !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(driver.code)
  ) {
    return error;
  }

  const constraint =
    'constraint' in driver && typeof driver.constraint === 'string'
      ? driver.constraint
      : undefined;
  if (driver.code === '23505') {
    return new PersistenceError('unique', constraint);
  }

  if (
    [
      '40001',
      '40P01',
      '55P03',
      '57014',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
    ].includes(driver.code) ||
    driver.code.startsWith('08')
  ) {
    return new PersistenceError('transient');
  }

  return new PersistenceError('permanent', constraint);
}
