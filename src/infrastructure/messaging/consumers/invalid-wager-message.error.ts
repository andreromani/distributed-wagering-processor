export class InvalidWagerMessageError extends Error {
  constructor() {
    super('INVALID_MESSAGE');
    this.name = 'InvalidWagerMessageError';
  }
}
