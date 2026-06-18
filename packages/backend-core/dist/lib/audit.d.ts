export type AuditInput = {
    workspaceId?: string | null;
    actorUserId?: string | null;
    type: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
};
export declare function recordAudit(e: AuditInput): Promise<void>;
