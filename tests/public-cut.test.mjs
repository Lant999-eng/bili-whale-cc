// 公开版的样子（2026-10-28 开源第四步）：把项目抄到临时目录，删掉陌生人私信、QQ 两个模块的全部文件
//   （清单从 host/modules/sdm.mjs、qq.mjs 开头的注释读：tests/helpers/module-files.mjs，不在这里另抄一份），然后在临时家目录里看：
//   · 留下的文件没有一个静态 import 指向删掉的文件；核心的库都加载得起来；两个模块都算「没装」
//   · cli help、bili help、config show 里没有 qq / sdm / 陌生人 的字样
//   · 她的守则（ensureWorkDir 写的 CLAUDE.md）里没有 QQ、陌生人私信、sdm，也没有剩下的模块标记行
// 全程离线，不碰真的家目录、宿主、计划任务；在已经是公开版的代码里跑也一样（那时候没有要删的）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makePublicCopy, moduleFiles, PRIVATE_MODULES } from './helpers/module-files.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-pubcut-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })
const pub = path.join(tmp, 'repo'), home = path.join(tmp, 'home')
// 测试、文档用不到，不抄（快一点）
const gone = makePublicCopy(root, pub, { skip: ['tests', 'docs'] })
const dsh = path.join(home, 'data'), cfgFile = path.join(dsh, 'bili-whale.config.json')
fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, listen: { comment: false, dm: false, live: false } }))
const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile, BILI_WHALE_AI_HOME: path.join(dsh, 'whale-work') }
for (const k of ['NODE_OPTIONS', 'BILI_WHALE_AGENT', 'BILI_WHALE_TURN', 'BILI_WHALE_VIA']) delete env[k]

/** 输出里的临时路径先抹掉（随机的目录名里碰巧有 qq 之类也不算） */
const scrub = (s) => [tmp, tmp.replace(/\\/g, '/'), tmp.replace(/\\/g, '\\\\')].reduce((a, p) => a.split(p).join('<tmp>'), String(s))
const run = (file, args) => {
  const r = spawnSync(process.execPath, [path.join(pub, file), ...args], { env, cwd: pub, encoding: 'utf8', timeout: 60_000 })
  assert.ifError(r.error)
  return { status: r.status, out: scrub(r.stdout + r.stderr) }
}
/** 一段代码在公开版里跑（沙盒的环境）；@PUB@ = 公开版的根（file:// 形式，末尾带 /） */
function script(code) {
  const file = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, code.replaceAll('@PUB@', pathToFileURL(pub).href + '/'))
  const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, scrub(r.stderr + r.stdout))
  return r.stdout
}
const MODULE_TEXT = /qq|sdm|陌生人|dmStrangers|napcat/i
const lines = (s, re) => s.split('\n').filter((l) => re.test(l)).join('\n')

test('public cut: the file sets come from the manifest headers — every listed file exists, the two sets do not overlap, nothing core is in them', () => {
  for (const name of PRIVATE_MODULES) {
    const files = moduleFiles(root, name)
    if (!fs.existsSync(path.join(root, 'host/modules', name + '.mjs'))) { assert.deepEqual(files, []); continue }   // 已经是公开版
    assert.ok(files.includes(`host/modules/${name}.mjs`), name + ' 的报到单自己')
    for (const f of files) assert.ok(new RegExp(`(^|/)${name}[-.]|^tests/helpers/`).test(f), `${name}：${f} 不像这个模块的文件`)
  }
  assert.equal(new Set(gone).size, gone.length, '两个模块没有共用的文件')
  for (const f of gone) assert.ok(!fs.existsSync(path.join(pub, f)), f)
  for (const f of ['host/core.mjs', 'host/modules.mjs', 'host/modules/web.mjs', 'lib/scheduler.js', 'tools/bili.mjs', 'templates/CLAUDE.md']) assert.ok(fs.existsSync(path.join(pub, f)), '核心的还在：' + f)
})

test('public cut: no static import in the remaining code points at a deleted file; the core libraries load and both modules count as not installed', () => {
  const missing = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) { walk(f); continue }
      if (!/\.(mjs|js)$/.test(e.name)) continue
      const src = fs.readFileSync(f, 'utf8')
      // 静态的 import / export … from（动态 import 前面都先看文件在不在：模块没装 = 不加载，不算）
      for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) missing.push(`${path.relative(pub, f)} → ${m[1]}`)
      }
    }
  }
  for (const d of ['host', 'lib', 'tools']) walk(path.join(pub, d))
  assert.deepEqual(missing, [])
  // 宿主、调度、工具的库（入口 cli.mjs / daemon.mjs 是命令，下面真跑）
  const libs = [
    ...fs.readdirSync(path.join(pub, 'host')).filter((f) => f.endsWith('.mjs') && !['cli.mjs', 'daemon.mjs'].includes(f)).map((f) => 'host/' + f),
    ...fs.readdirSync(path.join(pub, 'lib')).filter((f) => /\.(m?js)$/.test(f)).map((f) => 'lib/' + f),
    ...fs.readdirSync(path.join(pub, 'tools/lib')).filter((f) => f.endsWith('.mjs')).map((f) => 'tools/lib/' + f),
  ]
  const out = JSON.parse(script(`
    const bad = []
    for (const f of ${JSON.stringify(libs)}) { try { await import('@PUB@' + f) } catch (e) { bad.push(f + '：' + (e?.code ?? e?.message)) } }
    const M = await import('@PUB@host/modules.mjs')
    process.stdout.write(JSON.stringify({ bad, installed: Object.fromEntries(M.MODULE_NAMES.map((n) => [n, M.moduleInstalled(n)])) }))
  `))
  assert.deepEqual(out.bad, [])
  assert.ok(libs.length > 40, String(libs.length))
  assert.deepEqual(out.installed, { sdm: false, qq: false, web: true })
})

test('public cut: cli help, bili help and config show have no qq / sdm / 陌生人 text', () => {
  const help = run('host/cli.mjs', ['help'])
  assert.match(help.out, /node host\/cli\.mjs config/, '真的是帮助')
  assert.equal(lines(help.out, MODULE_TEXT), '', 'cli help')
  const bili = run('tools/bili.mjs', ['help'])
  assert.equal(bili.status, 0, bili.out); assert.match(bili.out, /letter|diary/, '真的是工具清单')
  assert.equal(lines(bili.out, MODULE_TEXT), '', 'bili help')
  const cfg = run('host/cli.mjs', ['config', 'show'])
  assert.equal(cfg.status, 0, cfg.out); assert.match(cfg.out, /"owner"/, '真的是设置')
  assert.equal(lines(cfg.out, MODULE_TEXT), '', 'config show')
})

test('public cut: her rendered rules (CLAUDE.md written by ensureWorkDir) have no QQ / stranger-DM / sdm text and no module marker lines left', () => {
  const out = JSON.parse(script(`
    import fs from 'node:fs'
    import path from 'node:path'
    const { ensureWorkDir } = await import('@PUB@host/workdir.mjs')
    const { AGENT_CONFIG_DIR } = await import('@PUB@host/core.mjs')
    const dir = ensureWorkDir()
    process.stdout.write(JSON.stringify({ home: fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), agent: fs.readFileSync(path.join(AGENT_CONFIG_DIR, 'CLAUDE.md'), 'utf8') }))
  `))
  assert.equal(out.home, out.agent, '两份守则一样')
  const rules = scrub(out.home)
  assert.match(rules, /^## /m, '真的是守则')
  assert.equal(lines(rules, /qq|sdm|陌生人私信|napcat/i), '', '守则里还有模块的字')
  assert.equal(lines(rules, /<!--\s*\/?module:/), '', '守则里还有模块标记')
  assert.doesNotMatch(rules, /\{\{[A-Z_]+\}\}/, '占位符都填上了')
})

test('public cut: the manifest list may wrap over several lines but must end with 「（清单到此）」; paths outside the repo are refused before anything is deleted', () => {
  const fake = path.join(tmp, 'fake')
  const put = (f, s = '') => { fs.mkdirSync(path.dirname(path.join(fake, f)), { recursive: true }); fs.writeFileSync(path.join(fake, f), s) }
  for (const f of ['tools/lib/qq.mjs', 'tools/lib/qq-x.mjs', 'host/qq-a.mjs', 'tests/qq-one.test.mjs', 'tests/helpers/qq-h.mjs']) put(f)
  const manifest = (lines) => put('host/modules/qq.mjs', lines.map((l) => '// ' + l).join('\n') + '\nexport const x = 1\n')
  // 折行：「这张报到单」后面还有一行（以前在那里就停了，后面的 helper 会漏删）
  manifest(['报到单', '这一块的文件：tools/lib/qq.mjs、qq-x.mjs、', '  host/qq-a.mjs、这张报到单，和 tests/ 里 qq 开头的测试、', '  helpers/qq-h.mjs（清单到此）', '（后面这行不算：host/modules.mjs）'])
  assert.deepEqual(moduleFiles(fake, 'qq'), ['host/modules/qq.mjs', 'host/qq-a.mjs', 'tests/helpers/qq-h.mjs', 'tests/qq-one.test.mjs', 'tools/lib/qq-x.mjs', 'tools/lib/qq.mjs'])
  // 没写收尾 → 抛错
  manifest(['这一块的文件：tools/lib/qq.mjs、这张报到单，和', '  helpers/qq-h.mjs'])
  assert.throws(() => moduleFiles(fake, 'qq'), /清单到此/)
  // 往仓库外面指 → 抛错（文件就算在也不行）
  put('../outside-qq.mjs')
  for (const bad of ['../outside-qq.mjs', 'tools/../../outside-qq.mjs', 'C:/x/qq.mjs']) {
    manifest([`这一块的文件：${bad}、这张报到单（清单到此）`])
    assert.throws(() => moduleFiles(fake, 'qq'), /不是仓库里的相对路径|仓库里没有/, bad)
  }
  assert.ok(fs.existsSync(path.join(tmp, 'outside-qq.mjs')), '仓库外面的文件没被碰')
})
