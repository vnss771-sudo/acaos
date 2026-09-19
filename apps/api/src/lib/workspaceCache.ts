// Workspace-level caching for frequently accessed read-only data. Phase 4.1 ensures
// multi-tenant isolation while improving performance by reducing redundant DB queries.
// Cached data: workspace config (plan, subscription), member roster, feature flags.
//
// Cache invalidation:
// - Membership changes: invalidate member cache
// - Subscription changes: invalidate plan cache
// - Feature flag changes: invalidate flags cache
// Uses Redis with in-memory fallback when Redis is unavailable.

import { getRedis } from './redis.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import type { Membership, Workspace } from '@prisma/client'

interface WorkspaceConfig {
  id: string
  plan: string
  subscriptionStatus: string | null
  featureFlags: Record<string, boolean>
}

// Per-pod in-memory cache with TTL (5 minutes). Falls back here when Redis is unavailable.
interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const localCache = new Map<string, CacheEntry<unknown>>()
const CACHE_TTL_MS = 5 * 60 * 1000

// Prune expired entries from local cache every 2 minutes
const pruneCacheTimer = setInterval(() => {
  const now = Date.now()
  let pruned = 0
  for (const [key, entry] of localCache) {
    if (entry.expiresAt <= now) {
      localCache.delete(key)
      pruned++
    }
  }
  if (pruned > 0) {
    logger.debug('workspace cache pruned', { entries: pruned })
  }
}, 2 * 60 * 1000)
if (pruneCacheTimer.unref) pruneCacheTimer.unref()

/**
 * Get workspace configuration (plan, subscription, flags) with caching.
 * Cached for 5 minutes; updates visible after TTL or cache invalidation.
 */
export async function getWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig> {
  const cacheKey = `ws_config:${workspaceId}`

  // Check local cache first
  const cached = localCache.get(cacheKey) as CacheEntry<WorkspaceConfig> | undefined
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  // Try Redis
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      const stored = await redis.get(cacheKey)
      if (stored) {
        const config = JSON.parse(stored) as WorkspaceConfig
        // Refresh local cache
        localCache.set(cacheKey, { data: config, expiresAt: Date.now() + CACHE_TTL_MS })
        return config
      }
    }
  } catch (err) {
    logger.warn('workspace config cache redis fetch failed', { workspaceId, error: (err as Error).message })
  }

  // Cache miss — fetch from DB
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, plan: true, subscriptionStatus: true },
  })

  if (!ws) {
    throw new Error(`Workspace ${workspaceId} not found`)
  }

  const config: WorkspaceConfig = {
    id: ws.id,
    plan: ws.plan || 'free',
    subscriptionStatus: ws.subscriptionStatus,
    featureFlags: {
      // Feature flags would be added per-workspace as needed; placeholder for future
      premiumScoring: (ws.plan === 'growth' || ws.plan === 'starter'),
      aiGeneration: ws.plan !== 'free',
    },
  }

  // Store in both caches
  localCache.set(cacheKey, { data: config, expiresAt: Date.now() + CACHE_TTL_MS })
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      await redis.setex(cacheKey, Math.ceil(CACHE_TTL_MS / 1000), JSON.stringify(config))
    }
  } catch (err) {
    logger.warn('workspace config cache redis store failed', { workspaceId, error: (err as Error).message })
  }

  return config
}

/**
 * Get workspace member roster with caching (frequently accessed for auth/permission checks).
 * Returns members' IDs and roles. Cached for 5 minutes.
 */
export async function getWorkspaceMembers(workspaceId: string): Promise<Membership[]> {
  const cacheKey = `ws_members:${workspaceId}`

  // Check local cache
  const cached = localCache.get(cacheKey) as CacheEntry<Membership[]> | undefined
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }

  // Try Redis
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      const stored = await redis.get(cacheKey)
      if (stored) {
        const members = JSON.parse(stored) as Membership[]
        localCache.set(cacheKey, { data: members, expiresAt: Date.now() + CACHE_TTL_MS })
        return members
      }
    }
  } catch (err) {
    logger.warn('workspace members cache redis fetch failed', { workspaceId, error: (err as Error).message })
  }

  // Cache miss — fetch from DB
  const members = await prisma.membership.findMany({
    where: { workspaceId },
    select: { id: true, userId: true, workspaceId: true, role: true, createdAt: true },
  })

  // Store in caches
  localCache.set(cacheKey, { data: members, expiresAt: Date.now() + CACHE_TTL_MS })
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      await redis.setex(cacheKey, Math.ceil(CACHE_TTL_MS / 1000), JSON.stringify(members))
    }
  } catch (err) {
    logger.warn('workspace members cache redis store failed', { workspaceId, error: (err as Error).message })
  }

  return members
}

/**
 * Invalidate cached data when workspace changes occur (e.g., plan upgrade, subscription change).
 * Called by workspace mutation handlers.
 */
export async function invalidateWorkspaceConfig(workspaceId: string): Promise<void> {
  const cacheKey = `ws_config:${workspaceId}`
  localCache.delete(cacheKey)
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      await redis.del(cacheKey)
    }
  } catch (err) {
    logger.warn('workspace config cache invalidation failed', { workspaceId, error: (err as Error).message })
  }
}

/**
 * Invalidate member roster when workspace membership changes.
 * Called when a user is added/removed/promoted in a workspace.
 */
export async function invalidateWorkspaceMembers(workspaceId: string): Promise<void> {
  const cacheKey = `ws_members:${workspaceId}`
  localCache.delete(cacheKey)
  try {
    const redis = getRedis()
    if (redis.status === 'ready') {
      await redis.del(cacheKey)
    }
  } catch (err) {
    logger.warn('workspace members cache invalidation failed', { workspaceId, error: (err as Error).message })
  }
}

/**
 * Health check for workspace caching layer. Returns cache hit rate.
 */
export function getWorkspaceCacheStats(): { localSize: number; hitRate: number } {
  return {
    localSize: localCache.size,
    hitRate: 0, // Real hit rate would require instrumentation at each call site
  }
}
