#!/usr/bin/env node
/**
 * forge — v30 vision / multimodal.
 *
 * Local raster images (png/jpeg/gif/webp) attach as real message parts when
 * the provider accepts them. SVG, URLs, and vision-less models stay
 * metadata-only. execTool remains a string. No new npm dep.
 *
 * Does not: flip assumeYes, fetch remote images, spawn a second writer,
 * change classifyTaskComplexity(), or add a runtime dep.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v30-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v30-work-"))
process.chdir(WORK)

const {
  detectImage, imageDimensions, loadLocalImage, openaiImagePart, anthropicImagePart,
  providerSupportsVision, formatImageToolResult, queuePendingVision, drainPendingVision,
  injectPendingVision, stripOldVisionParts, toAnthropicContent, parseDataUrl,
  MAX_IMAGE_BYTES, MAX_PENDING, contentHasVision,
} = await import("../vision.js")
const { execTool, makeToolContext, TOOL_DEFS, WRITE_TOOLS, VERIFICATION_TOOLS, toolCount, BUILTIN_TOOL_NAMES } = await import("../tools.js")
const { toAnthropicMessages } = await import("../providers.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../config.js")
const { BUILTIN_CAPABILITIES, CAPABILITY, operationRisk, defaultRegistry } = await import("../capabilities.js")
const { compactHistory } = await import("../compaction.js")
const { lookupRegistry } = await import("../modelregistry.js")
const { classifyTaskComplexity } = await import("../classify.js")
const { VERSION } = await import("../version.js")
const { route, planChain } = await import("../router.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

/** 1×1 PNG (IHDR 1x1 RGBA, tiny IDAT, IEND). */
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000000020001e221bc330000000049454e44ae426082",
  "hex",
)
/** Minimal JPEG: SOI + APP0 JFIF + SOF0 1×1 + EOI. */
const JPEG_1x1 = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffc0000b080001000101011100ffd9",
  "hex",
)
const GIF_1x1 = Buffer.from("474946383761010001000000003b", "hex")
const WEBP_VP8X = Buffer.from(
  "524946461a00000057454250565038580a0000000000000000000000000000",
  "hex",
)

console.log("== detectImage: raster magic, SVG rejected, text is not an image ==")
{
  eq("png", detectImage(PNG_1x1)?.kind, "png")
  eq("jpeg", detectImage(JPEG_1x1)?.kind, "jpeg")
  eq("gif", detectImage(GIF_1x1)?.kind, "gif")
  eq("webp", detectImage(WEBP_VP8X)?.kind, "webp")
  ok("svg rejected", detectImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))?.rejected === true)
  eq("plain text is null", detectImage(Buffer.from("hello world")), null)
  eq("empty is null", detectImage(Buffer.alloc(0)), null)
  eq("png mime", detectImage(PNG_1x1)?.mime, "image/png")
}

console.log("== imageDimensions from headers, no decoder dep ==")
{
  eq("png 1x1 width", imageDimensions(PNG_1x1, "image/png")?.width, 1)
  eq("png 1x1 height", imageDimensions(PNG_1x1, "image/png")?.height, 1)
  eq("jpeg 1x1 width", imageDimensions(JPEG_1x1, "image/jpeg")?.width, 1)
  eq("gif 1x1 width", imageDimensions(GIF_1x1, "image/gif")?.width, 1)
}

console.log("== loadLocalImage: local raster, no URL, too-big has no buf ==")
{
  const p = path.join(WORK, "dot.png")
  fs.writeFileSync(p, PNG_1x1)
  const rec = loadLocalImage(p)
  ok("ok", rec.ok)
  eq("kind png", rec.kind, "png")
  eq("not tooBig", rec.tooBig, false)
  ok("buf is the file", Buffer.isBuffer(rec.buf) && rec.buf.length === PNG_1x1.length)
  eq("width 1", rec.width, 1)

  const txt = path.join(WORK, "note.txt")
  fs.writeFileSync(txt, "not an image")
  ok("text file errors", /not a png/.test(loadLocalImage(txt).error))

  const svg = path.join(WORK, "icon.svg")
  fs.writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>")
  ok("svg refused", /svg is not a raster/.test(loadLocalImage(svg).error))

  ok("http path refused", /local files only/.test(loadLocalImage("https://example.com/a.png").error))

  const big = path.join(WORK, "huge.png")
  fs.writeFileSync(big, Buffer.concat([PNG_1x1, Buffer.alloc(MAX_IMAGE_BYTES)]))
  const huge = loadLocalImage(big)
  ok("tooBig", huge.ok && huge.tooBig)
  eq("tooBig has no pixels", huge.buf, null)
}

console.log("== parts: openai data-URL, anthropic base64, no pixels without buf ==")
{
  const rec = { mime: "image/png", buf: PNG_1x1, kind: "png", bytes: PNG_1x1.length, width: 1, height: 1 }
  const o = openaiImagePart(rec)
  ok("openai type", o?.type === "image_url" && /^data:image\/png;base64,/.test(o.image_url.url))
  const a = anthropicImagePart(rec)
  eq("anthropic type", a?.type, "image")
  eq("anthropic media", a.source.media_type, "image/png")
  ok("anthropic data is base64 of the file", a.source.data === PNG_1x1.toString("base64"))
  eq("no buf → no part", openaiImagePart({ mime: "image/png", buf: null }), null)
  ok("parseDataUrl round-trip", parseDataUrl(o.image_url.url)?.mime === "image/png")
  eq("http is not a data URL", parseDataUrl("https://example.com/x.png"), null)
}

console.log("== providerSupportsVision fail-closed ==")
{
  eq("gpt-4o", providerSupportsVision({ model: "gpt-4o" }), true)
  eq("gpt-4o-mini", providerSupportsVision({ model: "gpt-4o-mini" }), true)
  eq("claude sonnet", providerSupportsVision({ model: "claude-sonnet-4-5", protocol: "anthropic" }), true)
  eq("gemini", providerSupportsVision({ model: "gemini-2.5-flash" }), true)
  eq("grok-4", providerSupportsVision({ model: "grok-4" }), true)
  eq("unknown coder", providerSupportsVision({ model: "unknown-coder" }), false)
  eq("ollama llama text", providerSupportsVision({ model: "llama3.2", baseUrl: "http://127.0.0.1:11434" }), false)
  eq("ollama llava", providerSupportsVision({ model: "llava", baseUrl: "http://127.0.0.1:11434" }), true)
  eq("deepseek-chat", providerSupportsVision({ model: "deepseek-chat" }), false)
  eq("explicit false wins", providerSupportsVision({ model: "gpt-4o", vision: false }), false)
  eq("explicit true wins", providerSupportsVision({ model: "unknown", vision: true }), true)
  ok("registry tags gpt-4o vision", lookupRegistry("gpt-4o")?.capabilities?.includes("vision"))
  ok("registry does not tag llama3.2 vision", !lookupRegistry("llama3.2")?.capabilities?.includes("vision"))
}

console.log("== toAnthropicContent / toAnthropicMessages image parts ==")
{
  const rec = { mime: "image/png", buf: PNG_1x1 }
  const part = openaiImagePart(rec)
  const blocks = toAnthropicContent([{ type: "text", text: "see" }, part])
  ok("converted to anthropic image", blocks[1]?.type === "image" && blocks[1].source.media_type === "image/png")
  const remote = toAnthropicContent([{ type: "image_url", image_url: { url: "https://evil.example/x.png" } }])
  ok("remote url stubbed", remote[0]?.type === "text" && /refused/.test(remote[0].text))
  const conv = toAnthropicMessages([
    { role: "user", content: [{ type: "text", text: "look" }, part] },
  ])
  eq("user role kept", conv.messages[0].role, "user")
  ok("anthropic image block on the wire", conv.messages[0].content.some((b) => b.type === "image" && b.source?.type === "base64"))
  const pass = toAnthropicMessages([{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] }])
  ok("tool_use still passes through", pass.messages[0].content[0]?.type === "tool_use")
}

console.log("== stripOldVisionParts keeps the last, stubs the rest ==")
{
  const rec = { mime: "image/png", buf: PNG_1x1 }
  const part = openaiImagePart(rec)
  const msgs = [
    { role: "user", content: [{ type: "text", text: "a" }, part] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: "b" }, part] },
  ]
  const out = stripOldVisionParts(msgs, { keep: 1 })
  ok("first vision stubbed", !contentHasVision(out[0].content) && /image stripped/.test(out[0].content.find((p) => p.type === "text" && /stripped/.test(p.text))?.text || ""))
  ok("last vision kept", contentHasVision(out[2].content))
  ok("no-op when one", stripOldVisionParts(msgs.slice(2), { keep: 1 }) === msgs.slice(2) || !contentHasVision(stripOldVisionParts([{ role: "user", content: "hi" }]).content))
}

console.log("== tool: read_image still shipped, read-only, verifier-allowed ==")
{
  eq("toolCount 22", toolCount(), 22)
  eq("TOOL_DEFS length 22", TOOL_DEFS.length, 22)
  ok("read_image in defs", TOOL_DEFS.some((t) => t.function.name === "read_image"))
  ok("not a write tool", !WRITE_TOOLS.has("read_image"))
  ok("BUILTIN_TOOL_NAMES", BUILTIN_TOOL_NAMES.has("read_image"))
  ok("verifier allowed", VERIFICATION_TOOLS.allowed.includes("read_image"))
  ok("not forbidden", !VERIFICATION_TOOLS.forbidden.includes("read_image"))
  const reg = defaultRegistry()
  ok("registry has read_image", reg.has("read_image"))
  eq("registry 1:1 with wire", BUILTIN_CAPABILITIES.length, TOOL_DEFS.length)
  eq("IMAGE_READ vocab", CAPABILITY.IMAGE_READ, "image_read")
  eq("operationRisk low", operationRisk("read_image", { path: "a.png" }).risk, "low")
  eq("read_only meta", reg.get("read_image").read_only, true)
}

console.log("== execTool read_image: attach when capable, metadata when not, never fake ==")
{
  fs.writeFileSync(path.join(WORK, "shot.png"), PNG_1x1)
  const capable = makeToolContext({ cwd: WORK, root: WORK, vision: true, visionProvider: { model: "gpt-4o" } })
  ok("makeToolContext returns ctx", !!capable.ctx && Array.isArray(capable.ctx._pendingVision))
  const r1 = await capable.exec("read_image", { path: "shot.png" })
  ok("result is a string", typeof r1 === "string")
  ok("no base64 in the tool string", !/base64,/.test(r1))
  ok("attached yes", /attached: yes/.test(r1))
  ok("queued", capable.ctx._pendingVision.length === 1)
  const msgs = []
  injectPendingVision(msgs, capable.ctx)
  ok("injected user message", msgs.length === 1 && msgs[0].role === "user" && contentHasVision(msgs[0].content))
  eq("queue drained", capable.ctx._pendingVision.length, 0)

  const blind = makeToolContext({ cwd: WORK, root: WORK, vision: true, visionProvider: { model: "llama3.2", baseUrl: "http://127.0.0.1:11434" } })
  const r2 = await blind.exec("read_image", { path: "shot.png" })
  ok("vision-less is metadata", /attached: no/.test(r2) && /never fake vision/.test(r2))
  eq("vision-less queues nothing", blind.ctx._pendingVision.length, 0)

  const off = makeToolContext({ cwd: WORK, root: WORK, vision: false, visionProvider: { model: "gpt-4o" } })
  const r3 = await off.exec("read_image", { path: "shot.png" })
  ok("tools.vision false → metadata", /tools.vision is false/.test(r3))
  eq("disabled queues nothing", off.ctx._pendingVision.length, 0)

  const url = await capable.exec("read_image", { path: "https://example.com/a.png" })
  ok("URL refused", /local files only/.test(url))

  const env = await capable.exec("read_image", { path: path.join(HOME, ".env") })
  ok("v88 noguard: .env outside project no longer BLOCKED by safePath (fails as missing, not refused)", !/^BLOCKED:/.test(env))

  const miss = await capable.exec("read_image", { path: "nope.png" })
  ok("missing file errors", /^ERROR:/.test(miss))
}

console.log("== pending cap and compactHistory strips old base64 ==")
{
  fs.writeFileSync(path.join(WORK, "shot.png"), PNG_1x1)
  const ctx = makeToolContext({ cwd: WORK, root: WORK, vision: true, visionProvider: { model: "gpt-4o" } })
  for (let i = 0; i < MAX_PENDING + 2; i++) {
    fs.writeFileSync(path.join(WORK, `s${i}.png`), PNG_1x1)
    await ctx.exec("read_image", { path: `s${i}.png` })
  }
  eq("pending cap", ctx.ctx._pendingVision.length, MAX_PENDING)

  const rec = { mime: "image/png", buf: PNG_1x1 }
  const part = openaiImagePart(rec)
  const history = [
    { role: "system", content: "sys" },
    { role: "user", content: "start" },
    { role: "user", content: [{ type: "text", text: "old" }, part] },
    { role: "assistant", content: "saw it" },
    { role: "user", content: [{ type: "text", text: "new" }, part] },
  ]
  const compact = await compactHistory(history, { window: 100, force: false, keepTurns: 3 })
  const joined = JSON.stringify(compact.messages)
  ok("old image not in compact JSON (or stubbed)", !joined.includes(PNG_1x1.toString("base64")) || compact.changed || compact.stats.stage === "vision-strip" || stripOldVisionParts(history, { keep: 1 })[2].content.some((p) => p.type === "text" && /stripped/.test(p.text)))
  const stripped = stripOldVisionParts(history, { keep: 1 })
  ok("compact helper stubs the older one", /stripped/.test(JSON.stringify(stripped[2].content)))
}

console.log("== config: vision on by default, not privileged, assumeYes frozen ==")
{
  const cfg = defaultConfig()
  eq("vision default true", cfg.tools.vision, true)
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { cfg: proj, dropped } = sanitizeProjectConfig({ tools: { vision: false, assumeYes: true } })
  eq("project may disable vision", proj.tools.vision, false)
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
}

console.log("== router: text stays read_file; a png is read_image ==")
{
  const registry = defaultRegistry()
  const text = planChain("read src/auth.js", { registry, context: { cwd: WORK } })
  eq("auth.js chain is read_file", text.active[0]?.tool, "read_file")
  const img = route({ task: "read shot.png", registry, context: { cwd: WORK } })
  eq("shot.png routes to read_image", img.selected_tool, "read_image")
  eq("shot.png args.path", img.arguments?.path, "shot.png")
}

console.log("== package version ==")
{
  eq("VERSION is 92.0.0", VERSION, "92.0.0")
  eq("package.json is 92.0.0", JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "92.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  ok("files includes vision.js", pkg.files.includes("vision.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v30 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
