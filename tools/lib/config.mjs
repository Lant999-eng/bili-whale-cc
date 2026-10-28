// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
//
// 为什么要有它（2026-10-14 外部评审指出的最大架构缺口）：
//   在此之前，"个人化的东西"散在四处、形态还不一样 ——
//     ① `~/.bili-ai/quota.json`（额度/白名单，独立文件）
//     ② `~/.dsh/whale-night.config.json`（作息，独立文件）
//     ③ `whale-diary.md` 的叙事段落（偏好被 feed.mjs 解析 Markdown 提取 ✗ 脆弱）
//     ④ 代码里硬编码（历史昵称 SELF_NAMES ✗）
//   使用者的体验是"我得读源码才知道要改哪" ✗ —— 这不是模板，是作者的自用件。
//   现在：**填一个 `bili-whale.config.json` 就完成自定义** ✓，其余全是中性默认值。
//
// 查找顺序：$BILI_WHALE_CONFIG → <数据目录>/bili-whale.config.json（默认 ~/.bili-whale）→ 内置默认值（中性）
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
// ⚠️ 2026-10-21：configPath 必须 **import 进来** 才可用 ✗
//   `export { configPath } from './paths.mjs'` 只是再导出，不会创建本地绑定 →
//   下面 config() 里的 fs.readFileSync(configPath) 会拿到 undefined → 抛错 → 被 catch 吞掉
//   → 静默退回默认值（self / owner / quota / preferences 全部失效）✗ 实测踩到
import { dshPath, configPath } from './paths.mjs'
import { DEFAULT_MAX_VIDEOS } from './night-config.mjs'


const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export { configPath } from './paths.mjs'

// 可拔掉的模块（QQ、陌生人私信，2026-10-28）自己那几段默认值：文件在 = 装了，合进下面的 DEFAULTS（位置和以前一样，存下来的配置一字不差）；
// 不在（公开版）= 配置里没有那几段。这两个小文件什么都不引用，所以这里先等它们读进来不会绕成一圈
const fragment = (f) => (fs.existsSync(new URL(f, import.meta.url)) ? import(f) : null)
const qqFrag = await fragment('./qq-defaults.mjs')
const sdmFrag = await fragment('./sdm-defaults.mjs')

/** 中性默认值：不含任何作者的个人信息，换个人也能跑。 */
export const DEFAULTS = {
  persona: {
    name: '<角色名>',
    ownerTitle: '你',      // 助手怎么称呼使用者
    selfClaim: '我',       // 助手怎么自称
    diaryTitle: '今日摘要', // diary show 的标题（想用自己的口吻就改这里）
  },
  preferences: {
    like: ['科普', '音乐', '美食', '猫'],   // 只是例子：换成你自己的（config set preferences.like "…、…"）
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '', fallback: '' },   // none | desktop | webhook | command | dm …（见 commands/notify.mjs；装了的模块还能多几种）；fallback = 失败时改用的方式
  ...(qqFrag && { qq: { ...qqFrag.QQ_TOOL_DEFAULTS } }),   // 装了 QQ 模块才有（tools/lib/qq-defaults.mjs）
  aliases: [],                  // 历史昵称（兜底用；当前昵称仍从 nav 动态读）
  // 使用者本人（分享型评论要 @ 的人）：mid 用于白名单/查询，name 用于正文里的 @昵称
  // （acc/info 查询会风控，所以 name 缓存一份；改过就用 thread 的 `@到:` 验一下）
  owner: { mid: '', name: '' },
  quota: { shareDaily: 3, autoDaily: 20 },   // autoDaily：她自己发的评论 / 弹幕每天各几条；新装默认 20，写 0 = 不限
  // 「标尺」（2026-10-18 加）：分享前必须打分，不到 share.minScore 就是"今天没有值得发的"（合法结果）
  share: { enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3, silentStopDays: 7 },  // 分享型（@主人）开关与评分阈值
  // 倾听（2026-10-18 补默认值，与设置页对齐）：评论区 + 直播间。装了陌生人私信模块，最后多一个开关（tools/lib/sdm-defaults.mjs）
  listen: { comment: true, commentIntervalSec: 300, scope: 'both', oncePerPerson: false, allDay: false, dm: false, live: false, liveRoom: '', liveScope: 'owner', ...sdmFrag?.SDM_LISTEN_DEFAULTS },
  ...(sdmFrag && { dmStrangers: { ...sdmFrag.SDM_DEFAULTS } }),   // 陌生人私信的细节：装了这个模块才有
  // 读书（2026-10-28，A 版：任何公开网页 + 搜索）：默认关；读书请求默认要主人批准才排队。数都是上限：只有 pagesPerRound 写 0 = 页数不限（一轮还是最长 turnTimeoutMin 分钟），别的没有「0 = 不限」（见下面 webOpts）。
  //   allow：她写读书请求时能给的起点网站（只认这些，按网站名精确比）；block：读书回合里一概不打开的网站（B站 一家另外写死在 webcage 里）
  web: { enabled: false, approve: true, roundsPerDay: 1, pagesPerRound: 15, searchesPerRound: 5, notesPerRound: 3, turnTimeoutMin: 12, engine: 'ddg', reviewNotes: true, allowTun: false,
    allow: ['zh.wikisource.org', 'zh.wikipedia.org', 'en.wikipedia.org', 'ctext.org', 'www.gutenberg.org'], block: [] },
  // 作息：windows[] = 每天允许醒来的时段，每个窗口醒 wakes 次（每个 0–12，一天加起来最多 12 次，见 tools/lib/night-plan.mjs）；
  //   maxVideos = 一轮最多筛几条：新装默认 5，写 0 = 不限
  night: { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: DEFAULT_MAX_VIDEOS },
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    // 默认值那边不是一组设置（数组之类）就从空的开始，不把数组拆成 0 / 1 / 2 这种键（2026-10-25 审查）
    out[k] = isPlain(v) ? merge(isPlain(base?.[k]) ? base[k] : {}, v) : v
  }
  return out
}

// 2026-10-27 搬到这里：出门检查、记忆和几个模块都用它
/**
 * 配置只严格读一次：读不出来（主人手改到一半、多了个逗号）→ null。不能退回默认值去判断 ——
 * 默认是 off，会被当成「主人关掉了」、记下「关过」，下次打开时重新建游标，中间来的消息就悄悄没了
 */
export function readConfigStrict() {
  let text
  try { text = fs.readFileSync(configPath, 'utf8') } catch (e) { return e?.code === 'ENOENT' ? merge(structuredClone(DEFAULTS), {}) : null }
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isPlain(j) ? merge(structuredClone(DEFAULTS), j) : null
  } catch { return null }
}

/** 占位的角色名（新装的配置里是它）：不算真名字 */
export const PERSONA_PLACEHOLDER = '<角色名>'
/**
 * 角色的名字，给面板、小窗的标题用（cli window --top 也按这个名字找小窗：两边都从这里拿）：
 * persona.name 是真名字（不空、不是占位的 <角色名>）就用它（空白压成一个空格、最多 40 个字），不然 'bili-whale'。
 * 和桌宠窗口的标题 'bili-whale pet' 不是一回事（桌宠不是 Edge 窗口，找小窗时不会找到它）
 */
export function personaName(cfg) {
  const n = typeof cfg?.persona?.name === 'string' ? cfg.persona.name.replace(/\s+/g, ' ').trim().slice(0, 40).trim() : ''
  return n && n !== PERSONA_PLACEHOLDER ? n : 'bili-whale'
}

/**
 * 分享开着吗：share 得是一组设置，enabled 没写或者是 true 才算开（2026-10-25 审查）。
 * 以前只认 enabled === false 是关：整段写成 false / "off"，或者 enabled 写成「关」「off」，分享照样开着。没有 share 这一段 = 默认（开）
 */
export const shareEnabled = (cfg) => cfg?.share === undefined || (isPlain(cfg.share) && (cfg.share.enabled === undefined || cfg.share.enabled === true))

/**
 * 分享门槛（share.minScore）：存配置和发之前检查用同一套（2026-10-25 审查）。
 * 没填 = 13；0 到 20 的整数（数，或者写成数的字符串）= 那个数；别的（-1、10.5、空串、true、「十分」）= NaN，分享一律拦下
 */
export function minScoreOf(v) {
  if (v === undefined || v === null) return 13
  if (!isNumberLike(v)) return NaN
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : NaN
}

/**
 * 听评论多久一次（秒）：存配置（host/core.mjs）、宿主的调度器、她的 comment-await 用同一套 ——
 * 空、不是数字（「5分钟」、NaN、Infinity）一律 300；去掉小数，夹在 60 到 86400（一天）之间（2026-10-24 审查）
 */
export function listenIntervalSec(v) {
  return isNumberLike(v) ? Math.min(86_400, Math.max(60, Math.floor(Number(v)))) : 300
}
/**
 * 每天最多 @ 主人几条（quota.shareDaily）：存配置、发之前检查、显示用同一套。返回 Infinity = 不限。
 * - 0（或负数）= 不限（2026-10-25 主人定；以前 0 = 一条也不发 —— 要停分享用 share.enabled false）
 * - 没填、不是数（「3条」、空串、true）= 默认 3：以前拿 NaN 去比，等于不限（2026-10-24 审查）
 * - 去掉小数
 */
export function shareDailyOf(v) {
  if (v === undefined || v === null || !isNumberLike(v)) return 3
  const n = Math.max(0, Math.floor(Number(v)))
  return n === 0 ? Infinity : n
}
/** 显示上限用：不限的写「不限」；算不出来的（NaN）写「?」—— 不能把坏掉的上限显示成不限（2026-10-25 审查） */
export const capText = (n) => (n === Infinity ? '不限' : Number.isFinite(n) ? String(n) : '?')
/**
 * 沉默衰减的两个天数（share.silentAfterDays / silentStopDays）：不是非负的数（「3天」、{}）就用默认 3 / 7；停的那天至少比开始降晚一天。
 * 以前写坏了算出 NaN，每天的上限和沉默衰减一起失效（2026-10-25 审查）。宿主的唤醒提示和她发之前的检查都用它
 */
export function silenceDays(share) {
  const day = (v, d) => (isNumberLike(v) && Number(v) >= 0 ? Math.floor(Number(v)) : d)
  const after = day(share?.silentAfterDays, 3)
  return { after, stopAt: Math.max(after + 1, day(share?.silentStopDays, 7)) }
}
/**
 * 主人沉默了几天：没有表态记录（feedback.last 没有）就从第一次分享算，都没有 = 0；
 * 有记录但读不出来（空串、0、乱码）= stopAt，按「已经停了」算 —— 以前空串 / 0 被当成「刚表态过」，沉默衰减失效（2026-10-25 第三轮审查）。
 * 宿主的唤醒提示和她发之前的检查都用它，两边说法一致
 */
/** 最后一次表态的时间有记录、但读不出来（空串、0、乱码）：silentDaysOf 这时按「已经停了」算，显示时要说「读不出来」，别说成「N 天」（第四轮审查） */
export const reactionUnreadable = (last) => last !== undefined && last !== null && !(typeof last === 'string' && last.trim() && Number.isFinite(new Date(last).getTime()))
export function silentDaysOf(last, firstShareAt, stopAt, now = Date.now()) {
  const daysSince = (at) => {
    const t = typeof at === 'string' && at.trim() ? new Date(at).getTime() : NaN
    return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : stopAt
  }
  if (last === undefined || last === null) return firstShareAt === undefined || firstShareAt === null ? 0 : daysSince(firstShareAt)
  return daysSince(last)
}
/**
 * 她自己发的评论 / 弹幕每天几条（quota.autoDaily）：存配置和发之前检查用同一套 —— 没写 = 默认值（新装 20）；空串 = 0（不限）；数（负数当 0，去掉小数）；
 * 别的（「5条」、true、[]、空白）= NaN，表示主人想设上限但写错了（以前两边读法不同：存的时候说「先停着」，检查时 true 却成了每天 1 条，2026-10-24 复核）
 */
export function autoDailyOf(v) {
  if (v === undefined || v === null) return DEFAULTS.quota.autoDaily
  if (v === '') return 0
  return isNumberLike(v) ? Math.max(0, Math.floor(Number(v))) : NaN
}
/**
 * 陌生人私信模块的几个读法（2026-10-25）：模块的宿主、工具这边都从这里拿。模块没装（公开版，没有 sdm-defaults.mjs）：
 * 开关一律 off（手改配置写了 on 也不会变成开着），几个数是空的，两个时长按模块的老默认值算（核心万一碰到这种回合也有个上限）
 */
const SDM_D = DEFAULTS.dmStrangers ?? {}
/**
 * 陌生人私信的开关（listen.dmStrangers）：只认 'observe' 和 'on' 这两个写法，别的（没写、true、'ON'、'开'）一律 'off'（2026-10-25）。
 * 宿主的调度器读的是原始配置，也用它
 */
export const dmStrangersMode = (cfg) => { if (!sdmFrag) return 'off'; const v = cfg?.listen?.dmStrangers; return v === 'observe' || v === 'on' ? v : 'off' }
/**
 * 陌生人私信的几个数（dmStrangers 段）：不是非负的数（「10条」、-1、true）就用默认值；去掉小数。0 照原样（各处当「不限 / 关」）
 */
export function dmStrangersOpts(cfg) {
  const d = SDM_D
  const s = isPlain(cfg?.dmStrangers) ? cfg.dmStrangers : {}
  const out = {}
  for (const k of Object.keys(d)) out[k] = isNumberLike(s[k]) && Number(s[k]) >= 0 ? Math.floor(Number(s[k])) : d[k]
  return out
}
/** 陌生人私信多久看一次会话列表（秒；o = dmStrangersOpts 的结果）：0 = 默认 60，至少 30（B站 接口经不起太勤）—— 宿主的调度器和存配置的提醒用同一套 */
export const sdmIntervalSec = (o) => (Number(o?.intervalSec) > 0 ? Math.max(30, Math.floor(Number(o.intervalSec))) : SDM_D.intervalSec ?? 60)
/** 陌生人回合最多跑几分钟：0 = 默认 8，夹在 2 到 60 之间（宿主结束回合、回合绑定过期、存配置的提醒用同一套） */
export const sdmTurnMin = (o) => (Number(o?.turnTimeoutMin) > 0 ? Math.min(60, Math.max(2, Math.floor(Number(o.turnTimeoutMin)))) : SDM_D.turnTimeoutMin ?? 8)
// 读书的几个数：[最小, 最大]（写错了、超出范围 → 夹到范围里；不是数 → 默认值）。
// 只有 pagesPerRound 写的正好是 0 = 页数不限（2026-10-28 主人定；一轮还是有时限 turnTimeoutMin）；负数、0.5 这类写错的照样夹到 1–60。
// 别的没有「0 = 不限」（searchesPerRound 0 = 不搜）
const WEB_RANGE = { roundsPerDay: [1, 24], pagesPerRound: [1, 60], searchesPerRound: [0, 20], notesPerRound: [1, 10], turnTimeoutMin: [3, 30] }
/** 网站名的统一写法（小写、去掉结尾的点）；不像网站名的（带 / : @ 空白、空的）→ '' */
const hostOf = (h) => { const s = String(h ?? '').trim().toLowerCase().replace(/\.+$/, ''); return /^[a-z0-9.-]{1,253}$/.test(s) && s.includes('.') ? s : '' }
/**
 * 读书的设置（web 段，2026-10-28）：enabled 只认 true；approve 只有写 false 才关（没写、写坏了都算要批准）；
 * 数夹在 WEB_RANGE 里；allow / block 是网站名的数组（不像网站名的丢掉）；engine 只认 ddg / bing
 */
export function webOpts(cfg) {
  const d = DEFAULTS.web
  const s = isPlain(cfg?.web) ? cfg.web : {}
  const out = { enabled: s.enabled === true, approve: s.approve !== false, engine: s.engine === 'bing' ? 'bing' : 'ddg' }
  for (const [k, [lo, hi]] of Object.entries(WEB_RANGE)) out[k] = isNumberLike(s[k]) ? Math.min(hi, Math.max(lo, Math.floor(Number(s[k])))) : d[k]
  if (isNumberLike(s.pagesPerRound) && Number(s.pagesPerRound) === 0) out.pagesPerRound = 0   // 页数不限
  out.reviewNotes = s.reviewNotes !== false
  out.allowTun = s.allowTun === true
  out.allow = [...new Set((Array.isArray(s.allow) ? s.allow : d.allow).map(hostOf).filter(Boolean))]
  out.block = [...new Set((Array.isArray(s.block) ? s.block : d.block).map(webBlockEntry).filter(Boolean))]
  return out
}
/** web.block 的一项：网站名，或者 IP / 网段（203.0.113.7、198.51.100.0/24、2001:db8::/32）→ 规范写法；不像的 → '' */
export function webBlockEntry(x) {
  const s = String(x ?? '').trim().toLowerCase()
  const m = /^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/.exec(s)
  const v = m ? net.isIP(m[1]) : 0
  // ::ffff: 写法的 IPv4 网段笼子按 IPv4 算、对不上前缀长度：不收，让主人直接写 IPv4
  if (v && !m[1].startsWith('::ffff:') && (m[2] === undefined || Number(m[2]) <= (v === 4 ? 32 : 128))) return s
  // 像 IP 却不是合格写法的（前导零 203.000.113.020、错的前缀）：不当成网站名收下（不然主人以为挡了，其实没挡）
  if (/^[\d.]+(?:\/\d*)?$/.test(s) || s.includes(':') || s.includes('/')) return ''
  return hostOf(s)
}
/** 读书回合最多跑几分钟（o = webOpts 的结果） */
export const webTurnMin = (o) => (Number(o?.turnTimeoutMin) > 0 ? Number(o.turnTimeoutMin) : DEFAULTS.web.turnTimeoutMin)
/** 是不是一个数（数字，或者写成数字的字符串）—— 布尔值、数组、空串都不算（Number(true) = 1、Number([]) = 0 会混进来） */
export const isNumberLike = (v) => typeof v === 'number' ? Number.isFinite(v)
  : typeof v === 'string' && /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(v) && Number.isFinite(Number(v))

let cache = null
/** 读取合并后的配置（带缓存）。 */
export function config() {
  if (cache) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没配置就用默认 */ }   // 记事本存的 UTF-8 带 BOM
  cache = merge(structuredClone(DEFAULTS), user)
  cache.__hasUserFile = Object.keys(user).length > 0
  return cache
}
