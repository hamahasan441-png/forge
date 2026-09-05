/**
 * forge — secret redaction (v20, hardened v20.1): keeps credentials out of
 * model context, logs, sessions, memory, and exports.
 *
 * Applied to every tool RESULT before it enters conversation history (bash
 * output, file reads, web pages, sub-agent reports) and to memory writes.
 * Layers:
 *   1. known token SHAPES (sk-, AKIA, ghp_, xox, AIza, JWTs, private keys)
 *   2. credential-style assignments (API_KEY=…, "token": …, password=…)
 *   3. Authorization: Bearer / Basic / Token headers
 *   4. unprefixed high-entropy blobs (keys with no tell-tale prefix)
 *
 * v20.1 P0-3 closed the gaps the first version left open:
 *   - a value shorter than 8 characters was never masked, so
 *     `password=hunter2` reached the model verbatim. High-risk names
 *     (password/token/secret/api_key/…) now need only 4 characters.
 *   - escaped JSON values ("pass": "hun\"ter2") were skipped.
 *   - `Authorization: Bearer <opaque>` was only caught when it looked like a JWT.
 *   - an unprefixed 40-char API key in a config dump was not caught at all.
 *
 * Over-redaction is acceptable here by design: a masked token in a tool
 * result costs a little context; a leaked key costs the user. The negative
 * corpus in tests/test-security.inner.mjs pins the false positives we accept
 * (git SHAs, UUIDs, hashes, paths, URLs, numbers, sentences).
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
]

// v20.1: one name vocabulary shared by both assignment styles, plus a
// high-risk subset that is masked even when the value is short.
const NAME_ALT = "api[_-]?key|apikey|token[a-z0-9_]*|secret[a-z0-9_]*|passw(?:o)?rd[a-z0-9_]*|passwd[a-z0-9_]*|pwd|credential[a-z0-9_]*|access[_-]?key|client[_-]?secret|bearer|authorization|private[_-]?key"
const HIGH_RISK_NAME = /passw(?:o)?rd|passwd|pwd|secret|token|api[_-]?key|apikey|credential|access[_-]?key|client[_-]?secret|bearer|authorization|private[_-]?key/i
const MIN_LEN_HIGH = 4 // "pw: abcd" is still a credential
const MIN_LEN_LOW = 8 // everything else needs a real-looking value

// JSON-style: "token": "value" / "api_key": "value" (escapes allowed inside)
const JSON_ASSIGN = new RegExp(`"((?:${NAME_ALT}))"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "gi")

// env-style / kv-style credential assignments: NAME = value / NAME: "value"
const ASSIGN_RE = new RegExp(
  "\\b((?:API|SECRET|TOKEN|PASS|KEY|CRED|AUTH|PRIVATE)[A-Z0-9_]{0,24}" +
  `|(?:${NAME_ALT})[a-z0-9_]*)` +
  "(\\s*(?:=|:=|=>|:)\\s*)(\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)'|([^\\s\"'`,;)][^`\\n,;]{0,200}))",
  "gi",
)

// Authorization: Bearer|Basic|Token <credential> (not only JWTs)
const BEARER_RE = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi

// Unprefixed high-entropy blobs: 32+ chars mixing lower/upper/digits/symbols.
// Git SHAs and hex digests stay untouched (only two character classes); UUIDs
// are identifiers, not credentials.
const BLOB_RE = /[A-Za-z0-9+/=_-]{32,}/g
// a filesystem path is not a credential: /usr/local/bin/some-package-1.2.3
const LOOKS_LIKE_PATH = (m) => m.startsWith("/") || m.startsWith("./") || m.includes("//") || m.includes("/.")
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_SCAN = 2 * 1024 * 1024 // never regex a >2MB string (DoS guard)

/** Mask or keep: high-risk names need 4 characters, everything else 8.
 *  A pure number is a placeholder for an ordinary name (`port=8080`) but a
 *  genuine credential for a high-risk one (`password=1234`). */
function shouldMask(name, value) {
  if (value === undefined || value === null) return false
  const v = String(value)
  if (!v) return false
  const high = HIGH_RISK_NAME.test(String(name ?? ""))
  if (high ? isPlaceholderText(v) : isPlaceholder(v)) return false
  const min = high ? MIN_LEN_HIGH : MIN_LEN_LOW
  return v.length >= min
}

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
  // pass 1: JSON-style quoted assignments
  text = text.replace(JSON_ASSIGN, (full, name, value) => {
    if (!shouldMask(name, value)) return full
    found++
    return `"${name}": "${maskValue(value)}"`
  })
  JSON_ASSIGN.lastIndex = 0
  // pass 2: env/kv-style assignments
  text = text.replace(ASSIGN_RE, (full, name, sep, quoted, dq, sq, bare) => {
    const value = dq !== undefined ? dq : sq !== undefined ? sq : bare
    if (!shouldMask(name, value)) return full
    found++
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : ""
    return `${name}${sep}${quote}${maskValue(value)}${quote}`
  })
  ASSIGN_RE.lastIndex = 0
  // pass 3: Authorization: Bearer/Basic/Token <credential>
  text = text.replace(BEARER_RE, (full, scheme, tok) => {
    if (isPlaceholder(tok)) return full
    found++
    return `${scheme} [redacted ${scheme.toLowerCase()} credential]`
  })
  BEARER_RE.lastIndex = 0
  // pass 4: unprefixed high-entropy blobs (API keys with no tell-tale prefix)
  text = text.replace(BLOB_RE, (m) => {
    if (UUID_RE.test(m) || LOOKS_LIKE_PATH(m)) return m
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/=_-]/].filter((re) => re.test(m)).length
    if (classes < 3) return m
    found++
    return "[redacted high-entropy value]"
  })
  return { text, found }
}

const PLACEHOLDER_RE = /^(?:true|false|null|undefined|your[-_ ]?(?:api[-_ ]?)?key|xxx+|\*+|<[^>]+>|\$\{[^}]+\}|change[-_]?me|placeholder|EXAMPLE|REDACTED|\d+(?:\.\d+)?)$/i
const PLACEHOLDER_TEXT_RE = /^(?:true|false|null|undefined|your[-_ ]?(?:api[-_ ]?)?key|xxx+|\*+|<[^>]+>|\$\{[^}]+\}|change[-_]?me|placeholder|EXAMPLE|REDACTED)$/i

function isPlaceholder(v) {
  return PLACEHOLDER_RE.test(String(v))
}

/** As isPlaceholder, but pure numbers are NOT placeholders (numeric PINs,
 *  numeric passwords). Only used for high-risk names. */
function isPlaceholderText(v) {
  return PLACEHOLDER_TEXT_RE.test(String(v))
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
