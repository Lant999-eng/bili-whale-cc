// 「她的小窗」整条链的联调：真的 host/window.mjs（沙盒里起，合成会话记录）→ 真收到的 hello / ev / 快照 → 真的 window.js（假 DOM）画出来的样子；
// 再按桌宠（host/pet.ps1）的读法核一遍快照和立绘地址。各自的单测只拿自己手搓的数据测，这里专门抓两边对不上的地方：
//   字段名 / 事件名 / 路由；结束事件沿用开始那句时页面别念两遍；denied 要收掉「还在跑」的牌子；花费 / 用时三处一致；她的原话进不了 caption（桌宠没有「遮住私话」）。
// 全程不开窗口（BILI_WHALE_WINDOW_NO_EDGE=1）；沙盒在系统临时目录；会话记录全是合成的，CANARY 是不该出现在页面上的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const UI = path.join(root, 'host', 'window-ui')
// 时区钉在「这会儿是中午前后」的固定偏移：「今天」不会在半夜跑测试时跨到昨天（和 window.test.mjs 一样）
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }

const SID = '5ca1ab1e-aaaa-4bbb-8ccc-0123456789ab', NIGHT = 'bili-whale-1790000000000', DM0 = 'bili-whale-dm-1789990000000', FOX = 'BV1Fox000003'
// 嘴动按字数算（120 毫秒一个字，最多 6 秒）：两句都 50 字以上，顶满 6 秒 —— 下面「还在说」的断言只在离写进去不到 5.5 秒时才做
const MSG = '今晚看了狐狸跳舞，好可爱，明天想再看一遍它转圈圈的那一段，你也去看看嘛，看完告诉我你最喜欢哪一下，我先去睡啦', LAST = '今晚就到这里啦，狐狸跳舞那条我记进日记了，评论区也有人说它像在打太极，我笑了好久，晚安～明天见，你也早点睡'
const TALK_OK_MS = 5500, OOPS_OK_MS = 3500       // 服务端「刚刚」窗口（6 秒 / 出错 4 秒）减去余量
const EXPRS = ['neutral', '浅笑', '困', '想事情', '别扭', '低落', '小吃惊']
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const LEAK = /CANARY|canary@|deadbeef|SESSDATA|\.bili-whale|[A-Z]:\\/
const realTimeout = globalThis.setTimeout                  // 后半段假时钟接管 setTimeout：收尾（等进程退、删沙盒）还要真的
const sleep = (ms) => new Promise((r) => realTimeout(r, ms))
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)) }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
// 一律等「条件成立」、给足时间：全套测试并行跑的时候，服务端或者测试进程卡个三五秒是常事
async function until(fn, ms, why) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) assert.fail('等不到：' + why); await sleep(100) } }

let uid = 0
const u = () => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`
const T = {
  enq: (ts, content) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: SID, content }),
  prompt: (ts, turnIndex) => ({ type: 'user', uuid: u(), timestamp: ts, sessionId: SID, promptSource: 'sdk', turnPosition: { promptIndex: 0, turnIndex }, cwd: 'C:\\Users\\CANARYUSER\\x', message: { role: 'user', content: 'CANARY_PROMPT 主人私信的原文' } }),
  api: (ts) => ({ type: 'api-request', timestamp: ts, sessionId: SID, querySource: 'sdk' }),
  tool: (ts, id, name, input) => ({ type: 'assistant', uuid: u(), timestamp: ts, sessionId: SID,
    message: { id: 'msg_' + id, role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 20000 }, content: [{ type: 'tool_use', id, name, input }] } }),
  result: (ts, id, text, isError = false) => ({ type: 'user', uuid: u(), timestamp: ts, sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, toolUseResult: { stdout: 'CANARY_RAW ' + text, file: { content: 'CANARY_FILE' } } }),
  said: (ts, text) => ({ type: 'assistant', uuid: u(), timestamp: ts, sessionId: SID, message: { id: 'msg_s' + uid, role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 30 }, content: [{ type: 'text', text }] } }),
  cost: (usd, dur) => ({ type: 'cost-state', sessionId: SID, totalCostUSD: usd, totalDuration: dur, startTime: 1 }),
  noise: (ts) => [{ type: 'ai-title', sessionId: SID, aiTitle: 'CANARY_TITLE' }, { type: 'last-prompt', sessionId: SID, lastPrompt: 'CANARY_LAST' },
    { type: 'attachment', uuid: u(), timestamp: ts, sessionId: SID, attachment: { type: 'session_context', context: { userEmail: 'canary@example.com', organizationUuid: 'CANARY_ORG' } } }],
}
const jl = (...xs) => xs.flat().map((x) => JSON.stringify(x)).join('\n') + '\n'

/** 沙盒 + 起服务：宿主在线；今晚已经醒过；同一会话更早一个私信回合（累计 $0.30，日志里带私信原文）；这一回合（作息）刚开始在想 */
async function viewer(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-e2e-'))
  const dsh = path.join(home, 'data'), hostDir = path.join(dsh, 'whale-cc'), work = path.join(dsh, 'whale-work')
  const proj = path.join(hostDir, 'claude-config', 'projects', work.replace(/[^A-Za-z0-9]/g, '-'))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work, BILI_WHALE_WINDOW_NO_EDGE: '1' }
  delete env.NODE_OPTIONS; delete env.BILI_WHALE_WINDOW_PET_STUB
  const now = Date.now()
  // 醒的窗口包着「现在」（时区钉在中午前后）：回合做完以后是「在窗口里、今晚的事做完了」，不是白天
  w(env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, claude: { timeoutMin: 25, rotateDays: 7 }, night: { windows: [{ start: '11:00', end: '14:00', wakes: 1 }] } })
  w(path.join(hostDir, 'daemon.json'), { pid: process.pid, startedAt: iso(3600_000), heartbeat: iso(2000), scheduler: { ok: true, reason: 'ok' }, claude: 'claude', busy: true, running: null, queued: 0 })
  w(path.join(dsh, 'cast', 'demo', 'profile.json'), { name: '测试角色', outfit: '白裙' })
  for (const e of EXPRS) w(path.join(dsh, 'cast', 'demo', 'sprites', '白裙', e + '.png'), PNG)
  for (const e of ['neutral', '浅笑']) w(path.join(dsh, 'cast', 'demo', 'sprites', '白裙', '说话', e + '.png'), PNG)
  w(path.join(dsh, 'shots', 'covers', FOX + '.jpg'), 'jpg')
  w(path.join(dsh, 'whale-night.json'), { schema: 2, date: localDay(now), action: 'wake', atMs: now - 60_000, endsAt: now + 3600_000, fired: true, reason: 'SESSDATA=deadbeef 想看猫' })   // 服务端自己拼进快照的字也要过净化：凭据样子的整句不要
  w(path.join(hostDir, 'logs', localDay(now) + '.jsonl'), JSON.stringify({ at: iso(2 * 3600_000), id: DM0, ok: true, sessionId: SID, costUsd: 0.3, ms: 61_000, prompt: 'CANARY_LOGPROMPT', result: 'CANARY_LOGRESULT' }) + '\n')
  const tx = path.join(proj, SID + '.jsonl')
  w(tx, jl(T.enq(iso(2 * 3600_000 + 70_000), 'CANARY_QUEUE'), T.prompt(iso(2 * 3600_000 + 69_000), 1), T.said(iso(2 * 3600_000 + 60_000), 'CANARY_DMREPLY'), T.cost(0.3, 61_000), T.noise(iso(7200_000)),
    T.enq(iso(20_000), 'CANARY_QUEUE2'), T.prompt(iso(19_000), 2), T.api(iso(18_000))))
  w(path.join(hostDir, 'running.json'), { pid: process.pid, id: NIGHT, at: iso(20_000), sessionId: SID })
  const port = await freePort()
  const p = spawn(process.execPath, [path.join(root, 'host/window.mjs'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  t.after(async () => { try { p.kill() } catch {} await sleep(300); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const info = await until(() => { const j = readJson(path.join(hostDir, 'window.json')); return j?.pid === p.pid ? j : null }, 20_000, '小窗服务没起来：' + out)
  const req = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }))
    })
    r.on('error', reject); r.end()
  })
  return { hostDir, info, req, append: (...xs) => fs.appendFileSync(tx, jl(...xs)), out: () => out }
}

// ─────────────── 假浏览器（和 window-ui.test.mjs 同一套：按 index.html 建好带 id 的元素，假 EventSource / fetch / Image） ───────────────
class FakeEl {
  constructor(tag, id = '') { Object.assign(this, { tagName: String(tag).toUpperCase(), id, children: [], parentNode: null, _text: '', className: '', dataset: {}, style: {}, attrs: {}, listeners: {}, hidden: false, scrollTop: 0, scrollHeight: 0, clientHeight: 300 }) }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean), set = (a) => { this.className = a.join(' ') }
    return { add: (...c) => set([...new Set([...list(), ...c])]), remove: (...c) => set(list().filter((x) => !c.includes(x))), contains: (c) => list().includes(c),
      toggle: (c, force) => { const on = force === undefined ? !list().includes(c) : Boolean(force); set(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c)); return on } }
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v) }
  set innerHTML(_) { throw new Error('innerHTML used') }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { const x = new FakeEl('#text'); x._text = n; if (n) this.children.push(Object.assign(x, { parentNode: this })); continue } n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n) } }
  replaceChildren(...ns) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; this.append(...ns) }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c }
  remove() { this.parentNode?.removeChild(this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src' || k === 'href') delete this[k] }
  addEventListener(tp, f) { (this.listeners[tp] ??= []).push(f) }
}
const walk = (n) => [n, ...n.children.flatMap(walk)]
const byClass = (n, c) => walk(n).filter((x) => x.classList.contains(c))
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
async function fakePage(t, at) {
  const saved = {}
  for (const k of ['document', 'EventSource', 'fetch', 'localStorage', 'Image', 'matchMedia']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
  t.after(() => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k] } })
  const ids = new Map()
  for (const m of fs.readFileSync(path.join(UI, 'index.html'), 'utf8').matchAll(/<(\w+)\s([^>]*?\bid="([^"]+)"[^>]*)>/g)) { const e = new FakeEl(m[1], m[3]); e.hidden = /\shidden\b/.test(' ' + m[2]); ids.set(m[3], e) }
  const doc = { title: '', hidden: false, listeners: {}, getElementById: (id) => ids.get(id) ?? null, createElement: (tag) => new FakeEl(tag), addEventListener(tp, f) { (this.listeners[tp] ??= []).push(f) } }
  const sources = [], net = { body: null }
  class FakeES { constructor(url) { Object.assign(this, { url, readyState: 0, listeners: {} }); sources.push(this) } addEventListener(tp, f) { (this.listeners[tp] ??= []).push(f) } emit(tp, data) { this.readyState = 1; for (const f of this.listeners[tp] ?? []) f({ data: JSON.stringify(data) }) } close() {} }
  class FakeImage { set src(v) { this._src = v } get src() { return this._src } decode() { return Promise.resolve() } }
  const fetch = async () => ({ status: 200, ok: true, json: async () => net.body })
  for (const [k, v] of Object.entries({ document: doc, EventSource: FakeES, localStorage: { getItem: () => null, setItem() {} }, Image: FakeImage, fetch, matchMedia: undefined }))
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: at })
  await import(pathToFileURL(path.join(UI, 'window.js')).href + '?e2e')
  const tick = async (ms) => { for (let i = 0; i < ms; i += 50) { t.mock.timers.tick(50); await flush() } }
  // 假时钟上也等「条件成立」：字幕播放器按字数停留（她的话 50 多字要念满 6 秒），排着的几条念完要多久不固定
  const tickUntil = async (fn, ms, why) => { for (let i = 0; i <= ms; i += 50) { if (fn()) return; t.mock.timers.tick(50); await flush() } assert.fail('假时钟上等不到：' + why) }
  return { $: (id) => ids.get(id), doc, net, tick, tickUntil, es: () => sources.at(-1) }
}

test('小窗联调：真服务端 → 快照 / SSE 随回合变化、不漏金丝雀 → 真页面画出来对得上；桌宠读的字段和立绘地址也对得上', async (t) => {
  const V = await viewer(t)
  // 一次性口令换 cookie；桌宠只带令牌头（没有 cookie / Origin / Sec-Fetch-Site）
  const r0 = await V.req('/?k=' + V.info.code, { 'sec-fetch-site': 'none' })
  assert.equal(r0.status, 302)
  const cookie = /^whale_win=[^;]+/.exec(r0.headers['set-cookie'][0])[0]
  const raw = []
  const snaps = []
  const live = async (why) => { const r = await V.req('/api/live', { cookie }); assert.equal(r.status, 200); raw.push(r.body); const s = JSON.parse(r.body); snaps.push({ why, s, upTo: evs.at(-1)?.seq ?? 0 }); return s }
  const peek = async () => { const r = await V.req('/api/live', { cookie }); raw.push(r.body); return JSON.parse(r.body) }   // 只为等条件：不进 snaps（后面喂给假页面的是那几份）
  // SSE
  const evs = []
  let hello = null, sseRaw = ''
  const sreq = http.get({ host: '127.0.0.1', port: V.info.port, path: '/events', headers: { host: `127.0.0.1:${V.info.port}`, cookie } })
  sreq.on('error', () => {})                           // 收尾时服务先被关掉：连接被重置不算错
  t.after(() => sreq.destroy())
  sreq.on('response', (res) => {
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (d) => {
      sseRaw += d; buf += d
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const m = {}
        for (const l of buf.slice(0, i).split('\n')) { const x = /^(\w+): ?(.*)$/.exec(l); if (x) m[x[1]] = x[2] }
        buf = buf.slice(i + 2)
        if (m.event === 'hello') hello = JSON.parse(m.data); else if (m.event === 'ev') evs.push(JSON.parse(m.data))
      }
    })
  })
  const ev = (f, why) => until(() => evs.find(f), 20_000, why)
  await until(() => hello, 15_000, 'hello')

  // ── 开头：这一回合只有提示词 + api-request；更早的私信回合只留回合头（开始的时刻）+ 一行小结
  let s = await live('boot')
  assert.equal(s.turn?.id, NIGHT); assert.equal(s.turn.kindLabel, '按作息醒来')
  assert.deepEqual([s.state, s.expr, s.caption], ['thinking', '想事情', '在想…'])
  assert.deepEqual(s.feed.map((e) => `${e.kind}:${e.turn}`), [`turn_start:${DM0}`, `turn_end:${DM0}`, `turn_start:${NIGHT}`, `thinking:${NIGHT}`])
  assert.equal(s.lastTurn?.costUsd, 0.3)
  assert.equal(s.feed[0].t, s.lastTurn.at, '更早那组的标题时刻 = 「上一回合」卡片上的时刻 = 开始的时刻')
  assert.equal(Date.parse(s.lastTurn.endedAt) - Date.parse(s.lastTurn.at), 61_000)
  assert.deepEqual([s.plan?.action, s.plan?.text, s.plan?.reason], ['done', '今晚已经醒过了', null])

  // ── feed：在找 → 挑了几条（新 token = 输入 + 输出 + 写缓存，不算缓存重读的 20000）
  V.append(T.tool(iso(15_000), 'tu_feed', 'Bash', { command: 'node bili.mjs feed', description: 'Pick candidates' }))
  await ev((e) => e.kind === 'tool_start' && e.toolId === 'tu_feed', 'feed start')
  s = await live('feed')
  assert.deepEqual([s.state, s.expr, s.caption, s.turn.inflight.length, s.turn.steps, s.turn.tokens], ['searching', '浅笑', '在挑今天看什么', 1, 1, 1050])
  V.append(T.result(iso(12_000), 'tu_feed', '今天的候选：\n  1. BV1Cat000001  60s  弹幕 12  播放 3456  猫坐地铁  @某UP\n'), T.api(iso(11_000)))
  assert.equal((await ev((e) => e.kind === 'tool_end' && e.toolId === 'tu_feed', 'feed end')).cap, '挑了 1 条候选')

  // ── debrief：先是光秃秃的 BV，结果里的「标题:」到了以后换上；私密日记只有一句
  V.append(T.tool(iso(10_000), 'tu_deb', 'Bash', { command: `node bili.mjs debrief ${FOX}`, description: 'Watch' }))
  assert.equal((await ev((e) => e.kind === 'tool_start' && e.toolId === 'tu_deb', 'debrief start')).cap, `在看 ${FOX}`)
  s = await live('debrief')
  assert.deepEqual([s.state, s.expr, s.turn.inflight[0]?.bv], ['watching', '浅笑', FOX])
  V.append(T.result(iso(8_000), 'tu_deb', `标题: 狐狸跳舞\n有字幕：是\nSHEET C:\\Users\\CANARYUSER\\.bili-whale\\shots\\video\\${FOX}\\sheet.jpg\n评论：CANARY_COMMENT SESSDATA=deadbeef`),
    T.tool(iso(7_800), 'tu_priv', 'Read', { file_path: 'C:\\Users\\CANARYUSER\\.bili-whale\\whale-diary-private.md' }), T.result(iso(7_700), 'tu_priv', 'CANARY_DIARY'))
  assert.equal((await ev((e) => e.kind === 'tool_end' && e.toolId === 'tu_deb', 'debrief end')).cap, '看完了《狐狸跳舞》（字幕✓ 画面✓）')
  await ev((e) => e.kind === 'tool_end' && e.toolId === 'tu_priv', 'private read end')

  // ── 被拦下的命令（denied 代替 tool_end）+ 一条出错的：别扭
  // 「别扭」「嘴动」是服务端按「收到那一行多久了」算的（4 秒 / 6 秒）：服务端收到的时刻一定不早于这里写进去的时刻，
  // 所以从写进去算、还在窗口里时才断言那个状态；机器卡过头了就只断言窗口过了以后该有的样子（不让三五秒的卡顿翻转结果）
  const tA = Date.now()
  V.append(T.tool(iso(7_500), 'tu_curl', 'Bash', { command: 'curl https://example.com', description: 'Fetch a page' }),
    T.result(iso(7_400), 'tu_curl', 'PreToolUse:Bash hook error: [主人的白名单] 拒绝：只能跑 node bili.mjs', true),
    T.tool(iso(7_300), 'tu_err', 'Bash', { command: `node bili.mjs comments ${FOX}`, description: 'Comments' }), T.result(iso(7_200), 'tu_err', 'Exit code 1\n出错了 CANARY_ERR', true))
  const den = await ev((e) => e.kind === 'denied', 'denied')
  assert.equal(den.toolId, 'tu_curl')
  await ev((e) => e.kind === 'tool_end' && e.toolId === 'tu_err', 'error end')
  s = await live('error')
  if (Date.now() - tA < OOPS_OK_MS) assert.deepEqual([s.state, s.expr, s.talking, s.turn.inflight.length], ['error', '别扭', false, 0])
  else assert.deepEqual([['error', 'thinking'].includes(s.state), s.talking, s.turn.inflight.length], [true, false, 0], s.state)

  // ── 给主人发私信：嘴动，caption 是动作不是原话（桌宠没有「遮住私话」，只显示 caption）
  // 先等出错的「别扭」过去（它排在说话前面）：等服务端自己说过去了，不按固定秒数睡
  await until(async () => (await peek()).state !== 'error', 20_000, '「别扭」一直没过去')
  const tB = Date.now()
  V.append(T.api(iso(7_000)), T.tool(iso(6_000), 'tu_dm', 'Bash', { command: `node bili.mjs dm --msg "${MSG}" --go`, description: 'DM owner' }))
  const dm = await ev((e) => e.kind === 'tool_start' && e.toolId === 'tu_dm', 'dm start')
  assert.deepEqual([dm.cap, dm.text, dm.private, dm.activity], ['在给你发私信', MSG, true, 'send'])
  s = await live('dm')
  if (Date.now() - tB < TALK_OK_MS) assert.deepEqual([s.state, s.talking, s.caption], ['replying', true, '在给你发私信'])
  else assert.deepEqual([s.state, s.caption], ['replying', '在给你发私信'], '嘴不动了也还在发（发私信那件事还没结果）')
  V.append(T.result(iso(5_000), 'tu_dm', '✓ 私信已发送'))
  await ev((e) => e.kind === 'tool_end' && e.toolId === 'tu_dm', 'dm end')

  // ── 最后一句话 → 会话累计 → 宿主的结果日志 + running.json 删掉
  const tC = Date.now()
  V.append(T.said(iso(3_000), LAST))
  assert.equal((await ev((e) => e.kind === 'said', 'said')).private, true)
  s = await live('said')
  if (Date.now() - tC < TALK_OK_MS) assert.deepEqual([s.state, s.talking, s.caption], ['replying', true, '她在说话'])
  else assert.ok(['replying', 'thinking'].includes(s.state), s.state)
  V.append(T.cost(0.8, 200_000))
  const te = await ev((e) => e.kind === 'turn_end' && e.turn === NIGHT, 'turn_end')
  assert.deepEqual([te.ok, te.steps], [true, 7])
  s = await live('after turn_end')                    // 日志那行还没来：lastTurn 还是更早的私信回合
  assert.equal(s.lastTurn?.id, DM0)
  fs.appendFileSync(path.join(V.hostDir, 'logs', localDay(Date.now()) + '.jsonl'), JSON.stringify({ at: iso(0), id: NIGHT, ok: true, sessionId: SID, costUsd: 0.8, ms: 21_000, prompt: 'CANARY_LOGPROMPT2', result: 'CANARY_LOGRESULT2' }) + '\n')
  fs.rmSync(path.join(V.hostDir, 'running.json'))
  await until(async () => (await live('turn over')).lastTurn?.id === NIGHT, 20_000, 'lastTurn 换成这一回合')
  s = snaps.at(-1).s
  assert.equal(s.turn, null)
  assert.deepEqual([s.lastTurn.costUsd, s.lastTurn.durationMs, s.lastTurn.ok], [0.5, 21_000, true], '这一回合花的 = 会话累计 0.80 − 上一回合的 0.30')
  assert.equal(Date.parse(s.lastTurn.endedAt) - Date.parse(s.lastTurn.at), 21_000, 'at 是开始、endedAt 是结束')
  assert.equal(evs.filter((e) => e.kind === 'turn_end' && e.turn === NIGHT).length, 1)
  // 「这回合做完了」挂 3 秒以后：在窗口里、今晚已经醒过了 → 困，不画 zz（不是 asleep）；今天那一栏跟上
  await until(async () => { const x = await peek(); return x.state === 'night_done' && x.today.turns === 2 }, 20_000, '没落到「今晚的事做完了」')
  s = await live('settled')
  assert.deepEqual([s.state, s.expr, s.caption], ['night_done', '困', '在睡觉 · 今晚的事做完了'])
  assert.deepEqual([s.today.turns, s.today.costUsd], [2, 0.8])

  // ── 金丝雀：SSE 和每一份快照里都没有提示词 / 排队内容 / 原始输出 / 私密日记 / 附件 / 日志里的私信原文 / 路径 / 凭据
  raw.push(sseRaw)
  assert.doesNotMatch(raw.join('\n'), LEAK)
  // 桌宠读的字段：host.state/label、turn、expr（在 exprs 里）、talking（布尔）、caption（≤80、不含她的原话）
  const words = evs.filter((e) => typeof e.text === 'string').map((e) => e.text)
  assert.deepEqual(words, [MSG, LAST])
  for (const { why, s: x } of snaps) {
    assert.ok(['online', 'offline', 'paused'].includes(x.host.state) && typeof x.host.label === 'string', why)
    assert.ok(x.exprs.includes(x.expr) && typeof x.talking === 'boolean' && typeof x.caption === 'string' && [...x.caption].length <= 80, why)
    for (const t2 of words) assert.ok(!x.caption.includes(t2), `${why}: caption 不能带她的原话`)
  }
  const pet = { 'x-whale-pet': V.info.petToken }
  const petSnap = await V.req('/api/live', pet)
  assert.equal(petSnap.status, 200)
  // 桌宠拼立绘地址的方式（[Uri]::EscapeDataString 每一段）
  const sprite = (outfit, expr, open) => '/sprite/' + encodeURIComponent(outfit) + '/' + (open ? encodeURIComponent('说话') + '/' : '') + encodeURIComponent(expr) + '.png'
  for (const [e, open] of [['neutral', false], ['浅笑', true], ['困', false]]) assert.equal((await V.req(sprite(s.outfit, e, open), pet)).status, 200, e)
  for (const f of ['/window', '/window.js', '/player.mjs', '/window.css', '/cover/' + FOX]) assert.equal((await V.req(f, { cookie })).status, 200, f)

  // ─────────────── 同一批数据喂给真的 window.js ───────────────
  const P = await fakePage(t, Date.parse(hello.at))
  const { $, tick, tickUntil } = P
  const snapAt = (seq) => snaps.filter((x) => x.upTo <= seq).at(-1)?.s ?? snaps[0].s
  P.net.body = snapAt(0)
  P.es().emit('hello', hello)
  await tick(200)
  assert.equal($('chip').textContent, '醒着'); assert.equal($('kind').textContent, '按作息醒来'); assert.equal($('cap').textContent, '在想…')
  const rows = () => byClass($('feed'), 'row')
  const sawChips = []
  for (const e of evs) {
    if (e.turn === NIGHT && e.kind === 'turn_end') break
    P.net.body = snapAt(e.seq)
    P.es().emit('ev', e)
    await tick(400)
    sawChips.push(...$('chips').children.map((c) => c.textContent))
  }
  await tick(4000)
  sawChips.push(...$('chips').children.map((c) => c.textContent))
  await tickUntil(() => /她说/.test($('cap').textContent), 15_000, '最后那句话没念到')   // 前面排着的念完，轮到她最后那句
  assert.ok(!sawChips.some((c) => /在跑一条命令|在翻.*评论区/.test(c)), '被拦下 / 出错结束的工具不再挂「还在跑」：' + JSON.stringify([...new Set(sawChips)]))
  // 每一行：开始那句 + 结果；结果和开始那句一样时不念两遍
  const text = rows().map((r) => r.textContent)
  const has = (re) => assert.ok(text.some((x) => re.test(x)), `${re} 不在动态里：\n${text.join('\n')}`)
  has(/在挑今天看什么挑了 1 条候选$/)
  has(new RegExp(`在看 ${FOX}看完了《狐狸跳舞》`))
  has(/在翻只给自己看的日记好了$/)
  has(/在跑一条命令Fetch a page想跑一条不允许的命令，被拦下了$/)
  has(/的评论区出错了（退出码 1）$/)
  has(new RegExp(`在给你发私信“${MSG}”好了$`))
  has(new RegExp(`她说：「${LAST}」`))
  assert.ok(rows().filter((r) => /被拦下了|出错了/.test(r.textContent)).every((r) => r.classList.contains('err')))
  // 回合结束：转录先到（turn_end 没有花费），宿主日志后到 —— 中间这几秒不显示更早那一回合的「上一回合」卡片
  P.net.body = snaps.find((x) => x.why === 'after turn_end').s
  P.es().emit('ev', te)
  await tickUntil(() => $('chip').textContent === '睡着', 10_000, '念完最后那句以后回合没收尾')   // 那句念满 6 秒，接着是「这回合做完了」
  await tick(1000)
  assert.equal($('chip').textContent, '睡着')
  assert.equal($('meter').textContent, '这回合 · 花费待算')
  assert.equal($('last').hidden, true, '日志那行来之前，不拿更早的私信回合当「上一回合」')
  P.net.body = snaps.find((x) => x.why === 'settled').s
  await tick(11_000)
  // 顶栏 / 小结 / 「上一回合」：花费和用时都认宿主日志（$0.50、21 秒），三处一致
  assert.equal($('meter').textContent, '这回合 $0.50'); assert.equal($('timer').textContent, '用了 0:21')
  const sum = byClass($('feed'), 'sum').at(-1).textContent
  assert.match(sum, /^21 秒 · 7 步 · \$0\.50 · 看了 1 条$/)
  assert.equal($('last').hidden, false); assert.match($('last').textContent, /按作息醒来.*21 秒 · \$0\.50.*跑完了/)
  assert.match($('t-stats').textContent, /回合 2.*花了 \$0\.80/)
  assert.equal($('cap').textContent, '在睡觉 · 今晚的事做完了'); assert.equal($('plan').textContent, '今晚已经醒过了')
  assert.equal(decodeURIComponent($('sp-closed').src), '/sprite/白裙/困.png')
  assert.equal($('stage').classList.contains('asleep'), false, '今晚的事做完了：不画 zz')
  assert.doesNotMatch(walk(P.doc.getElementById('feed')).map((n) => n._text).join('\n') + $('cap').textContent, LEAK)
  t.mock.timers.reset()
})
