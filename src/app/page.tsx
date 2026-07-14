import Link from 'next/link';
import { requireUser, isManager, userStoreIds } from '@/lib/auth';
import { db } from '@/lib/db';
import Nav from '@/components/Nav';
import { ensureAnnualLeaveBalance, compTimeBalance } from '@/lib/leave';
import { fmtHours } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await requireUser();
  const today = new Date().toISOString().slice(0, 10);
  const mgr = isManager(user);
  const d = db();

  // 今日班
  const todayShift = d.prepare(
    `SELECT s.date, st.name AS shift_name, st.start_time, st.end_time, so.name AS store_name
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN stores so ON so.id = s.store_id
     WHERE s.user_id = ? AND s.date = ?`
  ).get(user.id, today) as { shift_name: string; start_time: string; end_time: string; store_name: string } | undefined;

  // 未來 7 天班
  const upcoming = d.prepare(
    `SELECT s.date, st.code, st.start_time, st.end_time, so.name AS store_name
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN stores so ON so.id = s.store_id
     WHERE s.user_id = ? AND s.date > ? ORDER BY s.date LIMIT 7`
  ).all(user.id, today) as { date: string; code: string; start_time: string; end_time: string; store_name: string }[];

  const annual = ensureAnnualLeaveBalance(user.id, user.hire_date, today);
  const comp = compTimeBalance(user.id, today);

  let pendingCounts = { leave: 0, ot: 0, swap: 0 };
  if (mgr) {
    const sids = userStoreIds(user);
    if (sids.length) {
      const ph = sids.map(() => '?').join(',');
      pendingCounts = {
        leave: (d.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status='pending' AND store_id IN (${ph})`).get(...sids) as { c: number }).c,
        ot: (d.prepare(`SELECT COUNT(*) c FROM overtime_requests WHERE status='pending' AND store_id IN (${ph})`).get(...sids) as { c: number }).c,
        swap: (d.prepare(`SELECT COUNT(*) c FROM swap_requests WHERE status='pending_manager' AND store_id IN (${ph})`).get(...sids) as { c: number }).c,
      };
    }
  }
  const myPeerSwaps = (d.prepare(
    `SELECT COUNT(*) c FROM swap_requests WHERE to_user_id = ? AND status = 'pending_peer'`
  ).get(user.id) as { c: number }).c;

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>{user.name}，您好</h1>
        <div className="statgrid">
          <div className="stat">
            <div className="num">{todayShift ? `${todayShift.start_time}–${todayShift.end_time}` : '休'}</div>
            <div className="lbl">今日{todayShift ? `：${todayShift.store_name} ${todayShift.shift_name}` : '假'}</div>
          </div>
          <div className="stat">
            <div className="num">{annual ? fmtHours(annual.granted_minutes - annual.used_minutes) : 0} 小時</div>
            <div className="lbl">特休餘額{annual ? `（至 ${annual.period_end}）` : '（年資未滿 6 個月）'}</div>
          </div>
          <div className="stat">
            <div className="num">{fmtHours(comp)} 小時</div>
            <div className="lbl">補休餘額</div>
          </div>
          {mgr && (
            <div className="stat">
              <div className="num">{pendingCounts.leave + pendingCounts.ot + pendingCounts.swap}</div>
              <div className="lbl"><Link href="/approvals">待審核申請</Link></div>
            </div>
          )}
        </div>

        {myPeerSwaps > 0 && (
          <div className="alert warning">
            有 {myPeerSwaps} 筆換班申請等待您同意，<Link href="/requests">前往處理</Link>
          </div>
        )}

        <h2>未來班表</h2>
        <div className="card">
          {upcoming.length === 0 ? <p className="muted">尚未排班</p> : (
            <table className="tbl">
              <thead><tr><th>日期</th><th>門市</th><th>班別</th><th>時間</th></tr></thead>
              <tbody>
                {upcoming.map(u2 => (
                  <tr key={u2.date}>
                    <td>{u2.date}</td><td>{u2.store_name}</td><td>{u2.code}</td>
                    <td>{u2.start_time}–{u2.end_time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
