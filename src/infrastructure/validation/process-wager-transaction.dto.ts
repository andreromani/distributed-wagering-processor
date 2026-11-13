import {
  IsUUID,
  IsString,
  MaxLength,
  Matches,
  IsIn,
  IsDefined,
  IsObject,
  ValidateNested,
  ValidateIf,
  NotContains,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from './money.dto.js';
import { WagerTransactionKind as Kind } from '../../domain/financial.types.js';

export class ProcessWagerTransactionDto {
  @IsString()
  @MaxLength(256)
  @NotContains('\0')
  @Matches(/\S/)
  declare readonly providerId: string;

  @IsString()
  @MaxLength(256)
  @NotContains('\0')
  @Matches(/\S/)
  declare readonly externalTransactionId: string;

  @IsString()
  @MaxLength(256)
  @NotContains('\0')
  @Matches(/\S/)
  declare readonly roundId: string;

  @IsString()
  @MaxLength(256)
  @NotContains('\0')
  @Matches(/\S/)
  declare readonly gameId: string;

  @IsUUID('all')
  declare readonly walletId: string;

  @IsUUID('all')
  declare readonly playerId: string;

  @IsIn([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])
  declare readonly kind: Kind;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  declare readonly money: MoneyDto;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(256)
  @NotContains('\0')
  @Matches(/\S/)
  declare readonly referenceExternalTransactionId?: string;
}
