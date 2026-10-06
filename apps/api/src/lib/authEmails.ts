// The account emails the API sends itself. Each goes out as HTML with a
// plain-text alternative: some mail clients show only text, and spam filters
// score HTML-only mail as more suspicious.

export type AccountEmail = { subject: string; html: string; text: string }

export function verificationEmail(verifyUrl: string): AccountEmail {
  return {
    subject: 'Verify your ACAOS email address',
    html:
      `<p>Please verify your email address by clicking the link below. This link expires in 24 hours.</p>` +
      `<p><a href="${verifyUrl}">Verify email address</a></p>` +
      `<p>If you didn't sign up for ACAOS, you can ignore this email.</p>`,
    text:
      `Please verify your email address by opening the link below. This link expires in 24 hours.\n\n` +
      `${verifyUrl}\n\n` +
      `If you didn't sign up for ACAOS, you can ignore this email.\n`,
  }
}

export function passwordResetEmail(resetUrl: string): AccountEmail {
  return {
    subject: 'Reset your ACAOS password',
    html:
      `<p>Click the link below to reset your password. This link expires in 1 hour.</p>` +
      `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email.</p>`,
    text:
      `Open the link below to reset your password. This link expires in 1 hour.\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email.\n`,
  }
}
