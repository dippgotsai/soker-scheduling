import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import Nav from '@/components/Nav';
import { ensureAnnualLeaveBalance, annualLeaveDays } from '@/lib/leave';
import { fmtHours } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

export default async function BalancesPage() {
  const user = await requireUser();
  const d = db();
  const today = new Date().toISOString().slice(0, 10);
  const annual = ensureAnnualLeaveBalance(user.id, user.hire_date, today);

  const compLots = d.prepare(
    `SELECT * FROM comp_time WHERE user_id = ? AND minutes > used_minutes ORDER BY expires_at`
  ).all(user.id) as { id: number; minutes: number; used_minutes: number; earned_date: string; expires_at: string }[];

  const leaveTypes = d.prepare(`SELECT * FROM leave_types ORDER BY sort_order`).all() as
    { id: number; code: string; name: string; annual_quota_minutes: number | null; pay_ratio: number }[];
  const year = today.slice(0, 4);
  const usedByType = new Map(
    (d.prepare(
      `SELECT leave_type_id, SUM(minutes) AS m FROM leave_requests
       WHERE user_id = ? AND status = 'approved' AND start_date LIKE ? GROUP BY leave_type_id`
    ).all(user.id, `${year}-%`) as { leave_type_id: number; m: number }[]).map(r => [r.leave_type_id, r.m])
  );

  const seniorityYears = (Date.now() - new Date(user.hire_date).getTime()) / (365.25 * 86400000);

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>假別餘額</h1>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>特休（勞基法 §38，週年制）</h2>
          <p>到職日：{user.hire_date}（年資約 {seniorityYears.toFixed(1)} 年）</p>
          {annual ? (
            <table className="tbl" style={{ maxWidth: 560 }}>
              <tbody>
                <tr><th>本期期間</th><td>至 {annual.period_end}</td></tr>
                <tr><th>本期額度</th><td>{fmtHours(annual.granted_minutes)} 小時（{annual.granted_minutes / 480} 日）</td></tr>
                <tr><th>已使用</th><td>{fmtHours(annual.used_minutes)} 小時</td></tr>
                <tr><th>剩餘</th><td><strong>{fmtHours(annual.granted_minutes - annual.used_minutes)} 小時</strong></td></tr>
              </tbody>
            </table>
          ) : <p className="muted">年資未滿 6 個月，尚無特休。滿 6 個月將自動核給 3 日。</p>}
          <p className="muted">年資對照：滿半年 3 日→1 年 7 日→2 年 10 日→3 年 14 日→5 年 15 日→10 年起每年 +1 日（上限 30 日）。目前年資下一級距為 {annualLeaveDays(Math.floor(seniorityYears) + 1)} 日。年度終結未休完之特休，雇主應折發工資。
            {user.employment_type === 'parttime' && `您為部分工時（約定每週 ${user.weekly_hours} 小時），特休依週工時 ÷40 之比例計給。`}</p>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>補休（勞基法 §32-1）</h2>
          {compLots.length === 0 ? <p className="muted">目前無可用補休。加班時選擇「換補休」並經核准後，會依 1:1 產生補休時數。</p> : (
            <table className="tbl" style={{ maxWidth: 640 }}>
              <thead><tr><th>加班日</th><th>剩餘時數</th><th>補休期限</th></tr></thead>
              <tbody>
                {compLots.map(c => (
                  <tr key={c.id}>
                    <td>{c.earned_date}</td>
                    <td>{fmtHours(c.minutes - c.used_minutes)} 小時</td>
                    <td>{c.expires_at}{c.expires_at < today ? <span className="badge err" style={{ marginLeft: 6 }}>已逾期，應折發工資</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>各假別本年度使用狀況（{year}）</h2>
          <table className="tbl" style={{ maxWidth: 720 }}>
            <thead><tr><th>假別</th><th>薪資</th><th>年度額度</th><th>已核准使用</th></tr></thead>
            <tbody>
              {leaveTypes.map(lt => (
                <tr key={lt.id}>
                  <td>{lt.name}</td>
                  <td>{lt.pay_ratio === 1 ? '全薪' : lt.pay_ratio === 0.5 ? '半薪' : '無薪'}</td>
                  <td>{lt.code === 'annual' ? '依年資' : lt.code === 'comp' ? '依加班' : lt.annual_quota_minutes ? `${lt.annual_quota_minutes / 480} 日` : '－'}</td>
                  <td>{fmtHours(usedByType.get(lt.id) ?? 0)} 小時</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">＊生理假每月 1 日、全年 3 日內不併入病假；家庭照顧假併入事假計算——細部合併規則請依公司人事規章，系統額度為上限提醒。</p>
        </div>
      </div>
    </>
  );
}
