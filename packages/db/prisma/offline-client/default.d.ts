export namespace Prisma {
  export type JsonPrimitive = string | number | boolean | null
  export type InputJsonValue = JsonPrimitive | { [key: string]: InputJsonValue } | InputJsonValue[]
  export interface TransactionClient {
    [key: string]: any
  }
  // Permissive model input/args aliases. The real generated client emits a precise
  // type per model+operation; the offline stub only needs the names to exist so
  // tsc resolves `Prisma.<Model><Op>` references during the offline/forward-compat
  // builds. Add an entry here when code references a new `Prisma.*` member.
  export type ContactEventCreateInput = Record<string, unknown>
  export type CampaignDailyStatsCreateInput = Record<string, unknown>
  export type CampaignDailyStatsUpdateInput = Record<string, unknown>
  export type CampaignDailyStatsUpsertArgs = Record<string, unknown>
  export type FollowupTaskUpdateInput = Record<string, unknown>
  export const OfflineStub: true
  export function defineExtension<T>(extension: T): T
  export function getExtensionContext(): never
}

export class PrismaClient {
  [key: string]: any
  constructor(...args: any[])
  $connect(): Promise<void>
  $disconnect(): Promise<void>
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T> | T): Promise<T>
  $transaction<T extends readonly unknown[]>(operations: T): Promise<T>
  $queryRaw(...args: any[]): Promise<never>
  $executeRaw(...args: any[]): Promise<never>
  $on(...args: any[]): void
  $use(...args: any[]): void
}

export default PrismaClient
