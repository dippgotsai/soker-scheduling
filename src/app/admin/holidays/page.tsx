import { requireManager, managedStoreIds } from '@/lib/auth';
import { db, type StoreRow } from '@/lib/db';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { upsertHolidayAction, deleteHolidayAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function HolidaysPage({ searchParams }: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const user = await requireManager();
  const sp = await searchParams;
  const d = db();
  const sids = managedStoreIds(user);
  const stores = (sids.length
    ? d.prepare(`SELECT * FROM stores WHERE id IN (${sids.map(() => '?').join(',')})`).all(...sids)
    : []) as StoreRow[];
  const holidays = d.prepare(
    `SELECT h.*, s.name AS store_name FROM holidays h LEFT JOIN stores s ON s.id = h.store_id ORDER BY h.date`
  ).all() as { id: number; date: string; name: string; holiday_type: string; store_name: string | null }[];

  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>假日設定</h1>
        <Flash msg={sp.msg} err={sp.err} />

        <div className="grid2">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>新增假日</h2>
            <form action={upsertHolidayAction}>
              <div className="row">
                <label className="fld"><span>日期</span><input type="date" name="date" required /></label>
                <label className="fld"><span>名稱</span><input type="text" name="name" placeholder="如：春節、百貨公休" required /></label>
              </div>
              <div className="row">
                <label className="fld"><span>類型</span>
                  <select name="holiday_type">
                    <option value="national">國定假日（出勤加倍工資）</option>
                    <option value="store_closed">門市公休日</option>
                  </select>
                </label>
                <label className="fld"><span>適用門市</span>
                  <select name="store_id" defaultValue="">
                    <option value="">全公司</option>
                    {stores.map(s2 => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
                  </select>
                </label>
              </div>
              <button type="submit">新增</button>
              <p className="muted">國定假日（紀念日、勞動節及其他中央主管機關規定應放假之日）應休假；經員工同意於該日出勤者工資加倍。亦可與工作日「調移」，請於班表中以例假／休息日標記處理並保留員工同意紀錄。</p>
            </form>
          </div>

          <div className="card tbl-scroll">
            <h2 style={{ marginTop: 0 }}>假日清單</h2>
            <table className="tbl">
              <thead><tr><th>日期</th><th>名稱</th><th>類型</th><th>門市</th><th></th></tr></thead>
              <tbody>
                {holidays.map(h => (
                  <tr key={h.id}>
                    <td>{h.date}</td><td>{h.name}</td>
                    <td>{h.holiday_type === 'national' ? '國定假日' : '門市公休'}</td>
                    <td>{h.store_name ?? '全公司'}</td>
                    <td>
                      <form action={deleteHolidayAction}>
                        <input type="hidden" name="id" value={h.id} />
                        <button className="small secondary">刪除</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
