#!/usr/bin/env node
/**
 * forge — effort classification, model cache and skill indexing (v20.4).
 *
 * classifyTaskComplexity/resolveEffort decide whether a task gets DEEP
 * reasoning (bigger token budgets, slower, costlier) — a user-visible,
 * cost-relevant decision that had no test. modelcache backs the offline FREE
 * badges. indexSkills is what puts skills in front of the model.
 * Isolated FORGE_HOME, zero network.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-effort-"))
process.env.FORGE_HOME = HOME

const { classifyTaskComplexity, resolveEffort } = await import("../forge/agent.js")
const { MODEL_CACHE_PATH, readModelCache, writeModelCache, freeFromCache } = await import("../forge/modelcache.js")
const { indexSkills, resolveSkillsDir } = await import("../forge/skills.js")

let PASS = 0, FAIL = 0
const ok = (name, cond) => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}`) } }

console.log("== classifyTaskComplexity ==")
ok("a question is trivial", classifyTaskComplexity("what is this file") === "trivial")
ok("a rename is trivial", classifyTaskComplexity("rename this variable") === "trivial")
ok("a short imperative is simple", classifyTaskComplexity("add a log line") === "simple")
ok("security work is critical", classifyTaskComplexity("audit the auth layer for a security vulnerability") === "critical")
ok("a multi-signal task is critical", classifyTaskComplexity("refactor the database schema and fix the failing test suite") === "critical")
ok("empty input does not throw", ["trivial", "simple"].includes(classifyTaskComplexity("")))
ok("null input does not throw", ["trivial", "simple"].includes(classifyTaskComplexity(null)))
ok("returns one of the five levels", ["trivial", "simple", "moderate", "complex", "critical"]
  .includes(classifyTaskComplexity("migrate the production deploy pipeline")))

console.log("== resolveEffort honors the profile ==")
{
  ok("profile=fast never goes deep", resolveEffort("fast", "refactor the whole security layer").deep === false)
  ok("profile=deep always goes deep", resolveEffort("deep", "what is this").deep === true)
  ok("profile=balanced stays shallow", resolveEffort("balanced", "refactor the security layer").deep === false)
  const trivial = resolveEffort("auto", "what is this file")
  ok("auto: a trivial task stays shallow", trivial.deep === false)
  const heavy = resolveEffort("auto", "refactor the database schema and fix the failing test suite")
  ok("auto: a complex task goes deep", heavy.deep === true)
  ok("the reason is reported (never a silent switch)", /auto/.test(heavy.why) && heavy.why.length > 0)
  ok("fast reports its reason too", /fast/.test(resolveEffort("fast", "x").why))
}

console.log("== modelcache ==")
{
  ok("cache path is under FORGE_HOME", MODEL_CACHE_PATH.startsWith(HOME))
  ok("missing cache reads as null", readModelCache("openai") === null)
  ok("empty entries are rejected", writeModelCache("openai", []) === false)
  ok("missing provider name is rejected", writeModelCache("", [{ id: "a" }]) === false)
  ok("write succeeds", writeModelCache("openai", [
    { id: "big-free", free: true, context: 200000 },
    { id: "small-free", free: true, context: 8000 },
    { id: "paid", free: false, context: 128000 },
  ]) === true)
  const e = readModelCache("openai")
  ok("read returns the entries", e && e.entries.length === 3)
  ok("write stamps a timestamp", typeof e.ts === "number")
  ok("a second provider does not clobber the first", (writeModelCache("groq", [{ id: "g" }]), readModelCache("openai").entries.length === 3))
  const free = freeFromCache("openai")
  ok("freeFromCache returns only free models", free.length === 2 && free.every((m) => m.free))
  ok("freeFromCache sorts by biggest context first", free[0].id === "big-free")
  ok("freeFromCache on an unknown provider is empty", freeFromCache("nope").length === 0)
  fs.writeFileSync(MODEL_CACHE_PATH, "{ corrupt")
  ok("a corrupt cache never throws", readModelCache("openai") === null && freeFromCache("openai").length === 0)
  ok("a corrupt cache can be overwritten", writeModelCache("openai", [{ id: "x" }]) === true)
}

console.log("== indexSkills ==")
{
  const dir = path.join(HOME, "skills")
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true })
  fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "# Alpha Skill\n\nDoes alpha things.\n")
  fs.mkdirSync(path.join(dir, "beta"), { recursive: true })
  fs.writeFileSync(path.join(dir, "beta", "SKILL.md"), "no heading, just an intro line\n")
  fs.mkdirSync(path.join(dir, "not-a-skill"), { recursive: true })
  const idx = indexSkills(dir)
  ok("only directories with SKILL.md are indexed", idx.length === 2)
  ok("indexed alphabetically", idx[0].name === "alpha" && idx[1].name === "beta")
  ok("description comes from the H1", /Alpha Skill/.test(idx.find((s) => s.name === "alpha").desc))
  ok("falls back to the first prose line", /just an intro line/.test(idx.find((s) => s.name === "beta").desc))
  ok("each entry carries its SKILL.md path", idx.every((s) => s.path.endsWith("SKILL.md")))
  ok("a missing directory indexes as empty", indexSkills(path.join(HOME, "nope")).length === 0)
  ok("no directory at all is empty", indexSkills(null).length === 0)
  ok("resolveSkillsDir finds a real skills dir", typeof resolveSkillsDir(dir) === "string")
  // resolveSkillsDir falls back through several candidates, so a bogus hint does
  // not have to yield null — but whatever it returns must be a real directory
  // that actually holds skills, never a stale or invented path.
  {
    const r = resolveSkillsDir(path.join(HOME, "bogus"))
    ok("a bogus hint yields null or a directory that really holds skills",
       r === null || (fs.existsSync(r) && fs.readdirSync(r).some((d) => fs.existsSync(path.join(r, d, "SKILL.md")))))
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n== effort suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
