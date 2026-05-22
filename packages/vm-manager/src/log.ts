// Minimal logger; matches the style of @sim/controller and @sim/host-agent so
// piped output looks consistent across services.

const stamp = (): string => new Date().toISOString().slice(11, 23);

export function log(...args: unknown[]): void {
  console.log(`[vm-manager ${stamp()}]`, ...args);
}
export function warn(...args: unknown[]): void {
  console.warn(`[vm-manager ${stamp()} WARN]`, ...args);
}
export function err(...args: unknown[]): void {
  console.error(`[vm-manager ${stamp()} ERR ]`, ...args);
}
