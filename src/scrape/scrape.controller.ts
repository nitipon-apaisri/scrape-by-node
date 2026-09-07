import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';

import { SearchQuery } from './dto/search.query';
import { FinancialQuery } from './dto/financial.query';
import { PlaywrightDbdClient } from './providers/playwright-dbd.client';

const REG_NO_RE = /^\d{13}$/;

@Controller()
export class ScrapeController {
  constructor(private readonly client: PlaywrightDbdClient) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('search')
  search(@Query() query: SearchQuery) {
    return this.client.searchByName(query.keyword, query.page ?? 1);
  }

  @Get('profile/:registrationNo')
  async profile(@Param('registrationNo') registrationNo: string) {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) {
      throw new BadRequestException('registrationNo must be exactly 13 digits');
    }
    const profile = await this.client.getByRegistrationNo(id);
    if (!profile) {
      throw new NotFoundException(`No profile found for registration number ${id}`);
    }
    return profile;
  }

  @Get('profile/:registrationNo/financial/balance-sheet')
  async balanceSheet(
    @Param('registrationNo') registrationNo: string,
    @Query() query: FinancialQuery,
  ) {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) {
      throw new BadRequestException('registrationNo must be exactly 13 digits');
    }
    const balanceSheet = await this.client.getBalanceSheet(id, query.year);
    if (!balanceSheet) {
      throw new NotFoundException(`No profile found for registration number ${id}`);
    }
    return balanceSheet;
  }

  @Get('profile/:registrationNo/financial/income-statement')
  async incomeStatement(
    @Param('registrationNo') registrationNo: string,
    @Query() query: FinancialQuery,
  ) {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) {
      throw new BadRequestException('registrationNo must be exactly 13 digits');
    }
    const incomeStatement = await this.client.getIncomeStatement(id, query.year);
    if (!incomeStatement) {
      throw new NotFoundException(`No profile found for registration number ${id}`);
    }
    return incomeStatement;
  }

  @Get('profile/:registrationNo/financial')
  async financial(
    @Param('registrationNo') registrationNo: string,
    @Query() query: FinancialQuery,
  ) {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) {
      throw new BadRequestException('registrationNo must be exactly 13 digits');
    }
    const financial = await this.client.getFinancial(id, query.year);
    if (!financial) {
      throw new NotFoundException(`No profile found for registration number ${id}`);
    }
    return financial;
  }
}
