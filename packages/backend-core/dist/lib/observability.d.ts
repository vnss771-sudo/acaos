export type ErrorContext = Record<string, unknown>;
export type ErrorReporter = (err: unknown, context?: ErrorContext) => void;
/** Register (or clear, with null) the process-wide error transport. */
export declare function setErrorReporter(fn: ErrorReporter | null): void;
/** True when a transport is registered — useful for conditional enrichment. */
export declare function hasErrorReporter(): boolean;
export declare function captureError(err: unknown, context?: ErrorContext): void;
