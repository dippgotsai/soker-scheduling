'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db, type StoreRow, type UserRow } from '@/lib/db';
import {
  login, logout, requireUser, requireManager, requireAdmin,
  canManageStore, hashPassword, isManager,
} from '@/lib/auth';
import { validateUserSchedule } from '@/lib/schedule';
import { ensureAnnualLeaveBalance, compTimeBalance } from '@/lib/leave';
import { addDays } from '@/lib/laborlaw';

function s(fd: FormData, key: string): string {
  return String(fd.get(key) ?? '').trim();
}
function n(fd: FormData, key: string): number {
  return Number(fd.get(key) ?? 0);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function backTo(fd: FormData, fallback: string, msg?: string, isErr = false): never {
  const base = s(fd, 'back') || fallback;
  const sep = base.includes('?') ? '&' : '?';
  redirect(msg ? `${base}${sep}${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}` : base);
}

// ---------- 認證 ----------
export async function loginAction(fd: FormData) {
  const u = await login(s(fd, 'account'), s(fd, 'password'));
  if (!u) redirect('/login?err=' + encodeURIComponent('帳號或密碼錯誤'));
  redirect('/');
}

export async function logoutAction() {
  await logout();
  redirect('/login');
}

export async function changePasswordAction(fd: FormData) {
  const u = await requireUser();
  const oldPw = s(fd, 'old_password'), newPw = s(fd, 'new_password');
  if (newPw.length < 8) backTo(fd, '/profile', '新密碼至少 8 碼', true);
  const bcrypt = (await import('bcryptjs')).default;
  if (!bcrypt.compareSync(oldPw, u.password_hash)) backTo(fd, '/profile', '舊密碼錯誤', true);
  db().prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPw), u.id);
  backTo(fd, '/profile', '密碼已更新');
}

// ---------- 排班 ----------
function getStore(storeId: number): StoreRow {
  const st = db().prepare(`SELECT * FROM stores WHERE id = ?`).get(storeId) as StoreRow | undefined;
  if (!st) throw new Error('門市不存在');
  return st;
}

export async function assignShiftAction(fd: FormData) {
  const mgr = await requireManager();
  const storeId = n(fd, 'store_id'), userId = n(fd, 'user_id');
  const date = s(fd, 'date'), shiftTypeId = n(fd, 'shift_type_id');
  const force = s(fd, 'force') === '1';
  if (!canManageStore(mgr, storeId)) backTo(fd, '/schedule', '無此門市管理權限', true);
  const store = getStore(storeId);
  const target = db().prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
  if (!target) backTo(fd, '/schedule', '員工不存在', true);

  const d = db();
  d.prepare(`DELETE FROM rest_days WHERE user_id = ? AND date = ?`).run(userId, date);
  d.prepare(
    `INSERT INTO shifts (store_id, user_id, date, shift_type_id, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET store_id = excluded.store_id,
       shift_type_id = excluded.shift_type_id, created_by = excluded.created_by`
  ).run(storeId, userId, date, shiftTypeId, mgr.id);

  // 法規檢核：error 且未強制 → 回復並拒絕
  const viol = validateUserSchedule(target!, store, date, date);
  const errors = viol.filter(v => v.level === 'error');
  if (errors.length && !force) {
    d.prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(userId, date);
    backTo(fd, '/schedule', `排班被拒：${errors[0].message}（如仍要排入請勾選「強制排入」）`, true);
  }
  revalidatePath('/schedule');
  const warn = viol.find(v => v.level === 'warning');
  backTo(fd, '/schedule', warn ? `已排入，但請注意：${warn.message}` : '已排入班表');
}

export async function removeShiftAction(fd: FormData) {
  const mgr = await requireManager();
  const userId = n(fd, 'user_id'), date = s(fd, 'date');
  const row = db().prepare(`SELECT store_id FROM shifts WHERE user_id = ? AND date = ?`).get(userId, date) as { store_id: number } | undefined;
  if (row && !canManageStore(mgr, row.store_id)) backTo(fd, '/schedule', '無此門市管理權限', true);
  db().prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(userId, date);
  revalidatePath('/schedule');
  backTo(fd, '/schedule', '已清除該日排班');
}

export async function markRestDayAction(fd: FormData) {
  const mgr = await requireManager();
  const storeId = n(fd, 'store_id'), userId = n(fd, 'user_id');
  const date = s(fd, 'date'), kind = s(fd, 'kind');
  if (!canManageStore(mgr, storeId)) backTo(fd, '/schedule', '無此門市管理權限', true);
  const d = db();
  d.prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(userId, date);
  if (kind === 'regular' || kind === 'rest') {
    d.prepare(
      `INSERT INTO rest_days (store_id, user_id, date, kind) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET kind = excluded.kind, store_id = excluded.store_id`
    ).run(storeId, userId, date, kind);
  } else {
    d.prepare(`DELETE FROM rest_days WHERE user_id = ? AND date = ?`).run(userId, date);
  }
  revalidatePath('/schedule');
  backTo(fd, '/schedule', kind === 'regular' ? '已標記例假' : kind === 'rest' ? '已標記休息日' : '已清除標記');
}

// ---------- 請假 ----------
export async function createLeaveRequestAction(fd: FormData) {
  const u = await requireUser();
  const storeId = n(fd, 'store_id');
  const leaveTypeId = n(fd, 'leave_type_id');
  const startDate = s(fd, 'start_date'), endDate = s(fd, 'end_date') || startDate;
  const startTime = s(fd, 'start_time') || null, endTime = s(fd, 'end_time') || null;
  const reason = s(fd, 'reason');
  if (!startDate || endDate < startDate) backTo(fd, '/requests', '日期不正確', true);

  const lt = db().prepare(`SELECT * FROM leave_types WHERE id = ?`).get(leaveTypeId) as
    { id: number; code: string; name: string; annual_quota_minutes: number | null } | undefined;
  if (!lt) backTo(fd, '/requests', '假別不存在', true);

  // 時數計算：全日假以每日 8 小時計；部分工時假以起訖時間計
  let minutes: number;
  if (startTime && endTime && startDate === endDate) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    minutes = (eh * 60 + em) - (sh * 60 + sm);
    if (minutes <= 0) backTo(fd, '/requests', '請假時間不正確', true);
  } else {
    let days = 0;
    for (let d0 = startDate; d0 <= endDate; d0 = addDays(d0, 1)) days++;
    minutes = days * 480;
  }

  // 額度檢查
  if (lt!.code === 'annual') {
    const bal = ensureAnnualLeaveBalance(u.id, u.hire_date, today());
    if (!bal) backTo(fd, '/requests', '年資未滿 6 個月，尚無特休可用', true);
    if (bal.granted_minutes - bal.used_minutes < minutes) backTo(fd, '/requests', '特休餘額不足', true);
  } else if (lt!.code === 'comp') {
    if (compTimeBalance(u.id, today()) < minutes) backTo(fd, '/requests', '補休餘額不足', true);
  } else if (lt!.annual_quota_minutes != null) {
    const year = startDate.slice(0, 4);
    const used = (db().prepare(
      `SELECT COALESCE(SUM(minutes),0) AS m FROM leave_requests
       WHERE user_id = ? AND leave_type_id = ? AND status IN ('pending','approved')
       AND start_date LIKE ?`
    ).get(u.id, lt!.id, `${year}-%`) as { m: number }).m;
    if (used + minutes > lt!.annual_quota_minutes) {
      backTo(fd, '/requests', `${lt!.name}年度額度不足（已用 ${(used / 480).toFixed(1)} 日 / ${(lt!.annual_quota_minutes / 480)} 日）`, true);
    }
  }

  db().prepare(
    `INSERT INTO leave_requests (user_id, store_id, leave_type_id, start_date, end_date, start_time, end_time, minutes, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u.id, storeId, leaveTypeId, startDate, endDate, startTime, endTime, minutes, reason);
  revalidatePath('/requests');
  backTo(fd, '/requests', '請假申請已送出，等待主管審核');
}

interface LeaveReqRow {
  id: number; user_id: number; store_id: number; leave_type_id: number;
  minutes: number; start_date: string; end_date: string;
}

/** 核准請假的共用後續處理：扣特休/補休額度、移除請假期間排班 */
function applyLeaveApproval(req: LeaveReqRow, mgr: UserRow, note: string) {
  const d = db();
  d.prepare(
    `UPDATE leave_requests SET status = 'approved', approver_id = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`
  ).run(mgr.id, note, req.id);
  const lt = d.prepare(`SELECT code FROM leave_types WHERE id = ?`).get(req.leave_type_id) as { code: string };
  const emp = d.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user_id) as UserRow;
  if (lt.code === 'annual') {
    ensureAnnualLeaveBalance(emp.id, emp.hire_date, today());
    d.prepare(
      `UPDATE leave_balances SET used_minutes = used_minutes + ?
       WHERE user_id = ? AND leave_type_id = ? AND period_start <= ? AND period_end >= ?`
    ).run(req.minutes, emp.id, req.leave_type_id, req.start_date, req.start_date);
  } else if (lt.code === 'comp') {
    // 依到期日先進先出扣抵補休
    let rest = req.minutes;
    const lots = d.prepare(
      `SELECT id, minutes, used_minutes FROM comp_time
       WHERE user_id = ? AND expires_at >= ? AND minutes > used_minutes ORDER BY expires_at`
    ).all(emp.id, today()) as { id: number; minutes: number; used_minutes: number }[];
    for (const lot of lots) {
      if (rest <= 0) break;
      const take = Math.min(rest, lot.minutes - lot.used_minutes);
      d.prepare(`UPDATE comp_time SET used_minutes = used_minutes + ? WHERE id = ?`).run(take, lot.id);
      rest -= take;
    }
  }
  // 核准之全日假自動移除當日排班
  for (let d0 = req.start_date; d0 <= req.end_date; d0 = addDays(d0, 1)) {
    d.prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(req.user_id, d0);
  }
}

export async function decideLeaveAction(fd: FormData) {
  const mgr = await requireManager();
  const id = n(fd, 'id');
  const decision = s(fd, 'decision'); // approved / rejected
  const note = s(fd, 'note');
  const req = db().prepare(`SELECT * FROM leave_requests WHERE id = ? AND status = 'pending'`).get(id) as LeaveReqRow | undefined;
  if (!req) backTo(fd, '/approvals', '申請單不存在或已處理', true);
  if (!canManageStore(mgr, req!.store_id)) backTo(fd, '/approvals', '無此門市管理權限', true);

  if (decision === 'approved') {
    applyLeaveApproval(req!, mgr, note);
  } else {
    db().prepare(
      `UPDATE leave_requests SET status = 'rejected', approver_id = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`
    ).run(mgr.id, note, id);
  }
  revalidatePath('/approvals');
  backTo(fd, '/approvals', decision === 'approved' ? '已核准' : '已駁回');
}

/** 一鍵代班：核准請假＋改代班者當日班別（先檢核）＋逾 8 小時自動產生加班單 */
export async function approveLeaveWithCoverAction(fd: FormData) {
  const mgr = await requireManager();
  const id = n(fd, 'id');
  const coverUserId = n(fd, 'cover_user_id');
  const coverShiftTypeId = n(fd, 'cover_shift_type_id');
  const coverDate = s(fd, 'cover_date');
  const compensation = s(fd, 'ot_compensation') === 'comp' ? 'comp' : 'pay';

  const d = db();
  const req = d.prepare(`SELECT * FROM leave_requests WHERE id = ? AND status = 'pending'`).get(id) as LeaveReqRow | undefined;
  if (!req) backTo(fd, '/approvals', '申請單不存在或已處理', true);
  if (!canManageStore(mgr, req!.store_id)) backTo(fd, '/approvals', '無此門市管理權限', true);
  if (coverUserId === req!.user_id) backTo(fd, '/approvals', '代班人不能是請假者本人', true);
  if (coverDate < req!.start_date || coverDate > req!.end_date) backTo(fd, '/approvals', '代班日期不在請假期間內', true);
  const st = d.prepare(`SELECT * FROM shift_types WHERE id = ? AND store_id = ?`).get(coverShiftTypeId, req!.store_id) as
    { id: number; start_time: string; end_time: string; break_minutes: number; name: string } | undefined;
  if (!st) backTo(fd, '/approvals', '班別不屬於該門市', true);
  const coverUser = d.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`).get(coverUserId) as UserRow | undefined;
  if (!coverUser) backTo(fd, '/approvals', '代班人不存在', true);

  // 快照代班者當日原狀，先排入再檢核，違規則還原
  const prevShift = d.prepare(`SELECT * FROM shifts WHERE user_id = ? AND date = ?`).get(coverUserId, coverDate) as
    { store_id: number; shift_type_id: number } | undefined;
  const prevRest = d.prepare(`SELECT kind FROM rest_days WHERE user_id = ? AND date = ?`).get(coverUserId, coverDate) as
    { kind: string } | undefined;

  d.prepare(`DELETE FROM rest_days WHERE user_id = ? AND date = ?`).run(coverUserId, coverDate);
  d.prepare(
    `INSERT INTO shifts (store_id, user_id, date, shift_type_id, created_by, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET store_id = excluded.store_id,
       shift_type_id = excluded.shift_type_id, created_by = excluded.created_by, note = excluded.note`
  ).run(req!.store_id, coverUserId, coverDate, coverShiftTypeId, mgr.id, `代班（請假單 #${req!.id}）`);

  const store = getStore(req!.store_id);
  const viol = validateUserSchedule(coverUser!, store, coverDate, coverDate);
  const errors = viol.filter(v => v.level === 'error');
  if (errors.length) {
    // 還原代班者原狀，請假單維持 pending
    d.prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(coverUserId, coverDate);
    if (prevShift) {
      d.prepare(`INSERT INTO shifts (store_id, user_id, date, shift_type_id) VALUES (?, ?, ?, ?)`)
        .run(prevShift.store_id, coverUserId, coverDate, prevShift.shift_type_id);
    }
    if (prevRest) {
      d.prepare(`INSERT INTO rest_days (store_id, user_id, date, kind) VALUES (?, ?, ?, ?)`)
        .run(req!.store_id, coverUserId, coverDate, prevRest.kind);
    }
    backTo(fd, '/approvals', `代班安排違反法規，已取消：${errors[0].message}`, true);
  }

  // 核准請假（扣額度、移除請假者排班）
  applyLeaveApproval(req!, mgr, `核准並由 ${coverUser!.name} 代班`);

  // 逾 8 小時自動產生加班單（尾段時間），待審核
  const { shiftSpan: span2, fmtHM } = await import('@/lib/laborlaw');
  const span = span2(st!.start_time, st!.end_time);
  const work = span.endMin - span.startMin - st!.break_minutes;
  const otMin = work - 480;
  let otMsg = '';
  if (otMin > 0) {
    const otStart = span.endMin - otMin;
    d.prepare(
      `INSERT INTO overtime_requests (user_id, store_id, date, start_time, end_time, minutes, day_kind, compensation, reason)
       VALUES (?, ?, ?, ?, ?, ?, 'workday', ?, ?)`
    ).run(coverUserId, req!.store_id, coverDate, fmtHM(otStart), fmtHM(span.endMin), otMin, compensation,
      `臨時代班自動產生（請假單 #${req!.id}）`);
    otMsg = `，並自動建立 ${(otMin / 60).toFixed(1)} 小時加班單（待審核，請於下方加班區核准）`;
  }
  const warn = viol.find(v => v.level === 'warning');
  revalidatePath('/approvals');
  revalidatePath('/schedule');
  backTo(fd, '/approvals',
    `已核准請假，${coverDate} 由 ${coverUser!.name} 代班「${st!.name}」${otMsg}${warn ? `。注意：${warn.message}` : ''}`);
}

// ---------- 加班 ----------
export async function createOvertimeAction(fd: FormData) {
  const u = await requireUser();
  const storeId = n(fd, 'store_id');
  const date = s(fd, 'date'), startTime = s(fd, 'start_time'), endTime = s(fd, 'end_time');
  const dayKind = s(fd, 'day_kind') || 'workday';
  const compensation = s(fd, 'compensation') === 'comp' ? 'comp' : 'pay';
  const reason = s(fd, 'reason');
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let minutes = (eh * 60 + em) - (sh * 60 + sm);
  if (minutes <= 0) minutes += 1440; // 跨日
  if (minutes <= 0 || minutes > 720) backTo(fd, '/requests', '加班時間不正確', true);

  // 每月加班上限即時檢查（含此筆）
  const store = getStore(storeId);
  const mo = date.slice(0, 7);
  const used = (db().prepare(
    `SELECT COALESCE(SUM(minutes),0) AS m FROM overtime_requests
     WHERE user_id = ? AND status IN ('pending','approved') AND date LIKE ?`
  ).get(u.id, `${mo}-%`) as { m: number }).m;
  if (used + minutes > store.ot_monthly_cap_minutes) {
    backTo(fd, '/requests', `本月加班（含審核中）將達 ${((used + minutes) / 60).toFixed(1)} 小時，超過上限 ${(store.ot_monthly_cap_minutes / 60)} 小時（勞基法 §32）`, true);
  }

  db().prepare(
    `INSERT INTO overtime_requests (user_id, store_id, date, start_time, end_time, minutes, day_kind, compensation, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u.id, storeId, date, startTime, endTime, minutes, dayKind, compensation, reason);
  revalidatePath('/requests');
  backTo(fd, '/requests', '加班申請已送出');
}

export async function decideOvertimeAction(fd: FormData) {
  const mgr = await requireManager();
  const id = n(fd, 'id');
  const decision = s(fd, 'decision');
  const note = s(fd, 'note');
  const req = db().prepare(`SELECT * FROM overtime_requests WHERE id = ? AND status = 'pending'`).get(id) as
    { id: number; user_id: number; store_id: number; date: string; minutes: number; compensation: string } | undefined;
  if (!req) backTo(fd, '/approvals', '申請單不存在或已處理', true);
  if (!canManageStore(mgr, req.store_id)) backTo(fd, '/approvals', '無此門市管理權限', true);

  db().prepare(
    `UPDATE overtime_requests SET status = ?, approver_id = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`
  ).run(decision === 'approved' ? 'approved' : 'rejected', mgr.id, note, id);

  if (decision === 'approved' && req.compensation === 'comp') {
    // §32-1：1:1 換補休；期限預設當年度 12/31（逾期由結算折發工資）
    const expires = `${req.date.slice(0, 4)}-12-31`;
    db().prepare(
      `INSERT INTO comp_time (user_id, source_ot_id, minutes, earned_date, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(req.user_id, req.id, req.minutes, req.date, expires);
  }
  revalidatePath('/approvals');
  backTo(fd, '/approvals', decision === 'approved' ? '已核准' : '已駁回');
}

// ---------- 換班 ----------
export async function createSwapAction(fd: FormData) {
  const u = await requireUser();
  const fromShiftId = n(fd, 'from_shift_id');
  const toUserId = n(fd, 'to_user_id');
  const toShiftId = n(fd, 'to_shift_id') || null;
  const note = s(fd, 'note');
  const fromShift = db().prepare(`SELECT * FROM shifts WHERE id = ? AND user_id = ?`).get(fromShiftId, u.id) as
    { id: number; store_id: number; date: string } | undefined;
  if (!fromShift) backTo(fd, '/requests', '找不到你的班（僅能用自己的班發起換班）', true);
  if (toUserId === u.id) backTo(fd, '/requests', '不能與自己換班', true);
  if (toShiftId) {
    const toShift = db().prepare(`SELECT * FROM shifts WHERE id = ? AND user_id = ?`).get(toShiftId, toUserId);
    if (!toShift) backTo(fd, '/requests', '對方班次不正確', true);
  }
  db().prepare(
    `INSERT INTO swap_requests (store_id, from_user_id, to_user_id, from_shift_id, to_shift_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fromShift.store_id, u.id, toUserId, fromShiftId, toShiftId, note);
  revalidatePath('/requests');
  backTo(fd, '/requests', '換班申請已送出，等待對方同意');
}

export async function peerDecideSwapAction(fd: FormData) {
  const u = await requireUser();
  const id = n(fd, 'id');
  const decision = s(fd, 'decision');
  const req = db().prepare(
    `SELECT * FROM swap_requests WHERE id = ? AND to_user_id = ? AND status = 'pending_peer'`
  ).get(id, u.id);
  if (!req) backTo(fd, '/requests', '申請不存在或已處理', true);
  db().prepare(
    `UPDATE swap_requests SET status = ?, peer_decided_at = datetime('now') WHERE id = ?`
  ).run(decision === 'accept' ? 'pending_manager' : 'rejected_peer', id);
  revalidatePath('/requests');
  backTo(fd, '/requests', decision === 'accept' ? '已同意，送店長核准' : '已婉拒');
}

export async function managerDecideSwapAction(fd: FormData) {
  const mgr = await requireManager();
  const id = n(fd, 'id');
  const decision = s(fd, 'decision');
  const req = db().prepare(`SELECT * FROM swap_requests WHERE id = ? AND status = 'pending_manager'`).get(id) as
    { id: number; store_id: number; from_user_id: number; to_user_id: number; from_shift_id: number; to_shift_id: number | null } | undefined;
  if (!req) backTo(fd, '/approvals', '申請不存在或已處理', true);
  if (!canManageStore(mgr, req.store_id)) backTo(fd, '/approvals', '無此門市管理權限', true);

  if (decision !== 'approved') {
    db().prepare(`UPDATE swap_requests SET status = 'rejected_manager', manager_id = ?, manager_decided_at = datetime('now') WHERE id = ?`).run(mgr.id, id);
    backTo(fd, '/approvals', '已駁回換班');
  }

  const d = db();
  const fromShift = d.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.from_shift_id) as
    { id: number; user_id: number; date: string; store_id: number; shift_type_id: number } | undefined;
  if (!fromShift) backTo(fd, '/approvals', '原班次已不存在，無法換班', true);
  const toShift = req.to_shift_id
    ? d.prepare(`SELECT * FROM shifts WHERE id = ?`).get(req.to_shift_id) as
      { id: number; user_id: number; date: string; store_id: number; shift_type_id: number } | undefined
    : null;
  if (req.to_shift_id && !toShift) backTo(fd, '/approvals', '對方班次已不存在，無法換班', true);

  const tx = d.transaction(() => {
    if (toShift) {
      // 互換：交換兩班的 user_id（先移除避免 UNIQUE 衝突）
      d.prepare(`DELETE FROM shifts WHERE id IN (?, ?)`).run(fromShift.id, toShift.id);
      d.prepare(`INSERT INTO shifts (store_id, user_id, date, shift_type_id, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(fromShift.store_id, req.to_user_id, fromShift.date, fromShift.shift_type_id, mgr.id);
      d.prepare(`INSERT INTO shifts (store_id, user_id, date, shift_type_id, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(toShift.store_id, req.from_user_id, toShift.date, toShift.shift_type_id, mgr.id);
    } else {
      // 單向轉讓
      d.prepare(`DELETE FROM shifts WHERE id = ?`).run(fromShift.id);
      d.prepare(`DELETE FROM shifts WHERE user_id = ? AND date = ?`).run(req.to_user_id, fromShift.date);
      d.prepare(`INSERT INTO shifts (store_id, user_id, date, shift_type_id, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run(fromShift.store_id, req.to_user_id, fromShift.date, fromShift.shift_type_id, mgr.id);
    }
    d.prepare(`UPDATE swap_requests SET status = 'approved', manager_id = ?, manager_decided_at = datetime('now') WHERE id = ?`).run(mgr.id, id);
  });

  // 先執行換班，再檢核雙方是否違規；有 error 則回滾
  const store = getStore(req.store_id);
  try {
    tx();
    const fromUser = d.prepare(`SELECT * FROM users WHERE id = ?`).get(req.from_user_id) as UserRow;
    const toUser = d.prepare(`SELECT * FROM users WHERE id = ?`).get(req.to_user_id) as UserRow;
    const dates = [fromShift.date, toShift?.date].filter(Boolean) as string[];
    const dMin = dates.reduce((a, b) => (a < b ? a : b)), dMax = dates.reduce((a, b) => (a > b ? a : b));
    const errs = [
      ...validateUserSchedule(fromUser, store, dMin, dMax),
      ...validateUserSchedule(toUser, store, dMin, dMax),
    ].filter(v => v.level === 'error');
    if (errs.length) {
      throw new Error(errs[0].message);
    }
  } catch (e) {
    // 回滾：還原原班表
    const restore = d.transaction(() => {
      d.prepare(`DELETE FROM shifts WHERE user_id IN (?, ?) AND date IN (?, ?)`)
        .run(req.from_user_id, req.to_user_id, fromShift.date, toShift?.date ?? fromShift.date);
      d.prepare(`INSERT OR REPLACE INTO shifts (store_id, user_id, date, shift_type_id) VALUES (?, ?, ?, ?)`)
        .run(fromShift.store_id, fromShift.user_id, fromShift.date, fromShift.shift_type_id);
      if (toShift) {
        d.prepare(`INSERT OR REPLACE INTO shifts (store_id, user_id, date, shift_type_id) VALUES (?, ?, ?, ?)`)
          .run(toShift.store_id, toShift.user_id, toShift.date, toShift.shift_type_id);
      }
      d.prepare(`UPDATE swap_requests SET status = 'pending_manager', manager_id = NULL, manager_decided_at = NULL WHERE id = ?`).run(id);
    });
    restore();
    backTo(fd, '/approvals', `換班將造成違規，已取消：${(e as Error).message}`, true);
  }
  revalidatePath('/approvals');
  revalidatePath('/schedule');
  backTo(fd, '/approvals', '換班已核准並更新班表');
}

// ---------- 劃休 ----------
export async function submitAvailabilityAction(fd: FormData) {
  const u = await requireUser();
  const storeId = n(fd, 'store_id');
  const month = s(fd, 'month'); // YYYY-MM
  const dates = (fd.getAll('dates') as string[]).filter(x => x.startsWith(month));
  const win = db().prepare(
    `SELECT * FROM availability_windows WHERE store_id = ? AND target_month = ?`
  ).get(storeId, month) as { open_from: string; open_until: string; max_off_days: number } | undefined;
  const t = today();
  if (!win) backTo(fd, '/availability', '該月份尚未開放劃休', true);
  if (t < win.open_from || t > win.open_until) backTo(fd, '/availability', `劃休開放期間為 ${win.open_from} ～ ${win.open_until}`, true);
  if (dates.length > win.max_off_days) backTo(fd, '/availability', `最多可劃 ${win.max_off_days} 天`, true);

  const d = db();
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM availability WHERE user_id = ? AND date LIKE ?`).run(u.id, `${month}-%`);
    const ins = d.prepare(
      `INSERT INTO availability (user_id, store_id, date, preference) VALUES (?, ?, ?, 'off')`
    );
    for (const date of dates) ins.run(u.id, storeId, date);
  });
  tx();
  revalidatePath('/availability');
  backTo(fd, '/availability', `已送出 ${dates.length} 天劃休`);
}

export async function setAvailabilityWindowAction(fd: FormData) {
  const mgr = await requireManager();
  const storeId = n(fd, 'store_id');
  if (!canManageStore(mgr, storeId)) backTo(fd, '/availability', '無此門市管理權限', true);
  db().prepare(
    `INSERT INTO availability_windows (store_id, target_month, open_from, open_until, max_off_days)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (store_id, target_month) DO UPDATE SET
       open_from = excluded.open_from, open_until = excluded.open_until, max_off_days = excluded.max_off_days`
  ).run(storeId, s(fd, 'target_month'), s(fd, 'open_from'), s(fd, 'open_until'), n(fd, 'max_off_days') || 8);
  revalidatePath('/availability');
  backTo(fd, '/availability', '劃休設定已儲存');
}

// ---------- 管理（admin）----------
export async function upsertUserAction(fd: FormData) {
  const admin = await requireAdmin();
  const id = n(fd, 'id');
  const employeeNo = s(fd, 'employee_no'), name = s(fd, 'name'), email = s(fd, 'email') || null;
  const role = s(fd, 'role'), hireDate = s(fd, 'hire_date');
  const password = s(fd, 'password');
  const storeIds = (fd.getAll('store_ids') as string[]).map(Number);
  const isPregnant = fd.get('is_pregnant') ? 1 : 0;
  const isMinor = fd.get('is_minor') ? 1 : 0;
  const active = fd.get('active') ? 1 : 0;
  if (!employeeNo || !name || !hireDate) backTo(fd, '/admin/users', '欄位不完整', true);

  const d = db();
  let userId = id;
  if (id) {
    d.prepare(
      `UPDATE users SET employee_no = ?, name = ?, email = ?, role = ?, hire_date = ?, is_pregnant = ?, is_minor = ?, active = ? WHERE id = ?`
    ).run(employeeNo, name, email, role, hireDate, isPregnant, isMinor, active, id);
    if (password) d.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), id);
  } else {
    if (!password) backTo(fd, '/admin/users', '新使用者需設定密碼', true);
    userId = d.prepare(
      `INSERT INTO users (employee_no, name, email, password_hash, role, hire_date, is_pregnant, is_minor, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(employeeNo, name, email, hashPassword(password), role, hireDate, isPregnant, isMinor).lastInsertRowid as number;
  }
  d.prepare(`DELETE FROM user_stores WHERE user_id = ?`).run(userId);
  const ins = d.prepare(`INSERT INTO user_stores (user_id, store_id, is_primary) VALUES (?, ?, ?)`);
  storeIds.forEach((sid, i) => ins.run(userId, sid, i === 0 ? 1 : 0));
  void admin;
  revalidatePath('/admin/users');
  backTo(fd, '/admin/users', '已儲存');
}

export async function upsertStoreAction(fd: FormData) {
  await requireAdmin();
  const id = n(fd, 'id');
  const name = s(fd, 'name');
  const storeType = s(fd, 'store_type');
  const mode = s(fd, 'schedule_mode');
  const anchor = s(fd, 'eightweek_anchor') || null;
  const otCapH = n(fd, 'ot_monthly_cap_hours') || 46;
  const openT = s(fd, 'open_time') || '11:00', closeT = s(fd, 'close_time') || '22:00';
  const maxConsec = n(fd, 'max_consecutive_days') || 6;
  const forbidClopening = fd.get('forbid_clopening') ? 1 : 0;
  if (!name) backTo(fd, '/admin/stores', '請輸入門市名稱', true);
  if (mode === 'eightweek' && !anchor) backTo(fd, '/admin/stores', '八週變形需設定週期起算日（建議週一）', true);
  if (otCapH !== 46 && otCapH !== 54) backTo(fd, '/admin/stores', '每月加班上限僅能為 46 或 54 小時', true);

  if (id) {
    db().prepare(
      `UPDATE stores SET name=?, store_type=?, schedule_mode=?, eightweek_anchor=?, ot_monthly_cap_minutes=?,
       open_time=?, close_time=?, max_consecutive_days=?, forbid_clopening=? WHERE id=?`
    ).run(name, storeType, mode, anchor, otCapH * 60, openT, closeT, maxConsec, forbidClopening, id);
  } else {
    db().prepare(
      `INSERT INTO stores (name, store_type, schedule_mode, eightweek_anchor, ot_monthly_cap_minutes, open_time, close_time, max_consecutive_days, forbid_clopening)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, storeType, mode, anchor, otCapH * 60, openT, closeT, maxConsec, forbidClopening);
  }
  revalidatePath('/admin/stores');
  backTo(fd, '/admin/stores', '已儲存');
}

export async function upsertShiftTypeAction(fd: FormData) {
  const mgr = await requireManager();
  const id = n(fd, 'id');
  const storeId = n(fd, 'store_id');
  if (!canManageStore(mgr, storeId)) backTo(fd, '/admin/shifts', '無此門市管理權限', true);
  const name = s(fd, 'name'), code = s(fd, 'code') || name.slice(0, 1);
  const startT = s(fd, 'start_time'), endT = s(fd, 'end_time');
  const breakMin = n(fd, 'break_minutes');
  const color = s(fd, 'color') || '#4f6ef7';
  const active = fd.get('active') === null && id ? 0 : 1;
  if (!name || !startT || !endT) backTo(fd, '/admin/shifts', '欄位不完整', true);

  // 工時試算警告：班別扣休息 > 12 小時直接拒絕
  const { shiftSpan } = await import('@/lib/laborlaw');
  const span = shiftSpan(startT, endT);
  const work = span.endMin - span.startMin - breakMin;
  if (work > 720) backTo(fd, '/admin/shifts', `此班別實際工時 ${(work / 60).toFixed(1)} 小時，超過每日 12 小時上限，不可建立`, true);

  if (id) {
    db().prepare(
      `UPDATE shift_types SET name=?, code=?, start_time=?, end_time=?, break_minutes=?, color=?, active=? WHERE id=? AND store_id=?`
    ).run(name, code, startT, endT, breakMin, color, active, id, storeId);
  } else {
    db().prepare(
      `INSERT INTO shift_types (store_id, name, code, start_time, end_time, break_minutes, color) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(storeId, name, code, startT, endT, breakMin, color);
  }
  revalidatePath('/admin/shifts');
  backTo(fd, '/admin/shifts', work > 480
    ? `已儲存。注意：此班別實際工時 ${(work / 60).toFixed(1)} 小時，超過 8 小時部分屬延長工時`
    : '已儲存');
}

export async function upsertStaffingAction(fd: FormData) {
  const mgr = await requireManager();
  const storeId = n(fd, 'store_id');
  if (!canManageStore(mgr, storeId)) backTo(fd, '/admin/staffing', '無此門市管理權限', true);
  const d = db();
  const shiftTypes = d.prepare(`SELECT id FROM shift_types WHERE store_id = ? AND active = 1`).all(storeId) as { id: number }[];
  const tx = d.transaction(() => {
    for (const st of shiftTypes) {
      for (let wd = 0; wd < 7; wd++) {
        const v = Number(fd.get(`req_${st.id}_${wd}`) ?? 0);
        d.prepare(
          `INSERT INTO staffing_requirements (store_id, weekday, shift_type_id, min_staff) VALUES (?, ?, ?, ?)
           ON CONFLICT (store_id, weekday, shift_type_id) DO UPDATE SET min_staff = excluded.min_staff`
        ).run(storeId, wd, st.id, v);
      }
    }
  });
  tx();
  revalidatePath('/admin/staffing');
  backTo(fd, '/admin/staffing', '人力需求已儲存');
}

export async function upsertHolidayAction(fd: FormData) {
  await requireManager();
  const date = s(fd, 'date'), name = s(fd, 'name');
  const holidayType = s(fd, 'holiday_type') || 'national';
  const storeId = n(fd, 'store_id') || null;
  if (!date || !name) backTo(fd, '/admin/holidays', '欄位不完整', true);
  db().prepare(
    `INSERT OR IGNORE INTO holidays (date, name, holiday_type, store_id) VALUES (?, ?, ?, ?)`
  ).run(date, name, holidayType, storeId);
  revalidatePath('/admin/holidays');
  backTo(fd, '/admin/holidays', '已新增');
}

export async function deleteHolidayAction(fd: FormData) {
  await requireManager();
  db().prepare(`DELETE FROM holidays WHERE id = ?`).run(n(fd, 'id'));
  revalidatePath('/admin/holidays');
  backTo(fd, '/admin/holidays', '已刪除');
}

export async function cancelRequestAction(fd: FormData) {
  const u = await requireUser();
  const kind = s(fd, 'kind'); // leave / ot / swap
  const id = n(fd, 'id');
  if (kind === 'leave') {
    db().prepare(`UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`).run(id, u.id);
  } else if (kind === 'ot') {
    db().prepare(`UPDATE overtime_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`).run(id, u.id);
  } else if (kind === 'swap') {
    db().prepare(`UPDATE swap_requests SET status = 'cancelled' WHERE id = ? AND from_user_id = ? AND status IN ('pending_peer','pending_manager')`).run(id, u.id);
  }
  revalidatePath('/requests');
  backTo(fd, '/requests', '已取消');
}
void isManager;
