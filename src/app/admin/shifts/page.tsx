import { requireManager, managedStoreIds } from '@/lib/auth';
import { db, type StoreRow, type ShiftTypeRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { upsertShiftTypeAction, deleteShiftTypeAction } from '@/app/actions';
import { shiftSpan, fmtHours } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

export default async function ShiftTypesPage({ searchParams }: {
  searchParams: Promise<{ store?: string; edit?: string; msg?: string; err?: string }>;
}) {
  const user = await requireManager();
  const sp = await searchParams;
  const d = db();
  const sids = managedStoreIds(user);
  const stores = (sids.length
    ? d.prepare(`SELECT * FROM stores WHERE id IN (${sids.map(() => '?').join(',')}) AND active = 1`).all(...sids)
    : []) as StoreRow[];
  if (!stores.length) {
    return (<><Nav user={user} /><div className="container"><p>無管轄門市。</p></div></>);
  }
  const store = stores.find(x => x.id === Number(sp.store)) ?? stores[0];
  const shiftTypes = d.prepare(`SELECT * FROM shift_types WHERE store_id = ? ORDER BY start_time`).all(store.id) as ShiftTypeRow[];
  const editing = shiftTypes.find(t => t.id === Number(sp.edit));

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>班別設定　{store.name}</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="card">
          <form method="get" className="row">
            <label className="fld"><span>門市</span>
              <select name="store" defaultValue={store.id}>
                {stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
              </select>
            </label>
            <button className="secondary" type="submit">切換</button>
          </form>
        </div>

        <div className="card tbl-scroll">
          <table className="tbl">
            <thead><tr><th>代碼</th><th>名稱</th><th>時間</th><th>休息</th><th>實際工時</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {shiftTypes.map(t => {
                const span = shiftSpan(t.start_time, t.end_time);
                const work = span.endMin - span.startMin - t.break_minutes;
                return (
                  <tr key={t.id}>
                    <td><span className="shift-chip" style={{ background: t.color }}>{t.code}</span></td>
                    <td>{t.name}</td>
                    <td>{t.start_time}–{t.end_time}{span.endMin > 1440 ? '（跨日）' : ''}</td>
                    <td>{t.break_minutes} 分</td>
                    <td>{fmtHours(work)} 小時{work > 480 && <span className="badge warn" style={{ marginLeft: 6 }}>逾 8 小時含延長工時</span>}</td>
                    <td>{t.active ? <span className="badge ok">啟用</span> : <span className="badge cancelled">停用</span>}</td>
                    <td>
                      <a href={`/admin/shifts?store=${store.id}&edit=${t.id}`}>編輯</a>
                      {user.role === 'admin' && (
                        <form action={deleteShiftTypeAction} style={{ display: 'inline', marginLeft: 8 }}>
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="store_id" value={store.id} />
                          <input type="hidden" name="back" value={`/admin/shifts?store=${store.id}`} />
                          <button className="small danger" type="submit">刪除</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {user.role === 'admin' && (
            <p className="muted">刪除僅限系統管理員，且班別未被任何排班使用過才可刪除（已使用過的班別請改「停用」以保留歷史紀錄）。</p>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>{editing ? `編輯：${editing.name}` : '新增班別'}</h2>
          <form action={upsertShiftTypeAction}>
            <input type="hidden" name="store_id" value={store.id} />
            <input type="hidden" name="back" value={`/admin/shifts?store=${store.id}`} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="row">
              <label className="fld"><span>名稱</span><input type="text" name="name" defaultValue={editing?.name} required /></label>
              <label className="fld"><span>代碼（1–2 字）</span><input type="text" name="code" maxLength={2} defaultValue={editing?.code} /></label>
              <label className="fld"><span>顏色</span><input type="color" name="color" defaultValue={editing?.color ?? '#4f6ef7'} /></label>
            </div>
            <div className="row">
              <label className="fld"><span>上班</span><input type="time" name="start_time" defaultValue={editing?.start_time} required /></label>
              <label className="fld"><span>下班（早於上班＝跨日）</span><input type="time" name="end_time" defaultValue={editing?.end_time} required /></label>
              <label className="fld"><span>休息（分鐘）</span><input type="number" name="break_minutes" min={0} step={15} defaultValue={editing?.break_minutes ?? 60} /></label>
            </div>
            {editing && <label className="fld"><input type="checkbox" name="active" defaultChecked={!!editing.active} /> 啟用</label>}
            <p className="muted">工作 4 小時至少應有 30 分鐘休息（勞基法 §35）。實際工時逾 12 小時之班別無法建立。</p>
            <button type="submit">儲存</button>
            {editing && <a className="btn secondary" href={`/admin/shifts?store=${store.id}`} style={{ marginLeft: 8 }}>取消編輯</a>}
          </form>
        </div>
      </div>
    </>
  );
}
