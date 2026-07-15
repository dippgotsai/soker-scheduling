import { requireAdmin } from '@/lib/auth';
import { db, type StoreRow, type UserRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { upsertUserAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

const ROLE_NAMES: Record<string, string> = {
  admin: '系統管理員', area_manager: '區域主管', store_manager: '店長', employee: '員工',
};

export default async function UsersPage({ searchParams }: {
  searchParams: Promise<{ edit?: string; msg?: string; err?: string }>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const d = db();
  const users = d.prepare(`SELECT * FROM users ORDER BY employee_no`).all() as UserRow[];
  const stores = d.prepare(`SELECT * FROM stores WHERE active = 1 ORDER BY id`).all() as StoreRow[];
  const editing = users.find(u2 => u2.id === Number(sp.edit));
  const editingStores = editing
    ? (d.prepare(`SELECT store_id FROM user_stores WHERE user_id = ?`).all(editing.id) as { store_id: number }[]).map(r => r.store_id)
    : [];
  const storeNames = new Map<number, string[]>();
  for (const r of d.prepare(
    `SELECT us.user_id, s.name FROM user_stores us JOIN stores s ON s.id = us.store_id`
  ).all() as { user_id: number; name: string }[]) {
    if (!storeNames.has(r.user_id)) storeNames.set(r.user_id, []);
    storeNames.get(r.user_id)!.push(r.name);
  }

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>帳號管理</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="card tbl-scroll">
          <table className="tbl">
            <thead><tr><th>工號</th><th>姓名</th><th>Email</th><th>角色</th><th>僱用型態</th><th>到職日</th><th>門市</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {users.map(u2 => (
                <tr key={u2.id}>
                  <td>{u2.employee_no}</td><td>{u2.name}</td><td>{u2.email}</td>
                  <td>{ROLE_NAMES[u2.role]}</td>
                  <td>{u2.employment_type === 'parttime' ? `工讀（週 ${u2.weekly_hours}h）` : '正職'}</td>
                  <td>{u2.hire_date}</td>
                  <td>{(storeNames.get(u2.id) ?? []).join('、')}</td>
                  <td>{u2.active ? <span className="badge ok">啟用</span> : <span className="badge cancelled">停用</span>}</td>
                  <td><a href={`/admin/users?edit=${u2.id}`}>編輯</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>{editing ? `編輯：${editing.name}` : '新增帳號'}</h2>
          <form action={upsertUserAction}>
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="row">
              <label className="fld"><span>工號</span><input type="text" name="employee_no" defaultValue={editing?.employee_no} required /></label>
              <label className="fld"><span>姓名</span><input type="text" name="name" defaultValue={editing?.name} required /></label>
              <label className="fld"><span>Email</span><input type="email" name="email" defaultValue={editing?.email ?? ''} /></label>
            </div>
            <div className="row">
              <label className="fld"><span>角色</span>
                <select name="role" defaultValue={editing?.role ?? 'employee'}>
                  <option value="employee">員工</option>
                  <option value="store_manager">店長</option>
                  <option value="area_manager">區域主管</option>
                  <option value="admin">系統管理員</option>
                </select>
              </label>
              <label className="fld"><span>到職日（特休年資起算）</span>
                <input type="date" name="hire_date" defaultValue={editing?.hire_date} required />
              </label>
              <label className="fld"><span>{editing ? '重設密碼（留空不變）' : '密碼'}</span>
                <input type="password" name="password" minLength={8} />
              </label>
            </div>
            <div className="row">
              <label className="fld"><span>僱用型態</span>
                <select name="employment_type" defaultValue={editing?.employment_type ?? 'fulltime'}>
                  <option value="fulltime">正職（全時）</option>
                  <option value="parttime">工讀生／部分工時</option>
                </select>
              </label>
              <label className="fld"><span>約定每週工時（工讀生用，特休按 ÷40 比例計給）</span>
                <input type="number" name="weekly_hours" min={1} max={48} step={0.5}
                  defaultValue={editing?.weekly_hours ?? 40} />
              </label>
            </div>
            <label className="fld"><span>所屬門市（可複選；第一個勾選為主門市）</span>
              <span style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontWeight: 400 }}>
                {stores.map(s2 => (
                  <label key={s2.id}>
                    <input type="checkbox" name="store_ids" value={s2.id} defaultChecked={editingStores.includes(s2.id)} /> {s2.name}
                  </label>
                ))}
              </span>
            </label>
            <div className="row" style={{ margin: '10px 0' }}>
              <label><input type="checkbox" name="is_pregnant" defaultChecked={!!editing?.is_pregnant} /> 妊娠／哺乳期間（22:00–06:00 禁排班）</label>
              <label><input type="checkbox" name="is_minor" defaultChecked={!!editing?.is_minor} /> 未成年工（20:00–06:00 禁排班、日上限 8 小時）</label>
              <label><input type="checkbox" name="active" defaultChecked={editing ? !!editing.active : true} /> 帳號啟用</label>
            </div>
            <button type="submit">儲存</button>
            {editing && <a className="btn secondary" href="/admin/users" style={{ marginLeft: 8 }}>取消編輯</a>}
          </form>
        </div>
      </div>
    </>
  );
}
