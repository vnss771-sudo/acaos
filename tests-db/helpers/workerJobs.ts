// The worker jobs that worker.ts runs inside runInWorkspaceContext(workspaceId, …),
// wrapped the same way. Tests call these instead of the bare processors, so a run
// with TENANT_GUARD_MODE set checks every query a job makes, as in production. The
// context is read only by the tenant guard, so with the guard off (the test
// default) these behave exactly like the bare functions.

import * as processors from '../../apps/worker/src/processors.ts'
import { learnFromOutcomes as learnFromOutcomesRaw } from '../../packages/backend-core/src/lib/outcomeLearning.ts'
import { learnSignalCalibration as learnSignalCalibrationRaw } from '../../packages/backend-core/src/lib/calibrationLearning.ts'
import { runInWorkspaceContext } from '../../packages/backend-core/src/lib/tenantContext.ts'

export const researchLead = (...a: Parameters<typeof processors.researchLead>) =>
  runInWorkspaceContext(a[1], () => processors.researchLead(...a))

export const generateOutreachDraft = (...a: Parameters<typeof processors.generateOutreachDraft>) =>
  runInWorkspaceContext(a[1], () => processors.generateOutreachDraft(...a))

export const scoreProspects = (...a: Parameters<typeof processors.scoreProspects>) =>
  runInWorkspaceContext(a[0], () => processors.scoreProspects(...a))

export const discoverProspectsBatch = (...a: Parameters<typeof processors.discoverProspectsBatch>) =>
  runInWorkspaceContext(a[1], () => processors.discoverProspectsBatch(...a))

export const sendCampaignBatch = (...a: Parameters<typeof processors.sendCampaignBatch>) =>
  runInWorkspaceContext(a[1], () => processors.sendCampaignBatch(...a))

export const calibrateScoring = (...a: Parameters<typeof processors.calibrateScoring>) =>
  runInWorkspaceContext(a[0], () => processors.calibrateScoring(...a))

export const learnFromOutcomes = (...a: Parameters<typeof learnFromOutcomesRaw>) =>
  runInWorkspaceContext(a[0], () => learnFromOutcomesRaw(...a))

export const learnSignalCalibration = (...a: Parameters<typeof learnSignalCalibrationRaw>) =>
  runInWorkspaceContext(a[0], () => learnSignalCalibrationRaw(...a))
