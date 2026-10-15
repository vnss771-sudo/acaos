// Declared content types accepted for evidence uploads. Kept free of heavy
// dependencies so the API can validate requests without loading the image library.
// These are only what a client may DECLARE; the worker verifies the real bytes.
export const ALLOWED_EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type EvidenceImageType = (typeof ALLOWED_EVIDENCE_TYPES)[number]
