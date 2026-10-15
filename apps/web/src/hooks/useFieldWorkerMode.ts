import { useCallback, useEffect, useState } from 'react'
import type { ApiHook } from './useApi.js'
import type { Workspace } from '../types.js'

// Field-worker mode: a plain `member` whose login is linked to an active crew
// record gets the reduced "My work" menu and lands on My jobs. Anyone else (owners,
// admins, members with no crew link) is unaffected. This only shapes navigation;
// the API still authorises every request, so a failure to resolve fails OPEN to the
// normal menu rather than hiding anything behind a guess.
//
// Members who also carry other responsibilities can switch to the full menu; the
// choice is a per-user, per-workspace convenience kept in localStorage.

const storageKey = (workspaceId: string) => `acaos.fullMenu.${workspaceId}`

function readFullMenu(workspaceId: string): boolean {
  try { return window.localStorage.getItem(storageKey(workspaceId)) === '1' } catch { return false }
}

function writeFullMenu(workspaceId: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(storageKey(workspaceId), '1')
    else window.localStorage.removeItem(storageKey(workspaceId))
  } catch { /* storage unavailable: the choice just won't persist */ }
}

/** Land on My jobs only when arriving at the default route; deep links are respected. */
export function shouldLandOnMyJobs(o: { fieldWorker: boolean; pathname: string }): boolean {
  return o.fieldWorker && o.pathname === '/'
}

export type FieldWorkerMode = {
  /** The role/crew check has finished for the active workspace. */
  resolved: boolean
  /** Member with an active linked crew account (regardless of menu preference). */
  eligible: boolean
  /** Eligible and not opted out: use the reduced menu. */
  fieldWorker: boolean
  setFullMenu: (full: boolean) => void
}

export function useFieldWorkerMode(api: ApiHook, workspace: Workspace | null): FieldWorkerMode {
  const wsId = workspace?.id ?? null
  const isMember = workspace?.role === 'member'
  const [result, setResult] = useState<{ wsId: string; linked: boolean } | null>(null)
  const [full, setFull] = useState(false)

  useEffect(() => {
    if (!wsId) return
    setFull(readFullMenu(wsId))
    if (!isMember) { setResult(null); return }
    let cancelled = false
    api<{ linked?: boolean }>(`/api/ops/technician/assigned?workspaceId=${encodeURIComponent(wsId)}`)
      .then(r => { if (!cancelled) setResult({ wsId, linked: Boolean(r?.linked) }) })
      .catch(() => { if (!cancelled) setResult({ wsId, linked: false }) })
    return () => { cancelled = true }
  }, [api, wsId, isMember])

  const setFullMenu = useCallback((value: boolean) => {
    if (wsId) writeFullMenu(wsId, value)
    setFull(value)
  }, [wsId])

  const eligible = Boolean(wsId && isMember && result?.wsId === wsId && result.linked)
  const resolved = wsId !== null && (!isMember || result?.wsId === wsId)
  return { resolved, eligible, fieldWorker: eligible && !full, setFullMenu }
}
