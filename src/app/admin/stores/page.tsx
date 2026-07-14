import { requireAdmin } from '@/lib/auth';
import { db, type StoreRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { upsertStoreAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function StoresPage({ searchParams }: {
  searchParams: Promise<{ edit?: string; msg?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const stores = db().prepare(`SELECT * FROM stores ORDER BY id`).all() as StoreRow[];
  const editing = stores.find(s2 => s2.id === Number(sp.edit));

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>門市管理</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="card tbl-scroll">
          <table className="tbl">
            <thead><tr><th>名稱</th><th>型態</th><th>工時制度</th><th>八週起算日</th><th>月加班上限</th><th>營業時間</th><th>內規連上上限</th><th></th></tr></thead>
            <tbody>
              {stores.map(s2 => (
                <tr key={s2.id}>
                  <td>{s2.name}{!s2.active && <span className="badge cancelled" style={{ marginLeft: 6 }}>停用</span>}</td>
                  <td>{s2.store_type === 'department' ? '百貨專櫃' : '街邊門市'}</td>
                  <td>{s2.schedule_mode === 'eightweek' ? '八週變形' : '標準（一例一休）'}</td>
                  <td>{s2.eightweek_anchor ?? '－'}</td>
                  <td>{s2.ot_monthly_cap_minutes / 60} 小時</td>
                  <td>{s2.open_time}–{s2.close_time}</td>
                  <td>{s2.max_consecutive_days} 天{s2.forbid_clopening ? '｜禁晚接早' : ''}</td>
                  <td><a href={`/admin/stores?edit=${s2.id}`}>編輯</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>{editing ? `編輯：${editing.name}` : '新增門市'}</h2>
          <form action={upsertStoreAction}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="row">
              <label className="fld"><span>名稱</span><input type="text" name="name" defaultValue={editing?.name} required /></label>
              <label className="fld"><span>型態</span>
                <select name="store_type" defaultValue={editing?.store_type ?? 'department'}>
                  <option value="department">百貨專櫃</option>
                  <option value="street">街邊門市</option>
                </select>
              </label>
              <label className="fld"><span>工時制度</span>
                <select name="schedule_mode" defaultValue={editing?.schedule_mode ?? 'standard'}>
                  <option value="standard">標準工時（一例一休）</option>
                  <option value="eightweek">八週變形工時</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="fld"><span>八週週期起算日（採八週變形必填，建議週一）</span>
                <input type="date" name="eightweek_anchor" defaultValue={editing?.eightweek_anchor ?? ''} />
              </label>
              <label className="fld"><span>每月加班上限（小時）</span>
                <select name="ot_monthly_cap_hours" defaultValue={editing ? editing.ot_monthly_cap_minutes / 60 : 46}>
                  <option value="46">46（法定）</option>
                  <option value="54">54（經勞資會議同意）</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="fld"><span>開店</span><input type="time" name="open_time" defaultValue={editing?.open_time ?? '11:00'} /></label>
              <label className="fld"><span>閉店</span><input type="time" name="close_time" defaultValue={editing?.close_time ?? '22:00'} /></label>
              <label className="fld"><span>內規：最多連上天數</span>
                <input type="number" name="max_consecutive_days" min={1} max={12} defaultValue={editing?.max_consecutive_days ?? 6} />
              </label>
            </div>
            <label className="fld">
              <input type="checkbox" name="forbid_clopening" defaultChecked={!!editing?.forbid_clopening} /> 內規：禁止晚班隔日接早班（clopening）
            </label>
            <p className="muted">採用八週變形工時之門市，須為勞動部指定行業（零售業屬之）並經工會或勞資會議同意，請先完成程序再啟用。</p>
            <button type="submit">儲存</button>
            {editing && <a className="btn secondary" href="/admin/stores" style={{ marginLeft: 8 }}>取消編輯</a>}
          </form>
        </div>
      </div>
    </>
  );
}
