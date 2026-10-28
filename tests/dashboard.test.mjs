// 本地面板（只读）：宿主停了显示离线；回合 / 发言 / 投稿的「已触发、进行中、成功、失败、不确定」分得清；
// 她日记里写「我发了」不算成功（只认代码记的账本）；不泄露凭据和推送地址；除了 dashboard.json（一次性口令）不改任何文件；只认本机 Host、只接受 GET；
// 她和观众写的字被转义；要用 cli 打印的一次性链接换 cookie 才看得到（门的每条路径在 tests/dashboard-gate.test.mjs）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
// 时区钉在「这会儿正好是中午 12 点左右」的固定偏移（没有夏令时）：下面的素材是「N 小时前」，面板只数本地日期是今天的 ——
// 以前在凌晨 0–3 点跑，「3 小时前」就成了昨天，测试必失败。沙盒复制 process.env，面板子进程也用这个时区
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return localDay(d) }   // 按日历往前一天（「现在减 24 小时」在 25 小时的那天还是今天）
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)) }

/** 一个「过了一天」的沙盒：宿主在线、各种状态都有一条 */
function sandbox(t, { online = true, name = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-dash-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data'), ai = path.join(home, '.bili-ai'), hostDir = path.join(dsh, 'whale-cc'), work = path.join(dsh, 'whale-work')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work }
  delete env.NODE_OPTIONS
  w(env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, self: { mid: '333' }, notify: { type: 'webhook', url: 'https://hook.example/SECRET_WEBHOOK_KEY' }, claude: { timeoutMin: 25 }, ...(name ? { persona: { name } } : {}) })
  w(path.join(ai, 'credentials.json'), { sessdata: 'SECRET_SESSDATA_VALUE', bili_jct: 'SECRET_JCT_VALUE', buvid3: 'x' })
  // 宿主
  const dmId = 'bili-whale-dm-' + crypto.randomUUID(), listenId = 'bili-whale-listen-' + (Date.now() - 1000)
  w(path.join(hostDir, 'daemon.json'), online
    ? { pid: process.pid, startedAt: iso(3600_000), heartbeat: iso(5_000), scheduler: { ok: true, reason: 'ok' }, claude: 'claude', busy: true, running: dmId, queued: 2 }
    : { pid: null, startedAt: iso(7200_000), heartbeat: iso(3600_000), stoppedAt: iso(3500_000), scheduler: { ok: true, reason: 'ok' }, claude: 'claude' })
  w(path.join(hostDir, 'queue.json'), [{ id: dmId, text: '主人私信…', at: iso(60_000) }, { id: listenId, text: '有人找你', at: iso(30_000) }])
  if (online) w(path.join(hostDir, 'running.json'), { pid: process.pid, id: dmId, at: iso(50_000), sessionId: '00000000-0000-4000-8000-000000000001' })
  const day = localDay(Date.now())
  w(path.join(hostDir, 'logs', `${day}.jsonl`), [
    // costUsd 是会话累计（claude 的 total_cost_usd）：同一会话 0.12 → 0.15，第二轮只花了 0.03
    { at: iso(7200_000), id: 'bili-whale-1', ok: true, sessionId: 'sess-a', costUsd: 0.12, ms: 60000, prompt: 'x', result: '今天看了三条，我发了一条动态！' },
    { at: iso(5000_000), id: 'manual-2', ok: false, sessionId: 'sess-a', costUsd: 0.15, ms: 1500000, prompt: 'x', result: '[超时，已终止] …' },
    { at: iso(4000_000), id: 'bili-whale-listen-3', ok: true, sessionId: 'sess-a', costUsd: null, ms: 20000, prompt: 'x', result: '回了一个人' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  w(path.join(hostDir, 'turns-done.json'), [{ id: 'bili-whale-4', at: iso(3000_000) }])
  w(path.join(hostDir, 'daemon.log'), `${iso(3 * 86400_000)} [bili-whale] 监听失败：很久以前的错\n${iso(600_000)} [bili-whale-cc] 回合失败（manual-2）：超时\n${iso(500_000)} [bili-whale] 已投递 wake · 2026\n`)
  w(path.join(ai, 'dm-tick-err.log'), `${iso(400_000)} dm-await 退出码 3：fetch_session_msgs code=-101 SESSDATA=LEAKED_IN_LOG\n`)
  // 发出去的（额度账本）
  w(path.join(ai, 'quota.json'), { log: [
    { at: iso(3600_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '谢谢你喜欢', rid: 'r1', committedAt: iso(3590_000) },
    { at: iso(3 * 3600_000), type: 'dynamic', auto: true, share: false, target: 'dyn:1000000000000000002', note: '今天的动态' },
    { at: iso(30 * 60_000), type: 'comment', auto: true, share: false, target: 'oid:999999004', note: '这条结果不明', rid: 'r2', pending: true },
    { at: iso(60_000), type: 'danmaku', auto: true, share: false, target: 'room:12345', note: '正在发', rid: 'r3', pending: true },
    { at: iso(2 * 86400_000), type: 'comment', auto: true, share: false, target: 'BV:BV1bbbbbbbbb', note: '前天的' },
  ] })
  // 观众记忆：和第一条评论对得上的交流（带她那条回复的编号）+ 一个起坏名字的观众
  w(path.join(ai, 'memory', '5555.json'), { version: 1, uid: '5555', names: [{ name: '<img src=x onerror=alert(1)>', at: iso() }], tombstones: [], entries: [
    { id: 'm1', kind: 'exchange', uid: '5555', at: iso(3590_000), channel: 'comment', visibility: 'public', msgId: '9', herMsgId: '777', thread: '1:1:9', target: { type: 1, oid: '2', bvid: 'BV1xx411c7mD', dyn: null }, text: '<script>alert(1)</script>好看', her: '谢谢你喜欢', status: 'active', by: 'tool' },
    { id: 'm2', kind: 'preference', uid: '5555', at: iso(3500_000), visibility: 'public', evidence: '9', text: '喜欢猫', status: 'active', by: 'her' },
  ] })
  // 视频：等审 / 已投稿 / 投稿结果不确定 / 上传半路崩了
  const review = (id) => path.join(ai, 'review', id)
  w(path.join(ai, 'pending-videos.json'), { items: [{ id: '202610230900-wait', submissionId: 's1', title: '【睡前故事 1】等你审的', seconds: 60, reason: '理由理由理由理由', at: iso(7200_000), snapshot: review('202610230900-wait'), originality: { passed: true, notes: [], scriptSha: 'a' }, hashes: {} }] })
  w(path.join(review('202610230900-wait'), 'submitted.json'), { title: '【睡前故事 1】等你审的', submissionId: 's1', at: iso(7200_000) })
  w(path.join(review('202610220900-done'), 'submitted.json'), { title: '已经投了的', submissionId: 's2', at: iso(86400_000) })
  w(path.join(review('202610220900-done'), 'published.json'), { bvid: 'BV1ccccccccc', existing: false, state: null, submissionId: 's2', at: iso(80000_000) })
  w(path.join(review('202610220930-unc'), 'submitted.json'), { title: '结果不确定的', submissionId: 's3', at: iso(86000_000) })
  w(path.join(review('202610220930-unc'), 'attempts.json'), { unresolved: [{ at: iso(85000_000), submissionId: 's3', title: '结果不确定的', error: 'timeout', kind: 'failed' }], resolved: [] })
  w(path.join(review('202610221000-lock'), 'submitted.json'), { title: '上传崩了的', submissionId: 's4', at: iso(80000_000) })
  w(path.join(review('202610221000-lock'), '.uploading'), { submissionId: 's4', title: '上传崩了的', pid: 999999, at: iso(79000_000), token: 'TOKEN_SHOULD_NOT_SHOW' })
  // 待审回复草稿、风控熔断、看过的（工具留下的封面 / 字幕）
  w(path.join(ai, 'pending-replies.json'), { items: [{ id: 'ab12cd34', at: iso(600_000), oid: '1', type: '1', bvid: 'BV1aaaaaaaaa', root: '9', parent: '10', who: '路人', src: '问了个问题', real: { mid: '6666', name: '路人乙', text: '这期用的什么软件？' }, message: '用的是剪映' }] })
  w(path.join(ai, 'api-ban.json'), { until: Date.now() + 10 * 60_000, why: 'HTTP 412', at: iso(60_000), streak: 1, endpoint: 'reply/add' })
  w(path.join(dsh, 'shots', 'covers', 'BV1ddddddddd.jpg'), 'jpg')
  w(path.join(dsh, 'shots', 'subs', 'BV1ddddddddd-ai-zh.txt'), '一个视频的标题\nUP  BV1ddddddddd  60s\n\n[00:01] 你好')
  // 她的日记：说自己发了（不算数），还夹了一段想注入的 HTML
  w(path.join(work, 'whale-diary.md'), '# 给主人的信\n\n## 信\n今天我发了 3 条动态，还投了一个视频！<script>alert("x")</script>\n')
  return { home, dsh, ai, hostDir, env, dmId, listenId }
}

const runJson = (s) => {
  const r = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'dashboard', '--json'], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout)
}
/** 起一个面板（cli dashboard，沙盒里、随机端口），等它打印出一次性链接 → { p, port, code（链接里的口令）, out() } */
async function startPanel(t, s) {
  const port = 18000 + Math.floor(Math.random() * 20000)
  const p = spawn(process.execPath, [path.join(root, 'host/cli.mjs'), 'dashboard', '--port', String(port)], { env: s.env })
  t.after(() => p.kill())
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  const code = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('面板没起来：' + out)), 30000)
    p.stdout.on('data', () => { const m = new RegExp(`本地面板：http://127\\.0\\.0\\.1:${port}/\\?k=([A-Za-z0-9_-]{16,64})`).exec(out); if (m) { clearTimeout(to); resolve(m[1]) } })
    p.on('exit', (c) => { clearTimeout(to); reject(new Error('面板退出了 ' + c + ' ' + out)) })
  })
  return { p, port, code, out: () => out }
}
/** 所有文件的内容指纹（看面板有没有改任何东西） */
function treeHash(dir) {
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') } }
  walk(dir)
  return out
}

test('dashboard: every kind of status is told apart, and only code-written ledgers count as success (her "我发了" does not)', (t) => {
  const s = sandbox(t)
  const j = runJson(s)
  assert.equal(j.host.state, 'online')
  const turn = (id) => j.turns.items.find((x) => x.id === id)
  assert.equal(turn(s.listenId).status, 'triggered'); assert.equal(turn(s.dmId).status, 'running')
  assert.equal(turn('bili-whale-1').status, 'success'); assert.match(turn('bili-whale-1').said, /我发了/, '她说的照样显示，但只是「她说的」')
  assert.equal(turn('manual-2').status, 'fail'); assert.match(turn('manual-2').note, /超时/)
  assert.equal(turn('bili-whale-4').status, 'unknown', '标了处理过、却没有结果记录')
  const sends = j.sends.items
  assert.deepEqual(sends.map((x) => [x.type, x.status]).sort(), [['comment', 'success'], ['comment', 'uncertain'], ['danmaku', 'running'], ['dynamic', 'success']].sort(), '只有今天账本里的；前天的不算')
  const c = sends.find((x) => x.type === 'comment' && x.status === 'success')
  assert.equal(c.link, 'https://www.bilibili.com/video/av2/#reply777', '从观众记忆里配上她那条回复的链接（按真正发到的视频）'); assert.equal(c.where, 'BV1xx411c7mD', '她标的 BV 换算得上 av 号：照样显示 BV'); assert.equal(c.warn, null)
  assert.equal(sends.find((x) => x.type === 'dynamic').link, 'https://t.bilibili.com/1000000000000000002')
  assert.equal(sends.find((x) => x.status === 'uncertain').link, null, 'oid 不知道评论区类型，不乱拼链接')
  assert.equal(sends.length, 4, '日记里说发了 3 条动态、投了视频 —— 都不算，只认账本')
  const vid = (id) => j.videos.items.find((x) => x.id === id)
  assert.equal(vid('202610230900-wait').status, 'triggered'); assert.match(vid('202610230900-wait').cmd, /videos play/)
  assert.equal(vid('202610220900-done').status, 'success'); assert.equal(vid('202610220900-done').link, 'https://www.bilibili.com/video/BV1ccccccccc/')
  assert.equal(vid('202610220930-unc').status, 'uncertain'); assert.equal(vid('202610221000-lock').status, 'uncertain', '上传锁在、进程不在：结果不确定')
  assert.equal(j.drafts.items.length, 1); assert.equal(j.drafts.items[0].who, '路人乙')
  assert.deepEqual(j.views.items.map((x) => x.bv), ['BV1ddddddddd']); assert.equal(j.views.items[0].title, '一个视频的标题')
  assert.equal(j.usage.costUsd, 0.15, '每轮相减后再加：0.12 + 0.03（以前把累计加起来是 0.27）'); assert.equal(j.usage.costUnknown, 2, '没有费用记录的不当 0 算（一个回合没记费用 + 一个结果不明）')
  assert.equal(turn('bili-whale-1').costUsd, 0.12); assert.equal(turn('manual-2').costUsd, 0.03, '回合列表里是这一轮花的，不是会话累计'); assert.equal(turn('bili-whale-listen-3').costUsd, null)
  assert.ok(j.errors.flags.some((f) => /风控熔断/.test(f)))
  assert.ok(j.errors.items.some((e) => /回合失败/.test(e.text)) && j.errors.items.some((e) => e.from === '收主人私信'))
  assert.ok(!j.errors.items.some((e) => /很久以前/.test(e.text)), '只看 24 小时内')
  assert.equal(j.memory.viewers, 1); assert.equal(j.memory.notes[0].text, '喜欢猫')
})

test('dashboard: a stopped host shows as offline; leftovers are explained', (t) => {
  const s = sandbox(t, { online: false })
  const j = runJson(s)
  assert.equal(j.host.state, 'stopped'); assert.match(j.host.label, /离线/)
  assert.equal(j.turns.items.find((x) => x.id === s.dmId).status, 'triggered', '宿主不在：排着的照样显示，不算进行中')
  w(path.join(s.hostDir, 'daemon.json'), { pid: 999999, startedAt: iso(7200_000), heartbeat: iso(3600_000) })
  assert.equal(runJson(s).host.state, 'crashed')
  fs.rmSync(path.join(s.hostDir, 'daemon.json'))
  assert.equal(runJson(s).host.state, 'never')
  // 今天的回合都没有费用记录：费用是「不知道」，不是 0
  w(path.join(s.hostDir, 'logs', `${localDay(Date.now())}.jsonl`), JSON.stringify({ at: iso(60_000), id: 'bili-whale-9', ok: true, costUsd: null, ms: 1000, prompt: 'x', result: 'ok' }) + '\n')
  const u = runJson(s).usage
  assert.equal(u.costUsd, null); assert.equal(u.costUnknown >= 1, true)
})

test('dashboard: the page is read-only, local-only, escapes her and viewers\' text, and never shows credentials', async (t) => {
  const s = sandbox(t, { name: '测试角色' })   // 标题上的名字来自 persona.name
  const before = treeHash(s.home)
  const { port, code } = await startPanel(t, s)
  const get = (pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })) })
    r.on('error', reject); r.end()
  })
  // 没换 cookie：页面、/api/state 都只有那一句（没有她说的话、没有回合）
  const locked = await get('/')
  assert.equal(locked.status, 401); assert.match(locked.body, /<title>测试角色 · 本地面板<\/title>/); assert.match(locked.body, /node host\/cli\.mjs dashboard/); assert.doesNotMatch(locked.body, /我发了|在线|bili-whale-/)
  const lockedApi = await get('/api/state')
  assert.equal(lockedApi.status, 401); assert.deepEqual(Object.keys(JSON.parse(lockedApi.body)).sort(), ['error', 'message'])
  // 打印的一次性链接 → cookie，303 回不带口令的 /
  const ex = await get('/?k=' + code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(ex.status, 303); assert.equal(ex.headers.location, '/')
  const cookie = /^whale_dash=[^;]+/.exec(ex.headers['set-cookie'][0])[0]
  const page = await get('/', { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.match(page.body, /测试角色 · 本地面板/); assert.match(page.body, /在线/)
  assert.doesNotMatch(page.body, /<script/i, '她的日记、观众的名字里的标签都被转义了')
  assert.doesNotMatch(page.body, /<img src=x/i)
  assert.match(page.body, /&lt;script&gt;/)
  assert.match(page.body, /不算数/, '页面写明她说的不算')
  for (const secret of ['SECRET_SESSDATA_VALUE', 'SECRET_JCT_VALUE', 'SECRET_WEBHOOK_KEY', 'LEAKED_IN_LOG', 'TOKEN_SHOULD_NOT_SHOW']) assert.ok(!page.body.includes(secret), secret)
  assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.equal(page.headers['referrer-policy'], 'no-referrer')
  const api = await get('/api/state', { headers: { cookie } })
  assert.equal(api.status, 200); const j = JSON.parse(api.body)
  for (const secret of ['SECRET_SESSDATA_VALUE', 'SECRET_JCT_VALUE', 'SECRET_WEBHOOK_KEY', 'LEAKED_IN_LOG', 'TOKEN_SHOULD_NOT_SHOW']) assert.ok(!api.body.includes(secret), secret)
  assert.equal(j.host.state, 'online')
  assert.equal((await get('/', { host: 'evil.example:' + port, headers: { cookie } })).status, 421, '别的网页借 DNS 重绑定来读：拒绝（有 cookie 也一样）')
  assert.equal((await get('/api/state', { method: 'POST', headers: { cookie } })).status, 405, '只读')
  assert.equal((await get('/../.bili-ai/credentials.json', { headers: { cookie } })).status, 404)
  assert.equal((await get('/../.bili-ai/credentials.json')).status, 401)
  // 面板只写了自己的 dashboard.json（一次性口令）：别的文件一个没动
  const after = treeHash(s.home)
  const info = path.join('data', 'whale-cc', 'dashboard.json')
  assert.ok(after[info], '写了 dashboard.json'); delete after[info]
  assert.deepEqual(after, before, '面板没改别的任何文件')
})

test('dashboard: one unreadable file only spoils its own block, and is reported instead of looking empty', (t) => {
  const s = sandbox(t)
  w(path.join(s.ai, 'quota.json'), '{坏了')
  w(path.join(s.ai, 'pending-videos.json'), '{坏了')
  w(path.join(s.ai, 'memory', '6666.json'), '{坏了')
  const j = runJson(s)
  assert.equal(j.sends.corrupt, true); assert.ok(j.errors.flags.some((f) => /额度账本/.test(f)))
  assert.ok(j.errors.flags.some((f) => /待审视频队列/.test(f)))
  assert.ok(j.errors.flags.some((f) => /观众记忆文件读不出来/.test(f)))
  assert.equal(j.host.state, 'online', '别的块照常')
  assert.ok(j.turns.items.length > 0)
})

// ─────────────── 对抗审查之后的回归测试 ───────────────
test('dashboard review: a malformed request path does not take the panel down', async (t) => {
  const s = sandbox(t)
  const { port, code } = await startPanel(t, s)
  const raw = (target, extra = '') => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}Connection: close\r\n\r\n`))
    let b = ''; sock.on('data', (d) => (b += d)); sock.on('close', () => resolve(b)); sock.on('error', () => resolve(b))
  })
  for (const target of ['//', '///', '//[', 'http://[', '/?k=%', '/?k=' + '%E0'.repeat(30), '/?%%k=1']) await raw(target)
  const ex = await raw('/?k=' + code)
  assert.match(ex, /^HTTP\/1\.1 303/, '还活着，口令照样能换')
  const cookie = /\r\nset-cookie: (whale_dash=[^;]+)/i.exec(ex)[1]
  assert.match(await raw('/', `Cookie: ${cookie}\r\n`), /^HTTP\/1\.1 200/, '还活着')
  assert.match(await raw('/'), /^HTTP\/1\.1 401/, '没 cookie 的照样挡着')
})

test('dashboard review: comment locations come from where they were really posted; her BV label is checked or marked unverified', (t) => {
  const s = sandbox(t)
  const q = JSON.parse(fs.readFileSync(path.join(s.ai, 'quota.json'), 'utf8'))
  q.log.push({ at: iso(1800_000), type: 'comment', auto: true, share: false, target: 'BV:BV1L9Uoa9EUx', note: '没对上记忆的评论' })
  q.log.push({ at: iso(1700_000), type: 'comment', auto: true, share: false, target: 'BV:BV1aaaaaaaaa', note: '标错视频的回复', committedAt: iso(1700_000) })
  w(path.join(s.ai, 'quota.json'), q)
  const m = JSON.parse(fs.readFileSync(path.join(s.ai, 'memory', '5555.json'), 'utf8'))
  m.entries.push({ id: 'm9', kind: 'exchange', uid: '5555', at: iso(1700_000), channel: 'comment', visibility: 'public', msgId: '19', herMsgId: '888', thread: '1:3:19', target: { type: 1, oid: '3', bvid: 'BV1aaaaaaaaa', dyn: null }, text: '?', her: '标错视频的回复', status: 'active', by: 'tool' })
  w(path.join(s.ai, 'memory', '5555.json'), m)
  const j = runJson(s)
  const lone = j.sends.items.find((x) => x.note === '没对上记忆的评论')
  assert.match(lone.where, /她标的视频，没核对/)
  const wrong = j.sends.items.find((x) => x.note === '标错视频的回复')
  assert.equal(wrong.link, 'https://www.bilibili.com/video/av3/#reply888', '链到真正发到的视频'); assert.match(wrong.warn, /对不上/)
  const d = j.drafts.items[0]
  assert.match(d.where, /av1|BV1aaaaaaaaa/); assert.equal(d.link, 'https://www.bilibili.com/video/av1/')
  assert.match(d.warn ?? '', /对不上/, '草稿里她标的 BV 和 oid 对不上：写出来')
})

test('dashboard review: several replies on one video each get their own reply link and name', (t) => {
  const s = sandbox(t)
  const q = JSON.parse(fs.readFileSync(path.join(s.ai, 'quota.json'), 'utf8'))
  q.log = [
    { at: iso(600_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '回 Alice 的话', committedAt: iso(600_000) },
    { at: iso(540_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '回 Bob 的话', committedAt: iso(540_000) },
    { at: iso(500_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '一条顶层评论', committedAt: iso(500_000) },
    { at: iso(400_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '谢谢', committedAt: iso(400_000) },
    { at: iso(390_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '谢谢', committedAt: iso(390_000) },
  ]
  w(path.join(s.ai, 'quota.json'), q)
  const ex = (uid, name, list) => w(path.join(s.ai, 'memory', `${uid}.json`), { version: 1, uid, names: [{ name, at: iso() }], tombstones: [], entries: list.map(([rpid, at, her]) => ({ id: 'x' + rpid, kind: 'exchange', uid, at, channel: 'comment', visibility: 'public', msgId: 'p' + rpid, herMsgId: rpid, thread: '1:2:1', target: { type: 1, oid: '2', bvid: 'BV1xx411c7mD', dyn: null }, text: '?', her, status: 'active', by: 'tool' })) })
  // Alice 那条交流记下的时间恰好和回 Bob 的那条最近：只有对得上她回的话才不会配错
  ex('7001', 'Alice', [['7001', iso(540_000), '回 Alice 的话'], ['7003', iso(400_000), '谢谢']])
  ex('7002', 'Bob', [['7002', iso(520_000), '回 Bob 的话']])
  const j = runJson(s)
  const row = (n) => j.sends.items.find((x) => x.note === n)
  assert.equal(row('回 Alice 的话').replyTo, 'Alice'); assert.match(row('回 Alice 的话').link, /#reply7001$/)
  assert.equal(row('回 Bob 的话').replyTo, 'Bob'); assert.match(row('回 Bob 的话').link, /#reply7002$/)
  assert.equal(row('一条顶层评论').replyTo, null, '顶层评论没有对得上的记录：不借别人的')
  const thanks = j.sends.items.filter((x) => x.note === '谢谢')
  assert.equal(thanks.filter((x) => x.replyTo).length, 1, '两条一样的「谢谢」只有一条记录：只配给一条')
})

test('dashboard review: unresolved sends from yesterday stay visible after midnight; old ones fall off', (t) => {
  const s = sandbox(t)
  const q = JSON.parse(fs.readFileSync(path.join(s.ai, 'quota.json'), 'utf8'))
  q.log.push({ at: iso(30 * 3600_000), type: 'comment', auto: true, share: false, target: 'oid:9', note: '昨晚结果不明的', pending: true })
  q.log.push({ at: iso(3 * 86400_000), type: 'comment', auto: true, share: false, target: 'oid:9', note: '三天前的', pending: true })
  w(path.join(s.ai, 'quota.json'), q)
  const j = runJson(s)
  assert.equal(j.sends.items.find((x) => x.note === '昨晚结果不明的')?.status, 'uncertain')
  assert.ok(!j.sends.items.some((x) => x.note === '三天前的'))
  assert.ok(j.errors.items.some((e) => /昨晚结果不明|oid:9/.test(e.text) || e.from === '发出去的结果不确定'))
})

test('dashboard review: host and turn states stay honest (pid reuse, stale heartbeat id, stuck turns, yesterday\'s plan)', (t) => {
  // 心跳停了一小时、进程号被别的程序用着：离线
  const a = sandbox(t)
  const dj = JSON.parse(fs.readFileSync(path.join(a.hostDir, 'daemon.json'), 'utf8'))
  w(path.join(a.hostDir, 'daemon.json'), { ...dj, heartbeat: iso(3600_000) })
  assert.equal(runJson(a).host.state, 'crashed')
  // 心跳里的 running 还是刚跑完的上一个：以 running.json 为准
  const b = sandbox(t)
  w(path.join(b.hostDir, 'daemon.json'), { ...JSON.parse(fs.readFileSync(path.join(b.hostDir, 'daemon.json'), 'utf8')), running: 'bili-whale-1' })
  const jb = runJson(b)
  assert.equal(jb.turns.items.find((x) => x.id === b.dmId).status, 'running')
  assert.deepEqual(jb.turns.items.filter((x) => x.id === 'bili-whale-1').map((x) => x.status), ['success'])
  // 宿主离线时卡住的回合：只列一次，按下次启动时真的会怎样说
  for (const [extra, expect] of [[{ stoppedByOwner: true }, /不会重跑/], [{}, /重跑一次/]]) {
    const c = sandbox(t, { online: false })
    w(path.join(c.hostDir, 'running.json'), { pid: 999999, id: c.dmId, at: iso(600_000), sessionId: '00000000-0000-4000-8000-000000000001', ...extra })
    const rows = runJson(c).turns.items.filter((x) => x.id === c.dmId)
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'uncertain'); assert.match(rows[0].note, expect)
  }
  const d = sandbox(t, { online: false })
  w(path.join(d.hostDir, 'running.json'), { pid: 999999, id: d.listenId, at: iso(600_000), sessionId: '00000000-0000-4000-8000-000000000001' })
  assert.match(runJson(d).turns.items.find((x) => x.id === d.listenId).note, /丢掉/)
  // 昨天的「今天不再醒了」不拿来说今天
  w(path.join(d.dsh, 'whale-night.json'), { schema: 2, date: yesterday(), action: 'done', reason: '今天醒来次数已用完', fired: false })
  assert.doesNotMatch(runJson(d).plan.text, /今天不再醒了/)
})

test('dashboard review: a pending video with an old uncertain upload still shows as waiting for review; a huge diary is read by its tail only', (t) => {
  const s = sandbox(t)
  w(path.join(s.ai, 'review', '202610230900-wait', 'attempts.json'), { unresolved: [{ at: iso(86400_000), submissionId: 's0', title: 'x', error: 'timeout', kind: 'failed' }], resolved: [] })
  w(path.join(s.dsh, 'whale-work', 'whale-diary.md'), '很长的一行'.repeat(400_000) + '\n最后一行')
  const j = runJson(s)
  const v = j.videos.items.find((x) => x.id === '202610230900-wait')
  assert.equal(v.status, 'triggered'); assert.ok(v.snapshot); assert.ok(v.notes.some((n) => /不确定/.test(n)))
  assert.ok(j.diary.letter.length < 70_000); assert.match(j.diary.letter, /最后一行/)
})

// ─────────────── 对抗审查（第二轮）之后的回归测试 ───────────────
const stand = (t, sid, ms = 60000) => { const c = spawn(process.execPath, ['-e', `setTimeout(()=>{},${ms})`, '--', '--resume', sid, '--output-format', 'json'], { stdio: 'ignore' }); t.after(() => { try { c.kill() } catch {} }); return c }

test('dashboard review 2: a left-over claude still running is shown as running (host online, or offline past the time limit)', (t) => {
  const sid = '0123abcd-0000-4000-8000-0000000d0b01'
  const a = sandbox(t)
  stand(t, sid)
  w(path.join(a.hostDir, 'daemon.json'), { ...JSON.parse(fs.readFileSync(path.join(a.hostDir, 'daemon.json'), 'utf8')), running: null })
  w(path.join(a.hostDir, 'running.json'), { pid: 999999, id: a.dmId, at: iso(300_000), sessionId: sid })
  const ra = runJson(a).turns.items.find((x) => x.id === a.dmId)
  assert.equal(ra.status, 'running'); assert.match(ra.note, /上一个宿主留下的/)
  const sid2 = '0123abcd-0000-4000-8000-0000000d0b02'
  const b = sandbox(t, { online: false })
  const c = stand(t, sid2)
  w(path.join(b.hostDir, 'running.json'), { pid: c.pid, id: b.dmId, at: iso(40 * 60_000), sessionId: sid2 })
  const rb = runJson(b).turns.items.filter((x) => x.id === b.dmId)
  assert.equal(rb.length, 1); assert.equal(rb[0].status, 'running'); assert.match(rb[0].note, /跑太久了.*不重跑/)
})

test('dashboard review 2: reply records are matched globally by closeness, not first come first served', (t) => {
  const s = sandbox(t)
  const q = JSON.parse(fs.readFileSync(path.join(s.ai, 'quota.json'), 'utf8'))
  q.log = [
    { at: iso(600_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '哈哈哈哈', committedAt: iso(600_000) },
    { at: iso(480_000), type: 'comment', auto: true, share: false, target: 'BV:BV1xx411c7mD', note: '哈哈哈哈', committedAt: iso(480_000) },
  ]
  w(path.join(s.ai, 'quota.json'), q)
  w(path.join(s.ai, 'memory', '7101.json'), { version: 1, uid: '7101', names: [{ name: 'Bob', at: iso() }], tombstones: [], entries: [{ id: 'xb', kind: 'exchange', uid: '7101', at: iso(475_000), channel: 'comment', visibility: 'public', msgId: 'pb', herMsgId: '7777', thread: '1:2:1', target: { type: 1, oid: '2', bvid: 'BV1xx411c7mD', dyn: null }, text: '?', her: '哈哈哈哈', status: 'active', by: 'tool' }] })
  const rows = runJson(s).sends.items.filter((x) => x.note === '哈哈哈哈').sort((a, b) => a.at.localeCompare(b.at))
  assert.equal(rows[0].replyTo, null, '早发的那条（顶层评论）不抢后一条回复的记录'); assert.equal(rows[1].replyTo, 'Bob')
})

test('dashboard review 2: the header counts only today\'s sends; older unresolved ones are mentioned separately', (t) => {
  const s = sandbox(t)
  w(path.join(s.ai, 'quota.json'), { log: [
    { at: iso(3600_000), type: 'comment', auto: true, share: false, target: 'oid:1', note: '今天的' },
    { at: iso(30 * 3600_000), type: 'comment', auto: true, share: false, target: 'oid:1', note: '昨天没了结的', uncertain: true },
  ] })
  const code = `import(${JSON.stringify(pathToFileURL(path.join(root, 'host/dashboard.mjs')).href)}).then((m) => process.stdout.write(m.render(m.collect())))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /今天发出去：1 条；前两天还有 <b class="st-unc">1 条<\/b>没了结/)
})

test('dashboard: a turn\'s cost is shown rounded like the daily total, not as a raw float', (t) => {
  const s = sandbox(t)
  w(path.join(s.hostDir, 'logs', `${localDay(Date.now())}.jsonl`), JSON.stringify({ at: iso(60_000), id: 'bili-whale-dm-x', ok: true, costUsd: 0.14372910000000003, ms: 1000, prompt: 'x', result: 'ok' }) + '\n')
  const code = `import(${JSON.stringify(pathToFileURL(path.join(root, 'host/dashboard.mjs')).href)}).then((m) => process.stdout.write(m.render(m.collect())))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, / · \$0\.1437/)
  assert.match(r.stdout, /<title>bili-whale · 本地面板<\/title>/, '没起名字（persona.name 没写）：标题用 bili-whale')
  assert.doesNotMatch(r.stdout, /0\.143729/)
})

test('dashboard review 2: repeated errors collapse into one row and never push out failed turns; viewer text in log lines is not taken as an error', (t) => {
  const s = sandbox(t)
  w(path.join(s.ai, 'dm-tick-err.log'), Array.from({ length: 120 }, (_, i) => `${iso(i * 20_000)} dm-await 退出码 3：fetch_session_msgs code=-101 账号未登录`).join('\n') + '\n')
  const yday = yesterday()
  w(path.join(s.hostDir, 'logs', `${yday}.jsonl`), JSON.stringify({ at: iso(15 * 3600_000), id: 'bili-whale-77', ok: false, costUsd: null, ms: 1, prompt: 'x', result: '昨晚失败的回合' }) + '\n')
  const word = (i) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26))
  w(path.join(s.hostDir, 'daemon.log'), [
    ...Array.from({ length: 50 }, (_, i) => `${iso(600_000 + i * 60_000)} ✗ 各不相同的错误 ${word(i)}`),   // 50 条各不相同的：合并不掉
    `${iso(500_000)} [bili-whale] 监听命中 1 条（发布失败的小号（回复））→ 已叫醒`,
    `${iso(400_000)} [bili-whale-cc] 回合 bili-whale-9 出队没写成：EPERM`,
    `${iso(300_000)} [bili-whale] 私信积压太多，中间有一段没取到（可能有主人的私信）`,
  ].join('\n') + '\n')
  const e = runJson(s).errors.items
  assert.equal(e.filter((x) => x.from === '收主人私信').length, 1); assert.match(e.find((x) => x.from === '收主人私信').text, /120 次/)
  assert.ok(e.some((x) => x.from === '回合失败' && /昨晚失败的回合/.test(x.text)), '昨晚失败的回合还在')
  assert.ok(e.some((x) => /出队没写成/.test(x.text)) && e.some((x) => /私信积压太多/.test(x.text)))
  assert.ok(!e.some((x) => /监听命中/.test(x.text)), '观众的昵称里带「失败」不算错误')
})

test('dashboard review 2: a send with an unknown result is marked uncertain right away (not "sending" for 10 minutes)', (t) => {
  const s = sandbox(t)
  w(path.join(s.ai, 'quota.json'), { log: [] })
  fs.rmSync(path.join(s.ai, 'api-ban.json'))                                              // 样例里开着的风控熔断：这里要真的发一次
  const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment.mjs'), '--oid', '1', '--bvid', 'BV1234567890', '--root', '9', '--parent', '9', '--message', '谢谢你', '--auto', '--go'],
    { env: { ...s.env, PARENT_MID: '5555', REPLY_CODE: 'garbage', NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/reply-fetch.mjs')).href }, encoding: 'utf8', timeout: 30000 })
  assert.match(r.stdout + r.stderr, /不知道发没发出去/)
  const log = JSON.parse(fs.readFileSync(path.join(s.ai, 'quota.json'), 'utf8')).log
  assert.equal(log.length, 1); assert.equal(log[0].uncertain, true); assert.equal(log[0].pending, undefined)
  assert.equal(runJson(s).sends.items[0].status, 'uncertain')
})
