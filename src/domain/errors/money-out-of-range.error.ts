export class MoneyOutOfRangeError extends Error {
  constructor() {
    super('Amount exceeds the supported monetary range');
    this.name = 'MoneyOutOfRangeError';
  }
}
