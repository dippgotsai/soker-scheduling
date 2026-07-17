import { requireUser, isManager, userStoreIds, canManageStore } from '@/lib/auth';
import { db, type StoreRow, type UserRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { assignShiftAction, removeShiftAction, markRestDayAction, importScheduleAction } from '@/app/actions';
import {
  monthDates, storeShiftTypes, storeMembers, validateStoreMonth, staffingGaps,
} from '@/lib/schedule';
import { weekdayOf } from '@/lib/laborlaw';

export const dynamic = 'force-dynamic';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

interface StoreMonthData {
  store: StoreRow;
  members: UserRow[];
  shiftMap: Map<string, { code: string; color: string }>;
  restMap: Map<string, 'regular' | 'rest'>;
  availSet: Set<string>;
  leaveMap: Map<string, string>;
}

function buildStoreMonthData(store: StoreRow, month: string, dates: string[]): StoreMonthData {
  const d = db();
  const members = storeMembers(store.id);
  const shifts = d.prepare(
    `SELECT s.user_id, s.date, st.code, st.color FROM shifts s
     JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.store_id = ? AND s.date LIKE ?`
  ).all(store.id, `${month}-%`) as { user_id: number; date: string; code: string; color: string }[];
  const rests = d.prepare(
    `SELECT user_id, date, kind FROM rest_days WHERE store_id = ? AND date LIKE ?`
  ).all(store.id, `${month}-%`) as { user_id: number; date: string; kind: 'regular' | 'rest' }[];
  const avail = d.prepare(
    `SELECT user_id, date FROM availability WHERE store_id = ? AND date LIKE ?`
  ).all(store.id, `${month}-%`) as { user_id: number; date: string }[];
  const leaves = d.prepare(
    `SELECT lr.user_id, lr.start_date, lr.end_date, lt.name FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.status = 'approved' AND lr.store_id = ? AND lr.start_date <= ? AND lr.end_date >= ?`
  ).all(store.id, dates[dates.length - 1], dates[0]) as { user_id: number; start_date: string; end_date: string; name: string }[];
  const leaveMap = new Map<string, string>();
  for (const l of leaves) {
    for (const date of dates) {
      if (date >= l.start_date && date <= l.end_date) leaveMap.set(`${l.user_id}|${date}`, l.name);
    }
  }
  return {
    store,
    members,
    shiftMap: new Map(shifts.map(r => [`${r.user_id}|${r.date}`, r])),
    restMap: new Map(rests.map(r => [`${r.user_id}|${r.date}`, r.kind])),
    availSet: new Set(avail.map(r => `${r.user_id}|${r.date}`)),
    leaveMap,
  };
}

function Roster({ data, dates, currentUserId, simpleRest = false, showRestCount = false }: {
  data: StoreMonthData; dates: string[]; currentUserId: number;
  simpleRest?: boolean;      // 例假/休息日一律顯示「休」（總覽用）
  showRestCount?: boolean;   // 列尾顯示月休天數
}) {
  const extraCols = showRestCount ? 1 : 0;
  return (
    <table className="roster">
      <thead>
        <tr>
          <th className="name-col">員工</th>
          {dates.map(date => {
            const wd = weekdayOf(date);
            return <th key={date} className={wd === 0 || wd === 6 ? 'wknd' : ''}>{Number(date.slice(8))}<br />{WD[wd]}</th>;
          })}
          {showRestCount && <th title="例假＋休息日合計">月休</th>}
        </tr>
      </thead>
      <tbody>
        {data.members.length === 0 && (
          <tr><td className="name-col muted" colSpan={dates.length + 1 + extraCols}>此門市尚未指派員工</td></tr>
        )}
        {data.members.map(m => {
          let restCount = 0;
          for (const date of dates) {
            if (data.restMap.has(`${m.id}|${date}`)) restCount++;
          }
          return (
            <tr key={m.id} style={m.id === currentUserId ? { outline: '2px solid #3b5bdb' } : undefined}>
              <td className="name-col">{m.name}{m.employment_type === 'parttime' && <span className="badge warn" style={{ marginLeft: 4, fontSize: 10.5, padding: '0 5px' }}>工讀</span>}<span className="muted"> {m.employee_no}</span></td>
              {dates.map(date => {
                const key = `${m.id}|${date}`;
                const sft = data.shiftMap.get(key);
                const rest = data.restMap.get(key);
                const leave = data.leaveMap.get(key);
                const wantsOff = data.availSet.has(key);
                let content: React.ReactNode = <span className="cell-off">·</span>;
                let cls = '';
                if (sft) content = <span className="shift-chip" style={{ background: sft.color }}>{sft.code}</span>;
                else if (leave) content = <span title={leave}>假</span>;
                else if (rest === 'regular') {
                  if (simpleRest) { content = '休'; cls = 'cell-rest'; }
                  else { content = '例'; cls = 'cell-regular'; }
                }
                else if (rest === 'rest') { content = '休'; cls = 'cell-rest'; }
                return (
                  <td key={date} className={`roster-cell ${cls}`} title={wantsOff ? '員工劃休日' : undefined}
                    style={wantsOff ? { boxShadow: 'inset 0 -3px 0 #f97316' } : undefined}>
                    {content}
                  </td>
                );
              })}
              {showRestCount && <td><strong>{restCount}</strong></td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function SchedulePage({ searchParams }: {
  searchParams: Promise<{ store?: string; month?: string; msg?: string; err?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const mgr = isManager(user);
  const d = db();

  const myStoreIds = userStoreIds(user);
  const stores = (myStoreIds.length
    ? d.prepare(`SELECT * FROM stores WHERE active = 1 AND id IN (${myStoreIds.map(() => '?').join(',')})`).all(...myStoreIds)
    : []) as StoreRow[];
  if (stores.length === 0) {
    return (<><Nav user={user} /><div className="container"><p>尚未指派門市，請聯絡管理員。</p></div></>);
  }
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : new Date().toISOString().slice(0, 7);
  const dates = monthDates(month);
  const prevMonth = shiftMonth(month, -1), nextMonth = shiftMonth(month, 1);
  const canViewAll = mgr && stores.length > 1;
  const viewAll = canViewAll && sp.store === 'all';

  // ---- 全部門市總覽 ----
  if (viewAll) {
    const blocks = stores.map(st => ({
      data: buildStoreMonthData(st, month, dates),
      violations: canManageStore(user, st.id) ? validateStoreMonth(st, month) : new Map(),
      gaps: canManageStore(user, st.id) ? staffingGaps(st, month) : [],
      shiftTypes: storeShiftTypes(st.id),
    }));
    return (
      <>
        <Nav user={user} />
        <div className="container wide">
          <h1>班表總覽　全部門市（{month}）</h1>
          <Flash msg={sp.msg} err={sp.err} />
          <div className="card">
            <form method="get" className="row">
              <label className="fld"><span>門市</span>
                <select name="store" defaultValue="all">
                  <option value="all">全部門市</option>
                  {stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
                </select>
              </label>
              <label className="fld"><span>月份</span><input type="month" name="month" defaultValue={month} /></label>
              <button type="submit" className="secondary">切換</button>
              <a className="btn secondary" href={`/schedule?store=all&month=${prevMonth}`}>← 上月</a>
              <a className="btn secondary" href={`/schedule?store=all&month=${nextMonth}`}>下月 →</a>
            </form>
          </div>

          {blocks.map(({ data, violations, gaps, shiftTypes }) => {
            const st = data.store;
            const errCount = [...violations.values()].flat().filter((v) => (v as { level: string }).level === 'error').length;
            const warnCount = [...violations.values()].flat().filter((v) => (v as { level: string }).level === 'warning').length;
            return (
              <div className="card tbl-scroll" key={st.id}>
                <h2 style={{ marginTop: 0 }}>
                  {st.name}
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                    {st.store_type === 'department' ? '百貨' : '街邊'}・{st.schedule_mode === 'eightweek' ? '八週變形' : '標準工時'}
                  </span>
                  <span style={{ marginLeft: 10 }}>
                    {errCount > 0 && <span className="badge err">{errCount} 違規</span>}{' '}
                    {warnCount > 0 && <span className="badge warn">{warnCount} 注意</span>}{' '}
                    {gaps.length > 0 && <span className="badge warn">缺口 {gaps.length}</span>}
                    {errCount === 0 && warnCount === 0 && gaps.length === 0 && <span className="badge ok">正常</span>}
                  </span>
                  <a className="btn small secondary" style={{ marginLeft: 10 }} href={`/schedule?store=${st.id}&month=${month}`}>編輯此門市</a>
                </h2>
                <p className="muted" style={{ margin: '2px 0 8px' }}>
                  班別：{shiftTypes.map(t => `${t.code}=${t.name} ${t.start_time}–${t.end_time}`).join('｜') || '尚未設定'}
                </p>
                <Roster data={data} dates={dates} currentUserId={user.id} simpleRest showRestCount />
              </div>
            );
          })}
          <p className="muted">圖例：色塊=班別｜休=休假｜假=核准請假｜橘底線=員工劃休希望日｜月休=當月例假＋休息日合計。例假/休息日之區分與編輯請點各門市的「編輯此門市」。</p>
        </div>
      </>
    );
  }

  // ---- 單一門市（原有畫面）----
  const store = stores.find(x => x.id === Number(sp.store)) ?? stores[0];
  const shiftTypes = storeShiftTypes(store.id);
  const canEdit = mgr && canManageStore(user, store.id);
  const data = buildStoreMonthData(store, month, dates);
  const members = data.members;
  const violations = canEdit ? validateStoreMonth(store, month) : new Map();
  const gaps = canEdit ? staffingGaps(store, month) : [];
  const stMap = new Map(shiftTypes.map(x => [x.id, x]));
  const back = `/schedule?store=${store.id}&month=${month}`;

  return (
    <>
      <Nav user={user} />
      <div className="container wide">
        <h1>班表　{store.name}（{store.store_type === 'department' ? '百貨' : '街邊'}・{store.schedule_mode === 'eightweek' ? '八週變形工時' : '標準工時（一例一休）'}）</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="card">
          <form method="get" className="row">
            <label className="fld"><span>門市</span>
              <select name="store" defaultValue={store.id}>
                {canViewAll && <option value="all">全部門市</option>}
                {stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
              </select>
            </label>
            <label className="fld"><span>月份</span>
              <input type="month" name="month" defaultValue={month} />
            </label>
            <button type="submit" className="secondary">切換</button>
            <a className="btn secondary" href={`/schedule?store=${store.id}&month=${prevMonth}`}>← 上月</a>
            <a className="btn secondary" href={`/schedule?store=${store.id}&month=${nextMonth}`}>下月 →</a>
          </form>
        </div>

        <div className="card tbl-scroll">
          <Roster data={data} dates={dates} currentUserId={user.id} />
          <p className="muted">圖例：色塊=班別｜例=例假｜休=休息日｜假=核准請假｜橘底線=員工劃休希望日</p>
        </div>

        {canEdit && (
          <div className="grid2">
            <div className="card">
              <h2>排班／標記</h2>
              <form action={assignShiftAction}>
                <input type="hidden" name="store_id" value={store.id} />
                <input type="hidden" name="back" value={back} />
                <div className="row">
                  <label className="fld"><span>員工</span>
                    <select name="user_id" required>
                      {members.map(m => <option key={m.id} value={m.id}>{m.name}（{m.employee_no}）</option>)}
                    </select>
                  </label>
                  <label className="fld"><span>日期</span>
                    <input type="date" name="date" required defaultValue={`${month}-01`} min={dates[0]} max={dates[dates.length - 1]} />
                  </label>
                  <label className="fld"><span>班別</span>
                    <select name="shift_type_id" required>
                      {shiftTypes.map(t => <option key={t.id} value={t.id}>{t.name}（{t.start_time}–{t.end_time}，休 {t.break_minutes} 分）</option>)}
                    </select>
                  </label>
                </div>
                <label className="fld" style={{ marginTop: 8 }}>
                  <input type="checkbox" name="force" value="1" /> 強制排入（法規檢核出現「錯誤」仍排入，須自行負擔法遵風險）
                </label>
                <button type="submit">排入班表</button>
              </form>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
              <form action={markRestDayAction} className="row">
                <input type="hidden" name="store_id" value={store.id} />
                <input type="hidden" name="back" value={back} />
                <label className="fld"><span>員工</span>
                  <select name="user_id" required>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label className="fld"><span>日期</span>
                  <input type="date" name="date" required defaultValue={`${month}-01`} />
                </label>
                <label className="fld"><span>標記</span>
                  <select name="kind">
                    <option value="regular">例假</option>
                    <option value="rest">休息日</option>
                    <option value="clear">清除標記</option>
                  </select>
                </label>
                <button type="submit" className="secondary">標記休假</button>
              </form>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
              <form action={removeShiftAction} className="row">
                <input type="hidden" name="back" value={back} />
                <label className="fld"><span>員工</span>
                  <select name="user_id" required>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label className="fld"><span>日期</span>
                  <input type="date" name="date" required defaultValue={`${month}-01`} />
                </label>
                <button type="submit" className="danger">清除排班</button>
              </form>
            </div>

            <div>
              <div className="card">
                <h2>勞基法檢核（{month}）</h2>
                {violations.size === 0 ? <p className="muted">目前無違規項目 ✓</p> : (
                  [...violations.entries()].map(([uid, vs]) => {
                    const m = members.find(x => x.id === uid);
                    return (
                      <div key={uid}>
                        <strong>{m?.name ?? uid}</strong>
                        <ul className="viol">
                          {(vs as { level: string; message: string }[]).map((v, i) => (
                            <li key={i} className={v.level}>
                              <span className={`badge ${v.level === 'error' ? 'err' : 'warn'}`}>{v.level === 'error' ? '違規' : '注意'}</span> {v.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="card">
                <h2>人力缺口</h2>
                {gaps.length === 0 ? <p className="muted">人力需求皆已滿足 ✓</p> : (
                  <ul className="viol">
                    {gaps.map((g, i) => (
                      <li key={i} className="warning">
                        {g.date} {stMap.get(g.shiftTypeId)?.name ?? g.shiftTypeId}：需 {g.need} 人，現排 {g.have} 人
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {canEdit && (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>班表批次匯入（{month}）</h2>
            <form action={importScheduleAction}>
              <input type="hidden" name="store_id" value={store.id} />
              <input type="hidden" name="month" value={month} />
              <label className="fld">
                <span>每行一位員工：工號或姓名,第1日,第2日,…第{dates.length}日（休=休息日、例=例假、班別代碼如「{shiftTypes[0]?.code ?? '全'}」=該班別、空白=下方預設）</span>
                <textarea name="csv" rows={6} style={{ maxWidth: 900, fontFamily: 'monospace' }}
                  placeholder={`TD00638,,,休,,,,休,休,,,,休,…\n許皓偉,,,,休,休,,,,休,…`} />
              </label>
              <div className="row">
                <label className="fld"><span>空白日期的處理</span>
                  <select name="default_shift_type_id" defaultValue={shiftTypes[0]?.id ?? ''}>
                    <option value="">不排班（留空）</option>
                    {shiftTypes.map(t => <option key={t.id} value={t.id}>自動排「{t.name}」（{t.start_time}–{t.end_time}）</option>)}
                  </select>
                </label>
                <label className="fld" style={{ alignSelf: 'center' }}>
                  <input type="checkbox" name="overwrite" value="1" defaultChecked /> 覆蓋此月既有排班（僅限貼上名單中的員工）
                </label>
              </div>
              <button type="submit">匯入班表</button>
              <p className="muted">匯入後每週若有休假但未標例假，自動將該週第一個休假升為例假；完成後會回報整月勞基法檢核結果。</p>
            </form>
          </div>
        )}
      </div>
    </>
  );
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d0 = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d0.toISOString().slice(0, 7);
}
