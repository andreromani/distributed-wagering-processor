import {
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';
import type { WagerEventData } from './wager-transaction-processed.event.js';

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    props: IntegrationEventProps<WagerEventData>,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}
