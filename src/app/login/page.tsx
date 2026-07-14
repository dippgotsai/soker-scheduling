import { loginAction } from '@/app/actions';
import { currentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Flash from '@/components/Flash';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  if (await currentUser()) redirect('/');
  const { err } = await searchParams;
  return (
    <div className="login-wrap">
      <div className="card login-box">
        <h1>門市排班系統</h1>
        <p className="muted">百貨專櫃／街邊門市共用・符合台灣勞基法</p>
        <Flash err={err} />
        <form action={loginAction}>
          <label className="fld"><span>工號或 Email</span>
            <input type="text" name="account" required autoFocus />
          </label>
          <label className="fld"><span>密碼</span>
            <input type="password" name="password" required />
          </label>
          <button type="submit" style={{ width: '100%' }}>登入</button>
        </form>
      </div>
    </div>
  );
}
