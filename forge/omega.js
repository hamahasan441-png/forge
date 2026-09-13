/**
 * forge — Ω/∞ cognitive kernel (zero dependencies)
 *
 * A thin façade over the subsystems that already exist (diagnose, completion,
 * verifyledger, dag, recovery) plus the Ω modules (classify, hypothesis,
 * impact, evidence, cmdout) and the ∞ layer (causal, selfdiag, taskmodel,
 * review, telemetry). Meta owns the lifecycle; this module decides *how
 * heavy* a run should be, keeps the hypothesis/evidence/causal ledgers so
 * repair cannot retry a rejected cause, and runs the adversarial checklist
 * without a second model call.
 *
 * Nothing here talks to a model or the filesystem beyond impactRadius.
 */
import { classifyTask, synthesizePlan, TASK_CLASS, strategyFor } from "./classify.js"
import { createHypothesisEngine, HSTATUS } from "./hypothesis.js"
import { impactRadius, testingScope } from "./impact.js"
import { createEvidenceLog, KIND, fact, verified } from "./evidence.js"
import { classifyFailure, FAILURE } from "./diagnose.js"
import { summarizeCommand, createCommandResult } from "./cmdout.js"
import { createCausalEngine, counterfactual, LAYER } from "./causal.js"
import { classifyOrigin, formatOrigin, ORIGIN } from "./selfdiag.js"
import { createTaskModel, seedFromObjective, TAG } from "./taskmodel.js"
import { adversarialReview, needsReview, formatReview } from "./review.js"
import { createTelemetry, METRIC } from "./telemetry.js"
import { createInfoGainEngine, formatExperiment } from "./infogain.js"

export { TASK_CLASS, HSTATUS, KIND, LAYER, ORIGIN, TAG, METRIC, FAILURE }

export function createKernel({ cwd = process.cwd() } = {}) {
  const hypo = createHypothesisEngine()
  const evidence = createEvidenceLog()
  const causal = createCausalEngine()
  const tasks = createTaskModel()
  const telemetry = createTelemetry()
  const gain = createInfoGainEngine()
  let lastClass = null
  let lastOrigin = null
  let lastImpact = null
  let lastDiagnosis = null
  const writes = {}

  function classify(task, opts = {}) {
    lastClass = classifyTask(task, opts)
    telemetry.inc(METRIC.CLASSIFY)
    if (lastClass.class === TASK_CLASS.RECOVERY) telemetry.inc(METRIC.RECOVERY)
    evidence.record(fact(`class=${lastClass.class}`, { source: "classify" }))
    seedFromObjective(task, tasks)
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
    const d = classifyFailure(result, meta)
    const origin = classifyOrigin(result, { ...meta, diagnosis: d })
    lastOrigin = origin
    lastDiagnosis = d
    evidence.record(d.failed
      ? fact(`failure:${d.code}`, { source: "command", files: meta.files || [] })
      : verified(`command ok exit=${d.exitCode ?? 0}`, { source: "command", files: meta.files || [] }))
    telemetry.inc(d.failed ? METRIC.COMMAND_FAIL : METRIC.COMMAND_OK)
    if (origin.origin === ORIGIN.FORGE) telemetry.inc(METRIC.ORIGIN_FORGE)
    else if (origin.origin === ORIGIN.PROJECT) telemetry.inc(METRIC.ORIGIN_PROJECT)
    else if (d.failed) telemetry.inc(METRIC.ORIGIN_UNKNOWN)

    let hypothesis = null
    let causalObs = null
    if (d.failed) {
      causalObs = causal.observe(result, { ...meta, diagnosis: d })
      telemetry.inc(METRIC.CAUSAL)
      if (causalObs.proposed) causal.support(causalObs.proposed.id, { text: d.evidence, source: "classifyFailure" })
      hypothesis = hypo.add({ description: `${d.code}: ${d.evidence}`.slice(0, 240), confidence: 0.55 })
      hypo.support(hypothesis.id, { text: d.evidence, source: "classifyFailure" })
      return {
        diagnosis: d, hypothesis, origin, causal: causalObs,
        summary: summarizeCommand(result), originHint: formatOrigin(origin),
      }
    }
    return { diagnosis: d, hypothesis: null, origin, causal: null, summary: summarizeCommand(result), originHint: "" }
  }

  function impact(files) {
    const r = impactRadius({ files, cwd })
    lastImpact = r
    evidence.record(fact(`impact radius=${r.radius} scope=${r.scope.join(",")}`, { source: "impact", files }))
    return r
  }

  function counterfactualOf(files, { root = null } = {}) {
    const r = files ? impact(files) : (lastImpact || impact([]))
    const target = causal.nextTarget()
    return counterfactual(r, { root: root || target.node?.description || null })
  }

  function noteWrite(file) {
    writes[String(file)] = Date.now()
    evidence.invalidate(writes)
    for (const h of hypo.snapshot()) {
      if (h.status === HSTATUS.OPEN || h.status === HSTATUS.SUPPORTED) hypo.stale(h.id)
    }
    for (const n of causal.snapshot()) {
      if (n.status === "OPEN" || n.status === "SUPPORTED") causal.stale(n.id)
    }
  }

  function attachExperiment(base) {
    const looping = base.action === "escalate" && /twice/.test(String(base.reason || ""))
    const experiment = gain.select({
      klass: lastClass?.class,
      origin: base.origin || lastOrigin,
      code: lastDiagnosis?.code || lastOrigin?.code,
      action: base.action,
      hypothesis: base.hypothesis,
      causal: base.causal,
      looping,
    })
    telemetry.inc(METRIC.INFOGAIN)
    return { ...base, experiment }
  }

  function nextRepair() {
    const target = causal.nextTarget()
    const h = hypo.best()
    if (lastOrigin && lastOrigin.origin === ORIGIN.FORGE) {
      telemetry.inc(METRIC.LOOP_ESCALATE)
      return attachExperiment({ action: "escalate", reason: lastOrigin.why, origin: lastOrigin, causal: target, hypothesis: h })
    }
    if (!h && !target.node) return attachExperiment({ action: "inspect", reason: "no open hypothesis", origin: lastOrigin, causal: target })
    const last = h && h.tests[h.tests.length - 1]
    if (h && last && hypo.looping(h.id, last.test)) {
      telemetry.inc(METRIC.LOOP_ESCALATE)
      return attachExperiment({ action: "escalate", reason: "same hypothesis already tested twice", hypothesis: h, origin: lastOrigin, causal: target })
    }
    if (target.layer === LAYER.ROOT && target.node) {
      return attachExperiment({ action: "test", hypothesis: h, reason: target.reason, origin: lastOrigin, causal: target })
    }
    return attachExperiment({ action: h ? "test" : "inspect", hypothesis: h, reason: h ? `discriminate ${h.id}` : target.reason, origin: lastOrigin, causal: target })
  }

  function noteExperiment(id, result = null) {
    return gain.record(id, result)
  }

  function confirmRootCause(id) {
    const h = hypo.confirm(id)
    const target = causal.nextTarget()
    if (target.node) causal.confirm(target.node.id)
    return h
  }

  function rejectCause(id, why) {
    const h = hypo.reject(id, { text: why, source: "repair" })
    const target = causal.nextTarget()
    if (target.node && (target.node.status === "OPEN" || target.node.status === "SUPPORTED")) {
      causal.reject(target.node.id, why)
    }
    return h
  }

  function review(input = {}) {
    telemetry.inc(METRIC.REVIEW)
    const klass = input.klass || lastClass?.class
    return adversarialReview({
      klass,
      objective: input.objective ?? lastClass?.task ?? "",
      files: input.files || [],
      impact: input.impact || lastImpact || {},
      taskModel: tasks,
      hypotheses: hypo.snapshot(),
      causal: causal.chain(),
      verificationOk: input.verificationOk,
      checkpoint: input.checkpoint,
    })
  }

  function snapshot() {
    return {
      class: lastClass,
      origin: lastOrigin,
      hypotheses: hypo.snapshot(),
      evidence: evidence.snapshot(),
      causal: causal.chain(),
      tasks: tasks.snapshot(),
      telemetry: telemetry.snapshot(),
      infogain: gain.snapshot(),
      writes: { ...writes },
    }
  }

  return {
    classify, workflow, planFor, observeCommand, impact, noteWrite,
    nextRepair, confirmRootCause, rejectCause, snapshot, review,
    counterfactualOf, needsReview, noteExperiment,
    hypotheses: hypo, evidence, causal, tasks, telemetry, infogain: gain,
    testingScope, createCommandResult,
  }
}

export function omegaBanner(version) {
  return `forge v${version} — ∞ autonomous engineering`
}

export { strategyFor, needsReview, formatReview, formatOrigin, counterfactual, formatExperiment }
