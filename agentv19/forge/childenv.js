/**
 * forge — environment for spawned helper processes (MCP / LSP servers).
 *
 * v21.1 P0: both clients used `{ ...process.env, ...this.env }`, so every MCP
 * and LSP server — configured by a project's forge.config.json, i.e. by
 * whoever committed that file — inherited OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY,
 * GITHUB_TOKEN, DATABASE_URL… from the user's shell. A helper process needs
 * PATH, HOME, locale and its own declared variables; it does not need the
 * user's credentials.
 *
 * Policy:
 *   - a small allow-list of runtime variables is always passed through
 *   - anything whose NAME looks credential-bearing is dropped
 *   - anything whose VALUE looks like a known token shape is dropped
 *   - variables the server config declares explicitly (`env: {...}`) always win;
 *     the operator wrote them into the config on purpose
 */
import { redactSecrets } from "./secrets.js"

/** Variables a subprocess legitimately needs to run at all. */
const PASSTHROUGH = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP",
  "PWD", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "NODE_PATH", "NODE_OPTIONS", "NODE_ENV", "NVM_DIR", "NVM_BIN", "VIRTUAL_ENV", "PYTHONPATH", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME", "SDKMAN_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "CI", "DEBUG", "COLORTERM", "FORCE_COLOR", "NO_COLOR", "FORGE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
])
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PASSWD|PASSWORD|CRED|CREDENTIAL|AUTH|PRIVATE|SESSION|COOKIE|SIGNING|CERT|_URL|_URI|_DSN)/i
/** Values that are obviously credentials regardless of the variable's name. */
function secretValue(v) {
  if (typeof v !== "string" || v.length < 8) return false
  return redactSecrets(v).found > 0
}

/**
 * Build the environment for a helper process.
 * @param declared  variables from the server's config entry (always kept)
 * @param base      the parent environment (default process.env)
 */
export function childEnv(declared = {}, base = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (PASSTHROUGH.has(k)) { out[k] = v; continue }
    if (SECRET_NAME.test(k)) continue
    if (/^FORGE_/.test(k)) continue // forge's own switches (FORGE_ASSUME_YES…) are not a server's business
    if (secretValue(v)) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(declared || {})) {
    if (v === undefined || v === null) continue
    out[k] = String(v)
  }
  return out
}
