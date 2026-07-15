import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'app.db');

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  // 首次啟動自動建立初始資料（正式環境可設 SEED_DEMO=0 僅建 admin 帳號）
  // 使用 require 避免與 leave.ts 的循環 import 在模組載入期互咬
  const { seedSystemLeaveTypes, seedDemo, applySokerStoreConfig } = require('./seed-core') as typeof import('./seed-core');
  seedSystemLeaveTypes(_db);
  seedDemo(_db);
  applySokerStoreConfig(_db);
  return _db;
}

function addColumnIfMissing(d: Database.Database, table: string, columnDef: string) {
  const col = columnDef.split(' ')[0];
  const exists = (d.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info(?) WHERE name = ?`).get(table, col) as { c: number }).c;
  if (!exists) d.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

function migrate(d: Database.Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_no TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','area_manager','store_manager','employee')),
    hire_date TEXT NOT NULL,            -- YYYY-MM-DD，特休年資起算
    is_pregnant INTEGER NOT NULL DEFAULT 0,  -- 妊娠/哺乳期間：夜間工作限制
    is_minor INTEGER NOT NULL DEFAULT 0,     -- 未成年工：工時/夜間限制
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    store_type TEXT NOT NULL CHECK (store_type IN ('department','street')), -- 百貨/街邊
    schedule_mode TEXT NOT NULL DEFAULT 'standard' CHECK (schedule_mode IN ('standard','eightweek')),
    eightweek_anchor TEXT,               -- 八週變形週期起算日（週一），schedule_mode=eightweek 時必填
    ot_monthly_cap_minutes INTEGER NOT NULL DEFAULT 2760,  -- 46h=2760m；經勞資會議同意可設 54h=3240m
    open_time TEXT NOT NULL DEFAULT '11:00',
    close_time TEXT NOT NULL DEFAULT '22:00',
    max_consecutive_days INTEGER NOT NULL DEFAULT 6,       -- 內規：最多連上天數（法規上限另檢核）
    forbid_clopening INTEGER NOT NULL DEFAULT 0,           -- 內規：禁止晚班接早班（即使滿足11小時）
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_stores (
    user_id INTEGER NOT NULL REFERENCES users(id),
    store_id INTEGER NOT NULL REFERENCES stores(id),
    is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, store_id)
  );

  CREATE TABLE IF NOT EXISTS shift_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    name TEXT NOT NULL,
    code TEXT NOT NULL,                  -- 班表格子顯示用短代碼，如「早」「晚」
    start_time TEXT NOT NULL,            -- HH:MM
    end_time TEXT NOT NULL,              -- HH:MM（跨日班以小於 start 表示，如 22:00-06:00）
    break_minutes INTEGER NOT NULL DEFAULT 60,
    color TEXT NOT NULL DEFAULT '#4f6ef7',
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS staffing_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=週日
    shift_type_id INTEGER NOT NULL REFERENCES shift_types(id),
    min_staff INTEGER NOT NULL DEFAULT 1,
    UNIQUE (store_id, weekday, shift_type_id)
  );

  -- 排班（一人一日至多一班）
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,                  -- YYYY-MM-DD
    shift_type_id INTEGER NOT NULL REFERENCES shift_types(id),
    note TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, date)
  );

  -- 例假/休息日標記（排班表上需區分例假與休息日，供七休一/八週變形檢核）
  CREATE TABLE IF NOT EXISTS rest_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('regular','rest')),  -- regular=例假, rest=休息日
    UNIQUE (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    holiday_type TEXT NOT NULL DEFAULT 'national' CHECK (holiday_type IN ('national','store_closed')),
    store_id INTEGER REFERENCES stores(id),   -- NULL=全公司（國定假日）
    UNIQUE (date, store_id, holiday_type)
  );

  CREATE TABLE IF NOT EXISTS leave_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    annual_quota_minutes INTEGER,        -- NULL=無固定年額度（如特休依年資、補休依加班）
    pay_ratio REAL NOT NULL DEFAULT 0,   -- 1=全薪 0.5=半薪 0=無薪
    is_system INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100
  );

  CREATE TABLE IF NOT EXISTS leave_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    period_start TEXT NOT NULL,          -- 額度適用起日（特休=週年日）
    period_end TEXT NOT NULL,
    granted_minutes INTEGER NOT NULL,
    used_minutes INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, leave_type_id, period_start)
  );

  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    store_id INTEGER NOT NULL REFERENCES stores(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    start_time TEXT,                     -- NULL=全日
    end_time TEXT,
    minutes INTEGER NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    approver_id INTEGER REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS overtime_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    store_id INTEGER NOT NULL REFERENCES stores(id),
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    day_kind TEXT NOT NULL DEFAULT 'workday' CHECK (day_kind IN ('workday','restday','national_holiday')),
    compensation TEXT NOT NULL DEFAULT 'pay' CHECK (compensation IN ('pay','comp')),  -- 加班費 / 換補休
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    approver_id INTEGER REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 補休（依 §32-1：1:1 換補休，設補休期限，逾期須折發工資）
  CREATE TABLE IF NOT EXISTS comp_time (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    source_ot_id INTEGER REFERENCES overtime_requests(id),
    minutes INTEGER NOT NULL,
    used_minutes INTEGER NOT NULL DEFAULT 0,
    earned_date TEXT NOT NULL,
    expires_at TEXT NOT NULL,            -- 補休期限（預設年度終結）
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 換班申請：兩位員工互換某日班別（或單向轉讓），需對方同意＋店長核准
  CREATE TABLE IF NOT EXISTS swap_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    from_user_id INTEGER NOT NULL REFERENCES users(id),
    to_user_id INTEGER NOT NULL REFERENCES users(id),
    from_shift_id INTEGER NOT NULL REFERENCES shifts(id),
    to_shift_id INTEGER REFERENCES shifts(id),   -- NULL=單向轉讓（對方原為休假日）
    status TEXT NOT NULL DEFAULT 'pending_peer'
      CHECK (status IN ('pending_peer','pending_manager','approved','rejected_peer','rejected_manager','cancelled')),
    peer_decided_at TEXT,
    manager_id INTEGER REFERENCES users(id),
    manager_decided_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 劃休：員工每月提交希望休假日
  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    store_id INTEGER NOT NULL REFERENCES stores(id),
    date TEXT NOT NULL,
    preference TEXT NOT NULL DEFAULT 'off' CHECK (preference IN ('off','prefer_off')),  -- off=必休 prefer_off=希望休
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, date)
  );

  -- 劃休開放期間設定（每門市）
  CREATE TABLE IF NOT EXISTS availability_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    target_month TEXT NOT NULL,          -- YYYY-MM
    open_from TEXT NOT NULL,
    open_until TEXT NOT NULL,
    max_off_days INTEGER NOT NULL DEFAULT 8,  -- 每人可劃「必休」上限
    UNIQUE (store_id, target_month)
  );

  CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_shifts_store_date ON shifts(store_id, date);
  CREATE INDEX IF NOT EXISTS idx_rest_user_date ON rest_days(user_id, date);
  `);
  // 既有資料庫的欄位擴充（新安裝亦適用）
  addColumnIfMissing(d, 'users', `employment_type TEXT NOT NULL DEFAULT 'fulltime'`); // fulltime=正職 parttime=工讀/部分工時
  addColumnIfMissing(d, 'users', `weekly_hours REAL NOT NULL DEFAULT 40`);            // 約定每週工時（特休比例計給用）
}

export type Role = 'admin' | 'area_manager' | 'store_manager' | 'employee';

export interface UserRow {
  id: number; employee_no: string; name: string; email: string | null;
  password_hash: string; role: Role; hire_date: string;
  is_pregnant: number; is_minor: number; active: number;
  employment_type: 'fulltime' | 'parttime'; weekly_hours: number;
}
export interface StoreRow {
  id: number; name: string; store_type: 'department' | 'street';
  schedule_mode: 'standard' | 'eightweek'; eightweek_anchor: string | null;
  ot_monthly_cap_minutes: number; open_time: string; close_time: string;
  max_consecutive_days: number; forbid_clopening: number; active: number;
}
export interface ShiftTypeRow {
  id: number; store_id: number; name: string; code: string;
  start_time: string; end_time: string; break_minutes: number; color: string; active: number;
}
export interface ShiftRow {
  id: number; store_id: number; user_id: number; date: string;
  shift_type_id: number; note: string | null;
}
