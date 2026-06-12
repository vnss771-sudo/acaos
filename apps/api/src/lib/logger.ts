// Minimal structured (JSON-lines) logger. Dependency-free: emits one JSON
// object per line to stdout/stderr so logs are machine-parseable and can carry
// a request id for correlation, without pulling in a logging framework.

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info
}

export type LogFields = Record<string, unknown>

function emit(level: Level, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < threshold()) return
  const record = { level, time: new Date().toISOString(), msg, ...fields }
  const line = JSON.stringify(record, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v))
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
  /** Returns a logger that includes `base` fields on every line (e.g. a request id). */
  child(base: LogFields) {
    return {
      debug: (msg: string, fields?: LogFields) => emit('debug', msg, { ...base, ...fields }),
      info: (msg: string, fields?: LogFields) => emit('info', msg, { ...base, ...fields }),
      warn: (msg: string, fields?: LogFields) => emit('warn', msg, { ...base, ...fields }),
      error: (msg: string, fields?: LogFields) => emit('error', msg, { ...base, ...fields }),
    }
  },
}
