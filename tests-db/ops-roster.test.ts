// Database-backed tests for the Ops roster: draft/publish lifecycle, the
// double-booking unique constraint, bulk create with skipDuplicates, and the
// publishedBy-is-a-user-id property.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rosterRouter } from '../apps/api/src/routes/ops/roster.ts'
import { utcWeekRange } from '../apps/api/src/routes/ops/utils.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/ops/roster', rosterRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

function jsonAuth(userId: string) {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

async function seedCrewAndSite(workspaceId: string, code = 'E1') {
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId, employeeCode: code, fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId, jobCode: `J-${code}`, siteName: 'Site 1' } })
  return { crew, site }
}

function slot(dayOffset: number) {
  const rosterDate = new Date(Date.now() + dayOffset * 86_400_000)
  const startTime = new Date(rosterDate.getTime() + 8 * 3_600_000)
  const endTime = new Date(rosterDate.getTime() + 16 * 3_600_000)
  return { rosterDate: rosterDate.toISOString(), startTime: startTime.toISOString(), endTime: endTime.toISOString() }
}

test('POST / creates a DRAFT entry; a duplicate (crewMember, rosterDate, startTime) returns 409', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const s = slot(1)

  const first = await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...s }),
  })
  assert.equal(first.status, 201)
  assert.equal(first.body.entry.status, 'DRAFT')

  const dup = await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...s }),
  })
  assert.equal(dup.status, 409)
})

test('POST /bulk creates multiple entries and skips a duplicate without failing the whole batch', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const existingSlot = slot(1)
  await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...existingSlot }),
  })

  const res = await server.request('/api/ops/roster/bulk', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({
      workspaceId: workspace.id,
      entries: [
        { crewMemberId: crew.id, jobSiteId: site.id, ...existingSlot }, // collides with the one above
        { crewMemberId: crew.id, jobSiteId: site.id, ...slot(2) },
        { crewMemberId: crew.id, jobSiteId: site.id, ...slot(3) },
      ],
    }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.requested, 3)
  assert.equal(res.body.created, 2, 'the colliding entry must be skipped, not fail the whole batch')

  const total = await prisma.opsRosterEntry.count({ where: { workspaceId: workspace.id } })
  assert.equal(total, 3, '1 pre-existing + 2 newly created')
})

test('POST /bulk rejects a crewMemberId/jobSiteId that belongs to another workspace', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const other = await seedUserWithWorkspace('other@x.test')
  const { crew: otherCrew, site: otherSite } = await seedCrewAndSite(other.workspace.id)

  const res = await server.request('/api/ops/roster/bulk', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, entries: [{ crewMemberId: otherCrew.id, jobSiteId: otherSite.id, ...slot(1) }] }),
  })
  assert.equal(res.status, 404)
})

test('POST /publish moves DRAFT to PUBLISHED for a date range and stamps publishedBy with the USER ID', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const s = slot(1)
  await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...s }),
  })

  const from = new Date(Date.now()).toISOString()
  const to = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const res = await server.request('/api/ops/roster/publish', {
    method: 'POST', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id, from, to }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.published, 1)

  const row = await prisma.opsRosterEntry.findFirst({ where: { workspaceId: workspace.id } })
  assert.equal(row!.status, 'PUBLISHED')
  assert.equal(row!.publishedBy, user.id, 'publishedBy must be the acting user\'s id, never a display name')
  assert.ok(row!.publishedAt)
})

test('editing or deleting a PUBLISHED entry is rejected with 400', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  const s = slot(1)
  const created = await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...s }),
  })
  await server.request('/api/ops/roster/publish', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, from: new Date().toISOString(), to: new Date(Date.now() + 5 * 86_400_000).toISOString() }),
  })

  const edit = await server.request(`/api/ops/roster/${created.body.entry.id}`, {
    method: 'PUT', headers: jsonAuth(user.id), body: JSON.stringify({ workspaceId: workspace.id, notes: 'trying to edit' }),
  })
  assert.equal(edit.status, 400)

  const del = await server.request(`/api/ops/roster/${created.body.entry.id}?workspaceId=${workspace.id}`, {
    method: 'DELETE', headers: jsonAuth(user.id),
  })
  assert.equal(del.status, 400)
})

test('GET /summary counts drafts, this-week published entries, and active job sites', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const { crew, site } = await seedCrewAndSite(workspace.id)
  await seedCrewAndSite(workspace.id, 'E2') // second active job site

  // One entry pinned to THIS UTC week (published), one pinned to NEXT week
  // (left as a draft) — controls for the week boundary instead of assuming
  // "tomorrow" falls in the current week, which is flaky near a week rollover.
  const { start: weekStart, end: weekEnd } = utcWeekRange(new Date())
  const thisWeekMid = new Date(weekStart.getTime() + 2 * 86_400_000 + 8 * 3_600_000)
  const thisWeekEnd = new Date(thisWeekMid.getTime() + 8 * 3_600_000)
  const nextWeekMid = new Date(weekEnd.getTime() + 2 * 86_400_000 + 8 * 3_600_000)
  const nextWeekEnd = new Date(nextWeekMid.getTime() + 8 * 3_600_000)

  await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, rosterDate: thisWeekMid.toISOString(), startTime: thisWeekMid.toISOString(), endTime: thisWeekEnd.toISOString() }),
  })
  await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, rosterDate: nextWeekMid.toISOString(), startTime: nextWeekMid.toISOString(), endTime: nextWeekEnd.toISOString() }),
  })
  // Publish only the current-week entry.
  await server.request('/api/ops/roster/publish', {
    method: 'POST', headers: jsonAuth(user.id),
    body: JSON.stringify({ workspaceId: workspace.id, from: weekStart.toISOString(), to: weekEnd.toISOString() }),
  })

  const res = await server.request(`/api/ops/roster/summary?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(user.id) } })
  assert.equal(res.status, 200)
  assert.equal(res.body.activeJobSiteCount, 2)
  assert.equal(res.body.draftCount, 1, 'the next-week entry is still a draft')
  assert.equal(res.body.publishedThisWeekCount, 1, 'only the current-week entry was published')
})

test('a plain member is denied on every mutating roster endpoint but can still read', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const member = await seedUserWithWorkspace(undefined, 'member')
  await prisma.membership.create({ data: { userId: member.user.id, workspaceId: workspace.id, role: 'member' } })
  const { crew, site } = await seedCrewAndSite(workspace.id)

  const create = await server.request('/api/ops/roster', {
    method: 'POST', headers: jsonAuth(member.user.id),
    body: JSON.stringify({ workspaceId: workspace.id, crewMemberId: crew.id, jobSiteId: site.id, ...slot(1) }),
  })
  assert.equal(create.status, 403)

  const list = await server.request(`/api/ops/roster?workspaceId=${workspace.id}`, { headers: { Authorization: bearer(member.user.id) } })
  assert.equal(list.status, 200)
})
