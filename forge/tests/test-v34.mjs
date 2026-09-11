#!/usr/bin/env node
/**
 * forge — v34 skill evaluator, plugin selector, integrator.
 *
 * Does not: flip assumeYes, add a runtime dep, spawn a second writer,
 * change classifyTaskComplexity(), or auto-grant plugins.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v34-'))
process.env.FORGE_HOME = HOME
delete process.env.FORGE_SKILLS_ALL
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v34-work-'))
process.chdir(WORK)

const { evaluateSkills, formatSkillPicks, selectPlugins, scoreAgainst, namedIn } = await import('../evaluate.js')
const { integrateResults, ensureIntegrator, reportsFromGraph, isIntegratorRole } = await import('../integrate.js')
const { ROLES, roleIsReadOnly } = await import('../agentmanager.js')
const { skillDescription, indexSkills } = await import('../skills.js')
const { classifyTaskComplexity, classifyTask, TASK_CLASS, synthesizePlan } = await import('../classify.js')
const { validatePlan } = await import('../dag.js')
const { isStale, writesFromIndex, fact } = await import('../evidence.js')
const { lessonIsStale, recordLesson, relevantLessons } = await import('../lessons.js')
const { defaultConfig, sanitizeProjectConfig } = await import('../config.js')
const { VERSION } = await import('../version.js')

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = '') => {
  if (cond) { PASS++; console.log(`  ok   ${name}`) }
  else { FAIL++; console.log(`  FAIL ${name}${extra ? ' — ' + String(extra).slice(0, 240) : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)

const SKILLS = [
  { name: 'coding-agent', desc: 'Coding workflow with planning, implementation, verification, and testing' },
  { name: 'fullstack-dev', desc: 'Fullstack web development with Next.js, TypeScript, Prisma ORM, API routes' },
  { name: 'blog-writer', desc: 'Write a blog post from an outline' },
  { name: 'gift-evaluator', desc: 'Evaluate gift ideas for friends and family' },
  { name: 'dream-interpreter', desc: 'Interpret dreams and symbols' },
  { name: 'get-fortune-analysis', desc: 'Read fortune and horoscope' },
  { name: 'broken', desc: 'broken pack', ok: false },
]

console.log('== evaluateSkills ==')
{
  eq('typo is empty', evaluateSkills('fix a typo in README', SKILLS).length, 0)
  eq('empty task is empty', evaluateSkills('', SKILLS).length, 0)
  eq('empty list is empty', evaluateSkills('implement an API', []).length, 0)
  const api = evaluateSkills('implement a Next.js API route with prisma across files', SKILLS)
  ok('api picks fullstack or coding', api.some((s) => s.name === 'fullstack-dev' || s.name === 'coding-agent'))
  ok('api does not pick fortune', !api.some((s) => /fortune|gift|dream/.test(s.name)))
  eq('api top-k <= 3', api.length <= 3, true)
  const named = evaluateSkills('use coding-agent for this typo', SKILLS)
  ok('named skill on MICRO still selected', named.some((s) => s.name === 'coding-agent'))
  ok('broken never selected', !evaluateSkills('broken pack please', SKILLS).some((s) => s.name === 'broken'))
  ok('fortune task does not pick coding-agent first', evaluateSkills('read my fortune', SKILLS)[0]?.name !== 'coding-agent')
  eq('format empty is empty', formatSkillPicks([]), '')
  ok('format lists name', /coding-agent/.test(formatSkillPicks(named)))
  ok('namedIn hyphen', namedIn('please load coding-agent now', 'coding-agent'))
  ok('score name weighs more than noise', scoreAgainst('prisma api', 'fullstack-dev', 'Prisma ORM API routes') > scoreAgainst('prisma api', 'gift-evaluator', 'gifts'))
}

console.log('== skillDescription frontmatter ==')
{
  const md = '---\nname: fullstack-dev\ndescription: "Fullstack with Prisma and API routes"\n---\n\n# Fullstack\n'
  ok('frontmatter description wins', skillDescription(md).includes('Prisma'))
  eq('h1 fallback', skillDescription('# Hello Skill\n\nbody\n'), 'Hello Skill')
}

console.log('== selectPlugins ==')
{
  const jira = { name: 'jira_issue', isolated: true, description: 'Fetch a Jira issue by key', def: { function: { name: 'jira_issue', description: 'Fetch a Jira issue by key' } } }
  const fmt = { name: 'gofmt_run', isolated: true, description: 'Run gofmt on Go files', def: { function: { name: 'gofmt_run', description: 'Run gofmt on Go files' } } }
  const lsp = { name: 'lsp_diagnostics', isolated: false, description: 'LSP diagnostics' }
  const mcp = { name: 'github_search', description: 'search github', source: 'mcp:github' }
  eq('typo drops isolated plugins', selectPlugins('fix a typo', [jira, fmt, lsp], { klass: TASK_CLASS.MICRO }).filter((p) => p.isolated).length, 0)
  ok('typo keeps LSP', selectPlugins('fix a typo', [jira, lsp], { klass: TASK_CLASS.MICRO }).some((p) => p.name === 'lsp_diagnostics'))
  ok('typo keeps MCP (not isolated)', selectPlugins('fix a typo', [mcp], { klass: TASK_CLASS.MICRO }).some((p) => p.name === 'github_search'))
  ok('named plugin on MICRO', selectPlugins('use jira_issue to fetch PROJ-1', [jira], { klass: TASK_CLASS.MICRO }).some((p) => p.name === 'jira_issue'))
  ok('go task picks gofmt', selectPlugins('run gofmt on the changed files', [jira, fmt], { klass: TASK_CLASS.MEDIUM }).some((p) => p.name === 'gofmt_run'))
  ok('go task drops jira', !selectPlugins('run gofmt on the changed files', [jira, fmt], { klass: TASK_CLASS.MEDIUM }).some((p) => p.name === 'jira_issue'))
}

console.log('== integrator role ==')
{
  eq('INTEGRATOR exists', ROLES.INTEGRATOR, 'integrator')
  ok('integrator is read-only', roleIsReadOnly('integrator'))
  ok('coder is NOT read-only', !roleIsReadOnly('coder'))
  ok('isIntegratorRole', isIntegratorRole('integrator'))
  ok('researcher is not integrator', !isIntegratorRole('researcher'))
}

console.log('== integrateResults ==')
{
  const empty = integrateResults({ reports: [] })
  eq('empty apply', empty.apply.length, 0)
  ok('empty is read-only', empty.readOnly === true)
  ok('empty text says empty', /empty/.test(empty.text))
  const one = integrateResults({
    reports: [{ role: 'researcher', files: ['api.ts'], action: 'add route /users', ok: true }],
  })
  eq('one file', one.apply.length, 1)
  eq('file name', one.apply[0].file, 'api.ts')
  const conflict = integrateResults({
    reports: [
      { role: 'researcher', files: ['api.ts'], action: 'add GET', ok: true },
      { role: 'reviewer', files: ['api.ts'], action: 'add POST', ok: true },
    ],
  })
  ok('conflict recorded', conflict.conflicts.length >= 1)
  eq('one apply after conflict', conflict.apply.length, 1)
  eq('later wins', conflict.apply[0].action, 'add POST')
  const failed = integrateResults({ reports: [{ role: 'tester', ok: false, error: 'timed out' }] })
  ok('failed skipped', failed.skip.length >= 1 && failed.apply.length === 0)
  const escaped = integrateResults({ reports: [{ role: 'researcher', files: ['../etc/passwd'], action: 'nope', ok: true }] })
  eq('path escape dropped', escaped.apply.length, 0)
  const fromText = integrateResults({ reports: [{ role: 'researcher', text: 'look at src/app.js and lib/util.js', ok: true }] })
  ok('files from text', fromText.apply.some((a) => a.file === 'src/app.js'))
}

console.log('== ensureIntegrator ==')
{
  const small = synthesizePlan('add a log line', TASK_CLASS.SMALL)
  const small2 = ensureIntegrator(small)
  eq('SMALL unchanged length', small2.length, small.length)
  ok('SMALL has no integrator', !small2.some((n) => n.role === 'integrator'))
  const micro = synthesizePlan('fix typo', TASK_CLASS.MICRO)
  eq('MICRO still 1 node', ensureIntegrator(micro).length, 1)
  const wide = [
    { id: 'r1', objective: 'inspect api.ts', role: 'researcher', read_only: true, dependencies: [], verificationRequirements: ['acceptance'] },
    { id: 'r2', objective: 'inspect app.py', role: 'researcher', read_only: true, dependencies: [], verificationRequirements: ['acceptance'] },
    { id: 'patch', objective: 'implement the change', role: 'coder', read_only: false, dependencies: ['r1', 'r2'], verificationRequirements: ['syntax'] },
  ]
  const withI = ensureIntegrator(wide)
  ok('inserts integrator', withI.some((n) => n.role === 'integrator' && n.read_only === true))
  const integ = withI.find((n) => n.role === 'integrator')
  ok('integrator depends on both researchers', integ.dependencies.includes('r1') && integ.dependencies.includes('r2'))
  const patch = withI.find((n) => n.id === 'patch')
  ok('writer depends on integrator', patch.dependencies.includes(integ.id))
  const v = validatePlan(withI)
  ok('integrated plan validates', v.ok === true, v.errors && v.errors.join('; '))
  const again = ensureIntegrator(withI)
  eq('idempotent', again.filter((n) => n.role === 'integrator').length, 1)
}

console.log('== reportsFromGraph ==')
{
  const dag = {
    nodes: [
      { id: 'r1', role: 'researcher', read_only: true, status: 'completed', result: 'see api.ts', targetFiles: ['api.ts'] },
      { id: 'i', role: 'integrator', read_only: true, status: 'completed', result: 'merged' },
      { id: 'p', role: 'coder', read_only: false, status: 'pending' },
    ],
  }
  const reps = reportsFromGraph(dag)
  eq('skips integrator and writer', reps.length, 1)
  eq('keeps researcher', reps[0].role, 'researcher')
}

console.log('== stale lessons / evidence index ==')
{
  const writes = writesFromIndex({ files: { 'api.ts': { mtime: 2000, size: 10, symbols: [] } } })
  eq('writesFromIndex mtime', writes['api.ts'], 2000)
  ok('empty index is empty writes', Object.keys(writesFromIndex(null)).length === 0)
  const ev = fact('route exists', { files: ['api.ts'], asOf: 1000 })
  ok('index mtime stales fact', isStale(ev, writes) === true)
  ok('older mtime is not stale', isStale(ev, { 'api.ts': 500 }) === false)
  recordLesson({
    failure: 'tests failed on api',
    cause: 'missing route',
    failedStrategy: 'guess',
    successfulRepair: 'add the route',
    files: ['api.ts'],
  }, WORK)
  const idxDir = path.join(HOME, 'projects')
  // lessonIsStale needs loadIndex(cwd) — write a fake index under project hash
  const { projectDir } = await import('../memory.js')
  const pdir = projectDir(WORK)
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'index.json'), JSON.stringify({
    version: 1,
    files: { 'api.ts': { mtime: Date.now() + 60_000, size: 12, symbols: ['x'] } },
  }))
  const les = { files: ['api.ts'], lastUsed: Date.now() - 120_000, successful_repair: 'add the route', failure: 'x' }
  ok('lesson with newer index is stale', lessonIsStale(les, WORK) === true)
  ok('lesson without files is not stale', lessonIsStale({ files: [], lastUsed: 1 }, WORK) === false)
  const hits = relevantLessons('missing route', { cwd: WORK })
  ok('stale lesson dropped from relevantLessons', !hits.some((h) => (h.files || []).includes('api.ts')))
}

console.log('== frozen kernel + package ==')
{
  const cfg = defaultConfig()
  eq('assumeYes stays false', cfg.tools.assumeYes, false)
  eq('allowSudo stays false', cfg.tools.allowSudo, false)
  const { dropped } = sanitizeProjectConfig({ tools: { assumeYes: true } })
  ok('project cannot flip assumeYes', dropped.includes('tools.assumeYes'))
  eq('classifyTaskComplexity frozen', classifyTaskComplexity('fix a typo'), 'trivial')
  eq('typo still MICRO', classifyTask('fix a typo in README').class, TASK_CLASS.MICRO)
  eq('VERSION is 79.0.0', VERSION, '79.0.0')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  eq('package.json is 79.0.0', pkg.version, '79.0.0')
  ok('files includes evaluate.js', pkg.files.includes('evaluate.js'))
  ok('files includes integrate.js', pkg.files.includes('integrate.js'))
  eq('zero runtime deps', Object.keys(pkg.dependencies ?? {}).length, 0)
}

console.log(`\n== v34 suite: ${PASS} passed, ${FAIL} failed ==`)
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
try { fs.rmSync(WORK, { recursive: true, force: true }) } catch {}
process.exit(FAIL ? 1 : 0)
