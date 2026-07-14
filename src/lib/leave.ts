import { db } from './db';
import { addDays } from './laborlaw';

// 特休天數（勞基法 §38，週年制）：
// 6個月以上未滿1年 → 3日；1年 → 7日；2年 → 10日；3年 → 14日；5年 → 15日；
// 10年以上每滿1年加1日，加至30日為止。
export function annualLeaveDays(seniorityYears: number): number {
  if (seniorityYears < 0.5) return 0;
  if (seniorityYears < 1) return 3;
  if (seniorityYears < 2) return 7;
  if (seniorityYears < 3) return 10;
  if (seniorityYears < 5) return 14;
  if (seniorityYears < 10) return 15;
  return Math.min(30, 15 + Math.floor(seniorityYears - 9));
}

/** 以週年制回傳某員工「今日適用」的特休週期與應給天數 */
export function currentAnnualLeavePeriod(hireDate: string, today: string): { start: string; end: string; days: number } | null {
  const hire = new Date(hireDate + 'T00:00:00Z');
  const now = new Date(today + 'T00:00:00Z');
  const yearsExact = (now.getTime() - hire.getTime()) / (365.25 * 86400000);
  if (yearsExact < 0.5) return null;
  if (yearsExact < 1) {
    // 滿半年起至滿一年前一日，給 3 日
    const start = new Date(hire); start.setUTCMonth(start.getUTCMonth() + 6);
    const end = new Date(hire); end.setUTCFullYear(end.getUTCFullYear() + 1);
    return { start: start.toISOString().slice(0, 10), end: addDays(end.toISOString().slice(0, 10), -1), days: 3 };
  }
  const fullYears = Math.floor(yearsExact);
  const start = new Date(hire); start.setUTCFullYear(start.getUTCFullYear() + fullYears);
  const end = new Date(hire); end.setUTCFullYear(end.getUTCFullYear() + fullYears + 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: addDays(end.toISOString().slice(0, 10), -1),
    days: annualLeaveDays(fullYears),
  };
}

/** 確保員工目前週期的特休額度已建立，回傳餘額（分鐘） */
export function ensureAnnualLeaveBalance(userId: number, hireDate: string, today: string) {
  const lt = db().prepare(`SELECT id FROM leave_types WHERE code = 'annual'`).get() as { id: number } | undefined;
  if (!lt) return null;
  const period = currentAnnualLeavePeriod(hireDate, today);
  if (!period) return null;
  db().prepare(
    `INSERT OR IGNORE INTO leave_balances (user_id, leave_type_id, period_start, period_end, granted_minutes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, lt.id, period.start, period.end, period.days * 8 * 60);
  return db().prepare(
    `SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND period_start = ?`
  ).get(userId, lt.id, period.start) as { granted_minutes: number; used_minutes: number; period_end: string } | undefined;
}

/** 補休可用餘額（分鐘，未逾期） */
export function compTimeBalance(userId: number, today: string): number {
  const row = db().prepare(
    `SELECT COALESCE(SUM(minutes - used_minutes), 0) AS bal FROM comp_time
     WHERE user_id = ? AND expires_at >= ? AND minutes > used_minutes`
  ).get(userId, today) as { bal: number };
  return row.bal;
}

export const SYSTEM_LEAVE_TYPES: Array<{
  code: string; name: string; annual_quota_minutes: number | null; pay_ratio: number; sort_order: number;
}> = [
  { code: 'annual',    name: '特休',        annual_quota_minutes: null,      pay_ratio: 1,   sort_order: 1 },  // 依年資
  { code: 'comp',      name: '補休',        annual_quota_minutes: null,      pay_ratio: 1,   sort_order: 2 },  // 依加班換發
  { code: 'personal',  name: '事假',        annual_quota_minutes: 14 * 480,  pay_ratio: 0,   sort_order: 3 },
  { code: 'sick',      name: '普通傷病假',  annual_quota_minutes: 30 * 480,  pay_ratio: 0.5, sort_order: 4 },
  { code: 'menstrual', name: '生理假',      annual_quota_minutes: 12 * 480,  pay_ratio: 0.5, sort_order: 5 },  // 每月1日
  { code: 'marriage',  name: '婚假',        annual_quota_minutes: 8 * 480,   pay_ratio: 1,   sort_order: 6 },
  { code: 'funeral',   name: '喪假',        annual_quota_minutes: 8 * 480,   pay_ratio: 1,   sort_order: 7 },  // 依親等 3/6/8 日
  { code: 'official',  name: '公假',        annual_quota_minutes: null,      pay_ratio: 1,   sort_order: 8 },
  { code: 'maternity', name: '產假',        annual_quota_minutes: 56 * 480,  pay_ratio: 1,   sort_order: 9 },
  { code: 'paternity', name: '陪產檢及陪產假', annual_quota_minutes: 7 * 480, pay_ratio: 1,  sort_order: 10 },
  { code: 'family',    name: '家庭照顧假',  annual_quota_minutes: 7 * 480,   pay_ratio: 0,   sort_order: 11 }, // 併入事假計算
];
