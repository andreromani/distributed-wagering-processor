import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class ListWalletLedgerQueryDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^(?:[1-9]|[1-9][0-9]|100)$/)
  declare readonly limit?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/)
  declare readonly cursor?: string;
}
