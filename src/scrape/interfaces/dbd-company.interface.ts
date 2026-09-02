/**
 * DBD DataWarehouse lookup — domain types.
 *
 * Field names mirror the data shown on https://datawarehouse.dbd.go.th.
 *
 * Two search modes:
 *   1. by registration number (13 digits) -> a single company profile
 *   2. by name (free text)                -> a paginated list of matching companies
 */

/** One row in a name-search result table. */
export interface DbdCompanyListItem {
  /** Display rank within the current page (1-based). */
  rank: number;
  /** เลขทะเบียนนิติบุคคล — 13-digit juristic registration number. */
  registrationNo: string;
  /** ชื่อนิติบุคคล — juristic person name. */
  name: string;
  /** ประเภทนิติบุคคล — e.g. "บริษัทจำกัด", "ห้างหุ้นส่วนจำกัด", "บริษัทมหาชนจำกัด". */
  juristicType: string;
  /** สถานะ — e.g. "ยังดำเนินกิจการอยู่". */
  status: string;
  /** รหัสประเภทธุรกิจ — TSIC business code (e.g. "46102"). */
  businessCode: string;
  /** ชื่อประเภทธุรกิจ — TSIC business description. */
  businessType: string;
  /** จังหวัด — province. */
  province: string;
  /** ทุนจดทะเบียน (บาท). */
  registeredCapital: number;
  /** รายได้รวม (บาท) — latest filed financial year. */
  totalRevenue: number;
  /** กำไร (ขาดทุน) สุทธิ (บาท). */
  netProfit: number;
  /** สินทรัพย์รวม (บาท). */
  totalAssets: number;
  /** ส่วนของผู้ถือหุ้น (บาท). */
  shareholderEquity: number;
}

/** Paginated name-search result. */
export interface DbdCompanySearchResult {
  keyword: string;
  /** Current 1-based page. */
  currentPage: number;
  /** Number of rows per page (DBD shows 10). */
  pageSize: number;
  /** Total number of matching juristic persons. */
  totalCount: number;
  /** Total number of pages. */
  totalPages: number;
  items: DbdCompanyListItem[];
  /**
   * `true` when a live scrape returned zero rows without throwing — ambiguous
   * between "DBD genuinely has no results" and "the scraper was silently
   * blocked/timed out".
   */
  scrapeSuspectFailure?: boolean;
}

/** Full company profile — returned when searching by registration number. */
export interface DbdCompanyProfile {
  registrationNo: string;
  name: string;
  juristicType: string;
  status: string;
  /** วันที่จดทะเบียนจัดตั้ง (ISO date or display string). */
  registrationDate: string;
  registeredCapital: number;
  /** ทุนชำระแล้ว (บาท). */
  paidCapital: number;
  /** กลุ่มธุรกิจ. */
  businessGroup: string;
  /** ขนาดธุรกิจ (S/M/L). */
  businessSize: string;
  businessCode: string;
  businessType: string;
  /** วัตถุประสงค์. */
  objective: string;
  /** ที่ตั้งสำนักงานแห่งใหญ่. */
  address: string;
  website: string;
  /** รายชื่อกรรมการ. */
  directors: string[];
  /** กรรมการลงชื่อผูกพัน (อำนาจกรรมการ). */
  authorizedDirector: string;
  /** ปีที่ส่งงบการเงิน. */
  financialYears: number[];
}
