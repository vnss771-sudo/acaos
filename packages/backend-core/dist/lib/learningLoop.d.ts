type Outcome = {
    stage: 'WON' | 'LOST';
    prospect: {
        industry: string | null;
        employeeCount: number | null;
        signals: Array<{
            type: string;
        }>;
    };
};
type CalibrateStats = {
    calibrated: boolean;
    reason?: string;
    totalOutcomes: number;
    baselineWinRate: number;
};
export type CalibrateResult = {
    stats: CalibrateStats;
    signalWeights: Record<string, number>;
    icpUpdate: {
        targetIndustries?: string[];
        minEmployees?: number;
        maxEmployees?: number;
    };
};
export declare function calibrate(outcomes: Outcome[]): CalibrateResult;
export {};
