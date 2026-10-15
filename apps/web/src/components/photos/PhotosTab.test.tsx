import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PhotosTab, describe as describeItem } from './PhotosTab.js'
import { Harness, Backend, NET, OK, apiErr, wait } from './testHarness.js'
import { ImageError } from '../../lib/evidence/imagePipeline.js'
import { MemoryQueueStore } from '../../lib/evidence/queueStore.js'

const jpegFile = (name = 'IMG_1.jpg') => new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], name, { type: 'image/jpeg' })
const add = (testId: string, files: File[]) => fireEvent.change(screen.getByTestId(testId), { target: { files } })

function setup(over: { backend?: Backend; store?: MemoryQueueStore } = {}) {
  const backend = over.backend ?? new Backend()
  const store = over.store ?? new MemoryQueueStore()
  const ui = render(<Harness backend={backend} store={store}><PhotosTab jobId="job-1" /></Harness>)
  return { backend, store, ...ui }
}

beforeEach(() => { vi.restoreAllMocks() })

describe('capture controls', () => {
  it('offers camera and gallery with the right attributes and large touch targets', () => {
    setup()
    const camera = screen.getByTestId('photo-camera-input') as HTMLInputElement
    const gallery = screen.getByTestId('photo-gallery-input') as HTMLInputElement
    expect(camera.accept).toBe('image/*')
    expect(camera.getAttribute('capture')).toBe('environment')
    expect(camera.multiple).toBe(false)
    expect(gallery.accept).toBe('image/*')
    expect(gallery.hasAttribute('capture')).toBe(false)
    expect(gallery.multiple).toBe(true)
    for (const name of ['Take photo', 'Choose from gallery']) {
      const b = screen.getByRole('button', { name })
      expect(parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(48)
      expect(parseInt(b.style.minWidth, 10)).toBeGreaterThanOrEqual(48)
    }
  })

  it('the buttons open the matching file picker', async () => {
    setup()
    const camera = screen.getByTestId('photo-camera-input'), gallery = screen.getByTestId('photo-gallery-input')
    const cam = vi.spyOn(camera as HTMLInputElement, 'click'), gal = vi.spyOn(gallery as HTMLInputElement, 'click')
    await userEvent.click(screen.getByRole('button', { name: 'Take photo' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose from gallery' }))
    expect(cam).toHaveBeenCalledTimes(1)
    expect(gal).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state, and says that photos stay on the phone first and have location data removed', () => {
    setup()
    expect(screen.getByText(/saved on this phone first/i)).toBeInTheDocument()
    expect(screen.getByText(/location data is removed/i)).toBeInTheDocument()
    expect(screen.getByText(/No photos waiting/i)).toBeInTheDocument()
  })
})

describe('photo states', () => {
  it('a photo goes queued -> uploaded, announces progress, and can be cleared', async () => {
    const { backend } = setup()
    add('photo-camera-input', [jpegFile()])
    await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument())
    expect(backend.count('init')).toBe(1)
    expect(screen.getByRole('img', { name: /Preview of Photo from/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Clear Photo from .* from the list/ }))
    await waitFor(() => expect(screen.queryByText('Uploaded')).not.toBeInTheDocument())
  })

  it('shows uploading with a progress bar and a Cancel button', async () => {
    const backend = new Backend()
    let release!: () => void
    backend.putQueue = [() => new Promise((r) => { release = () => r(OK) })]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    const bar = await screen.findByRole('progressbar')
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(0)
    expect(screen.getByText(/Uploading \d+%/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel Photo from/ })).toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument())
  })

  it('offline: shows the banner and "Waiting for a connection", then uploads when back online', async () => {
    const backend = new Backend()
    backend.online = false
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    expect(await screen.findByText(/Waiting for a connection/)).toBeInTheDocument()
    expect(screen.getByText(/No connection. Photos will upload/)).toBeInTheDocument()
    expect(screen.getByText(/saved on this phone and not yet uploaded/)).toBeInTheDocument()
    backend.online = true
    window.dispatchEvent(new Event('online'))   // connectivity recovery resumes the queue at once
    await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument())
    expect(screen.queryByText(/No connection/)).not.toBeInTheDocument()
  })

  it('a failing photo ends as failed with Retry and Remove, keeps the photo, and Retry uploads it', async () => {
    const backend = new Backend()
    backend.putQueue = [NET, NET, NET]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    expect(await screen.findByText(/Upload stopped|connection/i, {}, { timeout: 4000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry Photo from/ })).toBeInTheDocument(), { timeout: 4000 })
    expect(screen.getByText(/Your photo is still saved on this phone/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove Photo from/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Retry Photo from/ }))
    await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument())
  })

  it('a final rejection explains why, offers no retry, and can be cleared', async () => {
    const backend = new Backend()
    backend.nextInit = [apiErr(409, 'Job is not active')]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    expect(await screen.findByText(/This job is closed/)).toBeInTheDocument()
    expect(screen.getByText(/This photo was not uploaded/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Clear Photo from/ }))
    await waitFor(() => expect(screen.queryByText(/This job is closed/)).not.toBeInTheDocument())
  })

  it('only shows this job\'s photos', async () => {
    const backend = new Backend()
    const store = new MemoryQueueStore()
    backend.online = false
    const { rerender } = render(<Harness backend={backend} store={store}><PhotosTab jobId="job-1" /></Harness>)
    add('photo-camera-input', [jpegFile()])
    await screen.findByText(/Waiting for a connection/)
    rerender(<Harness backend={backend} store={store}><PhotosTab jobId="job-2" /></Harness>)
    await waitFor(() => expect(screen.getByText(/No photos waiting/)).toBeInTheDocument())
  })

  it('describe() never exposes anything beyond fixed text', () => {
    const base = { id: 'x', jobId: 'j', progress: 0, attempts: 0, nextAttemptAt: null, sizeBytes: 1, width: 1, height: 1, createdAt: 1, hasPhoto: true, preview: null, errorCode: null, errorText: null }
    expect(describeItem({ ...base, state: 'queued' }, true).label).toBe('Waiting to upload')
    expect(describeItem({ ...base, state: 'queued' }, false).label).toBe('Waiting for a connection')
    expect(describeItem({ ...base, state: 'processing' }, true).label).toMatch(/Checking/)
    expect(describeItem({ ...base, state: 'done' }, true).tone).toBe('good')
    expect(describeItem({ ...base, state: 'cancelling' }, true).label).toBe('Removing…')
  })
})

describe('adding photos', () => {
  it('shows the HEIC message and queues nothing', async () => {
    const backend = new Backend()
    backend.prepareError = new ImageError('heic_unsupported')
    setup({ backend })
    add('photo-gallery-input', [new File([new Uint8Array(40)], 'IMG_9.HEIC', { type: 'image/heic' })])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/IMG_9\.HEIC/)
    expect(alert).toHaveTextContent(/HEIC\/HEIF/)
    expect(backend.calls).toHaveLength(0)
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adds several gallery photos, one at a time, and reports how many were added', async () => {
    const backend = new Backend()
    backend.online = false
    setup({ backend })
    add('photo-gallery-input', [jpegFile('a.jpg'), jpegFile('b.jpg'), jpegFile('c.jpg')])
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(screen.getByText(/3 photos added/)).toBeInTheDocument()
    expect(screen.getByText(/3<\/strong>|^3$/, { selector: 'strong' })).toBeInTheDocument()
  })

  it('clears the input so the same photo can be chosen again', async () => {
    setup()
    const input = screen.getByTestId('photo-camera-input') as HTMLInputElement
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'C:\\fakepath\\IMG_1.jpg' })
    add('photo-camera-input', [jpegFile()])
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('the queue limit is reported per photo', async () => {
    const backend = new Backend()
    backend.online = false
    const store = new MemoryQueueStore()
    setup({ backend, store })
    const many = Array.from({ length: 31 }, (_, i) => jpegFile(`p${i}.jpg`))
    add('photo-gallery-input', many)
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 })
    expect(alert).toHaveTextContent(/Too many photos are waiting/)
    expect(screen.getAllByRole('listitem')).toHaveLength(30)
  }, 15000)
})

describe('cancel and remove (including races)', () => {
  it('cancelling an upload in progress asks first, then stops it and removes the photo', async () => {
    const backend = new Backend()
    let release!: () => void
    backend.putQueue = [() => new Promise((r) => { release = () => r({ ...OK, aborted: true, status: 0 }) })]
    const { store } = setup({ backend })
    add('photo-camera-input', [jpegFile()])
    await screen.findByRole('progressbar')
    await userEvent.click(screen.getByRole('button', { name: /Cancel Photo from/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/cannot be undone/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove photo' }))
    release()
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
    await waitFor(() => expect(backend.count('cancel')).toBe(1))
    expect(await store.list({ userId: 'user-a', workspaceId: 'ws-1' })).toHaveLength(0)
    expect(backend.count('complete')).toBe(0)
  })

  it('"Keep it" leaves the photo uploading', async () => {
    const backend = new Backend()
    let release!: () => void
    backend.putQueue = [() => new Promise((r) => { release = () => r(OK) })]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    await screen.findByRole('progressbar')
    await userEvent.click(screen.getByRole('button', { name: /Cancel Photo from/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.getByText('Uploaded')).toBeInTheDocument())
    expect(backend.count('cancel')).toBe(0)
  })

  it('removing a photo whose upload finishes at the same moment never loses or double-saves it', async () => {
    const backend = new Backend()
    let release!: () => void
    backend.putQueue = [() => new Promise((r) => { release = () => r(OK) })]
    backend.nextCancel = [apiErr(409, 'Uploaded evidence cannot be removed here')]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    await screen.findByRole('progressbar')
    await userEvent.click(screen.getByRole('button', { name: /Cancel Photo from/ }))
    release() // the upload completes while the confirmation is open
    // The dialog notices and says so, instead of offering to delete evidence that is already in the job.
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText(/finished uploading and is now part of the job/)).toBeInTheDocument(), { timeout: 4000 })
    expect(within(dialog).queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'OK' }))
    expect(screen.getByText('Uploaded')).toBeInTheDocument()
    expect(backend.files.size).toBe(1)
    expect(backend.count('cancel')).toBe(0)
  })

  it('a failed photo can be removed (after confirmation) and disappears', async () => {
    const backend = new Backend()
    backend.putQueue = [NET, NET, NET]
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    await waitFor(() => expect(screen.getByRole('button', { name: /Remove Photo from/ })).toBeInTheDocument(), { timeout: 4000 })
    await userEvent.click(screen.getByRole('button', { name: /Remove Photo from/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove photo' }))
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
    await wait(20)
  })
})

describe('accessibility', () => {
  it('uses real buttons with names, a labelled list, and live regions for status', async () => {
    const backend = new Backend()
    backend.online = false
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    const list = await screen.findByRole('list', { name: 'Photos for this job' })
    const item = within(list).getByRole('listitem')
    expect(within(item).getByRole('button', { name: /Cancel Photo from/ }).tagName).toBe('BUTTON')
    expect(within(item).getByRole('status')).toBeInTheDocument()
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1)
    expect(within(item).getByRole('img', { name: /Preview of Photo from/ })).toHaveAttribute('alt')
  })

  it('never renders the dialog or list without an accessible name', async () => {
    const backend = new Backend()
    backend.online = false
    setup({ backend })
    add('photo-camera-input', [jpegFile()])
    await userEvent.click(await screen.findByRole('button', { name: /Cancel Photo from/ }))
    expect(screen.getByRole('dialog', { name: 'Remove this photo?' })).toBeInTheDocument()
  })
})
