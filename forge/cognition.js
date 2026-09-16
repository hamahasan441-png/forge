/**
 * forge — ONE cognitive core (v104 bindwise, zero dependencies)
 *
 * Composes engines that already exist (omega kernel = hypothesis/evidence/causal
 * /infogain/taskmodel) with the user model, task contract, governor, and self-model.
 *
 * Individual modules specialize. They are NOT independent brains.
 *
 * STATE → PREDICT → DECISION → ACTION → OBSERVATION → DELTA → LEARNING
 *
 * v101: the governor's action is AUTHORITY, not narration.
 * v102: every mutating action carries a deterministic prediction; settlement
 * against reality feeds the governor (high drift → REPLAN).
 * v103: the system models ITSELF from measured evidence (calibration + empirics),
 * invalidates a stale plan when the instruction changes (v1 stays frozen),
 * and runs the cheapest information-gain experiment before another patch.
 * v104: bind the engines that existed but were skipped on the live path —
 * world-model tests, honest covering checks (not "ok" in stdout), recorded
 * VOI experiments, ranked strategies on PLAN.
 *
 * v106: capability + knowledge gaps feed the governor; measured capability
 * health changes the next route (learning is a behavior change, not a file).
 *
 * Persistable. Restored cognitive state is reconciled against current reality,
 * never treated as still true.
 */
import fs from "node:fs"
import path from "node:path"
import { createKernel } from "./omega.js"
import { createUserModel, AUTHORITY } from "./usermodel.js"
import { createTaskContract, REQ, GAP } from "./contract.js"
import { chooseNextAction, formatAction, authorityFor, formatGovernorMessage, rankStrategies, CHEAPEST_FIRST, ACTION, DEPTH, depthFor } from "./governor.js"
import { predictForAction, settlePrediction as settleLedger, recordPrediction, driftVerdict, predictionsForPrompt, formatPrediction, formatSettlement } from "./prediction.js"
import { rankExperiments, formatExperiment } from "./infogain.js"
import { createSelfModel } from "./selfmodel.js"
import { createWorldModel } from "./worldmodel.js"
import { summarizeCommand } from "./cmdout.js"
import { detectGaps } from "./knowgap.js"
import { formatCapLearn, loadCapLearn } from "./caplearn.js"
import { recommendDepth, recordReasoning, formatMetaPolicy, recordStrategy, strategyRates } from "./metalearn.js"
import { scoreRoute, formatJointRoute, recordRoute } from "./jointroute.js"
import { projectDir } from "./memory.js"

export const COGNITION_VERSION = "1.5.0"
export const STATE_SCHEMA = "1.5.0"
export const EVENT_SCHEMA = "1.5.0"

export { ACTION, DEPTH, AUTHORITY, REQ, GAP, authorityFor, rankStrategies, CHEAPEST_FIRST }

const CHECK_CMD = /\b(test|spec|pytest|jest|vitest|mocha|lint|typecheck|tsc\b|coverage|verify)\b/i

/** A bash/test result covers writes only if it is an actual check that passed.
 *  `echo ok` / `ls` / a body containing the word "ok" is not verification. */
export function isCoveringCheck({ command = "", result = "" } = {}) {
  const text = String(result ?? "")
  const cmd = String(command ?? "")
  const sum = summarizeCommand(text)
  const exitKnown = /\[exit code: (-?\d+)\]/m.test(text)
  const testCmd = CHECK_CMD.test(cmd)
  const testOutput = !!(sum.counts && Number.isFinite(sum.counts.passed))
  if (!testCmd && !testOutput) return false
  if (sum.counts && sum.counts.failed > 0) return false
  if (exitKnown && sum.exit !== 0) return false
  if (exitKnown && sum.exit === 0) return true
  if (testOutput && sum.counts.failed === 0 && sum.counts.passed > 0) return true
  return false
}

function sameIntent(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
}

export function cognitionPath(cwd) {
  return path.join(projectDir(cwd), "cognition.json")
}

export function createCognition({ cwd = process.cwd(), objective = "", resume = null } = {}) {
  const kernel = createKernel({ cwd })
  const user = createUserModel()
  const resumedOriginal = String(resume?.contract?.originalIntent || resume?.objective || "").trim()
  const contract = createTaskContract({ originalIntent: resumedOriginal || objective })
  const self = createSelfModel({ cwd })
  const events = []
  let inspected = false
  let hasPlan = false
  let lastAction = null
  let lastAuth = null
  let writes = 0
  let unverified = []
  let failed = false
  let looping = false
  let pendingDecision = false
  let klass = "SMALL"
  let openPred = null
  let lastSettled = null
  let lastDrift = null
  let driftReplans = 0
  let ranked = []
  let lastExperiment = null
  let world = null
  let worldFailed = false
  let know = null
  let capGap = false
  let lastAcquire = null
  let lastMeta = null
  let lastJoint = null

  function refreshGaps() {
    try {
      know = detectGaps(objective, {
        cwd,
        klass,
        persist: klass === "LARGE" || klass === "ARCHITECTURAL",
      })
      if (know?.learn?.length) emit("KNOWLEDGE_GAP", { n: know.learn.length, ids: know.learn.map((g) => g.id).slice(0, 4) })
    } catch { know = null }
  }

  function acquirePlan() {
    const g = know?.learn?.[0]
    return g?.acquire || (g ? { id: g.id, method: g.method, tool: g.tool, query: g.query, why: g.why } : null)
  }

  function observeAcquire(acq) {
    lastAcquire = acq && typeof acq === "object" ? acq : null
    inspected = true
    if (know?.learn?.length && lastAcquire) {
      know = { ...know, learn: [] }
    }
    if (Array.isArray(lastAcquire?.facts)) {
      for (const f of lastAcquire.facts.slice(0, 4)) {
        try { contract.noteEvidence({ kind: f.kind || "github", value: String(f.value || "").slice(0, 200), source: "gh" }) } catch { /* evidence is best-effort */ }
      }
    }
    emit("ACQUIRE_RAN", { tool: lastAcquire?.tool, ok: lastAcquire?.ok === true, skipped: lastAcquire?.skipped || null, hits: lastAcquire?.hits ?? 0 })
    return lastAcquire
  }

  function worldOf() {
    if (worldFailed) return null
    if (world) return world
    try { world = createWorldModel({ cwd }); return world }
    catch { worldFailed = true; return null }
  }

  function emit(type, payload = {}) {
    const ev = { type, at: Date.now(), ...payload }
    events.push(ev)
    if (events.length > 120) events.splice(0, events.length - 120)
    return ev
  }

  function boot(text = objective) {
    const t = String(text ?? "").trim()
    if (!t) return snapshot()
    const u = user.understand(t)
    contract.freezeIntent(t, { source: "user", reason: "original" })
    const cls = kernel.classify(t)
    klass = cls?.class || klass
    if (u.ambiguities?.length) {
      for (const a of u.ambiguities) contract.addUnknown({ text: a, impact: u.decisionAuthority === AUTHORITY.IRREVERSIBLE_CONFIRM ? "CRITICAL UNKNOWN" : "HIGH-VALUE UNKNOWN" })
    }
    emit("USER_INTENT_CREATED", { text: t, confidence: u.confidence, hypotheses: u.intentHypotheses?.length ?? 0 })
    emit("TASK_CREATED", { klass, objective: t })
    if (u.intentHypotheses?.length > 1) {
      emit("HYPOTHESIS_CREATED", { kind: "intent", count: u.intentHypotheses.length })
    }
    return snapshot()
  }

  function absorbInstruction(text) {
    const t = String(text ?? "").trim()
    if (!t) return { changed: false }
    const orig = contract.original()?.text
    if (!orig) {
      boot(t)
      return { changed: false, booted: true }
    }
    if (sameIntent(orig, t) || sameIntent(contract.currentIntent()?.text, t)) {
      return { changed: false, original: orig }
    }
    contract.reviseIntent(t, { source: "user", reason: "changed-instruction" })
    const u = user.understand(t)
    hasPlan = false
    ranked = []
    openPred = null
    lastDrift = null
    driftReplans = 0
    contract.addGap({ text: "instruction changed — prior plan and predictions may be stale", kind: GAP.CONFLICT, impact: "high" })
    const cls = kernel.classify(t)
    klass = cls?.class || klass
    emit("USER_INTENT_CONFLICT", { previous: orig, next: t, reason: "changed-instruction" })
    emit("USER_INTENT_CREATED", { text: t, confidence: u.confidence, reason: "changed-instruction" })
    return { changed: true, previous: orig, next: t, original: orig }
  }

  if (resume?.user || resume?.contract) {
    try {
      if (resumedOriginal) {
        user.understand(resumedOriginal)
        klass = kernel.classify(resumedOriginal)?.class || klass
      }
      if (resume.rejected) for (const r of resume.rejected) user.rejectStrategy(r)
    } catch { /* restore is best-effort; reality is reconstructed below */ }
    emit("TASK_RESUMED", { from: "cognition.json" })
    if (objective) absorbInstruction(objective)
  } else if (objective) {
    boot(objective)
  }
  refreshGaps()

  function next(opts = {}) {
    if (opts.inspected != null) inspected = Boolean(opts.inspected)
    if (opts.hasPlan != null) hasPlan = Boolean(opts.hasPlan)
    if (opts.writes != null) writes = Number(opts.writes) || 0
    if (opts.unverified) unverified = Array.isArray(opts.unverified) ? opts.unverified : []
    if (opts.failed != null) failed = Boolean(opts.failed)
    if (opts.looping != null) looping = Boolean(opts.looping)
    if (opts.pendingDecision != null) pendingDecision = Boolean(opts.pendingDecision)
    const repair = failed ? (kernel.nextRepair?.() || null) : null
    lastExperiment = repair?.experiment || lastExperiment
    if (!failed && writes === 0 && klass !== "MICRO" && klass !== "SMALL") {
      try {
        lastExperiment = kernel.infogain?.select?.({ klass }) || lastExperiment || rankExperiments({ klass })[0] || null
      } catch { /* catalog is optional */ }
    }
    const u = user.understanding
    const ambiguous = (u?.intentHypotheses?.length ?? 0) > 1 && (u?.confidence ?? 1) < 0.55
    try {
      lastMeta = recommendDepth({
        cwd,
        klass,
        fallback: depthFor({ klass, failed, conflict: ambiguous }),
        failed,
        conflict: ambiguous,
      })
    } catch { lastMeta = null }
    try {
      lastJoint = scoreRoute({
        cwd,
        klass,
        task: objective,
        depth: lastMeta?.depth || depthFor({ klass, failed, conflict: ambiguous }),
        model: opts.model || "",
        skills: opts.skills || [],
        failed,
        lockModel: opts.lockModel === true,
      })
    } catch { lastJoint = null }
    const learned = lastJoint?.depth || ((lastMeta?.source === "learned" || lastMeta?.source === "shift" || lastMeta?.source === "floor") ? lastMeta.depth : null)
    const action = chooseNextAction({
      klass,
      contract,
      user,
      repair,
      writes,
      unverified,
      steps: opts.steps ?? 0,
      failed,
      looping,
      pendingDecision,
      hasPlan,
      inspected,
      verified: opts.verified ?? (unverified.length === 0 && writes > 0),
      reviewRequired: opts.reviewRequired ?? (klass === "ARCHITECTURAL" || klass === "LARGE"),
      aborted: opts.aborted === true,
      driftScore: lastDrift?.driftScore ?? opts.driftScore ?? 0,
      driftLevel: lastDrift?.level ?? opts.driftLevel ?? null,
      driftReplans,
      experiment: lastExperiment,
      knowledgeGap: (Boolean(know?.learn?.length) && !lastAcquire) || opts.knowledgeGap === true,
      capabilityGap: capGap || opts.capabilityGap === true,
      learnedDepth: learned,
    })
    if (action.action === ACTION.REPLAN && (lastDrift?.level === "MISS" || (lastDrift?.driftScore ?? 0) >= 0.75)) {
      driftReplans += 1
    }
    lastAction = action
    lastAuth = authorityFor(action.action, { klass })
    if (action.action === ACTION.PLAN && ranked.length === 0) {
      const hypos = user.understanding?.intentHypotheses || []
      const list = hypos.length
        ? hypos.map((h) => ({
          id: h.id,
          text: String(h.meaning || h.goal || h.id).slice(0, 200),
          reversible: true,
          cost: 0.35,
          confidence: h.confidence,
        }))
        : [
          { id: "S1", text: `smallest reversible change: ${String(objective).slice(0, 120)}`, reversible: true, cost: 0.2, blast: 0.2 },
          { id: "S2", text: `broader change: ${String(objective).slice(0, 120)}`, reversible: false, cost: 0.75, blast: 0.7 },
        ]
      noteStrategies(list)
    }
    emit("GOVERNOR_ACTION", { action: action.action, why: action.why, depth: action.depth, voi: action.voi, enforce: lastAuth.enforce, halt: lastAuth.halt, drift: lastDrift?.level ?? null, meta: lastMeta?.source || null, joint: lastJoint?.source || null })
    return action
  }

  function enforce(gov = lastAction) {
    lastAuth = authorityFor(gov?.action || ACTION.EXECUTE, { klass })
    return lastAuth
  }

  function stepDirective(gov = lastAction, auth = lastAuth) {
    return formatGovernorMessage(gov || lastAction, auth || lastAuth)
  }

  function noteInspect() {
    inspected = true
    emit("OBSERVATION_CREATED", { kind: "inspect" })
  }

  function notePlan(plan) {
    hasPlan = true
    contract.setStrategy(plan || "plan")
    emit("PLAN_CREATED")
  }

  function noteStrategies(list = []) {
    let rates = null
    try { rates = strategyRates(cwd, klass) } catch { rates = null }
    ranked = rankStrategies(list, { rates })
    if (ranked[0]) contract.setStrategy(ranked[0].text || ranked[0].id)
    for (const s of ranked) contract.addAlternative(s)
    emit("PLAN_CREATED", { strategies: ranked.length, best: ranked[0]?.id ?? null })
    return ranked
  }

  function predict(opts = {}) {
    const pred = predictForAction({
      action: opts.action || lastAction?.action || ACTION.EXECUTE,
      objective: opts.objective || objective,
      expectedFiles: opts.expectedFiles,
      reads: opts.reads,
      writes: opts.writes,
      scope: opts.scope || contract.snapshot()?.scope?.files,
      expectedRisk: opts.expectedRisk,
      expectedSteps: opts.expectedSteps ?? 1,
      taskId: opts.taskId,
    })
    openPred = pred
    if (pred.expectedTests == null && pred.expectedFiles?.length && klass !== "MICRO") {
      try {
        const n = worldOf()?.testsFor?.(pred.expectedFiles)?.length
        if (Number.isFinite(n)) pred.expectedTests = n
      } catch { /* world is a view */ }
    }
    contract.notePrediction({ id: pred.id, expected: pred.expectedFiles, derived: pred.derived, action: pred.action })
    contract.setExpected(pred.expectedOutcome)
    emit("PREDICTION_MADE", { id: pred.id, files: pred.expectedFiles, derived: pred.derived, action: pred.action, text: formatPrediction(pred) })
    return pred
  }

  function settle(opts = {}) {
    if (!openPred) return null
    const settled = settleLedger(openPred, {
      actualFiles: opts.actualFiles || [],
      finalRisk: opts.finalRisk ?? null,
      status: opts.status ?? "ok",
      actualTests: opts.actualTests,
      actualSteps: opts.actualSteps,
    })
    lastSettled = settled
    lastDrift = driftVerdict(settled)
    try { recordPrediction(settled, cwd) } catch { /* ledger is best-effort */ }
    contract.settlePrediction(settled.id, settled.actualFiles)
    contract.setActual(settled.status)
    if (lastDrift.level === "MISS" || lastDrift.level === "SCOPE") {
      contract.addGap({ text: lastDrift.why, kind: "UNVERIFIED", impact: lastDrift.level === "MISS" ? "high" : "medium" })
    }
    emit("PREDICTION_SETTLED", {
      id: settled.id, drift: lastDrift.level, driftScore: lastDrift.driftScore,
      extra: settled.filesExtra, missed: settled.filesMissed, text: formatSettlement(settled),
    })
    openPred = null
    return { settled, drift: lastDrift }
  }

  function observeCommand(result, meta = {}) {
    const obs = kernel.observeCommand(result, meta)
    failed = Boolean(obs?.diagnosis?.failed)
    contract.noteEvidence({
      kind: obs?.diagnosis?.failed ? "command-fail" : "command-ok",
      value: obs?.summary || String(result ?? "").slice(0, 200),
      source: "command",
      files: meta.files || [],
    })
    emit(obs?.diagnosis?.failed ? "PREDICTION_MISMATCH" : "ACTION_COMPLETED", { failed: obs?.diagnosis?.failed || false })
    if (obs?.hypothesis) emit("HYPOTHESIS_CREATED", { id: obs.hypothesis.id, description: obs.hypothesis.description })
    return obs
  }

  function observeTools(records = []) {
    for (const r of records) {
      const name = r.name || r.tool || ""
      const raw = r.result != null ? String(r.result) : (r.ok === false ? "ERROR" : "")
      const failedTool = /^ERROR|^BLOCKED/.test(raw)
      if (["write_file", "edit_file", "multi_edit", "apply_patch"].includes(name) && !failedTool) {
        writes += 1
        const file = r.args?.path || r.file || r.args?.file
        if (file) {
          unverified.push(file)
          kernel.noteWrite?.(file)
          try { worldOf()?.invalidate?.([file]) } catch { /* stale world is worse than a missed invalidate */ }
          contract.noteEvidence({ kind: "write", value: file, source: name, files: [file] })
        }
      }
      if (name === "bash" || name === "test") {
        const text = String(r.result ?? "")
        const command = String(r.args?.command || r.args?.cmd || "")
        if (lastExperiment?.id) {
          try {
            const sum = summarizeCommand(text)
            kernel.noteExperiment?.(lastExperiment.id, sum.ok ? "pass" : "fail")
          } catch { /* experiment ledger is best-effort */ }
        }
        if (isCoveringCheck({ command, result: text })) {
          unverified = []
          contract.setVerification({ status: "PASSED" })
          const reqs = contract.snapshot().requirements
          for (const req of reqs) if (req.status === REQ.IMPLEMENTED || req.status === REQ.OPEN) contract.setRequirement(req.id, REQ.VERIFIED)
        }
        observeCommand(text, { tool: name })
      }
      if (name === "github" && !failedTool) {
        contract.noteEvidence({
          kind: /CI reported failure|unavailable/i.test(raw) ? "github-ci" : "github",
          value: raw.slice(0, 240),
          source: "github",
        })
        inspected = true
      }
    }
  }

  function learnFeedback(text) {
    const rec = user.recordFeedback(text)
    contract.addFeedback(rec)
    emit("USER_FEEDBACK_RECEIVED", { kind: rec.kind })
    return rec
  }

  function close(opts = {}) {
    const gate = contract.canComplete({
      wrote: (opts.wrote ?? writes) > 0,
      unverified: opts.unverified ?? unverified,
      klass,
    })
    try {
      recordReasoning({
        cwd,
        klass,
        depth: lastAction?.depth || lastMeta?.depth || DEPTH.L2,
        ok: gate.ok === true,
        repairs: driftReplans,
        replans: driftReplans,
      })
      if (ranked[0]?.id) recordStrategy({ cwd, klass, id: ranked[0].id, ok: gate.ok === true })
      recordRoute({
        cwd,
        klass,
        depth: lastAction?.depth || lastJoint?.depth || lastMeta?.depth || DEPTH.L2,
        model: lastJoint?.model || "*",
        skills: lastJoint?.skills || [],
        ok: gate.ok === true,
      })
    } catch { /* meta ledger is best-effort */ }
    emit(gate.ok ? "TASK_COMPLETED" : "TASK_INCOMPLETE", { why: gate.why, status: gate.status, depth: lastAction?.depth || null })
    return gate
  }

  function snapshot() {
    return {
      cognitionVersion: COGNITION_VERSION,
      stateSchema: STATE_SCHEMA,
      klass,
      inspected,
      hasPlan,
      writes,
      unverified: unverified.slice(),
      failed,
      pendingDecision,
      lastAction,
      lastAuth,
      lastDrift,
      lastSettled: lastSettled ? { id: lastSettled.id, driftScore: lastSettled.driftScore, derived: lastSettled.derived } : null,
      openPrediction: openPred ? { id: openPred.id, files: openPred.expectedFiles, derived: openPred.derived } : null,
      ranked,
      self: self.snapshot(),
      experiment: lastExperiment ? { id: lastExperiment.id, kind: lastExperiment.kind, gain: lastExperiment.gain } : null,
      user: user.snapshot(),
      contract: contract.snapshot(),
      kernel: kernel.snapshot(),
      events: events.slice(-40),
    }
  }

  function brief() {
    const u = user.understanding
    return {
      klass,
      intent: contract.original()?.text ?? objective,
      intentHypotheses: u?.intentHypotheses?.length ?? 0,
      confidence: u?.confidence ?? null,
      authority: u?.decisionAuthority ?? null,
      lastAction: lastAction?.action ?? null,
      enforce: lastAuth?.enforce ?? false,
      halt: lastAuth?.halt ?? false,
      drift: lastDrift?.level ?? null,
      predicted: openPred?.id ?? lastSettled?.id ?? null,
      experiment: lastExperiment?.id ?? null,
    }
  }

  function promptBlock() {
    const parts = [user.formatForPrompt(), contract.formatForPrompt()]
    try { parts.push(self.formatForPrompt({ klass, driftLevel: lastDrift?.level })) } catch { /* self-model is context */ }
    if (lastAction) parts.push(formatAction(lastAction))
    if (lastAuth?.directive) parts.push(`AUTHORITY: ${lastAuth.action} enforce=${lastAuth.enforce} halt=${lastAuth.halt} — ${lastAuth.directive}`)
    parts.push(`CAPABILITY ROUTER: ${CHEAPEST_FIRST}. Do not spend tokens on what a grep can answer.`)
    if (lastExperiment) {
      const line = formatExperiment(lastExperiment)
      if (line) parts.push(`VOI EXPERIMENT (cheapest discriminating check, before another patch):\n${line}`)
    }
    if (know?.learn?.length && !lastAcquire) {
      parts.push("KNOWLEDGE GAPS (cheapest acquire first — skill/repo before the web; do not research for its own sake):")
      for (const g of know.learn.slice(0, 3)) {
        parts.push(`- ${g.id} via ${g.method}/${g.tool}: ${g.query || g.why || ""}`)
      }
    }
    if (lastMeta) {
      const line = formatMetaPolicy(lastMeta)
      if (line) parts.push(line)
    }
    if (lastJoint) {
      const line = formatJointRoute(lastJoint)
      if (line) parts.push(line)
    }
    if (lastAcquire) {
      const bit = lastAcquire.skipped
        ? `skipped ${lastAcquire.skipped}`
        : `${lastAcquire.ok ? "ok" : "miss"} ${lastAcquire.hits ?? 0} hits via ${lastAcquire.tool}`
      parts.push(`ACQUIRE (ran, not a prompt): ${lastAcquire.tool} ${lastAcquire.query || ""} — ${bit}`)
    }
    try {
      const health = formatCapLearn(loadCapLearn(cwd), { klass, limit: 4 })
      if (health) parts.push(health)
    } catch { /* health is context */ }
    if (ranked.length) {
      parts.push("STRATEGIES (ranked by expected value — reversible and cheap first):")
      for (const s of ranked.slice(0, 4)) parts.push(`- ${s.id} ev=${s.expectedValue} rev=${s.reversible} ${s.text}`)
    }
    if (openPred) parts.push(`PREDICTION (unsettled): ${formatPrediction(openPred)}`)
    if (lastDrift) parts.push(`LAST DRIFT: ${lastDrift.level}${lastDrift.driftScore != null ? ` ${lastDrift.driftScore.toFixed(2)}` : ""} — ${lastDrift.why}`)
    try {
      const cal = predictionsForPrompt(cwd)
      if (cal) parts.push(cal)
    } catch { /* calibration is context, never a gate */ }
    const snap = kernel.snapshot?.()
    const hypos = snap?.hypotheses?.filter((h) => h.status === "OPEN" || h.status === "SUPPORTED") || []
    if (hypos.length) {
      parts.push("FAILURE HYPOTHESES (what would change my mind is a discriminating test, not another identical retry):")
      for (const h of hypos.slice(0, 5)) parts.push(`- ${h.id} [${h.status} ${h.confidence}] ${h.description}`)
    }
    parts.push("INVARIANTS: reality > belief; evidence > confidence; verification > claim; current explicit intent > stale preference; no silent goal substitution; no unsupported completion.")
    return parts.filter(Boolean).join("\n\n")
  }

  function persist() {
    try {
      const file = cognitionPath(cwd)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify({ ...snapshot(), objective, savedAt: Date.now() }, null, 1), "utf8")
      fs.renameSync(tmp, file)
      emit("CHECKPOINT_CREATED", { file })
      return file
    } catch {
      return null
    }
  }

  return {
    kernel, user, contract, self,
    boot, absorbInstruction, next, enforce, stepDirective, noteInspect, notePlan, noteStrategies,
    predict, settle, observeCommand, observeTools, acquirePlan, observeAcquire,
    learnFeedback, close, snapshot, brief, promptBlock, persist, emit,
    get events() { return events.slice() },
    get klass() { return klass },
    get lastAction() { return lastAction },
    get lastAuth() { return lastAuth },
    get lastDrift() { return lastDrift },
    get lastSettled() { return lastSettled },
    get openPrediction() { return openPred },
    get lastExperiment() { return lastExperiment },
    get lastAcquire() { return lastAcquire },
    get lastMeta() { return lastMeta },
    get lastJoint() { return lastJoint },
  }
}

export function loadCognition(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(cognitionPath(cwd), "utf8"))
    return createCognition({ cwd, objective: j.objective || j.contract?.originalIntent || "", resume: j })
  } catch {
    return null
  }
}
