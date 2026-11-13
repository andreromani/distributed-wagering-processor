import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WagerMessageDto } from './wager-message.dto.js';
import { InvalidWagerMessageError } from './invalid-wager-message.error.js';
import { Money } from '../../../domain/value-objects/money.js';
import { WagerTransactionKind as Kind } from '../../../domain/financial.types.js';

export async function parseWagerMessage(
  body: string,
): Promise<WagerMessageDto> {
  try {
    if (Buffer.byteLength(body, 'utf8') > 262144) {
      throw new InvalidWagerMessageError();
    }
    const raw: unknown = JSON.parse(body);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidWagerMessageError();
    }
    const message = plainToInstance(WagerMessageDto, raw, {
      enableImplicitConversion: false,
    });
    const errors = await validate(message, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    });
    if (errors.length) {
      throw new InvalidWagerMessageError();
    }
    const data = message.data;
    if (
      data.providerId === 'internal' ||
      ((data.kind === Kind.Refund || data.kind === Kind.Rollback) &&
        !data.referenceExternalTransactionId) ||
      (data.referenceExternalTransactionId !== undefined &&
        ![Kind.Win, Kind.Refund, Kind.Rollback].includes(data.kind))
    ) {
      throw new InvalidWagerMessageError();
    }
    Money.from(data.money);
    return message;
  } catch {
    throw new InvalidWagerMessageError();
  }
}
