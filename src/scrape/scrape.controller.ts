import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';

import { SearchQuery } from './dto/search.query';
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
}
