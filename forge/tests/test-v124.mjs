#!/usr/bin/env node
/**
 * forge — v124 "yolodiag": it was already unlimited, and could not say so.
 *
 * The report was "forge blocks my commands, there is too much filter, make it
 * unlimited". Resolving the real runtime against a DEFAULT config:
 *
 *   yolo true · assumeYes true · allowSudo true · allowOutsideProject true
 *   allowInterpreterEval true · allowNetworkUpload true · allowNewPlugins true
 *   governorEnforce false · critiqueEnforce false · maxRisk null
 *
 * Every switch already open. v122 "yolowise" built that and shipped it ON.
 * So a user being refused is NOT missing a feature — something on their
 * machine turned it off, silently.
 *
 * It takes exactly one stale key. The derivation is `unrestricted &&
 * autoApprove`, and `forge config set` persists the WHOLE merged object, so a
 * config file written by a forge older than v85 carries `unrestricted: false`
 * forever and puts every layer back in charge. `source` said only
 * "tools.unrestricted/autoApprove off" — naming both keys without saying which
 * one, and never saying how to undo it.
 *
 * Same shape as v120's stale `retry.connectMs=30000`: an old default outliving
 * the release that changed it, costing the user on every run, in silence.
 *
 * Nothing here removes a limit. The limits are already off; this makes their
 * re-imposition visible and one command away — and §5 below pins that the
 * defences which are NOT about the owner's own friction stayed exactly put.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v124-"))
process.env.FORGE_HOME = HOME
const ROOT = path.dirname(new URL("../package.json", import.meta.url).pathname)

let PASS = 0, FAIL = 0
const ok = (name, cond, detail = "") => { if (cond) { PASS++; console.log(`  ok   ${name}`) } else { FAIL++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`) } }
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want))

const { yoloState, formatYolo } = await import("../yolo.js")
const { defaultConfig } = await import("../config.js")

const base = defaultConfig()
const withTools = (over) => ({ ...base, tools: { ...base.tools, ...over } })

// ---------------------------------------------------------------------------
console.log("== 1. it ships unlimited — the claim, pinned ==")
{
  const y = yoloState(base, {})
  ok("a default config resolves YOLO ON", y.yolo === true, y.source)
  eq("and nothing is holding it off", y.blockedBy, [])
  eq("so there is nothing to fix", y.fix, null)

  // Every grant open. If a future change quietly tightens a default, this is
  // the assertion that says so out loud.
  for (const k of ["assumeYes", "allowSudo", "allowOutsideProject", "allowOutsideTraversal",
    "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "fetchPrivateUrls"]) {
    ok(`default: ${k} is granted`, y[k] === true)
  }
  ok("the governor does not veto by default", y.governorEnforce === false)
  ok("the pre-edit critique does not veto by default", y.critiqueEnforce === false)
  ok("there is no risk ceiling by default", y.maxRisk === null)
}

// ---------------------------------------------------------------------------
console.log("== 2. one stale key turns all of it off, and it is now named ==")
{
  // A config written before v85 persists this, and `unrestricted && autoApprove`
  // means one false is enough.
  const stale = yoloState(withTools({ unrestricted: false }), {})
  ok("a pre-v85 config turns YOLO off", stale.yolo === false)
  eq("and the exact key is named", stale.blockedBy, ["tools.unrestricted"])
  eq("with the command that undoes it", stale.fix, "forge yolo on")
  ok("…and every layer really is back in charge", stale.governorEnforce === true && stale.assumeYes === false)

  eq("autoApprove alone does it too", yoloState(withTools({ autoApprove: false }), {}).blockedBy, ["tools.autoApprove"])
  eq("and both are named when both are off",
    yoloState(withTools({ unrestricted: false, autoApprove: false }), {}).blockedBy,
    ["tools.unrestricted", "tools.autoApprove"])

  // An explicit persisted switch outranks the pair and must say so, not blame
  // a key the user never touched.
  eq("an explicit tools.yolo=false blames itself", yoloState(withTools({ yolo: false }), {}).blockedBy, ["tools.yolo"])
}

// ---------------------------------------------------------------------------
console.log("== 3. the env var is a different problem, and gets a different fix ==")
{
  // `forge yolo on` writes the CONFIG — it cannot beat FORGE_YOLO=0, which
  // outranks it. Telling the user to run it here would be wrong advice.
  const env = yoloState(base, { FORGE_YOLO: "0" })
  ok("FORGE_YOLO=0 turns it off", env.yolo === false)
  eq("and names the environment, not a config key", env.blockedBy, ["env FORGE_YOLO"])
  ok("the fix is to unset it, NOT `forge yolo on`",
    /unset FORGE_YOLO/.test(env.fix) && !/^forge yolo on$/.test(env.fix), env.fix)
  ok("FORGE_YOLO=1 turns it back on from a config that had it off",
    yoloState(withTools({ unrestricted: false }), { FORGE_YOLO: "1" }).yolo === true)
}

// ---------------------------------------------------------------------------
console.log("== 4. a pin still enforces WITH yolo on — the other silent refusal ==")
{
  const pinned = yoloState({ ...base, governor: { enforce: "always" } }, {})
  ok("YOLO reads ON", pinned.yolo === true)
  ok("but the governor is still enforcing", pinned.governorEnforce === true)
  eq("and the pin is named", pinned.pinnedOn, ["governor.enforce"])
  ok("with the command that releases it", /governor\.enforce auto/.test(pinned.fix), pinned.fix)
  eq("critique pins are named too", yoloState({ ...base, critique: { enforce: "always" } }, {}).pinnedOn, ["critique.enforce"])
  eq("no pin, nothing named", yoloState(base, {}).pinnedOn, [])
}

// ---------------------------------------------------------------------------
console.log("== 5. NOTHING here removed a defence ==")
{
  // The rails YOLO deliberately never touches are not about the owner's
  // friction — they stop a cloned repo steering the agent against its operator.
  // This PR is diagnostics; if it ever starts disabling one of these, fail.
  const src = fs.readFileSync(path.join(ROOT, "yolo.js"), "utf8")
  const shown = formatYolo(yoloState(base, {}))
  ok("the never-YOLO list still exists in source", /NEVER_YOLO\s*=/.test(src))
  ok("and is still printed, so it is not a secret",
    /never turned off by YOLO/.test(shown), shown.slice(-400))

  // The specific ones, by name.
  for (const [what, re] of [
    ["project configs stay stripped of privileged keys", /PRIVILEGED_TOOL_KEYS/],
    ["tool results stay attribution-fenced", /contentfence/],
    ["secrets stay redacted out of provider logs", /secrets\.js|redact/i],
    ["socket pinning stays (DNS-rebinding integrity)", /pinnedFetch|pinning/],
  ]) ok(`still documented: ${what}`, re.test(src))

  // fetchPrivateUrls is a GRANT, not a hole: pinning stays either way.
  ok("private-URL fetching remains an explicit grant, not a removed check",
    /fetchPrivateUrls/.test(src) && /pinnedFetch/.test(src))
}

// ---------------------------------------------------------------------------
console.log("== 6. the report says it, not just the object ==")
{
  const off = formatYolo(yoloState(withTools({ unrestricted: false }), {}))
  ok("an off state names the key", /held off by:\s+tools\.unrestricted/.test(off), off.split("\n").slice(0, 5).join(" / "))
  ok("says that key ships true", /ships true/.test(off))
  ok("and prints the command", /turn it on:\s+forge yolo on/.test(off))

  const on = formatYolo(yoloState(base, {}))
  ok("an on state does not invent a blocker", !/held off by/.test(on))
  ok("and still leads with FULL CONTROL", /FULL CONTROL/.test(on), on.split("\n")[0])

  const pin = formatYolo(yoloState({ ...base, governor: { enforce: "always" } }, {}))
  ok("a pinned layer is called out even though YOLO is on",
    /still enforcing: governor\.enforce/.test(pin), pin.split("\n").slice(0, 6).join(" / "))
}

// ---------------------------------------------------------------------------
console.log("== 7. doctor answers it without reading source ==")
{
  const src = fs.readFileSync(path.join(ROOT, "forge.js"), "utf8")
  ok("doctor resolves the control state", /yoloState\(config\)/.test(src))
  ok("and prints a control line", /control:/.test(src))
  ok("naming what holds it off", /held off by/.test(src))
  ok("and the command to undo it", /turn it back on/.test(src))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { }
process.exit(FAIL ? 1 : 0)
