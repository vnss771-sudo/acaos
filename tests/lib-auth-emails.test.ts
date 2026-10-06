import test from 'node:test'
import assert from 'node:assert/strict'
import { passwordResetEmail, verificationEmail } from '../apps/api/src/lib/authEmails.ts'

const cases = [
  { name: 'verification', msg: verificationEmail('https://app.acaos.test/#verify=tok123'), url: 'https://app.acaos.test/#verify=tok123' },
  { name: 'password reset', msg: passwordResetEmail('https://app.acaos.test/#reset=tok456'), url: 'https://app.acaos.test/#reset=tok456' },
]

for (const { name, msg, url } of cases) {
  test(`the ${name} email has a plain-text part carrying the link`, () => {
    assert.ok(msg.text.includes(url), 'the text part holds the bare link')
    assert.doesNotMatch(msg.text, /<\/?[a-z]/i, 'the text part has no markup')
    assert.ok(msg.html.includes(`href="${url}"`), 'the HTML part still links it')
  })
}
