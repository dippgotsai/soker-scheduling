// 初始資料建立：系統假別（必要）與示範資料（可關閉）。
// 由 db.ts 於首次啟動時呼叫，正式環境設 SEED_DEMO=0 可停用示範資料（僅建立 admin 帳號）。
import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { SYSTEM_LEAVE_TYPES } from './leave';
import { mondayOf } from './laborlaw';

export function seedSystemLeaveTypes(d: Database.Database) {
  const ins = d.prepare(
    `INSERT OR IGNORE INTO leave_types (code, name, annual_quota_minutes, pay_ratio, is_system, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  for (const lt of SYSTEM_LEAVE_TYPES) {
    ins.run(lt.code, lt.name, lt.annual_quota_minutes, lt.pay_ratio, lt.sort_order);
  }
}

/** DB 無任何使用者時建立示範門市與帳號；回傳是否有建立 */
export function seedDemo(d: Database.Database): boolean {
  const c = (d.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
  if (c > 0) return false;
  const hash = (pw: string) => bcrypt.hashSync(pw, 10);

  if (process.env.SEED_DEMO === '0') {
    // 僅建立管理員帳號（密碼可用 ADMIN_PASSWORD 覆寫，請登入後立即變更）
    d.prepare(
      `INSERT INTO users (employee_no, name, email, password_hash, role, hire_date)
       VALUES ('A001', '系統管理員', NULL, ?, 'admin', ?)`
    ).run(hash(process.env.ADMIN_PASSWORD || 'admin1234'), new Date().toISOString().slice(0, 10));
    return true;
  }

  const today = new Date().toISOString().slice(0, 10);
  const anchor = mondayOf(today);

  const insStore = d.prepare(
    `INSERT INTO stores (name, store_type, schedule_mode, eightweek_anchor, open_time, close_time)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const dept = insStore.run('信義百貨櫃', 'department', 'eightweek', anchor, '11:00', '22:00').lastInsertRowid as number;
  const street = insStore.run('永康街門市', 'street', 'standard', null, '10:00', '21:00').lastInsertRowid as number;

  const insShiftType = d.prepare(
    `INSERT INTO shift_types (store_id, name, code, start_time, end_time, break_minutes, color)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const deptEarly = insShiftType.run(dept, '早班', '早', '10:30', '17:30', 60, '#3b82f6').lastInsertRowid as number;
  const deptLate = insShiftType.run(dept, '晚班', '晚', '15:00', '22:30', 60, '#8b5cf6').lastInsertRowid as number;
  insShiftType.run(dept, '全班', '全', '10:30', '22:30', 90, '#f59e0b');
  const stEarly = insShiftType.run(street, '早班', '早', '09:30', '17:30', 60, '#3b82f6').lastInsertRowid as number;
  const stLate = insShiftType.run(street, '晚班', '晚', '13:00', '21:30', 60, '#8b5cf6').lastInsertRowid as number;

  const insReq = d.prepare(
    `INSERT INTO staffing_requirements (store_id, weekday, shift_type_id, min_staff) VALUES (?, ?, ?, ?)`
  );
  for (let wd = 0; wd < 7; wd++) {
    const weekend = wd === 0 || wd === 6;
    insReq.run(dept, wd, deptEarly, weekend ? 2 : 1);
    insReq.run(dept, wd, deptLate, weekend ? 2 : 1);
    insReq.run(street, wd, stEarly, 1);
    insReq.run(street, wd, stLate, 1);
  }

  const insUser = d.prepare(
    `INSERT INTO users (employee_no, name, email, password_hash, role, hire_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insUS = d.prepare(`INSERT INTO user_stores (user_id, store_id, is_primary) VALUES (?, ?, ?)`);
  insUser.run('A001', '系統管理員', 'admin@example.com', hash('admin1234'), 'admin', '2020-01-01');
  const area = insUser.run('M001', '區域主管－王主管', 'area@example.com', hash('manager1234'), 'area_manager', '2020-06-01').lastInsertRowid as number;
  const mgr1 = insUser.run('S001', '店長－陳店長', 'mgr1@example.com', hash('manager1234'), 'store_manager', '2021-03-01').lastInsertRowid as number;
  const mgr2 = insUser.run('S002', '店長－林店長', 'mgr2@example.com', hash('manager1234'), 'store_manager', '2022-05-10').lastInsertRowid as number;
  const emp1 = insUser.run('E001', '張小美', 'emp1@example.com', hash('emp1234'), 'employee', '2023-04-15').lastInsertRowid as number;
  const emp2 = insUser.run('E002', '李大文', 'emp2@example.com', hash('emp1234'), 'employee', '2024-11-01').lastInsertRowid as number;
  const emp3 = insUser.run('E003', '周雅婷', 'emp3@example.com', hash('emp1234'), 'employee', '2025-09-20').lastInsertRowid as number;
  const emp4 = insUser.run('E004', '吳志明', 'emp4@example.com', hash('emp1234'), 'employee', '2024-02-01').lastInsertRowid as number;

  insUS.run(area, dept, 0); insUS.run(area, street, 0);
  insUS.run(mgr1, dept, 1); insUS.run(mgr2, street, 1);
  insUS.run(emp1, dept, 1); insUS.run(emp2, dept, 1);
  insUS.run(emp3, street, 1); insUS.run(emp4, street, 1);
  return true;
}
