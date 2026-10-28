// 「她的小窗」服务端（host/window.mjs）和 node host/cli.mjs window：
//   只认本机 + 一次性口令换 cookie（或桌宠令牌）；会话记录只读 projects/<她家目录名>/<uuid>.jsonl（硬链接 / 联接 / 乱写的 id 一律不开）；
//   原始行到不了页面（金丝雀）；SSE 快照 + 实时追加 + 断线续传 + 连接上限；立绘只认 listCast() 里的名字、封面只认 BV 号；
//   除了 window.json 什么都不写；桌宠是它的子进程（令牌只走环境变量，按退出码重启）；cli window 起服务、打印地址、--pet、--stop。
// 全程不开任何窗口：BILI_WHALE_WINDOW_NO_EDGE=1（不开 Edge、不起桌宠、不跑 PowerShell 窗口操作），沙盒都在系统临时目录里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const NODE = process.execPath
// 时区钉在「这会儿是中午前后」的固定偏移（没有夏令时）：下面的素材都是「N 分钟 / 小时前」，「今天」不会在半夜跑测试时跨到昨天
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)) }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-')        // Claude Code 给会话目录起名的规矩（和真的一样从沙盒的家目录推出来）
async function until(fn, ms = 10_000, why = () => '') {   // 等「条件成立」、给足时间：全套测试一起跑时一个进程卡三五秒是常事
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) assert.fail('等不到：' + why())
    await sleep(100)
  }
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const SID = '5ca1ab1e-1111-4222-8333-444455556666'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

// ─────────────── 合成的会话记录（只有假内容；CANARY 是不该出现在页面上的） ───────────────
let uid = 0
const u = () => `00000000-0000-4000-8000-${String(++uid).padStart(12, '0')}`
const T = {
  enq: (ts, content = 'CANARY_PROMPT 主人私信的原文') => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: SID, content }),
  prompt: (ts, turnIndex = 2) => ({ type: 'user', uuid: u(), timestamp: ts, sessionId: SID, promptSource: 'sdk', turnPosition: { promptIndex: 0, turnIndex }, cwd: 'C:\\Users\\CANARYUSER\\x', message: { role: 'user', content: 'CANARY_PROMPT 你好' } }),
  api: (ts) => ({ type: 'api-request', timestamp: ts, sessionId: SID, querySource: 'sdk' }),
  tool: (ts, id, command, description = 'run a tool') => ({ type: 'assistant', uuid: u(), timestamp: ts, sessionId: SID,
    message: { id: 'msg_' + id, role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }] } }),
  result: (ts, id, text) => ({ type: 'user', uuid: u(), timestamp: ts, sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] }, toolUseResult: { stdout: 'CANARY_RAW ' + text } }),
  said: (ts, text, stop = 'end_turn') => ({ type: 'assistant', uuid: u(), timestamp: ts, sessionId: SID, message: { id: 'msg_s' + uid, role: 'assistant', stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text }] } }),
  title: () => ({ type: 'ai-title', sessionId: SID, aiTitle: 'CANARY_TITLE 主人说的话' }),
  last: () => ({ type: 'last-prompt', sessionId: SID, lastPrompt: 'CANARY_LAST' }),
  attach: (ts) => ({ type: 'attachment', uuid: u(), timestamp: ts, sessionId: SID, attachment: { type: 'session_context', context: { userEmail: 'canary@example.com' } } }),
  cost: (usd) => ({ type: 'cost-state', sessionId: SID, totalCostUSD: usd, totalDuration: 100000, startTime: 1 }),
}
const jl = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n'
const FEED_OUT = '今天的候选：\n  1. BV1Cat000001  60s  弹幕 12  播放 3456  猫坐地铁  @某UP\n  2. BV1Dog000002  90s  弹幕 3  播放 99  小狗冲浪  @另一个UP\n'

/** 一个沙盒：宿主在线、她有角色和立绘、有封面、有一份不该被读的「凭据」（里面是能翻出字来的记录行） */
function sandbox(t, { daemon = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-win-'))
  const s = { home, procs: [], pids: [] }
  t.after(async () => {
    // 只结束这个测试自己起的进程（window.json 里的进程号可能已经被系统复用了，不按它杀）
    for (const p of s.procs) try { p.kill() } catch {}
    for (const pid of s.pids) try { if (alive(pid)) process.kill(pid) } catch {}
    await sleep(300)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const dsh = path.join(home, 'data'), hostDir = path.join(dsh, 'whale-cc'), work = path.join(dsh, 'whale-work'), ai = path.join(home, '.bili-ai')
  const cfgDir = path.join(hostDir, 'claude-config'), proj = path.join(cfgDir, 'projects', slug(work))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: NODE, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work, BILI_WHALE_WINDOW_NO_EDGE: '1' }
  delete env.NODE_OPTIONS; delete env.BILI_WHALE_WINDOW_PET_STUB
  w(env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, claude: { timeoutMin: 25, rotateDays: 7 } })
  if (daemon) w(path.join(hostDir, 'daemon.json'), { pid: process.pid, startedAt: iso(3600_000), heartbeat: iso(2000), scheduler: { ok: true, reason: 'ok' }, claude: 'claude', busy: false, running: null, queued: 0 })
  w(path.join(dsh, 'cast', 'demo', 'profile.json'), { name: '测试角色', outfit: '白裙' })
  for (const e of ['neutral', '浅笑', '困', '想事情']) w(path.join(dsh, 'cast', 'demo', 'sprites', '白裙', e + '.png'), PNG)
  for (const e of ['neutral', '浅笑']) w(path.join(dsh, 'cast', 'demo', 'sprites', '白裙', '说话', e + '.png'), PNG)
  w(path.join(dsh, 'cast', 'demo', 'sprites', '黑裙', 'neutral.png'), PNG)
  w(path.join(dsh, 'cast', 'demo', 'sprites', '说话', 'neutral.png'), PNG)          // 「说话」不是一套换装
  w(path.join(dsh, 'shots', 'covers', 'BV1Cat000001.jpg'), 'jpg-bytes')
  // 凭据旁边的文件：要是被读了，「她说」会把 CANARY 带到页面上
  w(path.join(cfgDir, '.credentials.json'), jl(T.enq(iso(9000)), T.said(iso(8000), 'CANARY_CRED 这是凭据文件里的字')))
  fs.mkdirSync(proj, { recursive: true })
  Object.assign(s, { dsh, hostDir, work, ai, cfgDir, proj, env, info: path.join(hostDir, 'window.json') })
  return s
}

/** 所有文件的指纹（看小窗服务除了 window.json 有没有写别的） */
function treeHash(dir) {
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') } }
  walk(dir)
  return out
}
async function startViewer(t, s, extraEnv = {}) {
  const port = await freePort()
  const p = spawn(NODE, [path.join(root, 'host/window.mjs'), '--port', String(port)], { env: { ...s.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  s.procs.push(p)
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  const info = await until(() => { const j = readJson(s.info); return j?.pid === p.pid ? j : null }, 20_000, () => '小窗服务没起来：' + out)
  return { p, port, info, out: () => out }
}
function req(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: body.toString('utf8'), raw: body }) })
    })
    r.on('error', reject)
    r.end()
  })
}
async function login(v, s) {
  const code = readJson(s.info).code
  const r = await req(v.port, '/?k=' + code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r.status, 302, r.body)
  return /^whale_win=[^;]+/.exec(r.headers['set-cookie'][0])[0]
}
/** 一个 SSE 客户端：把收到的块解析成 { event, id, data }，也留着原文（查金丝雀用） */
function sse(port, { cookie, lastId, headers = {} } = {}) {
  const c = { events: [], raw: '', status: null }
  let buf = ''
  const r = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...(lastId != null ? { 'last-event-id': String(lastId) } : {}), ...headers } })
  c.ready = new Promise((resolve) => {
    r.on('response', (res) => {
      c.status = res.statusCode
      resolve(res.statusCode)
      res.setEncoding('utf8')
      res.on('data', (d) => {
        c.raw += d; buf += d
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = {}
          for (const l of block.split('\n')) { const m = /^(\w+): ?(.*)$/.exec(l); if (m) ev[m[1]] = m[2] }
          if (ev.event) c.events.push({ event: ev.event, id: ev.id === undefined ? undefined : Number(ev.id), data: JSON.parse(ev.data) })
        }
      })
    })
    r.on('error', () => resolve(null))
  })
  c.close = () => r.destroy()
  c.evs = () => c.events.filter((e) => e.event === 'ev').map((e) => e.data)
  c.main = () => c.events.filter((e) => e.event !== 'hb')       // 心跳（每 10 秒一条）随时会插进来：看顺序时不算它
  return c
}
const SNAP_KEYS = ['v', 'at', 'host', 'turn', 'state', 'expr', 'talking', 'caption', 'outfit', 'exprs', 'talkingExprs', 'plan', 'queued', 'lastTurn', 'today', 'feed', 'viewer'].sort()
const EV_KEYS = new Set(['seq', 'kind', 'turn', 't', 'cap', 'sub', 'glyph', 'activity', 'bv', 'title', 'seen', 'ok', 'toolId', 'private', 'text', 'steps', 'tokens', 'costUsd', 'durationMs'])
const TODAY_KEYS = ['channelWaiting', 'costUsd', 'dmToOwner', 'pending', 'pendingDrafts', 'pendingVideos', 'sent', 'turns', 'uncertain', 'watched', 'watchedList']
const pad2 = (n) => String(n).padStart(2, '0')
const hm = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }   // 本地钟点（时区已经钉住）
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }

// ─────────────── 进程里直接测的那几块（会话记录路径、跟读、立绘名单、口令、Edge 参数） ───────────────
// 先把这个进程的家指到一个沙盒，再加载模块（模块加载时就定死了数据目录）
const IP = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-win-ip-'))
process.on('exit', () => { try { fs.rmSync(IP, { recursive: true, force: true }) } catch {} })
Object.assign(process.env, { USERPROFILE: IP, HOME: IP, DSH_HOME: path.join(IP, 'data'), BILI_WHALE_AI_HOME: path.join(IP, 'data', 'whale-work'), BILI_WHALE_CONFIG: path.join(IP, 'data', 'cfg.json') })
const W = await import('../host/window.mjs')
const tmpDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-win-t-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })); return d }

test('会话记录的目录名和 Claude Code 一样从她家目录推出来；超长的不猜', () => {
  assert.equal(W.slugOf('C:\\Users\\Alice\\.bili-whale\\whale-work'), 'C--Users-Alice--bili-whale-whale-work')
  assert.equal(W.transcriptDir(), path.join(IP, 'data', 'whale-cc', 'claude-config', 'projects', slug(path.join(IP, 'data', 'whale-work'))))
  assert.equal(W.slugOf('C:\\' + 'a'.repeat(300)), null)
  assert.equal(W.slugOf(''), null)
})

test('跟读：半行留到下次、1 MB 的行完整、超长行整行跳过、开头从最后一个 enqueue 读起、变短 / 被替换 / 换会话都重来', (t) => {
  const dir = tmpDir(t)
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', f = path.join(dir, id + '.jsonl')
  // 开头：两个回合，只从第二个 enqueue 读；一行字符串里转义过的 "operation":"enqueue" 不算
  const old = jl(T.enq('2026-10-24T10:00:00.000Z', 'first'), T.said('2026-10-24T10:00:01.000Z', 'OLD_TURN'))
  const fake = JSON.stringify({ type: 'user', message: { content: 'x "operation":"enqueue" y' }, note: '{"type":"queue-operation","operation":"enqueue"}' }) + '\n'
  w(f, old + jl(T.enq('2026-10-24T11:00:00.000Z', 'second'), T.api('2026-10-24T11:00:01.000Z')) + fake + '{"partial":')
  const tl = W.createTailer()
  let r = tl.poll(dir, id)
  assert.equal(r.reset, true); assert.equal(r.start.ts, '2026-10-24T11:00:00.000Z')
  assert.equal(r.lines.length, 3); assert.match(r.lines[0], /second/); assert.ok(!r.lines.join('').includes('OLD_TURN'))
  fs.appendFileSync(f, '1}\n')
  r = tl.poll(dir, id)
  assert.deepEqual(r.lines, ['{"partial":1}'], '半行拼回来了'); assert.equal(r.reset, false)
  const big = JSON.stringify({ type: 'user', pad: 'x'.repeat(1 << 20) })
  fs.appendFileSync(f, big + '\n')
  assert.equal(tl.poll(dir, id).lines[0].length, big.length, '1 MB 的行原样交出')
  // 小上限的读者：超长行（分两次写进来）整行扔掉，后面的照常
  const small = W.createTailer({ maxLine: 1000 })
  small.poll(dir, id)
  fs.appendFileSync(f, 'y'.repeat(800))
  assert.deepEqual(small.poll(dir, id).lines, [])
  fs.appendFileSync(f, 'y'.repeat(800) + '\n{"ok":1}\n')
  assert.deepEqual(small.poll(dir, id).lines, ['{"ok":1}'])
  tl.poll(dir, id)
  // 变短：从新内容的最后一个 enqueue 重来
  w(f, jl(T.enq('2026-10-24T12:00:00.000Z', 'third'), T.api('2026-10-24T12:00:01.000Z')))
  r = tl.poll(dir, id)
  assert.equal(r.reset, true); assert.equal(r.start.ts, '2026-10-24T12:00:00.000Z'); assert.equal(r.lines.length, 2)
  // 被替换（改名盖过来、比原来长）：ino 变了也重来
  const tmp = path.join(dir, 'x.tmp')
  w(tmp, jl(T.enq('2026-10-24T13:00:00.000Z', 'fourth'), T.api('2026-10-24T13:00:01.000Z'), T.api('2026-10-24T13:00:02.000Z'), T.api('2026-10-24T13:00:03.000Z')))
  fs.renameSync(tmp, f)
  r = tl.poll(dir, id)
  assert.equal(r.reset, true); assert.equal(r.start.ts, '2026-10-24T13:00:00.000Z'); assert.equal(r.lines.length, 4)
  // 换会话（running.json 里的 id 变了）：新文件从头（没有 enqueue 就从 0）
  const id2 = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff'
  w(path.join(dir, id2 + '.jsonl'), jl(T.api('2026-10-24T14:00:00.000Z')))
  r = tl.poll(dir, id2)
  assert.equal(r.reset, true); assert.equal(r.start, null); assert.equal(r.lines.length, 1)
  // enqueue 正好跨在两块的交界上也找得到
  const fd = fs.openSync(f, 'r')
  try { for (const chunk of [7, 13, 64]) assert.equal(W.lastEnqueue(fd, fs.fstatSync(fd).size, { chunk }).ts, '2026-10-24T13:00:00.000Z', `chunk ${chunk}`) } finally { fs.closeSync(fd) }
})

test('会话记录只认 <目录>/<小写 uuid>.jsonl 的普通文件：硬链接、联接、符号链接、目录本身是联接 —— 都不开', (t) => {
  const dir = tmpDir(t), outside = tmpDir(t)
  const id = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`
  const secret = path.join(outside, '.credentials.json')
  w(secret, jl(T.said(iso(), 'CANARY_SECRET')))
  w(path.join(dir, id(1) + '.jsonl'), jl(T.api(iso())))
  assert.ok(W.plainFileIn(dir, path.join(dir, id(1) + '.jsonl'), { single: true, flat: true }))
  fs.linkSync(secret, path.join(dir, id(2) + '.jsonl'))
  assert.equal(W.plainFileIn(dir, path.join(dir, id(2) + '.jsonl'), { single: true, flat: true }), null, '硬链接（看上去是普通文件）')
  fs.symlinkSync(outside, path.join(dir, id(3) + '.jsonl'), 'junction')
  assert.equal(W.plainFileIn(dir, path.join(dir, id(3) + '.jsonl'), { single: true, flat: true }), null, '联接')
  let symlinked = false
  try { fs.symlinkSync(secret, path.join(dir, id(4) + '.jsonl'), 'file'); symlinked = true } catch {}   // 没开发者模式时建不了，跳过
  if (symlinked) assert.equal(W.plainFileIn(dir, path.join(dir, id(4) + '.jsonl'), { single: true, flat: true }), null, '符号链接')
  const jdir = path.join(outside, 'jdir')
  fs.symlinkSync(dir, jdir, 'junction')
  assert.equal(W.plainFileIn(jdir, path.join(jdir, id(1) + '.jsonl')), null, '目录本身是联接')
  // 跟读也一样：一行都读不出来
  const tl = W.createTailer()
  for (const n of [2, 3, 4]) assert.deepEqual(tl.poll(dir, id(n)).lines, [], `id ${n}`)
  // 选会话：running.json → session.json → 最新的（只认合格的）
  assert.equal(W.pickSession(dir, ['../../.credentials', 'NOT-A-UUID', id(1).toUpperCase(), null, id(9)]), id(9), '第一个格式对的候选')
  w(path.join(dir, 'AAAAAAAA-BBBB-4CCC-8DDD-000000000099.jsonl'), jl(T.api(iso())))
  fs.utimesSync(path.join(dir, id(1) + '.jsonl'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.equal(W.pickSession(dir, [undefined, 'x']), id(1), '大写的、硬链接的、联接都不算最新')
})

test('间谍：不管 running.json / session.json 里写的什么，碰到的路径都在那一个目录里', (t) => {
  const dir = tmpDir(t)
  const good = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  w(path.join(dir, good + '.jsonl'), jl(T.enq(iso()), T.api(iso())))
  const seen = []
  const names = ['openSync', 'readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'existsSync', 'accessSync']
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]))
  const origNative = fs.realpathSync.native
  for (const n of names) fs[n] = function (p, ...rest) { if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) seen.push(String(p)); return orig[n].call(this, p, ...rest) }
  fs.realpathSync.native = function (p, ...rest) { seen.push(String(p)); return origNative.call(this, p, ...rest) }
  try {
    const attacks = ['../../.credentials', '..\\..\\.credentials', '..%2F..%2F.credentials', 'NOT-A-UUID', good.toUpperCase(), `${good}/../../x`, `${good}.jsonl`, '', null, 42, {}, ['x'], `../${good}`]
    const tl = W.createTailer()
    for (const a of attacks) { tl.poll(dir, a); W.pickSession(dir, [a]) }
    W.pickSession(dir, [])
    tl.poll(dir, good)
  } finally { for (const n of names) fs[n] = orig[n]; fs.realpathSync.native = origNative }
  assert.ok(seen.length > 0)
  const inDir = (p) => { const rel = path.relative(dir, path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)) }
  for (const p of seen) assert.ok(inDir(p), '碰了目录外面：' + p)
  assert.ok(!seen.some((p) => /credentials/i.test(p)))
})

test('立绘只认 listCast() 里真有的名字：说话当换装、..、%2F、反斜杠、不在名单里的表情 —— 都不行', () => {
  const cast = { id: 'demo', outfits: [{ name: '白裙', exprs: ['neutral', '浅笑'], talking: ['neutral'] }, { name: '黑裙', exprs: ['neutral'], talking: [] }] }
  const ok = W.spriteTarget(cast, ['白裙', '浅笑.png'])
  assert.ok(ok.file.endsWith(path.join('demo', 'sprites', '白裙', '浅笑.png'))); assert.ok(ok.file.startsWith(ok.root))
  assert.ok(W.spriteTarget(cast, ['白裙', '说话', 'neutral.png']).file.endsWith(path.join('白裙', '说话', 'neutral.png')))
  assert.ok(W.spriteTarget(cast, ['黑裙', 'neutral.png']))
  for (const segs of [['白裙', '说话', '浅笑.png'], ['说话', 'neutral.png'], ['..', 'neutral.png'], ['白裙', '..', 'neutral.png'], ['白裙', 'neutral'], ['白裙/..', 'neutral.png'],
    ['白裙\\..', 'neutral.png'], ['白裙', '../neutral.png'], ['白裙', 'neutral.png', 'x'], ['白裙'], [], ['黑裙', '说话', 'neutral.png'], ['白裙', 'NEUTRAL.png'], ['白裙', 'neutral.PNG']])
    assert.equal(W.spriteTarget(cast, segs), null, JSON.stringify(segs))
  assert.equal(W.spriteTarget(null, ['白裙', 'neutral.png']), null)
})

test('一次性口令：能用一次、60 秒过期、30 秒一换时上一个还认、格式不对直接不认', () => {
  let now = 1_000_000
  const changes = []
  const c = W.createCodes({ now: () => now, onChange: (x) => changes.push(x.code) })
  const a = c.current().code
  assert.match(a, /^[A-Za-z0-9_-]{24}$/)
  assert.equal(c.redeem(a), true); assert.equal(c.redeem(a), false, '用过一次就作废')
  assert.notEqual(c.current().code, a, '兑换后马上换新的'); assert.equal(changes.length, 2)
  const b = c.current().code
  now += 30_000; c.rotate()
  assert.equal(c.redeem(b), true, '上一个还没到 60 秒：还认')
  const d = c.current().code
  now += 60_001
  assert.equal(c.redeem(d), false, '过了 60 秒')
  for (const bad of ['', 'short', 'x'.repeat(65), '../../a', null, 42, d + '\n']) assert.equal(c.redeem(bad), false, String(bad))
  assert.equal(W.safeEq('abc', 'abc'), true); assert.equal(W.safeEq('abc', 'abcd'), false)
})

test('cli window 的参数、Edge 的启动参数、找 Edge、登录核对（只看有没有）', () => {
  const none = { stop: false, noOpen: false, top: false, pet: null, port: null, withPet: false, out: null, force: false }
  assert.deepEqual(W.parseWindowArgs([]), none)
  assert.deepEqual(W.parseWindowArgs(['--no-open', '--top', '--pet', 'on', '--port', '9000']), { ...none, noOpen: true, top: true, pet: 'on', port: 9000 })
  // 桌面按钮：开小窗 + 桌宠、说的话写进文件
  assert.deepEqual(W.parseWindowArgs(['--with-pet', '--out', 'C:\\x\\o.txt']), { ...none, withPet: true, out: 'C:\\x\\o.txt' })
  for (const bad of [['--pet'], ['--pet', 'yes'], ['--port', '80'], ['--port', 'x'], ['--bogus'], ['open'], ['--out'], ['--out', '--top'],
    ['--with-pet', '--pet', 'on'], ['--with-pet', '--stop'], ['--with-pet', '--no-open']]) assert.ok(W.parseWindowArgs(bad).error, bad.join(' '))
  const args = W.edgeArgs({ port: 8766, code: 'CODE123', profile: 'C:\\p\\window-edge', pos: { x: 1255, y: 12 } })
  assert.deepEqual(args, ['--app=http://127.0.0.1:8766/?k=CODE123', '--user-data-dir=C:\\p\\window-edge', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-features=msImplicitSignin', '--window-size=440,760', '--window-position=1255,12'])
  assert.ok(!W.edgeArgs({ port: 1, code: 'x' }).some((a) => a.startsWith('--window-position')))
  const exists = (f) => f === 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe'
  assert.equal(W.findEdge({ env: { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' }, reg: () => null, exists }), 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe')
  assert.equal(W.findEdge({ env: {}, reg: () => 'C:\\R\\msedge.exe', exists: () => true }), 'C:\\R\\msedge.exe', '注册表优先')
  assert.equal(W.findEdge({ env: {}, reg: () => 'C:\\R\\evil.exe', exists: () => true }), null, '不是 msedge.exe 不用')
  assert.equal(W.findEdge({ env: {}, reg: () => null, exists: () => true }), null)
  assert.equal(W.signedIn({ account_info: [] }), false); assert.equal(W.signedIn({}), false)
  assert.equal(W.signedIn({ account_info: [{ email: 'x' }] }), true); assert.equal(W.signedIn({ sync: { gaia_id: 'g' } }), true)
  assert.equal(W.signedIn({ google: { services: { last_gaia_id: 'g' } } }), true); assert.equal(W.signedIn(null), null)
})

test('PowerShell 片段（找工作区 / 置顶 / 关掉登录了的 Edge）：纯 ASCII、语法检查 0 错（只解析，不运行）', { skip: process.platform !== 'win32' }, () => {
  for (const [name, src] of Object.entries({ PS_WORKAREA: W.PS_WORKAREA, PS_EDGE_WINDOW: W.PS_EDGE_WINDOW, PS_EDGE_KILL: W.PS_EDGE_KILL })) {
    assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(src), name + ' 不是纯 ASCII')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:WHALE_PS_SRC, [ref]$null, [ref]$e); $e.Count'],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, WHALE_PS_SRC: src } })
    assert.equal(String(r.stdout).trim(), '0', name + '：' + r.stdout + r.stderr)
  }
  assert.match(W.PS_EDGE_WINDOW, /WHALE_EDGE_PROFILE/); assert.match(W.PS_EDGE_WINDOW, /StartsWith\(\$title\)/)
  assert.ok(!/Start-Process/i.test(W.PS_EDGE_WINDOW + W.PS_EDGE_KILL + W.PS_WORKAREA), '不开任何程序')
})

// ─────────────── 真起一个小窗服务（沙盒里、随机端口、不开窗口） ───────────────
test('服务：只认本机、除了 POST /api/act 都只能看、跨站不理；口令换 cookie 只能一次；/health 不带数据；/window 带 CSP；window.json 原子写、只有这些字段', async (t) => {
  const s = sandbox(t)
  const v = await startViewer(t, s)
  const P = v.port, info = readJson(s.info)
  assert.deepEqual(Object.keys(info).sort(), ['busy', 'code', 'codeExpiresAt', 'petToken', 'pid', 'port', 'startedAt'])
  assert.equal(info.port, P); assert.match(info.petToken, /^[A-Za-z0-9_-]{16,256}$/); assert.match(info.code, /^[A-Za-z0-9_-]{16,64}$/)
  const left = Date.parse(info.codeExpiresAt) - Date.now()
  assert.ok(left > 0 && left <= 60_000, '口令最多一分钟')
  assert.deepEqual(fs.readdirSync(s.hostDir).filter((f) => f.endsWith('.tmp')), [], '没留下临时文件')
  const pet = { 'x-whale-pet': info.petToken }
  // 本机、只读、跨站
  assert.equal((await req(P, '/api/live', { host: 'evil.example:' + P, headers: pet })).status, 421, '换了 Host（DNS 重绑定）')
  assert.equal((await req(P, '/api/live', { host: '127.0.0.1:1', headers: pet })).status, 421)
  assert.equal((await req(P, '/api/live', { host: `localhost:${P}`, headers: pet })).status, 200)
  const post = await req(P, '/api/live', { method: 'POST', headers: pet })
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD')
  assert.equal((await req(P, '/api/live', { method: 'PUT', headers: pet })).status, 405)
  for (const site of ['cross-site', 'same-site']) assert.equal((await req(P, '/api/live', { headers: { ...pet, 'sec-fetch-site': site } })).status, 403, site)
  // 没有口令
  for (const p of ['/api/live', '/events', '/window', '/window.js', '/sprite/%E7%99%BD%E8%A3%99/neutral.png', '/cover/BV1Cat000001', '/api/windows', '/'])
    assert.equal((await req(P, p)).status, 403, p)
  assert.equal((await req(P, '/api/live', { headers: { 'x-whale-pet': info.petToken + 'x' } })).status, 403, '令牌不对')
  assert.equal((await req(P, '/api/live', { headers: { cookie: 'whale_win=' + crypto.randomBytes(32).toString('base64url') } })).status, 403, '编的 cookie')
  const health = await req(P, '/health')
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ok: true, v: 1 }, '探活不带任何数据')
  // 口令：HEAD 不兑换；GET 换 cookie（HttpOnly + SameSite=Strict），只能一次，兑换后 window.json 里换了新口令
  assert.equal((await req(P, '/?k=' + info.code, { method: 'HEAD' })).status, 403)
  assert.equal((await req(P, '/?k=WRONGWRONGWRONGWRONG')).status, 403)
  const r = await req(P, '/?k=' + info.code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/window')
  assert.match(r.headers['set-cookie'][0], /^whale_win=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/)
  assert.equal((await req(P, '/?k=' + info.code)).status, 403, '第二次就不行了')
  await until(() => readJson(s.info)?.code !== info.code, 3000, () => '兑换后没换口令')
  const cookie = /^whale_win=[^;]+/.exec(r.headers['set-cookie'][0])[0]
  assert.equal((await req(P, '/', { headers: { cookie } })).status, 302, '已经登录的直接去 /window')
  const page = await req(P, '/window', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /^text\/html/)
  assert.equal(page.headers['content-security-policy'], "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  assert.equal(page.headers['x-content-type-options'], 'nosniff'); assert.equal(page.headers['access-control-allow-origin'], undefined, '不发 CORS 头')
  assert.match(page.body, /<script type="module" src="\/window\.js"><\/script>/)
  assert.match(page.body, /<title>bili-whale<\/title>/, '配置里没有 persona.name：标题就是 bili-whale')
  // 有名字：标题、立绘的 alt 换成它（转义；名字里的 $& 不当替换模式）。cli window --top 按同一个名字找窗口
  const named = W.withName(page.body, '测试角色')
  assert.match(named, /<title>测试角色<\/title>/); assert.match(named, /<img id="sp-closed" class="frame" alt="测试角色">/); assert.doesNotMatch(named, /bili-whale/)
  assert.match(W.withName(page.body, '<b>$&"'), /<title>&lt;b&gt;\$&amp;&quot;<\/title>/)
  for (const [p, type] of [['/window.js', /^text\/javascript/], ['/player.mjs', /^text\/javascript/], ['/window.css', /^text\/css/]]) {
    const x = await req(P, p, { headers: { cookie } })
    assert.equal(x.status, 200, p); assert.match(x.headers['content-type'], type, p)
  }
  for (const p of ['/nope', '/../window.json', '/window.json', '/host/window.mjs', '/window-ui/index.html', '//', '/events/../health'])
    assert.equal((await req(P, p, { headers: { cookie } })).status, 404, p)
  assert.equal(JSON.parse((await req(P, '/api/windows', { headers: pet })).body).windows, 0)
  // 桌宠令牌也能看快照
  assert.equal((await req(P, '/api/live', { headers: { ...pet, 'sec-fetch-site': 'same-origin' } })).status, 200)
})

test('服务：立绘只给名单里的（带缓存头、304）；穿越 / 说话当换装 / 联接的换装 → 404；封面只认 BV 号、普通文件', async (t) => {
  const s = sandbox(t)
  const sp = path.join(s.dsh, 'cast', 'demo', 'sprites')
  const outside = path.join(s.home, 'outside')
  w(path.join(outside, 'neutral.png'), 'SECRET_PNG')
  fs.symlinkSync(outside, path.join(sp, '链接'), 'junction')          // 联接的换装目录：listCast 不认
  // 换装目录是真的，里面的「说话」却是联接到别处：listCast 会把那边的文件列进 talking —— 只有「真实路径还在 sprites 里」这一条挡得住
  w(path.join(sp, '粉裙', 'neutral.png'), PNG)
  fs.symlinkSync(outside, path.join(sp, '粉裙', '说话'), 'junction')
  fs.linkSync(path.join(outside, 'neutral.png'), path.join(s.dsh, 'shots', 'covers', 'BV1Hard00001.jpg'))   // 指向别处的硬链接封面
  const v = await startViewer(t, s)
  const pet = { 'x-whale-pet': v.info.petToken }
  const get = (p, h = {}) => req(v.port, p, { headers: { ...pet, ...h } })
  const enc = (...segs) => '/sprite/' + segs.map(encodeURIComponent).join('/')
  const a = await get(enc('白裙', 'neutral.png'))
  assert.equal(a.status, 200); assert.equal(a.headers['content-type'], 'image/png'); assert.deepEqual(a.raw, PNG)
  assert.equal(a.headers['cache-control'], 'private, max-age=86400'); assert.ok(a.headers.etag)
  assert.equal((await get(enc('白裙', 'neutral.png'), { 'if-none-match': a.headers.etag })).status, 304)
  assert.equal((await get(enc('白裙', '说话', 'neutral.png'))).status, 200)
  assert.equal((await get(enc('黑裙', 'neutral.png'))).status, 200)
  assert.equal((await get(enc('粉裙', 'neutral.png'))).status, 200)
  for (const p of [enc('粉裙', '说话', 'neutral.png'), enc('白裙', '说话', '困.png'), enc('说话', 'neutral.png'), enc('链接', 'neutral.png'), enc('白裙', 'nope.png'), enc('白裙', 'neutral'),
    '/sprite/%E7%99%BD%E8%A3%99/../../profile.json', '/sprite/../cast/demo/profile.json', '/sprite/%2E%2E/neutral.png', '/sprite/%E7%99%BD%E8%A3%99%2F..%2F%E9%BB%91%E8%A3%99/neutral.png',
    '/sprite/%E7%99%BD%E8%A3%99%5Cneutral.png', '/sprite/%E7%99%BD%E8%A3%99/%2E%2E%2F%2E%2E%2Fprofile.json', '/sprite/%E0%A4%A/neutral.png', '/sprite/', '/sprite'])
    assert.equal((await get(p)).status, 404, p)
  const cv = await get('/cover/BV1Cat000001')
  assert.equal(cv.status, 200); assert.equal(cv.headers['content-type'], 'image/jpeg'); assert.equal(cv.body, 'jpg-bytes')
  for (const p of ['/cover/BV1Cat00000', '/cover/BV1Cat000001.jpg', '/cover/bv1Cat000001', '/cover/BV1Cat0000012', '/cover/BV1Cat000002', '/cover/..%2F..%2Fcast', '/cover/BV1Hard00001', '/cover/'])
    assert.equal((await get(p)).status, 404, p)
  // 快照里的立绘名单和真的一样
  const snap = JSON.parse((await get('/api/live')).body)
  assert.equal(snap.outfit, '白裙'); assert.deepEqual(snap.exprs, ['neutral', '想事情', '困', '浅笑'].sort()); assert.deepEqual(snap.talkingExprs, ['neutral', '浅笑'].sort())
})

test('服务：开机重建正在跑的这一回合 + 今天更早回合的小结；SSE 快照 → 实时追加 → 收尾（花费按会话累计相减）；断线续传；最多 4 个连接；页面上没有金丝雀；除了 window.json 什么都没写', async (t) => {
  const s = sandbox(t)
  const day = localDay(Date.now())
  const runId = 'manual-' + (Date.now() - 31_000)
  // 今天早些时候的一回合（私信，会话第一回合 $0.10，用了 20 秒）+ 正在跑的这一回合（从 enqueue 开始重建）
  const r1End = iso(2 * 3600_000), r1Start = new Date(Date.parse(r1End) - 20_000).toISOString()
  w(path.join(s.hostDir, 'logs', `${day}.jsonl`), JSON.stringify({ at: r1End, id: 'bili-whale-dm-r1', ok: true, sessionId: SID, costUsd: 0.1, turns: 4, ms: 20_000, prompt: 'CANARY_LOGPROMPT', result: 'CANARY_LOGRESULT' }) + '\n')
  w(path.join(s.proj, SID + '.jsonl'), jl(
    T.enq(iso(2 * 3600_000 + 20_000)), T.prompt(iso(2 * 3600_000 + 19_000), 1), T.attach(iso(2 * 3600_000 + 19_000)), T.api(iso(2 * 3600_000 + 18_000)),
    T.said(iso(2 * 3600_000 + 17_000), 'EARLIER_SAID 早先那回合说的'), T.last(), T.title(), T.cost(0.1),
    T.enq(iso(30_000)), T.prompt(iso(29_000)), T.attach(iso(29_000)), T.api(iso(28_000)),
    T.tool(iso(27_000), 'toolu_feed', 'node bili.mjs feed', 'Get feed CANARY_DESC'), T.result(iso(25_000), 'toolu_feed', FEED_OUT),
    T.api(iso(24_000)), T.tool(iso(23_000), 'toolu_deb', 'node bili.mjs debrief BV1Cat000001')))
  w(path.join(s.hostDir, 'running.json'), { pid: process.pid, id: runId, at: iso(31_000), sessionId: SID })
  w(path.join(s.hostDir, 'session.json'), { id: SID, startedAt: iso(86400_000), used: true, turns: 2 })
  w(path.join(s.hostDir, 'queue.json'), [{ id: runId, text: 'CANARY_QUEUE', at: iso(31_000) }, { id: 'bili-whale-dm-r2', text: 'CANARY_QUEUE_DM 主人又发了私信', at: iso(5000) }])
  w(path.join(s.dsh, 'whale-night.json'), { schema: 2, date: day, action: 'skip', fired: false, atMs: Date.now() + 3 * 3600_000, endsAt: Date.now() + 4 * 3600_000, atText: 'x', reason: '今晚只写日记' })
  const before = treeHash(s.home)
  const v = await startViewer(t, s)
  const P = v.port, pet = { 'x-whale-pet': v.info.petToken }
  const live = async () => JSON.parse((await req(P, '/api/live', { headers: pet })).body)
  let snap = await live()
  assert.deepEqual(Object.keys(snap).sort(), SNAP_KEYS)
  assert.equal(snap.v, 1); assert.equal(snap.host.state, 'online'); assert.equal(snap.host.label, '在线'); assert.ok(snap.host.heartbeatAgeSec >= 0)
  assert.equal(snap.turn.id, runId); assert.equal(snap.turn.kind, 'manual'); assert.equal(snap.turn.kindLabel, '你叫醒了她')
  assert.equal(snap.turn.steps, 2); assert.equal(snap.turn.tokens, 240, '每条回复的 usage 只算一次')
  assert.deepEqual(snap.turn.inflight.map((x) => [x.toolId, x.cap, x.bv, x.title, x.activity]), [['toolu_deb', '在看《猫坐地铁》', 'BV1Cat000001', '猫坐地铁', 'watch']], '标题是从 feed 的结果里认出来的')
  assert.equal(snap.state, 'watching'); assert.equal(snap.expr, '浅笑'); assert.equal(snap.talking, false); assert.equal(snap.caption, '在看《猫坐地铁》')
  assert.equal(snap.outfit, '白裙')
  assert.deepEqual(snap.queued, { dm: 1, win: 0, total: 1 }, '排着的不算正在跑的那个')
  assert.equal(snap.plan.action, 'skip'); assert.ok(snap.plan.atMs > Date.now()); assert.equal(snap.plan.reason, '今晚只写日记')
  // 三小时后（还是今天下午）：只说钟点；只写日记的那种不说「今晚」（计划可能是明晚的）
  assert.equal(snap.plan.when, hm(snap.plan.atMs)); assert.equal(snap.plan.text, `${hm(snap.plan.atMs)} 醒（只写日记）`)
  assert.equal(snap.lastTurn.id, 'bili-whale-dm-r1'); assert.equal(snap.lastTurn.costUsd, 0.1); assert.equal(snap.lastTurn.ok, true); assert.equal(snap.lastTurn.kindLabel, '你发来私信')
  assert.deepEqual([snap.lastTurn.at, snap.lastTurn.endedAt, snap.lastTurn.durationMs], [r1Start, r1End, 20_000], 'at 是开始的时刻（日志的结束时刻 − 用时），endedAt 是结束')
  assert.deepEqual(Object.keys(snap.today).sort(), TODAY_KEYS)
  assert.equal(snap.today.turns, 1); assert.equal(snap.today.costUsd, 0.1); assert.ok(snap.today.watchedList.some((x) => x.bv === 'BV1Cat000001'))
  assert.deepEqual(snap.viewer, { startedAt: v.info.startedAt, beatSec: 10 })
  const kinds = snap.feed.map((e) => [e.kind, e.turn])
  assert.deepEqual(kinds.slice(0, 3), [['turn_start', 'bili-whale-dm-r1'], ['turn_end', 'bili-whale-dm-r1'], ['turn_start', runId]], '先是今天更早那回合（回合头 + 小结），再是这回合的开头')
  assert.equal(snap.feed[0].t, r1Start, '更早那回合的回合头也是开始的时刻：页面按它起这一组的标题，和看着它跑时一样')
  assert.equal(snap.feed[1].t, r1End); assert.equal(snap.feed[1].costUsd, 0.1); assert.equal(snap.feed[1].durationMs, 20_000)
  assert.ok(snap.feed.some((e) => e.kind === 'tool_end' && e.cap === '挑了 2 条候选'))
  assert.ok(!JSON.stringify(snap).includes('EARLIER_SAID'), '只重建最近这一回合')
  for (const [i, e] of snap.feed.entries()) {
    assert.equal(e.seq, i + 1, '序号从 1 连着来')
    for (const k of Object.keys(e)) assert.ok(EV_KEYS.has(k), '多了字段 ' + k)
  }
  // SSE：先 hello（和快照一样的形状），再实时追加
  const cookie = await login(v, s)
  const c1 = sse(P, { cookie })
  assert.equal(await c1.ready, 200)
  const petEs = sse(P, { headers: pet })             // 桌宠的实时连接：推给它的事件也不带 private 的原话
  assert.equal(await petEs.ready, 200)
  await until(() => c1.events.some((e) => e.event === 'hello'))
  const hello = c1.events.find((e) => e.event === 'hello')
  assert.deepEqual(Object.keys(hello.data).sort(), [...SNAP_KEYS, 'chat'].sort(), '小窗页面的快照多一份聊天（桌宠的没有）'); assert.deepEqual(hello.data.chat, [])
  assert.equal(hello.id, snap.feed.length)
  // 新的一行推过来（平时一秒内；全套测试一起跑、机器卡的时候给足时间 —— 等的是「推到了」，不卡「几秒内」）
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(T.result(iso(), 'toolu_deb', '标题: 猫坐地铁\n有字幕：是\nSHEET 3x3\nCANARY_SUBS 字幕原文')))
  await until(() => c1.evs().some((e) => e.kind === 'tool_end' && e.toolId === 'toolu_deb'), 15_000, () => '新的一行没推过来')
  assert.equal(c1.evs().find((e) => e.toolId === 'toolu_deb' && e.kind === 'tool_end').cap, '看完了《猫坐地铁》（字幕✓ 画面✓）')
  // 回合收尾：她说最后一句 → cost-state → running.json 没了 → 结果日志那行（会话累计 0.25 − 上一回合 0.10 = 0.15）
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(T.api(iso()), T.said(iso(), 'DONE_SAID 今天看完了猫坐地铁'), T.last(), T.title(), T.cost(0.25)))
  await until(() => c1.evs().some((e) => e.kind === 'said'), 15_000)
  const saidEv = c1.evs().find((e) => e.kind === 'said')
  assert.equal(saidEv.text, 'DONE_SAID 今天看完了猫坐地铁'); assert.equal(saidEv.private, true, '一回合的最后一句是对主人说的：标 private，页面决定遮不遮')
  await until(() => petEs.evs().some((e) => e.kind === 'said'), 15_000, () => '桌宠没收到那一句')
  const petSaid = petEs.evs().find((e) => e.kind === 'said')
  assert.equal(petSaid.private, true); assert.equal('text' in petSaid, false); assert.equal(petSaid.seq, saidEv.seq)
  assert.ok(!petEs.raw.includes('DONE_SAID'), '桌宠的实时连接里没有她回主人的原话')
  // 断线重连（带 Last-Event-ID）补发的也一样：小窗页面那份带原话，桌宠那份不带
  const petRe = sse(P, { headers: pet, lastId: saidEv.seq - 1 }), winRe = sse(P, { cookie, lastId: saidEv.seq - 1 })
  await until(() => petRe.evs().some((e) => e.kind === 'said') && winRe.evs().some((e) => e.kind === 'said'), 10_000, () => '重连没补发')
  assert.ok(!petRe.raw.includes('DONE_SAID')); assert.equal(winRe.evs().find((e) => e.kind === 'said').text, 'DONE_SAID 今天看完了猫坐地铁')
  for (const x of [petEs, petRe, winRe]) x.close()     // 下面还要数「最多 4 个连接」：先关掉、等服务那边也收到
  await sleep(500)
  snap = await live()
  if (snap.talking) assert.equal(snap.caption, '她在说话')
  assert.ok(!snap.caption.includes('DONE_SAID'), '快照的 caption 不带她的原话（桌宠没有「遮住私话」）')
  assert.ok(!JSON.stringify(snap).includes('DONE_SAID'), '桌宠的快照里，标了 private 的那句连 feed 里都不带原话')
  assert.equal(snap.feed.find((e) => e.kind === 'said')?.private, true)
  fs.rmSync(path.join(s.hostDir, 'running.json'))
  fs.appendFileSync(path.join(s.hostDir, 'logs', `${day}.jsonl`), JSON.stringify({ at: iso(), id: runId, ok: true, sessionId: SID, costUsd: 0.25, turns: 5, ms: 31_000, prompt: 'x', result: 'CANARY_LOGRESULT2' }) + '\n')
  await until(async () => (await live()).lastTurn?.id === runId, 15_000, () => '结果日志那行没认出来')
  await until(async () => (await live()).today.turns === 2, 15_000, () => '今天那一栏没跟上')
  snap = await live()
  assert.equal(snap.turn, null); assert.equal(snap.lastTurn.costUsd, 0.15, '这一回合花的 = 累计相减'); assert.equal(snap.today.costUsd, 0.25)
  // 刚做完的 3 秒里是 done；之后还排着一个私信回合（queue.json 里那条）→ dm_queued（机器慢的时候这一下可能已经过了 3 秒）
  assert.ok(['done', 'dm_queued'].includes(snap.state), snap.state)
  const ends = c1.evs().filter((e) => e.kind === 'turn_end' && e.turn === runId)
  assert.equal(ends.length, 1, '一回合只收一次尾')
  // 下一回合：running.json 先出现（它的 enqueue 要晚几秒才落盘）—— 这时的步数 / token / 进行中的工具不能是上一回合的
  const run2 = 'bili-whale-dm-' + Date.now()
  w(path.join(s.hostDir, 'running.json'), { pid: process.pid, id: run2, at: iso(), sessionId: SID })
  await until(async () => (await live()).turn?.id === run2, 15_000)
  snap = await live()
  assert.equal(snap.turn.kindLabel, '你发来私信'); assert.equal(snap.turn.steps, 0); assert.equal(snap.turn.tokens, 0); assert.deepEqual(snap.turn.inflight, [])
  assert.equal(snap.state, 'starting')
  assert.ok(c1.evs().some((e) => e.kind === 'turn_start' && e.turn === run2), '回合开头不等记录、running.json 一出现就有')
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(T.enq(iso()), T.prompt(iso(), 3), T.api(iso()), T.tool(iso(), 'toolu_dm', 'node bili.mjs dm --status')))
  await until(async () => (await live()).turn?.steps === 1, 15_000, () => '新回合的步数没跟上')
  snap = await live()
  assert.equal(snap.turn.tokens, 120); assert.deepEqual(snap.turn.inflight.map((x) => x.cap), ['在看私信通道'])
  assert.equal(c1.evs().filter((e) => e.kind === 'turn_start' && e.turn === run2).length, 1, '记录里的 enqueue 到了也不重复开头')
  // 这一回合的最后几行和结果日志那行几乎同时落盘（同一轮读到）：先把记录读完再收尾 —— 「她说」不会跑到「这回合做完了」后面
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(T.result(iso(), 'toolu_dm', '私信通道：正常'), T.said(iso(), '收到你的私信啦'), T.cost(0.3)))
  fs.rmSync(path.join(s.hostDir, 'running.json'))
  fs.appendFileSync(path.join(s.hostDir, 'logs', `${day}.jsonl`), JSON.stringify({ at: iso(), id: run2, ok: true, sessionId: SID, costUsd: 0.3, turns: 2, ms: 5000, prompt: 'x', result: 'CANARY_LOGRESULT3' }) + '\n')
  await until(() => c1.evs().some((e) => e.kind === 'turn_end' && e.turn === run2), 15_000)
  await sleep(1600)
  const mine2 = c1.evs().filter((e) => e.turn === run2)
  assert.deepEqual(mine2.map((e) => e.kind), ['turn_start', 'thinking', 'tool_start', 'tool_end', 'said', 'turn_end'])
  assert.equal(mine2.at(-1).costUsd, 0.05, '记录里两次累计相减（0.30 − 0.25）'); assert.equal(mine2.find((e) => e.kind === 'said').private, true, '私信回合她说的话标 private')
  assert.equal((await live()).lastTurn.costUsd, 0.05)
  // 断线续传：带着 Last-Event-ID 连回来 —— 先补发漏掉的，再给快照；服务重启过（序号比现在大）就只给快照
  const c2 = sse(P, { cookie, lastId: 3 })
  await c2.ready
  await until(() => c2.events.some((e) => e.event === 'hello'))
  const max = c2.events.find((e) => e.event === 'hello').id
  assert.ok(max > 10)
  const replay = c2.events.filter((e) => e.event === 'ev').map((e) => e.data.seq)
  assert.deepEqual(replay, Array.from({ length: max - 3 }, (_, i) => i + 4), '漏掉的一条不少、按顺序')
  assert.equal(c2.main().at(-1).event, 'hello')
  const c3 = sse(P, { cookie, lastId: max + 1000 })
  await c3.ready
  await until(() => c3.events.some((e) => e.event === 'hello'))
  assert.deepEqual(c3.main().map((e) => e.event), ['hello'])
  // 最多 4 个连接：第 5 个 503
  const c4 = sse(P, { cookie })
  assert.equal(await c4.ready, 200)
  const c5 = sse(P, { cookie })
  assert.equal(await c5.ready, 503)
  assert.equal(JSON.parse((await req(P, '/api/windows', { headers: pet })).body).windows, 4)
  for (const c of [c1, c2, c3, c4, c5]) c.close()
  // 金丝雀：主人的私信、提示词、附件、工具原始输出、结果日志里的原文、凭据文件 —— 都没出现在任何输出里
  const all = [c1.raw, c2.raw, c3.raw, JSON.stringify(await live())].join('\n')
  assert.ok(!/canary/i.test(all), '金丝雀漏了：' + (/.{0,40}canary.{0,40}/i.exec(all)?.[0] ?? ''))
  assert.ok(!all.includes('"rx"'), '服务端收到的时刻只给 stateOf 用')
  // 除了 window.json，沙盒里什么都没变
  await sleep(200)
  const after = treeHash(s.home)
  delete after[path.relative(s.home, s.info)]
  for (const f of [path.join(s.hostDir, 'running.json'), path.join(s.hostDir, 'logs', `${day}.jsonl`), path.join(s.proj, SID + '.jsonl')]) { delete before[path.relative(s.home, f)]; delete after[path.relative(s.home, f)] }   // 这几个是测试自己改的
  assert.deepEqual(after, before, '小窗服务只写 window.json')
})

test('服务：会话 id 被写成路径 / 不是 uuid / 指向硬链接或联接 —— 一个字都不读；换成正经的 uuid 文件马上就读', async (t) => {
  const s = sandbox(t)
  const id = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`
  fs.linkSync(path.join(s.cfgDir, '.credentials.json'), path.join(s.proj, id(1) + '.jsonl'))          // 硬链接到凭据
  fs.symlinkSync(s.cfgDir, path.join(s.proj, id(2) + '.jsonl'), 'junction')                          // 联接到配置目录
  w(path.join(s.proj, id(3).toUpperCase() + '.jsonl'), jl(T.enq(iso()), T.said(iso(), 'CANARY_UPPER')))  // 大写 uuid
  w(path.join(s.hostDir, 'running.json'), { pid: process.pid, id: 'manual-1', at: iso(5000), sessionId: '../../.credentials' })
  w(path.join(s.hostDir, 'session.json'), { id: id(1) })
  const v = await startViewer(t, s)
  const pet = { 'x-whale-pet': v.info.petToken }
  const live = async () => (await req(v.port, '/api/live', { headers: pet })).body
  await sleep(1600)
  w(path.join(s.hostDir, 'session.json'), { id: id(2) })
  await sleep(1600)
  w(path.join(s.hostDir, 'session.json'), { id: 'NOT-A-UUID' })
  await sleep(1600)
  let body = await live()
  assert.ok(!/canary/i.test(body), '读了不该读的：' + (/.{0,40}canary.{0,40}/i.exec(body)?.[0] ?? ''))
  assert.deepEqual(JSON.parse(body).feed.map((e) => e.kind), ['turn_start'], '只有 running.json 给的回合开头')
  // 正经的文件：马上就读（说明上面没读到不是因为根本没在读）
  w(path.join(s.proj, id(5) + '.jsonl'), jl(T.enq(iso()), T.api(iso()), T.said(iso(), '正经文件里的话', 'tool_use')))
  w(path.join(s.hostDir, 'session.json'), { id: id(5) })
  await until(async () => JSON.parse(await live()).feed.some((e) => e.kind === 'said' && e.text === '正经文件里的话'), 15_000)
  body = await live()
  assert.ok(!/canary/i.test(body))
  assert.ok(alive(v.p.pid), '一路没崩')
})

test('服务：整份合成记录（两回合、各种金丝雀）跟着读进来 —— 页面和快照里一只金丝雀都没有', async (t) => {
  const s = sandbox(t)
  const fixture = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'transcript-synthetic.jsonl'), 'utf8')
  const fsid = /"sessionId":"([0-9a-f-]{36})"/.exec(fixture)[1]
  const f = path.join(s.proj, fsid + '.jsonl')
  w(f, '')
  w(path.join(s.hostDir, 'session.json'), { id: fsid })
  const v = await startViewer(t, s)
  const cookie = await login(v, s)
  const c = sse(v.port, { cookie })
  await c.ready
  await until(() => c.events.some((e) => e.event === 'hello'))
  // 分几次、还故意从一行中间切开写进去
  const cut = Math.floor(fixture.length / 3)
  fs.appendFileSync(f, fixture.slice(0, cut)); await sleep(900)
  fs.appendFileSync(f, fixture.slice(cut, 2 * cut)); await sleep(900)
  fs.appendFileSync(f, fixture.slice(2 * cut))
  await until(() => c.evs().length > 30, 15_000, () => `只收到 ${c.evs().length} 条`)
  // 整份都读完了：最后几行是主人 cli open 当面聊的（另起一组 chat-<毫秒>）
  await until(() => c.evs().some((e) => /^chat-\d+$/.test(e.turn ?? '') && e.kind === 'said'), 15_000, () => '当面聊那几行没读到')
  await sleep(1000)
  const kinds = new Set(c.evs().map((e) => e.kind))
  for (const k of ['thinking', 'tool_start', 'tool_end', 'said', 'retry']) assert.ok(kinds.has(k), k)
  const body = (await req(v.port, '/api/live', { headers: { cookie } })).body
  const all = c.raw + '\n' + body
  assert.ok(!/canary/i.test(all), '金丝雀漏了：' + (/.{0,40}canary.{0,40}/i.exec(all)?.[0] ?? ''))
  for (const x of ['主人说今晚想你了', 'example.com', 'whale-diary-private', 'C:\\\\Users', 'SESSDATA', 'bili_jct', 'Cookie']) assert.ok(!all.includes(x), x + ' 漏了')
  const seqs = c.evs().map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); assert.equal(new Set(seqs).size, seqs.length, '序号不重复')
  for (const e of c.evs()) for (const v2 of Object.values(e)) if (typeof v2 === 'string') assert.ok(v2.length <= 80, v2)
  c.close()
})

test('作息（窗口包着现在）：等着醒 →「在睡觉 · HH:MM 醒」，醒过了 →「今晚的事做完了」；20 小时前没做完的回合开机重放也不低落；回合时刻说开始；心跳是有名字的事件', async (t) => {
  const s = sandbox(t)
  const now = Date.now(), day = localDay(now)
  // 醒的窗口包着「现在」（时区钉在中午前后：11:00–14:00 一定包着）
  w(s.env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, claude: { timeoutMin: 25, rotateDays: 7 }, night: { windows: [{ start: '11:00', end: '14:00', wakes: 1 }] } })
  // 20 小时前的一回合：没做完（结果日志 ok:false、带 sessionId）—— 开机从它的 enqueue 重放，再用日志那行收尾
  const endMs = now - 20 * 3600_000, oldId = 'bili-whale-' + (endMs - 60_000), at = (ms) => new Date(ms).toISOString()
  w(path.join(s.hostDir, 'logs', `${localDay(endMs)}.jsonl`), JSON.stringify({ at: at(endMs), id: oldId, ok: false, sessionId: SID, costUsd: 0.2, ms: 60_000, prompt: 'x', result: 'CANARY_LOGRESULT' }) + '\n')
  w(path.join(s.proj, SID + '.jsonl'), jl(T.enq(at(endMs - 60_000)), T.prompt(at(endMs - 59_000), 1), T.api(at(endMs - 58_000)),
    { type: 'system', subtype: 'api_error', timestamp: at(endMs - 2000), sessionId: SID, retryAttempt: 10, maxRetries: 10 }, T.said(at(endMs - 1000), '没做完就断了', 'tool_use'), T.cost(0.2)))
  w(path.join(s.hostDir, 'session.json'), { id: SID })
  const wakeAt = now + 30 * 60_000
  w(path.join(s.dsh, 'whale-night.json'), { schema: 2, date: day, action: 'wake', fired: false, atMs: wakeAt, startsAt: todayAt(11), endsAt: todayAt(14), window: '11:00–14:00', windowKey: `${day}|11:00–14:00`, roll: 'watch' })
  const v = await startViewer(t, s)
  const pet = { 'x-whale-pet': v.info.petToken }
  const live = async () => JSON.parse((await req(v.port, '/api/live', { headers: pet })).body)
  let snap = await live()
  assert.deepEqual([snap.state, snap.expr, snap.caption], ['asleep', '困', `在睡觉 · ${hm(wakeAt)} 醒`], '在窗口里、今晚还有一次：睡着等')
  assert.deepEqual([snap.plan.when, snap.plan.text, snap.plan.action, snap.plan.startsAt], [hm(wakeAt), `${hm(wakeAt)} 醒（醒来看视频）`, 'wake', todayAt(11)])
  assert.deepEqual([snap.lastTurn.id, snap.lastTurn.ok, snap.lastTurn.at, snap.lastTurn.endedAt], [oldId, false, at(endMs - 60_000), at(endMs)])
  const mine = snap.feed.filter((e) => e.turn === oldId)
  assert.equal(mine[0].kind, 'turn_start'); assert.equal(mine[0].t, snap.lastTurn.at, '这一组的回合头 = 开始的时刻 = 上一回合卡片上的时刻')
  assert.ok(mine.some((e) => e.kind === 'retry') && mine.some((e) => e.kind === 'turn_end'), '整回合重放了（含出错）')
  // 开机重放的旧回合：结束是 20 小时前（按日志时刻，不按「开机那一刻读到的」）→ 不低落；几秒后也一样
  await sleep(1600)
  snap = await live()
  assert.equal(snap.state, 'asleep', '20 小时前没做完的回合不该让她低落')
  // 调度醒过她、排不出下一次了（done，理由是引擎的话）：今晚的事做完了；不画 zz（不是 asleep），引擎的理由不当句子念
  w(path.join(s.dsh, 'whale-night.json'), { schema: 2, date: day, action: 'done', done: true, reason: '今天可用窗口已结束或已经处理', wokeAt: iso(10 * 60_000), wakes: 1, usedCount: {} })
  snap = await until(async () => { const x = await live(); return x.state === 'night_done' ? x : null }, 10_000, () => '没换成「今晚的事做完了」')
  assert.deepEqual([snap.expr, snap.caption], ['困', '在睡觉 · 今晚的事做完了'])
  assert.deepEqual([snap.plan.text, snap.plan.reason, snap.plan.action, snap.plan.woke], ['今晚已经醒过了', '今天可用窗口已结束或已经处理', 'done', true])
  // done、可这一晚一次都没醒（窗口设成 0 次）：作息那行说「今晚不醒了」，气泡 / 桌宠就不能说「今晚的事做完了」
  w(path.join(s.dsh, 'whale-night.json'), { schema: 2, date: day, action: 'done', done: true, reason: '所有窗口都设成了 0 次', wokeAt: null, wakes: 0, usedCount: {} })
  snap = await until(async () => { const x = await live(); return x.plan?.woke === false ? x : null }, 10_000, () => '没换成「今晚不醒了」')
  assert.deepEqual([snap.state, snap.expr, snap.caption, snap.plan.text], ['night_done', '困', '在睡觉', '今晚不醒了'])
  // 心跳：SSE 里有名字的 hb 事件（EventSource 收得到；不带 id，不动断线续传）；快照里说几秒一次
  const cookie = await login(v, s)
  const c = sse(v.port, { cookie })
  t.after(() => c.close())
  assert.equal(await c.ready, 200)
  const hello = await until(() => c.events.find((e) => e.event === 'hello'))
  assert.deepEqual(hello.data.viewer, { startedAt: v.info.startedAt, beatSec: 10 })
  const hb = await until(() => c.events.find((e) => e.event === 'hb'), 20_000, () => '20 秒都没有心跳')
  assert.equal(hb.id, undefined); assert.ok(Number.isFinite(Date.parse(hb.data.at)))
  assert.ok(!/canary/i.test(c.raw + JSON.stringify(await live())))
})

test('白天（窗口外）：neutral「白天不醒，私信随时能叫醒她」、计划说「今晚 21:00」；开机前刚做完的回合不闪「做完了」，开着时没做完的才低落；今天那一栏：分享私信不算「发出」、结果不确定的另算', async (t) => {
  const s = sandbox(t)          // 配置里没写 night：默认 20:00–24:00，中午不在窗口里
  w(path.join(s.dsh, 'cast', 'demo', 'sprites', '白裙', '低落.png'), PNG)   // 有这张图才会给「低落」（没有就退到 neutral）
  const now = Date.now(), day = localDay(now)
  w(path.join(s.dsh, 'whale-night.json'), { schema: 2, date: day, action: 'wake', fired: false, atMs: todayAt(21), startsAt: todayAt(20), endsAt: todayAt(23, 59), window: '20:00–24:00', windowKey: `${day}|20:00–24:00`, roll: 'watch' })
  // 账本（和面板读同一份）：一条公开评论、一条分享私信（也记在 dm-quota 里）、一条结果不确定的评论；一个等审的视频、一个投稿结果不确定的、一条回复草稿
  w(path.join(s.ai, 'quota.json'), { log: [
    { at: iso(3600_000), type: 'comment', auto: true, share: false, target: 'BV:BV1Cat000001', note: '好看', rid: 'r1' },
    { at: iso(1800_000), type: 'dm', auto: false, share: true, target: 'BV:BV1Cat000001', note: '分享给主人', rid: 'r2' },
    { at: iso(600_000), type: 'comment', auto: true, share: false, target: 'oid:1', note: '不确定的', rid: 'r3', uncertain: true },
  ] })
  w(path.join(s.ai, 'dm-quota.json'), { date: day, count: 1 })
  const review = (id) => path.join(s.ai, 'review', id)
  w(path.join(s.ai, 'pending-videos.json'), { items: [{ id: '202610230900-wait', submissionId: 's1', title: '等你审的', seconds: 60, reason: '理由理由理由理由', at: iso(7200_000), snapshot: review('202610230900-wait'), originality: { passed: true, notes: [], scriptSha: 'a' }, hashes: {} }] })
  w(path.join(review('202610230900-wait'), 'submitted.json'), { title: '等你审的', submissionId: 's1', at: iso(7200_000) })
  w(path.join(review('202610220930-unc'), 'submitted.json'), { title: '结果不确定的', submissionId: 's3', at: iso(86000_000) })
  w(path.join(review('202610220930-unc'), 'attempts.json'), { unresolved: [{ at: iso(85000_000), submissionId: 's3', title: '结果不确定的', error: 'timeout', kind: 'failed' }], resolved: [] })
  w(path.join(s.ai, 'pending-replies.json'), { items: [{ id: 'ab12cd34', at: iso(600_000), oid: '1', type: '1', bvid: 'BV1aaaaaaaaa', root: '9', parent: '10', who: '路人', src: '问了个问题', real: { mid: '6666', name: '路人乙', text: '这期用的什么软件？' }, message: '用的是剪映' }] })
  // 小窗起来前 0.3 秒刚做完一回合（ok）：开小窗时不该闪「这回合做完了」（那是开着的时候结束的才有）
  const logFile = path.join(s.hostDir, 'logs', `${day}.jsonl`)
  w(logFile, JSON.stringify({ at: iso(300), id: 'manual-1', ok: true, sessionId: null, costUsd: 0.05, ms: 5000, prompt: 'x', result: 'x' }) + '\n')
  const v = await startViewer(t, s)
  const live = async () => JSON.parse((await req(v.port, '/api/live', { headers: { 'x-whale-pet': v.info.petToken } })).body)
  let snap = await live()
  assert.deepEqual([snap.state, snap.expr, snap.caption], ['day', 'neutral', '白天不醒，私信随时能叫醒她'])
  assert.deepEqual([snap.plan.when, snap.plan.text], ['今晚 21:00', '今晚 21:00 醒（醒来看视频）'])
  assert.equal(snap.lastTurn.id, 'manual-1')
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]))
  assert.deepEqual(pick(snap.today, ['sent', 'dmToOwner', 'pending', 'pendingVideos', 'pendingDrafts', 'uncertain']),
    { sent: 1, dmToOwner: 1, pending: 2, pendingVideos: 1, pendingDrafts: 1, uncertain: 1 }, '分享私信只算「给你私信」；结果不确定的投稿不算「等你审」')
  // 开着小窗时一回合没做完：低落一小时内（之后没有做成的）
  fs.appendFileSync(logFile, JSON.stringify({ at: iso(), id: 'manual-2', ok: false, sessionId: null, costUsd: 0.01, ms: 3000, prompt: 'x', result: 'x' }) + '\n')
  snap = await until(async () => { const x = await live(); return x.lastTurn?.id === 'manual-2' ? x : null }, 15_000, () => '结果日志那行没认出来')
  assert.deepEqual([snap.state, snap.expr, snap.caption], ['failed', '低落', '上一回合没做完'])
  assert.equal(Date.parse(snap.lastTurn.endedAt) - Date.parse(snap.lastTurn.at), 3000, 'at 是开始、endedAt 是结束')
  // 补的回合头在收尾之前、时刻是开始
  const evs = snap.feed.filter((e) => e.turn === 'manual-2')
  assert.deepEqual(evs.map((e) => [e.kind, e.t]), [['turn_start', snap.lastTurn.at], ['turn_end', snap.lastTurn.endedAt]])
})

test('当面聊（cli open）：宿主没有回合时冒出来的提示词另起一组「你在和她当面聊」，不记到上一个做完的回合底下；快照里有这个假回合；主人的原话（搜的词）进不了 caption 和进行中的牌子', async (t) => {
  const s = sandbox(t)
  const night = 'bili-whale-' + (Date.now() - 600_000)
  w(path.join(s.hostDir, 'logs', `${localDay(Date.now())}.jsonl`), JSON.stringify({ at: iso(400_000), id: night, ok: true, sessionId: SID, costUsd: 0.3, ms: 200_000, prompt: 'x', result: 'x' }) + '\n')
  w(path.join(s.proj, SID + '.jsonl'), jl(T.enq(iso(600_000)), T.prompt(iso(599_000), 1), T.api(iso(598_000)), T.said(iso(401_000), '今晚就到这里'), T.cost(0.3)))
  w(path.join(s.hostDir, 'session.json'), { id: SID })
  const v = await startViewer(t, s)
  const pet = { 'x-whale-pet': v.info.petToken }
  const live = async () => JSON.parse((await req(v.port, '/api/live', { headers: pet })).body)
  let snap = await live()
  const nightEnd = snap.feed.find((e) => e.kind === 'turn_end' && e.turn === night)
  assert.ok(nightEnd, '上一回合已经收尾'); assert.equal(snap.turn, null)
  // 主人 cli open：paused.json 的进程活着；提示词不是 SDK 发的、前面没有 enqueue（空闲时打的字不排队）
  w(path.join(s.hostDir, 'paused.json'), { pid: process.pid, at: iso() })
  const chatTs = iso(), chatId = 'chat-' + Date.parse(chatTs)
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(
    { type: 'user', uuid: u(), timestamp: chatTs, sessionId: SID, entrypoint: 'cli', message: { role: 'user', content: 'CANARY_CHAT 帮我搜一下 OWNERKW秘密词' } },
    T.api(iso()), T.tool(iso(), 'toolu_cs', 'node bili.mjs search "OWNERKW秘密词"', 'Search videos')))
  snap = await until(async () => { const x = await live(); return x.turn?.inflight?.length ? x : null }, 15_000, () => '当面聊的那几行没读进来')
  assert.deepEqual([snap.turn.id, snap.turn.kind, snap.turn.kindLabel, snap.turn.at, snap.turn.steps], [chatId, 'chat', '你在和她当面聊', chatTs, 1])
  assert.deepEqual(snap.turn.inflight.map((x) => x.cap), ['在搜视频'])
  assert.deepEqual([snap.state, snap.caption, snap.host.state], ['chatting', '你正在和她当面聊', 'paused'])
  assert.ok(!JSON.stringify([snap.caption, snap.turn]).includes('OWNERKW'), '桌宠念的 caption、进行中的牌子里没有主人的原话')
  const srch = snap.feed.find((e) => e.kind === 'tool_start' && e.toolId === 'toolu_cs')
  assert.deepEqual([srch.turn, srch.cap, srch.text, srch.private], [chatId, '在搜视频', undefined, true], '桌宠拿到的没有原话')
  assert.ok(!JSON.stringify(snap).includes('OWNERKW'))
  // 小窗页面那份：原话只在 text 里、标了 private（「遮住私话」能遮）
  const cookie = await login(v, s)
  const page = JSON.parse((await req(v.port, '/api/live', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).body)
  const srchW = page.feed.find((e) => e.kind === 'tool_start' && e.toolId === 'toolu_cs')
  assert.deepEqual([srchW.turn, srchW.cap, srchW.text, srchW.private], [chatId, '在搜视频', 'OWNERKW秘密词', true], '原话只在 text 里、标了 private（「遮住私话」能遮）')
  fs.appendFileSync(path.join(s.proj, SID + '.jsonl'), jl(T.result(iso(), 'toolu_cs', '没有结果'), T.api(iso()), T.said(iso(), '没搜到呢，换个词试试？')))
  snap = await until(async () => { const x = await live(); return x.feed.some((e) => e.kind === 'said' && e.turn === chatId) ? x : null }, 15_000)
  assert.equal(snap.feed.find((e) => e.kind === 'said' && e.turn === chatId).private, true)
  const after = snap.feed.filter((e) => e.seq > nightEnd.seq)
  assert.ok(after.length >= 5 && after.every((e) => e.turn === chatId), '收尾之后的都在聊天那一组：' + JSON.stringify(after.map((e) => [e.kind, e.turn])))
  assert.equal(after[0].kind, 'turn_start'); assert.equal(after[0].cap, '你在和她当面聊')
  assert.ok(!snap.feed.some((e) => e.turn === chatId && e.kind === 'turn_end'), '当面聊没有「这回合做完了」')
  // 聊完（paused.json 没了）：快照里不再有这个回合
  fs.rmSync(path.join(s.hostDir, 'paused.json'))
  snap = await until(async () => { const x = await live(); return x.turn === null ? x : null }, 10_000, () => '聊完了快照里还挂着当面聊')
  assert.notEqual(snap.state, 'chatting')
  assert.ok(!/canary/i.test(JSON.stringify(snap)))
})

test('桌宠：pet:true 起一个子进程（令牌只在环境变量里、能用它看快照）；pet:false 关掉；退出码 3 退避重启、2 不再重启（关了再开才试）', async (t) => {
  const s = sandbox(t)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-win-pet-'))
  t.after(() => fs.rmSync(out, { recursive: true, force: true, maxRetries: 5 }))
  // 假桌宠：记下自己拿到的东西（令牌只记哈希），用令牌去看一眼快照；有 exit-code 文件就按它退出，没有就一直挂着
  const stub = path.join(out, 'stub.mjs')
  w(stub, `import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path'; import crypto from 'node:crypto'
const out = process.env.WHALE_STUB_OUT, tok = process.env.WHALE_PET_TOKEN ?? ''
const rec = { pid: process.pid, url: process.env.WHALE_PET_URL, tokenHash: crypto.createHash('sha256').update(tok).digest('hex'), tokenInArgv: process.argv.some((a) => tok && a.includes(tok)),
  node: process.env.WHALE_PET_NODE, cli: process.env.WHALE_PET_CLI, cwd: process.cwd() }
let code = null; try { code = Number(fs.readFileSync(path.join(out, 'exit-code'), 'utf8')) } catch {}
rec.exit = Number.isInteger(code) ? code : null
const u = new URL(rec.url)
http.get({ host: u.hostname, port: u.port, path: '/api/live', headers: { host: u.host, 'x-whale-pet': tok } }, (r) => {
  let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => {
    rec.live = r.statusCode; try { rec.state = JSON.parse(b).state } catch {}
    fs.appendFileSync(path.join(out, 'runs.jsonl'), JSON.stringify(rec) + '\\n')
    if (rec.exit !== null) process.exit(rec.exit); else setInterval(() => {}, 1000)
  })
}).on('error', () => process.exit(9))
`)
  const runs = () => { try { return fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
  const v = await startViewer(t, s, { BILI_WHALE_WINDOW_PET_STUB: stub, WHALE_STUB_OUT: out })
  t.after(() => { for (const r of runs()) try { process.kill(r.pid) } catch {} })
  const ctl = (pet) => w(path.join(s.hostDir, 'window-ctl.json'), { pet })
  await sleep(500)
  assert.equal(runs().length, 0, '没开桌宠就不起')
  ctl(true)
  const [r1] = await until(() => (runs().length ? runs() : null), 6000, () => '桌宠没起来：' + v.out())
  assert.equal(r1.url, `http://127.0.0.1:${v.port}`)
  assert.equal(r1.tokenHash, crypto.createHash('sha256').update(v.info.petToken).digest('hex'), '令牌就是 window.json 里那个')
  assert.equal(r1.tokenInArgv, false, '令牌不在命令行里')
  assert.equal(r1.live, 200); assert.equal(typeof r1.state, 'string')
  assert.equal(r1.node, NODE); assert.equal(path.resolve(r1.cli), path.join(root, 'host', 'cli.mjs')); assert.equal(path.resolve(r1.cwd), path.resolve(root))
  assert.ok(alive(r1.pid))
  ctl(false)
  await until(() => !alive(r1.pid), 6000, () => 'pet:false 没关掉桌宠')
  // 退出码 3（连不上服务）：退避后重启；这时改成 2（这台电脑跑不了）→ 不再重启
  w(path.join(out, 'exit-code'), '3')
  ctl(true)
  await until(() => runs().length >= 2, 6000)
  assert.equal(runs()[1].exit, 3)
  w(path.join(out, 'exit-code'), '2')
  const t2 = Date.now()
  await until(() => runs().length >= 3, 8000, () => '退出码 3 之后没重启')
  assert.ok(Date.now() - t2 >= 1000, '退避了一会儿才重启')
  assert.equal(runs()[2].exit, 2)
  await sleep(6000)
  assert.equal(runs().length, 3, '退出码 2 之后不再重启')
  // 关了再开：再试一次
  fs.rmSync(path.join(out, 'exit-code'))
  ctl(false); await sleep(2500); ctl(true)
  await until(() => runs().length >= 4, 6000, () => '关了再开没再试')
  ctl(false)
  await until(() => !alive(runs()[3].pid), 6000)
  // cli 每次 --pet 都写一个新的 at：开着的时候主人又说了一次 --pet on（她可能被「隐藏 10 分钟」藏着）→ 重起一个，命令说的「几秒内出现」才算数
  const ctlAt = (at) => w(path.join(s.hostDir, 'window-ctl.json'), { pet: true, at })
  ctlAt('2026-10-24T20:00:00.000Z')
  await until(() => runs().length >= 5, 8000, () => '--pet on 没起桌宠')
  const r5 = runs()[4]
  ctlAt('2026-10-24T20:05:00.000Z')
  await until(() => runs().length >= 6 && !alive(r5.pid), 8000, () => '又一次 --pet on 没重起她')
  await sleep(2500)
  assert.equal(runs().length, 6, '同一个 at 再读到不重起')
  ctl(false)
  await until(() => !alive(runs()[5].pid), 6000)
})

// ─────────────── cli window（不开 Edge：BILI_WHALE_WINDOW_NO_EDGE=1） ───────────────
test('cli window：起后台服务、打印带一次性口令的地址、已经开着就不开第二个、--pet on|off 写 window-ctl.json、--stop 停掉、参数不对给用法', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t)
  const port = await freePort()
  const cli = (...args) => {
    const r = spawnSync(NODE, [path.join(root, 'host/cli.mjs'), 'window', ...args], { env: s.env, encoding: 'utf8', timeout: 60_000 })
    return { code: r.status, out: String(r.stdout) + String(r.stderr) }
  }
  const cliAsync = (...args) => new Promise((resolve) => {
    const p = spawn(NODE, [path.join(root, 'host/cli.mjs'), 'window', ...args], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
  // 两个 cli window 同时起（终端里一个、点桌宠一个）：输的那个服务撞端口自己退出 —— 两条命令都用赢的那个，都不报「没起来」
  const both = await Promise.all([cliAsync('--no-open', '--port', String(port)), cliAsync('--no-open', '--port', String(port))])
  const info = readJson(s.info)
  if (info?.pid) s.pids.push(info.pid)                 // 后台服务是脱离的：测试失败也要结束它
  for (const r0 of both) { assert.equal(r0.code, 0, r0.out); assert.match(r0.out, new RegExp(`pid ${info.pid}`), r0.out); assert.match(r0.out, /打开窗口：node host\/cli\.mjs window/) }
  assert.match(both.map((x) => x.out).join('\n'), /小窗服务起来了/)
  assert.equal(info.port, port); assert.ok(alive(info.pid))
  let r
  assert.ok(fs.existsSync(path.join(s.hostDir, 'window.out')), '后台服务的输出进 window.out（和 daemon.out 一样）')
  // 再跑一次：用同一个服务，打印地址
  r = cli()
  assert.equal(r.code, 0, r.out)
  const m = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?k=([A-Za-z0-9_-]{16,64})`).exec(r.out)
  assert.ok(m, r.out); assert.doesNotMatch(r.out, /起来了/, '没起第二个')
  assert.equal(readJson(s.info).pid, info.pid)
  const red = await req(port, '/?k=' + m[1])
  assert.equal(red.status, 302, '打印的口令能用'); const cookie = /^whale_win=[^;]+/.exec(red.headers['set-cookie'][0])[0]
  // --pet on：写 window-ctl.json；不开 Edge、不打印地址（测试里也不起桌宠）
  r = cli('--pet', 'on')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /桌宠开了/); assert.doesNotMatch(r.out, /\?k=/)
  assert.equal(readJson(path.join(s.hostDir, 'window-ctl.json')).pet, true)
  // 窗口已经连着了：不再给新地址
  const c = sse(port, { cookie })
  assert.equal(await c.ready, 200)
  r = cli()
  assert.equal(r.code, 0, r.out); assert.match(r.out, /已经开着了/); assert.doesNotMatch(r.out, /\?k=/)
  c.close()
  r = cli('--pet', 'off')
  assert.equal(r.code, 0, r.out); assert.equal(readJson(path.join(s.hostDir, 'window-ctl.json')).pet, false)
  r = cli('--pet', 'on')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /屏幕右下角、小窗左边/); assert.match(r.out, /再跑一次这条命令/)
  // 参数不对
  r = cli('--bogus')
  assert.equal(r.code, 2); assert.match(r.out, /用法：node host\/cli\.mjs window/)
  r = cli('--pet', 'maybe')
  assert.equal(r.code, 2)
  // --stop：只停命令行是 window.mjs 的那个进程；window.json 删掉
  r = cli('--stop')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /小窗服务停了/)
  assert.match(r.out, /桌宠的开关还开着：下次 node host\/cli\.mjs window 她会跟着回来/, '--stop 不改 window-ctl.json：说清楚她下次会回来')
  await until(() => !alive(info.pid), 6000, () => '没停掉')
  assert.equal(fs.existsSync(s.info), false)
  r = cli('--stop')
  assert.equal(r.code, 0); assert.match(r.out, /没在跑/)
  // 帮助里有这条命令；window 不搬老布局（只读）
  const h = spawnSync(NODE, [path.join(root, 'host/cli.mjs'), 'help'], { env: s.env, encoding: 'utf8', timeout: 30_000 })
  assert.match(h.stdout, /node host\/cli\.mjs window \[--with-pet\] \[--no-open\] \[--top\] \[--pet on\|off\] \[--stop \[--force\]\] \[--port 8766\]/)
  const src = fs.readFileSync(path.join(root, 'host', 'cli.mjs'), 'utf8')
  assert.match(src, /\['help', 'prompt', 'dashboard', 'window'\]\.includes\(cmd\)/)
})

test('cli window --stop 不动进程号被复用了的别的进程', { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
  const s = sandbox(t)
  const other = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  s.procs.push(other)
  w(s.info, { pid: other.pid, port: 1, startedAt: iso(), code: 'x', codeExpiresAt: iso(), petToken: 'y' })
  const r = spawnSync(NODE, [path.join(root, 'host/cli.mjs'), 'window', '--stop'], { env: s.env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 1, r.stdout); assert.match(r.stdout, /不是小窗服务/)
  assert.ok(alive(other.pid), '别的进程还活着')
})

test('cli window --with-pet --out（桌面按钮用）：小窗服务起来、桌宠记成开着、说的话整段写进文件；没打印到控制台；BILI_WHALE_WINDOW_PORT 换默认端口', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t)
  const port = await freePort()
  const out = path.join(s.home, 'button-window.txt')
  const r = spawnSync(NODE, [path.join(root, 'host/cli.mjs'), 'window', '--with-pet', '--out', out], { env: { ...s.env, BILI_WHALE_WINDOW_PORT: String(port) }, encoding: 'utf8', timeout: 60_000 })
  const info = readJson(s.info)
  if (info?.pid) s.pids.push(info.pid)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(String(r.stdout).trim(), '', '按钮的脚本没有控制台：都写进 --out 的文件')
  const said = fs.readFileSync(out, 'utf8')
  assert.match(said, /小窗服务起来了/); assert.ok(said.includes(`http://127.0.0.1:${port}/?k=`), said)
  assert.equal(info.port, port, '没给 --port 时用 BILI_WHALE_WINDOW_PORT')
  if (process.platform === 'win32') { assert.match(said, /桌宠也开了/); assert.equal(readJson(path.join(s.hostDir, 'window-ctl.json')).pet, true) }
  // --out 的文件每次新写，不追加
  const r2 = spawnSync(NODE, [path.join(root, 'host/cli.mjs'), 'window', '--with-pet', '--out', out], { env: { ...s.env, BILI_WHALE_WINDOW_PORT: String(port) }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r2.status, 0); assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /小窗服务起来了/, '第二次用的是同一个服务、文件是新写的')
  assert.equal(readJson(s.info).pid, info.pid)
})
