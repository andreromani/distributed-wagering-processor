export type MessagingMetric =
  | 'received'
  | 'processed'
  | 'replays'
  | 'rejected'
  | 'retries'
  | 'dlq'
  | 'ackFailures'
  | 'published'
  | 'publishFailures'
  | 'pending'
  | 'exhausted'
  | 'visibilityFailures'
  | 'pendingReferenceResolved'
  | 'pendingReferenceRescheduled'
  | 'pendingReferenceRejected'
  | 'pendingReferenceFailures';

export class MessagingDiagnostics {
  readonly instanceId = crypto.randomUUID();
  readonly #values = new Map<MessagingMetric, number>();

  constructor(
    private readonly sink: (
      record: Readonly<Record<string, unknown>>,
    ) => void = (record) => console.log(JSON.stringify(record)),
  ) {}

  increment(metric: MessagingMetric): void {
    this.#values.set(metric, (this.#values.get(metric) ?? 0) + 1);
  }

  pending(value: number): void {
    this.#values.set('pending', value);
  }

  snapshot(): Readonly<Partial<Record<MessagingMetric, number>>> {
    return Object.freeze(Object.fromEntries(this.#values));
  }

  event(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.sink({ event, instanceId: this.instanceId, ...fields });
  }
}
