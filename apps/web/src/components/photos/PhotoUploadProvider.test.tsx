import React, { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PhotoUploadProvider, usePhotoUploads, type PhotoGuards } from './PhotoUploadProvider.js'
import { ForeignPhotosNotice } from './ForeignPhotosNotice.js'
import { PhotosTab } from './PhotosTab.js'
import { Harness, Backend, OK, wait, fakeApiHook } from './testHarness.js'
import { MemoryQueueStore, type Scope } from '../../lib/evidence/queueStore.js'
import { item } from '../../lib/evidence/queueStoreContract.js'

const A1: Scope = { userId: 'user-a', workspaceId: 'ws-1' }
const A2: Scope = { userId: 'user-a', workspaceId: 'ws-2' }
const B1: Scope = { userId: 'user-b', workspaceId: 'ws-1' }
const LIM = { maxQueueItems: 30, maxQueueBytes: 1e9 }
const seed = async (store: MemoryQueueStore, scope: Scope, id: string, over = {}) =>
  store.add(scope, item(scope, id, { sizeBytes: 3 * 1024 * 1024, sha256: id.padEnd(64, '0'), ...over }), { limits: LIM })
const jpegFile = (name = 'IMG.jpg') => new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], name, { type: 'image/jpeg' })

/** A tiny page that exposes the guards the way App does. */
function Page({ guards }: { guards: React.MutableRefObject<PhotoGuards | null> }) {
  return (
    <div>
      <button onClick={() => guards.current?.guardLogout(onLogout)}>sign out</button>
      <button onClick={() => guards.current?.guardWorkspaceSwitch(onSwitch)}>switch</button>
      <ForeignPhotosNotice />
    </div>
  )
}
const onLogout = vi.fn()
const onSwitch = vi.fn()

function Guarded(props: { backend: Backend; store: MemoryQueueStore; user?: { id: string } | null; workspaceId?: string; children?: React.ReactNode }) {
  const guards = useRef<PhotoGuards | null>(null)
  return (
    <Harness backend={props.backend} store={props.store} user={props.user} workspaceId={props.workspaceId} guardsRef={guards}>
      <Page guards={guards} />
      {props.children}
    </Harness>
  )
}

beforeEach(() => { onLogout.mockReset(); onSwitch.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe('engine lifecycle', () => {
  it('does nothing until photos are wanted: no engine, no network', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    render(<Harness backend={backend} store={store}><div>app</div></Harness>)
    await wait(40)
    expect(backend.calls).toHaveLength(0)
  })

  it('resumes photos already waiting on this phone as soon as the app loads (after a reload)', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    await seed(store, A1, 'left-over')
    render(<Harness backend={backend} store={store}><div>app</div></Harness>)
    await waitFor(() => expect(backend.count('init')).toBe(1))
    await waitFor(async () => expect((await store.get(A1, 'left-over'))?.state).toBe('done'))
    expect(backend.bySubmission.has('left-over')).toBe(true)
  })

  it('uploads keep going when the Photos tab is closed or the person navigates elsewhere', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    let release!: () => void
    backend.putQueue = [() => new Promise((r) => { release = () => r(OK) })]
    function Shell() {
      const [view, setView] = React.useState<'photos' | 'other'>('photos')
      return <div><button onClick={() => setView(view === 'photos' ? 'other' : 'photos')}>toggle</button>{view === 'photos' ? <PhotosTab jobId="job-1" /> : <div>other screen</div>}</div>
    }
    render(<Harness backend={backend} store={store}><Shell /></Harness>)
    fireEvent.change(screen.getByTestId('photo-camera-input'), { target: { files: [jpegFile()] } })
    await screen.findByRole('progressbar')
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }))        // navigate away mid-upload
    expect(screen.getByText('other screen')).toBeInTheDocument()
    release()
    await waitFor(async () => expect((await store.list(A1))[0]?.state).toBe('done'))
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }))        // come back: the finished photo is listed
    expect(await screen.findByText('Uploaded')).toBeInTheDocument()
    expect(backend.files.size).toBe(1)
  })

  it('stops (without deleting anything) when the user signs out, and never runs while signed out', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    await seed(store, A1, 'p1')
    backend.online = false
    const { rerender } = render(<Harness backend={backend} store={store}><div>app</div></Harness>)
    await wait(20)
    rerender(<Harness backend={backend} store={store} user={null}><div>app</div></Harness>)
    backend.online = true
    await wait(60)
    expect(backend.calls).toHaveLength(0)
    expect((await store.get(A1, 'p1'))?.state).toBe('queued')
  })

  it('does not start an engine just because another account or workspace has photos waiting', async () => {
    const store = new MemoryQueueStore()
    await seed(store, B1, 'someone-elses'); await seed(store, A2, 'other-workspace')
    const make = vi.fn(() => { throw new Error('no engine expected') })
    render(
      <PhotoUploadProvider user={{ id: 'user-a' }} workspaceId="ws-1" api={fakeApiHook} store={store} makeEngine={make as never}>
        <div>app</div>
      </PhotoUploadProvider>,
    )
    await wait(60)
    expect(make).not.toHaveBeenCalled()
  })

  it('does nothing in demo mode / when disabled', async () => {
    const store = new MemoryQueueStore()
    await seed(store, A1, 'p1')
    const backend = new Backend()
    render(
      <PhotoUploadProvider user={{ id: 'user-a' }} workspaceId="ws-1" api={fakeApiHook} store={store} enabled={false}
        makeEngine={() => { throw new Error('must not be created') }}>
        <div>demo</div>
      </PhotoUploadProvider>,
    )
    await wait(40)
    expect(backend.calls).toHaveLength(0)
  })
})

describe('sign-out', () => {
  it('signs out immediately when no photo is waiting', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('warns first, with counts, defaults to staying, and deletes only this user\'s photos on confirmation', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1'); await seed(store, A1, 'a2'); await seed(store, A2, 'a3'); await seed(store, B1, 'b1')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Photos have not finished uploading' })
    expect(dialog).toHaveTextContent('3 photos (9.0 MB)')                     // across both of this user's workspaces
    expect(dialog).toHaveTextContent(/deleted from this phone and cannot be recovered/)
    expect(within(dialog).getByRole('button', { name: 'Stay signed in' })).toHaveFocus()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay signed in' }))
    expect(onLogout).not.toHaveBeenCalled()
    expect(await store.list(A1)).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out and delete photos' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
    expect(await store.list(A1)).toHaveLength(0)
    expect(await store.list(A2)).toHaveLength(0)
    expect(await store.list(B1)).toHaveLength(1)                                // another account's photos are not touched by this sign-out
  })

  it('Escape is the safe answer', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onLogout).not.toHaveBeenCalled()
    expect(await store.list(A1)).toHaveLength(1)
  })

  it('a storage error while deleting still allows sign-out, but only after an accurate warning (never "deleted")', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1')
    store.clearUser = async () => { throw new Error('db closed') }
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out and delete photos' }))
    const warn = await screen.findByRole('dialog', { name: 'Photos may still be on this phone' })
    expect(onLogout).not.toHaveBeenCalled()                                     // not signed out silently
    expect(warn).toHaveTextContent('could not delete 1 photo (3.0 MB)')
    expect(warn).toHaveTextContent(/may stay on this phone/)
    expect(warn).toHaveTextContent(/You can still sign out/)
    expect(warn).not.toHaveTextContent(/will be deleted|were deleted|has been deleted/)
    await userEvent.click(within(warn).getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
    expect(await store.list(A1)).toHaveLength(1)                                // the data really is still there
  })

  it('staying signed in after a failed cleanup keeps the photos and resumes uploading them', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    await seed(store, A1, 'a1')
    store.clearUser = async () => { throw new Error('db closed') }
    backend.online = false
    render(<Guarded backend={backend} store={store}><PhotosTab jobId="job-1" /></Guarded>)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out and delete photos' }))
    const warn = await screen.findByRole('dialog', { name: 'Photos may still be on this phone' })
    backend.online = true
    await userEvent.click(within(warn).getByRole('button', { name: 'Stay signed in' }))
    expect(onLogout).not.toHaveBeenCalled()
    await waitFor(async () => expect((await store.get(A1, 'a1'))?.state).toBe('done'))
  })

  it('if local storage cannot even be read at sign-out, it says it cannot confirm nothing is left', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    store.summary = async () => { throw new Error('db closed') }
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    const warn = await screen.findByRole('dialog', { name: 'Photos may still be on this phone' })
    expect(warn).toHaveTextContent(/cannot tell you that none are left/)
    expect(onLogout).not.toHaveBeenCalled()
    await userEvent.click(within(warn).getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
  })

  it('a successful cleanup signs out straight away with no failure warning', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out and delete photos' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('finished photos do not count as unsent', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    await seed(store, A1, 'done1', { state: 'done', blob: null })
    backend.online = false
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
  })
})

describe('workspace switching', () => {
  it('warns when photos are waiting in this workspace, keeps them, and switches only when confirmed', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1'); await seed(store, A2, 'other-workspace')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'switch' }))
    const dialog = await screen.findByRole('dialog', { name: 'Photos are still waiting' })
    expect(dialog).toHaveTextContent('1 photo (3.0 MB) in Acme Plumbing')
    expect(dialog).toHaveTextContent(/stays on this phone/)
    expect(dialog).toHaveTextContent(/nothing is sent while you are in another workspace/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }))
    expect(onSwitch).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'switch' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch workspace' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(await store.list(A1)).toHaveLength(1)                                // nothing deleted
  })

  it('switches at once when nothing is waiting in this workspace (photos in other workspaces do not block)', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A2, 'elsewhere')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'switch' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1))
  })

  it('after switching, the old workspace\'s photos wait and the new workspace uploads only its own', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'in-ws1'); await seed(store, A2, 'in-ws2')
    const { rerender } = render(<Guarded backend={backend} store={store} workspaceId="ws-1" />)
    await wait(20)
    backend.online = true
    rerender(<Guarded backend={backend} store={store} workspaceId="ws-2" />)
    await waitFor(async () => expect((await store.get(A2, 'in-ws2'))?.state).toBe('done'))
    expect((await store.get(A1, 'in-ws1'))?.state).toBe('queued')               // not uploaded from ws-2
    const inits = backend.calls.filter((c) => c.op === 'init').map((c) => (c.body as { workspaceId: string }).workspaceId)
    expect(new Set(inits)).toEqual(new Set(['ws-2']))
  })
})

describe('account changes and cross-account access', () => {
  it('shows another account\'s leftover photos only as a count, and never uploads or lists them', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    await seed(store, B1, 'bs-photo')
    render(<Guarded backend={backend} store={store} user={{ id: 'user-a' }}><PhotosTab jobId="job-1" /></Guarded>)
    expect(await screen.findByText(/holding 1 unsent photo \(3\.0 MB\) from a different account/)).toBeInTheDocument()
    await wait(80)
    expect(backend.calls).toHaveLength(0)                                        // not uploaded under user A
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)                    // not listed in user A's Photos tab
    expect(document.body.innerHTML).not.toContain('data:image')                 // no photo content leaks into the page
    expect(await store.list(B1)).toHaveLength(1)
  })

  it('another account has no way to delete the first account\'s photos through the interface', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, B1, 'b1'); await seed(store, A1, 'mine')
    const clear = vi.spyOn(store, 'clearUser')
    render(<Guarded backend={backend} store={store}><PhotosTab jobId="job-1" /></Guarded>)
    const note = await screen.findByText(/from a different account/)
    expect(note).toHaveTextContent(/can't be opened, uploaded or deleted from this account/)
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Delete photos from another account/)).not.toBeInTheDocument()
    // the notice itself offers no control, and the context no longer exposes a delete action
    expect(within(note.parentElement as HTMLElement).queryAllByRole('button')).toHaveLength(0)
    const seen: string[] = []
    function Probe() { seen.push(...Object.keys(usePhotoUploads() ?? {})); return null }
    render(<Guarded backend={backend} store={store}><Probe /></Guarded>)
    await wait(30)
    expect(seen.some((k) => /foreign/i.test(k) && /delete|confirm|clear/i.test(k))).toBe(false)
    expect(seen).not.toContain('confirmDeleteForeign')
    expect(clear).not.toHaveBeenCalled()
    expect(await store.list(B1)).toHaveLength(1)
    expect(await store.list(A1)).toHaveLength(1)
  })

  it('signing out as one account never deletes another account\'s photos, even when cleanup fails', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, A1, 'a1'); await seed(store, B1, 'b1')
    const clear = vi.spyOn(store, 'clearUser')
    render(<Guarded backend={backend} store={store} />)
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out and delete photos' }))
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
    expect(clear.mock.calls.map((c) => c[0])).toEqual(['user-a'])
    expect(await store.list(B1)).toHaveLength(1)
  })

  it('when the other account signs back in, its photos are still there and are uploaded under that account only', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    await seed(store, B1, 'bs-photo')
    const { rerender } = render(<Guarded backend={backend} store={store} user={{ id: 'user-a' }} />)
    await wait(30)
    backend.online = true
    rerender(<Guarded backend={backend} store={store} user={{ id: 'user-b' }} />)
    await waitFor(async () => expect((await store.get(B1, 'bs-photo'))?.state).toBe('done'))
    expect(screen.queryByText(/from a different account/)).not.toBeInTheDocument()
  })

  it('nothing is queued or uploaded for a user without a session', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    render(<Harness backend={backend} store={store} user={null}><PhotosTab jobId="job-1" /></Harness>)
    expect(screen.queryByTestId('photo-camera-input')).not.toBeInTheDocument()
    expect(backend.calls).toHaveLength(0)
  })
})

describe('persistent storage', () => {
  it('asks the browser to keep the photos when one is added, and words the result carefully', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { ...navigator, onLine: true, storage: { persist, persisted: async () => false } })
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    render(<Harness backend={backend} store={store}><PhotosTab jobId="job-1" /></Harness>)
    fireEvent.change(screen.getByTestId('photo-camera-input'), { target: { files: [jpegFile()] } })
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/agreed to keep these photos while they wait, but they can still be lost/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/safe|guarantee|never lost/i)
  })

  it('when persistence is refused or unsupported the wording says the browser may delete photos', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: true, storage: { persist: async () => false, persisted: async () => false } })
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    render(<Harness backend={backend} store={store}><PhotosTab jobId="job-1" /></Harness>)
    fireEvent.change(screen.getByTestId('photo-camera-input'), { target: { files: [jpegFile()] } })
    expect(await screen.findByText(/may delete these photos if the phone is low on space/)).toBeInTheDocument()
  })

  it('works when the storage API does not exist at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: true, storage: undefined })
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    render(<Harness backend={backend} store={store}><PhotosTab jobId="job-1" /></Harness>)
    fireEvent.change(screen.getByTestId('photo-camera-input'), { target: { files: [jpegFile()] } })
    expect(await screen.findByText(/may delete these photos/)).toBeInTheDocument()
  })
})

describe('session loss while photos are waiting', () => {
  it('once signed out, the provider exposes nothing (the Photos tab disappears) and the photos stay saved', async () => {
    const backend = new Backend(), store = new MemoryQueueStore()
    backend.online = false
    function Probe() { const p = usePhotoUploads(); return <div>{p ? p.snapshot.paused ?? 'running' : 'no-provider'}</div> }
    await seed(store, A1, 'p1')
    const { rerender } = render(<Harness backend={backend} store={store}><Probe /><PhotosTab jobId="job-1" /></Harness>)
    await screen.findByText('running')
    act(() => { rerender(<Harness backend={backend} store={store} user={null}><Probe /></Harness>) })
    expect(await screen.findByText('no-provider')).toBeInTheDocument()
    expect((await store.get(A1, 'p1'))?.state).toBe('queued')
  })
})
