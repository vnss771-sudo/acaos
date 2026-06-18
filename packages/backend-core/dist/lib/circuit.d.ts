type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export declare class CircuitOpenError extends Error {
    readonly retryAfterMs: number;
    constructor(label: string, retryAfterMs: number);
}
export declare class CircuitBreaker {
    private readonly label;
    private readonly threshold;
    private readonly resetAfterMs;
    private failures;
    private lastFailureAt;
    private state;
    constructor(label: string, threshold?: number, resetAfterMs?: number);
    call<T>(fn: () => Promise<T>): Promise<T>;
    get isOpen(): boolean;
    get status(): State;
}
export declare const openAiBreaker: CircuitBreaker;
export declare const apolloBreaker: CircuitBreaker;
export declare const apolloSearchBreaker: CircuitBreaker;
export declare const stripeBreaker: CircuitBreaker;
export {};
