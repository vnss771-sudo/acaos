import type { Prisma } from '@prisma/client';
export type UsageAction = 'AI_RESEARCH' | 'AI_OUTREACH' | 'AI_REPLY';
declare const PLAN_LIMITS: {
    readonly free: {
        readonly aiCallsPerMonth: 15;
        readonly maxLeads: 500;
        readonly discoveriesPerMonth: 25;
    };
    readonly starter: {
        readonly aiCallsPerMonth: 300;
        readonly maxLeads: 10000;
        readonly discoveriesPerMonth: 500;
    };
    readonly growth: {
        readonly aiCallsPerMonth: number;
        readonly maxLeads: number;
        readonly discoveriesPerMonth: number;
    };
};
type Plan = keyof typeof PLAN_LIMITS;
export declare function checkAndIncrementAiUsage(workspaceId: string, action: UsageAction): Promise<void>;
export declare function checkAndIncrementDiscoveryUsage(workspaceId: string): Promise<void>;
export declare function checkLeadLimit(workspaceId: string): Promise<void>;
/**
 * Atomically determine how many of `requested` new leads a workspace may create
 * without exceeding its plan cap. MUST be called inside an interactive
 * transaction; it takes a per-workspace advisory lock so concurrent batch
 * imports cannot each pass an independent check and collectively overshoot the
 * limit. Returns the number permitted (clamped to 0..requested); unlimited plans
 * pass `requested` straight through. The caller inserts exactly the returned
 * count within the same transaction so the count-then-insert stays atomic.
 */
export declare function reserveLeadCapacity(tx: Prisma.TransactionClient, workspaceId: string, requested: number): Promise<number>;
export declare function getMonthlyUsage(workspaceId: string): Promise<{
    month: string;
    totals: Record<UsageAction, number>;
    total: number;
    limit: number;
    plan: Plan;
    discovery: {
        used: number;
        limit: number;
    };
    leads: {
        used: number;
        limit: number;
    };
}>;
export declare function getPlanInfo(plan: string): {
    plan: "free" | "starter" | "growth";
    aiCallsPerMonth: 15;
    maxLeads: 500;
    discoveriesPerMonth: 25;
} | {
    plan: "free" | "starter" | "growth";
    aiCallsPerMonth: 300;
    maxLeads: 10000;
    discoveriesPerMonth: 500;
} | {
    plan: "free" | "starter" | "growth";
    aiCallsPerMonth: number;
    maxLeads: number;
    discoveriesPerMonth: number;
};
export {};
