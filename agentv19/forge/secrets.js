/**
 * forge — secret redaction (v20): keeps credentials out of model context,
 * logs, sessions, memory, and exports.
 *
 * Applied to every tool RESULT before it enters conversation history (bash
 * output, file reads, web pages, sub-agent reports) and to memory writes.
 * Two layers:
 *   1. known token SHAPES (sk-, AKIA, ghp_, xox, AIza, JWTs, private keys)
 *   2. credential-style assignments (API_KEY=…, "token": …, password=…) with
 *      values >= 8 chars
 *
 * Over-redaction is acceptable here by design: a masked token in a tool
 * result costs a little context; a leaked key costs the user.
 */

const SHAPE_RULES = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, "[redacted private key]"],
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, "[redacted private key header]"],
  [/\bsk-(?:proj|ant)-[A-Za-z0-9-]{20,}\b/g, "[redacted api key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted api key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted aws access key]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[redacted aws session key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted github token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted slack token]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted google api key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted jwt]"],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, "[redacted hf token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[redacted gitlab token]"],
  [/\bghp_[A-Za-z0-9]{36}\b/g, "[redacted github token]"],
  // v20.0.1 additions — all verified unredacted in v20:
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[redacted stripe key]"],
  [/\bwhsec_[A-Za-z0-9]{24,}\b/g, "[redacted stripe webhook secret]"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[redacted sendgrid key]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted npm token]"],
  [/\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g, "[redacted pypi token]"],
  [/\bdop_v1_[a-f0-9]{64}\b/g, "[redacted digitalocean token]"],
  [/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, "[redacted shopify token]"],
  [/\b(?:sk|pk)-lf-[a-f0-9-]{30,}\b/g, "[redacted langfuse key]"],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}\b/g, "[redacted slack app token]"],
  [/\bAC[a-f0-9]{32}:[A-Za-z0-9]{32}\b/g, "[redacted twilio credentials]"],
  [/\bSK[a-f0-9]{32}\b/g, "[redacted twilio key]"],
  [/\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,}\b/g, "[redacted square token]"],
  [/\b(?:ya29\.[A-Za-z0-9_-]{30,})\b/g, "[redacted google oauth token]"],
  [/\bsl\.[A-Za-z0-9_-]{100,}\b/g, "[redacted dropbox token]"],
  [/\bLTAI[A-Za-z0-9]{12,20}\b/g, "[redacted alibaba access key]"],
  [/\bAGE-SECRET-KEY-1[A-Z0-9]{58}\b/g, "[redacted age secret key]"],
  [/\bhvs\.[A-Za-z0-9_-]{24,}\b/g, "[redacted vault token]"],
  [/\b(?:doo|dop|dor)_v1_[a-f0-9]{64}\b/g, "[redacted digitalocean token]"],
  [/\bvercel_[A-Za-z0-9]{24}\b/gi, "[redacted vercel token]"],
]

// credentials embedded in URLs: scheme://user:password@host — the password
// part is what leaks (postgres://app:hunter2@db, https://user:ghp_…@github.com)
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)([^\s/@:]{0,64}):([^\s/@]{1,256})@/gi
// 40-char base64-ish AWS secret next to a secret-key style name (the generic
// ASSIGN rule already covers many spellings; this one is stricter on the value
// so `AWS_SECRET_ACCESS_KEY = …` with spaces/quotes/export is always caught)
const AWS_SECRET_RE = /\b(aws_?secret_?access_?key|aws_?secret_?key|aws_?secret)\b(["']?\s*(?:=|:|=>)\s*["']?)([A-Za-z0-9/+=]{40})\b/gi

// JSON-style: "token": "value" / "api_key": "value" (quoted name AND quoted value)
const JSON_ASSIGN = /"((?:api[_-]?key|apikey|token[a-z0-9_]*|secret[a-z0-9_]*|passw(?:o)?rd[a-z0-9_]*|passwd[a-z0-9_]*|credential[a-z0-9_]*|access[_-]?key|client[_-]?secret|bearer|authorization))"\s*:\s*"([^"\\]{8,})"/gi

// env-style / kv-style credential assignments: NAME = value / NAME: "value"
const ASSIGN_RE = /\b((?:API|SECRET|TOKEN|PASS|KEY|CRED|AUTH|PRIVATE)[A-Z0-9_]{0,24}|(?:api[_-]?key|apikey|token|secret|passw(?:o)?rd|passwd|credential|access[_-]?key|client[_-]?secret|bearer)[a-z0-9_]*)\s*(=|:=|=>|:)\s*("([^"\\]{8,})"|'([^'\\]{8,})'|([^\s"'`,;)][^`\n,;]{7,}))/gi

const MAX_SCAN = 2 * 1024 * 1024 // never regex a >2MB string (DoS guard)

/** Redact secrets from text. Returns { text, found } — `found` counts rules hit. */
export function redactSecrets(input) {
  if (typeof input !== "string" || !input) return { text: input, found: 0 }
  if (input.length > MAX_SCAN) input = input.slice(0, MAX_SCAN)
  let found = 0
  let text = input
  for (const [re, mask] of SHAPE_RULES) {
    re.lastIndex = 0
    if (re.test(text)) {
      re.lastIndex = 0
      text = text.replace(re, mask)
      found++
    }
    re.lastIndex = 0
  }
  // pass 0: URL userinfo (user:password@) and AWS secret keys
  text = text.replace(URL_USERINFO_RE, (full, scheme, user, pw) => {
    if (isPlaceholder(pw)) return full
    found++
    return `${scheme}${user}:***@`
  })
  URL_USERINFO_RE.lastIndex = 0
  text = text.replace(AWS_SECRET_RE, (full, name, sep, value) => {
    found++
    return `${name}${sep}${maskValue(value)}`
  })
  AWS_SECRET_RE.lastIndex = 0
  // pass 1: JSON-style quoted assignments
  text = text.replace(JSON_ASSIGN, (full, name, value) => {
    if (isPlaceholder(value)) return full
    found++
    return `"${name}": "${maskValue(value)}"`
  })
  JSON_ASSIGN.lastIndex = 0
  // pass 2: env/kv-style assignments
  text = text.replace(ASSIGN_RE, (full, name, sep, quoted, dq, sq, bare) => {
    const value = (dq !== undefined && dq) || (sq !== undefined && sq) || bare
    if (!value || isPlaceholder(value)) return full
    found++
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ""
    return `${name}${sep}${quote}${maskValue(value)}${quote}`
  })
  ASSIGN_RE.lastIndex = 0
  return { text, found }
}

function isPlaceholder(v) {
  const s = String(v)
  return /^(?:true|false|null|undefined|your[-_ ]?(?:api[-_ ]?)?key|xxx+|\*+|<[^>]+>|\$\{[^}]+\}|change[-_]?me|placeholder|EXAMPLE|REDACTED|\d+(?:\.\d+)?)$/i.test(s)
}

function maskValue(v) {
  const s = String(v)
  if (s.length <= 10) return "***"
  return `${s.slice(0, 3)}…***…${s.slice(-2)}`
}

/** Convenience: redact and return just the text. */
export function redact(input) {
  return redactSecrets(input).text
}
