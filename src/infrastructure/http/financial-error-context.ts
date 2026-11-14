export interface FinancialErrorIdentifiers {
  providerId?: string;
  walletId?: string;
  transactionId?: string;
}

const contexts = new WeakMap<object, Readonly<FinancialErrorIdentifiers>>();

/** Call only after the controller's DTO and parameter pipes have succeeded. */
export function setFinancialErrorContext(
  response: object,
  identifiers: FinancialErrorIdentifiers,
): void {
  contexts.set(response, Object.freeze({ ...identifiers }));
}

export function financialErrorContext(
  response: object,
): Readonly<FinancialErrorIdentifiers> {
  return contexts.get(response) ?? {};
}
