// Tiny leveled logger with timestamps. Keeps provider errors visible without
// crashing the process.

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function fmt(color: string, tag: string, args: unknown[]): unknown[] {
  return [`${COLORS.dim}${ts()}${COLORS.reset} ${color}${tag}${COLORS.reset}`, ...args];
}

export const log = {
  info(...args: unknown[]): void {
    console.log(...fmt(COLORS.green, "info ", args));
  },
  warn(...args: unknown[]): void {
    console.warn(...fmt(COLORS.yellow, "warn ", args));
  },
  error(...args: unknown[]): void {
    console.error(...fmt(COLORS.red, "error", args));
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG) console.log(...fmt(COLORS.cyan, "debug", args));
  },
  pipe(...args: unknown[]): void {
    if (process.env.DEBUG) console.log(...fmt(COLORS.magenta, "pipe ", args));
  },
};

/** Convert an unknown thrown value into a readable message. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
