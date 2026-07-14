import Link from 'next/link';
import type { UserRow } from '@/lib/db';
import { isManager } from '@/lib/auth';
import { logoutAction } from '@/app/actions';

const ROLE_NAMES: Record<string, string> = {
  admin: '系統管理員', area_manager: '區域主管', store_manager: '店長', employee: '員工',
};

export default function Nav({ user }: { user: UserRow }) {
  const mgr = isManager(user);
  return (
    <nav className="topbar">
      <span className="brand">門市排班</span>
      <Link href="/">首頁</Link>
      <Link href="/schedule">班表</Link>
      <Link href="/requests">申請</Link>
      <Link href="/availability">劃休</Link>
      <Link href="/balances">假別餘額</Link>
      {mgr && <Link href="/approvals">審核中心</Link>}
      {mgr && <Link href="/admin/shifts">班別設定</Link>}
      {mgr && <Link href="/admin/staffing">人力需求</Link>}
      {mgr && <Link href="/admin/holidays">假日設定</Link>}
      {user.role === 'admin' && <Link href="/admin/stores">門市管理</Link>}
      {user.role === 'admin' && <Link href="/admin/users">帳號管理</Link>}
      <span className="spacer" />
      <span className="who">{user.name}（{ROLE_NAMES[user.role]}）</span>
      <Link href="/profile">密碼</Link>
      <form action={logoutAction} style={{ display: 'inline' }}>
        <button className="small secondary" type="submit">登出</button>
      </form>
    </nav>
  );
}
