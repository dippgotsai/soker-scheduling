import { requireUser, isManager, userStoreIds, canManageStore } from '@/lib/auth';
import { db, type StoreRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { submitAvailabilityAction, setAvailabilityWindowAction } from '@/app/actions';
import { monthDates } from '@/lib/schedule';
import { weekdayOf } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';
const WD = ['日', '一', '二', '三', '四', '五', '六'];

export default async function AvailabilityPage({ searchParams }: {
  searchParams: Promise<{ store?: string; month?: string; msg?: string; err?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const d = db();
  const mgr = isManager(user);
  const sids = userStoreIds(user);
  const stores = (sids.length
    ? d.prepare(`SELECT * FROM stores WHERE id IN (${sids.map(() => '?').join(',')})`).all(...sids)
    : []) as StoreRow[];
  if (!stores.length) {
    return (<><Nav user={user} /><div className="container"><p>尚未指派門市。</p></div></>);
  }
  const store = stores.find(x => x.id === Number(sp.store)) ?? stores[0];
  const nextMonth = defaultNextMonth();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : nextMonth;

  const win = d.prepare(
    `SELECT * FROM availability_windows WHERE store_id = ? AND target_month = ?`
  ).get(store.id, month) as { open_from: string; open_until: string; max_off_days: number } | undefined;

  const mine = d.prepare(
    `SELECT date FROM availability WHERE user_id = ? AND date LIKE ?`
  ).all(user.id, `${month}-%`) as { date: string }[];
  const mineSet = new Set(mine.map(r => r.date));

  const dates = monthDates(month);
  const today = new Date().toISOString().slice(0, 10);
  const open = !!win && today >= win.open_from && today <= win.open_until;

  const submissions = mgr && canManageStore(user, store.id) ? d.prepare(
    `SELECT a.date, u.name FROM availability a JOIN users u ON u.id = a.user_id
     WHERE a.store_id = ? AND a.date LIKE ? ORDER BY a.date`
  ).all(store.id, `${month}-%`) as { date: string; name: string }[] : [];

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>劃休　{store.name}（{month}）</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="card">
          <form method="get" className="row">
            <label className="fld"><span>門市</span>
              <select name="store" defaultValue={store.id}>
                {stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
              </select>
            </label>
            <label className="fld"><span>月份</span><input type="month" name="month" defaultValue={month} /></label>
            <button className="secondary" type="submit">切換</button>
          </form>
        </div>

        <div className="card">
          {!win ? (
            <p className="muted">此月份尚未開放劃休{mgr ? '，請於下方設定開放期間。' : '，請等候店長開放。'}</p>
          ) : (
            <>
              <p>開放期間：{win.open_from} ～ {win.open_until}｜每人最多可劃 <strong>{win.max_off_days}</strong> 天
                {open ? <span className="badge ok" style={{ marginLeft: 8 }}>開放中</span> : <span className="badge cancelled" style={{ marginLeft: 8 }}>未開放</span>}
              </p>
              <form action={submitAvailabilityAction}>
                <input type="hidden" name="store_id" value={store.id} />
                <input type="hidden" name="month" value={month} />
                <input type="hidden" name="back" value={`/availability?store=${store.id}&month=${month}`} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, maxWidth: 560 }}>
                  {Array.from({ length: weekdayOf(dates[0]) }).map((_, i) => <div key={`pad${i}`} />)}
                  {dates.map(date => (
                    <label key={date} style={{
                      border: '1px solid var(--border)', borderRadius: 8, padding: '6px 4px',
                      textAlign: 'center', fontSize: 13, cursor: 'pointer',
                      background: mineSet.has(date) ? '#ffedd5' : '#fff',
                    }}>
                      <div className="muted">{WD[weekdayOf(date)]}</div>
                      <div><strong>{Number(date.slice(8))}</strong></div>
                      <input type="checkbox" name="dates" value={date} defaultChecked={mineSet.has(date)} disabled={!open} />
                    </label>
                  ))}
                </div>
                {open && <p><button type="submit">送出劃休</button></p>}
              </form>
            </>
          )}
        </div>

        {mgr && canManageStore(user, store.id) && (
          <div className="grid2">
            <div className="card">
              <h2 style={{ marginTop: 0 }}>設定劃休開放期間（店長）</h2>
              <form action={setAvailabilityWindowAction}>
                <input type="hidden" name="store_id" value={store.id} />
                <input type="hidden" name="back" value={`/availability?store=${store.id}&month=${month}`} />
                <div className="row">
                  <label className="fld"><span>目標月份</span><input type="month" name="target_month" defaultValue={month} required /></label>
                  <label className="fld"><span>開放起</span><input type="date" name="open_from" required /></label>
                  <label className="fld"><span>開放迄</span><input type="date" name="open_until" required /></label>
                  <label className="fld"><span>每人上限（天）</span><input type="number" name="max_off_days" defaultValue={win?.max_off_days ?? 8} min={1} max={31} /></label>
                </div>
                <button type="submit">儲存設定</button>
              </form>
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>員工劃休一覽</h2>
              {submissions.length === 0 ? <p className="muted">尚無劃休資料</p> : (
                <div className="tbl-scroll"><table className="tbl">
                  <thead><tr><th>日期</th><th>已劃休員工</th></tr></thead>
                  <tbody>
                    {[...groupBy(submissions)].map(([date, names]) => (
                      <tr key={date}><td>{date}</td><td>{names.join('、')}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function defaultNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}
function groupBy(rows: { date: string; name: string }[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    if (!m.has(r.date)) m.set(r.date, []);
    m.get(r.date)!.push(r.name);
  }
  return m;
}
