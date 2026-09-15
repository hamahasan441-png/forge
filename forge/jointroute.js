/**
 * forge — joint route (v111 jointwise)
 *
 * Not a fourth brain. Composes the three existing pickers:
 *   depth  ← metalearn.recommendDepth
 *   model  ← caller / applyModelChoice (string only; this file does not steal providers)
 *   skills ← caplearn.shouldWithhold
 *
 * Then asks: does MEASURED (depth, model, skill) history say this combo loses
 * to a cheaper successful one for this task class?
 *
 * MICRO never joint-routes. Named skills and lockModel keep the caller's pick.
 */
import fs from "node:fs"
import path from "node:path"
import { projectDir } from "./memory.js"
import { writeStateFile } from "./securefs.js"
import { DEPTH } from "./governor.js"
import { recommendDepth, DEPTH_ORDER } from "./metalearn.js"
import { loadCapLearn, shouldWithhold } from "./caplearn.js"

export const JOINT_VERSION = "1.0.0"
export const JOINT_FILE = "jointroute.json"

const MICRO = new Set(["MICRO", "trivial"])
const MAX_ROUTES = 48

export function jointPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), JOINT_FILE)
}

export function routeKey({ depth = DEPTH.L2, model = "*", skill = "*" } = {}) {
  return `${String(depth || DEPTH.L2)}|${String(model || "*")}|${String(skill || "*")}`
}

function parseKey(key) {
  const [depth, model, skill] = String(key).split("|")
  return { depth: depth || DEPTH.L2, model: model || "*", skill: skill || "*" }
}

function depthIndex(d) {
  const i = DEPTH_ORDER.indexOf(String(d))
  return i < 0 ? 1 : i
}

export function loadJoint(cwd = process.cwd()) {
  try {
    const j = JSON.parse(fs.readFileSync(jointPath(cwd), "utf8"))
    if (j && typeof j === "object" && j.byKlass && typeof j.byKlass === "object") return j
  } catch { /* first run */ }
  return { v: JOINT_VERSION, byKlass: {}, updated: 0 }
}

function saveJoint(cwd, store) {
  writeStateFile(jointPath(cwd), JSON.stringify(store, null, 1), { mode: 0o600 })
}

export function recordRoute({
  cwd = process.cwd(),
  klass = "SMALL",
  depth = DEPTH.L2,
  model = "*",
  skills = [],
  ok = false,
} = {}) {
  const k = String(klass || "SMALL").slice(0, 24)
  const skill = String(Array.isArray(skills) && skills[0] ? skills[0] : "*").slice(0, 48)
  const key = routeKey({ depth, model: model || "*", skill })
  const store = loadJoint(cwd)
  const row = store.byKlass[k] && typeof store.byKlass[k] === "object" ? store.byKlass[k] : {}
  const rec = row[key] && typeof row[key] === "object" ? row[key] : { samples: 0, ok: 0, failed: 0, depth, model: model || "*", skill }
  rec.samples = (rec.samples || 0) + 1
  if (ok) rec.ok = (rec.ok || 0) + 1
  else rec.failed = (rec.failed || 0) + 1
  rec.rate = rec.samples ? rec.ok / rec.samples : 0
  rec.depth = String(depth || DEPTH.L2)
  rec.model = String(model || "*")
  rec.skill = skill
  row[key] = rec
  const keys = Object.keys(row)
  if (keys.length > MAX_ROUTES) {
    keys.sort((a, b) => (row[a].samples || 0) - (row[b].samples || 0))
    for (const drop of keys.slice(0, keys.length - MAX_ROUTES)) delete row[drop]
  }
  store.byKlass[k] = row
  store.v = JOINT_VERSION
  store.updated = Date.now()
  saveJoint(cwd, store)
  return rec
}

function comboScore(rec) {
  if (!rec || (rec.samples || 0) < 2) return null
  const rate = rec.ok / rec.samples
  return rate - 0.08 * depthIndex(rec.depth)
}

function bestMeasured(row) {
  let best = null
  let bestScore = -Infinity
  for (const rec of Object.values(row || {})) {
    const s = comboScore(rec)
    if (s == null) continue
    if (s > bestScore) { bestScore = s; best = rec }
  }
  return best
}

/**
 * Compose depth + model + skills. Returns the route the live path should use.
 * Never raises MICRO. Never drops a named skill. lockModel keeps the model.
 */
export function scoreRoute({
  cwd = process.cwd(),
  klass = "SMALL",
  task = "",
  depth = null,
  model = "",
  skills = [],
  failed = false,
  lockModel = false,
  namedSkills = [],
} = {}) {
  const named = new Set((namedSkills || []).map(String))
  if (MICRO.has(klass)) {
    return {
      depth: depth || DEPTH.L1,
      model: model || "",
      skills: skills.slice(),
      source: "micro",
      why: "MICRO does not joint-route",
      switched: false,
    }
  }

  let recDepth
  try {
    recDepth = recommendDepth({ cwd, klass, fallback: depth || DEPTH.L2, failed })
  } catch {
    recDepth = { depth: depth || DEPTH.L2, source: "default", why: "depth default" }
  }
  let chosenDepth = recDepth.depth
  let chosenModel = String(model || "")
  let chosenSkills = Array.isArray(skills) ? skills.slice() : []

  try {
    const store = loadCapLearn(cwd)
    chosenSkills = chosenSkills.filter((s) => {
      if (named.has(s)) return true
      return !shouldWithhold(store, { name: s, kind: "skill", klass, named: false })
    })
  } catch { /* withhold is advisory */ }

  const row = loadJoint(cwd).byKlass?.[String(klass)] || {}
  const best = bestMeasured(row)
  const currentKey = routeKey({
    depth: chosenDepth,
    model: chosenModel || "*",
    skill: chosenSkills[0] || "*",
  })
  const current = row[currentKey]
  const currentScore = comboScore(current)
  const bestScore = comboScore(best)

  let switched = false
  let why = recDepth.why || "composed existing pickers"
  let source = recDepth.source === "learned" ? "composed" : (recDepth.source || "composed")

  if (best && bestScore != null && (currentScore == null || currentScore < bestScore - 0.05)) {
    if ((best.samples || 0) >= 3 && (best.rate || 0) >= 0.5) {
      chosenDepth = best.depth || chosenDepth
      if (!lockModel && best.model && best.model !== "*") chosenModel = best.model
      why = `measured combo ${best.depth}+${best.model} ${Math.round((best.rate || 0) * 100)}% n=${best.samples} beats current`
      source = "joint"
      switched = (chosenDepth !== (depth || recDepth.depth)) || (chosenModel !== String(model || "") && !lockModel)
    }
  }

  return {
    depth: chosenDepth,
    model: chosenModel,
    skills: chosenSkills,
    source,
    why,
    switched,
    task: String(task || "").slice(0, 80),
  }
}

export function formatJointRoute(route) {
  if (!route) return ""
  const bits = [`${route.depth || "?"}`]
  if (route.model) bits.push(route.model)
  if (route.skills?.length) bits.push(route.skills.slice(0, 2).join(","))
  return `JOINT ROUTE: ${bits.join(" + ")} — ${route.why}`
}
