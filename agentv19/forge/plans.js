/**
 * forge — plan persistence (v20.2, P1-9).
 *
 * `forge agent --plan "task"` produces a read-only implementation plan and then
 * used to print it and throw it away. Plans are now saved under the project's
 * `.forge/plans/<slug>.md`, so the natural autonomous next step —
 * "read the plan back and execute it" — is possible:
 *
 *   forge agent --plan "add retry to the fetch layer"   # writes .forge/plans/…
 *   forge plan list
 *   forge plan show 1
 *   forge plan apply 1                                   # runs the agent on it
 *
 * Zero dependencies; best-effort (a plan write must never break the agent run).
 */
import fs from "node:fs"
import path from "node:path"

export function plansDir(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), ".forge", "plans")
}

/** Filesystem-safe, readable slug for a task string. */
export function slugify(task) {
  const s = String(task ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "")
  return s || "plan"
}

/** Save a plan for `task`. Returns { ok, file, slug } (best-effort). */
export function savePlan(task, text, cwd = process.cwd()) {
  try {
    const dir = plansDir(cwd)
    fs.mkdirSync(dir, { recursive: true })
    const slug = slugify(task)
    const file = path.join(dir, slug + ".md")
    const header = `# Plan: ${String(task ?? "").trim()}\n\n_generated ${new Date().toISOString()}_\n\n`
    fs.writeFileSync(file, header + String(text ?? "").trim() + "\n")
    return { ok: true, file, slug }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** List saved plans, newest first: [{ slug, file, mtime, title }]. */
export function listPlans(cwd = process.cwd()) {
  const dir = plansDir(cwd)
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")) } catch { return [] }
  const out = []
  for (const n of names) {
    const file = path.join(dir, n)
    let mtime = 0, title = ""
    try {
      mtime = fs.statSync(file).mtimeMs
      const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] || ""
      title = first.replace(/^#\s*(Plan:\s*)?/i, "").trim()
    } catch {}
    out.push({ slug: n.replace(/\.md$/, ""), file, mtime, title })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Resolve a plan by 1-based index (as shown by listPlans) or by slug.
 * Returns { ok, file, slug, text } or { ok:false, error }.
 */
export function readPlan(ref, cwd = process.cwd()) {
  const plans = listPlans(cwd)
  if (!plans.length) return { ok: false, error: "no saved plans (run: forge agent --plan \"task\")" }
  const r = String(ref ?? "").trim()
  let hit = null
  const n = Number(r)
  if (r && Number.isInteger(n) && n >= 1 && n <= plans.length) hit = plans[n - 1]
  else hit = plans.find((p) => p.slug === r) || (r ? null : plans[0])
  if (!hit) return { ok: false, error: `no plan "${r}" — use forge plan list` }
  try {
    return { ok: true, file: hit.file, slug: hit.slug, text: fs.readFileSync(hit.file, "utf8") }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
