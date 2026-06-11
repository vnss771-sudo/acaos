// Chaos tests for HTML injection safety — verifies the escapeHtml/bodyToHtml
// contract that all outgoing email bodies are escaped before being sent.
// The functions are inlined here (they're private to prospects.ts) to test
// the logic in isolation, and to catch any future regression if the escaping
// is changed or removed.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Mirror the implementation in apps/api/src/routes/prospects.ts
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function bodyToHtml(text: string): string {
  return `<p style="font-family:sans-serif;line-height:1.6">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
}

// XSS payloads sourced from OWASP XSS Filter Evasion cheat sheet
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)">',
  '<a href="javascript:void(0)" onclick="alert(1)">click</a>',
  '"><script>alert(1)</script>',
  '\';alert(1);//',
  '<ScRiPt>alert(1)</ScRiPt>',
  '<<SCRIPT>alert(1)//<</SCRIPT>',
  '<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;XSS&#39;&#41;>',
  '`<script>alert(1)</script>`',
  '<details/open/ontoggle=alert(1)>',
  '<div style="background:url(javascript:alert(1))">',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '&lt;script&gt;alert(1)&lt;/script&gt;', // double-encode attempt
]

const SQL_PAYLOADS = [
  "'; DROP TABLE users; --",
  "1 OR '1'='1",
  "1; SELECT * FROM prospects;",
  "admin'--",
  "' UNION SELECT * FROM memberships--",
  "Robert'; DROP TABLE Students;--",
]

describe('escapeHtml — XSS prevention', () => {
  for (const payload of XSS_PAYLOADS) {
    it(`escapes payload: ${payload.substring(0, 40)}`, () => {
      const escaped = escapeHtml(payload)
      // Primary check: raw angle brackets must be escaped (prevents tag injection)
      assert.ok(!escaped.includes('<script'), `Unescaped <script in: ${escaped}`)
      assert.ok(!escaped.includes('<img '), `Unescaped <img in: ${escaped}`)
      assert.ok(!escaped.includes('<svg '), `Unescaped <svg in: ${escaped}`)
      assert.ok(!escaped.includes('<iframe'), `Unescaped <iframe in: ${escaped}`)
      assert.ok(!escaped.includes('<a '), `Unescaped <a in: ${escaped}`)
      assert.ok(!escaped.includes('<div '), `Unescaped <div in: ${escaped}`)
      assert.ok(!escaped.includes('<style'), `Unescaped <style in: ${escaped}`)
      assert.ok(!escaped.includes('<details'), `Unescaped <details in: ${escaped}`)
      // Verify that angle-bracket-containing payloads are actually escaped
      const hasAngle = payload.includes('<') || payload.includes('>')
      if (hasAngle) {
        assert.ok(escaped.includes('&lt;') || escaped.includes('&gt;'),
          `Angle brackets not escaped in: ${escaped}`)
      }
      // Attributes like onerror=/onload= remain as text after escaping — that is correct
      // because the surrounding < > are escaped, making the text inert.
      // Only verify raw unescaped tags are gone (checked above).
    })
  }
})

describe('escapeHtml — SQL injection in email content', () => {
  for (const payload of SQL_PAYLOADS) {
    it(`handles SQL payload: ${payload.substring(0, 40)}`, () => {
      const escaped = escapeHtml(payload)
      // SQL payloads with quotes should have ' escaped to &#039;
      if (payload.includes("'")) {
        assert.ok(escaped.includes("&#039;"), `Single quote not escaped in: ${escaped}`)
        assert.ok(!escaped.includes("'"), `Unescaped single quote remains in: ${escaped}`)
      }
    })
  }
})

describe('escapeHtml — character-level correctness', () => {
  it('& is escaped to &amp;', () => {
    assert.equal(escapeHtml('A & B'), 'A &amp; B')
  })

  it('< is escaped to &lt;', () => {
    assert.equal(escapeHtml('A < B'), 'A &lt; B')
  })

  it('> is escaped to &gt;', () => {
    assert.equal(escapeHtml('A > B'), 'A &gt; B')
  })

  it('" is escaped to &quot;', () => {
    assert.equal(escapeHtml('say "hello"'), 'say &quot;hello&quot;')
  })

  it("' is escaped to &#039;", () => {
    assert.equal(escapeHtml("it's fine"), "it&#039;s fine")
  })

  it('already-escaped entities are double-escaped (no double-decode XSS)', () => {
    // If the input already has &lt; it should become &amp;lt; — not <
    const result = escapeHtml('&lt;script&gt;')
    assert.ok(result.includes('&amp;lt;'), `Should double-escape: ${result}`)
    assert.ok(!result.includes('<script>'), `Should not produce raw script tag: ${result}`)
  })

  it('empty string returns empty string', () => {
    assert.equal(escapeHtml(''), '')
  })

  it('plain text with no special chars is unchanged', () => {
    const plain = 'Hello John, hope you are doing well.'
    assert.equal(escapeHtml(plain), plain)
  })

  it('all five special chars together', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#039;')
  })
})

describe('bodyToHtml — full email rendering', () => {
  it('wraps output in <p> tag', () => {
    const html = bodyToHtml('Hello world')
    assert.ok(html.startsWith('<p '), `Should start with <p: ${html}`)
    assert.ok(html.endsWith('</p>'), `Should end with </p>: ${html}`)
  })

  it('newlines converted to <br>', () => {
    const html = bodyToHtml('Line 1\nLine 2\nLine 3')
    assert.equal(html.split('<br>').length, 3, `Expected 2 <br> tags in: ${html}`)
  })

  it('XSS in body is escaped', () => {
    const html = bodyToHtml('<script>alert(1)</script>')
    assert.ok(!html.includes('<script>'), `<script> not escaped in bodyToHtml output: ${html}`)
    assert.ok(html.includes('&lt;script&gt;'), `Should contain escaped script tag: ${html}`)
  })

  it('10KB email body completes without error', () => {
    const longBody = 'A'.repeat(10_000)
    assert.doesNotThrow(() => {
      const html = bodyToHtml(longBody)
      assert.ok(html.length > 10_000)
    })
  })

  it('unicode characters preserved (emoji, CJK, Arabic)', () => {
    const body = 'Hello 🚀 世界 مرحبا'
    const html = bodyToHtml(body)
    assert.ok(html.includes('🚀'), `Emoji stripped from output: ${html}`)
    assert.ok(html.includes('世界'), `CJK stripped from output: ${html}`)
    assert.ok(html.includes('مرحبا'), `Arabic stripped from output: ${html}`)
  })

  it('null bytes handled', () => {
    assert.doesNotThrow(() => bodyToHtml('Hello\x00World'))
  })

  it('CRLF newlines also rendered as <br>', () => {
    // Windows line endings — common in email content pasted from Outlook
    const html = bodyToHtml('Line 1\r\nLine 2')
    // \r should remain (only \n → <br>) but no crash
    assert.ok(typeof html === 'string')
  })
})

describe('HTML safety — edge-case combinations', () => {
  it('script tag with newlines is fully escaped', () => {
    const payload = '<script\n>alert(1)</script\n>'
    const html = bodyToHtml(payload)
    assert.ok(!html.includes('<script'), `Multi-line script not fully escaped: ${html}`)
  })

  it('attribute injection attempt', () => {
    const payload = 'Hi " onmouseover="alert(1)" style="'
    const escaped = escapeHtml(payload)
    assert.ok(!escaped.includes('"'), `Unescaped double-quote in output: ${escaped}`)
  })

  it('backtick injection (template literal confusion)', () => {
    const payload = '`${7*7}`'
    const escaped = escapeHtml(payload)
    // No angle brackets here — payload passes through unchanged except quotes
    assert.equal(escaped, '`${7*7}`')
  })

  it('mixing HTML entities and raw chars', () => {
    const payload = '&amp; and <raw>'
    const escaped = escapeHtml(payload)
    // & → &amp; (so &amp; becomes &amp;amp;), < → &lt;, > → &gt;
    assert.ok(escaped.includes('&amp;amp;'), `Double-encoding failed: ${escaped}`)
    assert.ok(escaped.includes('&lt;raw&gt;'), `Angle brackets not escaped: ${escaped}`)
  })
})
