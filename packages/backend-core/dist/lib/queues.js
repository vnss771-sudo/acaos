import { Redis as IORedis } from 'ioredis';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
let _connection = null;
function getConnection() {
    if (!_connection) {
        _connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: true
        });
        _connection.on('error', (err) => {
            console.warn('[redis] Connection error:', err.message);
        });
    }
    return _connection;
}
const _queues = new Map();
export function getQueue(name) {
    if (!_queues.has(name)) {
        _queues.set(name, new Queue(name, { connection: getConnection() }));
    }
    return _queues.get(name);
}
const defaultJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } };
// AI jobs use a longer backoff so retries always wait past the OpenAI circuit
// breaker's resetAfterMs (30s) — prevents burning all attempts while OPEN.
const aiJobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 35000 } };
// Job payloads are scoped by workspaceId (authoritative for polling/auth) plus an
// optional initiatedByUserId. Object params prevent the positional confusion that
// previously let ingest pass a workspaceId into a `userId` field.
export async function enqueueResearchLead(opts) {
    return getQueue('research-lead').add('research-lead', opts, aiJobOpts);
}
export async function enqueueGenerateOutreach(opts) {
    return getQueue('generate-outreach').add('generate-outreach', opts, aiJobOpts);
}
export async function enqueueAnalyzeReply(opts) {
    return getQueue('analyze-reply').add('analyze-reply', opts, aiJobOpts);
}
export async function enqueueSyncMailbox(workspaceId, userId) {
    return getQueue('sync-mailbox').add('sync-mailbox', { workspaceId, userId }, { attempts: 2, backoff: { type: 'exponential', delay: 10000 } });
}
export async function getJobById(queueName, jobId) {
    const { Job } = await import('bullmq');
    return Job.fromId(getQueue(queueName), jobId);
}
export async function enqueueScoreProspects(workspaceId) {
    return getQueue('score-prospects').add('score-prospects', { workspaceId }, defaultJobOpts);
}
export async function enqueueGenerateRecommendations(prospectId, workspaceId) {
    return getQueue('generate-recommendations').add('generate-recommendations', { prospectId, workspaceId }, defaultJobOpts);
}
export async function enqueueCalibrate(workspaceId) {
    return getQueue('calibrate-scoring').add('calibrate-scoring', { workspaceId }, defaultJobOpts);
}
export async function enqueueSendCampaign(campaignId, workspaceId, leadIds) {
    // Deterministic jobId so repeated "launch" clicks within the same minute collapse
    // to a single send job (BullMQ ignores an add with an existing jobId). The
    // minute bucket still allows a legitimate re-launch later; the lead set is part
    // of the key so "send all" and "send subset" are distinct operations.
    const leadKey = leadIds?.length ? [...leadIds].sort().join(',') : 'all';
    const leadHash = createHash('sha256').update(leadKey).digest('hex').slice(0, 16);
    const minuteBucket = Math.floor(Date.now() / 60000);
    // NOTE: BullMQ forbids ':' in custom job IDs (it's the internal Redis key
    // separator), so use '-'. cuids/hex/number segments contain no '-'.
    const dedupJobId = `send-campaign-${workspaceId}-${campaignId}-${leadHash}-${minuteBucket}`;
    return getQueue('send-campaign').add('send-campaign', { campaignId, workspaceId, leadIds }, {
        jobId: dedupJobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 200
    });
}
const ALL_QUEUES = [
    'research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox',
    'send-campaign', 'score-prospects', 'calibrate-scoring', 'generate-recommendations'
];
export async function getQueueStats() {
    return Promise.all(ALL_QUEUES.map(async (name) => {
        const q = getQueue(name);
        const counts = await q.getJobCounts('active', 'waiting', 'completed', 'failed');
        return { name, ...counts };
    }));
}
