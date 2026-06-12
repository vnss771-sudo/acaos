import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastContainer } from './Toast.js'
import type { Toast } from '../hooks/useToast.js'

const toasts: Toast[] = [
  { id: '1', message: 'Saved successfully', type: 'success' },
  { id: '2', message: 'Something failed', type: 'error' },
]

describe('ToastContainer', () => {
  test('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer toasts={[]} onRemove={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders each toast message', () => {
    render(<ToastContainer toasts={toasts} onRemove={() => {}} />)
    expect(screen.getByText('Saved successfully')).toBeInTheDocument()
    expect(screen.getByText('Something failed')).toBeInTheDocument()
  })

  test('calls onRemove with the toast id when dismissed', async () => {
    const onRemove = vi.fn()
    render(<ToastContainer toasts={[toasts[0]]} onRemove={onRemove} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onRemove).toHaveBeenCalledWith('1')
  })
})
