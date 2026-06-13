// Money is stored as integer cents in the database (avoids floating-point drift
// in pipeline/forecast sums) but exchanged as whole-unit amounts ("dollars") at
// the API boundary, so the client contract is unchanged. Convert at the edges.

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100)
}

export function centsToDollars(cents: number | null | undefined): number | null {
  return cents == null ? null : cents / 100
}
