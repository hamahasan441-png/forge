/**
 * forge — task classifier (Ω, zero dependencies)
 *
 * Every autonomous run must pick the *smallest sufficient* workflow.
 * A typo does not get a DAG, workers, or a model-written plan. An
 * architecture change does not get a single inspect→patch→verify hop.
 *
 * classifyTaskComplexity() is the v20 5-level API (trivial…critical) and
 * is byte-stable: existing effort / model-strategy tests keep passing.
 * classifyTask() is the Ω API (MICRO…ARCHITECTURAL) plus the strategy the
 * meta controller actually executes.
 */
export const TASK_CLASS = {
  MICRO: "MICRO",
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  LARGE: "LARGE",
  ARCHITECTURAL: "ARCHITECTURAL",
  RECOVERY: "RECOVERY",
}

export const ALL_CLASSES = Object.values(TASK_CLASS)

const LEGACY_OF = {
  MICRO: "trivial",
  SMALL: "simple",
  MEDIUM: "moderate",
  LARGE: "complex",
  ARCHITECTURAL: "critical",
  RECOVERY: "complex",
}

const CLASS_OF_LEGACY = {
  trivial: "MICRO",
  simple: "SMALL",
  moderate: "MEDIUM",
  complex: "LARGE",
  critical: "ARCHITECTURAL",
}

const COMPLEX_SIGNALS = [
  "architect", "refactor", "migrat", "security", "vulnerab", "production",
  "deploy", "database", "schema", "performance", "optimize", "race condition",
  "concurrency", "multi-file", "across files", "redesign", "rewrite", "debug",
  "not working", "failing", "broken", "regression", "test suite", "fix all",
  "end to end", "e2e",
]
const TRIVIAL_SIGNALS = [
  "what is", "explain", "summar", "rename", "one line", "typo", "comment",
  "docs for", "read me", "list ",
]
const ARCH_SIGNALS = [
  "architect", "redesign", "rewrite", "migrat", "multi-file", "across files",
]
const MICRO_STRONG = [
  "typo", "one line", "rename this", "what is", "explain this",
]

/**
 * v20 5-level classifier. Scoring is frozen: do not "improve" it without
 * updating tests/test-effort.mjs. Returns trivial|simple|moderate|complex|critical.
 */
export function classifyTaskComplexity(task) {
  const t = String(task ?? "").toLowerCase()
  const words = t.split(/\s+/).length
  let score = 0
  if (words > 12) score++
  if (words > 30) score++
  for (const s of COMPLEX_SIGNALS) if (t.includes(s)) score += 2
  for (const s of TRIVIAL_SIGNALS) if (t.includes(s)) score -= 2
  if (score <= -1) return "trivial"
  if (score <= 0) return "simple"
  if (score <= 1) return "moderate"
  if (score <= 3) return "complex"
  return "critical"
}

export function strategyFor(klass) {
  switch (klass) {
    case TASK_CLASS.MICRO:
      return {
        class: TASK_CLASS.MICRO,
        plan: "synthesize",
        workers: 0,
        maxSegments: 8,
        deep: false,
        verification: ["syntax"],
        workflow: ["inspect", "patch", "verify"],
        requireReview: false,
        requireRepoModel: false,
      }
    case TASK_CLASS.SMALL:
      return {
        class: TASK_CLASS.SMALL,
        plan: "synthesize",
        workers: 0,
        maxSegments: 16,
        deep: false,
        verification: ["syntax", "focused_test"],
        workflow: ["inspect", "implement", "test", "verify"],
        requireReview: false,
        requireRepoModel: false,
      }
    case TASK_CLASS.MEDIUM:
      return {
        class: TASK_CLASS.MEDIUM,
        plan: "model",
        workers: 1,
        maxSegments: 40,
        deep: false,
        verification: ["syntax", "focused_test"],
        workflow: ["inspect", "plan", "implement", "test", "repair", "regression", "verify"],
        requireReview: false,
        requireRepoModel: true,
      }
    case TASK_CLASS.LARGE:
      return {
        class: TASK_CLASS.LARGE,
        plan: "model",
        workers: 2,
        maxSegments: 80,
        deep: true,
        verification: ["syntax", "focused_test", "regression_test"],
        workflow: ["repo-model", "plan", "dag", "parallel", "integrate", "test", "diagnose", "repair", "regression", "review", "verify"],
        requireReview: true,
        requireRepoModel: true,
      }
    case TASK_CLASS.RECOVERY:
      return {
        class: TASK_CLASS.RECOVERY,
        plan: "restore",
        workers: 1,
        maxSegments: 40,
        deep: true,
        verification: ["syntax", "focused_test"],
        workflow: ["recover", "reconcile", "inspect", "repair", "verify"],
        requireReview: false,
        requireRepoModel: true,
      }
    default:
      return {
        class: TASK_CLASS.ARCHITECTURAL,
        plan: "model",
        workers: 2,
        maxSegments: 120,
        deep: true,
        verification: ["syntax", "focused_test", "regression_test", "build"],
        workflow: ["repo-model", "architecture", "impact", "alternatives", "plan", "dag", "parallel", "integrate", "review", "verify"],
        requireReview: true,
        requireRepoModel: true,
      }
  }
}

/**
 * Full Ω/∞ classification.
 * opts.resume = true is the only way to get RECOVERY — a typo never becomes
 * a recovery workflow, and a resume never steals MICRO scoring of the text.
 * @returns {{ class, legacy, confidence, signals, strategy, underlying? }}
 */
export function classifyTask(task, opts = {}) {
  const text = String(task ?? "")
  if (opts && opts.resume) {
    const underlying = classifyTask(text, {})
    const strategy = strategyFor(TASK_CLASS.RECOVERY)
    return {
      class: TASK_CLASS.RECOVERY,
      legacy: underlying.legacy,
      confidence: 0.9,
      signals: ["resume", ...underlying.signals],
      strategy,
      task: text.slice(0, 400),
      underlying: underlying.class,
    }
  }
  const legacy = classifyTaskComplexity(text)
  let klass = CLASS_OF_LEGACY[legacy] || TASK_CLASS.MEDIUM
  const t = text.toLowerCase()
  const signals = []
  for (const s of TRIVIAL_SIGNALS) if (t.includes(s)) signals.push(`trivial:${s}`)
  for (const s of COMPLEX_SIGNALS) if (t.includes(s)) signals.push(`complex:${s}`)
  // an architecture-flavoured critical task stays ARCHITECTURAL; a
  // "security vulnerability" critical task is LARGE unless an arch signal hits.
  if (klass === TASK_CLASS.ARCHITECTURAL && !ARCH_SIGNALS.some((s) => t.includes(s))) {
    if (/\b(refactor|migrat|redesign|rewrite|architect)\b/.test(t)) {
      /* keep */
    } else if (MICRO_STRONG.some((s) => t.includes(s))) {
      klass = TASK_CLASS.MICRO
    } else {
      // critical-by-score (security, production, failing suite) without an
      // architecture signal is LARGE, not a full architecture pass.
      klass = TASK_CLASS.LARGE
    }
  }
  const strategy = strategyFor(klass)
  const confidence = Math.max(0.35, Math.min(0.95, 0.5 + signals.length * 0.08))
  return { class: klass, legacy, confidence, signals, strategy, task: text.slice(0, 400) }
}

export function resolveEffort(profile, task) {
  switch (profile) {
    case "fast": return { deep: false, why: "profile=fast" }
    case "deep": return { deep: true, why: "profile=deep" }
    case "auto": {
      const level = classifyTaskComplexity(task)
      const deep = level === "complex" || level === "critical"
      return { deep, why: `profile=auto → ${level} task → ${deep ? "deep" : "standard"} effort` }
    }
    default: return { deep: false, why: "profile=balanced" }
  }
}

/**
 * Deterministic 1–3 node plan for MICRO/SMALL. Same shape as parsePlanToDAG
 * output so validatePlan/repairPlan/buildDAG consume it unchanged.
 */
export function synthesizePlan(objective, klass = TASK_CLASS.MICRO) {
  const obj = String(objective ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || "task"
  if (klass === TASK_CLASS.MICRO) {
    return [{
      id: "do",
      title: obj,
      objective: obj,
      dependencies: [],
      role: "coder",
      risk: "low",
      read_only: false,
      verificationRequirements: ["syntax"],
    }]
  }
  return [
    {
      id: "inspect",
      title: `Inspect: ${obj}`,
      objective: `Inspect the relevant files for: ${obj}`,
      dependencies: [],
      role: "researcher",
      risk: "low",
      read_only: true,
      verificationRequirements: ["acceptance"],
    },
    {
      id: "patch",
      title: `Implement: ${obj}`,
      objective: obj,
      dependencies: ["inspect"],
      role: "coder",
      risk: "medium",
      read_only: false,
      verificationRequirements: ["syntax", "focused_test"],
    },
    {
      id: "verify",
      title: `Verify: ${obj}`,
      objective: `Run the focused tests that prove: ${obj}`,
      dependencies: ["patch"],
      role: "tester",
      risk: "low",
      read_only: true,
      verificationRequirements: ["focused_test"],
    },
  ]
}

export function legacyOf(klass) {
  return LEGACY_OF[klass] || "moderate"
}
