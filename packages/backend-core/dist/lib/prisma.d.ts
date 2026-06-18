import { PrismaClient } from '@prisma/client';
declare global {
    var __acaosPrisma__: PrismaClient | undefined;
}
export declare const prisma: PrismaClient<import(".prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
