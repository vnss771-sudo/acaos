// Database-backed tests for reconcileShiftAlerts() — the upsert-based alert
// lifecycle behind OpsAlert's @@unique([shiftRecordId, alertType]) constraint.
// Calls the function directly (not through HTTP), matching the extracted-
// processor test style used for worker-processors.test.ts.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileShiftAlerts } from '../apps/api/src/routes/ops/utils.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

before(async () => {})
after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedShift(workspaceId: string) {
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId, employeeCode: 'E1', fullName: 'Jane Doe', role: 'TECH' } })
  const site = await prisma.opsJobSite.create({ data: { workspaceId, jobCode: 'J-1', siteName: 'Site 1' } })
  const start = new Date(Date.now() - 8 * 60 * 60 * 1000)
  return prisma.opsShiftRecord.create({
    data: {
      workspaceId, crewMemberId: crew.id, jobSiteId: site.id,
      shiftDate: start, startTime: start, endTime: new Date(),
      totalHours: 8, outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: false, allowanceTag: 'NONE',
    },
  })
}

function alertsFor(shiftRecordId: string) {
  return prisma.opsAlert.findMany({ where: { shiftRecordId } })
}

test('reconciling the same wanted condition repeatedly does not create duplicate rows', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const shift = await seedShift(workspace.id)
  const flagged = { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: true, allowanceTag: 'NONE' }

  await reconcileShiftAlerts(workspace.id, shift.id, flagged)
  await reconcileShiftAlerts(workspace.id, shift.id, flagged)
  await reconcileShiftAlerts(workspace.id, shift.id, flagged)

  const alerts = await alertsFor(shift.id)
  assert.equal(alerts.length, 1, 'repeated reconciliation must resolve to the SAME row, not one per call')
  assert.equal(alerts[0]!.alertType, 'FATIGUE_THRESHOLD')
  assert.equal(alerts[0]!.status, 'OPEN')
})

test('a re-triggered condition after review reopens the SAME row instead of creating a duplicate', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const shift = await seedShift(workspace.id)

  // 1) Condition triggers — alert created.
  await reconcileShiftAlerts(workspace.id, shift.id, { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: true, allowanceTag: 'NONE' })
  const created = await alertsFor(shift.id)
  assert.equal(created.length, 1)
  const originalId = created[0]!.id

  // 2) A reviewer actions it.
  await prisma.opsAlert.update({ where: { id: originalId }, data: { status: 'REVIEWED', reviewedBy: 'user-1', reviewedAt: new Date() } })

  // 3) The underlying condition resolves — reconcile must NOT delete the
  // REVIEWED row (it's historical record, not an open item).
  await reconcileShiftAlerts(workspace.id, shift.id, { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: false, allowanceTag: 'NONE' })
  const afterResolve = await alertsFor(shift.id)
  assert.equal(afterResolve.length, 1, 'a REVIEWED alert must not be deleted when its condition resolves')
  assert.equal(afterResolve[0]!.status, 'REVIEWED')

  // 4) The condition RE-TRIGGERS. This must reopen the existing row (same id),
  // not create a second row for the same (shiftRecordId, alertType).
  await reconcileShiftAlerts(workspace.id, shift.id, { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: true, allowanceTag: 'NONE' })
  const afterRetrigger = await alertsFor(shift.id)
  assert.equal(afterRetrigger.length, 1, 'a re-trigger after review must not create a duplicate row')
  assert.equal(afterRetrigger[0]!.id, originalId, 'the SAME row must be reused, not a new one')
  assert.equal(afterRetrigger[0]!.status, 'OPEN', 'a re-triggered condition reopens the alert')
  assert.equal(afterRetrigger[0]!.reviewedBy, null, 'the stale review stamp is cleared on reopen')
  assert.equal(afterRetrigger[0]!.reviewedAt, null)
})

test('an OPEN alert whose condition resolves is deleted (no historical value to keep)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const shift = await seedShift(workspace.id)

  await reconcileShiftAlerts(workspace.id, shift.id, { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: true, allowanceTag: 'NONE' })
  assert.equal((await alertsFor(shift.id)).length, 1)

  await reconcileShiftAlerts(workspace.id, shift.id, { outdoorHighRisk: false, heatCheckCompleted: false, fatigueConcern: false, allowanceTag: 'NONE' })
  assert.equal((await alertsFor(shift.id)).length, 0, 'an OPEN alert for a resolved condition is cleared')
})

test('multiple distinct alert types on one shift each get their own row, still exactly one per type', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const shift = await seedShift(workspace.id)
  const allFlagged = { outdoorHighRisk: true, heatCheckCompleted: false, fatigueConcern: true, allowanceTag: 'NONE' }

  await reconcileShiftAlerts(workspace.id, shift.id, allFlagged)
  await reconcileShiftAlerts(workspace.id, shift.id, allFlagged)

  const alerts = await alertsFor(shift.id)
  const types = alerts.map((a) => a.alertType).sort()
  // outdoorHighRisk + !heatCheckCompleted -> MISSING_HEAT_CHECK; fatigueConcern -> FATIGUE_THRESHOLD;
  // outdoorHighRisk + allowanceTag==='NONE' -> MISSING_ALLOWANCE.
  assert.deepEqual(types, ['FATIGUE_THRESHOLD', 'MISSING_ALLOWANCE', 'MISSING_HEAT_CHECK'])
})
