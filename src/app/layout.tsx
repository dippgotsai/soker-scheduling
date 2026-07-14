import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '門市排班系統',
  description: '百貨與街邊門市共用排班系統（符合台灣勞基法）',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
