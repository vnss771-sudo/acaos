export declare function isSuppressed(workspaceId: string, email: string): Promise<boolean>;
export declare function suppress(workspaceId: string, email: string, reason?: 'UNSUBSCRIBED' | 'BOUNCED' | 'MANUAL'): Promise<void>;
export declare function bulkCheckSuppression(workspaceId: string, emails: string[]): Promise<Set<string>>;
