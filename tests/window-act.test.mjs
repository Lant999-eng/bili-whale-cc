// 小窗里「对她下命令」：跟她说话（cli say → 宿主队列，插队）、叫醒她、启动宿主、审视频 / 频道设定（投稿点两次）。
//   进程里测：winchat（原话、提示、聊天记录的状态）、actArgs（参数白名单）、tidyOut、reviewData（她写的字不抹、看不见的字符提醒）、runCli（假 cli）、
//     liveview / dashboard / 页面里认「小窗」回合的那几处；
//   起一个真的小窗服务（沙盒、随机端口、不开窗口、cli 换成假的 BILI_WHALE_WINDOW_ACT_STUB）：POST /api/act 的每一道门、投稿的确认口令、
//     同时只审一件、window.json 的 busy 和 window --stop [--force]、聊天只推给小窗页面（桌宠拿不到）；
//   cli say / wake --queue-only：退出码、队列里插队的那一条、原话记录。全程不碰真的宿主 / 队列 / B站。
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
// 时区钉在「这会儿是中午前后」（和 window.test 一样）：结果日志按本地日期分文件，半夜跑测试也不跨天
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }

const ZW = String.fromCharCode(0x200b), BOM = String.fromCharCode(0xfeff), RLO = String.fromCharCode(0x202e)
const ESC = String.fromCharCode(27), NUL = String.fromCharCode(0), BEL = String.fromCharCode(7)
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)) }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
async function until(fn, ms = 10_000, why = () => '') {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) assert.fail('等不到：' + why())
    await sleep(100)
  }
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

// ─────────────── 进程里直接测的（先把家指到沙盒，再加载模块） ───────────────
const IP = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-act-ip-'))
process.on('exit', () => { try { fs.rmSync(IP, { recursive: true, force: true }) } catch {} })
Object.assign(process.env, { USERPROFILE: IP, HOME: IP, DSH_HOME: path.join(IP, 'data'), BILI_WHALE_AI_HOME: path.join(IP, 'data', 'whale-work'), BILI_WHALE_CONFIG: path.join(IP, 'data', 'cfg.json') })
const W = await import('../host/window.mjs')
const C = await import('../host/winchat.mjs')
const LV = await import('../host/liveview.mjs')
const DB = await import('../host/dashboard.mjs')
const PL = await import('../host/window-ui/player.mjs')
const REVIEW = await import('../host/review.mjs')
const { moduleInstalled } = await import('../host/modules.mjs')
const tmpDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-act-t-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })); return d }

/** 假 cli：把参数、标准输入、是不是小窗跑的记下来；hold-<命令>-<子命令> 这个文件在就一直等（测「正在投稿」）；输出带终端颜色和一个凭据样子 */
const STUB_SRC = `import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
for await (const d of process.stdin) input += d
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, input, fromWindow: process.env.BILI_WHALE_FROM_WINDOW ?? null }) + '\\n')
const hold = path.join(process.env.STUB_DIR, 'hold-' + args[0] + '-' + (args[1] ?? ''))
for (let i = 0; i < 600 && fs.existsSync(hold); i += 1) await new Promise((r) => setTimeout(r, 100))
console.log('\\x1b[32m假的 cli ' + args.slice(0, 2).join(' ') + '\\x1b[0m SESSDATA=abcdef123456')
process.exitCode = args[0] === 'wake' ? 3 : 0
`
function stubIn(dir) {
  const f = path.join(dir, 'stub-cli.mjs')
  w(f, STUB_SRC)
  return { file: f, log: path.join(dir, 'stub.jsonl'), dir, env: { BILI_WHALE_WINDOW_ACT_STUB: f, STUB_LOG: path.join(dir, 'stub.jsonl'), STUB_DIR: dir } }
}

test('normalizeSay：去 BOM / 控制字符、换行统一、头尾空白；空的、超过 2000 字（按字符数）不行', () => {
  assert.deepEqual(C.normalizeSay(BOM + '  你好\r\n世界\r' + NUL + BEL + '\t！  '), { text: '你好\n世界\n\t！' })
  for (const x of ['', '   ', '\r\n\t', null, undefined, NUL]) assert.ok(C.normalizeSay(x).error, JSON.stringify(x))
  assert.equal(C.normalizeSay('猫'.repeat(2000)).text.length, 2000)
  assert.equal(C.normalizeSay('😀'.repeat(2000)).text, '😀'.repeat(2000), 'emoji 按一个字算')
  assert.match(C.normalizeSay('猫'.repeat(2001)).error, /2001 字/)
})

test('winTurnText：人设在最前、原话夹在两行横线之间、说清楚回在最后那段话里（不走 dm / notify / qq）；回合 id 的样子', () => {
  const p = C.winTurnText('帮我看看\n今天的视频', '你是测试角色。')
  const lines = p.split('\n')
  assert.equal(lines[0], '你是测试角色。')
  assert.match(lines[1], /^【主人·小窗】/)
  assert.equal(lines[2], '————————'); assert.equal(lines[3], '帮我看看'); assert.equal(lines[4], '今天的视频'); assert.equal(lines[5], '————————')
  assert.match(p, /最后那段话/); assert.match(p, /偏好校准/)
  // 公开版没装 QQ 模块：只说别用 dm / notify，不提 qq
  if (moduleInstalled('qq')) assert.match(p, /别用\*\* dm \/ notify \/ qq/)
  else { assert.match(p, /别用\*\* dm \/ notify 回他/); assert.doesNotMatch(p, /qq/i) }
  // 先做事、写日记，最后才回他（小窗只显示这一回合最后那段话：回完再调工具，显示的就成了别的话）
  assert.ok(p.indexOf('偏好校准') < p.indexOf('最后那段话'), '日记写在回他之前'); assert.match(p, /之后别再调用任何工具/)
  assert.ok(!C.winTurnText('x').startsWith('\n'), '没有人设就不留空行')
  const id = C.newWinId(1761456000000)
  assert.match(id, C.WIN_ID_RE); assert.ok(id.startsWith('bili-whale-win-1761456000000-'))
  assert.ok(C.isWinId(id)); assert.ok(!C.isWinId('bili-whale-dm-1')); assert.ok(!C.isWinId(null))
})

test('原话记录：追加在锁里、坏行 / 重复 id / 时间不对的读的时候跳过、按时间排；补了 cancel 的不算；超过 512 KB 只留最后 300 句、不超过 256 KB；太大的文件只读结尾', (t) => {
  const dir = tmpDir(t), f = path.join(dir, 'window-chat.jsonl')
  const id1 = 'bili-whale-win-1761456000000-aaaa', id2 = 'bili-whale-win-1761456001000-bbbb'
  assert.throws(() => C.appendChat({ id: '../x', text: 'x' }, f), /回合 id 不对/)
  C.appendChat({ id: id2, at: '2026-10-26T10:00:05.000Z', text: '第二句' }, f)
  fs.appendFileSync(f, '{坏了\n' + JSON.stringify({ id: 'bili-whale-dm-1', at: iso(), text: 'x' }) + '\n' + JSON.stringify({ id: id1, at: '昨天', text: 'x' }) + '\n'
    + JSON.stringify({ id: id1, at: '2026-10-26T10:00:00.000Z', text: '' }) + '\n')
  C.appendChat({ id: id1, at: '2026-10-26T10:00:00.000Z', text: '第一句' }, f)
  C.appendChat({ id: id2, at: '2026-10-26T10:09:00.000Z', text: '重复的 id' }, f)
  assert.deepEqual(C.readChat(f), [{ id: id1, at: '2026-10-26T10:00:00.000Z', text: '第一句' }, { id: id2, at: '2026-10-26T10:00:05.000Z', text: '第二句' }])
  assert.deepEqual(C.readChat(path.join(dir, 'nope.jsonl')), [])
  // 投不成补的 cancel：那句整个不算（cancel 在前在后都一样）
  const id3 = 'bili-whale-win-1761456002000-cccc'
  C.appendChat({ id: id3, at: '2026-10-26T10:01:00.000Z', text: '没投成的' }, f)
  assert.equal(C.readChat(f).length, 3)
  C.appendChat({ id: id3, cancel: true }, f)
  assert.deepEqual(C.readChat(f).map((x) => x.text), ['第一句', '第二句'])
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').at(-1))).sort(), ['at', 'cancel', 'id'], 'cancel 行不带原话')
  // 先写 400 句小的、凑过 512 KB 的（每句 1.4 KB 多 → 光留 300 句也有 400 多 KB）：再追加一句 → 按 256 KB 留结尾，最后一句是新的
  const big = path.join(dir, 'big.jsonl')
  const line = (i, text) => JSON.stringify({ id: `bili-whale-win-${String(1761456000000 + i)}-0000`, at: new Date(1761456000000 + i * 1000).toISOString(), text })
  fs.writeFileSync(big, Array.from({ length: 400 }, (_, i) => line(i, '字'.repeat(500))).join('\n') + '\n')
  assert.ok(fs.statSync(big).size > 512 * 1024)
  C.appendChat({ id: 'bili-whale-win-1761457000000-ffff', at: '2026-10-26T12:00:00.000Z', text: '新的' }, big)
  let kept = C.readChat(big)
  assert.ok(fs.statSync(big).size <= 256 * 1024, String(fs.statSync(big).size))
  assert.ok(kept.length > 100 && kept.length < 300, String(kept.length)); assert.equal(kept.at(-1).text, '新的')
  assert.equal(kept.at(-2).id, 'bili-whale-win-1761456000399-0000', '留的是结尾那几句')
  // 很多短的：按句数留 300
  fs.writeFileSync(big, Array.from({ length: 6000 }, (_, i) => line(i, '短句')).join('\n') + '\n')
  assert.ok(fs.statSync(big).size > 512 * 1024)
  C.appendChat({ id: 'bili-whale-win-1761457000000-ffff', at: '2026-10-26T12:00:00.000Z', text: '新的' }, big)
  kept = C.readChat(big)
  assert.equal(kept.length, 300); assert.equal(kept.at(-1).text, '新的'); assert.equal(kept[0].id, 'bili-whale-win-1761456005701-0000')
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp') || x.endsWith('.lock')), [])
  // 别处写得超过 2 MB（没经过修剪）：只读最后 2 MB，照样显示结尾那些（以前整个不显示）
  const huge = path.join(dir, 'huge.jsonl')
  fs.writeFileSync(huge, Array.from({ length: 1700 }, (_, i) => line(i, '字'.repeat(500))).join('\n') + '\n')
  assert.ok(fs.statSync(huge).size > 2 * 1024 * 1024)
  const tail = C.readChat(huge)
  assert.ok(tail.length > 1000 && tail.length < 1700, String(tail.length)); assert.equal(tail.at(-1).id, 'bili-whale-win-1761456001699-0000')
})

test('chatView：结果日志里有 → done / failed（带回复、用时）；正在跑 → running；排着 → queued + 前面几个；两分钟以上哪都没有 → lost；三天前的不要', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z')
  const id = (n) => `bili-whale-win-${String(1761480000000 + n)}-000${n}`
  const at = (msAgo) => new Date(now - msAgo).toISOString()
  const entries = [
    { id: id(0), at: at(4 * 86400_000), text: '四天前' },
    { id: id(1), at: at(600_000), text: '做完了的' },
    { id: id(2), at: at(500_000), text: '没做完的' },
    { id: id(3), at: at(60_000), text: '在跑的' },
    { id: id(4), at: at(50_000), text: '排着的' },
    { id: id(5), at: at(30_000), text: '刚投、队列里还没读到' },
    { id: id(6), at: at(300_000), text: '丢了的' },
  ]
  const logs = [{ id: id(1), ok: true, result: '好呀', at: at(500_000), ms: 30_000 }, { id: id(2), ok: false, result: '超时了', at: at(400_000) }, { id: 'bili-whale-dm-1', ok: true, result: 'x' }]
  const v = C.chatView({ entries, queue: [id(3), 'manual-1', id(4)], active: id(3), logs, now })
  assert.deepEqual(v.map((x) => [x.text, x.state, x.ahead]), [['做完了的', 'done', undefined], ['没做完的', 'failed', undefined], ['在跑的', 'running', undefined],
    ['排着的', 'queued', 2], ['刚投、队列里还没读到', 'queued', undefined], ['丢了的', 'lost', undefined]])
  assert.equal(v[0].reply, '好呀'); assert.equal(v[0].ms, 30_000); assert.equal(v[0].replyAt, at(500_000))
  // 没做完的：result 是出错的原因，不当她的回复；挑一行像话的当 error（claude 的原始 JSON 输出跳过）
  assert.equal(v[1].reply, undefined); assert.equal(v[1].error, '超时了')
  const fail = (result) => C.chatView({ entries: [{ id: id(1), at: at(1000), text: 'x' }], logs: [{ id: id(1), ok: false, result }], now })[0]
  assert.equal(fail('{"type":"result","is_error":true}\n  claude 退出码 1：额度用完了  \n[1,2]').error, 'claude 退出码 1：额度用完了')
  assert.equal(fail('{"type":"result"}\n"raw"').error, undefined); assert.equal(fail('').error, undefined); assert.equal(fail(null).state, 'failed')
  assert.equal(fail('长'.repeat(500)).error.length, 160)
  // 宿主补的一行说明（[超时，已终止]）优先，去掉方括号；JSON 的一截（"key": …、"a","b"、逗号 / 冒号开头）不当原因
  assert.equal(fail('她刚写到一半的话\n[超时，已终止]').error, '超时，已终止')
  assert.equal(fail('"type": "result",\n  is_error": true, "result": "额度用完了\nx","y\n, 1\n: x\n真正的原因').error, '真正的原因')
  assert.equal(fail('[' + 'x'.repeat(81) + ']\n原因').error, '原因', '没有汉字的方括号行不算宿主的说明')
  assert.equal(fail('[' + '超'.repeat(81) + ']\n原因').error, '原因', '太长的方括号行也不算')
  assert.equal(fail('[' + '超'.repeat(80) + ']\n原因').error, '超'.repeat(80))
  // claude 最常见的出错：「API Error: 529 {json}」—— 取 { 前面那截，带上 JSON 里的 message
  assert.equal(fail('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').error, 'API Error: 529 Overloaded')
  assert.equal(fail('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}').error, 'API Error: 401')
  assert.equal(fail('超时了 [1/3]').error, '超时了')
  assert.equal(C.chatView({ entries, queue: [id(4)], active: null, logs: [], now }).find((x) => x.id === id(4)).ahead, 0, '没有在跑的、排在第一个：前面没有')
  assert.equal(C.chatView({ entries, now, limit: 2 }).length, 2)
  assert.deepEqual(C.chatView({}), [])
  assert.equal(C.chatView({ entries: [{ id: id(1), at: at(1000), text: 'x' }], logs: [{ id: id(1), ok: true, result: '长'.repeat(3000) }], now })[0].reply.length, 2000)
})

test('actArgs：只认白名单里的事；视频 id 要在等审的单子里；理由 / 意见不能空、不能太长、不能用「-」开头；指纹要十六进制', () => {
  const ids = { videoIds: ['202610260900-cat'] }
  assert.deepEqual(W.actArgs('say', { text: ' 你好\r\n世界 ' }), { args: ['say', '--stdin'], input: '你好\n世界' })
  assert.ok(W.actArgs('say', { text: '  ' }).error); assert.ok(W.actArgs('say', { text: '猫'.repeat(2001) }).error); assert.ok(W.actArgs('say', {}).error)
  assert.deepEqual(W.actArgs('wake', { extra: '--skip' }), { args: ['wake', '--queue-only'] }, '多给的字段不进参数')
  assert.deepEqual(W.actArgs('start', {}), { args: ['start'] })
  assert.deepEqual(W.actArgs('play', { id: '202610260900-cat' }, ids), { args: ['videos', 'play', '202610260900-cat'] })
  assert.deepEqual(W.actArgs('approve', { id: '202610260900-cat' }, ids), { args: ['videos', 'approve', '202610260900-cat'] })
  for (const bad of ['202610260900-dog', '../x', '--force', 'a b', '', null, ['202610260900-cat']]) {
    assert.ok(W.actArgs('approve', { id: bad }, ids).error, String(bad)); assert.ok(W.actArgs('play', { id: bad }, ids).error, String(bad))
  }
  assert.ok(W.actArgs('approve', { id: '202610260900-cat' }).error, '没给等审的单子就一条都不认')
  assert.deepEqual(W.actArgs('reject', { id: '202610260900-cat', text: ' 节奏太慢\r\n再剪短点 ' }, ids), { args: ['videos', 'reject', '202610260900-cat', '节奏太慢\n再剪短点'] })
  for (const text of ['', '   ', '-force', '--force', '猫'.repeat(201), undefined]) assert.ok(W.actArgs('reject', { id: '202610260900-cat', text }, ids).error, String(text))
  assert.ok(W.actArgs('reject', { id: '202610260900-cat', text: '猫'.repeat(200) }, ids).args, '理由最多 200 字（core 只存前 200 字）')
  // core 是 .slice(0, 200)，按 UTF-16 截：表情算两个
  const SMILE = String.fromCodePoint(0x1f600)
  assert.match(W.actArgs('reject', { id: '202610260900-cat', text: SMILE.repeat(101) }, ids).error, /表情算两个/)
  assert.ok(W.actArgs('reject', { id: '202610260900-cat', text: SMILE.repeat(100) }, ids).args)
  assert.ok(W.actArgs('channel-reject', { text: SMILE.repeat(2000) }).args, '频道意见整段写进文件，不截：按字符数算')
  assert.ok(W.actArgs('reject', { id: '202610260900-dog', text: '好' }, ids).error)
  assert.deepEqual(W.actArgs('channel-approve', { sha: 'ABCDEF0123456789' }), { args: ['channel', 'approve', 'abcdef0123456789'] })
  for (const sha of ['abc', 'g'.repeat(16), 'a'.repeat(65), '--force', '', null]) assert.ok(W.actArgs('channel-approve', { sha }).error, String(sha))
  assert.deepEqual(W.actArgs('channel-reject', { text: '定位再具体一点' }), { args: ['channel', 'reject', '定位再具体一点'] })
  assert.ok(W.actArgs('channel-reject', { text: '猫'.repeat(2001) }).error); assert.ok(W.actArgs('channel-reject', { text: '-x' }).error)
  for (const act of ['', 'nope', '__proto__', 'constructor', 'toString', 'videos', undefined]) assert.equal(W.actArgs(act, {}).error, '不认识的操作', String(act))
  assert.ok(W.actArgs('say', null).error); assert.ok(W.actArgs('say', 'text').error); assert.ok(W.actArgs('say', { text: ['你好'] }).error, '话要是字符串')
  assert.ok(W.actArgs('reject', { id: '202610260900-cat', text: ['不', '要'] }, ids).error); assert.ok(W.actArgs('channel-approve', { sha: ['abcdef0123456789'] }).error)
  assert.deepEqual(Object.keys(W.ACTS).sort(), ['approve', 'channel-approve', 'channel-reject', 'play', 'reject', 'say', 'start', 'wake'])
  assert.deepEqual(Object.entries(W.ACTS).filter(([, v]) => v.review).map(([k]) => k).sort(), ['approve', 'channel-approve', 'channel-reject', 'reject'])
})

test('tidyOut：去掉终端颜色和控制字符、抹掉凭据样子、太长留头尾；queuedCounts 分开数私信和小窗', () => {
  const out = W.tidyOut(ESC + '[32m✓ 好了' + ESC + '[0m\r\nSESSDATA=abcdef123456 ' + BEL + 'bili_jct=0123456789abcdef')
  assert.ok(!out.includes(ESC) && !out.includes(BEL) && !out.includes('\r'), JSON.stringify(out))
  assert.match(out, /^✓ 好了\nSESSDATA=\*\*\* +bili_jct=\*\*\*$/)
  const long = W.tidyOut('头' + 'x'.repeat(20_000) + '尾')
  assert.ok(long.startsWith('头') && long.endsWith('尾') && long.includes('（中间省略）') && long.length < 6100)
  // QQ 回合也是主人的回合，算进「私信」那一格；公开版没装 QQ 模块，bili-whale-qq-… 只是一条不认识的：算进总数、不算私信
  assert.deepEqual(W.queuedCounts(['bili-whale-dm-1', 'bili-whale-qq-2', 'bili-whale-win-1761456000000-aaaa', 'manual-1', 3]), { dm: moduleInstalled('qq') ? 2 : 1, win: 1, total: 4 })
  assert.deepEqual(W.queuedCounts(null), { dm: 0, win: 0, total: 0 })
})

test('桌宠的事件不带标了 private 的原话（她回主人的话、主人回合里的文件名），别的照旧；审核面板的上传规则和 studio.py 的常量一样', () => {
  const said = { seq: 3, kind: 'said', turn: 'bili-whale-win-1761456000000-aaaa', cap: '她说', text: '回主人的话', private: true }
  assert.deepEqual(W.petEvent(said), { seq: 3, kind: 'said', turn: 'bili-whale-win-1761456000000-aaaa', cap: '她说', private: true })
  assert.equal(said.text, '回主人的话', '不改原来那份（小窗页面还要用）')
  const pub = { seq: 4, kind: 'said', cap: '她说', text: '公开的话' }
  assert.equal(W.petEvent(pub), pub); assert.equal(W.petEvent(null), null)
  const R = { ...REVIEW }
  const py = fs.readFileSync(path.join(root, 'studio', 'studio.py'), 'utf8')
  const [, tagMax, tagLen, descMax] = /^TAG_MAX, TAG_LEN, DESC_MAX, TITLE_MAX = (\d+), (\d+), (\d+), \d+$/m.exec(py) ?? []
  assert.equal(Number(tagLen), R.TAG_LEN); assert.equal(Number(descMax), R.DESC_MAX); assert.equal(Number(tagMax), R.TAG_MAX)
  assert.equal(R.TAG_SHOW, Number(tagMax) - 1, '审核面板、cli 只显示她的 TAG_MAX - 1 个（studio.py：tags[:TAG_MAX - 1] + [AI生成]）')
  assert.match(py, /tags = tags\[:TAG_MAX - 1\] \+ \[AI_TAG\]/)
  assert.equal(/^AI_TAG = "(.*)"$/m.exec(py)?.[1], R.AI_TAG); assert.equal(/^AI_NOTE = "(.*)"$/m.exec(py)?.[1], R.AI_NOTE)
})

test('cli window 的 --force 只能和 --stop 一起', () => {
  const none = { stop: false, noOpen: false, top: false, pet: null, port: null, withPet: false, out: null, force: false }
  assert.deepEqual(W.parseWindowArgs(['--stop', '--force']), { ...none, stop: true, force: true })
  assert.deepEqual(W.parseWindowArgs(['--force', '--stop']), { ...none, stop: true, force: true })
  for (const bad of [['--force'], ['--force', '--no-open'], ['--with-pet', '--force']]) assert.ok(W.parseWindowArgs(bad).error, bad.join(' '))
  assert.match(W.WINDOW_USAGE, /\[--stop \[--force\]\]/)
})

test('reviewData：她写的简介 / 设定不抹凭据样子（主人要看到会发出去的那一份），去掉的看不见字符要提醒；标签照上传的规则整理；指纹不对就不给', () => {
  const ai = path.join(IP, '.bili-ai')
  const id = '202610260900-cat'
  w(path.join(ai, 'pending-videos.json'), { items: [
    { id, submissionId: 's1', title: '猫坐' + ZW + '地铁', seconds: 72, reason: '理由' + BEL, at: iso(60_000), outfits: { 第1段: '白裙' }, originality: { passed: true, flags: ['和参考 1 很像'], notes: [], references: [{ name: '讲义 A' }] } },
    { id: '../evil', title: '坏 id' },
  ] })
  w(path.join(ai, 'review', id, 'script.json'), { tags: ['猫', '#猫', 'AI生成', '地铁，', 'x'.repeat(21)], desc: '简介 SESSDATA=abc123' + ZW + ' 结尾', tid: 21 })
  const text = '# 频道设定\n定位：' + RLO + '讲猫\n'
  w(path.join(ai, 'channel-submitted.json'), { text, sha: sha256(text), at: iso(30_000) })
  const d = W.reviewData()
  assert.equal(d.videos.length, 1, '坏 id 不列')
  const v = d.videos[0]
  assert.equal(v.id, id); assert.equal(v.title, '猫坐地铁'); assert.equal(v.seconds, 72); assert.equal(v.reason, '理由')
  assert.deepEqual(v.outfits, [['第1段', '白裙']]); assert.equal(v.checked, true); assert.deepEqual(v.flags, ['和参考 1 很像']); assert.deepEqual(v.references, ['讲义 A'])
  assert.deepEqual(v.meta.tags, ['猫', '地铁']); assert.equal(v.meta.desc, '简介 SESSDATA=abc123 结尾', '不抹：这是会发出去的字'); assert.equal(v.meta.invisible, true)
  assert.equal(v.hasFile, false)
  assert.equal(v.sub, 's1', '这一轮交审的编号：小窗的按钮带着它'); assert.equal(v.titleInvisible, true); assert.equal(v.meta.tagsInvisible, false); assert.equal(v.meta.descCut, false)
  // 看不见的字认得更全：标签字符、变体选择符（表情后面的不算）、韩文填充符、C1 控制字符；标签里的也提醒
  const TAG = String.fromCodePoint(0xe0041), WARN = String.fromCodePoint(0x26a0, 0xfe0f), VS = String.fromCharCode(0xfe0f), FILL = String.fromCharCode(0x3164), C1 = String.fromCharCode(0x85)
  const meta = (sc) => { w(path.join(ai, 'review', id, 'script.json'), { tid: 21, ...sc }); return W.reviewData().videos[0].meta }
  assert.equal(meta({ desc: '注意' + WARN + ' 普通的字 ⭐' }).invisible, false, '表情后面的 FE0F 是正常的')
  for (const bad of ['a' + TAG + 'b', 'a' + VS + 'b', FILL + '空', 'a' + C1 + 'b']) {
    const m = meta({ desc: bad })
    assert.equal(m.invisible, true, JSON.stringify(bad)); assert.ok(![TAG, VS, FILL, C1].some((x) => m.desc.includes(x)), JSON.stringify(m.desc))
  }
  assert.equal(meta({ desc: 'x', tags: ['猫' + TAG] }).tagsInvisible, true)
  // Unicode「默认不显示」的那一大类也认：保留的标签区、高棉文的两个、不可见运算符的空位、FFF0 那段；表情里的 ZWJ 不算，落单的算
  const cp = (...x) => String.fromCodePoint(...x)
  for (const [bad, shown] of [...[0xe0080, 0x17b4, 0x2065, 0xfff0, 0x200d].map((x) => ['a' + cp(x) + 'b', 'ab']), [cp(0x1f469, 0x200d) + 'x', cp(0x1f469) + 'x']]) {
    const m = meta({ desc: bad })
    assert.equal(m.invisible, true, JSON.stringify(bad)); assert.equal(m.desc, shown, JSON.stringify(bad))
  }
  for (const ok of [cp(0x1f469, 0x200d, 0x1f4bb), cp(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb), cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), '1' + cp(0xfe0f, 0x20e3)]) {
    const m = meta({ desc: '看' + ok })
    assert.equal(m.invisible, false, JSON.stringify(ok)); assert.equal(m.desc, '看' + ok, '表情原样显示')
  }
  // 头尾空白照 Python 的 strip()：U+FEFF 它不去（会原样发出去 → 提醒），\x1c 它去（不提醒）
  assert.equal(meta({ desc: BOM + '简介' }).invisible, true)
  assert.equal(meta({ desc: '简介' + String.fromCharCode(0x1c) }).invisible, false)
  // 标签写成一个字符串：照 studio.py 按逗号 / 顿号 / 空白拆（Python 的空白：U+FEFF 不算，\x1c 算）；最多显示 9 个（再加 AI生成）
  assert.deepEqual(meta({ desc: 'x', tags: '猫,地铁、 学习  #猫' }).tags, ['猫', '地铁', '学习'])
  const feff = meta({ desc: 'x', tags: '猫' + BOM + '地铁' })
  assert.deepEqual(feff.tags, ['猫地铁'], '一个标签，中间夹着 U+FEFF（显示时去掉）'); assert.equal(feff.tagsInvisible, true)
  const fs1c = meta({ desc: 'x', tags: '猫' + String.fromCharCode(0x1c) + '地铁' })
  assert.deepEqual(fs1c.tags, ['猫', '地铁']); assert.equal(fs1c.tagsInvisible, false)
  assert.equal(meta({ desc: 'x', tags: Array.from({ length: 11 }, (_, i) => 't' + i) }).tags.length, 9)
  // 简介太长：B站 只收前 room 个字（后面留给 AI 创作声明）—— 显示的就是会发出去的那一截，另外说后面几个字不会发
  const room = 2000 - [...'本视频由 AI 自主创作：选题、文案、配音（语音合成）与画面均由 AI 生成，人类审核后发布。'].length - 2
  const long = meta({ desc: '长'.repeat(7000) })
  assert.equal(long.descCut, false); assert.equal(long.descLen, 7000); assert.equal([...long.desc].length, room); assert.equal(long.descDropped, 7000 - room)
  const fits = meta({ desc: '长'.repeat(room) })
  assert.equal(fits.descDropped, 0); assert.equal([...fits.desc].length, room)
  // 截完再 rstrip()：用 Python 去、JS 的 trim() 不去的 \x1c 垫着（不然显示前的 trim() 也会去掉，测不出来）
  const cut = meta({ desc: '长'.repeat(room - 1) + String.fromCharCode(0x1c).repeat(5) + '尾' })
  assert.equal(cut.desc, '长'.repeat(room - 1)); assert.equal(cut.invisible, false)
  assert.equal(d.channel.kind, 'submitted'); assert.equal(d.channel.state, 'waiting'); assert.equal(d.channel.sha, sha256(text))
  assert.equal(d.channel.invisible, true); assert.ok(!d.channel.text.includes(RLO)); assert.match(d.channel.text, /讲猫/)
  w(path.join(ai, 'channel-submitted.json'), { text, sha: 'NOT-HEX', at: iso() })
  assert.equal(W.reviewData().channel.sha, null)
  fs.rmSync(path.join(ai, 'channel-submitted.json')); fs.rmSync(path.join(ai, 'pending-videos.json'))
  assert.deepEqual(W.reviewData(), { videos: [], channel: null })
})

test('runCli：参数是数组、话从标准输入进、带着 BILI_WHALE_FROM_WINDOW；超时整个停掉；不开 NO_EDGE 时不认假 cli', { timeout: 60_000 }, async (t) => {
  const dir = tmpDir(t), st = stubIn(dir)
  const env = { ...process.env, BILI_WHALE_WINDOW_NO_EDGE: '1', ...st.env }
  const r = await W.runCli(['say', '--stdin'], { input: '你好 "$(whoami)" & echo x', env })
  assert.equal(r.ok, true); assert.equal(r.code, 0)
  assert.equal(r.out, '假的 cli say --stdin SESSDATA=***')
  assert.deepEqual(readLines(st.log), [{ args: ['say', '--stdin'], input: '你好 "$(whoami)" & echo x', fromWindow: '1' }])
  const r3 = await W.runCli(['wake', '--queue-only'], { env })
  assert.equal(r3.ok, false); assert.equal(r3.code, 3)
  w(path.join(dir, 'hold-videos-approve'), '')
  const slow = await W.runCli(['videos', 'approve', 'x'], { env, ms: 800 })
  assert.equal(slow.ok, false); assert.equal(slow.code, null); assert.match(slow.out, /超过 1 秒还没做完，停掉了/)
  assert.equal(slow.timedOut, true); assert.equal(r.timedOut, false); assert.equal(r3.timedOut, false)
  // 投稿超时才说「结果说不准」（B站 可能已经收到了）；没跑起来（code 也是 null）、别的事超时都不说
  const CAT = '202610260900-cat', A = ['videos', 'approve', CAT]
  assert.match(W.jobOut('approve', A, { out: '上传中…', code: null, timedOut: true }), /^上传中…\n结果说不准：.*videos resolve 202610260900-cat none（没投上）或 <BV号>（投上了）$/)
  assert.equal(W.jobOut('approve', A, { out: '没跑起来：spawn EPERM', code: null, timedOut: false }), '没跑起来：spawn EPERM')
  assert.equal(W.jobOut('reject', ['videos', 'reject', CAT, '慢'], { out: 'x', code: null, timedOut: true }), 'x')
  assert.match(W.jobOut('approve', ['videos', 'approve', '../x'], { out: 'x', timedOut: true }), /videos resolve <视频 id> none/)
  // 不开 NO_EDGE：假 cli 不算数，跑的是真的 cli.mjs（help 只打印用法）
  const env2 = { ...process.env, ...st.env }
  delete env2.BILI_WHALE_WINDOW_NO_EDGE
  const h = await W.runCli(['help'], { env: env2, ms: 30_000 })
  assert.match(h.out, /node host\/cli\.mjs say/); assert.ok(!h.out.includes('假的 cli'))
})

test('认得出「小窗」回合：liveview 的种类 / 主人的 / 状态，dashboard 的种类，页面上的排队那行、聊天状态、审核的数', () => {
  const id = 'bili-whale-win-1761456000000-abcd'
  assert.deepEqual(LV.kindOf(id), { kind: 'win', kindLabel: '你在小窗里找她' })
  assert.equal(LV.isOwnerKind('win'), true)
  assert.deepEqual(DB.kindOf(id), { kind: 'win', kindLabel: '主人在小窗里说' })
  const now = Date.now(), on = { state: 'online' }
  const s1 = LV.stateOf({ now, host: on, queued: { dm: 0, win: 1, total: 1 } })
  assert.equal(s1.state, 'dm_queued'); assert.equal(s1.caption, '收到你的话了，马上回')
  assert.equal(LV.stateOf({ now, host: on, queued: [id] }).caption, '收到你的话了，马上回')
  assert.equal(LV.stateOf({ now, host: on, queued: { dm: 1, win: 1, total: 2 } }).caption, '你的私信到了，马上醒', '私信先说')
  assert.equal(PL.queuedLine({ total: 2, dm: 0, win: 2 }, 'idle'), '还排着 2 个回合（都是你在小窗里说的）')
  assert.equal(PL.queuedLine({ total: 3, dm: 1, win: 1 }, 'idle'), '还排着 3 个回合（1 个是你的私信，1 句是你在小窗里说的）')
  assert.equal(PL.queuedLine([id, 'manual-1'], 'idle'), '还排着 2 个回合（1 句是你在小窗里说的）')
  assert.equal(PL.queuedLine({ total: 1, win: 1 }, 'dm_queued'), '', '只有那一句：状态那行已经说了')
  assert.equal(PL.chatStateText({ state: 'queued', ahead: 2 }), '排着，前面还有 2 个回合')
  assert.equal(PL.chatStateText({ state: 'queued' }), '交给她了，马上轮到')
  assert.equal(PL.chatStateText({ state: 'running' }), '她在回…')
  assert.equal(PL.chatStateText({ state: 'done', reply: '好' }), ''); assert.match(PL.chatStateText({ state: 'done' }), /没留话/)
  assert.match(PL.chatStateText({ state: 'failed' }), /没做完/); assert.match(PL.chatStateText({ state: 'lost' }), /再说一次/)
  assert.equal(PL.chatStateText(null), ''); assert.equal(PL.chatStateText({ state: 'weird' }), '')
  assert.equal(PL.reviewCount({ pendingVideos: 2, channelWaiting: true }), 3)
  assert.equal(PL.reviewCount({ pendingVideos: 0, channelWaiting: false }), 0)
  assert.equal(PL.reviewCount({ pendingVideos: -1 }), 0); assert.equal(PL.reviewCount(null), 0); assert.equal(PL.reviewCount({ channelWaiting: 'yes' }), 0)
  assert.ok(PL.fmtSeconds(72)); assert.equal(PL.fmtSeconds(0), ''); assert.equal(PL.fmtSeconds('x'), '')
  assert.ok(PL.isWinId(id)); assert.ok(!PL.isWinId('bili-whale-dm-1'))
  // 主人起的回合：文件名可能是照主人的原话起的 → 字幕（桌宠也念）只说「在读一个文件」，文件名放进 text、标 private；别的回合照旧
  const f = 'C:/Users/x/.bili-whale/whale-work/主人的秘密计划.md'
  assert.deepEqual(LV.captionFor('Read', { file_path: f }, { owner: true }), { cap: '在读一个文件', glyph: '读', activity: 'read', text: '主人的秘密计划.md', private: true })
  assert.equal(LV.captionFor('Edit', { file_path: f }, { owner: true }).cap, '在改一个文件')
  assert.equal(LV.captionFor('Write', { file_path: f }, { dm: true }).cap, '在写一个文件', '没给 owner 就跟着 dm')
  assert.equal(LV.captionFor('Read', { file_path: 'C:/x/截图.png' }, { owner: true }).cap, '在看一张图')
  assert.equal(LV.captionFor('Read', { file_path: f }, {}).cap, '在读 主人的秘密计划.md', '她自己醒来的回合照旧')
  assert.equal(LV.captionFor('Write', { file_path: 'C:/x/whale-diary.md' }, { owner: true }).cap, '在写日记', '固定说法的照旧')
})

// ─────────────── 真起一个小窗服务（沙盒、随机端口、不开窗口、cli 换成假的） ───────────────
const SID = '5ca1ab1e-1111-4222-8333-444455556666'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-')
const CAT = '202610260900-cat', DOG = '202610260930-dog'
const CHANNEL_TEXT = '# 我的频道设定\n定位：讲猫\n'

function sandbox(t, { daemon = true, review = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-act-'))
  const s = { home, procs: [] }
  t.after(async () => {
    for (const p of s.procs) try { p.kill() } catch {}
    await sleep(300)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const dsh = path.join(home, 'data'), hostDir = path.join(dsh, 'whale-cc'), work = path.join(dsh, 'whale-work'), ai = path.join(home, '.bili-ai')
  const cfgDir = path.join(hostDir, 'claude-config')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: NODE, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: work, BILI_WHALE_WINDOW_NO_EDGE: '1' }
  delete env.NODE_OPTIONS; delete env.BILI_WHALE_WINDOW_PET_STUB; delete env.BILI_WHALE_WINDOW_ACT_STUB
  w(env.BILI_WHALE_CONFIG, { owner: { mid: '222', name: 'Owner' }, claude: { timeoutMin: 25, rotateDays: 7 } })
  if (daemon) w(path.join(hostDir, 'daemon.json'), { pid: process.pid, startedAt: iso(3600_000), heartbeat: iso(2000), scheduler: { ok: true, reason: 'ok' }, claude: 'claude', busy: false, running: null, queued: 0 })
  w(path.join(dsh, 'cast', 'demo', 'profile.json'), { name: '测试角色', outfit: '白裙' })
  w(path.join(dsh, 'cast', 'demo', 'sprites', '白裙', 'neutral.png'), PNG)
  fs.mkdirSync(path.join(cfgDir, 'projects', slug(work)), { recursive: true })
  if (review) {
    w(path.join(ai, 'pending-videos.json'), { items: [
      { id: CAT, submissionId: 's1', title: '猫坐地铁', seconds: 72, reason: '想试试', at: iso(600_000), originality: { passed: true, flags: [], notes: [] } },
      { id: DOG, submissionId: 's2', title: '小狗冲浪', seconds: 45, reason: '夏天', at: iso(300_000), originality: { passed: true, flags: [], notes: [] } },
    ] })
    w(path.join(ai, 'review', CAT, 'script.json'), { tags: ['猫'], desc: '猫坐地铁的简介', tid: 21 })
    w(path.join(ai, 'channel-submitted.json'), { text: CHANNEL_TEXT, sha: sha256(CHANNEL_TEXT), at: iso(120_000) })
  }
  const stub = stubIn(home)
  Object.assign(s, { dsh, hostDir, work, ai, env, stub, info: path.join(hostDir, 'window.json'), chat: path.join(hostDir, 'window-chat.jsonl'), queue: path.join(hostDir, 'queue.json') })
  return s
}
async function startViewer(t, s) {
  const port = await freePort()
  const p = spawn(NODE, [path.join(root, 'host/window.mjs'), '--port', String(port)], { env: { ...s.env, ...s.stub.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  s.procs.push(p)
  let out = ''
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  const info = await until(() => { const j = readJson(s.info); return j?.pid === p.pid ? j : null }, 20_000, () => '小窗服务没起来：' + out)
  return { p, port, info, out: () => out, pet: { 'x-whale-pet': info.petToken } }
}
function req(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, body }) })
    })
    r.on('error', reject)
    r.end()
  })
}
const getJson = async (port, p, headers) => { const r = await req(port, p, { headers: { 'sec-fetch-site': 'same-origin', ...headers } }); return { status: r.status, json: (() => { try { return JSON.parse(r.body) } catch { return null } })() } }
/** 换一个窗口：用 window.json 里的新口令换 cookie，再拿这个窗口的操作令牌 */
async function login(v, s) {
  const code = await until(() => { const c = readJson(s.info)?.code; return c && c !== s.usedCode ? c : null }, 5000, () => '口令没换')
  s.usedCode = code
  const r = await req(v.port, '/?k=' + code, { headers: { 'sec-fetch-site': 'none' } })
  assert.equal(r.status, 302, r.body)
  const cookie = /^whale_win=[^;]+/.exec(r.headers['set-cookie'][0])[0]
  const me = await getJson(v.port, '/api/me', { cookie })
  assert.equal(me.status, 200)
  return { cookie, act: me.json.act }
}
/** POST /api/act：默认是小窗页面自己发的样子（同源、Origin、JSON），每一项都能换掉 / 拿掉（null） */
function post(port, body, { cookie = null, act = null, origin, site = 'same-origin', type = 'application/json', host, extra = {} } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  const h = { host: host ?? `127.0.0.1:${port}`, 'content-length': Buffer.byteLength(data), ...extra }
  if (type !== null) h['content-type'] = type
  if (cookie) h.cookie = cookie
  if (act) h['x-whale-act'] = act
  if (origin !== null) h.origin = origin ?? `http://127.0.0.1:${port}`
  if (site !== null) h['sec-fetch-site'] = site
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/act', method: 'POST', headers: h }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => { const b = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(b) } catch {} resolve({ status: res.statusCode, body: b, json }) })
    })
    r.on('error', reject)
    r.end(data)
  })
}
const as = (who) => ({ cookie: who.cookie, act: who.act })
/** SSE 客户端：小窗（cookie）或桌宠（令牌头） */
function sse(port, headers) {
  const c = { events: [], raw: '' }
  let buf = ''
  const r = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, ...headers } })
  c.ready = new Promise((resolve) => {
    r.on('response', (res) => {
      resolve(res.statusCode)
      res.setEncoding('utf8')
      res.on('data', (d) => {
        c.raw += d; buf += d
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = {}
          for (const l of block.split('\n')) { const m = /^(\w+): ?(.*)$/.exec(l); if (m) ev[m[1]] = m[2] }
          if (ev.event) c.events.push({ event: ev.event, data: JSON.parse(ev.data) })
        }
      })
    })
    r.on('error', () => resolve(null))
  })
  c.of = (name) => c.events.filter((e) => e.event === name).map((e) => e.data)
  c.close = () => r.destroy()
  return c
}
const cliRun = (s, args, { input, env = {} } = {}) => spawnSync(NODE, [path.join(root, 'host/cli.mjs'), ...args], { env: { ...s.env, ...env }, input, encoding: 'utf8', timeout: 90_000 })

test('小窗操作的每一道门：只认小窗页面自己（cookie + 同源 + Origin + 这个窗口的操作令牌 + JSON）；桌宠的令牌不行；太大、不是 JSON、不认识的都不跑；一分钟最多 30 次', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t)
  const v = await startViewer(t, s)
  const P = v.port
  const a = await login(v, s), b = await login(v, s)
  assert.match(a.act, /^[A-Za-z0-9_-]{32}$/); assert.notEqual(a.act, b.act, '每个窗口自己的令牌')
  // /api/me /api/review /api/jobs 只给小窗页面
  for (const p of ['/api/me', '/api/review', '/api/jobs']) {
    assert.equal((await getJson(P, p, v.pet)).status, 403, p + ' 桌宠')
    assert.equal((await getJson(P, p, {})).status, 403, p + ' 没口令')
  }
  const me = (await getJson(P, '/api/me', { cookie: a.cookie })).json
  assert.equal(me.act, a.act); assert.equal(me.sayMax, 2000); assert.deepEqual(me.acts.sort(), Object.keys(W.ACTS).sort())
  const rv = (await getJson(P, '/api/review', { cookie: a.cookie })).json
  assert.deepEqual(rv.videos.map((x) => [x.id, x.title]), [[CAT, '猫坐地铁'], [DOG, '小狗冲浪']])
  assert.equal(rv.channel.sha, sha256(CHANNEL_TEXT)); assert.equal(rv.channel.state, 'waiting')
  assert.deepEqual((await getJson(P, '/api/jobs', { cookie: a.cookie })).json, { jobs: [] })
  // 别的方法
  const g = await req(P, '/api/act', { headers: { cookie: a.cookie } })
  assert.equal(g.status, 405); assert.equal(g.headers.allow, 'POST')
  assert.equal((await req(P, '/api/act', { method: 'PUT', headers: { cookie: a.cookie } })).status, 405)
  // 每一道门（body 都是一件真能跑的事：叫醒她）
  const wake = { act: 'wake' }
  const gates = [
    ['换了 Host', { ...as(a), host: 'evil.example:' + P }, 421],
    ['没有 cookie', { act: a.act }, 403],
    ['桌宠的令牌', { act: a.act, extra: v.pet }, 403],
    ['没有 Sec-Fetch-Site', { ...as(a), site: null }, 403],
    ['same-site', { ...as(a), site: 'same-site' }, 403],
    ['cross-site', { ...as(a), site: 'cross-site' }, 403],
    ['none（地址栏）', { ...as(a), site: 'none' }, 403],
    ['没有 Origin', { ...as(a), origin: null }, 403],
    ['Origin: null', { ...as(a), origin: 'null' }, 403],
    ['别的端口', { ...as(a), origin: `http://127.0.0.1:${P + 1}` }, 403],
    ['https', { ...as(a), origin: `https://127.0.0.1:${P}` }, 403],
    ['别的网站', { ...as(a), origin: 'http://evil.example' }, 403],
    ['没有操作令牌', { cookie: a.cookie }, 403],
    ['令牌不对', { cookie: a.cookie, act: a.act + 'x' }, 403],
    ['别的窗口的令牌', { cookie: a.cookie, act: b.act }, 403],
    ['编的 cookie', { cookie: 'whale_win=' + crypto.randomBytes(32).toString('base64url'), act: a.act }, 403],
    ['text/plain（表单能发的）', { ...as(a), type: 'text/plain' }, 415],
    ['没有 Content-Type', { ...as(a), type: null }, 415],
    ['form', { ...as(a), type: 'application/x-www-form-urlencoded' }, 415],
  ]
  for (const [why, o, code] of gates) { const r = await post(P, wake, o); assert.equal(r.status, code, why + '：' + r.body); assert.equal(r.json?.ok ?? false, false, why) }
  for (const [why, body, code] of [['坏 JSON', '{act:', 400], ['数组', '[]', 400], ['null', 'null', 400], ['字符串', '"wake"', 400], ['不认识', { act: 'nope' }, 400],
    ['__proto__', '{"act":"__proto__"}', 400], ['constructor', { act: 'constructor' }, 400], ['没有 act', { text: 'x' }, 400],
    ['太大', { act: 'say', text: '猫'.repeat(6000) }, 413], ['话太长', { act: 'say', text: '猫'.repeat(2001) }, 400], ['空话', { act: 'say', text: ' ' }, 400],
    ['不在单子里的视频', { act: 'approve', id: '202610269999-nope' }, 400], ['路径当 id', { act: 'play', id: '../../x' }, 400]]) {
    const r = await post(P, body, as(a)); assert.equal(r.status, code, why + '：' + r.body); assert.equal(r.json.ok, false, why)
  }
  assert.deepEqual(readLines(s.stub.log), [], '上面一件都没真跑')
  assert.deepEqual((await getJson(P, '/api/jobs', { cookie: a.cookie })).json, { jobs: [] })
  // 限速：一个窗口一分钟最多 30 次（不管成没成）；别的窗口不受影响
  const c = await login(v, s)
  for (let i = 0; i < 30; i += 1) assert.equal((await post(P, { act: 'nope' }, as(c))).status, 400)
  const r429 = await post(P, wake, as(c))
  assert.equal(r429.status, 429); assert.match(r429.json.error, /太快/)
  assert.equal((await post(P, { act: 'nope' }, as(b))).status, 400, '别的窗口照常')
  assert.deepEqual(readLines(s.stub.log), [])
})

test('小窗里点的事跑的就是这些 cli 参数：跟她说（话从标准输入进）/ 叫醒（--queue-only）/ 启动宿主 / 看片 / 退回 / 频道设定；结果推给小窗页面、桌宠收不到', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t)
  const v = await startViewer(t, s)
  const P = v.port
  const a = await login(v, s)
  const win = sse(P, { cookie: a.cookie }), pet = sse(P, v.pet)
  t.after(() => { win.close(); pet.close() })
  assert.equal(await win.ready, 200); assert.equal(await pet.ready, 200)
  const run = async (body, o = as(a)) => { const r = await post(P, body, o); assert.equal(r.status, 200, r.body); assert.equal(r.json.ok, true); return r.json.job }
  let j = await run({ act: 'say', text: '  你好\r\n世界' + NUL + BEL + '  ' })
  assert.equal(j.state, 'done'); assert.equal(j.ok, true); assert.equal(j.label, '跟她说'); assert.equal(j.act, 'say')
  assert.equal(j.out, '假的 cli say --stdin SESSDATA=***', '去掉颜色、抹掉凭据样子')
  j = await run({ act: 'wake' }, { ...as(a), origin: `http://localhost:${P}` })
  assert.equal(j.ok, false); assert.equal(j.code, 3, '宿主没在跑（假 cli 退出码 3）：照实给页面')
  await run({ act: 'start' })
  j = await run({ act: 'play', id: CAT })
  assert.equal(j.label, '看片《猫坐地铁》')
  assert.equal((await post(P, { act: 'reject', id: CAT, sub: 's1', text: '-force' }, as(a))).status, 400)
  // 退回 / 频道设定要对上主人看到的那一版（交审编号 / 指纹）：对不上 409、不跑
  for (const [why, body, re] of [['没带编号', { act: 'reject', id: CAT, text: '不要' }, /重新交过/], ['旧的编号', { act: 'reject', id: CAT, sub: 's0', text: '不要' }, /重新交过/],
    ['频道退回没带指纹', { act: 'channel-reject', text: '再想想' }, /又交了一版/], ['频道确认的指纹是旧的', { act: 'channel-approve', sha: 'ab'.repeat(32) }, /又交了一版/]]) {
    const r = await post(P, body, as(a)); assert.equal(r.status, 409, why + '：' + r.body); assert.match(r.json.error, re, why)
  }
  j = await run({ act: 'reject', id: CAT, sub: 's1', text: ' 节奏太慢\r\n再剪短点 ' })
  assert.equal(j.label, '退回视频《猫坐地铁》')
  assert.equal((await post(P, { act: 'channel-approve', sha: 'xyz' }, as(a))).status, 400)
  await run({ act: 'channel-approve', sha: sha256(CHANNEL_TEXT).toUpperCase() })
  await run({ act: 'channel-reject', sha: sha256(CHANNEL_TEXT), text: '定位再具体一点' })
  assert.deepEqual(readLines(s.stub.log), [
    { args: ['say', '--stdin'], input: '你好\n世界', fromWindow: '1' },
    { args: ['wake', '--queue-only'], input: '', fromWindow: '1' },
    { args: ['start'], input: '', fromWindow: '1' },
    { args: ['videos', 'play', CAT], input: '', fromWindow: '1' },
    { args: ['videos', 'reject', CAT, '节奏太慢\n再剪短点'], input: '', fromWindow: '1' },
    { args: ['channel', 'approve', sha256(CHANNEL_TEXT)], input: '', fromWindow: '1' },
    { args: ['channel', 'reject', '定位再具体一点'], input: '', fromWindow: '1' },
  ])
  const jobs = (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs
  assert.deepEqual(jobs.map((x) => [x.label, x.state]), [['跟她说', 'done'], ['叫醒她', 'done'], ['启动宿主', 'done'], ['看片《猫坐地铁》', 'done'],
    ['退回视频《猫坐地铁》', 'done'], ['确认频道设定', 'done'], ['退回频道设定', 'done']])
  // 推送：小窗页面每件事一条「在做」一条「做完」；桌宠一条都没有，也看不到说的话
  await until(() => win.of('job').filter((x) => x.state === 'done').length === 7, 5000, () => JSON.stringify(win.of('job')))
  assert.equal(win.of('job').filter((x) => x.state === 'running').length, 7)
  await sleep(300)
  assert.deepEqual(pet.of('job'), []); assert.deepEqual(pet.of('chat'), [])
  assert.ok(!pet.raw.includes('假的 cli') && !pet.raw.includes('跟她说'), '桌宠的连接里没有这些')
})

test('cli videos：简介超出上限时说她一共写了几个字（按字符数）、只发前几个、后面几个不发；标签最多列 9 个', { timeout: 60_000 }, (t) => {
  const s = sandbox(t)
  const room = REVIEW.DESC_MAX - [...REVIEW.AI_NOTE].length - 2
  w(path.join(s.ai, 'review', CAT, 'script.json'), { tags: Array.from({ length: 11 }, (_, i) => '标签' + i), desc: '猫'.repeat(2499) + String.fromCodePoint(0x1f600), tid: 21 })
  const r = cliRun(s, ['videos'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /简介：猫{300}…（共 2500 字，全文在快照的 script\.json）/)
  assert.match(r.stdout, new RegExp(`只发前 ${room} 字，后面 ${2500 - room} 字不会发出去`))
  assert.match(r.stdout, /标签：标签0 \/ 标签1 \/ 标签2 \/ 标签3 \/ 标签4 \/ 标签5 \/ 标签6 \/ 标签7 \/ 标签8 \/ AI生成/)
})

test('投稿等到超时被停掉：做完的那件事（/api/jobs 和推给页面的 job）带着「结果说不准」和这条视频的 videos resolve；别的事超时不带', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t)
  s.env.BILI_WHALE_WINDOW_ACT_MS = '1500'          // 只在 NO_EDGE（测试）时认：把每件事最多等多久压到 1.5 秒
  w(path.join(s.home, 'hold-videos-approve'), ''); w(path.join(s.home, 'hold-videos-reject'), '')
  const v = await startViewer(t, s)
  const P = v.port
  const a = await login(v, s)
  const win = sse(P, { cookie: a.cookie })
  t.after(() => win.close())
  await win.ready
  const c = await post(P, { act: 'approve', id: CAT, sub: 's1' }, as(a))
  const r = await post(P, { act: 'approve', id: CAT, sub: 's1', confirm: c.json.confirm }, as(a))
  assert.equal(r.status, 200, r.body)
  const j = await until(async () => (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs.find((x) => x.act === 'approve' && x.state === 'done'), 20_000, () => '投稿没停掉')
  assert.equal(j.ok, false); assert.equal(j.code, null)
  assert.match(j.out, /超过 2 秒还没做完，停掉了\n结果说不准：可能已经投上了。.*videos resolve 202610260900-cat none（没投上）或 <BV号>（投上了）$/)
  const pushed = await until(() => win.of('job').find((x) => x.act === 'approve' && x.state === 'done'), 5000)
  assert.equal(pushed.out, j.out)
  const rj = await post(P, { act: 'reject', id: DOG, sub: 's2', text: '慢' }, as(a))
  assert.equal(rj.status, 200, rj.body)
  const jr = await until(async () => (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs.find((x) => x.act === 'reject' && x.state === 'done'), 20_000)
  assert.match(jr.out, /停掉了$/); assert.doesNotMatch(jr.out, /结果说不准/)
})

test('投稿点两次（确认口令：两分钟、一次、绑这个窗口和这条视频）；同时只审一件；正在投稿时 window.json 记着、window --stop 不停、--force 才停', { timeout: 180_000 }, async (t) => {
  const s = sandbox(t)
  const v = await startViewer(t, s)
  const P = v.port
  const a = await login(v, s), b = await login(v, s)
  // 第一次：只拿到确认口令，什么都没跑
  const c1 = await post(P, { act: 'approve', id: CAT, sub: 's1' }, as(a))
  assert.equal(c1.status, 200); assert.equal(c1.json.need, 'confirm'); assert.equal(c1.json.id, CAT); assert.equal(c1.json.title, '猫坐地铁')
  assert.equal(c1.json.seconds, 72); assert.equal(c1.json.expiresInSec, 120); assert.match(c1.json.confirm, /^[A-Za-z0-9_-]{24}$/)
  assert.deepEqual(readLines(s.stub.log), [])
  for (const [why, body, who] of [['别的视频', { act: 'approve', id: DOG, sub: 's2', confirm: c1.json.confirm }, a], ['别的窗口', { act: 'approve', id: CAT, sub: 's1', confirm: c1.json.confirm }, b],
    ['编的', { act: 'approve', id: CAT, sub: 's1', confirm: 'x'.repeat(24) }, a], ['不是字符串', { act: 'approve', id: CAT, sub: 's1', confirm: 123 }, a]]) {
    const r = await post(P, body, as(who)); assert.equal(r.status, 409, why + '：' + r.body); assert.match(r.json.error, /再点一次/)
  }
  assert.equal((await post(P, { act: 'approve', id: CAT }, as(a))).status, 409, '没带交审编号：不给确认口令')
  // 她重交了（同一个 id、新的交审编号）：旧卡片上的按钮不替你批 / 退；拿着旧那一版的确认口令也不行
  const pend = path.join(s.ai, 'pending-videos.json'), items = readJson(pend).items
  const c0 = await post(P, { act: 'approve', id: DOG, sub: 's2' }, as(a))
  assert.equal(c0.status, 200)
  w(pend, { items: items.map((x) => (x.id === DOG ? { ...x, submissionId: 's2b' } : x)) })
  for (const [why, body, re] of [['旧卡片', { act: 'approve', id: DOG, sub: 's2', confirm: c0.json.confirm }, /重新交过/], ['新编号、旧口令', { act: 'approve', id: DOG, sub: 's2b', confirm: c0.json.confirm }, /再点一次/],
    ['旧卡片退回', { act: 'reject', id: DOG, sub: 's2', text: '不要' }, /重新交过/]]) {
    const r = await post(P, body, as(a)); assert.equal(r.status, 409, why + '：' + r.body); assert.match(r.json.error, re, why)
  }
  w(pend, { items })
  assert.deepEqual(readLines(s.stub.log), [], '确认对不上：一件都没跑')
  // 第二次（带口令）：真投；假 cli 在 hold 文件在的时候一直等 = 正在上传
  const hold = path.join(s.home, 'hold-videos-approve')
  w(hold, '')
  const going = post(P, { act: 'approve', id: CAT, sub: 's1', confirm: c1.json.confirm }, as(a))
  await until(async () => (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs.some((x) => x.act === 'approve' && x.state === 'running'), 10_000, () => '投稿没开始')
  await until(() => readJson(s.info)?.busy?.length === 1, 5000, () => JSON.stringify(readJson(s.info)))
  assert.deepEqual(readJson(s.info).busy, ['投稿《猫坐地铁》'])
  // 正在投稿：别的「审」都不行；看片、跟她说照常
  for (const body of [{ act: 'approve', id: DOG }, { act: 'reject', id: DOG, text: '不要' }, { act: 'channel-approve', sha: sha256(CHANNEL_TEXT) }, { act: 'channel-reject', text: '再想想' }]) {
    const r = await post(P, body, as(b)); assert.equal(r.status, 409, body.act + '：' + r.body); assert.match(r.json.error, /投稿《猫坐地铁》」还在做/)
  }
  assert.equal((await post(P, { act: 'play', id: DOG }, as(b))).status, 200)
  // 跟她说也一次一句：正在交的时候再说一句 → 409（几个 cli say 同时数「排着几句」会一起超过 5 句）
  const holdSay = path.join(s.home, 'hold-say---stdin')
  w(holdSay, '')
  const saying = post(P, { act: 'say', text: '投得怎么样' }, as(b))
  await until(async () => (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs.some((x) => x.act === 'say' && x.state === 'running'), 10_000, () => 'say 没开始')
  const say2 = await post(P, { act: 'say', text: '再一句' }, as(a))
  assert.equal(say2.status, 409, say2.body); assert.match(say2.json.error, /跟她说」还在做/)
  fs.rmSync(holdSay)
  assert.equal((await saying).status, 200)
  // window --stop：正在投稿就不停（说怎么强停）；服务还在
  let r = cliRun(s, ['window', '--stop'])
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /投稿《猫坐地铁》/); assert.match(r.stdout, /--stop --force/)
  assert.ok(alive(v.p.pid)); assert.ok(fs.existsSync(s.info))
  // 投完了：busy 清掉；用过的口令不能再用
  fs.rmSync(hold)
  const done = await going
  assert.equal(done.status, 200, done.body)
  await until(async () => (await getJson(P, '/api/jobs', { cookie: a.cookie })).json.jobs.find((x) => x.act === 'approve')?.state === 'done', 10_000)
  await until(() => Array.isArray(readJson(s.info)?.busy) && readJson(s.info).busy.length === 0, 5000, () => JSON.stringify(readJson(s.info)))
  const again = await post(P, { act: 'approve', id: CAT, sub: 's1', confirm: c1.json.confirm }, as(a))
  assert.equal(again.status, 409, '口令只能用一次')
  assert.deepEqual(readLines(s.stub.log).map((x) => x.args), [['videos', 'approve', CAT], ['videos', 'play', DOG], ['say', '--stdin']])
  // 再投一条、正在投的时候 --stop --force：停了（连同它底下的 cli）
  const c2 = await post(P, { act: 'approve', id: DOG, sub: 's2' }, as(b))
  w(hold, '')
  const going2 = post(P, { act: 'approve', id: DOG, sub: 's2', confirm: c2.json.confirm }, as(b)).catch(() => null)
  await until(() => readJson(s.info)?.busy?.[0] === '投稿《小狗冲浪》', 10_000, () => JSON.stringify(readJson(s.info)))
  r = cliRun(s, ['window', '--stop', '--force'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /小窗服务停了/)
  await until(() => !alive(v.p.pid), 6000, () => '没停掉')
  assert.equal(fs.existsSync(s.info), false)
  await going2
  fs.rmSync(hold, { force: true })
})

test('聊天：原话 + 队列 + 结果日志 → 小窗快照里的 chat（排着 / 做完带回复 / 没做完 / 丢了）；回复抹掉凭据样子；chat 事件只推给小窗页面，桌宠的快照里没有', { timeout: 120_000 }, async (t) => {
  const s = sandbox(t, { review: false })
  const id = (n) => `bili-whale-win-${String(Date.now() - 600_000 + n)}-000${n}`
  const [q1, q2, lost, late] = [id(1), id(2), id(3), id(4)]
  for (const [i, at, text] of [[lost, iso(300_000), '丢了的那句'], [late, iso(290_000), '排了很久的'], [q1, iso(40_000), '帮我看看今天的视频'], [q2, iso(20_000), '还有这个']]) fs.appendFileSync(s.chat, JSON.stringify({ id: i, at, text }) + '\n')
  w(s.queue, [{ id: q1, text: 'CANARY_PROMPT 整段提示', at: iso(40_000), priority: true }, { id: 'manual-1', text: 'CANARY_PROMPT', at: iso(60_000) }, { id: q2, text: 'CANARY_PROMPT', at: iso(20_000), priority: true },
    { id: late, text: 'CANARY_PROMPT', at: iso(290_000), priority: true }])
  const v = await startViewer(t, s)
  const P = v.port
  const a = await login(v, s)
  const live = async (h) => (await getJson(P, '/api/live', h)).json
  let snap = await live({ cookie: a.cookie })
  assert.deepEqual(snap.chat.map((x) => [x.text, x.state, x.ahead]), [['丢了的那句', 'lost', undefined], ['排了很久的', 'queued', 3], ['帮我看看今天的视频', 'queued', 0], ['还有这个', 'queued', 2]])
  assert.deepEqual(snap.queued, { dm: 0, win: 3, total: 4 })
  assert.equal(snap.state, 'dm_queued'); assert.equal(snap.caption, '收到你的话了，马上回')
  const petSnap = await live(v.pet)
  assert.equal('chat' in petSnap, false, '桌宠的快照里没有聊天'); assert.equal(petSnap.caption, '收到你的话了，马上回')
  assert.ok(!JSON.stringify(petSnap).includes('帮我看看'))
  assert.ok(!JSON.stringify(snap).includes('CANARY_PROMPT'), '队列里的整段提示不上页面')
  const win = sse(P, { cookie: a.cookie }), pet = sse(P, v.pet)
  t.after(() => { win.close(); pet.close() })
  await win.ready; await pet.ready
  await until(() => win.of('hello').length && pet.of('hello').length, 5000)
  assert.ok(Array.isArray(win.of('hello')[0].chat)); assert.equal('chat' in pet.of('hello')[0], false)
  // 她回了第一句（结果日志）、第二句没做完；队列里只剩那个普通回合
  const logF = path.join(s.hostDir, 'logs', localDay(Date.now()) + '.jsonl')
  w(logF, [
    { at: iso(), id: q1, ok: true, sessionId: SID, costUsd: 0.21, turns: 3, ms: 25_000, prompt: '【主人·小窗】…', result: '看了！猫坐地铁那条挺好\n顺便 SESSDATA=abcdef123456 别外传' + ZW },
    { at: iso(), id: q2, ok: false, sessionId: SID, costUsd: 0.05, turns: 1, ms: 5000, prompt: '…', result: '超时了' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  w(s.queue, [{ id: 'manual-1', text: 'CANARY_PROMPT', at: iso(60_000) }])
  const t0 = Date.now()
  const ev = await until(() => win.of('chat').map((x) => x.chat).find((c) => c.find((x) => x.id === q1)?.state === 'done' && c.find((x) => x.id === q2)?.state === 'failed'), 10_000, () => JSON.stringify(win.of('chat')))
  const d = ev.find((x) => x.id === q1)
  assert.equal(d.reply, '看了！猫坐地铁那条挺好\n顺便 SESSDATA=*** 别外传', '凭据样子抹掉、看不见的字符去掉、换行留着')
  assert.equal(d.ms, 25_000); assert.ok(d.replyAt)
  const f = ev.find((x) => x.id === q2)
  assert.equal(f.reply, undefined, '没做完的不当她的回复'); assert.equal(f.error, '超时了')
  // 刚还排着、这一下哪儿都找不到（宿主刚拿掉、结果日志还没读到也是这样）：先照旧显示 2 秒，还找不到才算「没等到」
  assert.equal(ev.find((x) => x.id === late).state, 'queued')
  const gone = await until(() => win.of('chat').map((x) => x.chat).find((c) => c.find((x) => x.id === late)?.state === 'lost'), 10_000, () => JSON.stringify(win.of('chat').at(-1)))
  assert.ok(Date.now() - t0 >= 1500, String(Date.now() - t0)); assert.ok(gone)
  snap = await live({ cookie: a.cookie })
  assert.equal(snap.chat.find((x) => x.id === q1).state, 'done'); assert.deepEqual(snap.queued, { dm: 0, win: 0, total: 1 })
  await sleep(300)
  assert.deepEqual(pet.of('chat'), []); assert.ok(!pet.raw.includes('猫坐地铁那条') && !pet.raw.includes('帮我看看'), '桌宠的连接里没有聊天')
})

test('cli say：宿主没在跑 → 退出码 3、什么都不写；在跑 → 插队排进队列（小窗回合 id、priority）、原话记一份；--stdin；排着 5 句就先不收；wake --queue-only 宿主没在跑 → 3', { timeout: 180_000 }, async (t) => {
  const off = sandbox(t, { daemon: false, review: false })
  let r = cliRun(off, ['say', '你好'])
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout, /宿主没在跑/)
  r = cliRun(off, ['wake', '--queue-only'])
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout, /先启动宿主/)
  assert.equal(fs.existsSync(off.queue), false); assert.equal(fs.existsSync(off.chat), false)
  for (const args of [['say'], ['say', '--stdin', '多余的'], ['say', '   ']]) { r = cliRun(off, args); assert.equal(r.status, 2, args.join(' ') + '：' + r.stdout) }
  r = cliRun(off, ['say', '猫'.repeat(2001)])
  assert.equal(r.status, 2); assert.match(r.stdout, /太长了/)

  const s = sandbox(t, { review: false })
  w(s.queue, [{ id: 'manual-1', text: '醒', at: iso(60_000) }])
  // 宿主正在跑 manual-1（running.json 记着）：插队会排到它前面，可它在跑 —— 前面还有 1 个
  w(path.join(s.hostDir, 'running.json'), { pid: process.pid, id: 'manual-1', at: iso(5000), sessionId: SID })
  r = cliRun(s, ['say', '你好', '世界'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /交给她了（前面还有 1 个回合）/)
  let q = readJson(s.queue)
  assert.equal(q.length, 2); assert.match(q[0].id, C.WIN_ID_RE); assert.equal(q[0].priority, true); assert.equal(q[1].id, 'manual-1', '插在普通回合前面')
  assert.match(q[0].text, /【主人·小窗】/); assert.match(q[0].text, /————————\n你好 世界\n————————/)
  r = cliRun(s, ['say', '--stdin'], { input: BOM + '第二句\r\n换行了' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /前面还有 2 个回合/)
  fs.rmSync(path.join(s.hostDir, 'running.json'))
  q = readJson(s.queue)
  assert.deepEqual(q.map((x) => x.priority ?? false), [true, true, false], '插队的之间按先来后到')
  assert.match(q[1].text, /第二句\n换行了/)
  const chat = readLines(s.chat)
  assert.deepEqual(chat.map((x) => [x.id, x.text]), [[q[0].id, '你好 世界'], [q[1].id, '第二句\n换行了']])
  // 再排 3 句（一共 5 句没回）→ 第 6 句先不收
  w(s.queue, [...q.slice(0, 2), ...[1, 2, 3].map((n) => ({ id: `bili-whale-win-${Date.now()}-00${n}a`, text: 'x', at: iso(), priority: true })), q[2]])
  r = cliRun(s, ['say', '再来一句'])
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /5 句排着/)
  assert.equal(readJson(s.queue).length, 6); assert.equal(readLines(s.chat).length, 2)
  // 帮助里有 say
  r = cliRun(s, ['help'])
  assert.match(r.stdout, /node host\/cli\.mjs say "要说的话" \| say --stdin/)
  // running.json 没删掉（记的回合早就出队了）：不算它在跑，前面没有别的
  w(s.queue, [{ id: 'manual-1', text: '醒', at: iso(60_000) }])
  w(path.join(s.hostDir, 'running.json'), { pid: process.pid, id: 'manual-gone', at: iso(5000), sessionId: SID })
  r = cliRun(s, ['say', '前面没人'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /✓ 交给她了：/); assert.doesNotMatch(r.stdout, /前面还有/)
  fs.rmSync(path.join(s.hostDir, 'running.json'))
  // 投不成（队列写不进去）：原话后面补一行 cancel，这句在小窗里整个不算
  fs.rmSync(s.queue, { force: true }); fs.mkdirSync(s.queue)
  r = cliRun(s, ['say', '投不成的'])
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /✗ 没交给她/)
  const tail = fs.readFileSync(s.chat, 'utf8').trim().split('\n').slice(-2).map((l) => JSON.parse(l))
  assert.equal(tail[0].text, '投不成的'); assert.deepEqual(tail[1], { id: tail[0].id, at: tail[1].at, cancel: true })
  assert.ok(!C.readChat(s.chat).some((x) => x.text === '投不成的'))
  fs.rmSync(s.queue, { recursive: true, force: true })
})
