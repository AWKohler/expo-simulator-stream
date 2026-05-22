// Pool state machine for tart VMs.
//
// The state machine maintains the invariant:
//   • At most `MAX_TOTAL` pool VMs exist.
//   • At least `TARGET_WARM` of them are in the `warm` state (booted +
//     host-agent registered + no active session) — capped by MAX_TOTAL.
//
// On botflow-mba-26 (8GB) we set {TARGET_WARM=1, MAX_TOTAL=1}: exactly one
// VM at a time. When a session arrives it transitions warm → active and we
// can't replenish (MAX hit); the controller queues subsequent sessions.
// When the session ends the VM transitions active → stopping → gone and a
// fresh one spawns. Later hardware lifts those numbers without code changes.
//
// VMs are SINGLE-USE: an `active` VM is never returned to `warm`. Destroying
// + recreating is what gives us guaranteed tenant isolation. The COW clone
// from `golden` makes this cheap (~1-2s + boot time).

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  type ControllerHostSnapshot,
  ControllerWatch,
  type HostTransition,
} from './controller-watch.js';
import { tartClone, tartDelete, tartList, tartRun, tartStop } from './tart.js';
import { log, warn } from './log.js';

export interface PoolConfig {
  goldenImage: string;
  namePrefix: string;
  targetWarm: number;
  maxTotal: number;
  memoryMB: number;
  cpu: number;
  /** Where to write per-VM bootstrap files (authkey, env). Each VM gets a
   * subdirectory which gets mounted into the guest via `tart --dir`. */
  bootstrapDir: string;
  /** Bytes to write into each VM's bootstrap `env` file. The plist inside
   * the golden sources this file via /etc/sim-vm/env. */
  envFileContents: (vmName: string) => string;
  /** Tailscale authkey written into each VM's bootstrap `authkey` file.
   * Pulled from env once at boot of vm-manager; the secret never lands in
   * the golden image itself. */
  tailscaleAuthKey: string | null;
  /** A VM that has been `active` longer than this is force-destroyed. Guards
   * against a wedged build holding the queue forever. */
  watchdogMs: number;
  /** Polling cadence for the reconcile loop. */
  reconcileIntervalMs: number;
}

type VMStatus = 'spawning' | 'warm' | 'active' | 'stopping' | 'gone';

interface PoolVM {
  name: string;
  status: VMStatus;
  /** When the VM was first seen as `active` (used by the watchdog). */
  activatedAt: number | null;
  /** Handle to the `tart run` child process so we can SIGTERM it on stop. */
  runHandle: { pid: number; kill: (signal?: NodeJS.Signals) => void } | null;
}

export class Pool {
  private readonly cfg: PoolConfig;
  private readonly watch: ControllerWatch;
  /** name → state. The source of truth for what we believe each VM is doing.
   * Reconciled against `tartList()` so we recover from desync (e.g. operator
   * destroyed a VM out of band). */
  private vms = new Map<string, PoolVM>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(cfg: PoolConfig, watch: ControllerWatch) {
    this.cfg = cfg;
    this.watch = watch;
  }

  start(): void {
    // Initial sync: scrape `tart list` for any prefix-matching VMs left over
    // from a prior vm-manager run. Treat them as `warm` for now; the next
    // /health snapshot will correct us if they're actually active.
    for (const v of tartList()) {
      if (!v.name.startsWith(this.cfg.namePrefix)) continue;
      this.vms.set(v.name, {
        name: v.name,
        // A VM left "running" by a prior crash is most likely warm-but-stale.
        // We'd rather destroy and respawn for cleanliness — mark it stopping.
        status: v.state === 'running' ? 'stopping' : 'gone',
        activatedAt: null,
        runHandle: null,
      });
    }

    this.watch.onTransition((t) => this.onControllerTransition(t));
    this.watch.start();

    void this.reconcile();
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.cfg.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.watch.stop();
    // Best-effort teardown so the operator's `tart list` is clean.
    for (const vm of this.vms.values()) {
      if (vm.status === 'gone') continue;
      vm.runHandle?.kill('SIGTERM');
      tartStop(vm.name);
      tartDelete(vm.name);
    }
  }

  // ── Reconcile loop ────────────────────────────────────────────────────────
  private async reconcile(): Promise<void> {
    if (this.stopping) return;

    // Step 1: detect controller-side facts that change our state machine.
    this.reconcileWithController();

    // Step 2: watchdog — force-destroy any VM that's been active too long.
    this.runWatchdog();

    // Step 3: maintain warm-pool invariants.
    const counts = this.counts();
    const need = Math.max(0, Math.min(this.cfg.targetWarm, this.cfg.maxTotal) - counts.warm);
    const totalRoom = this.cfg.maxTotal - counts.live;
    const spawnCount = Math.max(0, Math.min(need, totalRoom));
    for (let i = 0; i < spawnCount; i++) this.spawn();

    // Step 4: garbage-collect VMs in `stopping` whose `tart run` has actually
    // exited so we don't keep them around forever.
    this.gcStopping();
  }

  /**
   * Cross-reference our state with the controller's /health snapshot.
   * Specifically: if we have a VM marked `spawning` and the controller now
   * shows it registered (kind='vm', any active count), promote it to `warm`.
   * If it shows `active>0`, promote past warm straight to `active`.
   */
  private reconcileWithController(): void {
    const snap = this.watch.snapshot();
    const byHostId = new Map<string, ControllerHostSnapshot>(snap.map((s) => [s.id, s]));
    for (const vm of this.vms.values()) {
      if (vm.status !== 'spawning') continue;
      // The host-agent inside the VM derives HOST_ID = vm-${VM_NAME}.
      const expected = `vm-${vm.name}`;
      const hostSnap = byHostId.get(expected);
      if (!hostSnap || hostSnap.kind !== 'vm') continue;
      if (hostSnap.active > 0) {
        vm.status = 'active';
        vm.activatedAt = Date.now();
        log(`vm ${vm.name} registered AND active (active=${hostSnap.active})`);
      } else {
        vm.status = 'warm';
        log(`vm ${vm.name} warm (host-agent registered)`);
      }
    }
  }

  private runWatchdog(): void {
    const cutoff = Date.now() - this.cfg.watchdogMs;
    for (const vm of this.vms.values()) {
      if (vm.status !== 'active' || vm.activatedAt === null) continue;
      if (vm.activatedAt > cutoff) continue;
      warn(`watchdog: vm ${vm.name} active >${this.cfg.watchdogMs}ms — destroying`);
      this.destroy(vm);
    }
  }

  private gcStopping(): void {
    for (const vm of this.vms.values()) {
      if (vm.status !== 'stopping') continue;
      // Best-effort hard stop + delete. We retry every reconcile until the
      // VM truly disappears from `tart list`.
      tartStop(vm.name);
      const tartHasIt = tartList().some((t) => t.name === vm.name);
      if (!tartHasIt) {
        vm.status = 'gone';
        continue;
      }
      tartDelete(vm.name);
      const stillThere = tartList().some((t) => t.name === vm.name);
      if (!stillThere) vm.status = 'gone';
    }
    // Drop `gone` VMs from the map so they can be recreated with the same
    // generated name in a later spawn cycle if we re-randomise.
    for (const [name, vm] of [...this.vms]) {
      if (vm.status === 'gone') this.vms.delete(name);
    }
  }

  // ── Controller-driven transitions ─────────────────────────────────────────
  private onControllerTransition(t: HostTransition): void {
    if (t.kind === 'appeared') {
      // Already handled in reconcileWithController; nothing to do here.
      return;
    }
    if (t.kind === 'activated') {
      // Find the pool VM whose host-agent reported this hostId.
      const vmName = this.hostIdToVmName(t.hostId);
      if (!vmName) return;
      const vm = this.vms.get(vmName);
      if (!vm) return;
      if (vm.status === 'warm') {
        vm.status = 'active';
        vm.activatedAt = Date.now();
        log(`vm ${vm.name} warm → active (controller assigned session)`);
      }
      return;
    }
    if (t.kind === 'deactivated') {
      const vmName = this.hostIdToVmName(t.hostId);
      if (!vmName) return;
      const vm = this.vms.get(vmName);
      if (!vm) return;
      if (vm.status === 'active') {
        log(`vm ${vm.name} active → stopping (session ended, single-use lifecycle)`);
        this.destroy(vm);
      }
      return;
    }
    if (t.kind === 'disappeared') {
      const vmName = this.hostIdToVmName(t.hostId);
      if (!vmName) return;
      const vm = this.vms.get(vmName);
      if (!vm) return;
      // host-agent inside the VM dropped its WS — could be a transient
      // network blip, OR the VM is genuinely gone. Mark stopping; gcStopping
      // will reach the truth.
      if (vm.status !== 'stopping' && vm.status !== 'gone') {
        log(`vm ${vm.name} controller-side host disappeared — marking stopping`);
        vm.status = 'stopping';
      }
    }
  }

  // ── Lifecycle helpers ─────────────────────────────────────────────────────
  private spawn(): void {
    if (this.stopping) return;
    if (this.counts().live >= this.cfg.maxTotal) return;
    const name = this.makeVmName();
    log(`spawn: cloning ${this.cfg.goldenImage} → ${name}`);
    if (!tartClone(this.cfg.goldenImage, name)) return;

    // Write per-VM bootstrap (env + authkey) into a shared host directory,
    // which gets mounted into the guest via `tart --dir`. The guest's launchd
    // unit reads /etc/sim-vm/env to learn its CONTROLLER_URL / HOST_TOKEN /
    // HOST_ID, and /etc/sim-vm/authkey to join Tailscale.
    const bootstrap = `${this.cfg.bootstrapDir}/${name}`;
    try {
      mkdirSync(bootstrap, { recursive: true, mode: 0o750 });
      writeFileSync(`${bootstrap}/env`, this.cfg.envFileContents(name), { mode: 0o640 });
      if (this.cfg.tailscaleAuthKey) {
        writeFileSync(`${bootstrap}/authkey`, this.cfg.tailscaleAuthKey, { mode: 0o600 });
      }
    } catch (e) {
      warn(`spawn: bootstrap write failed for ${name}: ${(e as Error).message}`);
      tartDelete(name);
      return;
    }

    const handle = tartRun(name, {
      memoryMB: this.cfg.memoryMB,
      cpu: this.cfg.cpu,
      noGraphics: true,
      mounts: { 'sim-vm': bootstrap },
    });
    if (!handle) {
      warn(`spawn: tart run failed for ${name}`);
      tartDelete(name);
      return;
    }
    this.vms.set(name, {
      name,
      status: 'spawning',
      activatedAt: null,
      runHandle: handle,
    });
  }

  private destroy(vm: PoolVM): void {
    if (vm.status === 'stopping' || vm.status === 'gone') return;
    vm.status = 'stopping';
    vm.runHandle?.kill('SIGTERM');
    // Actual `tart stop` + `tart delete` happen in gcStopping next tick so
    // we don't block the controller-transition handler on subprocess waits.
  }

  private counts(): { spawning: number; warm: number; active: number; live: number } {
    let spawning = 0;
    let warm = 0;
    let active = 0;
    for (const vm of this.vms.values()) {
      if (vm.status === 'spawning') spawning++;
      else if (vm.status === 'warm') warm++;
      else if (vm.status === 'active') active++;
    }
    // `live` = anything occupying a pool slot (i.e. not stopping/gone).
    return { spawning, warm, active, live: spawning + warm + active };
  }

  private makeVmName(): string {
    // 4 random hex chars is plenty of entropy at max=8 concurrent spawns.
    // The prefix keeps `tart list` greppable.
    return `${this.cfg.namePrefix}-${randomBytes(2).toString('hex')}`;
  }

  /** Maps `host-agent`'s reported hostId back to our VM name. The convention
   * (set in the golden image's launchd env): `HOST_ID=vm-${VM_NAME}`. */
  private hostIdToVmName(hostId: string): string | null {
    return hostId.startsWith('vm-') ? hostId.slice(3) : null;
  }
}
