import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Page } from 'playwright';

import {
  DbdCompanyListItem,
  DbdCompanyProfile,
  DbdCompanySearchResult,
} from '../interfaces/dbd-company.interface';
import { DbdBrowserService } from './dbd-browser.service';

const PAGE_SIZE = 10;
const REG_NO_RE = /^\d{13}$/;

/** Strip Thai number formatting ("1,000,000.00 บาท", "-") to a JS number. */
function toNumber(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Live DBD client backed by Playwright/Chromium.
 *
 * Drives the real SPA on datawarehouse.dbd.go.th and scrapes the rendered DOM.
 */
@Injectable()
export class PlaywrightDbdClient {
  private readonly logger = new Logger(PlaywrightDbdClient.name);

  constructor(private readonly browser: DbdBrowserService) {}

  async searchByName(keyword: string, page = 1): Promise<DbdCompanySearchResult> {
    const term = (keyword || '').trim();
    const currentPage = page > 0 ? page : 1;

    return this.browser.withPage(async pg => {
      await this.gotoSearch(pg, term);

      if (this.isProfileUrl(pg.url())) {
        const profile = await this.parseProfile(pg);
        const item = profile ? this.profileToListItem(profile, 1) : null;
        return {
          keyword: term,
          currentPage: 1,
          pageSize: PAGE_SIZE,
          totalCount: item ? 1 : 0,
          totalPages: 1,
          items: item ? [item] : [],
        };
      }

      if (currentPage > 1) await this.goToPage(pg, currentPage);

      const scraped = await this.parseResultsTable(pg);
      let scrapeSuspectFailure: boolean | undefined;
      if (!scraped.rows.length) {
        await this.browser.snapshot(pg, 'no-rows');
        this.logger.warn(
          `No result rows for "${term}" at ${pg.url()}. If a normal browser shows results, ` +
            'the headless browser was likely blocked/slow — try DBD_HEADLESS=false / DBD_DEBUG=true.',
        );
        scrapeSuspectFailure = true;
      }
      const totalCount = scraped.totalCount;
      const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
      const start = (currentPage - 1) * PAGE_SIZE;

      const items: DbdCompanyListItem[] = scraped.rows.map((c, idx) => ({
        rank: start + idx + 1,
        registrationNo: c[2] ?? '',
        name: c[3] ?? '',
        juristicType: c[4] ?? '',
        status: c[5] ?? '',
        businessCode: c[6] ?? '',
        businessType: c[7] ?? '',
        province: c[8] ?? '',
        registeredCapital: toNumber(c[9]),
        totalRevenue: toNumber(c[10]),
        netProfit: toNumber(c[11]),
        totalAssets: toNumber(c[12]),
        shareholderEquity: toNumber(c[13]),
      }));

      return {
        keyword: term,
        currentPage,
        pageSize: PAGE_SIZE,
        totalCount,
        totalPages,
        items,
        scrapeSuspectFailure,
      };
    });
  }

  async getByRegistrationNo(registrationNo: string): Promise<DbdCompanyProfile | null> {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) return null;

    return this.browser.withPage(async pg => {
      await this.gotoSearch(pg, id);
      if (!this.isProfileUrl(pg.url())) {
        return null;
      }
      return this.parseProfile(pg);
    });
  }

  private async gotoSearch(pg: Page, keyword: string): Promise<void> {
    const url = `${this.browser.base}/juristic/searchInfo?keyword=${encodeURIComponent(keyword)}`;

    let infosStatus: number | null = null;
    pg.on('response', r => {
      if (r.url().includes('/api/v1/company-profiles/infos')) infosStatus = r.status();
    });

    await pg.goto(url, { waitUntil: 'domcontentloaded' });
    await this.browser.dismissPopup(pg);

    const blocked = await this.browser.detectBlock(pg);
    if (blocked) {
      await this.browser.snapshot(pg, 'blocked');
      throw new ServiceUnavailableException(
        `DBD ${blocked}. The anti-bot WAF likely blocked the headless browser — try DBD_HEADLESS=false, ` +
          'and set DBD_DEBUG=true to capture a screenshot.',
      );
    }

    await Promise.race([
      pg.waitForSelector('table tbody tr', { timeout: this.browser.navigationTimeout }),
      pg.waitForURL(/\/company\/profile\//, { timeout: this.browser.navigationTimeout }),
    ]).catch(() => undefined);
    await pg.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    this.logger.log(
      `gotoSearch("${keyword}") -> url=${pg.url()} | search-XHR status=${infosStatus ?? 'NOT CALLED'}`,
    );
  }

  private isProfileUrl(url: string): boolean {
    return /\/company\/profile\//.test(url);
  }

  private async goToPage(pg: Page, page: number): Promise<void> {
    try {
      const beforeReg = await pg.evaluate(() => {
        const tables = [...document.querySelectorAll('table')];
        const t =
          tables.find(x =>
            [...x.querySelectorAll('thead th')].some(th =>
              (th.textContent || '').includes('เลขทะเบียน'),
            ),
          ) || tables[0];
        const cell = t && t.querySelector('tbody tr td:nth-child(3)');
        return cell ? (cell.textContent || '').trim() : '';
      });

      const input = pg
        .locator('.pager-wrap input.form-control.numeric, input.form-control.numeric')
        .first();
      await input.fill(String(page), { timeout: 5000 });
      await input.press('Enter');

      await pg.waitForFunction(
        (prev: string) => {
          const tables = [...document.querySelectorAll('table')];
          const t =
            tables.find(x =>
              [...x.querySelectorAll('thead th')].some(th =>
                (th.textContent || '').includes('เลขทะเบียน'),
              ),
            ) || tables[0];
          const cell = t && t.querySelector('tbody tr td:nth-child(3)');
          const v = cell ? (cell.textContent || '').trim() : '';
          return /\d{13}/.test(v) && v !== prev;
        },
        beforeReg,
        { timeout: this.browser.navigationTimeout },
      );
    } catch (e) {
      this.logger.warn(`Pagination to page ${page} failed: ${(e as Error).message}`);
    }
  }

  private async waitForResultsReady(pg: Page): Promise<void> {
    await pg
      .waitForFunction(
        () => {
          const tables = [...document.querySelectorAll('table')];
          const results = tables.find(t =>
            [...t.querySelectorAll('thead th')].some(th =>
              (th.textContent || '').includes('เลขทะเบียน'),
            ),
          );
          if (!results) return false;
          const firstReg = results.querySelector('tbody tr td:nth-child(3)');
          return !!(firstReg && /\d{13}/.test((firstReg.textContent || '').trim()));
        },
        { timeout: this.browser.navigationTimeout },
      )
      .catch(() => undefined);
  }

  private async parseResultsTable(pg: Page): Promise<{ totalCount: number; rows: string[][] }> {
    await this.waitForResultsReady(pg);
    const data = await pg.evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const tables = [...document.querySelectorAll('table')];
      const table =
        tables.find(t =>
          [...t.querySelectorAll('thead th')].some(th =>
            (th.textContent || '').includes('เลขทะเบียน'),
          ),
        ) || tables[0];
      const rows = table
        ? [...table.querySelectorAll('tbody tr')].map(tr =>
            [...tr.querySelectorAll('td')].map(td => clean((td as HTMLElement).innerText)),
          )
        : [];
      const m = document.body.innerText.match(/ค้นพบจำนวนทั้งสิ้น\s*([\d,]+)\s*รายการ/);
      const totalCountText = m ? m[1].replace(/,/g, '') : String(rows.length);
      return { totalCountText, rows };
    });
    return { totalCount: Number(data.totalCountText) || 0, rows: data.rows };
  }

  private async waitForProfileReady(pg: Page): Promise<void> {
    await pg
      .waitForFunction(
        () => {
          const all = [...document.querySelectorAll('div,td,span,dt,dd')];
          const lab = all.find(e => (e.textContent || '').trim() === 'ประเภทนิติบุคคล');
          const sib = lab?.nextElementSibling;
          return !!(sib && (sib.textContent || '').trim());
        },
        { timeout: this.browser.navigationTimeout },
      )
      .catch(() => undefined);
    await pg.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  }

  private async parseProfile(pg: Page): Promise<DbdCompanyProfile | null> {
    await this.waitForProfileReady(pg);
    const raw = await pg.evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('td,th,div,span,dt,dd,p,li,a')] as HTMLElement[];
      const valueOf = (label: string): string => {
        const el = all.find(e => clean(e.innerText) === label);
        if (!el) return '';
        if (el.nextElementSibling) return clean((el.nextElementSibling as HTMLElement).innerText);
        const sib = el.parentElement ? [...el.parentElement.children] : [];
        const i = sib.indexOf(el);
        return sib[i + 1] ? clean((sib[i + 1] as HTMLElement).innerText) : '';
      };
      const bodyText = document.body.innerText;
      const regMatch = bodyText.match(/เลขทะเบียนนิติบุคคล\s*:?\s*(\d{13})/);
      const nameHeader = clean((document.querySelector('h1,h2,h3') as HTMLElement)?.innerText);

      const dirHead = all.find(e => clean(e.innerText) === 'รายชื่อกรรมการ');
      let directors: string[] = [];
      if (dirHead) {
        const card = dirHead.closest('.card,.col,div') as HTMLElement | null;
        if (card) {
          directors = [...card.querySelectorAll('li')]
            .map(li => clean((li as HTMLElement).innerText))
            .filter(Boolean);
          if (!directors.length) {
            directors = clean(card.innerText)
              .split(/\s*\d+\.\s*/)
              .map(s => s.trim())
              .filter(s => s && s !== 'รายชื่อกรรมการ');
          }
        }
      }

      return {
        regNo: regMatch ? regMatch[1] : '',
        nameHeader,
        juristicType: valueOf('ประเภทนิติบุคคล'),
        status: valueOf('สถานะนิติบุคคล'),
        registrationDate: valueOf('วันที่จดทะเบียนจัดตั้ง'),
        registeredCapital: valueOf('ทุนจดทะเบียน'),
        paidCapital: valueOf('ทุนชำระแล้ว'),
        businessGroup: valueOf('กลุ่มธุรกิจ'),
        businessSize: valueOf('ขนาดธุรกิจ'),
        businessTypeRaw: valueOf('ประเภทธุรกิจ'),
        objective: valueOf('วัตถุประสงค์'),
        address: valueOf('ที่ตั้งสำนักงานแห่งใหญ่'),
        website: valueOf('Website'),
        financialYearsRaw: valueOf('ปีที่ส่งงบการเงิน'),
        directors,
      };
    });

    if (!raw.regNo && !raw.nameHeader) return null;

    const btMatch = raw.businessTypeRaw.match(/^(\d+)\s*(.*)$/);
    const businessCode = btMatch ? btMatch[1] : '';
    const businessType = btMatch ? btMatch[2] : raw.businessTypeRaw;

    const financialYears = (raw.financialYearsRaw.match(/\d{4}/g) || []).map(Number);

    return {
      registrationNo: raw.regNo,
      name: raw.nameHeader.replace(/^ชื่อนิติบุคคล\s*:?\s*/, '').trim(),
      juristicType: raw.juristicType,
      status: raw.status,
      registrationDate: raw.registrationDate,
      registeredCapital: toNumber(raw.registeredCapital),
      paidCapital: toNumber(raw.paidCapital),
      businessGroup: raw.businessGroup,
      businessSize: raw.businessSize,
      businessCode,
      businessType,
      objective: raw.objective,
      address: raw.address,
      website: raw.website,
      directors: raw.directors,
      authorizedDirector: '',
      financialYears,
    };
  }

  private profileToListItem(p: DbdCompanyProfile, rank: number): DbdCompanyListItem {
    return {
      rank,
      registrationNo: p.registrationNo,
      name: p.name,
      juristicType: p.juristicType,
      status: p.status,
      businessCode: p.businessCode,
      businessType: p.businessType,
      province: '',
      registeredCapital: p.registeredCapital,
      totalRevenue: 0,
      netProfit: 0,
      totalAssets: 0,
      shareholderEquity: 0,
    };
  }
}
