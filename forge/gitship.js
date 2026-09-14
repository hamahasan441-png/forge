/**
 * forge — verified git delivery (v98 shipwise, zero dependencies)
 *
 * THE delivery gap: through v97, forge verified work and then LEFT IT
 * UNCOMMITTED in the working tree. Every serious agent (Claude Code, Devin,
 * Cursor, Codex) delivers commits; forge delivered a pile of edited files.
 * gitship is the kernel-side delivery policy — exactly like worktree.js, it
 * is EXECUTION POLICY, not a tool surface: the agent wire stays 1:1, the
 * model never gains a commit/branch/push tool, and delivery fires ONLY at
 * the completion gate's ok moment (meta.js attemptCompletion), structurally
 * AFTER the 9 checks — there is no code path that commits an unverified tree.
 *
 * Law (all pinned by existing tests, none re-gated here):
 *   - git via execFile ARGUMENT ARRAYS, 15s timeout, bounded buffers (the
 *     worktree.js law — runGit is exported from there, one implementation).
 *   - ONLY the run's verified files are staged (explicit pathspec, never -A);
 *     foreign dirty files are never touched; `.forge/**` never ships.
 *   - identity: repo config if set, else `forge-agent <forge@local>` via
 *     per-invocation -c overrides; repo/global config is NEVER written.
 *   - trailers: every delivery commit carries Forge-Task-Id / Forge-Run so
 *     crash-recovery can recognize it (HEAD-moved reconciliation, recovery.js).
 *   - a delivery failure NEVER flips the task status: the commit is a
 *     best-effort post-gate annotation — refusal means today's behavior
 *     (verified files in the working tree, undo-able via checkpoints).
 *   - branch:"auto" BOOKMARKS the delivery commit (git branch forge/<task>
 *     <sha>) — the user's checkout is never switched, never disturbed.
 *   - push is OFF by default; "explicit" additionally requires a live
 *     AUTHORIZATION ask (decisionengine anti-nag applies); force NEVER.
 *   - PR-READY, not PR-creating: the PR text is rendered as an artifact the
 *     user can pipe to their forger — no remote API calls, no token trust.
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { runGit, probeGit, uncommittedFiles } from "./worktree.js"
import { gitOperationInProgress, gitState } from "./recovery.js"
import { writeStateFile } from "./securefs.js"

const MODES = Object.freeze(["off", "on", "ask"])
const PUSH_MODES = Object.freeze(["off", "explicit"])
const PR_MODES = Object.freeze(["off", "gh"])

/** Resolve the gitship policy from config (user-level only — config.js puts
 *  `gitship` in PRIVILEGED_SECTIONS, so a checked-in project config can never
 *  turn delivery on for everyone who clones). Unknown values fall back to
 *  "off" — delivery is opt-in, never a guess. */
export function gitshipMode(config) {
  const gs = config?.gitship
  const pick = (v, allowed, dflt) => (allowed.includes(String(v ?? "").toLowerCase()) ? String(v).toLowerCase() : dflt)
  return {
    commit: pick(gs?.commit, MODES, "off"),
    branch: pick(gs?.branch, ["off", "auto"], "off"),
    push: pick(gs?.push, PUSH_MODES, "off"),
    // v99 loopwise: PR creation via the user's OWN `gh` CLI (passthrough —
    // forge never holds a GitHub token; gh's auth is gh's business)
    pr: pick(gs?.pr, PR_MODES, "off"),
  }
}

/** Normalize a file reference to a repo-relative posix path, dropping
 *  anything that would escape the repo or ship forge state. A1 hardening:
 *  a DIRECTORY pathspec would make `git add -- <dir>` stage every file under
 *  it (foreign ones included) — directories are refused with the reason,
 *  never silently widened. A missing path is KEPT (it stages a deletion,
 *  which is exactly what a run that deleted a file must deliver). */
function shipSafeRel(root, f) {
  let rel = String(f ?? "").replace(/\\/g, "/")
  try {
    const abs = path.resolve(root, rel)
    const r = path.relative(path.resolve(root), abs)
    if (!r || r.startsWith("..") || path.isAbsolute(r)) return null
    rel = r.replace(/\\/g, "/")
  } catch { return null }
  if (rel.startsWith(".forge/") || rel === ".forge") return null
  if (rel.includes("\n") || rel.includes("\0")) return null
  try {
    const st = fs.statSync(path.join(root, rel))
    if (!st.isFile()) return null // a directory pathspec would over-stage — refused, named by the caller
  } catch { /* missing = deleted file: kept on purpose */ }
  return rel
}

/** Render the PR-ready text from what the delivery moment already holds:
 *  objective, gate checks, verification status, files, risk. No invention —
 *  every line traces to a gate/ledger artifact. */
export function renderPrText({ objective, taskId, runId, files, verificationStatus, finalRisk, gate }) {
  const lines = []
  lines.push(`## forge delivery — task ${taskId ?? "?"}`)
  lines.push("")
  lines.push(`**Objective:** ${String(objective ?? "").slice(0, 400) || "(not recorded)"}`)
  lines.push("")
  lines.push(`**Verification:** ${verificationStatus ?? "unknown"} · **Final risk:** ${finalRisk ?? "unknown"} · **Completion gate:** ${gate?.ok ? "satisfied (9-check)" : "refused"}`)
  lines.push("")
  lines.push(`**Files (${Array.isArray(files) ? files.length : 0}):**`)
  for (const f of (Array.isArray(files) ? files : []).slice(0, 100)) lines.push(`- \`${f}\``)
  lines.push("")
  lines.push("---")
  lines.push(`<sub>Generated by forge gitship · task ${taskId ?? "?"} · run ${runId ?? "?"} · review the diff, then push your forger.</sub>`)
  return lines.join("\n")
}

const skip = (reason, extra = {}) => ({ shipped: false, skipped: true, reason, ...extra })

/**
 * THE delivery entry point. Called ONLY after the completion gate said ok.
 * Never throws; every outcome is a settled result object the caller turns
 * into a GITSHIP_* event. `ask` is the decisionengine bound ask (may be null
 * in contexts with no consent surface — "ask"/"explicit" then degrade to a
 * refusal with the reason, never to a silent yes).
 */
export async function maybeShip({
  root = process.cwd(),
  config = null,
  taskId = null,
  runId = null,
  objective = "",
  changedFiles = [],
  verificationStatus = null,
  finalRisk = null,
  gate = null,
  ask = null,
  before = null, // pre-run gitState (checkpoint anchor) — enables idempotence
} = {}) {
  const mode = gitshipMode(config)
  if (mode.commit === "off") return skip("gitship.commit is off (default) — verified work stays in the working tree")
  const probe = probeGit(root)
  if (!probe.ok) return skip(`not a git repository (${probe.reason})`)
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => shipSafeRel(root, f)).filter(Boolean))]
  if (!files.length) return skip("no shippable files in this run (empty or forge-internal paths only)")
  try {
    if (gitOperationInProgress(root)) return skip("a git operation is mid-flight (merge/rebase/cherry-pick/revert/bisect) — never deliver into it")
  } catch { return skip("git operation probe failed — refusing to deliver into an unknown state") }

  // crash idempotence: if the delivery commit for THIS task already landed
  // (HEAD carries our trailer), do not commit twice — report DONE.
  const state = gitState(root)
  if (!state.isRepo) return skip("git state unreadable")
  const headSubject = String(state.head ?? "")
  try {
    // escape the id: a task id with regex metacharacters must never throw
    // or cross-match another task's trailer
    const esc = String(taskId ?? "__none__").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const trail = await runGit(["log", "-1", "--pretty=%B"], { cwd: root })
    if (!trail.err && new RegExp(`Forge-Task-Id: ${esc}`).test(trail.out)) {
      return { shipped: true, idempotent: true, sha: headSubject.split(" ")[0] ?? null, files, branch: null, reason: "delivery commit for this task already landed (HEAD carries its trailer)" }
    }
  } catch { /* log probe is best-effort */ }

  // consent gate for "ask" mode
  if (mode.commit === "ask") {
    if (typeof ask !== "function") return skip("gitship.commit=ask but no consent surface is available in this context — refusing (never a silent yes)")
    const decision = ask({
      type: "authorization",
      key: `gitship-commit-${taskId ?? "task"}`,
      title: "Commit the verified work?",
      question: `forge completed and verified ${files.length} file(s). Commit them on the current branch with a forge trailer?`,
      detail: files.slice(0, 8).join(", ") + (files.length > 8 ? ` +${files.length - 8} more` : ""),
    })
    if (decision?.skipped) return skip(`consent ask skipped (${decision.why ?? "anti-nag"})`)
    if (!decision?.ok && decision?.pending !== true) return skip("user declined the delivery commit")
  }

  // staging exactness: ONLY the run's files; foreign dirty files are named,
  // never staged, never stashed
  let foreign = []
  try {
    const dirty = await uncommittedFiles(root)
    if (dirty) {
      const want = new Set(files)
      foreign = [...dirty].filter((f) => !want.has(f))
    }
  } catch { /* status probe failure → foreign set unknown, staging stays exact */ }
  const add = await runGit(["add", "--", ...files], { cwd: root })
  if (add.err) return skip(`git add failed: ${String(add.errText).slice(0, 160)}`, { files })
  // A1 hardening — STAGING EXACTNESS against pre-staged foreign content:
  // the user may have staged their OWN changes before the run; a bare
  // `git commit` would ship them together with ours. The delivery commit
  // therefore uses the PATHSPEC form (`git commit -- <files>`), which by git
  // law records ONLY the named paths and leaves every other staged entry
  // untouched (still staged, still uncommitted, working tree never modified).
  // If nothing of OURS is staged, the run's files already match HEAD — the
  // honest skip, never an empty-commit git error.
  const want = new Set(files)
  const stagedProbe = await runGit(["diff", "--cached", "--name-only", "--", ...files], { cwd: root })
  if (stagedProbe.err) return skip(`staging audit failed: ${String(stagedProbe.errText).slice(0, 160)}`, { files })
  const oursStaged = String(stagedProbe.out).split("\n").map((s) => s.trim()).filter(Boolean).filter((p) => want.has(p))
  if (!oursStaged.length) {
    return skip("nothing to commit — the run's files already match HEAD (previously delivered or unchanged)", { files })
  }

  // identity: repo config wins; fallback is per-invocation -c (never written)
  const nameProbe = await runGit(["config", "user.name"], { cwd: root })
  const emailProbe = await runGit(["config", "user.email"], { cwd: root })
  const idArgs = []
  let identityNote = "repo identity"
  if (nameProbe.err || emailProbe.err || !String(nameProbe.out).trim() || !String(emailProbe.out).trim()) {
    idArgs.push("-c", "user.name=forge-agent", "-c", "user.email=forge@local")
    identityNote = "fallback identity forge-agent <forge@local> (repo identity unset)"
  }

  const subject = `forge: ${String(objective || "verified work").slice(0, 72).replace(/\n+/g, " ").trim()}`
  const body = [
    "",
    "Delivered by forge after the 9-check completion gate was satisfied.",
    `Verification: ${verificationStatus ?? "unknown"} · final risk: ${finalRisk ?? "unknown"}.`,
    `Forge-Task-Id: ${taskId ?? "unknown"}`,
    `Forge-Run: ${runId ?? "unknown"}`,
  ].join("\n")
  // pathspec commit (A1): records ONLY the run's verified paths; foreign
  // staged entries are neither committed nor unstaged — the user's staging
  // survives the delivery exactly as they left it
  const commitArgs = [...idArgs, "commit", "-m", subject, "-m", body, "--", ...files]
  const committed = await runGit(commitArgs, { cwd: root })
  if (committed.err) {
    // nothing half-lands: commit is atomic; unstage what we staged
    await runGit(["reset", "--", ...files], { cwd: root })
    return skip(`git commit failed: ${String(committed.errText).slice(0, 200)}`, { files })
  }

  const after = gitState(root)
  const sha = String(after.head ?? "").split(" ")[0] ?? null

  // bookmark branch (never a checkout — the user's worktree is untouched)
  let branch = null
  if (mode.branch === "auto" && taskId) {
    const branchName = `forge/${String(taskId).replace(/[^a-zA-Z0-9._/-]/g, "-").slice(0, 60)}`
    const b = await runGit(["branch", branchName], { cwd: root })
    if (!b.err) branch = branchName
  }

  // push: ONLY explicit mode AND a live approved ask; never force
  let pushed = false
  if (mode.push === "explicit") {
    let approved = false
    if (typeof ask === "function") {
      const d = ask({
        type: "authorization",
        key: `gitship-push-origin`,
        title: "Push the delivery commit?",
        question: `Push ${sha ?? "the delivery commit"} to the default remote? (never force)`,
      })
      approved = Boolean(d?.ok) && !d?.skipped
    }
    if (!approved) {
      return { shipped: true, pushed: false, pushRefused: true, sha, files, branch, reason: "delivery commit landed; push not approved (gitship.push=explicit requires consent)" }
    }
    const remote = await runGit(["remote"], { cwd: root })
    const firstRemote = String(remote.out).split("\n").map((s) => s.trim()).filter(Boolean)[0]
    if (!firstRemote) {
      return { shipped: true, pushed: false, pushRefused: true, sha, files, branch, reason: "no git remote configured — commit stays local" }
    }
    const currentBranch = String(after.branch ?? "").trim() || "HEAD"
    const push = await runGit(["push", firstRemote, currentBranch], { cwd: root })
    pushed = !push.err
  }

  // PR-ready artifact (data the user can act on — never an API call)
  let prPath = null
  try {
    const dir = path.join(root, ".forge", "delivery")
    fs.mkdirSync(dir, { recursive: true })
    prPath = path.join(dir, `pr-${taskId ?? "task"}.md`)
    writeStateFile(prPath, renderPrText({ objective, taskId, runId, files, verificationStatus, finalRisk, gate }))
  } catch { prPath = null }

  // v99 loopwise: PR CREATION via the user's own `gh` CLI — passthrough, not
  // an API client. forge never holds a GitHub token; gh's authentication is
  // gh's business (`gh auth login`). Requirements, all checked, all honest:
  //   gitship.pr = "gh" (explicit, user-level only) + a live approved ask
  //   (same consent as push) + the commit actually pushed (a PR needs the
  //   branch on the remote) + gh on PATH + gh authenticated. The PR body IS
  //   the PR-ready artifact that was just written — one source of truth.
  //   A failure (including "PR already exists") reports the reason; the
  //   delivery commit's status is NEVER affected by PR outcome.
  let pr = { created: false, url: null, reason: "gitship.pr is off (default) — the PR-ready artifact was written instead" }
  if (mode.pr === "gh") {
    if (!prPath) {
      // audit A14: the PR body IS the artifact — without it there is nothing
      // honest to open a PR with; never pass a null body-file to gh
      pr = { created: false, url: null, reason: "the PR-ready artifact could not be written — refusing to open a PR without it" }
    } else if (!pushed) {
      pr = { created: false, url: null, reason: "gitship.pr=gh but the commit was not pushed — a PR needs the branch on the remote" }
    } else {
      let approved = false
      if (typeof ask === "function") {
        const d = ask({
          type: "authorization",
          key: `gitship-pr-gh`,
          title: "Open a pull request via gh?",
          question: `Run \`gh pr create\` with the delivery PR text for ${sha ?? "this commit"}? (forge shells out to your own gh CLI — no token is stored by forge)`,
        })
        approved = Boolean(d?.ok) && !d?.skipped
      }
      if (!approved) {
        pr = { created: false, url: null, reason: "PR not approved (gitship.pr=gh requires live consent, like push)" }
      } else {
        const auth = spawnSync("gh", ["auth", "status"], { cwd: root, encoding: "utf8", timeout: 15000 })
        if (auth.error) {
          pr = { created: false, url: null, reason: "gh CLI not found on PATH — install github.com/cli/cli and `gh auth login`" }
        } else if (auth.status !== 0) {
          pr = { created: false, url: null, reason: `gh is not authenticated — run \`gh auth login\` (${String(auth.stderr ?? "").trim().split("\n")[0] ?? ""})`.slice(0, 200) }
        } else {
          const title = `[forge] ${String(objective ?? "").slice(0, 60) || "verified delivery"}${taskId ? ` (${taskId})` : ""}`
          const create = spawnSync("gh", ["pr", "create", "--title", title, "--body-file", prPath], { cwd: root, encoding: "utf8", timeout: 60000 })
          if (create.status === 0) {
            const urlMatch = /(https?:\/\/\S+)/.exec(String(create.stdout ?? ""))
            pr = { created: true, url: urlMatch ? urlMatch[1] : null, reason: "pull request created via gh" }
          } else {
            const tail = `${String(create.stderr ?? "")} ${String(create.stdout ?? "")}`.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 220)
            const exists = /already exists/i.test(tail)
            pr = { created: false, url: null, reason: exists ? `a pull request already exists for this branch — ${tail}` : `gh pr create failed — ${tail || `exit ${create.status}`}` }
          }
        }
      }
    }
  }

  return {
    shipped: true,
    pushed,
    sha,
    files,
    branch,
    identity: identityNote,
    foreignDirtyFiles: foreign.slice(0, 12),
    prPath,
    pr,
    reason: `committed ${files.length} verified file(s)${branch ? ` · bookmark branch ${branch}` : ""}${pushed ? " · pushed" : ""}${pr.created ? ` · PR ${pr.url ?? "created"}` : ""}`,
  }
}
