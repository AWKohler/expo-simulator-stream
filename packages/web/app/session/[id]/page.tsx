'use client';

import { use, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionState } from '@sim/shared';
import { SimulatorViewport } from '@/components/SimulatorViewport';

interface LogLine {
  ts: string;
  text: string;
  level: 'info' | 'ok' | 'warn' | 'err';
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [state, setState] = useState<SessionState>('queued');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const addLog = useCallback((text: string, level: LogLine['level'] = 'info') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((prev) => [...prev.slice(-99), { ts, text, level }]);
  }, []);

  const onStateChange = useCallback((next: string, qp?: number) => {
    setState(next as SessionState);
    setQueuePosition(qp ?? null);
    addLog(`state → ${next}${qp ? ` (queue #${qp})` : ''}`);
  }, [addLog]);

  const endSession = async (): Promise<void> => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    router.push('/');
  };

  const statusMode =
    state === 'streaming' ? 'live' : state === 'queued' || state === 'starting' ? 'busy' : state === 'error' ? 'error' : '';

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-13 items-center gap-4 border-b border-white/10 bg-[var(--surface)] px-5">
        <div className="text-base font-bold tracking-tight">
          sim<span className="text-blue-400">.stream</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`dot ${statusMode}`} />
          <span className="capitalize text-white/80">{state}</span>
          {queuePosition !== null && (
            <span className="ml-2 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-xs">
              queue #{queuePosition}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <code className="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-white/60">
            {id.slice(0, 8)}
          </code>
          <button
            onClick={endSession}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
          >
            End session
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-64 flex-col gap-3 border-r border-white/10 p-3.5">
          <div className="rounded-xl border border-white/10 bg-[var(--surface2)] p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-white/40">Session</div>
            <div className="space-y-1 text-xs">
              <Row k="State" v={state} />
              <Row k="Queue" v={queuePosition ?? '—'} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-white/40">Log</div>
            <div className="modern-scrollbar flex-1 overflow-y-auto rounded-xl border border-white/10 bg-[var(--surface2)] p-3 font-mono text-[10.5px] leading-relaxed">
              {logs.length === 0 ? (
                <div className="text-white/30">No events yet.</div>
              ) : (
                logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.level === 'err'
                        ? 'text-red-400'
                        : l.level === 'warn'
                          ? 'text-amber-400'
                          : l.level === 'ok'
                            ? 'text-emerald-400'
                            : 'text-white/60'
                    }
                  >
                    {l.ts} {l.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <section className="relative flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,_#13131a_0%,_var(--bg)_100%)]">
          {state === 'queued' || state === 'starting' ? (
            <QueueState state={state} queuePosition={queuePosition} />
          ) : null}
          {state === 'ended' || state === 'error' ? (
            <EndedState state={state} onRestart={() => router.push('/')} />
          ) : null}
          {state === 'streaming' && (
            <SimulatorViewport sessionId={id} onStateChange={onStateChange} onLog={addLog} />
          )}
          {state !== 'streaming' && (
            // Render the viewport off-screen so its WS subscribes immediately and we don't miss
            // the initial 'streaming' transition / first calibration frame.
            <div className="pointer-events-none absolute -left-[9999px] top-0">
              <SimulatorViewport sessionId={id} onStateChange={onStateChange} onLog={addLog} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/40">{k}</span>
      <span className="font-mono text-white/80">{v}</span>
    </div>
  );
}

function QueueState({ state, queuePosition }: { state: SessionState; queuePosition: number | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="rounded-2xl border border-white/10 bg-[var(--surface)] px-8 py-10">
        {state === 'queued' ? (
          <>
            <div className="text-[10px] uppercase tracking-widest text-white/40">Waiting in queue</div>
            <div className="mt-3 text-6xl font-light tracking-tighter">
              {queuePosition ? `#${queuePosition}` : '…'}
            </div>
            <p className="mt-4 max-w-xs text-xs text-white/50">
              All host slots are currently in use. You&apos;ll be placed automatically when one frees up.
            </p>
          </>
        ) : (
          <>
            <div className="text-[10px] uppercase tracking-widest text-amber-400">Booting simulator…</div>
            <div className="mt-3 text-2xl font-light tracking-tight">iPhone 16 Pro</div>
            <p className="mt-4 max-w-xs text-xs text-white/50">
              First boot can take 10–20 seconds while the host warms idb_companion.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function EndedState({ state, onRestart }: { state: SessionState; onRestart: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="rounded-2xl border border-white/10 bg-[var(--surface)] px-8 py-10">
        <div className={`text-[10px] uppercase tracking-widest ${state === 'error' ? 'text-red-400' : 'text-white/40'}`}>
          {state === 'error' ? 'Session error' : 'Session ended'}
        </div>
        <p className="mt-4 max-w-xs text-xs text-white/50">
          {state === 'error'
            ? 'Check the log for details. The host slot has been released.'
            : 'The simulator has been shut down. Start a new session?'}
        </p>
        <button
          onClick={onRestart}
          className="mt-6 rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-400"
        >
          New session
        </button>
      </div>
    </div>
  );
}
