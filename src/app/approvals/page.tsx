import { requireManager, managedStoreIds } from '@/lib/auth';
import { db } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { decideLeaveAction, decideOvertimeAction, managerDecideSwapAction } from '@/app/actions';
import { fmtHours } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const user = await requireManager();
  const { msg, err } = await searchParams;
  const d = db();
  const sids = managedStoreIds(user);
  if (sids.length === 0) {
    return (<><Nav user={user} /><div className="container"><p>無管轄門市。</p></div></>);
  }
  const ph = sids.map(() => '?').join(',');

  const leaves = d.prepare(
    `SELECT lr.*, lt.name AS type_name, u.name AS user_name, s.name AS store_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN users u ON u.id = lr.user_id
     JOIN stores s ON s.id = lr.store_id
     WHERE lr.status = 'pending' AND lr.store_id IN (${ph}) ORDER BY lr.created_at`
  ).all(...sids) as { id: number; type_name: string; user_name: string; store_name: string; start_date: string; end_date: string; start_time: string | null; end_time: string | null; minutes: number; reason: string | null }[];

  const ots = d.prepare(
    `SELECT o.*, u.name AS user_name, s.name AS store_name FROM overtime_requests o
     JOIN users u ON u.id = o.user_id JOIN stores s ON s.id = o.store_id
     WHERE o.status = 'pending' AND o.store_id IN (${ph}) ORDER BY o.created_at`
  ).all(...sids) as { id: number; user_name: string; store_name: string; date: string; start_time: string; end_time: string; minutes: number; day_kind: string; compensation: string; reason: string | null }[];

  const swaps = d.prepare(
    `SELECT sr.*, uf.name AS from_name, ut.name AS to_name, fs.date AS from_date, s.name AS store_name
     FROM swap_requests sr
     JOIN users uf ON uf.id = sr.from_user_id JOIN users ut ON ut.id = sr.to_user_id
     JOIN shifts fs ON fs.id = sr.from_shift_id
     JOIN stores s ON s.id = sr.store_id
     WHERE sr.status = 'pending_manager' AND sr.store_id IN (${ph}) ORDER BY sr.created_at`
  ).all(...sids) as { id: number; from_name: string; to_name: string; from_date: string; store_name: string; note: string | null }[];

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>審核中心</h1>
        <Flash msg={msg} err={err} />

        <div className="card">
          <h2 style={{ marginTop: 0 }}>請假（{leaves.length}）</h2>
          {leaves.length === 0 ? <p className="muted">無待審核</p> : (
            <div className="tbl-scroll"><table className="tbl">
              <thead><tr><th>員工</th><th>門市</th><th>假別</th><th>期間</th><th>時數</th><th>事由</th><th>審核</th></tr></thead>
              <tbody>{leaves.map(l => (
                <tr key={l.id}>
                  <td>{l.user_name}</td><td>{l.store_name}</td><td>{l.type_name}</td>
                  <td>{l.start_date}{l.end_date !== l.start_date ? `～${l.end_date}` : ''}{l.start_time ? ` ${l.start_time}–${l.end_time}` : ''}</td>
                  <td>{fmtHours(l.minutes)} 小時</td><td>{l.reason ?? ''}</td>
                  <td><DecideForms action="leave" id={l.id} /></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>加班（{ots.length}）</h2>
          {ots.length === 0 ? <p className="muted">無待審核</p> : (
            <div className="tbl-scroll"><table className="tbl">
              <thead><tr><th>員工</th><th>門市</th><th>日期</th><th>時間</th><th>時數</th><th>性質</th><th>補償</th><th>事由</th><th>審核</th></tr></thead>
              <tbody>{ots.map(o => (
                <tr key={o.id}>
                  <td>{o.user_name}</td><td>{o.store_name}</td><td>{o.date}</td>
                  <td>{o.start_time}–{o.end_time}</td><td>{fmtHours(o.minutes)} 小時</td>
                  <td>{o.day_kind === 'workday' ? '平日' : o.day_kind === 'restday' ? '休息日' : '國定假日'}</td>
                  <td>{o.compensation === 'pay' ? '加班費' : '補休'}</td><td>{o.reason ?? ''}</td>
                  <td><DecideForms action="ot" id={o.id} /></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>換班（{swaps.length}）</h2>
          {swaps.length === 0 ? <p className="muted">無待審核</p> : (
            <div className="tbl-scroll"><table className="tbl">
              <thead><tr><th>發起人</th><th>對象</th><th>班次日期</th><th>門市</th><th>備註</th><th>審核</th></tr></thead>
              <tbody>{swaps.map(s2 => (
                <tr key={s2.id}>
                  <td>{s2.from_name}</td><td>{s2.to_name}</td><td>{s2.from_date}</td><td>{s2.store_name}</td><td>{s2.note ?? ''}</td>
                  <td><DecideForms action="swap" id={s2.id} /></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
          <p className="muted">核准換班時系統會自動重新檢核雙方勞基法限制（11 小時間隔、七休一、工時上限等），違規將自動退回。</p>
        </div>
      </div>
    </>
  );
}

function DecideForms({ action, id }: { action: 'leave' | 'ot' | 'swap'; id: number }) {
  const fn = action === 'leave' ? decideLeaveAction : action === 'ot' ? decideOvertimeAction : managerDecideSwapAction;
  return (
    <div className="row">
      <form action={fn}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="approved" />
        <button className="small">核准</button>
      </form>
      <form action={fn}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="decision" value="rejected" />
        <button className="small danger">駁回</button>
      </form>
    </div>
  );
}
