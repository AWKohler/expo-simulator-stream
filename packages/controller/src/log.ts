const PREFIX = '[controller]';
export const log = (...a: unknown[]): void => console.log(PREFIX, ...a);
export const warn = (...a: unknown[]): void => console.warn(PREFIX, ...a);
export const err = (...a: unknown[]): void => console.error(PREFIX, ...a);
