// 台灣勞基法排班檢核引擎
//
// 支援兩種工時制度（依門市設定）：
//  - standard：標準工時（§30、§36 一例一休）
//  - eightweek：八週變形工時（§30-1，需為指定行業且經工會/勞資會議同意）
//
// 共同限制：
//  §32  每日正常＋延長 ≤ 12 小時；每月延長 ≤ 46hr（勞資會議同意可至 54hr，3 個月合計 ≤ 138hr）
//  §34  更換班次時，休息時間至少連續 11 小時
//  §36  每 7 日至少 1 例假（八週變形下例假仍不可挪移，僅休息日可於 8 週內挪移）
//
// 八週變形：
//  - 每日正常工時 ≤ 8 小時（不得分配至他日）
//  - 每週工作總時數 ≤ 48 小時
//  - 8 週內正常工時總計 ≤ 320 小時
//  - 8 週內例假＋休息日合計 ≥ 16 日
//
// 標準工時：
//  - 每日正常 ≤ 8、每週正常 ≤ 40
//  - 每 7 日應有 1 例假＋1 休息日

export interface WorkDay {
  date: string;            // YYYY-MM-DD
  startMin: number;        // 當日 00:00 起算分鐘
  endMin: number;          // 可能 > 1440（跨日班）
  workMinutes: number;     // 扣除休息時間之實際工作分鐘
  restKind?: 'regular' | 'rest' | null; // 例假/休息日標記（無班日）
}

export interface Violation {
  level: 'error' | 'warning';
  code: string;
  date?: string;
  message: string;
}

export interface StoreRules {
  scheduleMode: 'standard' | 'eightweek';
  eightweekAnchor?: string | null;      // 週期起算日
  otMonthlyCapMinutes: number;          // 2760 (46h) 或 3240 (54h)
  maxConsecutiveDays: number;           // 內規（≤ 法規上限）
  forbidClopening: boolean;
}

export interface PersonFlags {
  isMinor?: boolean;
  isPregnant?: boolean;
}

const DAY = 1440;
const NORMAL_DAILY = 8 * 60;
const MAX_DAILY = 12 * 60;
const MIN_SHIFT_GAP = 11 * 60;

export function dateToUTC(d: string): number {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}
export function addDays(d: string, n: number): string {
  const t = new Date(dateToUTC(d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}
export function diffDays(a: string, b: string): number {
  return Math.round((dateToUTC(a) - dateToUTC(b)) / 86400000);
}
export function weekdayOf(d: string): number {
  return new Date(dateToUTC(d)).getUTCDay(); // 0=Sun
}
/** 該日所屬週的週一 */
export function mondayOf(d: string): string {
  const wd = weekdayOf(d);
  return addDays(d, wd === 0 ? -6 : 1 - wd);
}

export function parseHM(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
export function fmtHM(min: number): string {
  const m = ((min % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function fmtHours(min: number): string {
  return (min / 60).toFixed(min % 60 === 0 ? 0 : 1);
}

/** 班別起訖 → 分鐘區間（end <= start 視為跨日） */
export function shiftSpan(startHM: string, endHM: string): { startMin: number; endMin: number } {
  const s = parseHM(startHM);
  let e = parseHM(endHM);
  if (e <= s) e += DAY;
  return { startMin: s, endMin: e };
}

/**
 * 檢核單一員工在一段期間內的班表。
 * days：該員工期間內（含前後緩衝，建議前後各多帶 14 天班）之工作/休假資料，需依日期排序。
 * checkFrom / checkTo：只回報此區間內的違規（緩衝日僅供跨週期計算）。
 */
export function validateSchedule(
  days: WorkDay[],
  rules: StoreRules,
  opts: { checkFrom: string; checkTo: string; flags?: PersonFlags; approvedOtByDate?: Map<string, number> }
): Violation[] {
  const v: Violation[] = [];
  const { checkFrom, checkTo, flags = {}, approvedOtByDate = new Map() } = opts;
  const work = days.filter(d => d.workMinutes > 0).sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(work.map(d => [d.date, d]));
  const inRange = (d: string) => d >= checkFrom && d <= checkTo;

  // ---- 每日工時 ----
  for (const d of work) {
    if (!inRange(d.date)) continue;
    const ot = approvedOtByDate.get(d.date) ?? 0;
    const total = d.workMinutes + ot;
    if (total > MAX_DAILY) {
      v.push({ level: 'error', code: 'DAILY_12H', date: d.date,
        message: `${d.date} 工時 ${fmtHours(total)} 小時，超過每日 12 小時上限（勞基法 §32）` });
    } else if (d.workMinutes > NORMAL_DAILY) {
      v.push({ level: 'warning', code: 'DAILY_OT', date: d.date,
        message: `${d.date} 排班工時 ${fmtHours(d.workMinutes)} 小時，超過 8 小時部分屬延長工時，須經加班申請並給付加班費` });
    }
    // 未成年工：不得於 20:00–06:00 工作（§48）；每日 ≤ 8hr（§47）
    if (flags.isMinor) {
      if (d.endMin > 20 * 60 || d.startMin < 6 * 60) {
        v.push({ level: 'error', code: 'MINOR_NIGHT', date: d.date,
          message: `${d.date} 未成年工不得於 20:00–06:00 間工作（勞基法 §48）` });
      }
      if (d.workMinutes > NORMAL_DAILY) {
        v.push({ level: 'error', code: 'MINOR_8H', date: d.date,
          message: `${d.date} 未成年工每日工時不得超過 8 小時（勞基法 §47）` });
      }
    }
    // 妊娠/哺乳：不得於 22:00–06:00 工作（§49）
    if (flags.isPregnant && (d.endMin > 22 * 60 || d.startMin < 6 * 60)) {
      v.push({ level: 'error', code: 'PREGNANT_NIGHT', date: d.date,
        message: `${d.date} 妊娠或哺乳期間員工不得於 22:00–06:00 間工作（勞基法 §49）` });
    }
  }

  // ---- §34 班次間隔 11 小時 ----
  for (let i = 1; i < work.length; i++) {
    const prev = work[i - 1], cur = work[i];
    if (!inRange(cur.date) && !inRange(prev.date)) continue;
    const gapDays = diffDays(cur.date, prev.date);
    if (gapDays <= 0 || gapDays > 2) continue;
    const prevEndAbs = prev.endMin;                       // prev.date 00:00 起算
    const curStartAbs = cur.startMin + gapDays * DAY;
    const gap = curStartAbs - prevEndAbs;
    if (gap < MIN_SHIFT_GAP) {
      v.push({ level: 'error', code: 'GAP_11H', date: cur.date,
        message: `${prev.date} 下班（${fmtHM(prev.endMin)}）至 ${cur.date} 上班（${fmtHM(cur.startMin)}）僅間隔 ${fmtHours(gap)} 小時，未達 11 小時（勞基法 §34）` });
    } else if (rules.forbidClopening && gapDays === 1 && prev.endMin > DAY - 180 + 0 && gap < 14 * 60) {
      v.push({ level: 'warning', code: 'CLOPENING', date: cur.date,
        message: `${cur.date} 晚班接早班（間隔 ${fmtHours(gap)} 小時），違反門市內規` });
    }
  }

  // ---- 連續工作日數 ----
  if (work.length > 0) {
    let runStart = work[0].date, runLen = 1;
    const flushRun = (endDate: string) => {
      const legalLimit = rules.scheduleMode === 'eightweek' ? 12 : 6;
      if (runLen > legalLimit && (inRange(endDate) || inRange(runStart))) {
        v.push({ level: 'error', code: 'CONSECUTIVE', date: endDate,
          message: `${runStart} 起連續工作 ${runLen} 天，超過${rules.scheduleMode === 'eightweek' ? '八週變形下例假挪移之 12 天上限' : '「七休一」之 6 天上限（勞基法 §36）'}` });
      } else if (runLen > rules.maxConsecutiveDays && (inRange(endDate) || inRange(runStart))) {
        v.push({ level: 'warning', code: 'CONSECUTIVE_POLICY', date: endDate,
          message: `${runStart} 起連續工作 ${runLen} 天，超過門市內規上限 ${rules.maxConsecutiveDays} 天` });
      }
    };
    for (let i = 1; i < work.length; i++) {
      if (diffDays(work[i].date, work[i - 1].date) === 1) { runLen++; }
      else { flushRun(work[i - 1].date); runStart = work[i].date; runLen = 1; }
    }
    flushRun(work[work.length - 1].date);
  }

  // ---- 週工時 ----
  const weeks = new Map<string, number>(); // 週一 → 正常工時分鐘
  for (const d of work) {
    const wk = mondayOf(d.date);
    weeks.set(wk, (weeks.get(wk) ?? 0) + Math.min(d.workMinutes, NORMAL_DAILY));
  }
  const weeklyCap = rules.scheduleMode === 'eightweek' ? 48 * 60 : 40 * 60;
  for (const [wk, mins] of weeks) {
    const wkEnd = addDays(wk, 6);
    if (wkEnd < checkFrom || wk > checkTo) continue;
    if (mins > weeklyCap) {
      v.push({ level: 'error', code: 'WEEKLY_CAP', date: wk,
        message: `${wk} 起該週正常工時 ${fmtHours(mins)} 小時，超過${rules.scheduleMode === 'eightweek' ? '八週變形每週 48 小時' : '每週 40 小時'}上限` });
    }
  }

  // ---- 每 7 日 1 例假（兩制皆適用；標準工時另需 1 休息日）----
  // 以「週一起算之曆週」檢查：該週內至少 1 日未排班且標記/視為例假。
  const allByDate = new Map(days.map(d => [d.date, d]));
  const weekKeys = new Set<string>();
  for (let d = mondayOf(checkFrom); d <= checkTo; d = addDays(d, 7)) weekKeys.add(d);
  for (const wk of weekKeys) {
    let offDays = 0, regularMarked = 0, scheduledDays = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(wk, i);
      const rec = allByDate.get(date);
      if (rec && rec.workMinutes > 0) { scheduledDays++; continue; }
      offDays++;
      if (rec?.restKind === 'regular') regularMarked++;
    }
    if (scheduledDays === 0) continue; // 整週未排班（可能未排到）不檢查
    if (offDays < 1) {
      v.push({ level: 'error', code: 'WEEKLY_REGULAR_OFF', date: wk,
        message: `${wk} 起該週無任何休假日，違反每 7 日至少 1 例假（勞基法 §36）` });
    } else if (regularMarked < 1) {
      v.push({ level: 'warning', code: 'REGULAR_UNMARKED', date: wk,
        message: `${wk} 起該週尚未標記「例假」，請於排班表將其中一休假日標為例假` });
    }
    if (rules.scheduleMode === 'standard' && scheduledDays > 5 && offDays < 2) {
      v.push({ level: 'error', code: 'ONE_REST_ONE_REGULAR', date: wk,
        message: `${wk} 起該週僅 ${offDays} 日休假，標準工時應每 7 日 1 例假＋1 休息日（一例一休）` });
    }
  }

  // ---- 八週變形：320 小時 / 16 日休假 ----
  if (rules.scheduleMode === 'eightweek' && rules.eightweekAnchor) {
    const anchor = rules.eightweekAnchor;
    const cycleOf = (d: string) => Math.floor(diffDays(d, anchor) / 56);
    const cycles = new Set<number>();
    for (let d = checkFrom; d <= checkTo; d = addDays(d, 1)) cycles.add(cycleOf(d));
    for (const c of cycles) {
      if (c < 0) continue;
      const cs = addDays(anchor, c * 56);
      const ce = addDays(cs, 55);
      let normal = 0, off = 0, coveredScheduled = 0;
      for (let d = cs; d <= ce; d = addDays(d, 1)) {
        const rec = allByDate.get(d);
        if (rec && rec.workMinutes > 0) { normal += Math.min(rec.workMinutes, NORMAL_DAILY); coveredScheduled++; }
        else off++;
      }
      if (coveredScheduled === 0) continue;
      if (normal > 320 * 60) {
        v.push({ level: 'error', code: 'CYCLE_320H', date: cs,
          message: `八週週期（${cs} ～ ${ce}）正常工時合計 ${fmtHours(normal)} 小時，超過 320 小時上限（勞基法 §30-1）` });
      }
      // 只有當週期已排滿（接近排完）才對 16 日休假做 error，否則提示
      if (off < 16) {
        const level = ce <= checkTo ? 'error' : 'warning';
        v.push({ level, code: 'CYCLE_16OFF', date: cs,
          message: `八週週期（${cs} ～ ${ce}）目前僅 ${off} 日休假，法定應有例假＋休息日合計至少 16 日` });
      }
    }
  }

  // ---- 每月加班上限 ----
  const otByMonth = new Map<string, number>();
  for (const [date, mins] of approvedOtByDate) {
    const mo = date.slice(0, 7);
    otByMonth.set(mo, (otByMonth.get(mo) ?? 0) + mins);
  }
  for (const d of work) {
    if (d.workMinutes > NORMAL_DAILY) {
      const mo = d.date.slice(0, 7);
      otByMonth.set(mo, (otByMonth.get(mo) ?? 0) + (d.workMinutes - NORMAL_DAILY));
    }
  }
  for (const [mo, mins] of otByMonth) {
    if (mo < checkFrom.slice(0, 7) || mo > checkTo.slice(0, 7)) continue;
    if (mins > rules.otMonthlyCapMinutes) {
      v.push({ level: 'error', code: 'MONTHLY_OT', date: `${mo}-01`,
        message: `${mo} 月加班合計 ${fmtHours(mins)} 小時，超過每月上限 ${fmtHours(rules.otMonthlyCapMinutes)} 小時（勞基法 §32）` });
    } else if (rules.otMonthlyCapMinutes > 2760 && mins > 2760) {
      v.push({ level: 'warning', code: 'MONTHLY_OT_46', date: `${mo}-01`,
        message: `${mo} 月加班合計 ${fmtHours(mins)} 小時已逾 46 小時，採 54 小時上限者 3 個月合計不得逾 138 小時，請留意` });
    }
  }

  return v.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

// ---- 加班費率試算（§24、§39）----
export interface OtPaySegment { multiplier: number; minutes: number; label: string }

export function overtimePaySegments(dayKind: 'workday' | 'restday' | 'national_holiday', minutes: number): OtPaySegment[] {
  const segs: OtPaySegment[] = [];
  let rest = minutes;
  const take = (cap: number) => { const t = Math.min(rest, cap); rest -= t; return t; };
  if (dayKind === 'workday') {
    const a = take(120); if (a) segs.push({ multiplier: 4 / 3, minutes: a, label: '平日前 2 小時 ×1.34' });
    const b = take(120); if (b) segs.push({ multiplier: 5 / 3, minutes: b, label: '平日再延長 2 小時 ×1.67' });
    if (rest > 0) segs.push({ multiplier: 5 / 3, minutes: rest, label: '超過 12 小時部分（違法，不應發生）' });
  } else if (dayKind === 'restday') {
    const a = take(120); if (a) segs.push({ multiplier: 4 / 3, minutes: a, label: '休息日前 2 小時 ×1.34' });
    const b = take(360); if (b) segs.push({ multiplier: 5 / 3, minutes: b, label: '休息日 2–8 小時 ×1.67' });
    if (rest > 0) segs.push({ multiplier: 8 / 3, minutes: rest, label: '休息日逾 8 小時 ×2.67' });
  } else {
    segs.push({ multiplier: 2, minutes, label: '國定假日出勤加倍發給（另 8 小時內給 1 日工資）' });
  }
  return segs;
}
