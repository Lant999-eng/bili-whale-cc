// 每一轮的真实花费（host/turncost.mjs）：日志里的 costUsd 是会话累计，一轮花的 = 同一会话前后两行相减。
// 数字是照 2026-10-23/24 真实日志的样子编的（时间和累计都不是真实的数）：累计 0.0913 / 0.1437 / 0.7052 / 1.2479 / 2.6213 → 每轮 0.091 / 0.052 / 0.561 / 0.543 / 1.373；
// 面板以前把累计加起来（这组数的 10-24 会显示 $3.869），实际 $1.916。面板「用量（今天）」、回合列表、cli logs 都按每轮显示
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 有夏令时的时区（主人那边）：下面按日期读日志的测试专门挑切换那两天
process.env.TZ = 'Europe/Berlin'
const { turnCosts, readTurnLogs, todayCost } = await import('../host/turncost.mjs')
const root = fileURLToPath(new URL('../', import.meta.url))

const S = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222'
const REAL = [   // 照真实日志的样子编的 5 轮：时间和累计（UTC；浮点尾巴、两天分布都照真实日志的形状）
  { at: '2026-10-23T09:41:07.000Z', id: 'bili-whale-dm-a', sessionId: S, costUsd: 0.0913 },
  { at: '2026-10-23T09:41:29.000Z', id: 'bili-whale-dm-b', sessionId: S, costUsd: 0.14372910000000003 },
  { at: '2026-10-23T13:08:52.000Z', id: 'bili-whale-1792760700000', sessionId: S, costUsd: 0.7052 },
  { at: '2026-10-24T07:16:34.000Z', id: 'bili-whale-dm-c', sessionId: S, costUsd: 1.2479 },
  { at: '2026-10-24T10:53:15.000Z', id: 'manual-1792839021437', sessionId: S, costUsd: 2.6213 },
]
const f3 = (x) => (x == null ? x : x.toFixed(3))
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v) }
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
const tmp = (t, tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `bili-whale-cost-${tag}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()

test('turncost: the logged running totals become per-turn costs, in any input order', () => {
  const m = turnCosts([...REAL].reverse())
  assert.deepEqual(REAL.map((l) => f3(m.get(l.id))), ['0.091', '0.052', '0.561', '0.543', '1.373'])
  assert.equal(m.get('bili-whale-dm-b'), 0.052429, '浮点相减的尾巴去掉了（0.05242910000000002 → 0.052429）')
  // 「直接把累计加起来」这个老毛病：10-24 那两轮是 3.8692，相减后是 1.9161
  const day = REAL.slice(3)
  assert.equal(Math.round(day.reduce((s, l) => s + l.costUsd, 0) * 1e4) / 1e4, 3.8692)
  assert.equal(Math.round(day.reduce((s, l) => s + m.get(l.id), 0) * 1e4) / 1e4, 1.9161)
})

test('turncost: a new session starts from its own total; interleaved sessions keep their own previous total; a shrinking total is a reset', () => {
  const m = turnCosts([
    { at: '2026-10-20T01:00:00Z', id: 'a1', sessionId: S, costUsd: 0.5 },
    { at: '2026-10-20T02:00:00Z', id: 'b1', sessionId: S2, costUsd: 0.2 },    // 换了会话：第一行就是它自己花的
    { at: '2026-10-20T03:00:00Z', id: 'a2', sessionId: S, costUsd: 0.9 },     // 跟 S 的上一行比，不跟 S2 比
    { at: '2026-10-20T04:00:00Z', id: 'b2', sessionId: S2, costUsd: 0.05 },   // 累计变小 = 计数从头来过 → 按累计本身算
    { at: '2026-10-20T05:00:00Z', id: 'b3', sessionId: S2, costUsd: 0.05 },   // 一样多 = 这一轮没花钱
  ])
  assert.deepEqual(Object.fromEntries(m), { a1: 0.5, b1: 0.2, a2: 0.4, b2: 0.05, b3: 0 })
})

test('turncost: a turn without a cost is unknown (null) and does not move the baseline; odd lines do not break the rest', () => {
  const m = turnCosts([
    { at: '2026-10-20T01:00:00Z', id: 'x1', sessionId: S, costUsd: 0.2 },
    { at: '2026-10-20T02:00:00Z', id: 'x2', sessionId: S, costUsd: null },     // 超时 / 失败：没记费用
    { at: '2026-10-20T02:30:00Z', id: 'x3', sessionId: S, costUsd: '0.4' },    // 字符串、负数、NaN 都不认
    { at: '2026-10-20T02:40:00Z', id: 'x4', sessionId: S, costUsd: -1 },
    { at: '2026-10-20T03:00:00Z', id: 'x5', sessionId: S, costUsd: 0.5 },      // 跟 x1 比（中间没数的不算）
    { at: 'not a date', id: 'x6', sessionId: S, costUsd: 9 },                  // 排不进时间顺序：不知道
    { at: '2026-10-20T04:00:00Z', id: 'x7', costUsd: 0.07 },                   // 没记会话的老日志：按它自己的数
    null, 42, 'junk',
  ])
  assert.deepEqual(Object.fromEntries(m), { x1: 0.2, x2: null, x3: null, x4: null, x5: 0.3, x6: null, x7: 0.07 })
  assert.equal(turnCosts(null).size, 0); assert.equal(turnCosts([]).size, 0)
  // 同一时刻的两行：按写日志的先后
  const same = turnCosts([{ at: '2026-10-20T01:00:00Z', id: 'p', sessionId: S, costUsd: 0.1 }, { at: '2026-10-20T01:00:00Z', id: 'q', sessionId: S, costUsd: 0.3 }])
  assert.deepEqual(Object.fromEntries(same), { p: 0.1, q: 0.2 })
})

test('turncost: readTurnLogs reads the last N local dates oldest first, skips bad lines, and tolerates missing days', (t) => {
  const dir = tmp(t, 'read')
  for (let d = 10; d <= 20; d += 1) if (d !== 15) w(path.join(dir, `2026-10-${d}.jsonl`), jsonl([{ at: `2026-10-${d}T10:00:00Z`, id: `d${d}` }]))
  w(path.join(dir, '2026-10-20.jsonl'), '﻿' + jsonl([{ at: '2026-10-20T10:00:00Z', id: 'd20' }, '{"broken', '[1,2]', '7', '', { at: '2026-10-20T11:00:00Z', id: 'd20b' }]) + '\r\n\r\n')
  w(path.join(dir, 'notes.jsonl'), jsonl([{ id: 'stray' }]))
  const ids = (o) => readTurnLogs(dir, o).map((l) => l.id)
  const now = local(2026, 10, 20, 18, 0)
  assert.deepEqual(ids({ now }), ['d13', 'd14', 'd16', 'd17', 'd18', 'd19', 'd20', 'd20b'], '默认 8 天：13–20 号（15 号没有文件）')
  assert.deepEqual(ids({ now, days: 1 }), ['d20', 'd20b'])
  assert.deepEqual(ids({ now, days: 'x' }), ids({ now }), '天数读不懂 → 默认 8 天')
  assert.deepEqual(readTurnLogs(path.join(dir, 'nope'), { now }), [])
})

test('turncost: readTurnLogs steps back by calendar day across both DST switches (minus 24 h would skip or repeat a day)', (t) => {
  const dir = tmp(t, 'dst')
  for (const d of ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']) w(path.join(dir, `${d}.jsonl`), jsonl([{ at: `${d}T10:00:00Z`, id: d }]))
  const day = (t) => new Date(t).toLocaleDateString('sv-SE')
  // 春天 3-29 只有 23 小时：3-30 00:30 往回减 24 小时落在 3-28，跳过了 3-29
  const spring = local(2026, 3, 30, 0, 30)
  assert.equal(day(spring - 86400_000), '2026-03-28', '确认这确实是那个坑')
  assert.deepEqual(readTurnLogs(dir, { now: spring, days: 2 }).map((l) => l.id), ['2026-03-29', '2026-03-30'])
  // 秋天 10-25 有 25 小时：10-25 23:30 往回减 24 小时还在 10-25，漏了 10-24
  const fall = local(2026, 10, 25, 23, 30)
  assert.equal(day(fall - 86400_000), '2026-10-25', '确认这确实是那个坑')
  assert.deepEqual(readTurnLogs(dir, { now: fall, days: 2 }).map((l) => l.id), ['2026-10-24', '2026-10-25'])
  assert.deepEqual(readTurnLogs(dir, { now: local(2026, 10, 26, 0, 30), days: 3 }).map((l) => l.id), ['2026-10-24', '2026-10-25', '2026-10-26'])
})

test('turncost: todayCost sums today\'s per-turn costs, using earlier days as context ($1.916 on 10-24, not $3.869)', (t) => {
  const dir = tmp(t, 'today')
  const file = (l) => new Date(l.at).toLocaleDateString('sv-SE')
  for (const d of new Set(REAL.map(file))) w(path.join(dir, `${d}.jsonl`), jsonl(REAL.filter((l) => file(l) === d).map((l) => ({ ...l, ok: true, prompt: 'x', result: 'y' }))))
  const r = todayCost(dir, { now: local(2026, 10, 24, 22, 0) })
  assert.equal(r.costUsd, 1.9161); assert.equal(r.known, 2); assert.equal(r.unknown, 0)
  assert.deepEqual(r.perTurn.map((x) => [x.id, f3(x.costUsd)]), [['bili-whale-dm-c', '0.543'], ['manual-1792839021437', '1.373']])
  // 没有前一天当上下文，今天第一轮就只能按累计算（这就是为什么要往前读）
  assert.equal(todayCost(dir, { now: local(2026, 10, 24, 22, 0), days: 1 }).costUsd, 2.6213)
  assert.equal(todayCost(dir, { now: local(2026, 10, 23, 22, 0) }).costUsd, 0.7052, '10-23：0.091 + 0.052 + 0.561')
  // 今天有一轮没记费用：算「不知道」，不当 0；一轮都没数 → null
  w(path.join(dir, '2026-10-27.jsonl'), jsonl([{ at: '2026-10-27T09:00:00Z', id: 'z1', sessionId: S, costUsd: null, ok: false }]))
  assert.deepEqual(todayCost(dir, { now: local(2026, 10, 27, 22, 0) }), { costUsd: null, known: 0, unknown: 1, perTurn: [{ id: 'z1', at: '2026-10-27T09:00:00Z', costUsd: null }] })
  assert.deepEqual(todayCost(path.join(dir, 'nope'), { now: local(2026, 10, 27, 22, 0) }), { costUsd: null, known: 0, unknown: 0, perTurn: [] })
})

// ─────────────── 用到 costUsd 的地方：面板（用量 + 回合列表）、cli logs ───────────────
/** 沙盒：时区钉成「这会儿正好中午」的固定偏移（今天 / 昨天的素材不会因为在半夜跑而跨日） */
function sandbox(t) {
  const off = 12 - new Date().getUTCHours()
  const tz = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off)
  const home = tmp(t, 'sb')
  const dsh = path.join(home, 'data'), hostDir = path.join(dsh, 'whale-cc')
  const env = { ...process.env, TZ: tz, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_AI_HOME: path.join(dsh, 'whale-work') }
  delete env.NODE_OPTIONS
  w(env.BILI_WHALE_CONFIG, JSON.stringify({ owner: { mid: '222' }, self: { mid: '333' }, claude: { timeoutMin: 25 } }))
  const day = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: tz })
  return { home, hostDir, env, day }
}

test('turncost: the dashboard\'s usage total and turn rows, and cli logs, show per-turn costs', (t) => {
  const s = sandbox(t)
  const now = Date.now(), h = 3600_000
  // 同一会话的上一轮在 3 天前（中间两天没醒）：只读昨天 + 今天就会把今天第一轮算成整个累计
  const rows = [[96 * h, 0.0913], [95.9 * h, 0.14372910000000003], [72 * h, 0.7052], [3 * h, 1.2479], [1 * h, 2.6213]]
    .map(([ago, c], i) => ({ at: new Date(now - ago).toISOString(), id: `bili-whale-dm-t${i}`, ok: true, sessionId: S, costUsd: c, turns: 3, ms: 20000, prompt: 'x', result: `第 ${i} 轮` }))
  const logDir = path.join(s.hostDir, 'logs')
  const writeLogs = (list) => { fs.rmSync(logDir, { recursive: true, force: true }); for (const d of new Set(list.map((r) => s.day(Date.parse(r.at))))) w(path.join(logDir, `${d}.jsonl`), jsonl(list.filter((r) => s.day(Date.parse(r.at)) === d))) }
  writeLogs(rows)
  assert.equal(s.day(Date.parse(rows[2].at)) !== s.day(now - 24 * h) && s.day(Date.parse(rows[3].at)) === s.day(now), true, '前三轮在三四天前、后两轮在今天')
  const r = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'dashboard', '--json'], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.usage.costUsd, 1.9161, '今天 = 0.5427 + 1.3734，不是 1.2479 + 2.6213'); assert.equal(j.usage.costKnown, 2)
  assert.deepEqual(j.turns.items.map((x) => [x.id, f3(x.costUsd)]), [['bili-whale-dm-t4', '1.373'], ['bili-whale-dm-t3', '0.543']])
  const html = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(root, 'host/dashboard.mjs')).href)}).then((m) => process.stdout.write(m.render(m.collect())))`], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(html.status, 0, html.stderr)
  assert.match(html.stdout, / · \$1\.3734/); assert.match(html.stdout, / · \$0\.5427/); assert.match(html.stdout, /Claude 费用：\$1\.9161/)
  assert.doesNotMatch(html.stdout, /\$2\.6213|\$3\.869/)
  // cli logs：每行是这一轮花的
  const lg = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'logs', '--n', '5'], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(lg.status, 0, lg.stdout + lg.stderr)
  const costs = [...lg.stdout.matchAll(/bili-whale-dm-t(\d)\s+\$(\d+\.\d{3})/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(costs, [['0', '0.091'], ['1', '0.052'], ['2', '0.561'], ['3', '0.543'], ['4', '1.373']], lg.stdout)
  // 只显示最后一行（cli wake 跑完就是这么调的）：照样拿前面的行当上下文
  const one = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'logs', '--n', '1'], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.match(one.stdout, /bili-whale-dm-t4\s+\$1\.373\b/); assert.doesNotMatch(one.stdout, /\$2\.621/)
  // 会话换得慢（rotateDays 14）：面板往前读 rotateDays + 1 天，10 天前的上一轮也接得上；默认 7 天时读 8 天，接不上就按累计算
  writeLogs([{ ...rows[2], at: new Date(now - 10 * 24 * h).toISOString() }, rows[3]])
  const usage = () => { const x = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'dashboard', '--json'], { env: s.env, encoding: 'utf8', timeout: 60000 }); assert.equal(x.status, 0, x.stderr); return JSON.parse(x.stdout).usage.costUsd }
  assert.equal(usage(), 1.2479)
  w(s.env.BILI_WHALE_CONFIG, JSON.stringify({ owner: { mid: '222' }, self: { mid: '333' }, claude: { timeoutMin: 25, rotateDays: 14 } }))
  assert.equal(usage(), 0.5427)
})

test('turncost: collect({ light: true }) never scans processes (the window calls it every 30 s); the full collect still does', async (t) => {
  const s = sandbox(t)
  const sid = crypto.randomUUID()   // 每次不同：会话进程是全机扫描的
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', '--', '--resume', sid, '--output-format', 'json'], { stdio: 'ignore' })
  t.after(() => { try { child.kill() } catch {} })
  await new Promise((r) => child.once('spawn', r))
  // 宿主不在线；running.json 记下的进程不在了，同一会话的 claude 还在跑 —— 只有查进程才知道它还在跑
  w(path.join(s.hostDir, 'running.json'), JSON.stringify({ pid: 999999, id: 'bili-whale-dm-light', at: new Date().toISOString(), sessionId: sid }))
  const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(root, 'host/dashboard.mjs')).href)})
const pick = (x) => ({ st: x.turns.items.find((i) => i.id === 'bili-whale-dm-light')?.status, usage: x.usage.costUsd })
const light = pick(m.collect({ light: true })); const full = pick(m.collect())
console.log(JSON.stringify({ light, full }))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: s.env, encoding: 'utf8', timeout: 90000 })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(o.full.st, 'running', '完整的 collect 查进程，认出同一会话还在跑（说明这个场景确实要查进程才知道）')
  assert.equal(o.light.st, 'uncertain', 'light 不查进程：只看记下的进程号（不在了）')
})
