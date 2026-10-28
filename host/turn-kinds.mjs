// 回合种类（2026-10-27，开源第 2 步）。主人的 B站 私信回合（bili-whale-dm-…）是核心自己的；
// QQ 回合、陌生人私信回合由模块报到时登记（host/modules/<名字>.mjs 导出的 turn）。
// 安全上一律「缺了就拒」：
//   · 保留前缀表写死在这里（前缀在 tools/lib/turn-ids.mjs）。模块没装、报到单不完整、加载出错 → 这些前缀的回合一律不跑
//     （宿主丢掉它，日志只记编号和原因，原话不进日志、不推送），绝不当成普通回合用她的主会话、主会话的权限去跑。
//   · isolated（陌生人私信）的收紧也看这张表、不看模块：新开会话、权限只给 sdm / memory（host/claude.mjs permissionArgs）、
//     排在最后、不能插队、排着跑着都不算「在忙」、日志打码。
import { loadModule } from './modules.mjs'
import { QQ_TURN_PREFIX, SDM_TURN_PREFIX, WEB_TURN_PREFIX } from '../tools/lib/turn-ids.mjs'

export const DM_TURN_PREFIX = 'bili-whale-dm-'

// need：报到单的 turn 里少了哪一样就算「不完整」（label 是字，别的都是函数）
const RESERVED = [
  { name: 'qq', prefix: QQ_TURN_PREFIX, owner: true,
    need: ['label', 'check', 'prompt', 'clear', 'replied', 'carryNotes',
      'say.finished', 'say.lost', 'say.repliedStopLog', 'say.repliedStop', 'say.repliedRecord', 'say.quiet', 'say.off', 'say.bindFail'] },
  { name: 'sdm', prefix: SDM_TURN_PREFIX, isolated: true,
    need: ['label', 'check', 'bind', 'clear', 'finish', 'record', 'say.bindFail'] },
  // 读书回合（2026-10-28）：和陌生人回合一样隔离，权限更紧（只有 web / note，见 host/claude.mjs ISOLATED）
  { name: 'web', prefix: WEB_TURN_PREFIX, isolated: true,
    need: ['label', 'check', 'bind', 'clear', 'finish', 'record', 'say.bindFail'] },
]

/** 这个回合编号是哪个保留前缀的 → 表里那一行；不是 → null */
export function reservedOf(id) {
  const s = String(id ?? '')
  return RESERVED.find((r) => s.startsWith(r.prefix)) ?? null
}
/** 陌生人私信那种隔离的回合（只看前缀，不看模块在不在） */
export const isIsolated = (id) => Boolean(reservedOf(id)?.isolated)

const at = (o, p) => p.split('.').reduce((x, k) => (x != null && typeof x === 'object' ? x[k] : undefined), o)
const kinds = new Map()
for (const r of RESERVED) {
  let got
  try {
    const m = await loadModule(r.name)
    if (!m?.mod) got = { why: m?.error ? `${r.name} 模块加载出错（${m.error}）` : `${r.name} 模块没装` }
    else {
      const t = m.mod.turn
      const miss = r.need.filter((p) => (p === 'label' ? typeof at(t, p) !== 'string' : typeof at(t, p) !== 'function'))
      got = miss.length ? { why: `${r.name} 模块的报到单不完整` } : { kind: t }
    }
  } catch (e) { got = { why: `${r.name} 模块加载出错（${e?.name ?? 'Error'}）` } }
  kinds.set(r.name, got)
}

/**
 * 这个回合是哪种 → { r（保留前缀表里那一行；普通回合 → null）, kind（模块登记的 turn；没有 → null）, why（为什么没有：模块没装 / 不完整 / 出错） }。
 * r 有、kind 没有 = 这个回合不能跑
 */
export function turnKind(id) {
  const r = reservedOf(id)
  if (!r) return { r: null, kind: null, why: null }
  const k = kinds.get(r.name)
  return { r, kind: k?.kind ?? null, why: k?.why ?? `${r.name} 模块没装` }
}
