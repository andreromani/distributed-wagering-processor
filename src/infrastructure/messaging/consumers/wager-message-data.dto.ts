import { IsString, Matches, NotContains } from 'class-validator';
import { ProcessWagerTransactionDto } from '../../validation/process-wager-transaction.dto.js';

export class WagerMessageDataDto extends ProcessWagerTransactionDto {
  @IsString()
  @Matches(/^[\x20-\x7E]{1,256}$/)
  @Matches(/\S/)
  @Matches(/^(?!opening:)/)
  @NotContains(',')
  declare readonly idempotencyKey: string;
}
