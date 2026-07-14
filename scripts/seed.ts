// 初始化資料：npm run seed
// db() 首次連線即自動建表並建立系統假別；若資料庫為空另建立示範資料。
import { db } from '../src/lib/db';

const d = db();
const users = (d.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;
console.log(`資料庫初始化完成（users: ${users}）。`);
if (users > 0) {
  console.log('登入帳號（工號 / 密碼，示範資料）：');
  console.log('  A001 / admin1234   系統管理員');
  console.log('  M001 / manager1234 區域主管');
  console.log('  S001 / manager1234 百貨櫃店長');
  console.log('  S002 / manager1234 街邊店店長');
  console.log('  E001 / emp1234     員工（百貨櫃）');
  console.log('  E003 / emp1234     員工（街邊店）');
}
