// vm-manager — bare-metal-side service that maintains the tart VM pool.
//
// One process, one box. Reads config from env, polls the controller's /health
// endpoint to learn host-side facts, and drives `tart` to keep the pool at
// the {TARGET_WARM, MAX_TOTAL} target.
//
// Designed for {warm=N, max=M}; configured for {1, 1} on botflow-mba-26.
// Scaling up requires only env changes (and enough RAM/disk to back it).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as dotenv } from 'dotenv';
import { ControllerWatch } from './controller-watch.js';
import { Pool, type PoolConfig } from './pool.js';
import { log, warn } from './log.js';

// Load env vars from a `.env` at the workspace root (where the operator
// keeps secrets like TS_AUTHKEY). `.env*` is gitignored at the expo-stream
// root so this never lands in the repo. We resolve relative to cwd which is
// where pnpm runs the package from.
dotenv({ path: path.resolve(process.cwd(), '.env') });

interface RawEnv {
  CONTROLLER_BASE_URL: string;
  CONTROLLER_HOST_TOKEN: string;
  VM_MANAGER_GOLDEN: string;
  VM_NAME_PREFIX: string;
  VM_POOL_WARM: number;
  VM_POOL_MAX: number;
  VM_MEMORY_MB: number;
  VM_CPU_COUNT: number;
  VM_BOOTSTRAP_DIR: string;
  WATCHDOG_MS: number;
  RECONCILE_INTERVAL_MS: number;
  HEALTH_POLL_MS: number;
  TS_AUTHKEY: string | null;
}

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    warn(`env ${name}=${raw} invalid; using ${fallback}`);
    return fallback;
  }
  return n;
}

function loadEnv(): RawEnv {
  const cfg: RawEnv = {
    CONTROLLER_BASE_URL: process.env.CONTROLLER_BASE_URL ?? 'http://127.0.0.1:8080',
    CONTROLLER_HOST_TOKEN: process.env.HOST_TOKEN ?? 'dev-token',
    VM_MANAGER_GOLDEN: process.env.VM_MANAGER_GOLDEN ?? 'golden',
    VM_NAME_PREFIX: process.env.VM_NAME_PREFIX ?? 'sim-vm',
    VM_POOL_WARM: intEnv('VM_POOL_WARM', 1, 0),
    VM_POOL_MAX: intEnv('VM_POOL_MAX', 1, 1),
    VM_MEMORY_MB: intEnv('VM_MEMORY_MB', 4096, 1024),
    VM_CPU_COUNT: intEnv('VM_CPU_COUNT', 2, 1),
    VM_BOOTSTRAP_DIR: process.env.VM_BOOTSTRAP_DIR ?? '/tmp/sim-vm-bootstrap',
    WATCHDOG_MS: intEnv('WATCHDOG_MS', 15 * 60 * 1000, 60_000),
    RECONCILE_INTERVAL_MS: intEnv('RECONCILE_INTERVAL_MS', 2000, 500),
    HEALTH_POLL_MS: intEnv('HEALTH_POLL_MS', 2000, 500),
    // Accept either `TAILSCALE_AUTH_KEY` (more readable) or `TS_AUTHKEY`
    // (shorter, matches Tailscale CLI flag name). First one set wins.
    TS_AUTHKEY: process.env.TAILSCALE_AUTH_KEY ?? process.env.TS_AUTHKEY ?? null,
  };
  if (cfg.VM_POOL_WARM > cfg.VM_POOL_MAX) {
    warn(`VM_POOL_WARM (${cfg.VM_POOL_WARM}) > VM_POOL_MAX (${cfg.VM_POOL_MAX}); clamping`);
    cfg.VM_POOL_WARM = cfg.VM_POOL_MAX;
  }
  return cfg;
}

function deriveWsUrl(httpBase: string): string {
  // The host-agent inside the VM dials the controller via WS. The base URL
  // we have is HTTP; convert scheme and append the host endpoint path.
  const u = new URL(httpBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/host';
  return u.toString();
}

async function main(): Promise<void> {
  const env = loadEnv();
  log(
    `starting (warm=${env.VM_POOL_WARM}, max=${env.VM_POOL_MAX}, ` +
      `mem=${env.VM_MEMORY_MB}MB, cpu=${env.VM_CPU_COUNT}, ` +
      `golden=${env.VM_MANAGER_GOLDEN})`,
  );
  if (!env.TS_AUTHKEY) {
    warn('TS_AUTHKEY not set — spawned VMs will not auto-join Tailscale');
  }

  try {
    mkdirSync(env.VM_BOOTSTRAP_DIR, { recursive: true, mode: 0o750 });
  } catch (e) {
    warn(`bootstrap dir ${env.VM_BOOTSTRAP_DIR}: ${(e as Error).message}`);
  }

  const watch = new ControllerWatch(env.CONTROLLER_BASE_URL, env.HEALTH_POLL_MS);

  const controllerWsUrl = deriveWsUrl(env.CONTROLLER_BASE_URL);
  const poolCfg: PoolConfig = {
    goldenImage: env.VM_MANAGER_GOLDEN,
    namePrefix: env.VM_NAME_PREFIX,
    targetWarm: env.VM_POOL_WARM,
    maxTotal: env.VM_POOL_MAX,
    memoryMB: env.VM_MEMORY_MB,
    cpu: env.VM_CPU_COUNT,
    bootstrapDir: env.VM_BOOTSTRAP_DIR,
    envFileContents: (vmName) =>
      [
        `CONTROLLER_URL=${controllerWsUrl}`,
        `HOST_TOKEN=${env.CONTROLLER_HOST_TOKEN}`,
        `HOST_ID=vm-${vmName}`,
        `HOST_SLOTS=1`,
        `HOST_KIND=vm`,
        `SIM_CAPTURE_MODE=framebuffer`,
        '',
      ].join('\n'),
    tailscaleAuthKey: env.TS_AUTHKEY,
    watchdogMs: env.WATCHDOG_MS,
    reconcileIntervalMs: env.RECONCILE_INTERVAL_MS,
  };

  const pool = new Pool(poolCfg, watch);
  pool.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log(`received ${signal}, tearing down pool…`);
    await pool.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((e: unknown) => {
  warn(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
