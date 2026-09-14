/**
 * plancritique.js — v99 "loopwise" plan-quality critique.
 *
 * The v98 planner validated STRUCTURE (schema, dependencies, cycles —
 * dag.js validatePlan/repairPlan) but never judged QUALITY: does the plan
 * actually cover the objective, is it decomposed sensibly, does a mutating
 * plan include verification, or is it one blob node wearing a numbered
 * list's clothes? This module is the deterministic quality gate the planner
 * lacked. It critiques the plan text + parsed defs against the objective and
 * returns findings plus a focused revision prompt; the caller may spend ONE
 * bounded planOnly revision pass when majors exist. Every check is
 * deterministic and every finding names its evidence — no model judgment,
 * no invented requirements, honest "no finding" when the plan is fine.
 *
 * House rules: zero dependencies, strengthens the existing plan path
 * (parsePlanToDAG/validatePlan/repairPlan untouched), bounded (one revision
 * per task, enforced by the caller), honest degradation.
 */

/** Objective terms that should surface in node text. Stopwords are English + common dev verbs that match everything. */
const STOP = new Set(("a an the and or but if then else of to in on for with without into from by at as is are be been was were do does did " +
  "can could should would will shall may might must it its this that these those there here we you i they them our your their " +
  "make makes made using use used add adds added create creates get gets set sets new all any some more most less least " +
  "please need needs want wants task code file files work working implement implementation change changes").split(" "))

const VERIFYISH = /\b(test|verify|check|validate|lint|typecheck|build|run tests|regression|assert|qa)\b/i
const MUTATIONISH = /\b(edit|write|modify|update|refactor|create|add|remove|delete|rename|move|implement|fix|patch|migrate|install)\b/i

/**
 * Deterministic plan-quality findings.
 * @param {object} o
 * @param {string} o.objective the task objective
 * @param {Array<object>} o.planDefs parsed plan nodes (title/objective/read_only fields per dag.js shapes)
 * @param {string} o.planText the raw plan text (numbered list)
 * @returns {{findings: Array<{id:string, severity:"major"|"minor", detail:string}>, score:number}}
 */
export function critiquePlan({ objective = "", planDefs = [], planText = "" } = {}) {
  const findings = []
  const push = (severity, id, detail) => findings.push({ severity, id, detail: String(detail).slice(0, 240) })
  const obj = String(objective ?? "").toLowerCase()
  const nodeText = planDefs.map((n) => `${n.title ?? ""} ${n.objective ?? ""} ${n.description ?? ""}`).join("\n").toLowerCase()

  // 1. coverage: salient objective tokens absent from every node
  const objTokens = [...new Set(obj.replace(/[^a-z0-9+#./_-]+/g, " ").split(/\s+/).filter((t) => t.length > 3 && !STOP.has(t)))]
  if (objTokens.length && nodeText) {
    const missing = objTokens.filter((t) => !nodeText.includes(t))
    // tolerate partial-token matches (plural/inflection): "auth" in "authentication"
    const reallyMissing = missing.filter((t) => !nodeText.includes(t.slice(0, Math.max(4, t.length - 2))))
    if (reallyMissing.length >= Math.max(2, Math.ceil(objTokens.length * 0.4))) {
      push("major", "coverage_gap", `objective terms no node mentions: ${reallyMissing.slice(0, 8).join(", ")}`)
    } else if (reallyMissing.length) {
      push("minor", "coverage_thin", `uncovered objective terms: ${reallyMissing.slice(0, 6).join(", ")}`)
    }
  }

  // 2. granularity
  if (planDefs.length === 1 && objTokens.length >= 5) {
    push("major", "blob_node", "the whole objective is one node — decompose into investigate/implement/verify steps")
  }
  if (planDefs.length > 15) {
    push("minor", "over_decomposed", `${planDefs.length} nodes for one objective — merge trivial steps`)
  }

  // 3. verification presence: a mutating plan needs a verify-shaped node
  const mutating = planDefs.filter((n) => n.read_only !== true && MUTATIONISH.test(`${n.title ?? ""} ${n.objective ?? ""}`))
  const verifying = planDefs.filter((n) => VERIFYISH.test(`${n.title ?? ""} ${n.objective ?? ""}`) || n.role === "tester")
  if (mutating.length && !verifying.length) {
    push("major", "no_verification_step", `${mutating.length} mutating node(s) but no test/verify step — plans that change code must verify it`)
  }

  // 4. all read-only for an implementation-flavored objective
  if (planDefs.length && planDefs.every((n) => n.read_only === true) && MUTATIONISH.test(obj)) {
    push("major", "read_only_plan", "every node is read-only but the objective asks for changes")
  }

  // 5. first-node sanity: the first node should investigate or already know the target
  const first = planDefs[0]
  if (first && planDefs.length >= 3 && !/\b(read|inspect|explore|analyz|investigat|understand|review|search|find|plan|check|setup|identify)\b/i.test(`${first.title ?? ""} ${first.objective ?? ""}`) && MUTATIONISH.test(obj)) {
    push("minor", "blind_first_step", "step 1 mutates before anything inspected the target — front-load a read-only look")
  }

  const majors = findings.filter((f) => f.severity === "major").length
  const score = Math.max(0, 1 - majors * 0.3 - (findings.length - majors) * 0.1)
  return { findings, score }
}

/**
 * The revision prompt for the ONE revision pass. Returns null when there is
 * nothing worth a revision (no majors) — the caller skips the model call.
 */
export function planRevisionPrompt({ objective, planText, findings }) {
  const majors = findings.filter((f) => f.severity === "major")
  if (!majors.length) return null
  const lines = majors.map((f) => `- [${f.id}] ${f.detail}`).join("\n")
  return `${objective}

Your previous plan was structurally valid but has QUALITY problems a reviewer caught:

${lines}

Produce a REVISED plan as a numbered list (one action per line, 3-10 steps) that fixes every problem above. Mark read-only investigation steps and implementation steps. A plan that changes code MUST end with a verification step (run the project's real test/build command). Do NOT execute anything — plan only.`
}
