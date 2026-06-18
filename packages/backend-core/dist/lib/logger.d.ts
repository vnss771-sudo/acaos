export type LogFields = Record<string, unknown>;
export declare const logger: {
    debug: (msg: string, fields?: LogFields) => void;
    info: (msg: string, fields?: LogFields) => void;
    warn: (msg: string, fields?: LogFields) => void;
    error: (msg: string, fields?: LogFields) => void;
    /** Returns a logger that includes `base` fields on every line (e.g. a request id). */
    child(base: LogFields): {
        debug: (msg: string, fields?: LogFields) => void;
        info: (msg: string, fields?: LogFields) => void;
        warn: (msg: string, fields?: LogFields) => void;
        error: (msg: string, fields?: LogFields) => void;
    };
};
