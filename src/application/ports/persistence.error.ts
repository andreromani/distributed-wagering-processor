export class PersistenceError extends Error {
  constructor(
    readonly category: 'unique' | 'transient' | 'permanent',
    readonly constraint?: string,
  ) {
    super('Financial persistence failed');
    this.name = 'PersistenceError';
  }
}
