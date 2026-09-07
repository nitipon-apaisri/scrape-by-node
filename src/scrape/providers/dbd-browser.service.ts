import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Owns a single long-lived Chromium instance + one browser context, used by
 * {@link PlaywrightDbdClient} to drive datawarehouse.dbd.go.th.
 *
 * One persistent, warm context reuses WAF/session cookies; navigations are serialized
 * (one at a time). Launched lazily on first use.
 */
@Injectable()
export class DbdBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(DbdBrowserService.name);
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /** Promise chain that serializes access to the single shared page. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly baseUrl: string;
  private readonly headless: boolean;
  private readonly navTimeout: number;
  private readonly browserChannel: string;
  private readonly blockAssets: boolean;
  private readonly userAgent =
    process.env.DBD_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('dbd.baseUrl', 'https://datawarehouse.dbd.go.th');
    this.headless = this.config.get<boolean>('dbd.headless', false);
    this.navTimeout = this.config.get<number>('dbd.navTimeoutMs', 30000);
    this.browserChannel = this.config.get<string | undefined>('dbd.browserChannel');
    this.blockAssets = this.config.get<boolean>('dbd.blockAssets', true);
  }

  get base(): string {
    return this.baseUrl;
  }

  get navigationTimeout(): number {
    return this.navTimeout;
  }

  get debug(): boolean {
    return this.config.get<boolean>('dbd.debug', false);
  }

  /**
   * Run `fn` with an exclusive, ready-to-use page. Calls are queued so only one
   * runs at a time against the shared session.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.exec(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exec<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(this.navTimeout);
    page.setDefaultNavigationTimeout(this.navTimeout);
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new ServiceUnavailableException(
        'Playwright is not installed. Run `pnpm install` (postinstall installs Chromium).',
      );
    }

    const channel = this.browserChannel?.trim() || undefined;
    this.logger.log(
      `Launching browser (channel=${channel || 'bundled-chromium'}, headless=${this.headless}) for DBD lookups`,
    );
    try {
      this.browser = await chromium.launch({
        ...(channel ? { channel } : {}),
        headless: this.headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });
      this.context = await this.browser.newContext({
        userAgent: this.userAgent,
        locale: 'th-TH',
        viewport: { width: 1440, height: 900 },
      });
    } catch (e) {
      const error = e as Error;
      this.logger.error(`DBD browser launch failed: ${error.message}`, error.stack);
      await this.browser?.close().catch(() => undefined);
      this.browser = null;
      this.context = null;

      if (/Executable doesn't exist/i.test(error.message)) {
        throw new ServiceUnavailableException(
          'Chromium binary missing. Run `npx playwright install chromium`.',
        );
      }
      throw new ServiceUnavailableException(
        'DBD lookup browser failed to start. Retry or set DBD_HEADLESS=false / DBD_BROWSER_CHANNEL=chrome.',
      );
    }

    if (this.blockAssets) {
      await this.context.route('**/*', route => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort();
        return route.continue();
      });
    }

    try {
      const page = await this.context.newPage();
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissPopup(page);
      await page.close().catch(() => undefined);
    } catch (e) {
      this.logger.warn(`DBD session warm-up failed: ${(e as Error).message}`);
    }

    return this.context;
  }

  async detectBlock(page: Page): Promise<string | null> {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '');
      const title = await page.title();
      const haystack = `${title}\n${text}`;
      if (
        /Incapsula|Imperva|Request unsuccessful|_Incapsula_Resource|Pardon the interruption|unusual traffic|Access Denied/i.test(
          haystack,
        )
      ) {
        return `WAF/anti-bot page detected (title="${title}")`;
      }
      return null;
    } catch {
      return null;
    }
  }

  async snapshot(page: Page, label: string): Promise<void> {
    if (!this.debug) return;
    const dir = process.env.DBD_DEBUG_DIR || tmpdir();
    const stamp = `${label}-${Date.now()}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      const png = join(dir, `dbd-${stamp}.png`);
      const html = join(dir, `dbd-${stamp}.html`);
      await page.screenshot({ path: png, fullPage: true }).catch(() => undefined);
      await fs.writeFile(html, await page.content()).catch(() => undefined);
      this.logger.warn(
        `[debug] ${label}: url=${page.url()} title="${await page.title().catch(() => '?')}" -> ${png}`,
      );
    } catch (e) {
      this.logger.warn(`[debug] snapshot failed: ${(e as Error).message}`);
    }
  }

  async dismissPopup(page: Page): Promise<void> {
    try {
      const closeBtn = page.locator('button:has-text("ปิด")').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click({ timeout: 2000 });
      }
    } catch {
      // popup not present — fine
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}
