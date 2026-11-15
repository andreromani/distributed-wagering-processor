export interface FinancialObserver {
  record(
    event: string,
    fields: Readonly<Record<string, unknown>>,
    level: 'debug' | 'warn' | 'error',
  ): void;
}

export interface FinancialObservation {
  observer: FinancialObserver;
  fields: Readonly<Record<string, unknown>>;
}

export const silentFinancialObserver: FinancialObserver = { record: () => {} };

export function observeFinancial(
  observation: FinancialObservation | undefined,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
  level: 'debug' | 'warn' | 'error' = 'debug',
): void {
  try {
    observation?.observer.record(
      event,
      { ...observation.fields, ...fields },
      level,
    );
  } catch {
    // Observers are optional diagnostics, never a financial dependency.
  }
}
