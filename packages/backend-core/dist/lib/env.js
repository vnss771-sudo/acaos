export function requireEnv(keys) {
    const missing = keys.filter((key) => !process.env[key]?.trim());
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}
export function hasEnv(keys) {
    return keys.every((key) => Boolean(process.env[key]?.trim()));
}
