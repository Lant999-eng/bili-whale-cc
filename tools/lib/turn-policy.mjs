// 哪种回合能用哪些 bili.mjs 命令（2026-10-28，读书回合）。只看宿主设的回合编号（BILI_WHALE_TURN，她改不了），不读文件、不联网。
// tools/bili.mjs 入口、host/bash-gate.mjs 钩子、host/claude.mjs 权限规则三处都用这一份；命令自己再查一遍（读书的还要对上宿主写的绑定）。
//   · 读书回合（bili-whale-web-…）：只有 web（search / open / more / page）和 note（write）。别的一概不行，help 也不给
//   · 陌生人私信回合（bili-whale-sdm-…）：只有 sdm、memory（和以前一样）
//   · 别的回合：web、note 一律不行（知道主人私事的她碰不到网页）；
//     read-request 只在醒来那一轮（按作息醒来 bili-whale-<13 位毫秒>、主人叫醒 manual-<13 位毫秒>）和主人跟她聊天的时候
//     （小窗 bili-whale-win-<13 位毫秒>-<4 位十六进制>、当面聊 bili-whale-open-<13 位毫秒>，2026-10-28 主人定）—— 读完的笔记只附在醒来那一轮。
//     QQ、主人私信、评论、直播间、认不出的编号、没有编号都不行
import { SDM_TURN_PREFIX, WEB_TURN_PREFIX, OPEN_TURN_PREFIX } from './turn-ids.mjs'

export const READER_ONLY = ['web', 'note']
export const READER_ACTIONS = { web: ['search', 'open', 'more', 'page'], note: ['write'] }
export const SDM_ONLY = ['sdm', 'memory']
export const WAKE_ONLY = ['read-request']   // 名字是老的：醒来那一轮 + 主人跟她聊天的回合（canRequestReading）
/** 醒来那一轮的编号（和 tools/lib/letters.mjs 的 WRITE_TURN_RE 同一个样子） */
export const WAKE_TURN_RE = /^(bili-whale-\d{13}|manual-\d{13})$/
/** 主人跟她聊天的回合：小窗（和 host/winchat.mjs 的 WIN_ID_RE 同一个样子）、当面聊（cli open 设的） */
export const CHAT_TURN_RE = new RegExp(`^(bili-whale-win-\\d{13}-[0-9a-f]{4}|${OPEN_TURN_PREFIX}\\d{13})$`)

export const isReaderTurn = (id) => String(id ?? '').startsWith(WEB_TURN_PREFIX)
export const isSdmTurn = (id) => String(id ?? '').startsWith(SDM_TURN_PREFIX)
export const isWakeTurn = (id) => WAKE_TURN_RE.test(String(id ?? ''))
export const isOwnerChatTurn = (id) => CHAT_TURN_RE.test(String(id ?? ''))
/** 能交读书请求的回合：醒来那一轮，或主人在小窗 / 当面跟她聊 */
export const canRequestReading = (id) => isWakeTurn(id) || isOwnerChatTurn(id)
export const READ_REQUEST_WHERE = 'read-request 只在醒来那一轮（按作息醒来、主人叫醒你）和主人跟你聊天的时候（小窗、当面聊）能用'

/**
 * 这一回合能不能跑 node bili.mjs <cmd> <action> … → { ok } / { ok:false, why }（why 给她看）。
 * cmd 是空的（光秃秃的 node bili.mjs）或 help：读书回合、陌生人回合都不行，别的回合行
 */
export function commandAllowed(cmd, action, turn) {
  const c = String(cmd ?? '')
  const bare = !c || c === 'help' || c === '-h' || c === '--help'
  if (isReaderTurn(turn)) {
    if (bare || !READER_ONLY.includes(c)) return { ok: false, why: `读书回合里只能用 web（search / open / more / page）和 note write${bare ? '' : `—— ${c.slice(0, 30)} 这里不能用`}` }
    if (!READER_ACTIONS[c].includes(String(action ?? ''))) return { ok: false, why: `读书回合里 ${c} 只能 ${READER_ACTIONS[c].join(' / ')}` }
    return { ok: true }
  }
  if (isSdmTurn(turn)) {
    if (bare || !SDM_ONLY.includes(c)) return { ok: false, why: `陌生人私信回合里只能用 sdm（回 TA）和 memory（只限 TA）${bare ? '' : `—— ${c.slice(0, 30)} 这里不能用`}。要主人知道的事：sdm flag --kind … --note "…"` }
    return { ok: true }
  }
  if (READER_ONLY.includes(c)) return { ok: false, why: `${c} 只在宿主单独开的读书回合里能用。想读什么：醒来那一轮或主人跟你聊天的时候用 read-request --topic "…"` }
  if (WAKE_ONLY.includes(c) && !canRequestReading(turn)) return { ok: false, why: READ_REQUEST_WHERE }
  return { ok: true }
}

/** 这一回合 help 里列哪些命令（和 commandAllowed 一致；只看命令名） */
export const listedIn = (cmd, turn) => commandAllowed(cmd, isReaderTurn(turn) ? READER_ACTIONS[cmd]?.[0] : '', turn).ok
