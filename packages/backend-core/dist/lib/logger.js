// Minimal structured (JSON-lines) logger. Dependency-free: emits one JSON
// object per line to stdout/stderr so logs are machine-parseable and can carry
// a request id for correlation, without pulling in a logging framework.
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
function threshold() {
    const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}
function emit(level, msg, fields) {
    if (LEVEL_ORDER[level] < threshold())
        return;
    const record = { level, time: new Date().toISOString(), msg, ...fields };
    const line = JSON.stringify(record, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
    if (level === 'error')
        process.stderr.write(line + '\n');
    else
        process.stdout.write(line + '\n');
}
export const logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** Returns a logger that includes `base` fields on every line (e.g. a request id). */
    child(base) {
        return {
            debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
            info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
            warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
            error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
        };
    },
};
