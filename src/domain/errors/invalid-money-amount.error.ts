export class InvalidMoneyAmountError extends Error {
  constructor() {
    super('Amount must be a decimal string with exactly two decimal places');
    this.name = 'InvalidMoneyAmountError';
  }
}
