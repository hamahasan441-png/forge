/**
 * forge — v132 "mindwise": one judgment table, and memory that returns.
 *
 * Five review systems still run where they belong:
 *   plan          → plancritique.js
 *   pre-mutation  → critique.js (toolintel)
 *   worker        → selfreview.js
 *   post-mutation → codereview.js
 *   gate          → review.js + completion.js
 *
 * They used to disagree in silence. The worker self-review was computed,
 * emitted, and then the ledger recorded `passed: true` anyway — the comment
 * in meta.js said the report "must survive" before being trusted as evidence.
 * `trustWorkerEvidence()` is the one answer to that question.
 *
 * think() already recorded on the tool context (v131). Nothing durable
 * read it. `persistThoughts()` writes the scratchpad onto the project's
 * episode store so the next planner's `contextBlock` / failed-approaches
 * prefix can actually see it.
 *
 * Failed approaches were stored (episodes.addFailedApproach) and the
 * planner hoped BM25 similar-episodes would retrieve them. When the next
 * objective was worded differently, they vanished. `failedApproachesPrefix`
 * is a dedicated planner prefix — same shape as planLessonsPrefix — so
 * "do not retry this" does not depend on ranking luck.
 */
import { createEpisodeStore } from "./episodes.js"

const FATAL_FLAG = /empty result|no evidence produced|no inspection happened/

/**
 * May this worker report be trusted as ACCEPTANCE evidence?
 *
 * Fatal flags (empty / no inspection / no evidence) are why a node should
 * not complete. Non-fatal flags (unverified claim wording) still flow as
 * findings, but the ledger must not claim they passed.
 */
export function trustWorkerEvidence(selfReview) {
  if (!selfReview) return { trust: false, fatal: true, reason: "no self-review", flags: [] }
  const flags = Array.isArray(selfReview.flags) ? selfReview.flags.map((f) => String(f)) : []
  const fatal = flags.some((f) => FATAL_FLAG.test(f))
  if (selfReview.ok === true && !fatal) return { trust: true, fatal: false, reason: "self-review passed", flags }
  return { trust: false, fatal, reason: fatal ? "self-review fatal" : "self-review flags", flags }
}

/** Durable think() — no-op when the run never thought. */
export function persistThoughts({ cwd = process.cwd(), task = "", runId = null, thoughts = [] } = {}) {
  const items = (Array.isArray(thoughts) ? thoughts : [])
    .map((t) => typeof t === "string" ? t : t?.text)
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(-8)
  if (!items.length) return { ok: false, n: 0, episodeId: null }
  try {
    const store = createEpisodeStore({ cwd })
    let ep = store.latest()
    const problem = String(task ?? "").slice(0, 1200)
    if (!ep) ep = store.start({ problem, taskId: runId })
    for (const text of items) store.addThought(ep, text, { runId })
    return { ok: true, n: items.length, episodeId: ep.episode_id }
  } catch {
    return { ok: false, n: 0, episodeId: null }
  }
}

/** Planner prefix: failed approaches for THIS objective, not "whatever BM25 liked". */
export function failedApproachesPrefix(query, { cwd = process.cwd(), limit = 6 } = {}) {
  try {
    const store = createEpisodeStore({ cwd })
    const failed = typeof store.failedApproachesFor === "function"
      ? store.failedApproachesFor(query, { limit })
      : []
    if (!failed.length) return ""
    return `FAILED APPROACHES FROM THIS PROJECT (do not retry these):\n${failed.map((f) => `- ${f}`).join("\n")}`
  } catch { return "" }
}
