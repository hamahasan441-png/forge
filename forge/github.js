/**
 * forge — GitHub inspect (v113 githubwise)
 *
 * GitHub is EVIDENCE, not a second agent and not a token store.
 * Read: allowlisted `gh` argv (your CLI, your `gh auth login`).
 * Write: gitship.js only (commit/push/PR create, consent-gated).
 *
 * Pipeline: github inspect → evidence fact → governor INSPECT/SEARCH.
 * MICRO does not fetch GitHub.
 */
import { spawnSync } from "node:child_process"

export const GITHUB_VERSION = "1.0.0"

const READ = {
  status: ["auth", "status"],
  repo: ["repo", "view", "--json", "name,description,url,defaultBranchRef,isPrivate,visibility"],
  issues: ["issue", "list", "--limit", "8", "--json", "number,title,state,updatedAt,url"],
  issue: ["issue", "view", null, "--json", "number,title,state,body,url,comments"],
  prs: ["pr", "list", "--limit", "8", "--json", "number,title,state,url,headRefName,isDraft"],
  pr: ["pr", "view", null, "--json", "number,title,state,url,body,statusCheckRollup,reviews,headRefName"],
  checks: ["pr", "checks", null],
  runs: ["run", "list", "--limit", "8", "--json", "databaseId,name,conclusion,status,headBranch,url,displayTitle"],
  run: ["run", "view", null, "--json", "conclusion,status,url,displayTitle,name"],
  releases: ["release", "list", "--limit", "5", "--json", "tagName,name,isDraft,isPrerelease"],
}

const ID_ACTIONS = new Set(["issue", "pr", "checks", "run"])
const ID_OK = /^[A-Za-z0-9._/-]{1,80}$/

export function githubImpliedByTask(task = "") {
  const t = String(task || "").toLowerCase()
  if (!t.trim()) return false
  return /\b(github|gh\b|pull request|\bprs?\b|#\d+|issue\s*#?\d+|ci\b|actions?\b|workflow|check suite|dependabot)\b/.test(t)
}

export function actionForTask(task = "") {
  const t = String(task || "").toLowerCase()
  const n = (t.match(/#(\d+)/) || t.match(/\b(?:issue|pr|pull request|pull)\s+#?(\d+)/) || [])[1]
  if (/\b(ci|action|workflow|check)\b/.test(t) && n) return { action: "checks", id: n }
  if (/\b(ci|action|workflow|run)\b/.test(t)) return { action: "runs", id: "" }
  if (/\b(pr|pull request)\b/.test(t) && n) return { action: "pr", id: n }
  if (/\bissue\b/.test(t) && n) return { action: "issue", id: n }
  if (/\b(pr|pull request)s?\b/.test(t)) return { action: "prs", id: "" }
  if (/\bissues?\b/.test(t)) return { action: "issues", id: "" }
  if (/\brelease/.test(t)) return { action: "releases", id: "" }
  return { action: "repo", id: n || "" }
}

export function ghAvailable({ spawn = spawnSync, cwd = process.cwd() } = {}) {
  try {
    const r = spawn("gh", ["auth", "status"], { cwd, encoding: "utf8", timeout: 8000 })
    if (r.error) return { ok: false, why: "gh CLI not on PATH — install github.com/cli/cli" }
    if (r.status !== 0) return { ok: false, why: "gh is not authenticated — run `gh auth login`" }
    return { ok: true, why: "gh authenticated" }
  } catch (e) {
    return { ok: false, why: String(e?.message || e).slice(0, 160) }
  }
}

function argvFor(action, id) {
  const tmpl = READ[action]
  if (!tmpl) return { ok: false, why: `unknown github action ${action} (read-only: ${Object.keys(READ).join(", ")})` }
  const args = tmpl.map((a) => (a === null ? String(id || "") : a))
  if (ID_ACTIONS.has(action)) {
    if (!id || !ID_OK.test(String(id))) return { ok: false, why: `${action} needs a safe id (digits or ref)` }
  }
  if (args.some((a) => a == null || a === "")) {
    return { ok: false, why: `${action} needs an id` }
  }
  return { ok: true, args }
}

export function ghInspect({
  action = "repo",
  id = "",
  cwd = process.cwd(),
  spawn = spawnSync,
} = {}) {
  const a = String(action || "repo")
  if (a === "status") {
    const probe = ghAvailable({ spawn, cwd })
    return { ok: probe.ok, action: a, preview: probe.why, facts: [{ kind: "github-auth", value: probe.ok ? "ok" : probe.why }] }
  }
  const built = argvFor(a, id)
  if (!built.ok) return { ok: false, action: a, preview: built.why, facts: [] }
  try {
    const r = spawn("gh", built.args, { cwd, encoding: "utf8", timeout: 20000, maxBuffer: 400_000 })
    if (r.error) return { ok: false, action: a, preview: "gh CLI not on PATH", facts: [] }
    const out = String(r.stdout || "").trim()
    const err = String(r.stderr || "").trim()
    if (r.status !== 0) {
      return { ok: false, action: a, preview: (err || out || `gh exit ${r.status}`).slice(0, 500), facts: [] }
    }
    return { ok: true, action: a, preview: out.slice(0, 4000), facts: factsFrom(a, out) }
  } catch (e) {
    return { ok: false, action: a, preview: String(e?.message || e).slice(0, 200), facts: [] }
  }
}

function factsFrom(action, text) {
  const facts = [{ kind: "github", value: `${action} ok`, source: "gh" }]
  if (/\b(fail|failure|cancelled)\b/i.test(text) && /conclusion|status/i.test(text)) {
    facts.push({ kind: "github-ci", value: "CI reported failure", source: "gh" })
  }
  const nums = text.match(/"number":\s*(\d+)/g)
  if (nums && nums.length) facts.push({ kind: "github-refs", value: `${nums.length} numbered item(s)`, source: "gh" })
  return facts.slice(0, 6)
}

export function formatGithub(inspect) {
  if (!inspect) return ""
  const head = inspect.ok ? "GITHUB (evidence)" : "GITHUB (unavailable)"
  return `${head}: ${inspect.action} — ${String(inspect.preview || "").slice(0, 400)}`
}
