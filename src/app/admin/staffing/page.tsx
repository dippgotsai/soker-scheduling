import { requireManager, managedStoreIds } from '@/lib/auth';
import { db, type StoreRow, type ShiftTypeRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { upsertStaffingAction } from '@/app/actions';

export const dynamic = 'force-dynamic';
const WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default async function StaffingPage({ searchParams }: {
  searchParams: Promise<{ store?: string; msg?: string; err?: string }>;
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
  const shiftTypes = d.prepare(
    `SELECT * FROM shift_types WHERE store_id = ? AND active = 1 ORDER BY start_time`
  ).all(store.id) as ShiftTypeRow[];
  const reqs = d.prepare(
    `SELECT shift_type_id, weekday, min_staff FROM staffing_requirements WHERE store_id = ?`
  ).all(store.id) as { shift_type_id: number; weekday: number; min_staff: number }[];
  const reqMap = new Map(reqs.map(r => [`${r.shift_type_id}|${r.weekday}`, r.min_staff]));

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>人力需求設定　{store.name}</h1>
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
          <p className="muted">設定每個班別在各星期日至少需要的人數；排班頁會依此顯示人力缺口。0 = 不需求。</p>
          <form action={upsertStaffingAction}>
            <input type="hidden" name="store_id" value={store.id} />
            <input type="hidden" name="back" value={`/admin/staffing?store=${store.id}`} />
            <table className="tbl">
              <thead><tr><th>班別</th>{WD.map(w => <th key={w}>{w}</th>)}</tr></thead>
              <tbody>
                {shiftTypes.map(t => (
                  <tr key={t.id}>
                    <td><span className="shift-chip" style={{ background: t.color }}>{t.code}</span> {t.name}</td>
                    {WD.map((_, wd) => (
                      <td key={wd}>
                        <input type="number" name={`req_${t.id}_${wd}`} min={0} max={99}
                          defaultValue={reqMap.get(`${t.id}|${wd}`) ?? 0} style={{ width: 64 }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p><button type="submit">儲存人力需求</button></p>
          </form>
        </div>
      </div>
    </>
  );
}
