// Local-only helper for scripts/e2e-evidence-local.sh: creates the throwaway bucket on the LOCAL
// S3-compatible server and sets its CORS to the exact page origins. Refuses any non-loopback endpoint.
import { S3Client, CreateBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3'

const endpoint = process.env.EVIDENCE_S3_ENDPOINT ?? ''
const host = new URL(endpoint).hostname
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('refusing to configure a non-loopback endpoint')
const bucket = process.env.EVIDENCE_S3_BUCKET!
const s3 = new S3Client({
  endpoint, region: process.env.EVIDENCE_S3_REGION ?? 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.EVIDENCE_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.EVIDENCE_S3_SECRET_ACCESS_KEY! },
})
async function main() {
  try { await s3.send(new CreateBucketCommand({ Bucket: bucket })) } catch (e) { if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e))) throw e }
  await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [{
    AllowedOrigins: (process.env.E2E_PAGE_ORIGINS ?? 'http://localhost:4173').split(','),
    AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 600,
  }] } }))
  console.log(`[e2e-s3] bucket ${bucket} ready with CORS for ${process.env.E2E_PAGE_ORIGINS ?? 'http://localhost:4173'}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
