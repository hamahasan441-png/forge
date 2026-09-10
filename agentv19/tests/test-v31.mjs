#!/usr/bin/env node
/**
 * forge — v31 browser tool.
 *
 * Opt-in binary. Absent → UNAVAILABLE, never a crash, never a fake DOM.
 * Injected mock driver covers open/snapshot/click/screenshot without chromium.
 * SSRF / file:// / javascript: policy is the real netguard + safePath.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or put browser in WRITE_TOOLS.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v31-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v31-work-"))
process.chdir(WORK)

const {
  detectBrowser, findBrowserBinary, validateTarget, sanitizeRef,
  createMockDriver, runBrowser, closeBrowserSession,
  browserMutatesFilesystem, isPageMutating, isVerifyAction, ACTIONS,
} = await import("../forge/browser.js")
const { execTool, makeToolContext, TOOL_DEFS, WRITE_TOOLS, VERIFICATION_TOOLS, toolCount, BUILTIN_TOOL_NAMES, verificationAllows, isReadOnlyViolation } = await import("../forge/tools.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { BUILTIN_CAPABILITIES, CAPABILITY, operationRisk, defaultRegistry } = await import("../forge/capabilities.js")
const { classifyTaskComplexity } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")
const { route, analyzeTask, INTENT } = await import("../forge/router.js")
const { contentHasVision, injectPendingVision } = await import("../forge/vision.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== detectBrowser: absent binary is none, never throws ==")
{
  const d = detectBrowser({ binary: null })
  eq("available false", d.available, false)
  eq("kind none", d.kind, "none")
  eq("binary null", d.binary, null)
  ok("hint mentions install", /chromium|agent-browser|FORGE_BROWSER/.test(d.hint))
  const prev = process.env.FORGE_BROWSER
  process.env.FORGE_BROWSER = "0"
  ok("FORGE_BROWSER=0 disables", findBrowserBinary() === null)
  if (prev === undefined) delete process.env.FORGE_BROWSER
  else process.env.FORGE_BROWSER = prev
}

console.log("== validateTarget: javascript/data refused, SSRF, file:// project ==")
{
  const js = await validateTarget("javascript:alert(1)")
  ok("javascript refused", js.ok === false && /javascript/.test(js.error))
  const data = await validateTarget("data:text/html,hi")
  ok("data refused", data.ok === false && /data/.test(data.error))
  const blob = await validateTarget("blob:https://example.com/x")
  ok("blob refused", blob.ok === false)
  const blank = await validateTarget("about:blank")
  ok("about:blank ok", blank.ok === true && blank.url === "about:blank")
  const loop = await validateTarget("http://127.0.0.1/", { fetchPrivateUrls: false })
  ok("loopback blocked", loop.ok === false && /BLOCKED/.test(loop.error))
  const meta = await validateTarget("http://169.254.169.254/", {})
  ok("metadata blocked", meta.ok === false && /BLOCKED/.test(meta.error))
  const pub = await validateTarget("https://example.com/path", {})
  ok("public https ok", pub.ok === true && pub.kind === "http")
  const etc = await validateTarget("file:///etc/passwd", { root: WORK, cwd: WORK })
  ok("file /etc/passwd blocked", etc.ok === false && /BLOCKED/.test(etc.error))
  fs.writeFileSync(path.join(WORK, "ui.html"), "<html><button>Go</button></html>")
  const local = await validateTarget("file://" + path.join(WORK, "ui.html"), {
    root: WORK, cwd: WORK,
    checkPath: (p) => {
      const abs = path.resolve(WORK, p)
      const rel = path.relative(WORK, abs)
      if (rel.startsWith("..")) return { ok: false, error: "BLOCKED: escapes" }
      return { ok: true, abs }
    },
  })
  ok("file inside project ok", local.ok === true && local.kind === "file")
  const empty = await validateTarget("  ")
  ok("empty url errors", empty.ok === false)
}

console.log("== sanitizeRef + action flags ==")
{
  eq("ref @e1", sanitizeRef("@e1").id, "e1")
  eq("ref e2", sanitizeRef("e2").kind, "ref")
  ok("css selector", sanitizeRef("#main .btn").kind === "css")
  ok("newline rejected", !!sanitizeRef("a\nb").error)
  ok("empty rejected", !!sanitizeRef("").error)
  ok("ACTIONS has open", ACTIONS.includes("open") && ACTIONS.includes("screenshot"))
  eq("click mutates page", isPageMutating("click"), true)
  eq("snapshot does not", isPageMutating("snapshot"), false)
  eq("snapshot is verify", isVerifyAction("snapshot"), true)
  eq("click is not verify", isVerifyAction("click"), false)
  eq("screenshot no path not fs", browserMutatesFilesystem({ action: "screenshot" }), false)
  eq("screenshot path is fs", browserMutatesFilesystem({ action: "screenshot", path: "shot.png" }), true)
}

console.log("== mock driver: open / snapshot / click / screenshot ==")
{
  const state = {}
  const driver = createMockDriver(state)
  const ctx = makeToolContext({ cwd: WORK, root: WORK, vision: true, visionProvider: { model: "gpt-4o" }, browserDriver: driver }).ctx
  const open = await execTool(ctx, "browser", { action: "open", url: "https://example.com" })
  ok("open is string", typeof open === "string")
  ok("open mentions example", /example.com/.test(open))
  ok("not UNAVAILABLE", !/UNAVAILABLE/.test(open))
  const snap = await execTool(ctx, "browser", { action: "snapshot" })
  ok("snapshot has @e1", /@e1/.test(snap) && /Submit/.test(snap))
  const click = await execTool(ctx, "browser", { action: "click", ref: "@e1" })
  ok("clicked @e1", /clicked @e1/.test(click))
  eq("state recorded click", state.lastClick, "@e1")
  const shot = await execTool(ctx, "browser", { action: "screenshot" })
  ok("screenshot no base64 in result", !/base64,/.test(shot) && /attached: yes/.test(shot))
  ok("queued vision", ctx._pendingVision.length === 1)
  const msgs = []
  injectPendingVision(msgs, ctx)
  ok("injected vision user message", msgs.length === 1 && contentHasVision(msgs[0].content))
  const filled = await execTool(ctx, "browser", { action: "fill", ref: "@e2", text: "hello" })
  ok("fill", /filled/.test(filled) && state.lastFill?.text === "hello")
  const closed = await execTool(ctx, "browser", { action: "close" })
  ok("close", /closed/.test(closed))
  eq("closeBrowserSession idle", await closeBrowserSession(ctx), "browser idle (nothing to close)")
}

console.log("== UNAVAILABLE: no binary, tools.browser false ==")
{
  const prev = process.env.FORGE_BROWSER
  process.env.FORGE_BROWSER = "0"
  const ctx = makeToolContext({ cwd: WORK, root: WORK, browser: true, browserBinary: null }).ctx
  ctx.browserBinary = null
  const r = await runBrowser({ ...ctx, browserBinary: null, _browserDriver: null }, { action: "open", url: "https://example.com" })
  ok("no binary is UNAVAILABLE not ERROR", /^UNAVAILABLE:/.test(r), r)
  ok("mentions binary", /binary/.test(r))
  const off = makeToolContext({ cwd: WORK, root: WORK, browser: false, browserDriver: createMockDriver() }).ctx
  const r2 = await execTool(off, "browser", { action: "open", url: "https://example.com" })
  ok("tools.browser false UNAVAILABLE", /UNAVAILABLE/.test(r2) && /tools.browser is false/.test(r2))
  if (prev === undefined) delete process.env.FORGE_BROWSER
  else process.env.FORGE_BROWSER = prev
}

console.log("== tool: 19th is browser, not a write tool, verifier look-not-drive ==")
{
  eq("toolCount 19", toolCount(), 19)
  eq("TOOL_DEFS length 19", TOOL_DEFS.length, 19)
  ok("browser in defs", TOOL_DEFS.some((t) => t.function.name === "browser"))
  ok("not a write tool", !WRITE_TOOLS.has("browser"))
  ok("BUILTIN_TOOL_NAMES", BUILTIN_TOOL_NAMES.has("browser"))
  ok("verifier allowed", VERIFICATION_TOOLS.allowed.includes("browser"))
  ok("not forbidden", !VERIFICATION_TOOLS.forbidden.includes("browser"))
  ok("snapshot verify ok", verificationAllows("browser", { action: "snapshot" }).ok === true)
  ok("click verify blocked", verificationAllows("browser", { action: "click", ref: "@e1" }).ok === false)
  ok("screenshot path verify blocked", verificationAllows("browser", { action: "screenshot", path: "x.png" }).ok === false)
  ok("screenshot no path verify ok", verificationAllows("browser", { action: "screenshot" }).ok === true)
  const ro = isReadOnlyViolation("browser", { action: "screenshot", path: "x.png" }, true)
  ok("screenshot path is read-only violation", !!ro && /filesystem/.test(ro))
  eq("snapshot not a read-only violation", isReadOnlyViolation("browser", { action: "snapshot" }, true), null)
  const reg = defaultRegistry()
  ok("registry has browser", reg.has("browser"))
  eq("registry 1:1 with wire", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  eq("BROWSER vocab", CAPABILITY.BROWSER, "browser_automation")
  eq("operationRisk medium", operationRisk("browser", { action: "open", url: "https://example.com" }).risk, "medium")
  eq("read_only meta", reg.get("browser").read_only, true)
  eq("not parallel_safe", reg.get("browser").parallel_safe, false)
}

console.log("== execTool: loopback still blocked even with mock driver ==")
{
  const ctx = makeToolContext({ cwd: WORK, root: WORK, browserDriver: createMockDriver(), fetchPrivateUrls: false }).ctx
  const r = await execTool(ctx, "browser", { action: "open", url: "http://127.0.0.1/" })
  ok("loopback BLOCKED", /^BLOCKED/.test(r), r)
  const js = await execTool(ctx, "browser", { action: "open", url: "javascript:alert(1)" })
  ok("javascript ERROR", /javascript/.test(js))
}

console.log("== config: browser on by default, not privileged, assumeYes frozen ==")
{
  const cfg = defaultConfig()
  eq("browser default true", cfg.tools.browser, true)
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { cfg: proj, dropped } = sanitizeProjectConfig({ tools: { browser: false, assumeYes: true } })
  eq("project may disable browser", proj.tools.browser, false)
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
}

console.log("== router: UI tasks pick browser; file reads stay read_file ==")
{
  const registry = defaultRegistry()
  const text = route({ task: "read src/auth.js", registry, context: { cwd: WORK } })
  eq("auth.js stays read_file", text.selected_tool, "read_file")
  const ui = analyzeTask("open https://example.com and snapshot the page")
  eq("browse intent", ui.primary, INTENT.BROWSE)
  const br = route({ task: "snapshot the page at https://example.com", registry, context: { cwd: WORK } })
  eq("browser tool", br.selected_tool, "browser")
}

console.log("== package version ==")
{
  eq("VERSION is 43.0.0", VERSION, "43.0.0")
  eq("package.json is 43.0.0", JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8")).version, "43.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  ok("files includes browser.js", pkg.files.includes("browser.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v31 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
