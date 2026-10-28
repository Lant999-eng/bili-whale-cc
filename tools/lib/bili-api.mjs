import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withFileLock, renameRetry } from './filelock.mjs'

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  delete values.w_rid
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-22：三样保护（社区实测报告：B站 的 412 是 IP 级限流，换接口救不了）
//   ① 缓存    同一份元信息 24 小时内只问一次 B站
//   ② 退避    撞到 412/风控码就熔断一段时间，不再硬闯
//   ③ 节流    两次请求之间至少隔 300ms
// 背景数字：一轮「刷 5 条 + 深读 2~3」原本要打 25~30 次，而且同一条视频的
//   view 会被 recon/debrief/video/comments/subtitles/quota 各查一遍 ✗
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CACHE_FILE = path.join(HOME, '.bili-ai', 'api-cache.json')
const BAN_FILE = path.join(HOME, '.bili-ai', 'api-ban.json')
const CACHE_TTL_MS = 24 * 3600 * 1000
// 2026-10-22：请求日志 —— 回答「这一趟到底打了几次网络、命中几次缓存」
//   主人问「她那次只查了一次缓存吗」✗ 当时只有「缓存写了几条」这个间接指标 ✗
//   日志按行追加：时间 命中/未命中 路径（不含 cookie、不含响应正文）
const REQ_LOG = path.join(HOME, '.bili-ai', 'api-requests.log')
const logReq = (hit, p) => {
  if (noCacheEnv()) return
  try { fs.appendFileSync(REQ_LOG, `${new Date().toISOString()} ${hit ? 'HIT ' : 'NET '} ${p}\n`) } catch {}
}

// 只缓存「静态一点的元信息」✗ 动态内容（评论/收件箱/动态流/点赞）绝不能缓存 ✓
const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,           // 视频元信息
  /^\/x\/space\/wbi\/acc\/info$/,                 // 用户信息
  // 字幕/播放地址含短期授权，关注关系会变化，必须实时获取。
]
// nav 只缓存 10 分钟（wbi 密钥会轮换），别放进 CACHE_TTL 那套 ✓
const NAV_TTL_MS = 10 * 60 * 1000
// 风控码：撞到就熔断
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])

// 2026-10-22 实测（主人要求验的）：-412 在【播放地址】上不代表限流 ✗
//   大会员专属 / 地区限制 / 番剧独播 都会返回 -412（HTTP 200）✓
//   实测：拿一条「大会员专享」的 playurl 打一次 → 整机被熔断 5 分钟 ✗
//   → 接下来别的视频连元信息都查不了 ✓ 这是误伤 ✓
//   所以：这两个端点上的 -412 只当「这条受限」，不熔断 ✓
const CONTENT_RESTRICTED = [/^\/x\/player\/(wbi\/)?playurl$/]
const isContentRestricted = (p) => CONTENT_RESTRICTED.some((re) => re.test(p))

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
// 原子写（先写临时文件再改名）：以前就地覆盖，别的进程刚好读到写了一半的熔断记录会当成「没熔断」接着发（2026-10-24 审查）
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value))
    try { renameRetry(tmp, file) } finally { fs.rmSync(tmp, { force: true }) }
  } catch {}
}
/** 改熔断记录：在锁里读、改、写（fn 返回 null = 不用改）；锁 5 秒等不到也照改 —— 宁可记上，别漏掉一次风控 */
function updateBan(fn) {
  const apply = () => {
    const prev = readJson(BAN_FILE, {})
    const next = fn(prev && typeof prev === 'object' ? prev : {})
    if (next) writeJson(BAN_FILE, next)
  }
  try { withFileLock(BAN_FILE + '.lock', apply, { waitMs: 5_000 }) } catch { apply() }
}
/**
 * 撞到风控：退避翻倍（5 分钟起，封顶 30 分钟），在锁里接着上一次的次数算；
 * 别的进程刚记下的更长的熔断不会被改短。返回这次停几分钟
 */
function armBan(why, endpoint) {
  let mins = 5
  updateBan((prev) => {
    const streak = Number(prev.streak ?? 0) + 1
    mins = Math.min(30, 5 * 2 ** (streak - 1))
    return { until: Math.max(Number(prev.until ?? 0) || 0, Date.now() + mins * 60_000), why, at: new Date().toISOString(), streak, endpoint }
  })
  return mins
}

// 缓存键：去掉每次都变的签名参数（wts / w_rid）和排序，才可能命中 ✓
function cacheKey(url, headers) {
  const u = new URL(url)
  if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'wts' && k !== 'w_rid')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const h = new Headers(headers)
  const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
  return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
}
const cacheable = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
}
const isNav = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
}

// 2026-10-22：BILI_NO_CACHE=1 → 关掉缓存与熔断（测试用；排障时也能强制走真网络）
const noCacheEnv = () => process.env.BILI_NO_CACHE === "1"   // 每次调用时读（测试里会中途设）

let lastRequestAt = 0
let requestQueue = Promise.resolve()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function throttle() {
  const turn = requestQueue.then(async () => {
    const gap = Date.now() - lastRequestAt
    if (gap < 300) await sleep(300 - gap)
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  return turn
}

function bannedUntilNow() {
  const b = readJson(BAN_FILE, {})
  return Number(b.until ?? 0) > Date.now() ? Number(b.until) : 0
}

// ─── 写操作也走熔断（2026-10-22，对抗审查）：以前只有 apiGet（读）看熔断、也只有读会触发熔断 ——
//     撞到风控之后，评论 / 弹幕 / 私信 / 动态 / 收藏照样往外发，正是 README 说的「撞到风控立刻停手」反过来了
/** 熔断中就返回一句原因（写操作据此不发），否则 null */
export function writeBlocked() {
  if (noCacheEnv()) return null
  const until = bannedUntilNow()
  if (!until) return null
  return `B站 风控退避中（约 ${Math.max(1, Math.round((until - Date.now()) / 60000))} 分钟后恢复）—— 这段时间不发任何东西`
}
/**
 * 读写操作的回包：先按文本读、先看风控（熔断），再试着解析 JSON —— B站 的风控拦截常常是一张 HTML 页面（HTTP 412），
 * 以前直接 res.json() 在解析那一步就崩了，熔断永远记不上。返回解析出的对象（解析不了就是 { raw }），外加 status / riskBlocked
 */
export async function readWriteResult(res, endpoint = 'write') {
  const text = await res.text().catch(() => '')
  let body = null
  try { body = JSON.parse(text) } catch {}
  if (!body || typeof body !== 'object') body = { raw: text.slice(0, 200) }
  noteWriteResult(res.status, body.code, endpoint)
  const riskBlocked = Number(res.status) === 412 || Number(res.status) === 429 || BAN_CODES.has(Number(body.code))
  return Object.assign(body, { _status: res.status, _risk: riskBlocked })
}

/**
 * 写操作的结果算哪一种：'sent'（code 0）· 'rejected'（B站 明确没收 / 风控拦下 → 撤掉预留）·
 * 'uncertain'（回包读不出来、5xx、服务端超时 / 内部错误 → 可能其实已经写进去了 → 预留留着）
 */
const UNSURE_CODES = new Set([-500, -503, -504])
export function writeOutcome(out) {
  if (out?.code === 0) return 'sent'
  if (out?._risk) return 'rejected'
  if (out?.code == null || UNSURE_CODES.has(Number(out.code)) || Number(out._status) >= 500) return 'uncertain'
  return 'rejected'
}

/** 写操作的回包：HTTP 412 / 429，或接口层风控码 → 一样熔断（和读同一套退避：5 分钟起，指数翻倍，封顶 30 分钟） */
export function noteWriteResult(status, code, endpoint = 'write') {
  if (noCacheEnv()) return
  if (!(Number(status) === 412 || Number(status) === 429 || BAN_CODES.has(Number(code)))) return
  const mins = armBan(`写操作 HTTP ${status} code=${code}`, endpoint)
  console.error(`[熔断] 写操作撞到风控（HTTP ${status} code=${code}）→ 停 ${mins} 分钟，期间不发任何东西`)
}

// 说明：读失败仍返回 {code, message} 这种形状，让每个调用方自己决定
// 「元信息必需」还是「可选」。cookie 和响应正文永远不会进日志。
export async function apiGet(input, headers = {}, opts = {}) {
  const url = new URL(input)
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const noCache = opts.noCache === true
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.max(1000, Number(opts.timeoutMs)) : 30000   // 默认 30 秒；调用方可以给更短的
  // ⚠️ 缓存键必须在【改写路径之前】就算好：
  //   「读」用的是原始 /x/web-interface/view?bvid=…，
  //   「写」如果等 url 被改成 /wbi/view?…&w_rid=…（每次都不同）就永远命中不了 ✗
  const key = cacheKey(url.href, headers)
  const canCache = cacheable(url.href) || isNav(url.href)
  const biliHost = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
  // Only stable metadata may be served stale, for at most seven days. Never
  // return old nav identity, relations, or expiring media URLs during a ban.
  const stale = () => {
    if (noCache || noCacheEnv() || !cacheable(url.href)) return null
    const hit = readJson(CACHE_FILE, {})[key]
    return hit?.data?.code === 0 && Date.now() - Number(hit.at ?? 0) < 7 * CACHE_TTL_MS
      ? { ...hit.data, _cached: true, _stale: true } : null
  }

  // ① 熔断中：不再打网络，直接给「等多久」的清楚原因 ✗
  //    （除了 nav —— 它要用来刷新签名密钥，但熔断时也别打 ✓）
  const banned = noCacheEnv() || !biliHost ? 0 : bannedUntilNow()
  if (banned) {
    const mins = Math.max(1, Math.round((banned - Date.now()) / 60000))
    // 熔断期间：能吃到缓存就吃 ✓ 吃不到就明确失败 ✓
    const hit = stale()
    if (hit) return hit
    return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${mins} 分钟后自动恢复（期间用缓存过日子）` }
  }

  // ② 缓存命中
  if (!noCache && canCache && !noCacheEnv()) {
    const hit = readJson(CACHE_FILE, {})[key]
    const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
    if (hit && Date.now() - Number(hit.at ?? 0) < useTtl) { logReq(true, url.pathname); return { ...hit.data, _cached: true } }
  }

  try {
    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers, { noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }

    // ③ 节流：两次请求至少隔 300ms（贴脸连打正是被限流的典型特征 ✗）
    await throttle()
    if (biliHost && !noCacheEnv() && bannedUntilNow()) return stale() ?? { code: -412, message: 'B站风控退避中，请稍后重试' }

    logReq(false, url.pathname)
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(timeoutMs) })

    // HTTP 412/429：平台级风控 → 熔断（默认 5 分钟，指数退避封顶 30 分钟）
    if (biliHost && (response.status === 412 || response.status === 429)) {
      const mins = noCacheEnv() ? Math.min(30, 5 * 2 ** Number(readJson(BAN_FILE, {}).streak ?? 0)) : armBan(`HTTP ${response.status}`, url.pathname)
      const hit = stale()
      if (hit) return hit
      return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
    }
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试；见 README 排障）` }

    const text = await response.text()
    let data
    try {
      // opts.rawFix：解析之前先改一下原文（私信的 msg_key 是 19 位整数，直接解析会丢精度 —— 陌生人私信先给它加上引号，见 tools/lib/sdm.mjs）
      data = JSON.parse(typeof opts.rawFix === 'function' ? opts.rawFix(text) : text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
    } catch {
      return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更；见 README 排障` }
    }

    // 接口层风控码：同样熔断（B站 有时 HTTP 200 但 code=-412）
    if (biliHost && BAN_CODES.has(Number(data.code))) {
      // 先在「内容限制」上排除：-412 来自 playurl → 是这条视频受限，不是限流 ✓
      if (Number(data.code) === -412 && isContentRestricted(url.pathname)) {
        return { ...data, message: `${data.message ?? ''}（这条播放地址受限：大会员专属/地区限制，不是限流）` }
      }
      const mins = noCacheEnv() ? Math.min(30, 5 * 2 ** Number(readJson(BAN_FILE, {}).streak ?? 0)) : armBan(`code=${data.code}`, url.pathname)
      return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
    }
    // 成功了：清掉退避计数，并写缓存
    if (Number(data.code) === 0) {
      // 只在没有熔断生效时清零（在锁里再看一眼）：以前读的是旧记录，别的进程刚记下的新熔断会被这一步整个冲掉
      const b = readJson(BAN_FILE, {})
      if (!noCacheEnv() && b.streak && b.endpoint === url.pathname) {
        updateBan((cur) => (cur.streak && cur.endpoint === url.pathname && !(Number(cur.until ?? 0) > Date.now()) ? { ...cur, streak: 0 } : null))
      }
      if (!noCache && canCache && !noCacheEnv()) {
        const store = readJson(CACHE_FILE, {})
        store[key] = { at: Date.now(), data }
        // 缓存别无限长（保留最近 400 条）
        const keys = Object.keys(store)
        if (keys.length > 400) {
          keys.sort((a, b2) => Number(store[a].at ?? 0) - Number(store[b2].at ?? 0))
          for (const k of keys.slice(0, keys.length - 400)) delete store[k]
        }
        writeJson(CACHE_FILE, store)
      }
    }
    return data
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : '请求失败（网络异常或 WBI 签名密钥无效）' }
  }
}

// 给「依赖体检 / 排障」用的现状
export function apiState() {
  const ban = readJson(BAN_FILE, {})
  const cache = readJson(CACHE_FILE, {})
  const until = Number(ban.until ?? 0)
  return {
    banned: until > Date.now(),
    banMinutesLeft: until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0,
    banWhy: ban.why ?? null,
    cacheEntries: Object.keys(cache).length,
  }
}
