export namespace Prisma {
  export type JsonPrimitive = string | number | boolean | null
  export type InputJsonValue = JsonPrimitive | { [key: string]: InputJsonValue } | InputJsonValue[]
  export interface TransactionClient {
    [key: string]: any
  }
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
