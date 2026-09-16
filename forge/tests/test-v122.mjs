#!/usr/bin/env node
/**
 * forge — v122 "costwise": the A/B verdict was throwing away the numbers it printed.
 *
 * A real run against deepseek-v4-flash-0731, 24 tasks, both arms:
 *
 *   on  PASS off-by-one … on LIE comparator-boolean … 23 PASS / 1 LIE
 *   off PASS off-by-one … off LIE comparator-boolean … 23 PASS / 1 LIE
 *
 * runAB has always computed delta.tokensIn/tokensOut/totalMs/toolCalls, and
 * formatABReport has always PRINTED them in the arm table. But the conclusion
 * underneath read
 *
 *     if (d.solved === 0 && d.falseCompletions === 0)   // evalbench.js:510
 *
 * and nothing else — so a run where cognition ON scored the same 23/24 for
 * TWICE the tokens reported "NO MEASURABLE DIFFERENCE". Same correctness at
 * higher cost is a NEGATIVE result, not a neutral one. The numbers were
 * computed, displayed, and never reached the verdict: the same dead wire v121
 * closed three of.
 *
 * Two guards matter more than the fix:
 *   - the band is perfbench's SINGLE_NOISE_PCT, not a second opinion. Each arm
 *     is one sample per task, which is the case that constant exists for.
 *   - wall time is reported and is NEVER the verdict. One run per task against
 *     a live provider carries latency the stack does not control.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v122-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { costVerdict, COST, formatABReport, runAB, EVAL_TASKS } = await import("../evalbench.js")
const { SINGLE_NOISE_PCT } = await import("../perfbench.js")

/** An arm shaped exactly as summarize() emits one. `over` scales every cost
 *  axis; outcomes are held identical so only cost can move the verdict. */
const arm = (over = 1, extra = {}) => ({
  tasks: 24, solved: 23, falseCompletions: 1, errored: 0, silentSuccesses: 0,
  medianMs: 9000, totalMs: Math.round(240000 * over),
  tokensIn: Math.round(40000 * over), tokensOut: Math.round(8000 * over),
  modelCalls: 60, toolCalls: Math.round(120 * over),
  models: ["deepseek-v4-flash-0731"], byClass: {}, results: [{ id: "x" }],
  ...extra,
})
const ab = (on, off = arm(1)) => ({
  on, off, lockModel: true, sameModel: true, models: ["deepseek-v4-flash-0731"],
  delta: {
    solved: on.solved - off.solved, falseCompletions: on.falseCompletions - off.falseCompletions,
    errored: on.errored - off.errored,
    tokensIn: on.tokensIn - off.tokensIn, tokensOut: on.tokensOut - off.tokensOut,
    totalMs: on.totalMs - off.totalMs, toolCalls: on.toolCalls - off.toolCalls,
  },
})

// ---------------------------------------------------------------------------
console.log("== 1. the defect: tied outcomes at double the cost ==")
{
  const doubled = ab(arm(2))
  const report = formatABReport(doubled)

  ok("outcomes really are tied — this is the branch that was wrong",
    doubled.delta.solved === 0 && doubled.delta.falseCompletions === 0)
  eq("the cost verdict is COSTLIER", costVerdict(doubled).verdict, COST.COSTLIER)

  ok("the report no longer claims there is no difference",
    !/NO MEASURABLE DIFFERENCE/.test(report), report)
  ok("it says the outcomes tied at higher cost",
    /SAME OUTCOMES AT HIGHER COST/.test(report), report)
  ok("and names it a NEGATIVE result rather than a neutral one",
    /NEGATIVE result/.test(report))
  ok("with the axis and the size, not just an adjective",
    /tokens \+100%/.test(report) && /tool calls \+100%/.test(report), report)
}

// ---------------------------------------------------------------------------
console.log("== 2. DAMPED — the band is perfbench's, not a second opinion ==")
{
  eq("costVerdict's default band is SINGLE_NOISE_PCT", costVerdict(ab(arm(2))).band, SINGLE_NOISE_PCT)

  // Inside the band: a real tie, honestly reported as one.
  const small = ab(arm(1.04))
  eq("a 4% cost delta is unchanged", costVerdict(small).verdict, COST.UNCHANGED)
  ok("and the report still says NO MEASURABLE DIFFERENCE",
    /NO MEASURABLE DIFFERENCE/.test(formatABReport(small)))
  ok("…now stating that the cost axes were actually checked",
    /inside the ±25% single-sample band/.test(formatABReport(small)), formatABReport(small))

  // Exactly at the band is not over it — a threshold that fires at equality
  // would call noise a finding.
  eq("a delta exactly at the band does not move the verdict",
    costVerdict(ab(arm(1 + SINGLE_NOISE_PCT))).verdict, COST.UNCHANGED)
  ok("but just past it does",
    costVerdict(ab(arm(1 + SINGLE_NOISE_PCT + 0.02))).verdict === COST.COSTLIER)
}

// ---------------------------------------------------------------------------
console.log("== 3. cheaper and mixed are distinguishable, not collapsed ==")
{
  const cheap = ab(arm(0.6))
  eq("40% less is CHEAPER", costVerdict(cheap).verdict, COST.CHEAPER)
  ok("and is called a win, because at a ceiling it is the only one available",
    /SAME OUTCOMES FOR LESS/.test(formatABReport(cheap)) && /real win/.test(formatABReport(cheap)))

  // Tokens up, tool calls down: the axes disagree and neither claim is honest.
  const on = arm(1)
  on.tokensIn = 80000; on.toolCalls = 60
  const mixed = ab(on)
  eq("disagreeing axes are MIXED", costVerdict(mixed).verdict, COST.MIXED)
  ok("and the report refuses a cost claim either way",
    /does not support a cost claim/.test(formatABReport(mixed)), formatABReport(mixed))
}

// ---------------------------------------------------------------------------
console.log("== 4. wall time is reported, and is NEVER the verdict ==")
{
  // Identical tokens and tool calls, but the ON arm took four times as long.
  // A live provider's queueing is not evidence about the cognitive stack.
  const slow = arm(1, { totalMs: 240000 * 4 })
  const v = costVerdict(ab(slow))
  eq("a 4x time delta alone leaves the verdict unchanged", v.verdict, COST.UNCHANGED)
  ok("time is not one of the verdict axes",
    !v.axes.some((a) => /time/i.test(a.label)), JSON.stringify(v.axes.map((a) => a.label)))
  const report = formatABReport(ab(slow))
  ok("the time delta is still reported — suppressed evidence is its own lie",
    /time \+720s/.test(report), report)
  ok("and is labelled as not evidence about the stack",
    /not evidence about the stack/.test(report))
}

// ---------------------------------------------------------------------------
console.log("== 5. an errored arm makes no cost claim at all ==")
{
  // An errored arm measures the harness setup, not the stack — the existing
  // report already says so, and a cost verdict over it would be noise.
  const broken = ab(arm(2, { errored: 3 }))
  eq("the verdict is UNKNOWN", costVerdict(broken).verdict, COST.UNKNOWN)
  ok("and says why", /never reached the model/.test(costVerdict(broken).why))
  ok("the report makes no higher-cost claim", !/HIGHER COST/.test(formatABReport(broken)))
  ok("and still leads with the errored warning",
    /NEVER REACHED THE MODEL/.test(formatABReport(broken)))
}

// ---------------------------------------------------------------------------
console.log("== 6. no fabricated percentages ==")
{
  // Zero baseline: there is nothing to be a percentage OF. The old shape of
  // this bug is a division by zero rendered as "Infinity%".
  const zero = arm(1, { tokensIn: 0, tokensOut: 0, toolCalls: 0 })
  const v = costVerdict(ab(arm(1), zero))
  ok("a zero baseline never yields NaN or Infinity in the text",
    !/NaN|Infinity/.test(JSON.stringify(v)) && !/NaN|Infinity/.test(formatABReport(ab(arm(1), zero))),
    JSON.stringify(v))
  ok("and reports the raw pair instead of a percentage",
    v.axes.every((a) => a.pct === null), JSON.stringify(v.axes))

  // Both arms at zero is a genuine tie, not a move.
  eq("zero vs zero is unchanged", costVerdict(ab(zero, zero)).verdict, COST.UNCHANGED)
}

// ---------------------------------------------------------------------------
console.log("== 7. the ceiling is named, because a tie at 23/24 is uninformative ==")
{
  const report = formatABReport(ab(arm(1.04)))
  ok("a 23/24 tie says so", /CEILING: both arms solved 23\/24/.test(report), report)
  ok("and says the solved column cannot show a difference there",
    /cannot show a difference even if one exists/.test(report))

  // A low solve rate has headroom, so the tie there IS informative.
  const low = arm(1.04, { solved: 8 }), lowOff = arm(1, { solved: 8 })
  ok("a low-scoring tie is not called a ceiling",
    !/CEILING/.test(formatABReport(ab(low, lowOff))), formatABReport(ab(low, lowOff)))
}

// ---------------------------------------------------------------------------
console.log("== 8. an outcome difference still wins over cost ==")
{
  // Correctness is the headline; cost never overrides it. §27 cuts both ways.
  const better = ab(arm(2, { solved: 24, falseCompletions: 0 }))
  const report = formatABReport(better)
  ok("a solved difference is reported as such", /cognition ON did better/.test(report), report)
  ok("and the cost is still named in the same sentence", /for \+\d+ tokens/.test(report))
  ok("the tie-only cost verdict does not appear", !/SAME OUTCOMES/.test(report))
}

// ---------------------------------------------------------------------------
console.log("== 9. the verdict travels with the result, not only the text ==")
{
  // `--json` consumers must see the same conclusion the report draws, rather
  // than re-deriving it and drifting from it.
  const srv = http.createServer((req, res) => {
    let b = ""
    req.on("data", (c) => { b += c })
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "m", object: "chat.completion", created: Date.now(), model: "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }))
    })
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  let out
  try {
    const { runAgent } = await import("../agent.js")
    out = await runAB({
      tasks: EVAL_TASKS.slice(0, 2), runAgent,
      config: { providers: {}, tools: { assumeYes: true }, agent: { autonomous: false, maxSteps: 2, verifyNudge: false } },
      provider: { name: "mock", protocol: "openai", baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "k", model: "mock-1" },
      timeoutMs: 60_000,
    })
  } finally { srv.close() }
  ok("runAB attaches a cost verdict", typeof out.cost?.verdict === "string", JSON.stringify(out.cost))
  ok("it is one of the declared values", Object.values(COST).includes(out.cost.verdict), out.cost.verdict)
  ok("and it matches what the report says",
    out.cost.verdict !== COST.COSTLIER || /HIGHER COST/.test(formatABReport(out)))
}

// ---------------------------------------------------------------------------
console.log("== 10. the wire stays connected ==")
{
  const src = fs.readFileSync(path.join(ROOT, "evalbench.js"), "utf8")
  ok("the tie branch consults the cost verdict rather than solved/lies alone",
    /d\.solved === 0 && d\.falseCompletions === 0[\s\S]{0,600}?costVerdict\(ab\)/.test(src))
  ok("the band is imported, not redeclared",
    /import \{ SINGLE_NOISE_PCT \} from "\.\/perfbench\.js"/.test(src) && !/SINGLE_NOISE_PCT\s*=\s*0\./.test(src))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
