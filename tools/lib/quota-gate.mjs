// 限额闸的统一入口（2026-10-17 加，Kimi 评审 #5：写通道只有 comment 接了闸门 ✗）
//
// 2026-10-22 改（Astra 审查）：以前是 gate()「检查」→ 发网络请求 → record()「记账」，中间不加锁 ——
//   同时发两条，两边都检查通过，额度就被突破了。现在发言工具这样用：
//     const rid = reserve({ type, target, … })   // 判断 + 预留，一步在账本锁里做完（不通过返回 null）
//     …发网络请求…
//     发成功 → commit(rid, { target, note })     // 落账
//     明确失败 → release(rid)                     // 撤掉预留
//     结果不确定（网络异常 / 进程崩了）→ 什么都不做，预留留着照样占额度
//   全部在发言工具自己的进程里做（不起 quota.mjs 子进程）：她在命令行上碰不到记账 / 撤账。
//   gate() 只判断（dry 阶段、编辑动态这种不占额度的写操作用）。
import { checkSpeech, reserveSpeech, commitSpeech, releaseSpeech, recordSpeech } from './ledger.mjs'
import { writeBlocked, noteWriteResult, readWriteResult, writeOutcome } from './bili-api.mjs'
export { writeBlocked, noteWriteResult, readWriteResult, writeOutcome }

const say = (lines) => { for (const l of lines ?? []) console.log(`[限额闸] ${l}`) }

/** 只判断，不占额度。返回 true = 放行 */
export function gate({ type, target = '', auto = true, share = false }) {
  const d = checkSpeech({ type, target, auto, share })
  say(d.lines)
  return d.ok
}

/** 判断 + 预留。返回预留编号（放行）或 null（拦下）。风控熔断中一律不放行 */
export function reserve({ type, target = '', auto = true, share = false, note = '' }) {
  const blocked = writeBlocked()
  if (blocked) { say([`✗ ${blocked}`]); return null }
  let r
  try { r = reserveSpeech({ type, target, auto, share, note }) } catch (e) { say([`✗ ${String(e?.message ?? e)}`]); return null }
  say(r.lines)
  return r.ok ? r.rid : null
}

/** 发出去了：落账 */
export function commit(rid, { type, target, note, share = false } = {}) {
  try { commitSpeech(rid, { type, target, note, share }); console.log('[限额闸] 已记账') } catch (e) { console.log(`[限额闸] 发出去了但记账失败：${String(e?.message ?? e).slice(0, 120)}`) }
}

/** 没发出去：撤掉预留（uncertain = 不知道发没发出去 → 预留留着） */
export function release(rid, { uncertain = false } = {}) {
  try { releaseSpeech(rid, { uncertain }) } catch {}
}

/** 不走预留、直接记一条（主人那边的记录用） */
export function record({ type, target = '', note = '', auto = true, share = false }) {
  const r = recordSpeech({ type, target, note, auto, share })
  say(r.ok ? ['已记账'] : r.lines)
}
