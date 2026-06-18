export type JwtPayload = {
    userId: string;
};
export declare function getJwtSecret(): string;
export declare function signJwt(payload: JwtPayload): string;
export declare function verifyJwt(token: string): JwtPayload;
export declare function generateRefreshToken(): string;
export declare function hashRefreshToken(token: string): string;
export declare function refreshTokenExpiresAt(): Date;
