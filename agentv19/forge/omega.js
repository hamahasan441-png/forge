/**
 * forge — Ω cognitive kernel (zero dependencies)
 *
 * A thin façade over the subsystems that already exist (diagnose, completion,
 * verifyledger, dag, recovery) plus the Ω modules (classify, hypothesis,
 * impact, evidence, cmdout). Meta owns the lifecycle; this module decides
 * *how heavy* a run should be and keeps the hypothesis/evidence ledger for
 * the repair loop so it cannot retry a rejected cause.
 *
 * Nothing here talks to a model or the filesystem beyond impactRadius.
 */
import { classifyTask, synthesizePlan, TASK_CLASS, strategyFor } from "./classify.js"
import { createHypothesisEngine, HSTATUS } from "./hypothesis.js"
import { impactRadius, testingScope } from "./impact.js"
import { createEvidenceLog, KIND, fact, verified } from "./evidence.js"
import { classifyFailure, FAILURE } from "./diagnose.js"
import { summarizeCommand, createCommandResult } from "./cmdout.js"

export { TASK_CLASS, HSTATUS, KIND }

export function createKernel({ cwd = process.cwd() } = {}) {
  const hypo = createHypothesisEngine()
  const evidence = createEvidenceLog()
  let lastClass = null
  const writes = {}

  function classify(task) {
    lastClass = classifyTask(task)
    evidence.record(fact(`class=${lastClass.class}`, { source: "classify" }))
    return lastClass
  }

  function workflow(task) {
    const c = lastClass && lastClass.task === String(task ?? lastClass.task) ? lastClass : classify(task)
    return c.strategy
  }

  function planFor(task) {
    const c = lastClass && lastClass.task === String(task ?? lastClass.task) ? lastClass : classify(task)
    if (c.strategy.plan === "synthesize") return synthesizePlan(task, c.class)
    return null
  }

  function observeCommand(result, meta = {}) {
    const text = typeof result === "string" ? result : (result?.stdout ?? "")
    const d = classifyFailure(result, meta)
    evidence.record(d.failed
      ? fact(`failure:${d.code}`, { source: "command", files: meta.files || [] })
      : verified(`command ok exit=${d.exitCode ?? 0}`, { source: "command", files: meta.files || [] }))
    if (d.failed) {
      const h = hypo.add({ description: `${d.code}: ${d.evidence}`.slice(0, 240), confidence: 0.55 })
      hypo.support(h.id, { text: d.evidence, source: "classifyFailure" })
      return { diagnosis: d, hypothesis: h, summary: summarizeCommand(result) }
    }
    return { diagnosis: d, hypothesis: null, summary: summarizeCommand(result) }
  }

  function impact(files) {
    const r = impactRadius({ files, cwd })
    evidence.record(fact(`impact radius=${r.radius} scope=${r.scope.join(",")}`, { source: "impact", files }))
    return r
  }

  function noteWrite(file) {
    writes[String(file)] = Date.now()
    evidence.invalidate(writes)
    for (const h of hypo.snapshot()) {
      if (h.status === HSTATUS.OPEN || h.status === HSTATUS.SUPPORTED) hypo.stale(h.id)
    }
  }

  function nextRepair() {
    const h = hypo.best()
    if (!h) return { action: "inspect", reason: "no open hypothesis" }
    const last = h.tests[h.tests.length - 1]
    if (last && hypo.looping(h.id, last.test)) {
      return { action: "escalate", reason: "same hypothesis already tested twice", hypothesis: h }
    }
    return { action: "test", hypothesis: h, reason: `discriminate ${h.id}` }
  }

  function confirmRootCause(id) {
    return hypo.confirm(id)
  }

  function rejectCause(id, why) {
    return hypo.reject(id, { text: why, source: "repair" })
  }

  function snapshot() {
    return {
      class: lastClass,
      hypotheses: hypo.snapshot(),
      evidence: evidence.snapshot(),
      writes: { ...writes },
    }
  }

  return {
    classify, workflow, planFor, observeCommand, impact, noteWrite,
    nextRepair, confirmRootCause, rejectCause, snapshot,
    hypotheses: hypo, evidence, testingScope, createCommandResult,
  }
}

export function omegaBanner(version) {
  return `forge v${version} — Ω autonomous engineering`
}
