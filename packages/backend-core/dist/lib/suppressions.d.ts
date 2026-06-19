export declare function isSuppressed(workspaceId: string, email: string): Promise<boolean>;
export declare function suppress(workspaceId: string, email: string, reason?: 'UNSUBSCRIBED' | 'BOUNCED' | 'MANUAL'): Promise<void>;
/**
 * Resolve which of `emails` are suppressed for a workspace and return a predicate
 * that normalizes its argument before checking. Returning a predicate (rather than
 * a raw Set of already-normalized addresses) removes a footgun: callers used to be
 * able to do `set.has(rawMixedCaseEmail)` and get a false negative, sending to a
 * suppressed address. Now the normalization lives on both sides of the comparison.
 */
export declare function bulkCheckSuppression(workspaceId: string, emails: string[]): Promise<(email: string) => boolean>;
