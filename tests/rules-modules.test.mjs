// 开源第 4 步（2026-10-28）：她的守则模板 templates/CLAUDE.md 里，QQ 和陌生人私信（sdm）的段落用模块标记圈起来，
// 宿主写守则时（host/workdir.mjs ensureWorkDir → renderModules）：装了的模块只去掉标记 —— 私有版和加标记之前一字不差；
// 没装的连同中间的字一起去掉 —— 公开版里没有 QQ / sdm / 陌生人私信的字，也没有指向那两节的话。
// 这里钉住：标记写法、全装 = 去掉标记、公开版去掉了什么 / 留下了什么、只装一个模块的两种、写坏的标记会报错、ensureWorkDir 真的这样写。
// 这一份测试在公开版里也跑（它不属于哪个模块）：那时 ensureWorkDir 写的就是公开版。全程离线：家目录都是临时的
// 公开版的模板已经按「两个模块都没装」预先渲染过（没有标记，仓库里看到的就是她读到的那份）：那时前三个用例只核对「怎么渲染都原样」
//   和公开版该有的样子；标记本身的逻辑（嵌套、行内、CRLF、写坏了报错）照样由第四个用例拿自己的样例文字测。装着模块时模板必须带标记
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const TPL = fs.readFileSync(path.join(root, 'templates/CLAUDE.md'), 'utf8')
const MARKED = /<!--\s*\/?\s*module/.test(TPL)
const href = (p) => JSON.stringify(pathToFileURL(path.join(root, p)).href)
/** 全装时该得到的：去掉标记（整行的连换行一起）。和宿主的 renderModules 各写一份 */
const stripMarkers = (s) => s.replace(/^<!-- \/?module:[a-z]+ -->\r?\n/gm, '').replace(/<!-- \/?module:[a-z]+ -->/g, '')
const lines = (s) => s.split(/\r?\n/)
const heads = (s) => lines(s).filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#+ /, ''))

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-rulesmod-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data'), work = path.join(dsh, 'whale-work')
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'Whale' }, notify: { type: 'none' } }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work }
  for (const k of ['NODE_OPTIONS', 'BILI_WHALE_TURN', 'BILI_WHALE_VIA', 'BILI_WHALE_AGENT']) delete env[k]
  return { home, dsh, work, env }
}
/** 在子进程（临时家目录）里跑一段用到宿主的代码，stdout 按 JSON 读回来 */
function run(t, body) {
  const s = sandbox(t)
  const code = `const { renderModules, ensureWorkDir } = await import(${href('host/workdir.mjs')})
const { moduleInstalled, MODULE_NAMES } = await import(${href('host/modules.mjs')})
const { AGENT_CONFIG_DIR } = await import(${href('host/core.mjs')})
const fs = await import('node:fs'); const path = await import('node:path')
const TPL = fs.readFileSync(${JSON.stringify(path.join(root, 'templates/CLAUDE.md'))}, 'utf8')
const tryRender = (text, set) => { try { return { ok: renderModules(text, (n) => set.includes(n)) } } catch (e) { return { error: String(e?.message ?? e) } } }
${body}`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  return { ...JSON.parse(r.stdout), s }
}
const ALL = ['sdm', 'qq', 'web'], NONE = ['web']
let cache = null
/** 四种组合各渲染一份（全装 / 只 QQ / 只陌生人私信 / 都不装） */
const renders = (t) => cache ??= run(t, `console.log(JSON.stringify({ names: MODULE_NAMES, installed: { qq: moduleInstalled('qq'), sdm: moduleInstalled('sdm') }, all: renderModules(TPL, () => true), qq: renderModules(TPL, (n) => n !== 'sdm'), sdm: renderModules(TPL, (n) => n !== 'qq'), none: renderModules(TPL, (n) => n === 'web') }))`)
/** 公开版：两个模块都没装，模板也已经预先渲染过（没有标记）。装着任何一个模块时都不算 —— 那时模板必须带标记 */
const preRendered = (r) => !MARKED && !r.installed.qq && !r.installed.sdm

test('the template marks only qq / sdm, every block marker sits alone on its line, inline markers stay on one line; rendering with everything installed is the template minus its markers (the private rules stay byte-identical)', (t) => {
  const r = renders(t), { names, all } = r
  const used = [...TPL.matchAll(/<!--\s*\/?\s*module\s*:\s*([^\s>]*)\s*-->/g)].map((m) => m[1])
  if (preRendered(r)) {
    // 公开版：预先渲染过的模板，装哪些模块渲染出来都原样（没有可去的标记）
    for (const k of ['all', 'qq', 'sdm', 'none']) assert.equal(r[k], TPL, '预先渲染过的模板原样交出去：' + k)
    assert.ok(lines(TPL)[0].startsWith('<!-- bili-whale-cc 生成的文件'), '开头那行说明（普通注释）还在')
    return
  }
  assert.ok(used.length > 0, '模板里有标记')
  for (const n of used) { assert.ok(names.includes(n), n); assert.ok(['qq', 'sdm'].includes(n), '守则里只圈 QQ 和陌生人私信：' + n) }
  for (const l of lines(TPL)) {
    const ms = [...l.matchAll(/<!-- (\/?)module:([a-z]+) -->/g)]
    if (!ms.length) continue
    if (ms.length === 1) { assert.equal(l, ms[0][0], '整行的标记单独占一行：' + l); continue }
    // 行内：一开一关成对、同名、开在前
    for (let i = 0; i < ms.length; i += 2) { assert.equal(ms[i][1], '', l); assert.equal(ms[i + 1]?.[1], '/', l); assert.equal(ms[i + 1][2], ms[i][2], l) }
  }
  assert.equal(all, stripMarkers(TPL), '全装 = 只去掉标记')
  assert.doesNotMatch(all, /<!--\s*\/?\s*module/)
  assert.ok(lines(all)[0].startsWith('<!-- bili-whale-cc 生成的文件'), '开头那行说明（普通注释）不受影响')
})

test('public render (no qq, no sdm): no QQ / sdm / 陌生人私信 text, the two sections and two tool rows are gone, nothing points at them, the rest reads unchanged', (t) => {
  const r = renders(t), { all, none } = r
  for (const [re, why] of [[/QQ|qq/, 'QQ'], [/sdm/, 'sdm'], [/陌生人私信/, '陌生人私信'], [/dmStrangers/, 'dmStrangers'], [/<!--\s*\/?\s*module/, '标记']]) {
    const hit = lines(none).filter((l) => re.test(l))
    assert.deepEqual(hit, [], '公开版里还有 ' + why)
  }
  // 少了的标题正好两个，别的标题、顺序都不变
  const gone = ['陌生人私信（别人先私信你）', 'QQ（主人在 QQ 上找你）']
  assert.deepEqual(heads(none), heads(all).filter((h) => !gone.includes(h)))
  // 指向某一节的话（见「X」、照「X」、CLAUDE.md「X」）都还对得上公开版的标题
  const hits = (part) => heads(none).some((h) => h === part || h.startsWith(part + '（'))
  for (const m of none.matchAll(/(?:见|照|CLAUDE\.md\s*)「([^」]+)」/g)) assert.ok(hits(m[1]), '公开版：' + m[0])
  // 工具表：去掉的两行前后还挨着，表没有断开
  const L = lines(none), push = L.findIndex((l) => l.startsWith('| 推送给主人 |'))
  assert.ok(push > 0 && L[push + 1].startsWith('| 发动态 |'), L[push + 1])
  const t0 = L.indexOf('| 要做的事 | 命令 |'), t1 = L.findIndex((l, i) => i > t0 && !l.startsWith('|'))
  assert.ok(L.slice(t0, t1).length >= 25, '工具表还是一整张')
  // 没有多出来的空行；两节之间照常隔一行
  assert.doesNotMatch(none, /(\r?\n){3}/)
  assert.ok(none.includes('别人私信你的事也一样不说') === false && none.includes('## 倾听（有人找你时）'))
  const at = (h) => L.indexOf(h)
  assert.ok(at('## 倾听（有人找你时）') < at('## 专属通道（主人私信你 —— 只认主人的 UID；【主人私信】只会由宿主给）') && at('## 专属通道（主人私信你 —— 只认主人的 UID；【主人私信】只会由宿主给）') < at('## 小窗（主人在电脑上的「她的小窗」里找你）'))
  // 行内去掉的四处读起来是通的
  for (const s of ['电脑路径（工具会尽量拦）；主人私下的原话（只写要点）', '别用 dm、notify 回他，他选了只在小窗里看。', '一个字都不进评论或私信。', '不群发私信、不主动私信陌生人、不刷量、不改账号设置。']) assert.ok(none.includes(s), s)
  // 红线还是 1–7
  const red = L.slice(L.indexOf('## 红线')).filter((l) => /^\d+\. /.test(l)).map((l) => l.split('.')[0])
  assert.deepEqual(red, ['1', '2', '3', '4', '5', '6', '7'])
  // 公开版只少不多：每一行要么原样在全装那份里，要么是全装那份里某一行删掉一段
  const A = new Set(lines(all))
  for (const l of L) assert.ok(A.has(l) || lines(all).some((x) => x.length > l.length && (() => { let s = 0; while (l[s] === x[s]) s += 1; return x.endsWith(l.slice(s)) })()), '多出来的一行：' + l)
  // 预先渲染过的公开版模板里本来就没有那两节（全装那份和它一样）：少了多少只在带标记的模板上量
  if (!preRendered(r)) assert.ok(Buffer.byteLength(none) < Buffer.byteLength(all) - 6000, '公开版少了两节')
})

test('one module alone: qq without sdm has no 陌生人私信 / sdm text; sdm without qq keeps only the generic QQ in the contact-details list', (t) => {
  const r = renders(t), { qq, sdm } = r
  // 公开版：模板里已经没有这两节（预先渲染过），只装一个模块也带不回来 —— 两种都和模板一样
  if (preRendered(r)) { assert.equal(qq, TPL); assert.equal(sdm, TPL); return }
  assert.ok(qq.includes('## QQ（主人在 QQ 上找你）') && qq.includes('| 回主人的 QQ |'))
  assert.doesNotMatch(qq, /陌生人私信|sdm/)
  assert.ok(qq.includes('但别写进评论、动态。开头的名字由工具自动加'), 'QQ 那一节里提陌生人私信的半句去掉了，句子还是通的')
  assert.ok(qq.includes('别用 dm、notify、qq 回他'))
  assert.ok(sdm.includes('## 陌生人私信（别人先私信你）') && sdm.includes('| 回陌生人私信 |'))
  assert.doesNotMatch(sdm, /qq|## QQ|回主人的 QQ/)
  assert.deepEqual(lines(sdm).filter((l) => /QQ/.test(l)).map((l) => l.match(/（手机号、QQ、微信、邮箱、群号）/)?.[0]), ['（手机号、QQ、微信、邮箱、群号）'])
  for (const s of ['主人的私信、日记、别的陌生人都不在里面', '他是谁、他的账号、他在私信里跟你说的、日记和记忆里关于他的']) assert.ok(sdm.includes(s), s)
  for (const x of [qq, sdm]) assert.doesNotMatch(x, /<!--\s*\/?\s*module|(\r?\n){3}/)
})

test('renderModules: nested blocks and inline markers, LF or CRLF, a block at the very end; broken markers throw instead of handing her half the rules', (t) => {
  const r = run(t, `
const cases = {
  nested: ['a\\r\\n<!-- module:qq -->\\r\\nq1 <!-- module:sdm -->s<!-- /module:sdm -->.\\r\\n<!-- module:sdm -->\\r\\nqs\\r\\n<!-- /module:sdm -->\\r\\n<!-- /module:qq -->\\r\\nb\\r\\n'],
  lf: ['x\\n<!-- module:sdm -->\\ny\\n<!-- /module:sdm -->\\nz <!-- module:qq -->w<!-- /module:qq -->!\\n'],
  eof: ['x\\n<!-- module:qq -->\\ny\\n<!-- /module:qq -->'],
  unclosed: ['a\\n<!-- module:qq -->\\nb\\n'],
  unknown: ['a <!-- module:foo -->b<!-- /module:foo --> c\\n'],
  trailing: ['<!-- module:qq -->\\nb\\n<!-- /module:qq --> 多了字\\n'],
  crossLine: ['a <!-- module:qq -->b\\nc<!-- /module:qq --> d\\n'],
  noSpace: ['a <!--module:qq-->b<!--/module:qq--> c\\n'],
  mismatch: ['a <!-- module:qq -->b<!-- /module:sdm --> c\\n'],
  // Codex 复查（10-28）：关的那行多一个空格，以前会一直吞到后面另一个 QQ 关标记，把中间的核心几节一起删掉
  closerSpace: ['<!-- module:qq -->\\nq\\n<!-- /module:qq --> \\ncore\\n<!-- module:qq -->\\nq2\\n<!-- /module:qq -->\\n'],
  spaceSyntax: ['a\\n<!-- module qq -->\\nq\\n<!-- /module qq -->\\nb\\n'],
  upper: ['a <!-- Module:qq -->b<!-- /Module:qq --> c\\n'],
  multiLine: ['a\\n<!--\\nmodule:qq -->\\nq\\n'],
  indented: ['a\\n  <!-- module:qq -->\\nq\\n<!-- /module:qq -->\\n'],
  crossed: ['<!-- module:qq -->\\n<!-- module:sdm -->\\nx\\n<!-- /module:qq -->\\n<!-- /module:sdm -->\\n'],
  strayCloser: ['a\\n<!-- /module:qq -->\\nb\\n'],
  inlineNested: ['a <!-- module:qq -->q<!-- module:sdm -->s<!-- /module:sdm -->!<!-- /module:qq --> z\\n'],
}
const out = {}
for (const [k, [text]] of Object.entries(cases)) out[k] = { all: tryRender(text, ['qq', 'sdm']), qq: tryRender(text, ['qq']), none: tryRender(text, []) }
console.log(JSON.stringify(out))`)
  assert.deepEqual(r.nested, { all: { ok: 'a\r\nq1 s.\r\nqs\r\nb\r\n' }, qq: { ok: 'a\r\nq1 .\r\nb\r\n' }, none: { ok: 'a\r\nb\r\n' } })
  assert.deepEqual(r.lf, { all: { ok: 'x\ny\nz w!\n' }, qq: { ok: 'x\nz w!\n' }, none: { ok: 'x\nz !\n' } })
  assert.deepEqual(r.eof, { all: { ok: 'x\ny\n' }, qq: { ok: 'x\ny\n' }, none: { ok: 'x\n' } })
  assert.deepEqual(r.inlineNested, { all: { ok: 'a qs! z\n' }, qq: { ok: 'a q! z\n' }, none: { ok: 'a  z\n' } })
  for (const k of ['unclosed', 'trailing', 'crossLine', 'noSpace', 'mismatch', 'closerSpace', 'spaceSyntax', 'upper', 'multiLine', 'indented', 'crossed', 'strayCloser']) for (const v of Object.values(r[k])) assert.match(v.error ?? '', /模块标记没配对/, k)
  for (const v of Object.values(r.unknown)) assert.match(v.error ?? '', /不认识的模块标记 module:foo/)
})

test('ensureWorkDir writes the rendered rules (for the modules this copy has) to both places, placeholders filled, no markers left', (t) => {
  const r = run(t, `const dir = ensureWorkDir()
console.log(JSON.stringify({ dir, a: fs.readFileSync(path.join(AGENT_CONFIG_DIR, 'CLAUDE.md'), 'utf8'), b: fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), want: renderModules(TPL), qq: moduleInstalled('qq'), sdm: moduleInstalled('sdm') }))`)
  assert.equal(r.dir, r.s.work)
  assert.equal(r.a, r.b, '两份一样')
  assert.equal(r.a, r.want.replaceAll('{{WORK_DIR}}', r.s.work).replaceAll('{{DSH_HOME}}', r.s.dsh))
  assert.doesNotMatch(r.a, /<!--\s*\/?\s*module|\{\{/)
  // 私有版（两个都装）：就是模板去掉标记 —— 和加标记之前写出来的一字不差
  if (r.qq && r.sdm) assert.equal(r.a, stripMarkers(TPL).replaceAll('{{WORK_DIR}}', r.s.work).replaceAll('{{DSH_HOME}}', r.s.dsh))
  if (!r.qq) { assert.doesNotMatch(r.a, /qq reply|## QQ/); assert.doesNotMatch(r.a, /、qq 回他/) }
  if (!r.sdm) assert.doesNotMatch(r.a, /陌生人私信|sdm/)
})
