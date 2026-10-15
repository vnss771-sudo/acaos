// Client-side limits for technician photo evidence. The server remains authoritative (it enforces
// its own size, type and count limits); these exist so the device fails early and predictably.
export const EVIDENCE_LIMITS = {
  /** Largest raw file accepted from the camera or gallery. */
  maxInputBytes: 60 * 1024 * 1024,
  /** Largest processed JPEG we will upload. Matches the server default (EVIDENCE_MAX_UPLOAD_BYTES). */
  maxUploadBytes: 10 * 1024 * 1024,
  /** Refuse to decode anything claiming more pixels than this (a decode bomb or a huge panorama). */
  maxSourcePixels: 120_000_000,
  /** Long-edge ladder tried in order until the JPEG fits. */
  edgeLadder: [2560, 2048, 1600, 1280] as readonly number[],
  /** JPEG quality ladder tried (per edge) in order. */
  qualityLadder: [0.85, 0.75, 0.65, 0.5] as readonly number[],
  /** Local queue caps, per (user, workspace). */
  maxQueueItems: 30,
  maxQueueBytes: 120 * 1024 * 1024,
  /** Uploads in flight at once. */
  concurrency: 2,
  /** Automatic attempts before an item needs a manual retry. */
  maxAttempts: 8,
  /** Backoff for retryable failures. */
  backoffBaseMs: 2_000,
  backoffCapMs: 5 * 60_000,
  /** Re-sign the upload this long before the 300 s presign lifetime would run out. */
  presignSafetyMs: 30_000,
  /** One PUT may take this long in total. */
  putTimeoutMs: 5 * 60_000,
  /** Status polling after `complete`. */
  pollIntervalMs: [1_500, 2_500, 4_000, 6_000, 10_000] as readonly number[],
  pollDeadlineMs: 3 * 60_000,
  /** Finished items are kept (without their photo) this long so the UI can show them. */
  doneRetentionMs: 24 * 60 * 60_000,
} as const

/** Widened so callers (and tests) can supply other numbers. */
export type EvidenceLimits = { -readonly [K in keyof typeof EVIDENCE_LIMITS]: (typeof EVIDENCE_LIMITS)[K] extends readonly number[] ? readonly number[] : number }
