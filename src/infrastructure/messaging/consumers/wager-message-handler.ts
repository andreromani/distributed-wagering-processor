import type {
  ProcessWagerInput,
  ProcessWagerResult,
} from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionStatus as Status } from '../../../domain/financial.types.js';
import { transactionCancellation } from '../../database/transaction-cancellation.js';
import type { WagerDelivery, WagerQueue } from '../sqs/wager-queue.js';
import type { WorkerOptions } from '../../config/worker-options.js';
import { parseWagerMessage } from './parse-wager-message.js';
import { classifyMessageError } from './message-error-classifier.js';
import { retryDelay } from '../retry-delay.js';
import { MessagingDiagnostics } from '../messaging-diagnostics.js';

export const WAGER_CONSUMER_NAME = 'wager-financial-v1';
export interface HandlingResult {
  continueGroup: boolean;
  retrySeconds: number;
}

export class WagerMessageHandler {
  constructor(
    private readonly process: {
      execute(input: ProcessWagerInput): Promise<ProcessWagerResult>;
    },
    private readonly queue: WagerQueue,
    private readonly options: WorkerOptions,
    private readonly diagnostics: MessagingDiagnostics,
  ) {}

  async handle(
    delivery: WagerDelivery,
    signal: AbortSignal,
    settled: () => Promise<void> = async () => {},
  ): Promise<HandlingResult> {
    const started = performance.now();
    const fields: Record<string, unknown> = {
      consumerName: WAGER_CONSUMER_NAME,
      sqsMessageId: delivery.sqsMessageId,
      attempt: delivery.receiveCount,
    };
    this.diagnostics.event('message_handling_started', fields);
    let messageId: string | undefined;
    let committed = false;
    try {
      signal.throwIfAborted();
      const message = await parseWagerMessage(delivery.body);
      messageId = message.messageId;
      const correlationId = message.correlationId ?? crypto.randomUUID();
      Object.assign(fields, {
        messageId,
        correlationId,
        causationId: message.causationId ?? messageId,
        walletId: message.data.walletId,
        providerId: message.data.providerId,
      });
      signal.throwIfAborted();
      const result = await transactionCancellation.run(signal, () =>
        this.process.execute({
          providerId: message.data.providerId,
          externalTransactionId: message.data.externalTransactionId,
          idempotencyKey: message.data.idempotencyKey,
          walletId: message.data.walletId,
          playerId: message.data.playerId,
          roundId: message.data.roundId,
          gameId: message.data.gameId,
          kind: message.data.kind,
          money: {
            amount: message.data.money.amount,
            currency: message.data.money.currency,
          },
          referenceExternalTransactionId:
            message.data.referenceExternalTransactionId,
          correlationId,
          causationId: message.causationId ?? messageId,
          inbox: {
            consumerName: WAGER_CONSUMER_NAME,
            messageId: message.messageId,
          },
        }),
      );
      committed = result.canAcknowledge;
      await settled();
      Object.assign(fields, {
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
      });
      signal.throwIfAborted();
      if (!result.canAcknowledge) {
        throw new Error('Unconfirmed inbox result');
      }
      if (result.status === Status.Pending) {
        fields.failureCode = 'TRANSACTION_NOT_SETTLED';
        throw new Error('Financial transaction is not settled');
      }
      if (result.idempotentReplay) {
        this.diagnostics.increment('replays');
      }
      if (result.status !== Status.Failed) {
        this.diagnostics.increment(
          result.status === Status.Rejected ? 'rejected' : 'processed',
        );
      }
      this.diagnostics.event('financial_result', fields);
      this.diagnostics.processing(result);
      if (result.status === Status.Failed) {
        await this.queue.deadLetter(delivery, 'TERMINAL_FAILED', messageId);
        this.diagnostics.increment('dlq');
        this.diagnostics.event('message_dead_lettered', {
          ...fields,
          failureCode: 'TERMINAL_FAILED',
        });
      }
      await this.acknowledge(delivery, fields);
      return { continueGroup: true, retrySeconds: 0 };
    } catch (error) {
      await settled();
      if (signal.aborted) {
        return this.retry(delivery, 0, {
          ...fields,
          failureCode: 'PROCESSING_CANCELLED',
        });
      }
      if (!committed) {
        const classification = classifyMessageError(error);
        if (classification.kind === 'permanent') {
          try {
            await this.queue.deadLetter(
              delivery,
              classification.code,
              messageId,
            );
            this.diagnostics.increment('dlq');
            this.diagnostics.event('message_dead_lettered', {
              ...fields,
              failureCode: classification.code,
            });
            await this.acknowledge(delivery, fields);
            return { continueGroup: true, retrySeconds: 0 };
          } catch {
            this.diagnostics.event('dlq_or_ack_failed', fields);
          }
        }
        Object.assign(fields, { failureCode: classification.code });
      }
      const delay = retryDelay(
        delivery.receiveCount,
        this.options.retryBaseSeconds,
        this.options.retryMaxSeconds,
      );
      if (delivery.receiveCount >= this.options.maxReceives) {
        this.diagnostics.increment('exhausted');
        this.diagnostics.event('message_attempts_exhausted', fields);
      }
      return this.retry(delivery, delay, fields);
    } finally {
      this.diagnostics.duration((performance.now() - started) / 1000);
    }
  }

  private async acknowledge(
    delivery: WagerDelivery,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.queue.acknowledge(delivery);
      this.diagnostics.event('message_acknowledged', fields);
    } catch (error) {
      this.diagnostics.increment('ackFailures');
      this.diagnostics.event('message_ack_failed', fields);
      throw error;
    }
  }

  private async retry(
    delivery: WagerDelivery,
    seconds: number,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<HandlingResult> {
    this.diagnostics.increment('retries');
    this.diagnostics.event('message_retry', {
      ...fields,
      delaySeconds: seconds,
    });
    try {
      await this.queue.visibility(delivery, seconds);
    } catch {
      this.diagnostics.increment('visibilityFailures');
      this.diagnostics.event('visibility_change_failed', fields);
    }
    return { continueGroup: false, retrySeconds: seconds };
  }
}
