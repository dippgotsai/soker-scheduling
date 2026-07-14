import { db, type StoreRow, type ShiftTypeRow, type UserRow } from './db';
import {
  validateSchedule, shiftSpan, addDays, type WorkDay, type Violation, type StoreRules,
} from './laborlaw';

export function storeRules(store: StoreRow): StoreRules {
  return {
    scheduleMode: store.schedule_mode,
    eightweekAnchor: store.eightweek_anchor,
    otMonthlyCapMinutes: store.ot_monthly_cap_minutes,
    maxConsecutiveDays: store.max_consecutive_days,
    forbidClopening: !!store.forbid_clopening,
  };
}

/** 載入某員工在 [from, to]（含前後緩衝）之 WorkDay 陣列（跨門市合併計算工時） */
export function loadWorkDays(userId: number, from: string, to: string): WorkDay[] {
  const bufFrom = addDays(from, -56);
  const bufTo = addDays(to, 56);
  const rows = db().prepare(
    `SELECT s.date, st.start_time, st.end_time, st.break_minutes
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.user_id = ? AND s.date BETWEEN ? AND ?`
  ).all(userId, bufFrom, bufTo) as { date: string; start_time: string; end_time: string; break_minutes: number }[];

  const rests = db().prepare(
    `SELECT date, kind FROM rest_days WHERE user_id = ? AND date BETWEEN ? AND ?`
  ).all(userId, bufFrom, bufTo) as { date: string; kind: 'regular' | 'rest' }[];
  const restMap = new Map(rests.map(r => [r.date, r.kind]));

  const days: WorkDay[] = rows.map(r => {
    const span = shiftSpan(r.start_time, r.end_time);
    return {
      date: r.date,
      startMin: span.startMin,
      endMin: span.endMin,
      workMinutes: Math.max(0, span.endMin - span.startMin - r.break_minutes),
      restKind: null,
    };
  });
  for (const [date, kind] of restMap) {
    if (!days.some(d => d.date === date)) {
      days.push({ date, startMin: 0, endMin: 0, workMinutes: 0, restKind: kind });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export function approvedOtMap(userId: number, from: string, to: string): Map<string, number> {
  const rows = db().prepare(
    `SELECT date, SUM(minutes) AS m FROM overtime_requests
     WHERE user_id = ? AND status = 'approved' AND date BETWEEN ? AND ? GROUP BY date`
  ).all(userId, addDays(from, -95), addDays(to, 95)) as { date: string; m: number }[];
  return new Map(rows.map(r => [r.date, r.m]));
}

/** 檢核某員工在期間內的班表 */
export function validateUserSchedule(user: UserRow, store: StoreRow, from: string, to: string): Violation[] {
  const days = loadWorkDays(user.id, from, to);
  return validateSchedule(days, storeRules(store), {
    checkFrom: from,
    checkTo: to,
    flags: { isMinor: !!user.is_minor, isPregnant: !!user.is_pregnant },
    approvedOtByDate: approvedOtMap(user.id, from, to),
  });
}

/** 檢核整間門市一個月的班表，回傳 userId → violations */
export function validateStoreMonth(store: StoreRow, ym: string): Map<number, Violation[]> {
  const from = `${ym}-01`;
  const to = endOfMonth(ym);
  const users = db().prepare(
    `SELECT DISTINCT u.* FROM users u
     JOIN user_stores us ON us.user_id = u.id
     WHERE us.store_id = ? AND u.active = 1`
  ).all(store.id) as UserRow[];
  const out = new Map<number, Violation[]>();
  for (const u of users) {
    const v = validateUserSchedule(u, store, from, to);
    if (v.length) out.set(u.id, v);
  }
  return out;
}

export function endOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export function monthDates(ym: string): string[] {
  const out: string[] = [];
  const end = endOfMonth(ym);
  for (let d = `${ym}-01`; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 人力需求缺口：回傳 date → shift_type_id → { need, have } */
export function staffingGaps(store: StoreRow, ym: string) {
  const reqs = db().prepare(
    `SELECT weekday, shift_type_id, min_staff FROM staffing_requirements WHERE store_id = ?`
  ).all(store.id) as { weekday: number; shift_type_id: number; min_staff: number }[];
  const counts = db().prepare(
    `SELECT date, shift_type_id, COUNT(*) AS c FROM shifts
     WHERE store_id = ? AND date LIKE ? GROUP BY date, shift_type_id`
  ).all(store.id, `${ym}-%`) as { date: string; shift_type_id: number; c: number }[];
  const countMap = new Map(counts.map(r => [`${r.date}|${r.shift_type_id}`, r.c]));
  const gaps: { date: string; shiftTypeId: number; need: number; have: number }[] = [];
  for (const date of monthDates(ym)) {
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    for (const r of reqs.filter(x => x.weekday === wd)) {
      const have = countMap.get(`${date}|${r.shift_type_id}`) ?? 0;
      if (have < r.min_staff) gaps.push({ date, shiftTypeId: r.shift_type_id, need: r.min_staff, have });
    }
  }
  return gaps;
}

export function storeShiftTypes(storeId: number): ShiftTypeRow[] {
  return db().prepare(
    `SELECT * FROM shift_types WHERE store_id = ? AND active = 1 ORDER BY start_time`
  ).all(storeId) as ShiftTypeRow[];
}

export function storeMembers(storeId: number): UserRow[] {
  return db().prepare(
    `SELECT u.* FROM users u JOIN user_stores us ON us.user_id = u.id
     WHERE us.store_id = ? AND u.active = 1 ORDER BY u.employee_no`
  ).all(storeId) as UserRow[];
}
