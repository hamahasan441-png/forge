#!/usr/bin/env node
/**
 * forge — v32 incremental index + language adapters.
 *
 * Skip unchanged file reads (size+mtime). Polyglot symbols without Tree-sitter.
 * JS/PY/GO/RS extractors frozen. FORGE_INDEX=0 never fakes a hit.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or hash every file.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-"))
process.env.FORGE_HOME = HOME
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-work-"))
process.chdir(WORK)

const {
  detectLanguage, extractSymbols, extractImports, jsSymbols, pySymbols,
  goSymbols, rsSymbols, discoverToolchain, adapterCount, ADAPTERS, UNKNOWN,
  isSourceFile, isConfigFile, extractRecord,
} = await import("../forge/lang.js")
const {
  INDEX_VERSION, indexEnabled, indexPath, loadIndex, saveIndex, cacheHit,
  fingerprint, recordFromSource, invalidate, emptyIndex,
} = await import("../forge/index.js")
const { buildRepoMap, getIndexStats, buildSemanticGraph } = await import("../forge/repomap.js")
const { detectTestCommand } = await import("../forge/router.js")
const { defaultConfig, sanitizeProjectConfig } = await import("../forge/config.js")
const { classifyTaskComplexity } = await import("../forge/classify.js")
const { VERSION } = await import("../forge/version.js")

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = "") => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? " — " + String(extra).slice(0, 240) : ""}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

console.log("== detectLanguage / adapters ==")
{
  eq("java", detectLanguage("Foo.java").id, "java")
  eq("kotlin", detectLanguage("Main.kt").id, "kotlin")
  eq("python", detectLanguage("a.py").id, "python")
  eq("go", detectLanguage("main.go").id, "go")
  eq("rust", detectLanguage("lib.rs").id, "rust")
  eq("ts family js", detectLanguage("a.ts").family, "js")
  eq("mts family js", detectLanguage("a.mts").family, "js")
  eq("js family js", detectLanguage("x.mjs").family, "js")
  eq("Dockerfile basename", detectLanguage("Dockerfile").id, "docker")
  eq("Makefile basename", detectLanguage("Makefile").id, "make")
  eq("unknown xyz", detectLanguage("nope.xyz").id, UNKNOWN.id)
  ok("shebang python", detectLanguage("bin/run", "#!/usr/bin/env python3\nprint(1)\n").id === "python")
  ok("shebang node", detectLanguage("run", "#!/usr/bin/env node\n").id === "javascript")
  ok("adapterCount >= 20", adapterCount() >= 20)
  ok("ADAPTERS frozen", Object.isFrozen(ADAPTERS))
  ok("isSource java", isSourceFile("A.java"))
  ok("isSource js", isSourceFile("a.js"))
  ok("not source md", !isSourceFile("README.md"))
  ok("package.json is config", isConfigFile("package.json"))
  ok("docker not source (config via basename)", !isSourceFile("Dockerfile") && isConfigFile("Dockerfile"))
}

console.log("== extractors: JS/PY/GO/RS frozen, java added ==")
{
  const js = jsSymbols("export function alpha(){}\nexport const beta = 1\nfunction notExported(){}\nexport class Gamma {}\n")
  ok("JS export function", js.includes("alpha"))
  ok("JS export const", js.includes("beta"))
  ok("JS export class", js.includes("Gamma"))
  ok("non-exported JS omitted", !js.includes("notExported"))
  const named = jsSymbols("export { a, b as bee }\n")
  ok("TS named export uses exported name", named.includes("bee") && !named.includes("b as bee"))
  ok("python def/class", pySymbols("def top_func():\n    def nested():\n        pass\nclass MyClass:\n    pass\n").includes("top_func")
    && pySymbols("class MyClass:\n    pass\n").includes("MyClass"))
  ok("python nested omitted", !pySymbols("def top_func():\n    def nested():\n        pass\n").includes("nested"))
  const go = goSymbols("func Exported(){}\nfunc unexported(){}\ntype Widget struct{}\n")
  ok("Go exported", go.includes("Exported") && go.includes("Widget") && !go.includes("unexported"))
  const rs = rsSymbols("pub fn do_it(){}\nfn private(){}\npub struct Config{}\n")
  ok("Rust pub", rs.includes("do_it") && rs.includes("Config") && !rs.includes("private"))
  const java = extractSymbols("A.java", "public class Foo {\n  public void bar() {}\n}\ninterface Baz {}\n")
  ok("java class", java.includes("Foo"))
  ok("java interface", java.includes("Baz"))
  const rb = extractSymbols("a.rb", "class Widget\nend\ndef ping\nend\nmodule Util\nend\n")
  ok("ruby class/def/module", rb.includes("Widget") && rb.includes("ping") && rb.includes("Util"))
  const php = extractSymbols("a.php", "<?php\nclass User {}\nfunction greet() {}\n")
  ok("php class/function", php.includes("User") && php.includes("greet"))
  const tf = extractSymbols("main.tf", 'resource "aws_s3_bucket" "logs" {\n}\n')
  ok("terraform resource name", tf.includes("logs"))
  ok("unknown symbols empty", extractSymbols("x.xyz", "function nope() {}").length === 0)
  ok("java import", extractImports("A.java", "import java.util.List;\n").includes("java.util.List"))
  const rec = extractRecord("a.ts", "export function run(){}\ninterface Opts {}\n", "src/a.ts")
  eq("record lang ts", rec.lang, "typescript")
  ok("record symbols", rec.symbols.includes("run"))
}

console.log("== index: load/save/hit/corrupt ==")
{
  eq("INDEX_VERSION", INDEX_VERSION, 1)
  ok("enabled by default", indexEnabled() === true)
  const st = { size: 12, mtimeMs: 1700000000123 }
  const fp = fingerprint(st)
  eq("fp size", fp.size, 12)
  eq("fp mtime rounded", fp.mtime, 1700000000123)
  ok("hit needs symbols array", cacheHit({ ...fp, symbols: ["a"] }, st) === true)
  ok("fingerprint alone is not a hit", cacheHit(fp, st) === false)
  ok("wrong size misses", cacheHit({ size: 1, mtime: fp.mtime, symbols: [] }, st) === false)
  const idxPath = indexPath(WORK)
  ok("index lives under forge state", idxPath.includes("projects") && idxPath.endsWith("index.json"))
  const empty = emptyIndex()
  eq("empty version", empty.version, 1)
  ok("empty files object", empty.files && !Array.isArray(empty.files))
  fs.mkdirSync(path.dirname(idxPath), { recursive: true })
  fs.writeFileSync(idxPath, "not-json{{{")
  const loaded = loadIndex(WORK)
  ok("corrupt → empty, no throw", loaded.version === 1 && Object.keys(loaded.files).length === 0)
  fs.writeFileSync(idxPath, JSON.stringify({ version: 99, files: { "a.js": { size: 1, mtime: 1, symbols: [] } } }))
  ok("wrong version → empty", Object.keys(loadIndex(WORK).files).length === 0)
  ok("save roundtrip", saveIndex(WORK, { files: { "a.js": { size: 3, mtime: 4, symbols: ["z"] } } }))
  eq("saved symbol", loadIndex(WORK).files["a.js"].symbols[0], "z")
  eq("invalidate one", invalidate(WORK, ["a.js"]), 1)
  ok("invalidated gone", !loadIndex(WORK).files["a.js"])
  const rec = recordFromSource("a.js", "export function zed(){}\n", path.join(WORK, "a.js"), { size: 8, mtimeMs: 9 })
  ok("recordFromSource symbols", rec.symbols.includes("zed") && rec.size === 8 && rec.lang === "javascript")
}

console.log("== walk: reuse unchanged, reparse touched, FORGE_INDEX=0 ==")
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-tree-"))
  fs.mkdirSync(path.join(tree, "src"))
  fs.writeFileSync(path.join(tree, "src", "a.js"), "export function alpha(){}\n")
  fs.writeFileSync(path.join(tree, "src", "b.js"), "export function beta(){}\n")
  fs.writeFileSync(path.join(tree, "src", "Foo.java"), "public class Foo {}\n")
  const map1 = buildRepoMap(tree)
  ok("map has alpha", /alpha/.test(map1))
  ok("map has java Foo", /Foo/.test(map1))
  const s1 = getIndexStats()
  ok("first scan parses", s1.parsed >= 3 && s1.reused === 0)
  ok("first scan persisted", s1.persisted === true)
  const map2 = buildRepoMap(tree)
  eq("second map identical", map2, map1)
  const s2 = getIndexStats()
  eq("second scan parsed 0", s2.parsed, 0)
  ok("second scan reused", s2.reused >= 3)
  fs.appendFileSync(path.join(tree, "src", "a.js"), "// touch\n")
  buildRepoMap(tree)
  const s3 = getIndexStats()
  eq("touch one → parsed 1", s3.parsed, 1)
  ok("touch one → rest reused", s3.reused >= 2)
  const g = buildSemanticGraph(tree)
  ok("graph has java file", g.files.some((f) => f.lang === "java" && f.symbols.includes("Foo")))
  ok("graph stats reused", g.stats.reused >= 0 && g.stats.parsed >= 0)
  fs.rmSync(tree, { recursive: true, force: true })
}

console.log("== FORGE_INDEX=0 never fakes a hit ==")
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-off-"))
  fs.writeFileSync(path.join(tree, "a.js"), "export function off(){}\n")
  const prev = process.env.FORGE_INDEX
  process.env.FORGE_INDEX = "0"
  eq("indexEnabled false", indexEnabled(), false)
  buildRepoMap(tree)
  const a = getIndexStats()
  ok("disabled first parse", a.parsed >= 1 && a.reused === 0)
  eq("disabled not persisted", a.persisted, false)
  ok("no index file written", !fs.existsSync(indexPath(tree)) || !loadIndex(tree).files["a.js"])
  buildRepoMap(tree)
  const b = getIndexStats()
  ok("disabled second still parses", b.parsed >= 1 && b.reused === 0)
  if (prev === undefined) delete process.env.FORGE_INDEX
  else process.env.FORGE_INDEX = prev
  fs.rmSync(tree, { recursive: true, force: true })
}

console.log("== discoverToolchain / detectTestCommand ==")
{
  eq("empty invents nothing", detectTestCommand(WORK), "")
  const npm = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-npm-"))
  fs.writeFileSync(path.join(npm, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }))
  eq("npm test", detectTestCommand(npm), "npm test")
  const buildOnly = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-build-"))
  fs.writeFileSync(path.join(buildOnly, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }))
  eq("npm build-as-test frozen", detectTestCommand(buildOnly), "npm run build")
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-gem-"))
  fs.writeFileSync(path.join(gem, "Gemfile"), "source 'https://rubygems.org'\n")
  eq("Gemfile rake", detectTestCommand(gem), "bundle exec rake test")
  const pom = fs.mkdtempSync(path.join(os.tmpdir(), "forge-v32-pom-"))
  fs.writeFileSync(path.join(pom, "pom.xml"), "<project/>")
  eq("pom mvn", detectTestCommand(pom), "mvn test")
  const t = discoverToolchain(npm)
  eq("toolchain test", t.test, "npm test")
  ok("toolchain languages", t.languages.includes("javascript"))
  fs.rmSync(npm, { recursive: true, force: true })
  fs.rmSync(buildOnly, { recursive: true, force: true })
  fs.rmSync(gem, { recursive: true, force: true })
  fs.rmSync(pom, { recursive: true, force: true })
}

console.log("== frozen kernel + package ==")
{
  const cfg = defaultConfig()
  eq("assumeYes stays false", cfg.tools.assumeYes, false)
  eq("allowSudo stays false", cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok("project cannot flip assumeYes", dropped.includes("tools.assumeYes"))
  eq("classifyTaskComplexity frozen", classifyTaskComplexity("fix a typo"), "trivial")
  eq("VERSION is 40.0.0", VERSION, "40.0.0")
  const pkg = JSON.parse(fs.readFileSync(new URL("../forge/package.json", import.meta.url), "utf8"))
  eq("package.json is 40.0.0", pkg.version, "40.0.0")
  ok("files includes lang.js", pkg.files.includes("lang.js"))
  ok("files includes index.js", pkg.files.includes("index.js"))
  eq("zero runtime deps", Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v32 suite: ${PASS} passed, ${FAIL} failed ==`)
process.exit(FAIL ? 1 : 0)
