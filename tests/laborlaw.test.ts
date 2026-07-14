// 勞基法引擎單元測試
import { validateSchedule, shiftSpan, overtimePaySegments, type WorkDay } from '../src/lib/laborlaw';

let pass = 0, fail = 0;
function expect(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', name); }
}

const mk = (date: string, start: string, end: string, brk = 60): WorkDay => {
  const span = shiftSpan(start, end);
  return { date, startMin: span.startMin, endMin: span.endMin, workMinutes: span.endMin - span.startMin - brk };
};

const stdRules = { scheduleMode: 'standard' as const, otMonthlyCapMinutes: 2760, maxConsecutiveDays: 6, forbidClopening: false };
const ewRules = { scheduleMode: 'eightweek' as const, eightweekAnchor: '2026-08-03', otMonthlyCapMinutes: 2760, maxConsecutiveDays: 6, forbidClopening: false };

// 1. 11 小時間隔違規：晚班 22:30 下班 → 隔日 08:00 上班（9.5h）
{
  const v = validateSchedule([mk('2026-08-03', '15:00', '22:30'), mk('2026-08-04', '08:00', '16:00')], stdRules,
    { checkFrom: '2026-08-03', checkTo: '2026-08-04' });
  expect('GAP_11H detected', v.some(x => x.code === 'GAP_11H' && x.level === 'error'));
}
// 2. 正常間隔無違規
{
  const v = validateSchedule([mk('2026-08-03', '10:00', '18:00'), mk('2026-08-04', '10:00', '18:00')], stdRules,
    { checkFrom: '2026-08-03', checkTo: '2026-08-04' });
  expect('normal gap OK', !v.some(x => x.code === 'GAP_11H'));
}
// 3. 連續 7 天（標準工時七休一）→ error
{
  const days: WorkDay[] = [];
  for (let i = 3; i <= 9; i++) days.push(mk(`2026-08-0${i}`, '10:00', '18:00'));
  const v = validateSchedule(days, stdRules, { checkFrom: '2026-08-03', checkTo: '2026-08-09' });
  expect('7 consecutive error (standard)', v.some(x => x.code === 'CONSECUTIVE' && x.level === 'error'));
}
// 4. 八週變形連續 7 天 → 僅內規 warning，非法規 error
{
  const days: WorkDay[] = [];
  for (let i = 3; i <= 9; i++) days.push(mk(`2026-08-0${i}`, '10:00', '18:00'));
  const v = validateSchedule(days, ewRules, { checkFrom: '2026-08-03', checkTo: '2026-08-09' });
  expect('7 consecutive not error (eightweek)', !v.some(x => x.code === 'CONSECUTIVE'));
  expect('7 consecutive policy warning (eightweek)', v.some(x => x.code === 'CONSECUTIVE_POLICY' && x.level === 'warning'));
}
// 5. 八週變形連續 13 天 → error
{
  const days: WorkDay[] = [];
  for (let i = 0; i < 13; i++) {
    const dd = new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10);
    days.push(mk(dd, '10:00', '18:00'));
  }
  const v = validateSchedule(days, ewRules, { checkFrom: '2026-08-03', checkTo: '2026-08-15' });
  expect('13 consecutive error (eightweek)', v.some(x => x.code === 'CONSECUTIVE' && x.level === 'error'));
}
// 6. 單日 >12 小時 → error；>8 → warning
{
  const v = validateSchedule([mk('2026-08-03', '08:00', '21:30', 60)], stdRules, { checkFrom: '2026-08-03', checkTo: '2026-08-03' });
  expect('12h error', v.some(x => x.code === 'DAILY_12H'));
  const v2 = validateSchedule([mk('2026-08-03', '08:00', '18:00', 60)], stdRules, { checkFrom: '2026-08-03', checkTo: '2026-08-03' });
  expect('9h OT warning', v2.some(x => x.code === 'DAILY_OT' && x.level === 'warning'));
}
// 7. 標準工時週 41+ 小時 → error（6 天 × 7h = 42h 正常工時）
{
  const days: WorkDay[] = [];
  for (let i = 3; i <= 8; i++) days.push(mk(`2026-08-0${i}`, '10:00', '18:00', 60)); // 7h × 6 = 42h
  const v = validateSchedule(days, stdRules, { checkFrom: '2026-08-03', checkTo: '2026-08-09' });
  expect('weekly 40h cap error (standard)', v.some(x => x.code === 'WEEKLY_CAP'));
}
// 8. 八週變形同樣 42h/週 → OK（<48）
{
  const days: WorkDay[] = [];
  for (let i = 3; i <= 8; i++) days.push(mk(`2026-08-0${i}`, '10:00', '18:00', 60));
  const v = validateSchedule(days, ewRules, { checkFrom: '2026-08-03', checkTo: '2026-08-09' });
  expect('weekly 42h OK (eightweek)', !v.some(x => x.code === 'WEEKLY_CAP'));
}
// 9. 未成年夜間 → error
{
  const v = validateSchedule([mk('2026-08-03', '15:00', '22:30')], stdRules,
    { checkFrom: '2026-08-03', checkTo: '2026-08-03', flags: { isMinor: true } });
  expect('minor night error', v.some(x => x.code === 'MINOR_NIGHT'));
}
// 10. 妊娠 22:00 後 → error
{
  const v = validateSchedule([mk('2026-08-03', '15:00', '22:30')], stdRules,
    { checkFrom: '2026-08-03', checkTo: '2026-08-03', flags: { isPregnant: true } });
  expect('pregnant night error', v.some(x => x.code === 'PREGNANT_NIGHT'));
}
// 11. 加班費率
{
  const segs = overtimePaySegments('workday', 180); // 3h
  expect('workday OT segments', segs.length === 2 && segs[0].minutes === 120 && segs[1].minutes === 60);
  const rest = overtimePaySegments('restday', 540); // 9h
  expect('restday OT segments', rest.length === 3 && rest[2].minutes === 60);
}
// 12. 一例一休：週工作 6 天僅 1 休 → error
{
  const days: WorkDay[] = [];
  for (let i = 3; i <= 8; i++) days.push(mk(`2026-08-0${i}`, '10:00', '17:00', 60)); // 6天×6h=36h < 40
  const v = validateSchedule(days, stdRules, { checkFrom: '2026-08-03', checkTo: '2026-08-09' });
  expect('one-rest-one-regular error', v.some(x => x.code === 'ONE_REST_ONE_REGULAR'));
}
// 13. 八週 320 小時：8 週排 41 個 8h 班（328h）→ error
{
  const days: WorkDay[] = [];
  let cnt = 0;
  for (let i = 0; i < 56 && cnt < 41; i++) {
    const dd = new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10);
    const wd = new Date(dd).getUTCDay();
    if (wd === 0) continue; // 週日休（滿足每週例假）
    days.push(mk(dd, '09:00', '18:00', 60)); // 8h
    cnt++;
  }
  const v = validateSchedule(days, ewRules, { checkFrom: '2026-08-03', checkTo: '2026-09-27' });
  expect('cycle 320h error', v.some(x => x.code === 'CYCLE_320H'));
}
// 14. 月加班上限：核准加班 47 小時 → error
{
  const otMap = new Map<string, number>();
  for (let i = 1; i <= 24; i++) otMap.set(`2026-08-${String(i).padStart(2, '0')}`, 120); // 48h
  const v = validateSchedule([mk('2026-08-03', '10:00', '18:00')], stdRules,
    { checkFrom: '2026-08-01', checkTo: '2026-08-31', approvedOtByDate: otMap });
  expect('monthly OT cap error', v.some(x => x.code === 'MONTHLY_OT'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
