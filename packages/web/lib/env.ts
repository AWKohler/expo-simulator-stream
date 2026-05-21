// Client-side env helpers. NEXT_PUBLIC_WS_BASE points to where the Controller
// is reachable for WebSocket upgrades. Falls back to the page origin (assuming
// the Controller is reverse-proxied or the rewrites in next.config.ts handle it).

export function getWSBase(): string {
  if (typeof window === 'undefined') return '';
  const explicit = process.env.NEXT_PUBLIC_WS_BASE;
  if (explicit) return explicit;
  // For local dev: Next runs on :3000, Controller on :8080 — point WS straight at the controller.
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'ws://127.0.0.1:8080';
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}
