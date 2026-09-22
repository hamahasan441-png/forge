#!/usr/bin/env node
/**
 * forge — v133 "stickwise": the model you picked is the model that runs.
 *
 * Reproduced against the repository, not the docs.
 *
 * v110 already solved this on the one-shot: applyModelChoice keeps MICRO,
 * honors lock, keeps low-confidence. Core (the default loop since v131)
 * called selectModel BEFORE classify, then swapped providers with no MICRO
 * guard, no lock, no low-confidence hold. Crew routing did it again per
 * role. e2e Anthropic agent ran with autonomous:false, so Anthropic-on-Core
 * was untested — OpenAI mock answered "Hello from mock!" and the suite
 * still passed.
 *
 * v133 is one table (applyModelChoice) consumed by Core and crew. Crew may
 * pick a different model on the SAME provider, never a different protocol.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v133-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const {
  applyModelChoice, selectModel, reconsiderModel, clearPerformance,
} = await import("../modelstrategy.js")

const twoProviders = () => ({
  providers: {
    mocka: { protocol: "anthropic", baseUrl: "https://a.example/v1", model: "claude-opus", apiKey: "k", timeoutMs: 1000 },
    mock: { protocol: "openai", baseUrl: "https://o.example/v1", model: "gpt-mini", apiKey: "k", timeoutMs: 1000 },
  },
})
const anthropic = () => ({ name: "mocka", model: "claude-opus", protocol: "anthropic" })

console.log("== 1. applyModelChoice: MICRO/SMALL/lock keep the caller ==")
{
  clearPerformance()
  const config = twoProviders()
  const p = anthropic()
  const micro = applyModelChoice({ config, provider: p, task: "typo fix teh", klass: "MICRO" })
  eq("MICRO switched=false", micro.switched, false)
  eq("MICRO keeps anthropic", micro.provider?.name, "mocka")
  const small = applyModelChoice({ config, provider: p, task: "USE_TOOL_A please run echo", klass: "SMALL" })
  eq("SMALL switched=false", small.switched, false)
  eq("SMALL keeps anthropic (the e2e class)", small.provider?.name, "mocka")
  const locked = applyModelChoice({ config, provider: p, task: "rewrite the auth module", klass: "LARGE", lock: true })
  eq("lock switched=false", locked.switched, false)
  ok("lock says so", /lock/.test(locked.why || ""))
}

console.log("== 2. crew sameProvider: never leave the owner's protocol ==")
{
  clearPerformance()
  const config = twoProviders()
  const p = anthropic()
  const sel = selectModel(config, { task: "explore the repo", provider: p, preferredClass: "fast_reasoning" })
  ok("selectModel can see the OpenAI candidate (the steal was possible)",
    (sel.candidates || []).some((c) => c.provider === "mock"), JSON.stringify(sel.decision))
  const crew = applyModelChoice({
    config, provider: p, task: "explore the repo",
    preferredClass: "fast_reasoning", sameProvider: true, klass: "LARGE",
  })
  eq("crew stays on mocka", crew.provider?.name, "mocka")
  ok("crew did not adopt the OpenAI provider", crew.provider?.name !== "mock")
  const recon = reconsiderModel(config, {
    provider: p, task: "rewrite auth",
    failures: 2, failureKind: "reasoning",
    resourceLimits: { preferredClass: "fast_reasoning" },
  })
  ok("reconsider does not return a different provider", recon == null || recon.provider === "mocka", JSON.stringify(recon))
}

console.log("== 3. production callers consume the table ==")
{
  const metaSrc = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")
  ok("meta.js imports applyModelChoice", /import \{[^}]*applyModelChoice[^}]*\} from "\.\/modelstrategy\.js"/.test(metaSrc))
  ok("meta.js no longer imports selectModel for the live pick", !/import \{[^}]*\bselectModel\b[^}]*\} from "\.\/modelstrategy\.js"/.test(metaSrc))
  ok("Core pick uses applyModelChoice with classified.class (after classify)", /applyModelChoice\(\{[\s\S]{0,180}?klass:\s*classified\.class/.test(metaSrc))
  ok("lane still feeds the table (fastwise pin)", /resolveLane\(\{ task: state\.objective/.test(metaSrc) && /latencyBudgetMs: lane\.latencyBudgetMs/.test(metaSrc))
  ok("crew uses applyModelChoice with sameProvider", /sameProvider:\s*true/.test(metaSrc) && /applyModelChoice\(\{[\s\S]{0,220}?sameProvider:\s*true/.test(metaSrc))
  ok("the old Core provider-swap is gone", !/sel\.decision\.provider !== provider\?\.name/.test(metaSrc))
  ok("crew no longer buildProvider's a different protocol", !/buildProvider91/.test(metaSrc) && !/crewModels/.test(metaSrc))
  ok("modelStrategy opt-out still exists", /modelStrategy !== false/.test(metaSrc))
  ok("crewRouting opt-out still exists", /crewRouting !== false/.test(metaSrc))
  ok("one-shot still uses applyModelChoice", /applyModelChoice/.test(agentSrc))
}

console.log("== 4. e2e proves Anthropic-on-Core, not only the one-shot ==")
{
  const e2eSrc = fs.readFileSync(path.join(ROOT, "tests/e2e-forge.sh"), "utf8")
  ok("historical Anthropic one-shot still exists", e2eSrc.includes("anthropic agent tool") && e2eSrc.includes("USE_TOOL_A"))
  ok("e2e now proves Anthropic-on-Core", e2eSrc.includes("v133 anthropic-on-core still runs bash") && e2eSrc.includes("anthropic-e2e-ok"))
  ok("v133 config has BOTH providers (the steal needs a second one)", /CFG133[\s\S]{0,1200}providers\.mock\.model[\s\S]{0,800}providers\.mocka\.protocol anthropic/.test(e2eSrc))
  ok("v133 active provider is mocka", /CFG133[\s\S]{0,1800}activeProvider mocka/.test(e2eSrc))
  ok("v133 uses the shipped default loop (not autonomous:false)", /printf '\{\}\\n' > "\$CFG133"/.test(e2eSrc) || /printf '\{\}\n' > "\$CFG133"/.test(e2eSrc))
}

console.log("== 5. YOLO, the gate, the v131 loop, five reviewers — untouched ==")
{
  const metaSrc = fs.readFileSync(path.join(ROOT, "meta.js"), "utf8")
  const yoloSrc = fs.readFileSync(path.join(ROOT, "yolo.js"), "utf8")
  const cfgSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8")
  ok("yolo.js still ships yoloState", /export function yoloState/.test(yoloSrc))
  ok("meta still honours yoloState", /yoloState\(config\)/.test(metaSrc))
  ok("completion gate still consulted", /canCompleteTask/.test(metaSrc))
  ok("useController is still the loop predicate", /export function useController/.test(cfgSrc))
  for (const f of ["plancritique.js", "critique.js", "selfreview.js", "codereview.js", "review.js"]) {
    ok(`${f} still exists`, fs.existsSync(path.join(ROOT, f)))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  eq("package version stays 122.0.0", pkg.version, "122.0.0")
}

console.log("== 6. CHANGELOG / docs house style ==")
{
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
  const firstH = /^##\s+.+$/m.exec(cl)?.[0] ?? ""
  ok("CHANGELOG first heading stays the package version", /122\.0\.0/.test(firstH))
  ok("named suite is a ### under it, not a ##", /^### v133 /m.test(cl) && !/^## v133 /m.test(cl))
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8")
  ok("README names v133", /v133/.test(readme) && /stickwise/.test(readme))
  const todo = fs.readFileSync(path.join(ROOT, "TODO.md"), "utf8")
  ok("TODO has v133 leftovers (no PLAN file)", /v133/.test(todo) && /stickwise/.test(todo))
  ok("no PLAN file shipped", !fs.existsSync(path.join(ROOT, "PLAN.md")) && !fs.existsSync(path.join(ROOT, "PLAN-v133.md")))
  const runAll = fs.readFileSync(path.join(ROOT, "tests/run-all.mjs"), "utf8")
  ok("run-all registers the v133 suite", /test-v133\.mjs/.test(runAll))
}

console.log(`\n== v133 stickwise suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
