import { timestamp } from '../errors/timestamp.js';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly #receivedAt: number;
  #processedAt: number | undefined;

  private constructor(state: InboxMessageState) {
    this.consumerName = state.consumerName;
    this.messageId = state.messageId;
    this.payloadHash = state.payloadHash;
    this.#receivedAt = timestamp(state.receivedAt);
    this.#processedAt =
      state.processedAt === undefined
        ? undefined
        : timestamp(state.processedAt);
    Object.freeze(this);
  }

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.#receivedAt);
  }

  get processedAt(): Date | undefined {
    return this.#processedAt === undefined
      ? undefined
      : new Date(this.#processedAt);
  }

  isProcessed(): boolean {
    return this.#processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new Error('Inbox message already processed');
    }
    this.#processedAt = timestamp(at);
  }
}
