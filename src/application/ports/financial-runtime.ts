export interface FinancialRuntime {
  now(): Date;
  id(): string;
}

export const systemFinancialRuntime: FinancialRuntime = {
  now: () => new Date(),
  id: () => crypto.randomUUID(),
};
