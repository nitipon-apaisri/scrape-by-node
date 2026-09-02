import { Module } from '@nestjs/common';

import { ScrapeController } from './scrape.controller';
import { DbdBrowserService } from './providers/dbd-browser.service';
import { PlaywrightDbdClient } from './providers/playwright-dbd.client';

@Module({
  controllers: [ScrapeController],
  providers: [DbdBrowserService, PlaywrightDbdClient],
  exports: [PlaywrightDbdClient],
})
export class ScrapeModule {}
