import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PhotosWaitingBanner } from './PhotosWaitingBanner.js'
import { ForeignPhotosNotice } from './ForeignPhotosNotice.js'
import { SignedOutPhotosNotice, SIGNED_OUT_PHOTOS_TEXT } from './SignedOutPhotosNotice.js'
import { Harness, Backend, wait } from './testHarness.js'
import { MemoryQueueStore, type Scope } from '../../lib/evidence/queueStore.js'
import { item } from '../../lib/evidence/queueStoreContract.js'

const A1: Scope = { userId: 'user-a', workspaceId: 'ws-1' }
const A2: Scope = { userId: 'user-a', workspaceId: 'ws-2' }
const B1: Scope = { userId: 'user-b', workspaceId: 'ws-1' }
const LIM = { maxQueueItems: 30, maxQueueBytes: 1e9 }
const seed = (store: MemoryQueueStore, scope: Scope, id: string, over = {}) =>
  store.add(scope, item(scope, id, { sha256: id.padEnd(64, '0'), ...over }), { limits: LIM })
const offline = () => { const b = new Backend(); b.online = false; return b }
const view = (backend: Backend, store: MemoryQueueStore, user = { id: 'user-a' }) =>
  render(<Harness backend={backend} store={store} user={user}><PhotosWaitingBanner /><ForeignPhotosNotice /></Harness>)

describe('photos waiting banner (signed in)', () => {
  it('shows nothing when no photos are waiting', async () => {
    view(new Backend(), new MemoryQueueStore())
    await wait(40)
    expect(screen.queryByTestId('photos-waiting-banner')).toBeNull()
  })

  it('counts this user\'s photos across all their workspaces, and says the other-workspace ones wait', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1'); await seed(store, A1, 'a2'); await seed(store, A2, 'a3')
    view(offline(), store)
    const b = await screen.findByTestId('photos-waiting-banner')
    expect(b).toHaveTextContent('3 photos saved on this phone are waiting to upload.')
    expect(b).toHaveTextContent('Waiting for a connection')
    expect(b).toHaveTextContent('1 of them is in another workspace and upload when you switch back.')
  })

  it('singular wording', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1')
    view(offline(), store)
    expect(await screen.findByTestId('photos-waiting-banner')).toHaveTextContent('1 photo saved on this phone is waiting to upload.')
  })

  it('PRIVACY: another account\'s photos are never counted in this account\'s banner', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1')
    await seed(store, B1, 'b1'); await seed(store, B1, 'b2'); await seed(store, B1, 'b3')
    view(offline(), store, { id: 'user-b' })
    const b = await screen.findByTestId('photos-waiting-banner')
    expect(b).toHaveTextContent('3 photos')
    expect(b).not.toHaveTextContent('4 photos')
    // and signing in as a user with nothing of their own shows no own-banner at all
  })

  it('PRIVACY: an account with no photos of its own gets no banner, only the existing count-only foreign notice', async () => {
    const store = new MemoryQueueStore()
    await seed(store, B1, 'b1')
    view(offline(), store, { id: 'user-c' })
    await screen.findByText(/from a different account/)
    expect(screen.queryByTestId('photos-waiting-banner')).toBeNull()
  })

  it('does not count finished, rejected-without-photo or photo-less items', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'd', { state: 'done', blob: null })
    await seed(store, A1, 'r', { state: 'rejected', blob: null })
    view(offline(), store)
    await wait(40)
    expect(screen.queryByTestId('photos-waiting-banner')).toBeNull()
  })

  it('shows the attention state for failed photos, with no action buttons', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1', { state: 'failed', errorCode: 'x' }); await seed(store, A1, 'a2', { state: 'failed' }); await seed(store, A1, 'a3')
    view(offline(), store)
    const b = await screen.findByTestId('photos-waiting-banner')
    await waitFor(() => expect(b).toHaveTextContent('2 need attention'))
    expect(b.querySelectorAll('button, a')).toHaveLength(0)
  })

  it('shows uploading while the engine is sending, then disappears when everything is sent', async () => {
    const store = new MemoryQueueStore(), backend = new Backend()
    await seed(store, A1, 'a1')
    view(backend, store)
    await waitFor(async () => expect((await store.get(A1, 'a1'))?.state).toBe('done'))
    await waitFor(() => expect(screen.queryByTestId('photos-waiting-banner')).toBeNull())
  })

  it('reopening offline (no job list needed) still shows the banner', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1')
    const backend = offline()
    view(backend, store)
    expect(await screen.findByTestId('photos-waiting-banner')).toHaveTextContent('Waiting for a connection')
    expect(backend.calls).toHaveLength(0)
  })

  it('unreadable local storage shows no banner and does not throw', async () => {
    const store = new MemoryQueueStore()
    store.summary = async () => { throw new Error('db closed') }
    view(offline(), store)
    await wait(40)
    expect(screen.queryByTestId('photos-waiting-banner')).toBeNull()
  })
})

describe('signed-out generic notice', () => {
  it('shows only the generic line when photos exist: no digits, no account or workspace hints', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1'); await seed(store, A2, 'a2'); await seed(store, B1, 'b1')
    const { container } = render(<SignedOutPhotosNotice store={store} />)
    const n = await screen.findByTestId('photos-signed-out-notice')
    expect(n).toHaveTextContent(SIGNED_OUT_PHOTOS_TEXT)
    expect(container.textContent).toBe(SIGNED_OUT_PHOTOS_TEXT)
    expect(container.textContent).not.toMatch(/\d|user-|ws-|Acme/)
    expect(container.querySelectorAll('button, a')).toHaveLength(0)
  })

  it('shows nothing when the queue is empty, holds only finished items, or storage is unreadable', async () => {
    const empty = new MemoryQueueStore()
    const done = new MemoryQueueStore(); await seed(done, A1, 'd', { state: 'done', blob: null })
    const broken = new MemoryQueueStore(); broken.summary = async () => { throw new Error('x') }
    for (const s of [empty, done, broken]) {
      const { unmount } = render(<SignedOutPhotosNotice store={s} />)
      await wait(30)
      expect(screen.queryByTestId('photos-signed-out-notice')).toBeNull()
      unmount()
    }
  })

  it('makes no network calls and does not start an engine', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'a1')
    render(<SignedOutPhotosNotice store={store} />)
    await screen.findByTestId('photos-signed-out-notice')
    expect(store.data.get('user-a\u0000ws-1')?.get('a1')?.state).toBe('queued')
  })
})
