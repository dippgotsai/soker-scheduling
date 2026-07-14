import { requireUser } from '@/lib/auth';
import Nav from '@/components/Nav';
import Flash from '@/components/Flash';
import { changePasswordAction } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const user = await requireUser();
  const { msg, err } = await searchParams;
  return (
    <>
      <Nav user={user} />
      <div className="container">
        <h1>個人設定</h1>
        <Flash msg={msg} err={err} />
        <div className="card">
          <p>工號：{user.employee_no}｜到職日：{user.hire_date}</p>
          <h2>變更密碼</h2>
          <form action={changePasswordAction}>
            <label className="fld"><span>舊密碼</span><input type="password" name="old_password" required /></label>
            <label className="fld"><span>新密碼（至少 8 碼）</span><input type="password" name="new_password" required minLength={8} /></label>
            <button type="submit">更新密碼</button>
          </form>
        </div>
      </div>
    </>
  );
}
