// 本地面板的门（2026-10-26，主人定的 A 方案，照小窗服务的做法）：没有有效 cookie 的请求（页面、/api/state、别的路径）什么数据都拿不到，
// 只有一句「从命令行打开」；cli dashboard 打印的一次性链接（10 分钟、只能用一次、比较时间不随内容变）换成 HttpOnly + SameSite=Strict、Path=/、
// 不带 Domain 的 cookie，303 回不带口令的 /；会话令牌只在面板进程的内存里；Host / Sec-Fetch-Site / Origin / 只接 GET、HEAD 照旧；
// 面板开着时再跑一次 cli dashboard 拿新链接（从只有主人读得到的 dashboard.json 读），不起第二个；口令、令牌除了打印的那个链接，哪里都不出现。
// 全程离线：家目录都是临时的、随机端口、不开浏览器
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { moduleInstalled } from '../host/modules.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
// 时区钉在「这会儿正好是中午 12 点左右」（同 tests/dashboard.test.mjs）：下面的回合记录是「一两分钟前」，面板只数本地日期是今天的
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Windows Terminal 1.24 认链接的规则（Microsoft.Terminal.Control.dll 里的那条）：ctrl+点击时，末尾的「-」不算进链接
const WT_LINK = /\b(?:https?|ftp|file):\/\/[-A-Za-z0-9+&@#/%?=~_|$!:,.;]*[A-Za-z0-9+&@#/%=~_|$]/

// 私密的东西（金丝雀）：她在 QQ 上回主人的话、回合失败的原因、陌生人私信的摘录和她回的、她的日记 —— 没登录时一个字都不能出现，登录后都在
const CANARY = { qq: 'PRIVATE_QQ_REPLY_CANARY', fail: 'PRIVATE_FAIL_REASON_CANARY', their: 'STRANGER_SAID_CANARY', her: 'HER_SDM_REPLY_CANARY', diary: 'PRIVATE_DIARY_CANARY' }
function seed(home) {
  const dsh = path.join(home, 'data'), ai = path.join(home, '.bili-ai'), hostDir = path.join(dsh, 'whale-cc'), work = path.join(dsh, 'whale-work')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work }
  for (const k of ['NODE_OPTIONS', 'BILI_WHALE_AGENT', 'BILI_WHALE_TURN', 'BILI_WHALE_VIA']) delete env[k]
  const now = Date.now()
  w(env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, self: { mid: '333' }, listen: { dmStrangers: 'on' } })
  w(path.join(hostDir, 'logs', `${localDay(now)}.jsonl`), [
    { at: iso(60_000), id: 'bili-whale-qq-1', ok: true, costUsd: null, ms: 1000, prompt: 'x', result: CANARY.qq },
    { at: iso(120_000), id: 'bili-whale-dm-2', ok: false, costUsd: null, ms: 1000, prompt: 'x', result: CANARY.fail },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  w(path.join(ai, 'dm-stranger-state.json'), { version: 1, owner: '222', self: '333', mode: 'on', peers: { 1001: { name: '小明', initiatedBy: 'them', lastTurnAt: now - 5000 } } })
  w(path.join(ai, 'sdm-replies.json'), { entries: [{ id: 's-1', turnId: 'bili-whale-sdm-a', peer: '1001', kind: 'reply', hash: 'h', len: 1, state: 'sent', at: now - 4000, her: CANARY.her, their: CANARY.their }] })
  w(path.join(work, 'whale-diary.md'), `# 给主人的信\n\n${CANARY.diary}\n`)
  return { home, dsh, ai, hostDir, env }
}

// 测试进程里直接 import 的面板模块在 import 的那一刻就把路径定死了：先把家目录指到一个临时目录（qq-config.test.mjs 一个样子）
const MOD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-dashgate-mod-'))
const MOD = seed(MOD_HOME)
Object.assign(process.env, { USERPROFILE: MOD_HOME, HOME: MOD_HOME, DSH_HOME: MOD.dsh, BILI_WHALE_CONFIG: MOD.env.BILI_WHALE_CONFIG, BILI_WHALE_AI_HOME: MOD.env.BILI_WHALE_AI_HOME })
for (const k of ['BILI_WHALE_AGENT', 'BILI_WHALE_TURN', 'BILI_WHALE_VIA']) delete process.env[k]
process.on('exit', () => { try { fs.rmSync(MOD_HOME, { recursive: true, force: true }) } catch {} })
const dash = await import('../host/dashboard.mjs')
assert.ok(dash.DASH_INFO_FILE?.startsWith(MOD_HOME) ?? true, '测试进程里的 dashboard.json 在临时目录里')

function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) }) }
async function until(fn, ms, why) { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(typeof why === 'function' ? why() : why); await sleep(50) } }
function req(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers }, agent: false }, (res) => {
      let b = ''
      res.setEncoding('utf8'); res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }))
    })
    r.on('error', reject); r.end()
  })
}
const cookieOf = (r) => /^whale_dash=[^;]+/.exec(r.headers['set-cookie']?.[0] ?? '')?.[0] ?? null
const readInfo = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
/** 没有任何数据：金丝雀、陌生人的昵称、快照的字段都不在 */
function noData(body, what) {
  for (const c of Object.values(CANARY)) assert.ok(!body.includes(c), `${what}：${c}`)
  assert.doesNotMatch(body, /小明|"turns"|"sdm"|她最后说的|bili-whale-qq-1/, what)
}
/** 测试进程里起一个面板（自己的 dashboard.json，不和别的测试抢） */
async function panel(t, opts = {}) {
  const port = opts.port ?? await freePort()
  const infoFile = opts.infoFile ?? path.join(MOD.hostDir, `dashboard-${port}.json`)
  const server = dash.startDashboard({ ...opts, port, infoFile })
  t.after(() => server.stop())
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  return { server, port, infoFile, info: () => readInfo(infoFile) }
}
/** 停掉，等端口真的放开（同一个端口马上要再起一个） */
const stopPanel = (v) => new Promise((resolve) => { if (!v.server.listening) return resolve(); v.server.once('close', resolve); v.server.stop() })
async function login(v, code = v.info().code) {
  const r = await req(v.port, '/?k=' + code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r.status, 303, r.body); assert.equal(r.headers.location, '/')
  const c = cookieOf(r)
  assert.ok(c, '换到了 cookie')
  return c
}

// ─────────────── 没登录 ───────────────
test('gate: without a valid cookie nothing is served — page, /api/state, HEAD and every other path get only the fixed "open the cli link" answer', async (t) => {
  const v = await panel(t)
  const P = v.port
  const page = await req(P, '/')
  assert.equal(page.status, 401); assert.match(page.headers['content-type'], /^text\/html/)
  assert.match(page.body, /node host\/cli\.mjs dashboard/); assert.match(page.body, /只能用一次/)
  assert.doesNotMatch(page.body, /http-equiv="refresh"/, '那一句不自己刷新')
  assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.equal(page.headers['cache-control'], 'no-store')
  noData(page.body, '页面')
  const api = await req(P, '/api/state')
  assert.equal(api.status, 401); assert.match(api.headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(api.body), { error: 'locked', message: dash.LOCKED_TEXT })
  noData(api.body, '/api/state')
  for (const p of ['/', '/api/state']) { const h = await req(P, p, { method: 'HEAD' }); assert.equal(h.status, 401, 'HEAD ' + p); assert.equal(h.body, '') }
  for (const p of ['/nope', '/api/other', '/../.bili-ai/credentials.json', '/index.html', '/?x=1']) { const r = await req(P, p); assert.equal(r.status, 401, p); noData(r.body, p) }
  // 编的 / 格式不对的 / 别的服务的 cookie：一样
  for (const cookie of ['whale_dash=' + crypto.randomBytes(32).toString('base64url'), 'whale_dash=', 'whale_dash=../../x', 'whale_win=' + crypto.randomBytes(32).toString('base64url'), 'x=1; whale_dash=' + 'A'.repeat(43)]) {
    const r = await req(P, '/api/state', { headers: { cookie } })
    assert.equal(r.status, 401, cookie); noData(r.body, cookie)
  }
  // 给 cli 探活的 /health：不带任何数据
  const h = await req(P, '/health')
  assert.equal(h.status, 200); assert.deepEqual(Object.keys(JSON.parse(h.body)).sort(), ['app', 'ok', 'startedAt']); noData(h.body, '/health')
  // 主人换到 cookie 以后什么都在（门挡的就是这些）
  const cookie = await login(v)
  const full = await req(P, '/', { headers: { cookie } })
  assert.equal(full.status, 200)
  const sdm = moduleInstalled('sdm')
  for (const c of [CANARY.qq, CANARY.fail, ...(sdm ? [CANARY.their, CANARY.her] : []), CANARY.diary]) assert.ok(full.body.includes(c), c)
  const j = JSON.parse((await req(P, '/api/state', { headers: { cookie } })).body)
  if (sdm) { assert.equal(j.sdm.rows[0].her, CANARY.her); assert.equal(j.sdm.rows[0].their, CANARY.their) }
  else {
    // 公开版（没装陌生人私信模块）：面板根本没有这一块，状态文件里的原话登录了也不出现
    assert.equal(j.sdm, undefined)
    for (const c of [CANARY.their, CANARY.her]) { assert.ok(!full.body.includes(c), c); assert.ok(!JSON.stringify(j).includes(c), c) }
  }
})

// ─────────────── 换 cookie ───────────────
test('gate: a good code → 303 to / without the code; the cookie is HttpOnly + SameSite=Strict + Path=/ with no Domain; the 20-second refresh keeps working', async (t) => {
  const v = await panel(t)
  const code = v.info().code
  const r = await req(v.port, '/?k=' + code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/', '跳回不带口令的 /'); assert.equal(r.body, '')
  assert.equal(r.headers['set-cookie'].length, 1)
  assert.match(r.headers['set-cookie'][0], /^whale_dash=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/)
  assert.doesNotMatch(r.headers['set-cookie'][0], /Domain|Max-Age|Expires/i)
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['referrer-policy'], 'no-referrer')
  const cookie = cookieOf(r)
  // 页面每 20 秒用 <meta refresh> 重新打开 /（同源导航，浏览器带着 SameSite=Strict 的 cookie）：不带口令
  const page = await req(v.port, '/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  assert.equal(page.status, 200)
  assert.match(page.body, /<meta http-equiv="refresh" content="20">/, '刷新的是当前地址 /（不带 url=）')
  assert.doesNotMatch(page.body, /\?k=/); assert.ok(!page.body.includes(code))
  assert.equal((await req(v.port, '/api/state', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status, 200)
  // 已经登录的再点一次用过的链接：照样跳回 /，不再发 cookie
  const again = await req(v.port, '/?k=' + code, { headers: { cookie } })
  assert.equal(again.status, 303); assert.equal(again.headers.location, '/'); assert.equal(again.headers['set-cookie'], undefined)
  // 会话过期了（面板重启过）：自动刷新拿到的是那一句，不是坏掉的页面
  await stopPanel(v)
  const v2 = await panel(t, { port: v.port })
  const stale = await req(v2.port, '/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  assert.equal(stale.status, 401); assert.match(stale.body, /node host\/cli\.mjs dashboard/)
})

test('gate: a wrong, malformed, reused or expired code gets no cookie (and is still stripped from the address bar)', async (t) => {
  const v = await panel(t)
  const P = v.port
  const noCookie = async (k, why) => {
    const r = await req(P, '/?k=' + k, { headers: { 'sec-fetch-site': 'none' } })
    assert.equal(r.status, 303, why); assert.equal(r.headers.location, '/', why); assert.equal(r.headers['set-cookie'], undefined, why)
  }
  await noCookie(crypto.randomBytes(18).toString('base64url'), '不对的口令')
  for (const bad of ['', 'short', 'x'.repeat(65), '..%2F..%2Fa', '%00', encodeURIComponent(v.info().code + '\n')]) await noCookie(bad, '格式不对：' + bad)
  // 用过一次就作废
  const code = v.info().code
  await login(v, code)
  await noCookie(code, '用过的口令')
  assert.equal((await req(P, '/')).status, 401)
  // 过期：口令只活 ttl（这里 1.5 秒；平时 10 分钟）
  const v2 = await panel(t, { codeTtl: 1500 })
  const old = v2.info().code
  await sleep(1700)
  const r = await req(v2.port, '/?k=' + old)
  assert.equal(r.status, 303); assert.equal(r.headers['set-cookie'], undefined, '过期的口令')
  assert.notEqual(v2.info().code, old, '到点换了新的')
  await login(v2)   // 新的照样能用
})

test('gate: HEAD never redeems a code; Host, Sec-Fetch-Site, Origin and GET/HEAD-only still apply even with a valid cookie', async (t) => {
  const v = await panel(t)
  const P = v.port, code = v.info().code
  const head = await req(P, '/?k=' + code, { method: 'HEAD' })
  assert.equal(head.status, 303); assert.equal(head.headers['set-cookie'], undefined, 'HEAD 不兑换（预取 / 探测不把口令用掉）')
  const cookie = await login(v, code)
  // Host（挡 DNS 重绑定）：在 cookie 之前就挡
  assert.equal((await req(P, '/api/state', { host: 'evil.example:' + P, headers: { cookie } })).status, 421)
  assert.equal((await req(P, '/api/state', { host: '127.0.0.1:1', headers: { cookie } })).status, 421)
  assert.equal((await req(P, '/?k=' + v.info().code, { host: 'evil.example:' + P })).status, 421, '换了 Host 的不兑换')
  assert.equal((await req(P, '/api/state', { host: `localhost:${P}`, headers: { cookie } })).status, 200)
  // 别的网页发来的（连同本机别的端口：对 cookie 来说算同站）
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await req(P, '/api/state', { headers: { cookie, 'sec-fetch-site': site } })).status, 403, site)
    assert.equal((await req(P, '/?k=' + v.info().code, { headers: { 'sec-fetch-site': site } })).status, 403, site + '：不兑换')
  }
  for (const site of ['same-origin', 'none']) assert.equal((await req(P, '/api/state', { headers: { cookie, 'sec-fetch-site': site } })).status, 200, site)
  for (const origin of ['http://evil.example', `http://127.0.0.1:${P + 1}`, 'null']) assert.equal((await req(P, '/api/state', { headers: { cookie, origin } })).status, 403, origin)
  assert.equal((await req(P, '/api/state', { headers: { cookie, origin: `http://127.0.0.1:${P}` } })).status, 200)
  // 只读
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await req(P, '/api/state', { method, headers: { cookie } })
    assert.equal(r.status, 405, method); assert.equal(r.headers.allow, 'GET, HEAD')
  }
  const h = await req(P, '/api/state', { method: 'HEAD', headers: { cookie } })
  assert.equal(h.status, 200); assert.equal(h.body, '')
})

// ─────────────── 口令、令牌怎么比、怎么换 ───────────────
test('gate: codes are single-use, live 10 minutes, rotate at half-life (the previous one still counts); bad formats are refused', () => {
  let now = 1_000_000
  const changes = []
  const c = dash.createCodes({ now: () => now, onChange: (x) => changes.push(x.code) })
  const a = c.current()
  assert.match(a.code, /^[0-9a-f]{32}$/); assert.equal(a.exp - now, 10 * 60_000); assert.equal(dash.CODE_TTL, 10 * 60_000)
  assert.equal(c.redeem(a.code), true); assert.equal(c.redeem(a.code), false, '用过一次就作废')
  assert.notEqual(c.current().code, a.code, '兑换后马上换新的'); assert.equal(changes.length, 2)
  const b = c.current().code
  now += 5 * 60_000; c.rotate()
  assert.equal(c.redeem(b), true, '上一个还没到 10 分钟：还认')
  const d = c.current().code
  now += 10 * 60_000 + 1
  assert.equal(c.redeem(d), false, '过了 10 分钟')
  for (const bad of ['', 'short', 'x'.repeat(65), '../../a', null, 42, undefined, d + '\n', [d]]) assert.equal(c.redeem(bad), false, String(bad))
})

test('gate: codes and session tokens are compared in constant time — every live one, no early exit', async (t) => {
  const real = crypto.timingSafeEqual
  let calls = 0
  crypto.timingSafeEqual = (x, y) => { calls += 1; return real(x, y) }
  t.after(() => { crypto.timingSafeEqual = real })
  assert.equal(dash.safeEq('abc', 'abc'), true); assert.equal(dash.safeEq('abc', 'abcd'), false, '长度不同也照样比（先哈希成一样长）')
  calls = 0
  let now = 1_000_000
  const c = dash.createCodes({ now: () => now })
  now += 1000; c.rotate()                                       // 两个都还活着
  calls = 0; assert.equal(c.redeem(crypto.randomBytes(18).toString('base64url')), false); assert.equal(calls, 2, '不对的口令：两个都比过')
  calls = 0; assert.equal(c.redeem(c.current().code), true); assert.equal(calls, 2, '第一个就对上了也接着比完')
  const s = dash.createSessions()
  const sids = [s.add(), s.add(), s.add()]
  calls = 0; assert.equal(s.has('whale_dash=' + crypto.randomBytes(32).toString('base64url')), false); assert.equal(calls, 3)
  calls = 0; assert.equal(s.has(`a=b; whale_dash=${sids[2]}`), true); assert.equal(calls, 3)
  calls = 0; assert.equal(s.has('whale_dash=short'), false); assert.equal(calls, 0, '格式不对的不比')
  // 服务里：每个请求的 cookie 都是这么比的
  const v = await panel(t)
  await login(v); await login(v)
  calls = 0
  assert.equal((await req(v.port, '/api/state', { headers: { cookie: 'whale_dash=' + crypto.randomBytes(32).toString('base64url') } })).status, 401)
  assert.equal(calls, 2, '两个会话都比过')
  // 源码里口令 / 令牌只用 safeEq 比，不用 === 比
  const src = fs.readFileSync(path.join(root, 'host/dashboard.mjs'), 'utf8')
  assert.match(src, /crypto\.timingSafeEqual\(digest\(a\), digest\(b\)\)/)
  for (const fn of [dash.createCodes, dash.createSessions]) {
    const body = fn.toString()
    assert.match(body, /safeEq\(/)
    assert.doesNotMatch(body, /\b(code|sid|s|v)\s*[!=]==\s*(k|v|s|sid)\b|\bk\s*[!=]==\s*[\w.]*code\b/, fn.name)
  }
})

test('gate: dashboard.json holds just the current code, rotates after use, leaves no temp files, is removed on stop; sessions live only in memory; nothing secret is logged', async (t) => {
  const logs = []
  const v = await panel(t, { log: (m) => logs.push(String(m)) })
  const info = v.info()
  assert.deepEqual(Object.keys(info).sort(), ['code', 'codeExpiresAt', 'pid', 'port', 'startedAt'])
  assert.equal(info.pid, process.pid); assert.equal(info.port, v.port); assert.match(info.code, /^[0-9a-f]{32}$/)
  const left = Date.parse(info.codeExpiresAt) - Date.now()
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000, '口令最多 10 分钟')
  assert.equal(v.server.link(), `http://127.0.0.1:${v.port}/?k=${info.code}`, 'cli 打印的就是文件里这个')
  if (process.platform !== 'win32') assert.equal(fs.statSync(v.infoFile).mode & 0o777, 0o600, '只给自己读写')
  // 用掉一个：文件里马上换成新的（第二个浏览器用新的）
  const c1 = await login(v, info.code)
  await until(() => v.info()?.code !== info.code, 3000, '兑换后没换口令')
  const c2 = await login(v)
  assert.notEqual(c1, c2)
  assert.deepEqual(fs.readdirSync(MOD.hostDir).filter((f) => f.endsWith('.tmp')), [], '没留下临时文件')
  // 令牌只在内存里：哪个文件里都没有；口令只在 dashboard.json 里
  const tokens = [c1, c2].map((c) => c.split('=')[1])
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(MOD_HOME)) {
    const body = fs.readFileSync(f, 'utf8')
    for (const tok of tokens) assert.ok(!body.includes(tok), '令牌写进了 ' + f)
    assert.ok(!body.includes(info.code), '用过的口令还在 ' + f)
  }
  // 停掉：文件删了；同一个端口再起一个，旧 cookie 不认（会话不落盘）
  const closed = stopPanel(v)
  assert.equal(fs.existsSync(v.infoFile), false, '停的时候（同步）删掉 dashboard.json')
  await closed
  const v2 = await panel(t, { port: v.port, infoFile: v.infoFile })
  for (const c of [c1, c2]) assert.equal((await req(v2.port, '/api/state', { headers: { cookie: c } })).status, 401)
  assert.deepEqual(logs, [], '正常的时候什么都不说')
  // dashboard.json 写不成：只说一句，不带口令；面板照样能用
  const blocker = path.join(MOD.hostDir, `not-a-dir-${v.port}`)
  w(blocker, 'x')
  const v3 = await panel(t, { infoFile: path.join(blocker, 'dashboard.json'), log: (m) => logs.push(String(m)) })
  assert.equal(logs.length, 1); assert.match(logs[0], /dashboard\.json 没写成/)
  const k3 = new URL(v3.server.link()).searchParams.get('k')
  assert.ok(!logs[0].includes(k3), '日志里没有口令')
  await login(v3, k3)
})

// ─────────────── cli dashboard（真起一个，沙盒里） ───────────────
function cliPanel(t, env, port) {
  const p = spawn(process.execPath, [path.join(root, 'host/cli.mjs'), 'dashboard', '--port', String(port)], { env })
  t.after(() => { try { p.kill() } catch {} })
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('面板没起来：' + out)), 30000)
    p.stdout.on('data', () => { const m = new RegExp(`本地面板：http://127\\.0\\.0\\.1:${port}/\\?k=([A-Za-z0-9_-]{16,64})`).exec(out); if (m) { clearTimeout(to); resolve(m[1]) } })
    p.on('exit', (c) => { clearTimeout(to); reject(new Error('面板退出了 ' + c + ' ' + out)) })
  })
  return { p, ready, out: () => out }
}
function cliOnce(env, args, ms = 60_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'host/cli.mjs'), ...args], { env })
    let out = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
    const to = setTimeout(() => p.kill(), ms)
    p.on('exit', (code) => { clearTimeout(to); resolve({ code, out }) })
  })
}
const count = (hay, needle) => hay.split(needle).length - 1

test('cli dashboard: prints the one-time link only once to its own terminal; a second run while it is open prints a fresh link to the same panel (no second panel); codes and tokens appear nowhere else', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-dashgate-cli-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const s = seed(home)
  const port = await freePort()
  const a = cliPanel(t, s.env, port)
  const code1 = await a.ready
  assert.equal(count(a.out(), code1), 1, '口令只在打印的那个链接里出现一次'); assert.equal(count(a.out(), '?k='), 1)
  assert.match(a.out(), /10 分钟内有效、只能用一次/); assert.match(a.out(), /再跑一次 node host\/cli\.mjs dashboard/)
  assert.match(a.out(), /cookie 不分端口/); assert.match(a.out(), /12 小时、2 小时没打开就作废/); assert.match(a.out(), /单独的浏览器个人资料/)
  assert.equal(WT_LINK.exec(a.out())?.[0], `http://127.0.0.1:${port}/?k=${code1}`, 'Windows Terminal 里点开的就是整条链接')
  const infoFile = path.join(s.hostDir, 'dashboard.json')
  assert.equal(readInfo(infoFile)?.code, code1, 'dashboard.json 里就是它')
  const r1 = await req(port, '/?k=' + code1, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r1.status, 303); const cookie1 = cookieOf(r1); assert.ok(cookie1)
  assert.equal((await req(port, '/api/state', { headers: { cookie: cookie1 } })).status, 200)
  const code2 = await until(() => { const c = readInfo(infoFile)?.code; return c && c !== code1 ? c : null }, 3000, '兑换后没换口令')
  // 第二个浏览器：面板开着时再跑一次 cli dashboard → 请开着的面板发一个新口令，不起第二个面板
  const b = await cliOnce(s.env, ['dashboard', '--port', String(port)])
  assert.equal(b.code, 0, b.out)
  assert.match(b.out, /本地面板已经开着/); assert.match(b.out, /新的链接/); assert.doesNotMatch(b.out, /本地面板：|没发新口令/, '没起第二个；面板发了新的')
  const m = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?k=([A-Za-z0-9_-]{16,64})`).exec(b.out)
  assert.ok(m, b.out); assert.ok(![code1, code2].includes(m[1]), '面板为这一次新发的，不是上次的'); assert.equal(count(b.out, '?k='), 1)
  assert.equal(readInfo(infoFile)?.code, m[1], '就是面板现在写在 dashboard.json 里的'); assert.match(readInfo(infoFile)?.mintFor ?? '', /^[0-9a-f]{32}$/)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'dashboard.want')), false, '条子收走了')
  assert.equal(WT_LINK.exec(b.out)?.[0], `http://127.0.0.1:${port}/?k=${m[1]}`, 'Windows Terminal 里点开的就是整条链接')
  // 两个浏览器的链接先都拿好、再打开（审查时的复现）：第二次再跑拿到的又是一个新的，两个都能用
  const b2 = await cliOnce(s.env, ['dashboard', '--port', String(port)])
  assert.equal(b2.code, 0, b2.out); assert.match(b2.out, /新的链接/)
  const m2 = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?k=([A-Za-z0-9_-]{16,64})`).exec(b2.out)
  assert.ok(m2, b2.out); assert.ok(![code1, code2, m[1]].includes(m2[1]), '第二次再跑又是新的')
  assert.equal((await req(port, '/?k=' + code1)).headers['set-cookie'], undefined, '旧链接用过了')
  const r2 = await req(port, '/?k=' + m[1], { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r2.status, 303); const cookie2 = cookieOf(r2); assert.ok(cookie2, '新链接能用')
  assert.equal((await req(port, '/', { headers: { cookie: cookie2 } })).status, 200)
  const rB = await req(port, '/?k=' + m2[1], { headers: { 'sec-fetch-site': 'none' } })
  assert.ok(cookieOf(rB), '另一个浏览器用第二次再跑的链接：也换得到')
  assert.equal((await req(port, '/api/state', { headers: { cookie: cookieOf(rB) } })).status, 200)
  // 面板为上一个浏览器换的 code2 没被拿走：还在 10 分钟里，照样能用（没过期的口令都认）
  assert.ok(cookieOf(await req(port, '/?k=' + code2)), 'code2 照样能用')
  // 别的端口也一样：指给开着的那个
  const c = await cliOnce(s.env, ['dashboard', '--port', String(port + 1)])
  assert.equal(c.code, 0, c.out); assert.match(c.out, new RegExp(`在 ${port} 端口，没换成 ${port + 1}`)); assert.match(c.out, new RegExp(`127\\.0\\.0\\.1:${port}/\\?k=`))
  // 面板自己的输出里：除了一开始那个链接，没有别的口令、没有令牌
  await sleep(300)
  const outA = a.out()
  assert.equal(count(outA, '?k='), 1); assert.ok(!outA.includes(code2)); assert.ok(!outA.includes(m[1])); assert.ok(!outA.includes(m2[1]))
  for (const ck of [cookie1, cookie2]) { const tok = ck.split('=')[1]; assert.ok(!outA.includes(tok) && !b.out.includes(tok) && !c.out.includes(tok), '令牌不出现在任何输出里') }
  // 文件里：令牌哪儿都没有；用过的口令哪儿都没有（只有 dashboard.json 里现在那一个）
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(home)) {
    const body = fs.readFileSync(f, 'utf8')
    for (const x of [code1, code2, m[1], m2[1], cookie1.split('=')[1], cookie2.split('=')[1]]) assert.ok(!body.includes(x), '写进了 ' + f)
  }
  // 面板被硬关掉（dashboard.json 留下了、进程没了）：再跑一次就起一个新的，旧 cookie 不认
  a.p.kill()
  await until(() => a.p.exitCode !== null || a.p.signalCode !== null, 10_000, '面板没停')
  assert.ok(fs.existsSync(infoFile), '硬关掉的会留下 dashboard.json')
  const n = cliPanel(t, s.env, port)
  const code3 = await n.ready
  assert.ok(![code1, code2].includes(code3))
  assert.equal((await req(port, '/api/state', { headers: { cookie: cookie2 } })).status, 401, '会话只在原来那个进程的内存里')
  assert.equal((await req(port, '/?k=' + code2)).headers['set-cookie'], undefined, '上一个面板的口令不认')
  assert.ok(cookieOf(await req(port, '/?k=' + code3)))
})

// ─────────────── 第二轮审查之后（2026-10-26）：登录会过期、口令在 Windows Terminal 里点得开、口令活满 10 分钟、再跑 cli 每次拿新的 ───────────────
test('review fix: a login ends 12 hours after it was made even while in use, and after 2 hours unused (a captured cookie stops working); README and cli say cookies are shared across ports', () => {
  assert.equal(dash.SESSION_MAX_AGE, 12 * 3600_000); assert.equal(dash.SESSION_IDLE, 2 * 3600_000)
  const H = 3600_000, ck = (sid) => `whale_dash=${sid}`
  let now = 5_000_000
  const s = dash.createSessions({ now: () => now })
  const a = s.add()
  // 一直在用（页面每 20 秒刷新）：12 小时内都认，满 12 小时就不认了
  for (let h = 1; h < 12; h += 1) { now += H; assert.equal(s.has(ck(a)), true, `${h} 小时`) }
  now += H - 1; assert.equal(s.has(ck(a)), true, '差 1 毫秒到 12 小时')
  now += 1; assert.equal(s.has(ck(a)), false, '满 12 小时：用着也作废')
  now += 1; assert.equal(s.has(ck(a)), false, '作废了就不回来')
  // 2 小时没用过
  const b = s.add()
  now += 2 * H - 1; assert.equal(s.has(ck(b)), true, '差 1 毫秒到 2 小时')
  now += 2 * H - 1; assert.equal(s.has(ck(b)), true, '用过一次又从头算')
  now += 2 * H; assert.equal(s.has(ck(b)), false, '2 小时没用过')
  // 一个过期了不连累别的
  const c = s.add(); now += H; const d = s.add(); now += H + 1
  assert.equal(s.has(ck(c)), false); assert.equal(s.has(ck(d)), true)
  // 说明里写清楚：cookie 不分端口、登录多久作废、Ctrl+C 全部作废
  const row = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n').find((l) => l.startsWith('| 一页看全（本地面板'))
  assert.ok(row); assert.match(row, /cookie 不分端口/); assert.match(row, /12 小时、2 小时没打开就作废/); assert.match(row, /所有登录马上作废/); assert.match(row, /单独的浏览器个人资料/)
  assert.match(dash.LOCKED_TEXT, /登录过期了/)
})

test('review fix (server): an expired login gets only the locked answer — the 20-second refresh does not stretch it past the limit, and an idle one ends too', async (t) => {
  const v = await panel(t, { sessionIdle: 1500, sessionMaxAge: 3000 })
  const cookie = await login(v)
  const t0 = Date.now()
  while (Date.now() - t0 < 2200) { assert.equal((await req(v.port, '/api/state', { headers: { cookie } })).status, 200, '用着、还没到点'); await sleep(200) }
  await sleep(Math.max(0, 3300 - (Date.now() - t0)))
  const late = await req(v.port, '/api/state', { headers: { cookie } })
  assert.equal(late.status, 401, '到点了：一直在刷新也不认'); assert.deepEqual(JSON.parse(late.body), { error: 'locked', message: dash.LOCKED_TEXT }); noData(late.body, '过期的登录')
  const page = await req(v.port, '/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  assert.equal(page.status, 401); assert.match(page.body, /node host\/cli\.mjs dashboard/); noData(page.body, '过期的登录：页面')
  // 闲着
  const c2 = await login(v)
  assert.equal((await req(v.port, '/api/state', { headers: { cookie: c2 } })).status, 200)
  await sleep(1900)
  const idle = await req(v.port, '/api/state', { headers: { cookie: c2 } })
  assert.equal(idle.status, 401, '闲了 1.5 秒以上'); noData(idle.body, '闲着过期的登录')
})

test('review fix: every code survives a ctrl+click in Windows Terminal — 32 hex characters, never ending in "-"', async (t) => {
  let now = 1_000_000
  const c = dash.createCodes({ now: () => now })
  for (let i = 0; i < 4000; i += 1) {
    const { code } = c.current()
    assert.match(code, /^[0-9a-f]{32}$/)
    const link = `http://127.0.0.1:8765/?k=${code}`
    assert.equal(WT_LINK.exec(`本地面板：${link}\n  用浏览器打开这个链接`)?.[0], link, '启动时打印的那行')
    assert.equal(WT_LINK.exec(`新的链接（9 分钟内有效、只能用一次）：\n  ${link}`)?.[0], link, '再跑一次打印的那行')
    now += 1000; c.rotate()
  }
  const v = await panel(t)
  assert.equal(WT_LINK.exec(v.server.link())?.[0], v.server.link())
  assert.match(v.info().code, /^[0-9a-f]{32}$/)
})

test('review fix: a code lives its full 10 minutes — the one a second cli prints is not dropped at the second rotation; at most 8 live codes', () => {
  const M = 60_000
  let now = 0
  const changes = []
  const c = dash.createCodes({ now: () => now, onChange: (x) => changes.push(x) })
  now = 4.9 * M
  assert.equal(c.redeem(c.current().code), true)            // 第一个浏览器在 4:54 用了启动时的链接
  const b = c.current()                                        // 再跑 cli 读到它：dashboard.json 写的 codeExpiresAt = b.exp（14:54）
  assert.equal(b.exp, 4.9 * M + 10 * M); assert.equal(changes.at(-1), b)
  now = 5 * M; c.rotate()
  now = 10 * M; c.rotate()
  now = b.exp - 1
  assert.equal(c.redeem(b.code), true, '14:53.999 还认（以前 10:00 那次换口令就把它挤掉了）')
  const d = c.current()
  now = d.exp; assert.equal(c.redeem(d.code), false, '满 10 分钟就不认')
  // 没过期的最多认 8 个：多了扔最早的
  now = 100 * M
  const made = []
  for (let i = 0; i < 9; i += 1) { c.rotate(); made.push(c.current().code); now += 1 }
  assert.equal(c.redeem(made[0]), false, '第 9 个把最早的挤掉了')
  for (const k of made.slice(1)) assert.equal(c.redeem(k), true, k)
})

test('review fix (server): the fresh code written after a redeem still works after two rotations, up to the codeExpiresAt it promised', async (t) => {
  const TTL = 6000
  const t0 = Date.now()
  const v = await panel(t, { codeTtl: TTL })              // 3 秒、6 秒各换一次口令
  const first = v.info().code
  await sleep(Math.max(0, 1500 - (Date.now() - t0)))
  assert.equal(v.info().code, first, '还没到第一次换口令')
  await login(v, first)
  const b = await until(() => { const j = v.info(); return j?.code && j.code !== first ? j : null }, 3000, '兑换后没换口令')
  const seen = new Set([first, b.code])
  await until(() => { const k = v.info()?.code; if (k) seen.add(k); return seen.size >= 4 }, 15_000, '没等到两次换口令')
  const left = Date.parse(b.codeExpiresAt) - Date.now()
  assert.ok(left > 200, `机器太慢，只剩 ${left} 毫秒，测不出来`)
  assert.ok(cookieOf(await req(v.port, '/?k=' + b.code, { headers: { 'sec-fetch-site': 'none' } })), `还剩 ${left} 毫秒的口令被扔掉了`)
})

test('review fix: asking the open panel for a link mints a new code every time (two browsers never share one); stale, bad or unreadable notes are dropped without minting', async (t) => {
  const v = await panel(t)
  const want = dash.wantFileOf(v.infoFile)
  assert.equal(want, v.infoFile.replace(/\.json$/, '.want')); assert.equal(dash.wantFileOf(dash.DASH_INFO_FILE), path.join(path.dirname(dash.DASH_INFO_FILE), 'dashboard.want'))
  const live = v.info(), start = live.code
  const one = await dash.requestCode(live, { file: v.infoFile })
  const two = await dash.requestCode(live, { file: v.infoFile })
  assert.ok(one && two, '面板发了')
  assert.ok(one.code !== start && two.code !== start && one.code !== two.code, '每次都是新的')
  assert.match(one.mintFor, /^[0-9a-f]{32}$/); assert.notEqual(one.mintFor, two.mintFor)
  assert.equal(fs.existsSync(want), false, '条子收走了')
  assert.ok(Date.parse(two.codeExpiresAt) - Date.now() > 9 * 60_000)
  // 两个浏览器各用各的，启动时那个也还认
  for (const k of [one.code, two.code, start]) assert.ok(cookieOf(await req(v.port, '/?k=' + k, { headers: { 'sec-fetch-site': 'none' } })), k)
  const before = v.info().code
  assert.equal(v.info().mintFor, undefined, '后来换的口令不带 mintFor')
  // id 不对的：只删不发
  w(want, { id: 'not-hex' })
  await until(() => !fs.existsSync(want), 3000, '格式不对的条子没删')
  await sleep(300)
  assert.equal(v.info().code, before, '没为它发口令')
  // 读不出来的（可能正在写）：先留着，放了 2 秒还读不出来才删，也不发
  w(want, '{"id": "')
  await sleep(700)
  assert.equal(fs.existsSync(want), true, '读不出来的先留着')
  await until(() => !fs.existsSync(want), 6000, '一直读不出来的没删')
  assert.equal(v.info().code, before, '没为它发口令')
  // 没人理（面板是更新前起的 / 正好关了）：等到点给 null，收回自己的条子
  const lone = path.join(MOD.hostDir, `dashboard-nobody-${v.port}.json`)
  w(lone, live)
  const t1 = Date.now()
  assert.equal(await dash.requestCode(live, { file: lone, timeout: 400 }), null)
  assert.ok(Date.now() - t1 >= 400); assert.equal(fs.existsSync(dash.wantFileOf(lone)), false, '收回了')
  // 上一个面板被硬关掉时留下的条子：新面板起来时扔掉，不为它发口令
  const port2 = await freePort()
  const info2 = path.join(MOD.hostDir, `dashboard-${port2}.json`)
  w(dash.wantFileOf(info2), { id: crypto.randomBytes(16).toString('hex') })
  const v2 = await panel(t, { port: port2, infoFile: info2 })
  assert.equal(fs.existsSync(dash.wantFileOf(info2)), false, '扔掉了'); assert.equal(v2.info().mintFor, undefined, '没为它发口令')
})

test('cli dashboard: when the open panel does not answer (started before this update), it says the link is the current one, not a new one', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-dashgate-old-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const s = seed(home)
  const startedAt = new Date().toISOString()
  // 装成一个开着的旧面板：/health 应答，但不看条子
  const fake = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, app: 'dashboard', startedAt })) })
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const port = fake.address().port
  const code = crypto.randomBytes(16).toString('hex')
  w(path.join(s.hostDir, 'dashboard.json'), { pid: process.pid, port, startedAt, code, codeExpiresAt: new Date(Date.now() + 7.5 * 60_000).toISOString() })
  const r = await cliOnce({ ...s.env, BILI_WHALE_FAKE_CMDLINE_FAIL: '1' }, ['dashboard', '--port', String(port)])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /本地面板已经开着/); assert.match(r.out, /没发新口令/); assert.match(r.out, /和上次打印的一样/); assert.doesNotMatch(r.out, /新的链接/)
  assert.match(r.out, /7 分钟内有效/)
  assert.equal(WT_LINK.exec(r.out)?.[0], `http://127.0.0.1:${port}/?k=${code}`)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'dashboard.want')), false, '没人理的条子收回了')
})
