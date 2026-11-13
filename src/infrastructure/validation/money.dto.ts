import { IsString, IsIn, Matches, MaxLength } from 'class-validator';

export class MoneyDto {
  @IsString()
  @MaxLength(31)
  @Matches(/^(0|[1-9]\d*)\.\d{2}(?![\s\S])/)
  declare readonly amount: string;

  @IsIn(['BRL', 'USD'])
  declare readonly currency: string;
}
