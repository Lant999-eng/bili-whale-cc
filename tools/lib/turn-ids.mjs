// 宿主排的回合编号前缀（只有常量，什么都不 import）。
// QQ、陌生人私信这两块以后能整块拔掉；核心要在它们不在的时候也认得出这两种编号 ——
// 队列里剩下的这种回合，模块没装就丢掉，绝不能当普通回合在她的主会话里跑（2026-10-27）
export const QQ_TURN_PREFIX = 'bili-whale-qq-'
export const SDM_TURN_PREFIX = 'bili-whale-sdm-'
// 读书回合（2026-10-28）：新开会话、只能 web / note，看不到主人的任何东西
export const WEB_TURN_PREFIX = 'bili-whale-web-'
// 当面聊（cli open，2026-10-28）：不是宿主排的回合，cli open 给她的会话设 bili-whale-open-<13 位毫秒> —— 只为认出「主人在跟她聊」（能交读书请求）
export const OPEN_TURN_PREFIX = 'bili-whale-open-'
// 同样的道理，这两块写下的记录里有私下的来回：模块拔掉以后，留下来的旧记录也不能被当成公开的（2026-10-28，开源第 3 步）
//   额度账本（quota.json）里这几种不是公开发言；观众记忆里这几个 channel 的交流不是评论区的
export const RESERVED_PRIVATE_LEDGER_TYPES = ['sdm']
export const RESERVED_PRIVATE_CHANNELS = ['qq']
