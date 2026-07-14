import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, type UserRow, type Role } from './db';

const COOKIE = 'session';
const SESSION_DAYS = 14;

export async function login(employeeNoOrEmail: string, password: string): Promise<UserRow | null> {
  const u = db().prepare(
    `SELECT * FROM users WHERE active = 1 AND (employee_no = ? OR email = ?)`
  ).get(employeeNoOrEmail, employeeNoOrEmail) as UserRow | undefined;
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db().prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, u.id, expires.toISOString());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', expires,
  });
  return u;
}

export async function logout() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) db().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  store.delete(COOKIE);
}

export async function currentUser(): Promise<UserRow | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const row = db().prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`
  ).get(token) as UserRow | undefined;
  return row ?? null;
}

export async function requireUser(): Promise<UserRow> {
  const u = await currentUser();
  if (!u) redirect('/login');
  return u;
}

export const MANAGER_ROLES: Role[] = ['admin', 'area_manager', 'store_manager'];

export function isManager(u: UserRow): boolean {
  return MANAGER_ROLES.includes(u.role);
}

export async function requireManager(): Promise<UserRow> {
  const u = await requireUser();
  if (!isManager(u)) redirect('/');
  return u;
}

export async function requireAdmin(): Promise<UserRow> {
  const u = await requireUser();
  if (u.role !== 'admin') redirect('/');
  return u;
}

/** 該使用者可管理的門市 id 清單（admin=全部；區主管/店長=所屬門市） */
export function managedStoreIds(u: UserRow): number[] {
  if (u.role === 'admin') {
    return (db().prepare(`SELECT id FROM stores WHERE active = 1`).all() as { id: number }[]).map(r => r.id);
  }
  return (db().prepare(`SELECT store_id AS id FROM user_stores WHERE user_id = ?`).all(u.id) as { id: number }[]).map(r => r.id);
}

export function userStoreIds(u: UserRow): number[] {
  return managedStoreIds(u);
}

export function canManageStore(u: UserRow, storeId: number): boolean {
  if (u.role === 'admin') return true;
  if (!isManager(u)) return false;
  return managedStoreIds(u).includes(storeId);
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}
