import { IsUUID, IsDefined, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from './money.dto.js';

export class CreateWalletDto {
  @IsUUID('all')
  declare readonly playerId: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  declare readonly initialBalance: MoneyDto;
}
