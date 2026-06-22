export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Minimal timestamped console logger. Kept dependency-free on purpose — a relay
 * should be trivial to audit and to run on a small box.
 */
export function createLogger(): Logger {
  const ts = (): string => new Date().toISOString();
  return {
    info: (m) => console.log(`${ts()} INFO  ${m}`),
    warn: (m) => console.warn(`${ts()} WARN  ${m}`),
    error: (m) => console.error(`${ts()} ERROR ${m}`),
  };
}
