import {
  IsString,
  MaxLength,
  Matches,
  IsIn,
  IsISO8601,
  IsDefined,
  IsObject,
  ValidateNested,
  ValidateIf,
  NotContains,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WagerMessageDataDto } from './wager-message-data.dto.js';

export class WagerMessageDto {
  @IsString()
  @MaxLength(256)
  @Matches(/\S/)
  @NotContains('\0')
  declare readonly messageId: string;

  @IsIn(['WagerTransactionRequested'])
  declare readonly type: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  declare readonly occurredAt: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => WagerMessageDataDto)
  declare readonly data: WagerMessageDataDto;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/)
  declare readonly correlationId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/)
  declare readonly causationId?: string;
}
