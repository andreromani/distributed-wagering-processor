import {
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';
import type { WagerEventData } from './wager-transaction-processed.event.js';

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    props: IntegrationEventProps<WagerEventData>,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}
