// 初始化資料：npm run seed
// 建立系統假別、示範門市/班別/人力需求，以及預設帳號（請於上線前變更密碼）。
import bcrypt from 'bcryptjs';
import { db } from '../src/lib/db';
import { SYSTEM_LEAVE_TYPES } from '../src/lib/leave';
import { mondayOf } from '../src/lib/laborlaw';

const d = db();

// 系統假別
const insLeave = d.prepare(
  `INSERT OR IGNORE INTO leave_types (code, name, annual_quota_minutes, pay_ratio, is_system, sort_order)
   VALUES (?, ?, ?, ?, 1, ?)`
);
for (const lt of SYSTEM_LEAVE_TYPES) {
  insLeave.run(lt.code, lt.name, lt.annual_quota_minutes, lt.pay_ratio, lt.sort_order);
}

const userCount = (d.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
if (userCount > 0) {
  console.log('已有使用者資料，僅同步系統假別，跳過示範資料。');
  process.exit(0);
}

const hash = (pw: string) => bcrypt.hashSync(pw, 10);
const today = new Date().toISOString().slice(0, 10);
const anchor = mondayOf(today);

// 門市
const insStore = d.prepare(
  `INSERT INTO stores (name, store_type, schedule_mode, eightweek_anchor, open_time, close_time)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const dept = insStore.run('信義百貨櫃', 'department', 'eightweek', anchor, '11:00', '22:00').lastInsertRowid as number;
const street = insStore.run('永康街門市', 'street', 'standard', null, '10:00', '21:00').lastInsertRowid as number;

// 班別
const insShiftType = d.prepare(
  `INSERT INTO shift_types (store_id, name, code, start_time, end_time, break_minutes, color)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const deptEarly = insShiftType.run(dept, '早班', '早', '10:30', '17:30', 60, '#3b82f6').lastInsertRowid as number;
const deptLate = insShiftType.run(dept, '晚班', '晚', '15:00', '22:30', 60, '#8b5cf6').lastInsertRowid as number;
insShiftType.run(dept, '全班', '全', '10:30', '22:30', 90, '#f59e0b');
const stEarly = insShiftType.run(street, '早班', '早', '09:30', '17:30', 60, '#3b82f6').lastInsertRowid as number;
const stLate = insShiftType.run(street, '晚班', '晚', '13:00', '21:30', 60, '#8b5cf6').lastInsertRowid as number;

// 人力需求（每週各日、各班別最少人數）
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

// 帳號
const insUser = d.prepare(
  `INSERT INTO users (employee_no, name, email, password_hash, role, hire_date)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const insUS = d.prepare(
  `INSERT INTO user_stores (user_id, store_id, is_primary) VALUES (?, ?, ?)`
);
const admin = insUser.run('A001', '系統管理員', 'admin@example.com', hash('admin1234'), 'admin', '2020-01-01').lastInsertRowid as number;
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
void admin;

console.log('示範資料建立完成。');
console.log('登入帳號（工號 / 密碼）：');
console.log('  A001 / admin1234   系統管理員');
console.log('  M001 / manager1234 區域主管');
console.log('  S001 / manager1234 百貨櫃店長');
console.log('  S002 / manager1234 街邊店店長');
console.log('  E001 / emp1234     員工（百貨櫃）');
console.log('  E003 / emp1234     員工（街邊店）');
