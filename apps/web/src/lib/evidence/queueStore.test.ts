import { describe, it, expect } from 'vitest'
import { MemoryQueueStore } from './queueStore'
import { runQueueStoreContract } from './queueStoreContract'

describe('MemoryQueueStore', () => {
  it('satisfies the queue store contract', async () => {
    await runQueueStoreContract(async () => new MemoryQueueStore())
  })
  it('returns copies, so callers cannot mutate stored records', async () => {
    const s = new MemoryQueueStore()
    const { item } = await import('./queueStoreContract')
    const scope = { userId: 'u', workspaceId: 'w' }
    await s.add(scope, item(scope, 'x'), { limits: { maxQueueItems: 5, maxQueueBytes: 1e6 } })
    const got = (await s.get(scope, 'x'))!
    got.state = 'done'
    expect((await s.get(scope, 'x'))!.state).toBe('queued')
  })
})
