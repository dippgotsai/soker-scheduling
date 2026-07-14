import { requireUser, userStoreIds } from '@/lib/auth';
import { db, type StoreRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import {
  createLeaveRequestAction, createOvertimeAction, createSwapAction,
  peerDecideSwapAction, cancelRequestAction,
} from '@/app/actions';
import { fmtHours, overtimePaySegments } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

const STATUS_NAME: Record<string, string> = {
  pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消',
  pending_peer: '待對方同意', pending_manager: '待店長核准',
  rejected_peer: '對方婉拒', rejected_manager: '店長駁回',
};

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const user = await requireUser();
  const { msg, err } = await searchParams;
  const d = db();
  const sids = userStoreIds(user);
  const stores = (sids.length
    ? d.prepare(`SELECT * FROM stores WHERE id IN (${sids.map(() => '?').join(',')})`).all(...sids)
    : []) as StoreRow[];
  const leaveTypes = d.prepare(`SELECT * FROM leave_types ORDER BY sort_order`).all() as
    { id: number; code: string; name: string; pay_ratio: number }[];

  const myLeaves = d.prepare(
    `SELECT lr.*, lt.name AS type_name FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.user_id = ? ORDER BY lr.created_at DESC LIMIT 20`
  ).all(user.id) as { id: number; type_name: string; start_date: string; end_date: string; start_time: string | null; end_time: string | null; minutes: number; status: string; decision_note: string | null }[];

  const myOts = d.prepare(
    `SELECT * FROM overtime_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
  ).all(user.id) as { id: number; date: string; start_time: string; end_time: string; minutes: number; day_kind: 'workday' | 'restday' | 'national_holiday'; compensation: string; status: string }[];

  const mySwaps = d.prepare(
    `SELECT sr.*, uf.name AS from_name, ut.name AS to_name, fs.date AS from_date
     FROM swap_requests sr
     JOIN users uf ON uf.id = sr.from_user_id JOIN users ut ON ut.id = sr.to_user_id
     JOIN shifts fs ON fs.id = sr.from_shift_id
     WHERE sr.from_user_id = ? OR sr.to_user_id = ? ORDER BY sr.created_at DESC LIMIT 20`
  ).all(user.id, user.id) as { id: number; from_user_id: number; to_user_id: number; from_name: string; to_name: string; from_date: string; status: string; note: string | null }[];

  // 供換班選擇：我的未來班、同店同事與其未來班
  const today = new Date().toISOString().slice(0, 10);
  const myShifts = d.prepare(
    `SELECT s.id, s.date, st.name FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.user_id = ? AND s.date >= ? ORDER BY s.date LIMIT 40`
  ).all(user.id, today) as { id: number; date: string; name: string }[];
  const colleagueShifts = sids.length ? d.prepare(
    `SELECT s.id, s.date, s.user_id, u.name AS user_name, st.name AS shift_name
     FROM shifts s JOIN users u ON u.id = s.user_id JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.store_id IN (${sids.map(() => '?').join(',')}) AND s.user_id != ? AND s.date >= ?
     ORDER BY s.date LIMIT 200`
  ).all(...sids, user.id, today) as { id: number; date: string; user_id: number; user_name: string; shift_name: string }[] : [];
  const colleagues = sids.length ? d.prepare(
    `SELECT DISTINCT u.id, u.name FROM users u JOIN user_stores us ON us.user_id = u.id
     WHERE us.store_id IN (${sids.map(() => '?').join(',')}) AND u.id != ? AND u.active = 1`
  ).all(...sids, user.id) as { id: number; name: string }[] : [];

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>申請</h1>
        <Flash msg={msg} err={err} />

        <div className="grid2">
          <div className="card">
            <h2>請假申請</h2>
            <form action={createLeaveRequestAction}>
              <div className="row">
                <label className="fld"><span>門市</span>
                  <select name="store_id">{stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}</select>
                </label>
                <label className="fld"><span>假別</span>
                  <select name="leave_type_id">
                    {leaveTypes.map(lt => (
                      <option key={lt.id} value={lt.id}>
                        {lt.name}（{lt.pay_ratio === 1 ? '全薪' : lt.pay_ratio === 0.5 ? '半薪' : '無薪'}）
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row">
                <label className="fld"><span>開始日期</span><input type="date" name="start_date" required /></label>
                <label className="fld"><span>結束日期（全日假）</span><input type="date" name="end_date" /></label>
              </div>
              <div className="row">
                <label className="fld"><span>起（部分時數，選填）</span><input type="time" name="start_time" /></label>
                <label className="fld"><span>訖</span><input type="time" name="end_time" /></label>
              </div>
              <label className="fld"><span>事由</span><textarea name="reason" rows={2} /></label>
              <button type="submit">送出請假</button>
              <p className="muted">全日假以每日 8 小時計；同日填起訖時間則以時數計。特休／補休會即時檢查餘額。</p>
            </form>
          </div>

          <div className="card">
            <h2>加班申請</h2>
            <form action={createOvertimeAction}>
              <div className="row">
                <label className="fld"><span>門市</span>
                  <select name="store_id">{stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}</select>
                </label>
                <label className="fld"><span>日期</span><input type="date" name="date" required /></label>
              </div>
              <div className="row">
                <label className="fld"><span>開始</span><input type="time" name="start_time" required /></label>
                <label className="fld"><span>結束</span><input type="time" name="end_time" required /></label>
              </div>
              <div className="row">
                <label className="fld"><span>加班日性質</span>
                  <select name="day_kind">
                    <option value="workday">工作日（平日加班）</option>
                    <option value="restday">休息日出勤</option>
                    <option value="national_holiday">國定假日出勤</option>
                  </select>
                </label>
                <label className="fld"><span>補償方式</span>
                  <select name="compensation">
                    <option value="pay">加班費</option>
                    <option value="comp">換補休（1:1）</option>
                  </select>
                </label>
              </div>
              <label className="fld"><span>事由</span><textarea name="reason" rows={2} /></label>
              <button type="submit">送出加班申請</button>
              <p className="muted">系統會檢查每月加班上限（46／54 小時）。費率：平日前 2 小時 ×1.34、再 2 小時 ×1.67；休息日 ×1.34／×1.67／×2.67；國定假日加倍。</p>
            </form>
          </div>
        </div>

        <div className="card">
          <h2>換班申請</h2>
          <form action={createSwapAction}>
            <div className="row">
              <label className="fld"><span>我的班</span>
                <select name="from_shift_id" required>
                  {myShifts.map(s2 => <option key={s2.id} value={s2.id}>{s2.date} {s2.name}</option>)}
                </select>
              </label>
              <label className="fld"><span>對象</span>
                <select name="to_user_id" required>
                  {colleagues.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="fld"><span>換對方的班（留空＝單向轉讓）</span>
                <select name="to_shift_id" defaultValue="">
                  <option value="">－不互換，直接由對方代班－</option>
                  {colleagueShifts.map(s2 => (
                    <option key={s2.id} value={s2.id}>{s2.user_name}：{s2.date} {s2.shift_name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="fld"><span>備註</span><input type="text" name="note" /></label>
            <button type="submit">送出換班</button>
            <p className="muted">流程：對方同意 → 店長核准。核准時系統會重新檢核雙方勞基法限制，若違規將自動退回。</p>
          </form>
        </div>

        <h2>我的申請紀錄</h2>
        <div className="card tbl-scroll">
          <h2 style={{ marginTop: 0 }}>請假</h2>
          <table className="tbl">
            <thead><tr><th>假別</th><th>期間</th><th>時數</th><th>狀態</th><th>審核備註</th><th></th></tr></thead>
            <tbody>
              {myLeaves.map(l => (
                <tr key={l.id}>
                  <td>{l.type_name}</td>
                  <td>{l.start_date}{l.end_date !== l.start_date ? `～${l.end_date}` : ''}{l.start_time ? ` ${l.start_time}–${l.end_time}` : ''}</td>
                  <td>{fmtHours(l.minutes)} 小時</td>
                  <td><span className={`badge ${l.status}`}>{STATUS_NAME[l.status]}</span></td>
                  <td>{l.decision_note ?? ''}</td>
                  <td>{l.status === 'pending' && (
                    <form action={cancelRequestAction}>
                      <input type="hidden" name="kind" value="leave" /><input type="hidden" name="id" value={l.id} />
                      <button className="small secondary">取消</button>
                    </form>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>加班</h2>
          <table className="tbl">
            <thead><tr><th>日期</th><th>時間</th><th>時數</th><th>性質</th><th>補償</th><th>費率試算</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {myOts.map(o => (
                <tr key={o.id}>
                  <td>{o.date}</td><td>{o.start_time}–{o.end_time}</td><td>{fmtHours(o.minutes)} 小時</td>
                  <td>{o.day_kind === 'workday' ? '平日' : o.day_kind === 'restday' ? '休息日' : '國定假日'}</td>
                  <td>{o.compensation === 'pay' ? '加班費' : '補休'}</td>
                  <td className="muted">{overtimePaySegments(o.day_kind, o.minutes).map(seg => `${fmtHours(seg.minutes)}h×${seg.multiplier.toFixed(2)}`).join('＋')}</td>
                  <td><span className={`badge ${o.status}`}>{STATUS_NAME[o.status]}</span></td>
                  <td>{o.status === 'pending' && (
                    <form action={cancelRequestAction}>
                      <input type="hidden" name="kind" value="ot" /><input type="hidden" name="id" value={o.id} />
                      <button className="small secondary">取消</button>
                    </form>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>換班</h2>
          <table className="tbl">
            <thead><tr><th>發起人</th><th>對象</th><th>班次日期</th><th>狀態</th><th>操作</th></tr></thead>
            <tbody>
              {mySwaps.map(s2 => (
                <tr key={s2.id}>
                  <td>{s2.from_name}</td><td>{s2.to_name}</td><td>{s2.from_date}</td>
                  <td><span className={`badge ${s2.status}`}>{STATUS_NAME[s2.status]}</span></td>
                  <td>
                    {s2.status === 'pending_peer' && s2.to_user_id === user.id && (
                      <div className="row">
                        <form action={peerDecideSwapAction}>
                          <input type="hidden" name="id" value={s2.id} /><input type="hidden" name="decision" value="accept" />
                          <button className="small">同意</button>
                        </form>
                        <form action={peerDecideSwapAction}>
                          <input type="hidden" name="id" value={s2.id} /><input type="hidden" name="decision" value="reject" />
                          <button className="small secondary">婉拒</button>
                        </form>
                      </div>
                    )}
                    {['pending_peer', 'pending_manager'].includes(s2.status) && s2.from_user_id === user.id && (
                      <form action={cancelRequestAction}>
                        <input type="hidden" name="kind" value="swap" /><input type="hidden" name="id" value={s2.id} />
                        <button className="small secondary">取消</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
