'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionSummary } from '@sim/shared';

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceModel: 'iPhone-16-Pro' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const session = (await res.json()) as SessionSummary;
      router.push(`/session/${session.sessionId}`);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <div className="mb-12 flex items-baseline gap-2">
          <h1 className="text-3xl font-bold tracking-tight">
            sim<span className="text-blue-400">.stream</span>
          </h1>
          <span className="text-xs text-white/40">proof of concept</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-8">
          <h2 className="text-xl font-medium tracking-tight">Launch iPhone Simulator</h2>
          <p className="mt-2 text-sm text-white/50">
            A fresh iPhone 16 Pro simulator will boot on the host and stream to your browser. You
            can tap, swipe, and scroll with full latency. Sessions are placed on the next available
            slot or queued.
          </p>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={launch}
              disabled={loading}
              className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? 'Requesting…' : 'Launch'}
            </button>
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>

          <div className="mt-8 grid grid-cols-3 gap-3 text-xs">
            <Stat label="Device" value="iPhone 16 Pro" />
            <Stat label="Stream" value="JPEG / WS" />
            <Stat label="Input" value="idb" />
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-white/30">
          Controller + Host Agent — multi-host fleet ready.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-white/10 bg-[var(--surface2)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 font-mono text-xs">{value}</div>
    </div>
  );
}
