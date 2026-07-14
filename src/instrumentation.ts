// Next.js 伺服器啟動時初始化資料庫（建表＋首次自動 seed）
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { db } = await import('./lib/db');
    db();
  }
}
