/** Tiny structured logger. Timestamped, level-prefixed lines on stdout/stderr. */

const ts = () => new Date().toISOString();

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${ts()} INFO  ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${ts()} WARN  ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${ts()} ERROR ${msg}`, ...rest),
  step: (msg: string) => console.log(`\n${ts()} ━━ ${msg}`),
};
