import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'sim.stream',
  description: 'Stream an iOS Simulator to your browser.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
