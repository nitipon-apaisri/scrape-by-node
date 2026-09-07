/** Key financial figures for one fiscal year (ข้อมูลงบการเงิน). */
export interface DbdFinancialBasics {
  fiscalYear: number;
  registeredCapital: number;
  paidUpCapital: number;
  totalRevenue: number;
  saleRevenue: number;
  costOfGoodsSold: number;
  adminExpenses: number;
  netProfit: number;
  totalAssets: number;
  totalCurrentAssets: number;
  totalLiabilities: number;
  currentLiabilities: number;
  shareholderEquity: number;
  accountReceivable: number;
  inventory: number;
  interestExpenses: number;
  incomeTax: number;
  earningPerShare: number;
}

/** Multi-year chart series from /api/v1/fin/basics/charts. */
export interface DbdFinancialCharts {
  years: number[];
  totalRevenue: number[];
  netProfit: number[];
  totalAssets: number[];
  shareholderEquity: number[];
}

export interface DbdFinancialResult {
  registrationNo: string;
  /** Full key figures per filed fiscal year (พ.ศ.), sorted ascending. */
  years: DbdFinancialBasics[];
  /** Multi-year summary series for charting. */
  charts: DbdFinancialCharts | null;
}

/** One fiscal year from /api/v1/fin/balancesheet/year (งบแสดงฐานะการเงิน). */
export interface DbdBalanceSheetYear {
  fiscalYear: number;
  accountReceivable: number | null;
  accountReceivableChangePct: number | null;
  inventory: number | null;
  inventoryChangePct: number | null;
  totalCurrentAssets: number;
  totalCurrentAssetsChangePct: number | null;
  propertyPlantAndEquipment: number | null;
  propertyPlantAndEquipmentChangePct: number | null;
  totalNonCurrentAssets: number;
  totalNonCurrentAssetsChangePct: number | null;
  totalAssets: number;
  totalAssetsChangePct: number | null;
  currentLiabilities: number;
  currentLiabilitiesChangePct: number | null;
  nonCurrentLiabilities: number | null;
  nonCurrentLiabilitiesChangePct: number | null;
  totalLiabilities: number;
  totalLiabilitiesChangePct: number | null;
  shareholderEquity: number;
  shareholderEquityChangePct: number | null;
  totalLiabilitiesAndEquity: number;
  totalLiabilitiesAndEquityChangePct: number | null;
}

export interface DbdBalanceSheetResult {
  registrationNo: string;
  /** Fiscal year passed to DBD (latest filed year when omitted). */
  anchorYear: number;
  /** Balance sheet rows sorted ascending by fiscal year. */
  years: DbdBalanceSheetYear[];
}

/** One fiscal year from /api/v1/fin/incomestatement/year (งบกำไรขาดทุน). */
export interface DbdIncomeStatementYear {
  fiscalYear: number;
  saleRevenue: number | null;
  saleRevenueChangePct: number | null;
  totalRevenue: number | null;
  totalRevenueChangePct: number | null;
  costOfGoodsSold: number | null;
  costOfGoodsSoldChangePct: number | null;
  grossProfit: number | null;
  grossProfitChangePct: number | null;
  adminExpenses: number | null;
  adminExpensesChangePct: number | null;
  totalExpenses: number | null;
  totalExpensesChangePct: number | null;
  interestExpenses: number | null;
  interestExpensesChangePct: number | null;
  profitBeforeTax: number | null;
  profitBeforeTaxChangePct: number | null;
  incomeTax: number | null;
  incomeTaxChangePct: number | null;
  netProfit: number | null;
  netProfitChangePct: number | null;
}

export interface DbdIncomeStatementResult {
  registrationNo: string;
  /** Fiscal year passed to DBD (latest filed year when omitted). */
  anchorYear: number;
  /** Income statement rows sorted ascending by fiscal year. */
  years: DbdIncomeStatementYear[];
}
