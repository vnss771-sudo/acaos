// Simple circuit breaker for external service calls (OpenAI, Stripe, Apollo).
// CLOSED → normal operation. After `threshold` consecutive failures, trips OPEN.
// After `resetAfterMs` of silence, probes with HALF_OPEN. Success → CLOSED.
export class CircuitOpenError extends Error {
    constructor(label, retryAfterMs) {
        super(`${label} temporarily unavailable — circuit open`);
        this.retryAfterMs = retryAfterMs;
        this.name = 'CircuitOpenError';
    }
}
export class CircuitBreaker {
    constructor(label, threshold = 5, resetAfterMs = 30000) {
        this.label = label;
        this.threshold = threshold;
        this.resetAfterMs = resetAfterMs;
        this.failures = 0;
        this.lastFailureAt = 0;
        this.state = 'CLOSED';
    }
    async call(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureAt >= this.resetAfterMs) {
                this.state = 'HALF_OPEN';
                console.warn(`[circuit:${this.label}] probing after ${this.resetAfterMs / 1000}s`);
            }
            else {
                throw new CircuitOpenError(this.label, this.resetAfterMs);
            }
        }
        try {
            const result = await fn();
            if (this.state !== 'CLOSED') {
                console.log(`[circuit:${this.label}] recovered`);
                this.failures = 0;
                this.state = 'CLOSED';
            }
            return result;
        }
        catch (err) {
            this.failures++;
            this.lastFailureAt = Date.now();
            if (this.failures >= this.threshold) {
                console.error(`[circuit:${this.label}] OPEN after ${this.failures} failures`);
                this.state = 'OPEN';
            }
            throw err;
        }
    }
    get isOpen() { return this.state === 'OPEN'; }
    get status() { return this.state; }
}
// Singleton breakers — shared across requests in the same process
export const openAiBreaker = new CircuitBreaker('openai', 5, 30000);
export const apolloBreaker = new CircuitBreaker('apollo-enrich', 5, 60000);
export const apolloSearchBreaker = new CircuitBreaker('apollo-search', 5, 60000);
export const stripeBreaker = new CircuitBreaker('stripe', 5, 30000);
