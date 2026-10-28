// 每一轮的真实花费：logs/*.jsonl 里的 costUsd 是这个会话到这一刻的累计（claude -p --resume 的 total_cost_usd），不是这一轮的。
//   核对过：日志里的 costUsd 和她转写里每轮末尾 cost-state.totalCostUSD 一模一样，同一会话的 startTime 一直不变 —— 是累计。
//   一轮花的 = 这一行的累计 − 同一会话上一行的累计；直接加起来会把前面的回合重复算（以前面板就是这么算的，显示的是实际的两倍多）。
//   会话 rotateDays（默认 7）天一换：往前读 8 天，今天第一个回合也能找到同一会话的上一行。
import fs from 'node:fs'
import path from 'node:path'

const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const r6 = (x) => Math.round(x * 1e6) / 1e6            // 两个浮点数相减会带出 0.046799999… 这种尾巴
const isCost = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0

/** 按 at 排好，每一行配上这一轮花的：同一会话跟上一个有数的行相减 */
function deltas(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((l, i) => ({ l, i, t: Date.parse(l?.at) }))
  // 同一时刻按原来的先后（写日志的顺序）；没有时间的排最后、不算（不知道它前面是哪一轮）
  list.sort((a, b) => (Number.isFinite(a.t) ? a.t : Infinity) - (Number.isFinite(b.t) ? b.t : Infinity) || a.i - b.i)
  const prev = new Map()                                // sessionId → 上一个有数的累计
  const out = []
  for (const { l, t } of list) {
    if (!l || typeof l !== 'object') continue
    const c = l.costUsd
    if (!isCost(c) || !Number.isFinite(t)) { out.push({ line: l, costUsd: null }); continue }   // 没记费用（多半是失败 / 超时）：不知道，也不挪「上一行」
    const sid = typeof l.sessionId === 'string' && l.sessionId ? l.sessionId : null
    const p = sid ? prev.get(sid) : undefined
    // 会话第一行（或没记会话的老日志）= 累计本身；累计变小 = 计数从头来过（比如续会话时没接上之前的累计）→ 也按累计本身算
    out.push({ line: l, costUsd: r6(p === undefined || c < p ? c : c - p) })
    if (sid) prev.set(sid, c)
  }
  return out
}

/** lines: [{ at, id, sessionId, costUsd }]，顺序随意 → Map<id, 这一轮花的 | null>（同一个 id 出现两次取后一次） */
export function turnCosts(lines) {
  const m = new Map()
  for (const { line, costUsd } of deltas(lines)) if (line.id != null) m.set(line.id, costUsd)
  return m
}

/** 读最近 days 个本地日期的 <logDir>/<YYYY-MM-DD>.jsonl（从今天往前，按日历一天天退：夏令时那两天「减 24 小时」会跳过 / 重复一天）；坏行跳过 */
export function readTurnLogs(logDir, { days = 8, now = Date.now() } = {}) {
  const n = Math.min(400, Math.max(1, Math.floor(Number(days)) || 8))
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)                               // 从当天中午往回退：中午在任何时区都不落在夏令时切换的那一小时里
  const dates = []
  for (let i = 0; i < n; i += 1) { dates.unshift(localDay(d)); d.setDate(d.getDate() - 1) }
  const lines = []
  for (const day of new Set(dates)) {
    let raw
    try { raw = fs.readFileSync(path.join(logDir, `${day}.jsonl`), 'utf8') } catch { continue }
    for (const l of raw.split(/\r?\n/)) {
      if (!l.trim()) continue
      try { const j = JSON.parse(l.replace(/^﻿/, '')); if (j && typeof j === 'object' && !Array.isArray(j)) lines.push(j) } catch {}
    }
  }
  return lines
}

/** 今天（本地日期，按回合结束的 at）花了多少：前几天的行只当上下文。costUsd = 有数的加起来（一个都没有 → null，不当 0） */
export function todayCost(logDir, { now = Date.now(), days = 8 } = {}) {
  const today = localDay(now)
  const perTurn = deltas(readTurnLogs(logDir, { days, now }))
    .filter(({ line }) => localDay(line.at) === today)
    .map(({ line, costUsd }) => ({ id: line.id ?? null, at: line.at ?? null, costUsd }))
  const known = perTurn.filter((x) => x.costUsd != null)
  return {
    costUsd: known.length ? Math.round(known.reduce((s, x) => s + x.costUsd, 0) * 10000) / 10000 : null,
    known: known.length, unknown: perTurn.length - known.length, perTurn,
  }
}
