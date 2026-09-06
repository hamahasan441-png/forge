/**
 * forge — resource manager (v21, zero dependencies)
 *
 * One place that watches RAM/CPU/disk/network/token/latency/tool-calls/
 * workers/time and turns those facts into ADAPTIVE decisions the meta
 * controller can act on. profile.js already computes a static machine tier
 * (low/normal/high); this module is the live, per-run counterpart that reacts
 * as a long task progresses.
 *
 * Adaptations are advisory limits that the controller enforces — they can
 * reduce concurrency, suggest compaction or a cheaper model, but they can NEVER
 * widen a security boundary (they never touch allowSudo / assumeYes / network
 * policy).
 */
import os from "node:os"
import fs from "node:fs"
import { resourceProfile } from "./profile.js"

export const ADAPT = {
  NONE: "none",
  REDUCE_CONCURRENCY: "reduce_concurrency",
  INCREASE_CONCURRENCY: "increase_concurrency",
  COMPACT_CONTEXT: "compact_context",
  PREFER_FAST_MODEL: "prefer_fast_model",
  REDUCE_TOOL_OUTPUT: "reduce_tool_output",
  PRECISE_RETRIEVAL: "precise_retrieval",
}

export function createResourceManager({ config = {}, cwd = process.cwd() } = {}) {
  const base = resourceProfile()
  const state = {
    tier: base.tier,
    cores: base.cores,
    freeMB: base.freeMB,
    totalMB: base.totalMB,
    diskFreeMB: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokenBudget: config.agent?.tokenBudget ?? (base.tier === "low" ? 600_000 : 2_000_000),
    toolCalls: 0,
    workers: 0,
    maxWorkers: config.agent?.maxParallelSubAgents ?? (base.tier === "low" ? 1 : base.tier === "high" ? 3 : 2),
    segments: 0,
    startedAt: Date.now(),
    lastLatencyMs: 0,
    slowStreak: 0,
    repoSizeFiles: 0,
    adaptations: [],
  }

  const sample = () => {
    // tests / constrained environments can pin the reading; otherwise live.
    if (state._freeMBOverride == null) state.freeMB = Math.round(os.freemem() / (1024 * 1024))
    else state.freeMB = state._freeMBOverride
    try {
      // disk free for the working volume (best-effort)
      if (typeof fs.statfsSync === "function") {
        const st = fs.statfsSync(cwd)
        state.diskFreeMB = Math.round((st.bavail * st.bsize) / (1024 * 1024))
      }
    } catch {}
    return state
  }
  /** Test/operation hook: pin free memory (MB) to force an adaptation. */
  const _setFreeMB = (mb) => { state._freeMBOverride = mb; sample() }
  sample()

  const record = (ev = {}) => {
    if (ev.tokensIn) state.tokensIn += ev.tokensIn
    if (ev.tokensOut) state.tokensOut += ev.tokensOut
    if (ev.toolCalls) state.toolCalls += ev.toolCalls
    if (ev.workers != null) state.workers = ev.workers
    if (ev.latencyMs != null) {
      state.lastLatencyMs = ev.latencyMs
      // a "slow" response is >20s; three in a row is a slow-provider signal
      if (ev.latencyMs > 20_000) state.slowStreak++
      else state.slowStreak = Math.max(0, state.slowStreak - 1)
    }
    if (ev.repoSizeFiles != null) state.repoSizeFiles = ev.repoSizeFiles
    if (ev.segment) state.segments++
    return evaluate()
  }

  /**
   * Turn live facts into decisions. Returns { level, actions:[{action,why,apply}],
   * limits:{maxWorkers, maxToolOutputChars, compactNow, preferredClass, retrievalPrecision} }.
   */
  const evaluate = () => {
    sample()
    const actions = []
    const limits = {
      maxWorkers: state.maxWorkers,
      maxToolOutputChars: config.agent?.maxToolOutput ?? 12000,
      compactNow: false,
      preferredClass: null,
      retrievalPrecision: "normal",
    }
    const tokenRatio = (state.tokensIn + state.tokensOut) / Math.max(1, state.tokenBudget)

    // --- RAM: low free memory → serialize workers, shrink tool output
    if (state.freeMB < 400) {
      limits.maxWorkers = 1
      limits.maxToolOutputChars = Math.min(limits.maxToolOutputChars, 6000)
      actions.push({ action: ADAPT.REDUCE_CONCURRENCY, why: `only ${state.freeMB}MB free RAM — 1 worker`, apply: "immediate" })
    } else if (state.freeMB > 2500 && state.maxWorkers < 3 && state.tier !== "low") {
      limits.maxWorkers = Math.min(3, state.maxWorkers + 1)
      actions.push({ action: ADAPT.INCREASE_CONCURRENCY, why: `${state.freeMB}MB free RAM — room for another worker`, apply: "next" })
    }

    // --- disk: tight disk is a signal to be careful, never to bypass checks
    if (state.diskFreeMB && state.diskFreeMB < 200) {
      limits.maxToolOutputChars = Math.min(limits.maxToolOutputChars, 4000)
      actions.push({ action: ADAPT.REDUCE_TOOL_OUTPUT, why: `only ${state.diskFreeMB}MB disk free`, apply: "immediate" })
    }

    // --- tokens: approaching budget → compact; near cap → cheap model
    if (tokenRatio > 0.6) {
      limits.compactNow = true
      actions.push({ action: ADAPT.COMPACT_CONTEXT, why: `${Math.round(tokenRatio * 100)}% of token budget used — compact`, apply: "immediate" })
    }
    if (tokenRatio > 0.85) {
      limits.preferredClass = "fast_reasoning"
      actions.push({ action: ADAPT.PREFER_FAST_MODEL, why: `near token budget — prefer a cheaper/faster model`, apply: "next" })
    }

    // --- latency: a slow provider streak → suggest a faster model class
    if (state.slowStreak >= 3) {
      limits.preferredClass = limits.preferredClass ?? "fast_reasoning"
      actions.push({ action: ADAPT.PREFER_FAST_MODEL, why: `${state.slowStreak} slow responses — consider a faster model`, apply: "next" })
    }

    // --- large repo: trade breadth for retrieval precision instead of loading it all
    if (state.repoSizeFiles > 3000) {
      limits.retrievalPrecision = "precise"
      actions.push({ action: ADAPT.PRECISE_RETRIEVAL, why: `${state.repoSizeFiles} files in repo — narrow retrieval rather than bulk loading`, apply: "immediate" })
    }

    const level = actions.some((a) => a.apply === "immediate") ? "adapting" : actions.length ? "watch" : "nominal"
    // keep a bounded history of distinct adaptations
    for (const a of actions) {
      const key = `${a.action}`
      if (!state.adaptations.some((x) => x.action === key && Date.now() - x.at < 60_000)) {
        state.adaptations.push({ ...a, at: Date.now() })
        if (state.adaptations.length > 40) state.adaptations.shift()
      }
    }
    return { level, actions, limits, snapshot: snapshot() }
  }

  const snapshot = () => ({
    tier: state.tier,
    cores: state.cores,
    freeMB: state.freeMB,
    totalMB: state.totalMB,
    diskFreeMB: state.diskFreeMB,
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    tokenBudget: state.tokenBudget,
    toolCalls: state.toolCalls,
    workers: state.workers,
    maxWorkers: state.maxWorkers,
    segments: state.segments,
    elapsedMs: Date.now() - state.startedAt,
    lastLatencyMs: state.lastLatencyMs,
    slowStreak: state.slowStreak,
    repoSizeFiles: state.repoSizeFiles,
  })

  return {
    state,
    sample,
    record,
    evaluate,
    snapshot,
    setFreeMB: _setFreeMB,
    /** Compact one-line for the UI. */
    summary() {
      const s = snapshot()
      return `ram ${s.freeMB}MB free • workers ${s.workers}/${s.maxWorkers} • tok ${(s.tokensIn / 1000).toFixed(0)}k • tools ${s.toolCalls} • ${s.elapsedMs > 0 ? Math.round(s.elapsedMs / 1000) + "s" : "0s"}`
    },
  }
}
