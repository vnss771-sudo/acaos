export declare function isProduction(): boolean;
/**
 * Whether internal error details may be returned to clients. Opaque by default
 * — only the explicit `development` environment is verbose, so a misconfigured
 * staging deploy never leaks stack-adjacent error text.
 */
export declare function verboseErrors(): boolean;
/**
 * Exact CORS origin allowlist. Driven by `ALLOWED_ORIGINS` (comma-separated),
 * falling back to `WEB_URL`. Provider wildcards (e.g. any *.vercel.app) are
 * intentionally NOT honored — they trust every tenant on a shared platform.
 */
export declare function getAllowedOrigins(): string[];
export declare function isOriginAllowed(origin: string | undefined): boolean;
/**
 * Validate configuration at process start. Throws a single aggregated error
 * listing every problem so a misconfigured deploy fails immediately and loudly.
 */
export declare function validateConfig(): void;
/** Returns a structured readiness report for /api/ready. */
export declare function getReadinessReport(): {
    ready: boolean;
    missing: string[];
    features: {
        feature: string;
        configured: boolean;
    }[];
};
