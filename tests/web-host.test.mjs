// 读书（2026-10-28，A 版）× 宿主：权限规则、读书回合怎么跑（新会话、只给 web / note、跑之前写绑定、跑完删、只记题目和次数、不推送）、
// 来源和编号对不上 / 关了 → 丢掉；调度器排读书回合、对账；醒来那一轮附笔记（排进队列才算附过）；主人的 cli web …；config set web.* —— 离线，每个测试一个临时目录
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { moduleInstalled } from '../host/modules.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const SDM = moduleInstalled('sdm')

function sandbox(t, { web = {}, cfg = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-webhost-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data'); fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfgFile = path.join(dsh, 'bili-whale.config.json')
  const notifyLog = path.join(home, 'notify.log')
  fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '111', name: 'Whale' }, persona: { name: '测试角色', ownerTitle: '主人', selfClaim: '我' },
    listen: { dm: false, comment: false, live: false }, notify: { type: 'file', path: notifyLog }, web: { enabled: true, allow: ['zh.wikipedia.org'], ...web }, ...cfg }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile,
    TEST_WEB_PAGES: path.join(home, 'pages.json'), TEST_WEB_LOG: path.join(home, 'fetch.jsonl'),
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/web-mock.mjs')).href }
  for (const k of ['BILI_WHALE_AGENT', 'BILI_WHALE_TURN', 'BILI_WHALE_VIA', 'BILI_NO_CACHE']) delete env[k]
  const s = { home, dsh, cfgFile, notifyLog, env }
  s.cli = (...args) => { const r = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), ...args], { env, encoding: 'utf8', timeout: 150_000 }); assert.ifError(r.error); return r }
  return s
}
function script(s, code) {
  const file = path.join(s.home, 't' + Math.random().toString(36).slice(2) + '.mjs')
  fs.writeFileSync(file, (PRELUDE + code).replaceAll('@ROOT@', root.replace(/\\/g, '/')))
  const r = spawnSync(process.execPath, [file], { env: s.env, encoding: 'utf8', timeout: 180_000 })
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''))
  return r.stdout
}
const PRELUDE = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const RealDateP = Date
const waitReal = (ms) => { const end = RealDateP.now() + ms; return new Promise((r) => { const spin = () => (RealDateP.now() >= end ? r() : setImmediate(spin)); spin() }) }
const until = async (f, ms = 20000) => { const end = RealDateP.now() + ms; while (!f()) { if (RealDateP.now() > end) throw new Error('等太久了：' + f); await waitReal(10) } }
const BILI = path.join(process.env.USERPROFILE, '.bili-ai')
const WEB = path.join(BILI, 'web')
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const W = await import('file:///@ROOT@tools/lib/webstate.mjs')
const { readConfigStrict: toolCfg } = await import('file:///@ROOT@tools/lib/config.mjs')
const logLines = () => { const d = path.join(process.env.DSH_HOME, 'whale-cc', 'logs'); let out = []; try { for (const f of fs.readdirSync(d)) out.push(...fs.readFileSync(path.join(d, f), 'utf8').trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l))) } catch {} return out }
/** 一条批准了的请求（主人加的）→ { r, item }：item 就是调度器交给宿主的样子 */
const approved = (topic = '诗经', start = []) => {
  const r = W.addRequest({ topic, start, by: 'owner', cfg: toolCfg() })
  return { r, item: { requestId: W.turnIdOf(r.id), source: { platform: 'web', requestId: r.id }, content: [{ type: 'text', text: W.readerPrompt(r, toolCfg()) }] } }
}
`
const last = (out) => out.trim().split('\n').pop()

test('permission args: reader turns get Bash only with exactly web search/open/more/page + note write, everything else denied; main turns deny web / note and keep read-request; unknown kinds throw', (t) => {
  const s = sandbox(t)
  const out = script(s, `
    const { permissionArgs, WEB_SYSTEM_APPEND, SYSTEM_APPEND } = await import('file:///@ROOT@host/claude.mjs')
    let threw = false; try { permissionArgs({ kind: 'reader' }) } catch { threw = true }
    console.log(JSON.stringify({ a: permissionArgs({ kind: 'web' }), m: permissionArgs(), threw, sys: SYSTEM_APPEND, webSys: WEB_SYSTEM_APPEND }))
  `)
  const { a, m, threw, sys, webSys } = JSON.parse(last(out))
  assert.equal(threw, true)
  const after = (x, f) => x[x.indexOf(f) + 1]
  assert.equal(after(a, '--tools'), 'Bash'); assert.ok(!a.includes('--add-dir'))
  const allow = a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools'))
  const deny = a.slice(a.indexOf('--disallowedTools') + 1)
  assert.deepEqual(allow.sort(), ['web search', 'web open', 'web more', 'web page', 'note write'].flatMap((c) => [`Bash(node bili.mjs ${c})`, `Bash(node bili.mjs ${c}:*)`]).sort())
  for (const d of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash(node bili.mjs)', 'Bash(node bili.mjs help)', 'Bash(node bili.mjs dm:*)', 'Bash(node bili.mjs notify:*)',
    'Bash(node bili.mjs read-request:*)', 'Bash(node bili.mjs diary:*)', ...(SDM ? ['Bash(node bili.mjs sdm:*)'] : []), 'Bash(node bili.mjs memory:*)', 'Bash(node bili.mjs letter:*)', 'Read(~/.bili-ai/**)']) assert.ok(deny.includes(d), d)
  // 公开版没装陌生人私信模块、没有 sdm 这条命令：拒绝的清单按 tools/bili.mjs 里真有的命令列，也就不提它
  if (!SDM) assert.ok(!deny.some((d) => /bili\.mjs sdm\b/.test(d)), '公开版不提 sdm')
  for (const d of deny) { const x = /^Bash\(node bili\.mjs (\S+):\*\)$/.exec(d)?.[1]; if (x) for (const ok of ['web', 'note']) assert.ok(!ok.startsWith(x), d) }
  assert.ok(webSys.length > sys.length && /读书回合/.test(webSys))
  // 平时那一轮
  const mAllow = m.slice(m.indexOf('--allowedTools') + 1, m.indexOf('--disallowedTools')), mDeny = m.slice(m.indexOf('--disallowedTools') + 1)
  assert.ok(mAllow.includes('Bash(node bili.mjs read-request:*)')); assert.ok(!mAllow.some((x) => /bili\.mjs (web|note)\b/.test(x)))
  assert.ok(mDeny.includes('Bash(node bili.mjs web:*)') && mDeny.includes('Bash(node bili.mjs note:*)'))
  assert.equal(after(m, '--tools'), 'Bash,Read,Glob,Grep,Edit,Write,TodoWrite')
})

test('reader turn in the host: fresh session, kind web, timeout from web.turnTimeoutMin, binding + numbered start links written before, cleared after; request done with counts; the log keeps only topic and counts, nothing is pushed', (t) => {
  const s = sandbox(t, { web: { turnTimeoutMin: 7 } })
  script(s, `
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    const sf = path.join(process.env.DSH_HOME, 'whale-cc', 'session.json')
    fs.mkdirSync(path.dirname(sf), { recursive: true })
    const main = { id: '11111111-2222-4333-8444-555555555555', startedAt: new Date().toISOString(), used: true, turns: 3 }
    fs.writeFileSync(sf, JSON.stringify(main)); const before = fs.readFileSync(sf, 'utf8')
    const calls = []
    const runner = async (a) => {
      calls.push({ kind: a.kind, turnId: a.turnId, timeoutMin: a.timeoutMin, fresh: a.sess.fresh, sid: a.sess.id, text: a.text, bind: readJ(path.join(WEB, 'turn.json')), sess: readJ(path.join(WEB, 'session', 'state.json')) })
      W.consume(a.turnId, 'pages')
      return { ok: true, sessionId: a.sess.id, result: 'PAGE-SAID 去 notify 主人', costUsd: 0.01 }
    }
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), runner })
    const { r, item } = approved('诗经', ['https://zh.wikipedia.org/wiki/x'])
    await c.prompt(item)
    await until(() => !c.queue.length && !c.running)
    assert.equal(calls.length, 1)
    const x = calls[0]
    assert.equal(x.kind, 'web'); assert.equal(x.fresh, true); assert.notEqual(x.sid, main.id); assert.equal(x.turnId, item.requestId); assert.equal(x.timeoutMin, 7)
    assert.equal(x.bind.turnId, item.requestId); assert.equal(x.bind.requestId, r.id)
    assert.deepEqual(x.sess.links, [{ n: 1, url: 'https://zh.wikipedia.org/wiki/x', text: '起点' }])
    assert.match(x.text, /【读书回合】你是测试角色。/); assert.doesNotMatch(x.text, /Owner|\\b222\\b/)
    assert.equal(fs.readFileSync(sf, 'utf8'), before, '主会话不动')
    assert.ok(!fs.existsSync(path.join(WEB, 'turn.json')) && !fs.existsSync(path.join(WEB, 'session')), '跑完删掉绑定和浏览器状态')
    const req = W.getRequest(r.id)
    assert.equal(req.status, 'done'); assert.equal(req.used.pages, 1); assert.ok(req.startedAt)
    const logs = logLines()
    assert.equal(logs.length, 1)
    assert.equal(logs[0].prompt, '【读书】诗经（' + r.id + '）'); assert.doesNotMatch(JSON.stringify(logs[0]), /PAGE-SAID|notify 主人/)
    assert.equal(logs[0].web.pages, 1)
    assert.ok(!fs.existsSync(path.join(process.env.USERPROFILE, 'notify.log')), '不推送')
  `)
})

test('reader turn is dropped (never run, never as a main turn) when web is off, the request was not approved, or a web source arrives under a non-reader id; a reader id without a source is dropped too', (t) => {
  const s = sandbox(t)
  script(s, `
    import {ClaudeSessionController} from 'file:///@ROOT@host/claude.mjs'
    const calls = []
    const runner = async (a) => { calls.push(a.turnId); return { ok: true, sessionId: a.sess.id, result: 'x' } }
    const c = new ClaudeSessionController({ cwd: path.join(process.env.DSH_HOME, 'w'), runner })
    // 来源是读书、编号是醒来那一轮的样子：不当成平时那一轮跑
    const a = approved('诗经')
    await c.prompt({ ...a.item, requestId: 'manual-' + RealDateP.now() })
    // 读书编号、没带来源
    const b = approved('楚辞')
    await c.prompt({ requestId: b.item.requestId, content: b.item.content })
    // 等批的（她写的、主人还没批）
    const p = W.addRequest({ topic: '宋词', by: 'her', cfg: toolCfg() })
    await c.prompt({ requestId: W.turnIdOf(p.id), source: { platform: 'web', requestId: p.id }, content: [{ type: 'text', text: 'x' }] })
    await until(() => !c.queue.length && !c.running)
    assert.deepEqual(calls, [])
    assert.equal(W.getRequest(p.id).status, 'pending', '没批的不动')
    assert.equal(W.getRequest(b.r.id).status, 'dropped')
    // 关了读书：批准了的也不跑
    const cfg = readJ(process.env.BILI_WHALE_CONFIG); cfg.web.enabled = false; fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
    const d = approved('唐诗')
    await c.prompt(d.item)
    await until(() => !c.queue.length && !c.running)
    assert.deepEqual(calls, []); assert.equal(W.getRequest(d.r.id).status, 'dropped')
    assert.ok(!logLines().some((l) => /manual-/.test(l.id ?? '') && l.ok), '没有当成平时那一轮记下来')
  `)
})

test('a real spawn of a reader turn (fake claude binary): Bash-only, reader system line, BILI_WHALE_TURN set, proxy / NODE_OPTIONS / TLS overrides stripped from its environment', (t) => {
  const s = sandbox(t)
  const fakeJs = path.join(s.home, 'fake-claude.mjs'), fakeLog = path.join(s.home, 'fake-claude.jsonl')
  fs.writeFileSync(fakeJs, `
    import fs from 'node:fs'
    const argv = process.argv.slice(2)
    let stdin = ''; for await (const c of process.stdin) stdin += c
    const e = process.env
    fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, turn: e.BILI_WHALE_TURN ?? null, proxy: [e.HTTPS_PROXY, e.https_proxy, e.HTTP_PROXY, e.ALL_PROXY].filter(Boolean),
      nodeOpts: e.NODE_OPTIONS ?? null, tls: e.NODE_TLS_REJECT_UNAUTHORIZED ?? null, ca: e.NODE_EXTRA_CA_CERTS ?? null, stdin }) + '\\n')
    const sid = argv[argv.indexOf('--session-id') + 1] ?? argv[argv.indexOf('--resume') + 1]
    console.log(JSON.stringify({ type: 'result', session_id: sid, result: 'ok', is_error: false, total_cost_usd: 0.01, num_turns: 1 }))
  `)
  let bin
  if (process.platform === 'win32') { bin = path.join(s.home, 'claude.cmd'); fs.writeFileSync(bin, `@"${process.execPath}" "${fakeJs}" %*\r\n`) }
  else { bin = path.join(s.home, 'claude'); fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`); fs.chmodSync(bin, 0o755) }
  const cfg = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...cfg, claude: { path: bin } }))
  s.env.HTTPS_PROXY = 'http://127.0.0.1:9'; s.env.ALL_PROXY = 'http://127.0.0.1:9'; s.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; s.env.NODE_EXTRA_CA_CERTS = path.join(s.home, 'ca.pem')
  script(s, `
    import {ClaudeSessionController, WEB_SYSTEM_APPEND} from 'file:///@ROOT@host/claude.mjs'
    import {ensureWorkDir} from 'file:///@ROOT@host/workdir.mjs'
    const c = new ClaudeSessionController({ cwd: ensureWorkDir() })
    const { item } = approved('诗经')
    await c.prompt(item)
    await until(() => !c.queue.length && !c.running, 90000)
    const runs = fs.readFileSync(${JSON.stringify(fakeLog)}, 'utf8').trim().split('\\n').map((l) => JSON.parse(l))
    assert.equal(runs.length, 1)
    const [x] = runs, after = (a, f) => a[a.indexOf(f) + 1]
    assert.equal(x.turn, item.requestId)
    assert.equal(after(x.argv, '--tools'), 'Bash'); assert.ok(x.argv.includes('--session-id') && !x.argv.includes('--resume'))
    assert.equal(after(x.argv, '--append-system-prompt'), WEB_SYSTEM_APPEND)
    assert.deepEqual(x.proxy, []); assert.equal(x.nodeOpts, null); assert.equal(x.tls, null); assert.equal(x.ca, null)
    assert.match(x.stdin, /【读书回合】/)
  `)
})

// ─────────────── 调度器 ───────────────
const SCHED = `
globalThis.setInterval = globalThis.setTimeout = () => ({})
globalThis.clearInterval = globalThis.clearTimeout = () => {}
const { startScheduler } = await import('file:///@ROOT@lib/scheduler.js')
const prompts = [], logs = []
const live = new Set()
const ctl = { create: async () => {}, prompt: async (p) => { prompts.push(p); live.add(p.requestId) }, isLive: (id) => live.has(id), get queue() { return [...live].map((id) => ({ id })) } }
const sched = startScheduler({ sessionController: ctl }, { dshHome: process.env.DSH_HOME, cwd: process.env.USERPROFILE, biliMjs: '@ROOT@tools/bili.mjs', log: (m) => logs.push(m) })
`
test('webTick: queues one approved request as a bili-whale-web turn (approved → queued before the enqueue), holds while it is live, reconciles a lost one to dropped, does nothing when off or when the controller cannot answer isLive', (t) => {
  const s = sandbox(t, { web: { roundsPerDay: 3 } })
  script(s, SCHED + `
    try {
      const a = approved('诗经', ['https://zh.wikipedia.org/wiki/x'])
      const b = approved('楚辞')
      await sched.webTick()
      assert.equal(prompts.length, 1)
      const p = prompts[0]
      assert.equal(p.requestId, a.item.requestId); assert.deepEqual(p.source, { platform: 'web', requestId: a.r.id })
      assert.match(p.content[0].text, /这次想读：「诗经」/); assert.match(p.content[0].text, /1\\. https:\\/\\/zh\\.wikipedia\\.org\\/wiki\\/x/)
      assert.equal(W.getRequest(a.r.id).status, 'queued')
      await sched.webTick(); assert.equal(prompts.length, 1, '排着一个就不再排')
      // 宿主那边丢了（重启、被拿掉）：对账成 dropped，接着排下一条
      live.clear()
      await sched.webTick()
      assert.equal(W.getRequest(a.r.id).status, 'dropped'); assert.ok(logs.some((l) => /1 条请求宿主这边已经没有那一轮了/.test(l)))
      assert.equal(prompts.length, 2); assert.equal(prompts[1].source.requestId, b.r.id)
      // 关了：只对账、不排
      live.clear(); W.markRequest(b.r.id, 'done', { from: ['queued'] })
      const c = approved('唐诗')
      const cfg = readJ(process.env.BILI_WHALE_CONFIG); cfg.web.enabled = false; fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
      await sched.webTick(); assert.equal(prompts.length, 2); assert.equal(W.getRequest(c.r.id).status, 'approved')
    } finally { sched.stop() }
    // 入队失败：退回 approved（下一轮再排）
    const cfg = readJ(process.env.BILI_WHALE_CONFIG); cfg.web.enabled = true; fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(cfg))
    const failing = { create: async () => {}, prompt: async () => { throw new Error('锁等不到') }, isLive: () => false, get queue() { return [] } }
    const s2 = startScheduler({ sessionController: failing }, { dshHome: process.env.DSH_HOME, cwd: process.env.USERPROFILE, biliMjs: 'unused', log: () => {} })
    const id = W.nextRunnable(toolCfg()).id
    await s2.webTick(); s2.stop()
    assert.equal(W.getRequest(id).status, 'approved')
    // 不认识 isLive 的会话控制器（别的宿主）：什么都不做
    const old = { create: async () => {}, prompt: async () => { throw new Error('不该调') } }
    const s3 = startScheduler({ sessionController: old }, { dshHome: process.env.DSH_HOME, cwd: process.env.USERPROFILE, biliMjs: 'unused', log: () => {} })
    await s3.webTick(); s3.stop()
    // 读完了、有笔记等主人看（web.reviewNotes 默认开）：推一次固定的话（笔记的字不进推送），下一轮不再推
    const idle = { create: async () => {}, prompt: async () => {}, isLive: () => false, get queue() { return [] } }
    W.markRequest(id, 'rejected', { from: ['approved'] }) /* 没有能排的，免得这一轮去排读书 */
    W.appendNote({ turnId: 't', requestId: 'R-x', topic: '诗经', title: '', text: 'SECRET-NOTE-BODY 读到雎鸠是水鸟。', sources: [] })
    const s4 = startScheduler({ sessionController: idle }, { dshHome: process.env.DSH_HOME, cwd: process.env.USERPROFILE, biliMjs: '@ROOT@tools/bili.mjs', log: () => {} })
    await s4.webTick()
    const nlog = path.join(process.env.USERPROFILE, 'notify.log')
    await until(() => fs.existsSync(nlog) && /等你看一眼/.test(fs.readFileSync(nlog, 'utf8')))
    assert.doesNotMatch(fs.readFileSync(nlog, 'utf8'), /SECRET-NOTE-BODY/)
    assert.deepEqual(W.notesAwaitingReview({ fresh: true }), [])
    await s4.webTick(); s4.stop()
    await waitReal(300)
    assert.equal(fs.readFileSync(nlog, 'utf8').match(/等你看一眼/g).length, 1, '只提醒一次')
  `)
})

test('wake prompts: notes are attached (and the read-request step offered) only when web is on; the prompt text is unchanged when off; notes count as delivered only after the turn is queued; cli prompt preview delivers nothing', (t) => {
  const s = sandbox(t, { cfg: { night: { windows: [{ start: '22:00', end: '23:00', wakes: 1 }], skipChance: 0 } } })
  script(s, `
    const { wakePrompt, webNotesNow } = await import('file:///@ROOT@lib/scheduler.js')
    const st = { atText: '22:30' }
    const off = (() => { const c = readJ(process.env.BILI_WHALE_CONFIG); c.web.enabled = false; fs.writeFileSync(process.env.BILI_WHALE_CONFIG, JSON.stringify(c)) })
    W.appendNote({ turnId: 't', requestId: 'R-x', topic: '诗经', title: '关雎', text: 'NOTE-TEXT 第一首诗从水鸟起兴，节奏像民歌。', sources: ['zh.wikipedia.org'] })
    assert.deepEqual(webNotesNow().ids, [], '主人还没放行（web ok）：不附')
    W.approveNotes(W.readNotes().notes.map((x) => x.id))
    const on = webNotesNow()
    assert.equal(on.ids.length, 1)
    const t1 = wakePrompt(st, '', 0, 25, null, on)
    assert.match(t1, /【读书笔记】/); assert.match(t1, /NOTE-TEXT/); assert.match(t1, /\\n8\\.8\\) 想读点什么/); assert.equal(t1.split('\\n8.8)').length, 2, '编号不和别的步骤撞')
    off()
    assert.equal(webNotesNow(), null)
    const t0 = wakePrompt(st, '', 0, 25, null, null)
    assert.doesNotMatch(t0, /读书|read-request/)
    assert.equal(wakePrompt(st, '', 0, 25, null), t0, '关着时和以前一字不差（默认参数）')
  `)
  // cli prompt：只看不附；cli wake（宿主没在跑 → --queue-only 不跑）也不附
  const c = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8')); c.web.enabled = true; fs.writeFileSync(s.cfgFile, JSON.stringify(c))
  const r = s.cli('prompt')
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NOTE-TEXT/)
  assert.equal(s.cli('wake', '--queue-only').status, 3)
  const notes = fs.readFileSync(path.join(s.home, '.bili-ai', 'web', 'notes.jsonl'), 'utf8')
  assert.doesNotMatch(notes, /"delivered"/, '预览、没交出去的都不算附过')
  // 生物钟那一轮：排进去了才记附过
  script(s, `
    const RealDate = Date
    let now = new RealDate('2026-10-21T22:00:00').getTime()
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])) } static now() { return now } }
    globalThis.setInterval = globalThis.setTimeout = () => ({}); globalThis.clearInterval = globalThis.clearTimeout = () => {}
    const { startScheduler } = await import('file:///@ROOT@lib/scheduler.js')
    const { makePlan } = await import('file:///@ROOT@tools/lib/night-plan.mjs')
    const W2 = await import('file:///@ROOT@tools/lib/webstate.mjs')
    fs.rmSync(path.join(WEB, 'notes.jsonl'), { force: true })
    W2.appendNote({ turnId: 't', requestId: 'R-x', topic: '诗经', title: '', text: 'NOTE-TWO 读到一半，想再看看楚辞。', sources: [], now: now - 1000 })
    W2.approveNotes(W2.readNotes().notes.map((x) => x.id), now)
    const seen = []
    const ctl = { create: async () => {}, prompt: async (p) => { seen.push(p.content[0].text) } }
    const sched = startScheduler({ sessionController: ctl }, { dshHome: process.env.DSH_HOME, biliMjs: 'unused', cwd: process.env.USERPROFILE, isBusy: () => false })
    fs.writeFileSync(path.join(process.env.DSH_HOME, 'whale-night.json'), JSON.stringify(makePlan({ windows: [{ start: '22:00', end: '23:00', wakes: 1 }], skipChance: 0 }, {}, now, () => 0)))
    now = new RealDate('2026-10-21T22:59:00').getTime()
    await sched.tick(); sched.stop()
    assert.equal(seen.length, 1); assert.match(seen[0], /NOTE-TWO/)
    assert.deepEqual(W2.notesBlock({ now }).ids, [], '排进去以后记了附过')
  `)
})

// ─────────────── 主人的 cli ───────────────
test('cli web: status / list show the full topic and start; approve re-checks against the current config; reject; add (owner, approved); stop drops a running request and clears its binding; notes / hide; log', (t) => {
  const s = sandbox(t)
  const ids = JSON.parse(last(script(s, `
    const her = W.addRequest({ topic: '诗经 · 关雎', start: ['https://zh.wikipedia.org/wiki/x'], by: 'her', cfg: toolCfg() })
    W.appendNote({ turnId: 't', requestId: her.id, topic: '诗经', title: '关雎', text: 'NOTE-FULL-TEXT 第一首诗从水鸟起兴。', sources: ['zh.wikipedia.org'] })
    W.logVisit({ turnId: 't', requestId: her.id, url: 'https://zh.wikipedia.org/wiki/x', host: 'zh.wikipedia.org', ok: true, status: 200, title: '诗经' })
    console.log(JSON.stringify({ her: her.id, note: W.readNotes().notes[0].id }))
  `)))
  let r = s.cli('web')
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /读书：开着/); assert.match(r.stdout, /等你批/); assert.match(r.stdout, /题目：「诗经 · 关雎」/); assert.match(r.stdout, /起点：https:\/\/zh\.wikipedia\.org\/wiki\/x/)
  r = s.cli('web', 'list'); assert.match(r.stdout, new RegExp(ids.her))
  // 主人后来把这个网站从名单里拿掉了：批不了
  const c = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8')); c.web.allow = ['ctext.org']; fs.writeFileSync(s.cfgFile, JSON.stringify(c))
  r = s.cli('web', 'approve', ids.her); assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /起点现在过不了/)
  c.web.allow = ['zh.wikipedia.org']; fs.writeFileSync(s.cfgFile, JSON.stringify(c))
  r = s.cli('web', 'approve', ids.her); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /批了/)
  assert.equal(s.cli('web', 'approve', ids.her).status, 2, '批过了')
  assert.equal(s.cli('web', 'approve', 'nope').status, 2)
  r = s.cli('web', 'add', '--topic', '主人的书'); assert.equal(r.status, 2)
  r = s.cli('web', 'add', '--topic', '楚辞', '--start', 'https://zh.wikipedia.org/wiki/' + encodeURIComponent('楚辞')); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /加好了/)
  // 停下一条正在读的
  script(s, `
    const r = W.getRequest(${JSON.stringify(ids.her)})
    W.markRequest(r.id, 'started', { from: ['approved'] })
    W.writeBinding({ turnId: W.turnIdOf(r.id), requestId: r.id, timeoutMin: 12, cfg: toolCfg() })
  `)
  r = s.cli('web', 'stop', ids.her); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!fs.existsSync(path.join(s.home, '.bili-ai', 'web', 'turn.json')))
  assert.equal(s.cli('web', 'stop', ids.her).status, 1, '已经停了')
  r = s.cli('web'); assert.match(r.stdout, /其中 1 条等你看/)
  r = s.cli('web', 'notes'); assert.match(r.stdout, /NOTE-FULL-TEXT/); assert.match(r.stdout, /等你看（web ok 放行）/)
  assert.equal(s.cli('web', 'ok', 'N-nothere-0000').status, 1)
  assert.equal(s.cli('web', 'ok', '../x').status, 2)
  r = s.cli('web', 'ok', ids.note); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /放行了 1 条/)
  r = s.cli('web', 'notes'); assert.match(r.stdout, /还没附给她/)
  // web ok all：只放行在 web notes 里看过的（看完之后才写好的那条不跟着放行）
  script(s, `W.appendNote({ turnId: 't', requestId: 'R-x', topic: '楚辞', title: '', text: 'NOTE-LATE 后来才写好的一条。', sources: [] })`)
  r = s.cli('web', 'ok', 'all'); assert.equal(r.status, 0); assert.match(r.stdout, /先 web notes 看一眼/)
  r = s.cli('web', 'notes'); assert.match(r.stdout, /NOTE-LATE/)
  r = s.cli('web', 'ok', 'all'); assert.match(r.stdout, /放行了 1 条/)
  r = s.cli('web', 'hide', ids.note); assert.equal(r.status, 0)
  r = s.cli('web', 'notes'); assert.match(r.stdout, /收起了/)
  r = s.cli('web', 'log'); assert.match(r.stdout, /zh\.wikipedia\.org\/wiki\/x/)
  assert.equal(s.cli('web', 'frobnicate').status, 2)
})

test('config set web.*: switches accept true / false words, numbers must be in range, sites must look like host names (a 、-separated list is accepted), engine is ddg / bing', (t) => {
  const s = sandbox(t)
  script(s, `
    import {setConfigPath, readConfig} from 'file:///@ROOT@host/core.mjs'
    const raw = () => readJ(process.env.BILI_WHALE_CONFIG)
    assert.equal(setConfigPath('web.enabled', 'off').ok, true); assert.equal(raw().web.enabled, false)
    assert.equal(setConfigPath('web.enabled', '"maybe"').ok, false)
    assert.equal(setConfigPath('web.approve', 'no').ok, true); assert.equal(raw().web.approve, false)
    for (const [k, v] of [['pagesPerRound', '-1'], ['pagesPerRound', '61'], ['roundsPerDay', '1.5'], ['turnTimeoutMin', '"十"'], ['searchesPerRound', '-1']]) assert.equal(setConfigPath('web.' + k, v).ok, false, k + '=' + v)
    assert.equal(setConfigPath('web.pagesPerRound', '0').ok, true); assert.equal(raw().web.pagesPerRound, 0)   // 0 = 页数不限（2026-10-28）
    assert.equal(setConfigPath('web.pagesPerRound', '20').ok, true); assert.equal(raw().web.pagesPerRound, 20)
    assert.equal(setConfigPath('web.allow', '"https://ctext.org/x"').ok, false)
    const r = setConfigPath('web.allow', '"ctext.org、ZH.wikipedia.org."'); assert.equal(r.ok, true, r.error); assert.deepEqual(raw().web.allow, ['ctext.org', 'zh.wikipedia.org'])
    assert.equal(setConfigPath('web.engine', 'google').ok, false); assert.equal(setConfigPath('web.engine', 'bing').ok, true)
    assert.equal(readConfig().web.notesPerRound, 3, '没写的按默认')
    assert.equal(readConfig().web.reviewNotes, true, '笔记默认要主人放行'); assert.equal(readConfig().web.allowTun, false)
    assert.equal(setConfigPath('web.reviewNotes', 'off').ok, true); assert.equal(raw().web.reviewNotes, false)
    assert.equal(setConfigPath('web.allowTun', '"sometimes"').ok, false)
    // block 还认 IP / 网段（挡自己家的公网 IP）；allow 不认
    const b = setConfigPath('web.block', '"evil.example、203.0.113.7、2001:db8::/32"'); assert.equal(b.ok, true, b.error); assert.deepEqual(raw().web.block, ['evil.example', '203.0.113.7', '2001:db8::/32'])
    assert.equal(setConfigPath('web.block', '"1.2.3.4/40"').ok, false)
    assert.equal(setConfigPath('web.allow', '"203.0.113.7"').ok, false)
  `)
})
