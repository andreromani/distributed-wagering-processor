export class InvalidMoneyAmountError extends Error {
  constructor() {
    super('Amount must be a decimal string with exactly two decimal places');
    this.name = 'InvalidMoneyAmountError';
  }
}
export class InvalidCurrencyError extends Error {
  constructor() {
    super('Supported currencies are BRL and USD');
    this.name = 'InvalidCurrencyError';
  }
}
export class CurrencyMismatchError extends Error {
  constructor() {
    super('Money currencies must match');
    this.name = 'CurrencyMismatchError';
  }
}
export class MoneyOutOfRangeError extends Error {
  constructor() {
    super('Amount exceeds the supported monetary range');
    this.name = 'MoneyOutOfRangeError';
  }
}
