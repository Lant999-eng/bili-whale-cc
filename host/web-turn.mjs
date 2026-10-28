// 读书回合（bili-whale-web-<请求编号>，2026-10-28）在宿主里要做的事：跑之前核对、每一次调 claude 之前写绑定、跑完删绑定和浏览器状态、
// 收尾把请求标成读完 / 拿掉、回合日志里只放宿主自己记的东西。由报到单 host/modules/web.mjs 登记给宿主（turn）。
// 收紧的那几样不在这里、写死在宿主里（模块不在也照样收紧）：新开会话、权限只给 web / note write、环境里没有代理设置、
// 排最后、不能插队、不算「在忙」、时限、不推送（host/claude.mjs ISOLATED、host/turn-kinds.mjs）
import { webOpts, readConfigStrict } from '../tools/lib/config.mjs'
import { getRequest, markRequest, patchRequest, roundsToday, writeBinding, endBinding, seedLinks, readBinding, readVisits, reqIdOfTurn, turnIdOf, APPROVED_TTL_DAYS } from '../tools/lib/webstate.mjs'
import { neutralizeText } from '../tools/lib/neutralize.mjs'

export const label = '读书回合'

/**
 * 跑之前核对 → { cfg }（照跑）/ { why }（悄悄拿掉）/ { why, wait }（配置、账本读不出来：先等着）。
 * 配置严格现读：主人关了读书 → 不跑；请求得是批准了（排着）的、批准不到 7 天、没开始过；今天的轮数用完了 → 先等着（明天再跑）
 */
export function check(item, { readConfigStrict }) {
  const reqId = reqIdOfTurn(item.id)
  if (!reqId || item.source?.platform !== 'web' || item.source?.requestId !== reqId) return { why: '没带来源（不知道是哪一条读书请求）' }
  const r = readConfigStrict()
  if (!r.ok) return { why: r.error, wait: true }
  const o = webOpts(r.cfg)
  if (!o.enabled) return { why: '主人把读书关了' }
  let req
  try { req = getRequest(reqId) } catch (e) { return { why: `读书的账本读不出来（${e?.exitCode ?? 'error'}）`, wait: true } }
  if (!req) return { why: '没有这条读书请求了' }
  // 上一次绑定写到一半宿主没了：请求已经是 started、绑定还是这个回合的 → 照跑（同一轮）
  const resumed = req.status === 'started' && readBinding()?.turnId === item.id
  if (!resumed && !['approved', 'queued'].includes(req.status)) return { why: `这条读书请求现在是「${req.status}」` }
  if (!resumed && !(Date.now() - Date.parse(req.approvedAt ?? req.at) < APPROVED_TTL_DAYS * 86_400_000)) return { why: '这条读书请求批准太久了，作废' }
  let used = 0
  try { used = roundsToday() } catch { return { why: '读书的账本读不出来', wait: true } }
  if (!resumed && used >= o.roundsPerDay) return { why: `今天的 ${o.roundsPerDay} 轮读书用完了，明天再读`, wait: true }
  return { cfg: r.cfg }
}

/**
 * 每一次调 claude 之前：第一次先把请求标成 started（这一天的一轮算用掉），再写绑定、把起点编好号。写不成就抛错（带 turnBind），这一次不调
 */
export function bind(item, timeoutMin) {
  try {
    const reqId = reqIdOfTurn(item.id)
    let req = getRequest(reqId)
    if (req?.status !== 'started') req = markRequest(reqId, 'started', { from: ['approved', 'queued'], extra: { turnId: item.id } })
    if (!req || req.status !== 'started' || turnIdOf(req.id) !== item.id) throw Object.assign(new Error('请求不能开始'), { code: 'ESTATE' })
    const cfg = readCfg()
    const fresh = readBinding()?.turnId !== item.id
    writeBinding({ turnId: item.id, requestId: reqId, timeoutMin, cfg })
    if (fresh) seedLinks(item.id, Array.isArray(req.start) ? req.start : [])
  } catch (e) {
    throw Object.assign(new Error('读书回合的绑定没写成'), { turnBind: true, code: e?.code ?? e?.name ?? 'error' })
  }
}
// 写绑定时要读书的上限（几页、几次搜索、几条笔记）：现读（宿主一直开着，带缓存的那份会过时）；读不出来 → 默认的上限
const readCfg = () => { try { return readConfigStrict() ?? {} } catch { return {} } }

/**
 * 回合结束（成功、失败、抛错、上一个宿主留下的）：先把这一轮用了几次记进请求，再删掉这个回合的绑定和浏览器状态（读过的网页正文）。
 * 访问记录、笔记、指纹留着
 */
export function clear(turnId) {
  endBinding(turnId)
}

/** 这个回合打开过几页、搜过几次、记了几条、读了哪些网站（都是宿主记的，不是她说的） */
function counts(id) {
  const b = readBinding()
  let used = b?.turnId === id ? b.used ?? {} : null
  if (!used) { try { used = getRequest(reqIdOfTurn(id))?.used ?? null } catch {} }
  let hosts = []
  try { hosts = [...new Set(readVisits({ n: 200 }).filter((v) => v.turnId === id && v.ok && v.kind === 'open').map((v) => v.host))] } catch {}
  return { used, hosts }
}

/**
 * 读书回合结束了（跑完、没跑成、上一个宿主留下的、跑之前就拿掉的 —— dropped）：请求标成 done / dropped（只改还没了结的），只记宿主日志，不推送
 */
export function finish(id, { ok, why = '', dropped = false } = {}, log) {
  const reqId = reqIdOfTurn(id)
  if (!reqId) return
  const { used, hosts } = counts(id)
  try {
    markRequest(reqId, dropped ? 'dropped' : 'done', { from: dropped ? ['approved', 'queued', 'started'] : ['started'],
      extra: { ok: Boolean(ok), why: String(why ?? '').slice(0, 80), used: used ?? undefined, hosts: hosts.slice(0, 15) } })
  } catch (e) { log(`读书回合 ${id} 的请求状态没改成（${e?.exitCode ?? e?.name ?? 'error'}）`) }
  if (dropped) return
  log(`读书回合 ${id} ${ok ? '跑完了' : `没跑成${why ? `（${why}）` : ''}`}：打开 ${used?.pages ?? '?'} 页 · 搜索 ${used?.searches ?? '?'} 次 · 笔记 ${used?.notes ?? '?'} 条（不推送）`)
}

/**
 * 回合日志里这一回合记什么：她最后那段话可能被网页带偏 —— 不记；只记请求的题目（醒来那一轮写的、查过的）、次数和读过的网站
 */
export function record(item, res) {
  const reqId = reqIdOfTurn(item.id)
  let topic = ''
  try { topic = neutralizeText(getRequest(reqId)?.topic ?? '', { max: 40 }) } catch {}
  const { used, hosts } = counts(item.id)
  const result = res.hostSaid ? String(res.raw ?? '').slice(0, 200)
    : res.ok ? `读书回合跑完了：打开 ${used?.pages ?? '?'} 页、搜索 ${used?.searches ?? '?'} 次、笔记 ${used?.notes ?? '?'} 条（她最后说的话不进日志；笔记看面板「她读了什么」）`
      : /超时，已终止/.test(String(res.raw ?? '')) ? '超时，已终止（原话不进日志）' : '回合没跑成（出错信息里可能有网页上的字，不进日志）'
  return {
    prompt: `【读书】${topic || '（没有题目）'}（${reqId ?? '?'}）`, result,
    extra: { web: { requestId: reqId, pages: used?.pages ?? null, searches: used?.searches ?? null, notes: used?.notes ?? null, hosts: hosts.slice(0, 15) } },
  }
}

/** 宿主日志里读书回合要说的话（日志不带「[bili-whale-cc] 」，宿主加） */
export const say = {
  bindFail: (id, code) => `读书回合 ${id} 的绑定没写成（${code}），这一次没交给她`,
}
