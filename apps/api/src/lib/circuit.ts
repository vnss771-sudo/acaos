// Simple circuit breaker for external service calls (OpenAI, Stripe, Apollo).
// CLOSED → normal operation. After `threshold` consecutive failures, trips OPEN.
// After `resetAfterMs` of silence, probes with HALF_OPEN. Success → CLOSED.

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitBreaker {
  private failures = 0
  private lastFailureAt = 0
  private state: State = 'CLOSED'

  constructor(
    private readonly label: string,
    private readonly threshold = 5,
    private readonly resetAfterMs = 30_000
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureAt >= this.resetAfterMs) {
        this.state = 'HALF_OPEN'
        console.warn(`[circuit:${this.label}] probing after ${this.resetAfterMs / 1000}s`)
      } else {
        throw new Error(`${this.label} temporarily unavailable — circuit open`)
      }
    }

    try {
      const result = await fn()
      if (this.state !== 'CLOSED') {
        console.log(`[circuit:${this.label}] recovered`)
        this.failures = 0
        this.state = 'CLOSED'
      }
      return result
    } catch (err) {
      this.failures++
      this.lastFailureAt = Date.now()
      if (this.failures >= this.threshold) {
        console.error(`[circuit:${this.label}] OPEN after ${this.failures} failures`)
        this.state = 'OPEN'
      }
      throw err
    }
  }

  get isOpen() { return this.state === 'OPEN' }
  get status() { return this.state }
}

// Singleton breakers — shared across requests in the same process
export const openAiBreaker = new CircuitBreaker('openai', 5, 30_000)
export const apolloBreaker  = new CircuitBreaker('apollo',  5, 60_000)
export const stripeBreaker  = new CircuitBreaker('stripe',  5, 30_000)
