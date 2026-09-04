import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class FinancialQuery {
  /** Fiscal year — พ.ศ. (e.g. 2569) or ค.ศ. (e.g. 2026, auto-converted). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  year?: number;
}
