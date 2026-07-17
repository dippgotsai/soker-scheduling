import { redirect } from 'next/navigation';

// 班表總覽獨立入口：導向班表頁的「全部門市」視圖（單店主管會自動退回單店畫面）
export default async function OverviewPage({ searchParams }: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  redirect(`/schedule?store=all${month ? `&month=${month}` : ''}`);
}
