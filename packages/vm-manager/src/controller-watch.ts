// Polls the controller's /health endpoint and emits transitions in each
// VM-tagged host's active-session count. The pool state machine uses these
// transitions to decide:
//   • activeSessions 0 → 1 : VM became busy → spawn a replenishment if MAX > 1
//   • activeSessions ≥1 → 0: VM became idle after serving a session → destroy
//                            it (single-use VMs guarantee tenant isolation)
//
// We poll instead of subscribing because the controller's WS host channel is
// a different protocol (authenticated host endpoint) and adding a new
// observer WS for one consumer adds API surface. Polling at 2s is cheap and
// good enough for the warm-pool reconcile loop.

import { log, warn } from './log.js';

export interface ControllerHostSnapshot {
  id: string;
  slots: number;
  active: number;
  kind: 'vm' | 'bare-metal';
  lastHeartbeat: number;
}

export interface HealthResponse {
  ok: boolean;
  hosts: ControllerHostSnapshot[];
}

export type HostTransition =
  | { kind: 'appeared'; host: ControllerHostSnapshot }
  | { kind: 'disappeared'; hostId: string }
  | { kind: 'activated'; hostId: string; active: number }
  | { kind: 'deactivated'; hostId: string };

export class ControllerWatch {
  private prev = new Map<string, ControllerHostSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(t: HostTransition) => void>();
  private aborter: AbortController | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly pollIntervalMs: number,
  ) {}

  onTransition(listener: (t: HostTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    void this.tick(); // immediate first tick so the pool sees current state
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.aborter?.abort();
  }

  /** Latest snapshot by hostId. Pool reads this to enumerate VM hosts. */
  snapshot(): ControllerHostSnapshot[] {
    return [...this.prev.values()];
  }

  private async tick(): Promise<void> {
    let body: HealthResponse;
    this.aborter?.abort();
    this.aborter = new AbortController();
    const timeout = setTimeout(() => this.aborter?.abort(), 3000);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: this.aborter.signal });
      if (!res.ok) {
        warn(`controller /health: HTTP ${res.status}`);
        return;
      }
      body = (await res.json()) as HealthResponse;
    } catch (e) {
      // Transient failure — log once and continue. The reconcile loop is
      // self-healing.
      warn(`controller /health: ${(e as Error).message}`);
      return;
    } finally {
      clearTimeout(timeout);
    }

    if (!Array.isArray(body.hosts)) {
      warn('controller /health: hosts not an array');
      return;
    }

    const next = new Map<string, ControllerHostSnapshot>();
    for (const h of body.hosts) next.set(h.id, h);

    // Diff prev → next and emit transitions.
    for (const [id, snap] of next) {
      const before = this.prev.get(id);
      if (!before) {
        this.emit({ kind: 'appeared', host: snap });
        continue;
      }
      // active count transitioned across the zero boundary?
      if (before.active === 0 && snap.active > 0) {
        this.emit({ kind: 'activated', hostId: id, active: snap.active });
      } else if (before.active > 0 && snap.active === 0) {
        this.emit({ kind: 'deactivated', hostId: id });
      }
    }
    for (const id of this.prev.keys()) {
      if (!next.has(id)) this.emit({ kind: 'disappeared', hostId: id });
    }

    this.prev = next;
  }

  private emit(t: HostTransition): void {
    log(
      `controller transition: ${
        t.kind === 'appeared'
          ? `appeared ${t.host.id} (kind=${t.host.kind}, active=${t.host.active})`
          : t.kind === 'disappeared'
            ? `disappeared ${t.hostId}`
            : t.kind === 'activated'
              ? `activated ${t.hostId} (active=${t.active})`
              : `deactivated ${t.hostId}`
      }`,
    );
    for (const l of this.listeners) {
      try {
        l(t);
      } catch (e) {
        warn(`watch listener threw: ${(e as Error).message}`);
      }
    }
  }
}
