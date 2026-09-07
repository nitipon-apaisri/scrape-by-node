import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Page } from 'playwright';

import {
  DbdCompanyListItem,
  DbdCompanyProfile,
  DbdCompanySearchResult,
} from '../interfaces/dbd-company.interface';
import {
  DbdBalanceSheetResult,
  DbdBalanceSheetYear,
  DbdFinancialBasics,
  DbdFinancialCharts,
  DbdFinancialResult,
  DbdIncomeStatementResult,
  DbdIncomeStatementYear,
} from '../interfaces/dbd-financial.interface';
import { browserFetchDbdApi } from '../utils/dbd-browser-api.util';
import { buildProfileSlug, splitJuristicId, toBuddhistYear } from '../utils/dbd-juristic.util';
import { DbdBrowserService } from './dbd-browser.service';

const PAGE_SIZE = 10;
const REG_NO_RE = /^\d{13}$/;

/** Strip Thai number formatting ("1,000,000.00 บาท", "-") to a JS number. */
function toNumber(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function apiNum(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return toNumber(obj[key] as string | number);
  }
  return 0;
}

function apiNumOrNull(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return toNumber(obj[key] as string | number);
  }
  return null;
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
      if (!(await this.gotoProfile(pg, id))) {
        return null;
      }
      return this.parseProfile(pg);
    });
  }

  async getFinancial(registrationNo: string, year?: number): Promise<DbdFinancialResult | null> {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) return null;

    const [typeCode, fullId] = splitJuristicId(id);
    const requestedYear = year != null ? toBuddhistYear(year) : undefined;

    return this.browser.withPage(async pg => {
      if (!(await this.gotoProfile(pg, id))) {
        return null;
      }

      const chartsPath = `/api/v1/fin/basics/charts/${typeCode}/${fullId}`;
      const chartsRes = await this.fetchDbdApi(pg, chartsPath);
      const charts = chartsRes.data ? this.mapFinancialCharts(chartsRes.data) : null;

      const profile = await this.parseProfile(pg);

      let fiscalYears: number[];
      if (requestedYear != null) {
        fiscalYears = [requestedYear];
      } else {
        fiscalYears = profile?.financialYears?.length
          ? [...profile.financialYears]
          : charts?.years?.length
            ? [...charts.years]
            : [];
      }

      fiscalYears = [...new Set(fiscalYears)].sort((a, b) => a - b);

      const years: DbdFinancialBasics[] = [];
      for (const yr of fiscalYears) {
        const path = `/api/v1/fin/basics/${typeCode}/${fullId}?fiscalYear=${yr}`;
        const res = await this.fetchDbdApi(pg, path);
        if (!res.data) continue;
        const basics = this.mapFinancialBasics(res.data, yr, profile?.registeredCapital);
        if (basics) years.push(basics);
      }

      const chartsFromYears = this.buildChartsFromYears(years);

      return {
        registrationNo: id,
        years,
        charts: chartsFromYears ?? charts,
      };
    });
  }

  async getBalanceSheet(registrationNo: string, year?: number): Promise<DbdBalanceSheetResult | null> {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) return null;

    const [typeCode, fullId] = splitJuristicId(id);
    const requestedYear = year != null ? toBuddhistYear(year) : undefined;

    return this.browser.withPage(async pg => {
      if (!(await this.gotoProfile(pg, id))) {
        return null;
      }

      const profile = await this.parseProfile(pg);
      const anchorYear =
        requestedYear ??
        (profile?.financialYears?.length ? Math.max(...profile.financialYears) : undefined);

      if (!anchorYear) {
        return { registrationNo: id, anchorYear: 0, years: [] };
      }

      const path = `/api/v1/fin/balancesheet/year/${typeCode}/${fullId}?fiscalYear=${anchorYear}`;
      const res = await this.fetchDbdApi(pg, path);
      if (!res.data) {
        return { registrationNo: id, anchorYear, years: [] };
      }

      let years = this.mapBalanceSheetRows(res.data);
      if (requestedYear != null) {
        years = years.filter(y => y.fiscalYear === requestedYear);
      }

      return { registrationNo: id, anchorYear, years };
    });
  }

  async getIncomeStatement(registrationNo: string, year?: number): Promise<DbdIncomeStatementResult | null> {
    const id = (registrationNo || '').trim();
    if (!REG_NO_RE.test(id)) return null;

    const [typeCode, fullId] = splitJuristicId(id);
    const requestedYear = year != null ? toBuddhistYear(year) : undefined;

    return this.browser.withPage(async pg => {
      if (!(await this.gotoProfile(pg, id))) {
        return null;
      }

      const profile = await this.parseProfile(pg);
      const anchorYear =
        requestedYear ??
        (profile?.financialYears?.length ? Math.max(...profile.financialYears) : undefined);

      if (!anchorYear) {
        return { registrationNo: id, anchorYear: 0, years: [] };
      }

      const path = `/api/v1/fin/incomestatement/year/${typeCode}/${fullId}?fiscalYear=${anchorYear}`;
      const res = await this.fetchDbdApi(pg, path);
      if (!res.data) {
        return { registrationNo: id, anchorYear, years: [] };
      }

      let years = this.mapIncomeStatementRows(res.data);
      if (requestedYear != null) {
        years = years.filter(y => y.fiscalYear === requestedYear);
      }

      return { registrationNo: id, anchorYear, years };
    });
  }

  private mapIncomeStatementRows(raw: unknown): DbdIncomeStatementYear[] {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as Record<string, unknown>;
    const rows = Array.isArray(obj.finStatementDailyDtos)
      ? (obj.finStatementDailyDtos as Record<string, unknown>[])
      : [];

    return rows
      .map(row => this.mapIncomeStatementYear(row))
      .filter((y): y is DbdIncomeStatementYear => y != null)
      .sort((a, b) => a.fiscalYear - b.fiscalYear);
  }

  private mapIncomeStatementYear(row: Record<string, unknown>): DbdIncomeStatementYear | null {
    const fiscalYear = apiNum(row, 'fiscalYear', 'FiscalYear');
    if (!fiscalYear) return null;

    return {
      fiscalYear,
      saleRevenue: apiNumOrNull(row, 'revfromsaleorrevfromservice', 'revfromsaleorrevfromserviceA'),
      saleRevenueChangePct: apiNumOrNull(row, 'revfromsaleorrevfromservicePc'),
      totalRevenue: apiNumOrNull(row, 'revenue', 'revenueA'),
      totalRevenueChangePct: apiNumOrNull(row, 'revenuePc'),
      costOfGoodsSold: apiNumOrNull(row, 'costsofsaleofgoodorservice', 'costsofsaleofgoodorserviceA'),
      costOfGoodsSoldChangePct: apiNumOrNull(row, 'costsofsaleofgoodorservicePc'),
      grossProfit: apiNumOrNull(row, 'grossprofit', 'grossprofitA'),
      grossProfitChangePct: apiNumOrNull(row, 'grossprofitPc'),
      adminExpenses: apiNumOrNull(
        row,
        'sellingandserviceexpense',
        'sellingandserviceexpenseA',
        'administrativeexpense',
        'administrativeexpenseA',
      ),
      adminExpensesChangePct: apiNumOrNull(
        row,
        'sellingandserviceexpensePc',
        'administrativeexpensePc',
      ),
      totalExpenses: apiNumOrNull(row, 'expenses', 'expensesA'),
      totalExpensesChangePct: apiNumOrNull(row, 'expensesPc'),
      interestExpenses: apiNumOrNull(row, 'interestexpense', 'interestexpenseA'),
      interestExpensesChangePct: apiNumOrNull(row, 'interestexpensePc'),
      profitBeforeTax: apiNumOrNull(row, 'plbeforeincometaxexpense', 'plbeforeincometaxexpenseA'),
      profitBeforeTaxChangePct: apiNumOrNull(row, 'plbeforeincometaxexpensePc'),
      incomeTax: apiNumOrNull(row, 'taxexpenseincome', 'taxexpenseincomeA'),
      incomeTaxChangePct: apiNumOrNull(row, 'taxexpenseincomePc'),
      netProfit: apiNumOrNull(row, 'profitloss', 'profitlossA'),
      netProfitChangePct: apiNumOrNull(row, 'profitlossPc'),
    };
  }

  private mapBalanceSheetRows(raw: unknown): DbdBalanceSheetYear[] {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as Record<string, unknown>;
    const rows = Array.isArray(obj.finStatementDailyDtos)
      ? (obj.finStatementDailyDtos as Record<string, unknown>[])
      : [];

    return rows
      .map(row => this.mapBalanceSheetYear(row))
      .filter((y): y is DbdBalanceSheetYear => y != null)
      .sort((a, b) => a.fiscalYear - b.fiscalYear);
  }

  private mapBalanceSheetYear(row: Record<string, unknown>): DbdBalanceSheetYear | null {
    const fiscalYear = apiNum(row, 'fiscalYear', 'FiscalYear');
    if (!fiscalYear) return null;

    return {
      fiscalYear,
      accountReceivable: apiNumOrNull(row, 'traderreceivables', 'traderreceivablesA'),
      accountReceivableChangePct: apiNumOrNull(row, 'traderreceivablesPc'),
      inventory: apiNumOrNull(row, 'inventories', 'inventoriesA'),
      inventoryChangePct: apiNumOrNull(row, 'inventoriesPc'),
      totalCurrentAssets: apiNum(row, 'currentassets', 'currentassetsA'),
      totalCurrentAssetsChangePct: apiNumOrNull(row, 'currentassetsPc'),
      propertyPlantAndEquipment: apiNumOrNull(row, 'propertyplantandequipment', 'propertyplantandequipmentA'),
      propertyPlantAndEquipmentChangePct: apiNumOrNull(row, 'propertyplantandequipmentPc'),
      totalNonCurrentAssets: apiNum(row, 'noncurrentassets', 'noncurrentassetsA'),
      totalNonCurrentAssetsChangePct: apiNumOrNull(row, 'noncurrentassetsPc'),
      totalAssets: apiNum(row, 'assets', 'assetsA'),
      totalAssetsChangePct: apiNumOrNull(row, 'assetsPc'),
      currentLiabilities: apiNum(row, 'currentliabilities', 'currentliabilitiesA'),
      currentLiabilitiesChangePct: apiNumOrNull(row, 'currentliabilitiesPc'),
      nonCurrentLiabilities: apiNumOrNull(row, 'noncurrentliabilities', 'noncurrentliabilitiesA'),
      nonCurrentLiabilitiesChangePct: apiNumOrNull(row, 'noncurrentliabilitiesPc'),
      totalLiabilities: apiNum(row, 'liabilities', 'liabilitiesA'),
      totalLiabilitiesChangePct: apiNumOrNull(row, 'liabilitiesPc'),
      shareholderEquity: apiNum(row, 'equity', 'equityA'),
      shareholderEquityChangePct: apiNumOrNull(row, 'equityPc'),
      totalLiabilitiesAndEquity: apiNum(row, 'liabilitiesandequity', 'liabilitiesandequityA'),
      totalLiabilitiesAndEquityChangePct: apiNumOrNull(row, 'liabilitiesandequityPc'),
    };
  }

  private async fetchDbdApi(
    pg: Page,
    path: string,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const result = await pg.evaluate(browserFetchDbdApi, path);

    if (!result.ok) {
      this.logger.warn(`DBD API ${path} failed: status=${result.status} error=${result.error ?? 'unknown'}`);
      if (result.status === 401 || result.status === 403) {
        await this.browser.snapshot(pg, 'api-auth-failed');
        throw new ServiceUnavailableException(
          `DBD API auth failed (${result.status}) for ${path}. Try DBD_HEADLESS=false / DBD_DEBUG=true.`,
        );
      }
      return { ok: false, status: result.status, data: null };
    }

    return { ok: true, status: result.status, data: result.data };
  }

  private mapFinancialBasics(
    raw: unknown,
    requestedYear?: number,
    registeredCapital = 0,
  ): DbdFinancialBasics | null {
    const row = this.unwrapFinancialRow(raw);
    if (!row) return null;

    const fiscalYear =
      apiNum(row, 'fiscalYear', 'FiscalYear', 'statementYear', 'StatementYear') ||
      requestedYear ||
      0;
    if (!fiscalYear) return null;

    return {
      fiscalYear,
      registeredCapital: apiNum(row, 'registeredCapital', 'RegisterCapital', 'registerCapital') || registeredCapital,
      paidUpCapital: apiNum(row, 'paidUpCapital', 'PaidUpCapital', 'paidCapital'),
      totalRevenue: apiNum(row, 'revenueA', 'totalRevenue', 'TotalRevenue'),
      saleRevenue: apiNum(row, 'revfromsaleorrevfromserviceA', 'saleRevenue', 'SaleRevenue'),
      costOfGoodsSold: apiNum(row, 'costsofsaleofgoodorserviceA', 'costOfGoodsSold', 'CostOfGoodsSold'),
      adminExpenses: apiNum(row, 'administrativeexpenseA', 'adminExpenses', 'AdminExpenses'),
      netProfit: apiNum(row, 'profitlossA', 'netProfit', 'NetProfit'),
      totalAssets: apiNum(row, 'assetsA', 'totalAssets', 'TotalAsset', 'totalAsset'),
      totalCurrentAssets: apiNum(row, 'currentassetsA', 'totalCurrentAssets', 'TotalCurrentAsset', 'totalCurrentAsset'),
      totalLiabilities: apiNum(row, 'liabilitiesA', 'totalLiabilities', 'TotalLiabilities'),
      currentLiabilities: apiNum(row, 'currentliabilitiesA', 'currentLiabilities', 'CurrentLiabilities'),
      shareholderEquity: apiNum(row, 'equityA', 'shareholderEquity', 'ShareholderEquity'),
      accountReceivable: apiNum(row, 'traderreceivablesA', 'accountReceivable', 'AccountReceivable'),
      inventory: apiNum(row, 'inventoriesA', 'inventory', 'Inventory'),
      interestExpenses: apiNum(row, 'interestexpenseA', 'interestExpenses', 'InterestExpenses'),
      incomeTax: apiNum(row, 'taxexpenseincomeA', 'incomeTax', 'IncomeTax'),
      earningPerShare: apiNum(row, 'earningPerShare', 'EarningPerShare'),
    };
  }

  private buildChartsFromYears(years: DbdFinancialBasics[]): DbdFinancialCharts | null {
    if (!years.length) return null;
    const sorted = [...years].sort((a, b) => a.fiscalYear - b.fiscalYear);
    return {
      years: sorted.map(y => y.fiscalYear),
      totalRevenue: sorted.map(y => y.totalRevenue),
      netProfit: sorted.map(y => y.netProfit),
      totalAssets: sorted.map(y => y.totalAssets),
      shareholderEquity: sorted.map(y => y.shareholderEquity),
    };
  }

  private unwrapFinancialRow(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    if (Array.isArray(obj.data) && obj.data.length) {
      return obj.data[0] as Record<string, unknown>;
    }
    if (Array.isArray(raw) && raw.length) {
      return raw[0] as Record<string, unknown>;
    }
    if (obj.result && typeof obj.result === 'object') {
      return obj.result as Record<string, unknown>;
    }
    if (obj.basics && typeof obj.basics === 'object') {
      return obj.basics as Record<string, unknown>;
    }

    const hasFigures = ['revenueA', 'profitlossA', 'assetsA', 'totalRevenue', 'TotalRevenue', 'netProfit', 'NetProfit'].some(
      k => k in obj,
    );
    return hasFigures ? obj : null;
  }

  private mapFinancialCharts(raw: unknown): DbdFinancialCharts | null {
    const rows = this.unwrapFinancialChartRows(raw);
    if (!rows.length) return null;

    const years: number[] = [];
    const totalRevenue: number[] = [];
    const netProfit: number[] = [];
    const totalAssets: number[] = [];
    const shareholderEquity: number[] = [];

    for (const row of rows) {
      const year =
        apiNum(row, 'fiscalYear', 'FiscalYear', 'statementYear', 'StatementYear', 'year', 'Year') ||
        toNumber(String(row.label ?? row.name ?? ''));
      if (!year) continue;

      years.push(year);
      totalRevenue.push(apiNum(row, 'totalRevenue', 'TotalRevenue'));
      netProfit.push(apiNum(row, 'netProfit', 'NetProfit'));
      totalAssets.push(apiNum(row, 'totalAssets', 'TotalAsset', 'totalAsset'));
      shareholderEquity.push(apiNum(row, 'shareholderEquity', 'ShareholderEquity'));
    }

    if (!years.length) return null;
    return { years, totalRevenue, netProfit, totalAssets, shareholderEquity };
  }

  private unwrapFinancialChartRows(raw: unknown): Record<string, unknown>[] {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as Record<string, unknown>;

    if (Array.isArray(raw)) return raw as Record<string, unknown>[];
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
    if (Array.isArray(obj.items)) return obj.items as Record<string, unknown>[];
    if (Array.isArray(obj.series)) return obj.series as Record<string, unknown>[];

    const labels = obj.labels ?? obj.years ?? obj.fiscalYears;
    if (Array.isArray(labels)) {
      const rev = (obj.totalRevenue ?? obj.TotalRevenue ?? obj.revenues) as unknown[];
      const profit = (obj.netProfit ?? obj.NetProfit ?? obj.profits) as unknown[];
      const assets = (obj.totalAssets ?? obj.TotalAsset ?? obj.assets) as unknown[];
      const equity = (obj.shareholderEquity ?? obj.ShareholderEquity ?? obj.equity) as unknown[];

      return (labels as unknown[]).map((label, i) => ({
        fiscalYear: toNumber(String(label)),
        totalRevenue: rev?.[i],
        netProfit: profit?.[i],
        totalAssets: assets?.[i],
        shareholderEquity: equity?.[i],
      }));
    }

    return [];
  }

  private buildProfileUrl(registrationNo: string): string {
    return `${this.browser.base}/company/profile/${buildProfileSlug(registrationNo)}`;
  }

  /** Open a company profile; falls back to direct URL when search stays on the results page. */
  private async gotoProfile(pg: Page, registrationNo: string): Promise<boolean> {
    await this.gotoSearch(pg, registrationNo);
    if (this.isProfileUrl(pg.url())) {
      return true;
    }

    const profileUrl = this.buildProfileUrl(registrationNo);
    this.logger.log(`Search did not redirect to profile; navigating directly to ${profileUrl}`);

    await pg.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await this.browser.dismissPopup(pg);

    const blocked = await this.browser.detectBlock(pg);
    if (blocked) {
      await this.browser.snapshot(pg, 'blocked-profile');
      throw new ServiceUnavailableException(
        `DBD ${blocked}. The anti-bot WAF likely blocked the headless browser — try DBD_HEADLESS=false, ` +
          'and set DBD_DEBUG=true to capture a screenshot.',
      );
    }

    await this.waitForProfileReady(pg);
    if (this.isProfileUrl(pg.url())) {
      this.logger.log(`gotoProfile("${registrationNo}") -> url=${pg.url()}`);
      return true;
    }

    await this.browser.snapshot(pg, 'profile-unreachable');
    return false;
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
