#!/usr/bin/env node
/**
 * forge — v130 "yolomode": full control got a NAME, and the name is testable.
 *
 * v124 pinned what a DEFAULT config resolves to:
 *
 *   yolo true · assumeYes true · allowSudo true · allowOutsideProject true
 *   allowInterpreterEval true · allowNetworkUpload true · allowNewPlugins true
 *   governorEnforce false · critiqueEnforce false · maxRisk null
 *
 * Seven grants open, two oversight layers advising. That is the state an owner
 * who says "make it unlimited" usually means. The other one — "unlimited, but
 * keep watching" — had no name: it was `forge yolo on` plus
 * `forge config set governor.enforce always` plus the same for
 * `critique.enforce`, three commands, and `forge yolo` then reported the result
 * as an anomaly ("still enforcing … release it") because the only way to get
 * there was to pin two layers and be told something was wrong.
 *
 * v130 names it: mode = off | yolo | full, one key (tools.yoloMode), one env
 * var (FORGE_YOLO_MODE), one flag (--yolo-full), one command (`forge yolo
 * full`), and one patch shape (applyYoloMode) shared by the CLI, `/yolo` in
 * chat and this suite. §1 pins the nine flags the mode is DEFINED by:
 *
 *   yolo true · assumeYes true · allowSudo true · allowOutsideProject true
 *   allowInterpreterEval true · allowNetworkUpload true · allowNewPlugins true
 *   governorEnforce true · critiqueEnforce true
 *
 * §8 is not about modes at all: it is the defect §7's grant list walked into.
 * `allowNewPlugins` was one of the nine, and the layer that honours it in
 * interactive chat read a bare `unrestricted` declared in a DIFFERENT function,
 * threw a ReferenceError on every call, and the best-effort catch swallowed it
 * — so chat loaded zero user plugins, silently, while `forge agent` loaded
 * them. A grant nobody reads is not a grant.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))) // …/forge
const FORGE_JS = path.join(ROOT, "forge.js")

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v130-"))
process.env.FORGE_HOME = HOME

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 300) : ""}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const { yoloState, yoloGrants, formatYolo, modeOf, applyYoloMode, yoloModeNote, yoloModeFlags, FULL_CONTROL_FLAGS, YOLO_MODES } = await import("../yolo.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")

const base = defaultConfig()
const cfg = (over = {}) => ({ ...base, tools: { ...base.tools, ...(over.tools ?? {}) }, governor: { ...(over.governor ?? base.governor) }, critique: { ...(over.critique ?? base.critique) } })
const ALL_TRUE = Object.fromEntries(FULL_CONTROL_FLAGS.map((k) => [k, true]))

// ---------------------------------------------------------------------------
console.log("== 1. the nine flags mode=full is defined by, pinned ==")
{
  eq("FULL_CONTROL_FLAGS is exactly the nine", FULL_CONTROL_FLAGS, [
    "yolo", "assumeYes", "allowSudo", "allowOutsideProject",
    "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins",
    "governorEnforce", "critiqueEnforce",
  ])
  const full = yoloState(cfg({ tools: { yoloMode: "full" } }), {})
  eq("tools.yoloMode:full resolves all nine true", yoloModeFlags(full), ALL_TRUE)
  eq("and says which mode it is", full.mode, "full")
  eq("with the source named", full.source, "tools.yoloMode=full")
  ok("no ceiling under full control", full.maxRisk === null)
  ok("nothing is holding it off", full.blockedBy.length === 0, full.blockedBy.join(","))
  ok("so there is nothing to 'fix'", full.fix === null, full.fix)
  ok("full mode is not reported as an anomaly", full.pinnedOn.length === 0, full.pinnedOn.join(","))
  ok("the two layers are held on BY THE MODE, not by a stray pin", full.governorByMode === true && full.critiqueByMode === true)

  // The contrast that makes the mode a real state and not a rename of v124.
  const std = yoloState(base, {})
  eq("a default config is mode 'yolo', not 'full'", std.mode, "yolo")
  eq("its seven grants are already open", Object.entries(yoloModeFlags(std)).filter(([k, v]) => v && k !== "governorEnforce" && k !== "critiqueEnforce").map(([k]) => k).length, 7)
  ok("and its two oversight layers advise only", std.governorEnforce === false && std.critiqueEnforce === false)
  eq("yoloGrants carries the plugin grant now too", yoloGrants(full).allowNewPlugins, true)
  eq("YOLO_MODES names all three", YOLO_MODES, ["off", "yolo", "full"])
  eq("modeOf normalises the aliases people actually type", [modeOf("FULL"), modeOf(" full-control "), modeOf("on"), modeOf("safe"), modeOf("bogus")], ["full", "full", "yolo", "off", null])
}

// ---------------------------------------------------------------------------
console.log("== 2. precedence: env beats a file, FORGE_YOLO beats everything ==")
{
  const offSaved = cfg({ tools: { yolo: false } })
  eq("FORGE_YOLO_MODE=full wins over a saved tools.yolo:false", yoloState(offSaved, { FORGE_YOLO_MODE: "full" }).mode, "full")
  eq("FORGE_YOLO=0 wins over FORGE_YOLO_MODE=full (a kill switch is a kill switch)", yoloState(cfg({ tools: { yoloMode: "full" } }), { FORGE_YOLO: "0", FORGE_YOLO_MODE: "full" }).mode, "off")
  eq("…and names the key that did it", yoloState(base, { FORGE_YOLO: "0" }).blockedBy, ["env FORGE_YOLO"])
  eq("FORGE_YOLO_MODE=off is named too, not blamed on unrestricted", yoloState(base, { FORGE_YOLO_MODE: "off" }).blockedBy, ["env FORGE_YOLO_MODE=off"])
  ok("with a command that undoes it", /unset FORGE_YOLO_MODE/.test(yoloState(base, { FORGE_YOLO_MODE: "off" }).fix ?? ""), yoloState(base, { FORGE_YOLO_MODE: "off" }).fix)
  eq("a saved tools.yoloMode:off is named as well", yoloState(cfg({ tools: { yoloMode: "off" } }), {}).blockedBy, ["tools.yoloMode=off"])
  eq("tools.yolo:false still wins over a saved mode (the specific key is newer news)", yoloState(cfg({ tools: { yolo: false, yoloMode: "full" } }), {}).mode, "off")
  eq("an unknown mode string is ignored, never guessed at", yoloState(cfg({ tools: { yoloMode: "yolo-max" } }), {}).mode, "yolo")
  eq("--yolo-full's env pair resolves full", yoloState(base, { FORGE_YOLO: "1", FORGE_YOLO_MODE: "full" }).mode, "full")
}

// ---------------------------------------------------------------------------
console.log("== 3. the patch: minimum that resolves, and 'off' really means off ==")
{
  const patched = applyYoloMode(base, "full")
  eq("full writes the mode key", patched.tools.yoloMode, "full")
  eq("full writes the umbrella", patched.tools.yolo, true)
  eq("full holds the governor", patched.governor.enforce, "always")
  eq("full holds the critique", patched.critique.enforce, "always")
  eq("…and resolves to the nine", yoloModeFlags(yoloState(patched, {})), ALL_TRUE)

  // The trap this shape avoids: `grant()` is `yolo || tools[key]`, so a grant
  // written into the file outlives `forge yolo off` and leaves a machine that
  // reports "off" while still running sudo.
  for (const k of ["allowSudo", "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "allowOutsideProject"]) {
    ok(`full does NOT persist ${k} (so 'off' can really turn it off)`, patched.tools[k] !== true, String(patched.tools[k]))
  }
  const offAfterFull = applyYoloMode(patched, "off")
  const offState = yoloState(offAfterFull, {})
  eq("after `forge yolo off` the mode is off", offState.mode, "off")
  eq("every GRANT is really gone (assumeYes included)", yoloModeFlags(offState), {
    yolo: false, assumeYes: false, allowSudo: false, allowOutsideProject: false,
    allowInterpreterEval: false, allowNetworkUpload: false, allowNewPlugins: false,
    // …and these two being TRUE is the definition of "off": the oversight
    // layers are back in charge. Not a leak — the mode says so.
    governorEnforce: true, critiqueEnforce: true,
  })
  ok("and the risk ceiling comes back with them", offState.maxRisk === base.tools.maxRisk, String(offState.maxRisk))
  eq("downgrading to 'yolo' releases the pins full set", applyYoloMode(patched, "yolo").governor.enforce, "auto")
  eq("…and the critique with it", applyYoloMode(patched, "yolo").critique.enforce, "auto")
  const handPinned = applyYoloMode({ ...base, governor: { enforce: "always" } }, "yolo")
  eq("but a hand-written pin survives a downgrade (it is the owner's, not the mode's)", handPinned.governor.enforce, "always")
  ok("applyYoloMode is pure — the input config is untouched", base.tools.yoloMode === null && base.governor.enforce === "auto")
  eq("the note for full says what it costs", yoloModeNote("full").join(" ").includes("WAITING_FOR_USER"), true)
}

// ---------------------------------------------------------------------------
console.log("== 4. an explicit 'never' outranks the mode ==")
{
  const never = yoloState(cfg({ tools: { yoloMode: "full" }, governor: { enforce: "never" } }), {})
  ok("full mode does not silently override a 'never' pin", never.governorEnforce === false && never.critiqueEnforce === true)
  eq("so the mode that RESOLVED is not the one asked for", never.mode, "yolo")
  eq("and both are reported", [never.requestedMode, never.modeSource], ["full", "tools.yoloMode"])
  const shown = formatYolo(never)
  ok("the report says so out loud", /asked for full via tools\.yoloMode/.test(shown), shown.split("\n").slice(0, 4).join(" / "))
  ok("FORGE_GOVERNOR=0 does the same from the shell", yoloState(cfg({ tools: { yoloMode: "full" } }), { FORGE_GOVERNOR: "0" }).governorEnforce === false)
}

// ---------------------------------------------------------------------------
console.log("== 5. `forge yolo` prints the mode and the nine flags ==")
{
  const full = formatYolo(yoloState(cfg({ tools: { yoloMode: "full" } }), {}))
  ok("it still leads with FULL CONTROL", /YOLO — FULL CONTROL/.test(full), full.split("\n")[0])
  ok("and says what full keeps instead of implying nothing can stop the run", /governor and the critique still hold their veto/.test(full), full.split("\n")[0])
  ok("the mode line is there, naming where the mode came from", /mode:\s+full \(tools\.yoloMode\) —/.test(full), full.split("\n").slice(0, 3).join(" / "))
  ok("the nine-flag block is there", /YOLO mode flags/.test(full))
  for (const k of FULL_CONTROL_FLAGS) ok(`  block names ${k} on`, new RegExp(`\\n\\s+${k}\\s+on`).test(full))
  ok("it says what an enforcing layer costs", /WAITING_FOR_USER/.test(full))
  ok("and does not call the mode an anomaly", !/still enforcing:/.test(full), full.split("\n").slice(0, 6).join(" / "))
  ok("the rails YOLO never turns off are still printed", /never turned off by YOLO/.test(full))

  const std = formatYolo(yoloState(base, {}))
  ok("a default config does not invent a mode change", /mode:\s+yolo —/.test(std) && !/mode:\s+full/.test(std))
  ok("a default config does not invent a blocker", !/held off by/.test(std))
  ok("and offers the command that reaches full", /forge yolo full/.test(std))

  const pinned = formatYolo(yoloState(cfg({ governor: { enforce: "always" } }), {}))
  ok("one hand-pinned layer is still called out (v124 behaviour kept)", /still enforcing: governor\.enforce/.test(pinned), pinned.split("\n").slice(0, 6).join(" / "))
  ok("…and now says what a pin restores", /WAITING_FOR_USER/.test(pinned))
}

// ---------------------------------------------------------------------------
console.log("== 6. a cloned repository cannot arm it ==")
{
  const evil = { tools: { yoloMode: "full", yolo: true, allowSudo: true }, governor: { enforce: "always" }, critique: { enforce: "always" }, agent: { steps: 5 } }
  const { cfg: proj, dropped } = sanitizeProjectConfig(JSON.parse(JSON.stringify(evil)))
  for (const k of ["tools.yoloMode", "tools.yolo", "tools.allowSudo", "governor", "critique"]) ok(`dropped: ${k}`, dropped.includes(k), dropped.join(","))
  ok("nothing privileged survives into the merged config", proj?.tools?.yoloMode === undefined && proj?.governor === undefined && proj?.critique === undefined)
  ok("an innocent key still passes", proj?.agent?.steps === 5)
  eq("defaultConfig carries the new key as null (visible in `forge config show`)", base.tools.yoloMode, null)
}

// ---------------------------------------------------------------------------
console.log("== 7. the CLI: one command to arm the mode, one to see it ==")
{
  const CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v130-home-"))
  const run = (args, env = {}) => spawnSync("node", [FORGE_JS, ...args], {
    encoding: "utf8", timeout: 60000, env: { ...process.env, FORGE_HOME: CLI_HOME, FORGE_NO_COLOR: "1", ...env },
  })
  const saved = () => JSON.parse(fs.readFileSync(path.join(CLI_HOME, "config.json"), "utf8"))

  const full = run(["yolo", "full"])
  ok("`forge yolo full` says which mode it wrote", /mode = full/.test(full.stdout), full.stdout?.slice(0, 240))
  ok("and still names the v122 key", /tools\.yolo = true/.test(full.stdout), full.stdout?.slice(0, 240))
  eq("tools.yoloMode is persisted", saved().tools.yoloMode, "full")
  eq("governor.enforce is persisted as always", saved().governor.enforce, "always")
  eq("critique.enforce is persisted as always", saved().critique.enforce, "always")
  // `forge config set` writes the WHOLE merged object, so the keys are always
  // present; what must not happen is any of them being written TRUE, because
  // `grant()` is `yolo || tools[key]` and a true one outlives `forge yolo off`.
  ok("no grant is persisted TRUE by the mode (so `off` still means off)", ["allowSudo", "allowInterpreterEval", "allowNetworkUpload", "allowNewPlugins", "allowOutsideProject"].every((k) => saved().tools[k] !== true), JSON.stringify(saved().tools))
  ok("it prints the nine flags it just resolved", FULL_CONTROL_FLAGS.every((k) => new RegExp(`${k} (true|false)`).test(full.stdout)), full.stdout?.slice(-400))
  ok("it says what full costs", /WAITING_FOR_USER/.test(full.stdout), full.stdout?.slice(0, 400))

  const status = run(["yolo"])
  ok("`forge yolo` reports mode full from the saved config", /mode:\s+full/.test(status.stdout), status.stdout?.split("\n").slice(0, 4).join(" / "))
  ok("and prints all nine on", FULL_CONTROL_FLAGS.every((k) => new RegExp(`\\n\\s+${k}\\s+on`).test(status.stdout)), status.stdout?.slice(-700))
  ok("it names the env var and the flag for one process", /FORGE_YOLO_MODE=full\|yolo\|off/.test(status.stdout) && /--yolo-full/.test(status.stdout), status.stdout?.slice(-400))

  ok("--yolo-full arms it for ONE process without saving", /mode:\s+full/.test(run(["--yolo-full", "yolo"]).stdout))
  eq("…and the saved file still says full from before (not rewritten by a flag)", saved().tools.yoloMode, "full")
  ok("--safe beats a saved full mode for that process", /YOLO off/.test(run(["--safe", "yolo"]).stdout), run(["--safe", "yolo"]).stdout?.slice(0, 200))

  ok("a doctor answers the mode without reading source", /mode full/.test(run(["doctor"]).stdout), run(["doctor"]).stdout?.split("\n").filter((l) => /control:/.test(l)).join(" / "))
  ok("and says what full costs", /WAITING_FOR_USER/.test(run(["doctor"]).stdout))

  const back = run(["yolo", "on"])
  ok("`forge yolo on` downgrades and says so", /mode = yolo/.test(back.stdout), back.stdout?.slice(0, 240))
  eq("releasing the pins full set", saved().governor.enforce, "auto")
  eq("…both of them", saved().critique.enforce, "auto")
  ok("and the doctor follows the downgrade", !/mode full/.test(run(["doctor"]).stdout), run(["doctor"]).stdout?.split("\n").filter((l) => /control:/.test(l)).join(" / "))
  ok("`forge yolo bogus` is a usage error, not a shrug", run(["yolo", "bogus"]).status !== 0 && /usage: forge yolo/.test(run(["yolo", "bogus"]).stderr + run(["yolo", "bogus"]).stdout))
  const help = run(["--help"]).stdout
  ok("--help documents the mode", /forge yolo \[full\|on\|off\]/.test(help))
  ok("--help documents --yolo-full", /--yolo-full/.test(help))
  ok("--help says what full keeps", /governor and the pre-edit critique KEEP their veto/.test(help))
  try { fs.rmSync(CLI_HOME, { recursive: true, force: true }) } catch {}
}

// ---------------------------------------------------------------------------
console.log("== 8. the grant that was not being read: chat's plugin loader ==")
{
  // `loadChatPlugins` read a bare `unrestricted` that is declared inside
  // startChat — a different function — so every call threw and the best-effort
  // catch swallowed it. Chat loaded ZERO user plugins, silently.
  const src = fs.readFileSync(path.join(ROOT, "chat.js"), "utf8")
  ok("the loader reads the resolved control state", /const control = yoloState\(config \?\? \{\}\)[\s\S]{0,600}allowNewPlugins: control\.allowNewPlugins/.test(src))
  ok("and a loader throw is reported, not swallowed", /plugin loader failed:/.test(src))
  ok("agent.js reads the same resolved grant", /allowNewPlugins: yolo\.allowNewPlugins/.test(fs.readFileSync(path.join(ROOT, "agent.js"), "utf8")))

  // DEFAULT_DIR is resolved once, when config.js is first imported, so the
  // probe goes in the FORGE_HOME this process already has.
  fs.mkdirSync(path.join(HOME, "tools"), { recursive: true })
  fs.writeFileSync(path.join(HOME, "tools", "demo-plugin.js"), [
    "export default {",
    "  name: \"v130_demo_tool\",",
    "  description: \"v130 loader probe\",",
    "  parameters: { type: \"object\", properties: {} },",
    "  async run() { return { ok: true } },",
    "}",
    "",
  ].join("\n"))
  const { loadChatPlugins } = await import("../chat.js")
  const { loadToolPlugins, PLUGINS_DIR } = await import("../plugins.js")
  eq("the probe is in the dir the loader reads", PLUGINS_DIR, path.join(HOME, "tools"))
  const direct = await loadToolPlugins(undefined, { reserved: [], grants: {}, cwd: process.cwd(), startedAt: null, allowNewPlugins: true })
  const via = await loadChatPlugins(defaultConfig(), { cwd: process.cwd(), startedAt: null })
  eq("the direct loader sees the plugin (the probe is valid)", direct.tools.map((t) => t.name), ["v130_demo_tool"])
  eq("and chat's loader sees it too now", via.plugins.map((t) => t.name), ["v130_demo_tool"])
  eq("with no swallowed error behind it", via.errors, [])
  try { await via.pluginHost?.close?.() } catch {}
  try { await direct.close?.() } catch {}
  try { fs.rmSync(path.join(HOME, "tools"), { recursive: true, force: true }) } catch {}
}

console.log(`\n== v130 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
