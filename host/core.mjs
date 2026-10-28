/**
 * bili-whale-cc —— 宿主的"设置页"那一半（移植自 DSH 插件的 lib/index.js）
 *
 * DSH 版靠网页设置页 + HTTP 路由；Claude Code 版没有常驻网页，改成一组普通函数，
 * 由 host/cli.mjs（命令行）和 host/daemon.mjs（常驻宿主）调用。逻辑与校验保持原样：
 *   · 配置：顶层白名单 + 范围校验，写到 bili-whale.config.json（与工具链共用一份）
 *   · 凭据：单独写 ~/.bili-ai/credentials.json，永远不回显；写完立刻问 nav 确认是哪个号
 *   · 人设：~/.bili-ai/persona.md（只影响她）
 *   · 待审回复：approve 失败要把草稿放回队列，别悄悄丢掉
 */
import './env.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOME, DSH_HOME, AI_HOME, configPath, credentialsPath } from '../tools/lib/paths.mjs'
import { resolveRuntime } from '../tools/lib/runtime.mjs'
import { updateJsonLocked, renameRetry } from '../tools/lib/filelock.mjs'
import { listenIntervalSec, isNumberLike, autoDailyOf, shareDailyOf, minScoreOf, shareEnabled, webBlockEntry, DEFAULTS as TOOL_DEFAULTS } from '../tools/lib/config.mjs'
import { optionalHook } from './modules.mjs'
import { RESERVED_PRIVATE_LEDGER_TYPES } from '../tools/lib/turn-ids.mjs'
import { videosPerWake, DEFAULT_MAX_VIDEOS } from '../tools/lib/night-config.mjs'
import { wordList, wordListProblem, joinedWords } from '../tools/lib/prefs.mjs'
import { listReferences, referenceOverlap } from '../tools/lib/reference.mjs'
import { describeHit, scriptText } from '../tools/lib/originality.mjs'
// 读书（可拔掉的模块）：装了才在投稿前和她读过的网页再比一遍；没装 = 没读过网页
let webOverlap = null
try { ({ webOverlap } = await import('../tools/lib/webstate.mjs')) } catch {}
import {
  STUDIO_DEFAULTS, STUDIO_PY, VENV_DIR, IMAGE_KEY_FILE, venvPython, studioConfig, projectDir, readMeta, writeMeta,
  pendingVideos, savePendingVideos, reviewDir, markRejected, acquireUploadLock, releaseUploadLock, readUploadLock, uploadLockLive, publishedRecord, markPublished,
  withQueueLock, dequeueVideo, uploadCopy, reviewRecords, readJson, subId, readAttempts, addUncertainAttempt, resolveAttempts, crashedLockToAttempt, notePublishedDuplicate,
  voxcpmPathProblem, VOXCPM_TUNING,
} from '../tools/lib/studio.mjs'

// 可拔掉的模块自己的那几段设置（2026-10-28，第 3 步）：默认值、校验、推送方式各由模块的设置钩子带来（host/<模块>-config.mjs）；
// 没装 = 没有那几段。顺序有用：先陌生人私信、后 QQ（和拆开之前一样）。钩子长什么样见 host/sdm-config.mjs、host/qq-config.mjs：
//   section / slot（默认值、「可选的设置」里排在哪一段后面）/ defaults / listenDefaults / notifyKinds / notifyExample / privateLedgerTypes，
//   校验分三处：afterListen（listen 段之后）、afterStudio（studio 段之后、推送之前）、afterNotify（推送之后）
//   钩子不完整（少了该有的校验）就当装坏了：抛出来，和加载出错一样 —— 绝不少校验一处、照样存（缺了就拒）
const CFG_NEED = { sdm: ['section', 'slot', 'defaults', 'afterListen', 'afterNotify'], qq: ['section', 'slot', 'defaults', 'afterStudio'] }
const cfgHook = async (name) => {
  const h = await optionalHook(name, `${name}-config.mjs`)
  const miss = h ? CFG_NEED[name].filter((k) => h[k] == null || (/^after/.test(k) && typeof h[k] !== 'function')) : []
  if (miss.length) throw new Error(`${name} 模块的设置钩子不完整（少了 ${miss.join('、')}）`)
  return h
}
const CFG_HOOKS = [await cfgHook('sdm'), await cfgHook('qq')].filter(Boolean)
/** 排在 key 后面的那几段模块默认值 */
const hookDefaults = (key) => Object.fromEntries(CFG_HOOKS.filter((h) => h.slot.defaults === key).map((h) => [h.section, { ...h.defaults }]))
/** 「可选的设置」里排在 key 后面的那几段 */
const hookKnown = (key) => CFG_HOOKS.filter((h) => h.slot.known === key).map((h) => h.section)
/** 推送方式：核心的几种，模块登记的排在 dm 后面（和拆开之前列出来的顺序一样） */
const NOTIFY_KINDS = ['none', 'desktop', 'webhook', 'command', 'dm', ...CFG_HOOKS.flatMap((h) => h.notifyKinds ?? []), 'stdout', 'file']
const NOTIFY_EXAMPLE = CFG_HOOKS.find((h) => h.notifyExample)?.notifyExample ?? 'config set notify.type webhook / config set notify.fallback desktop'
/** quota.json 里不算「对外发言」的几种记录（模块登记的，面板另有一栏） */
//   模块没装也照样挡核心记着的那几种（tools/lib/turn-ids.mjs：拔掉以后留下的旧记录不能变成公开的）
const PRIVATE_LEDGER = new Set([...RESERVED_PRIVATE_LEDGER_TYPES, ...CFG_HOOKS.flatMap((h) => h.privateLedgerTypes ?? [])])
/** 三处校验：按钩子的顺序挨个跑，哪个要挡就停 */
const runHooks = (phase, ctx) => {
  for (const h of CFG_HOOKS) { const e = h[phase]?.(ctx); if (e) return e }
  return null
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BILI_MJS = path.join(ROOT, 'tools', 'bili.mjs')
export const CFG_FILE = configPath
export const CRED_FILE = credentialsPath
export const PERSONA_FILE = path.join(HOME, '.bili-ai', 'persona.md')
export const PENDING_FILE = path.join(HOME, '.bili-ai', 'pending-replies.json')
export const WORK_DIR_DEFAULT = AI_HOME   // 她的家（她唯一能写的目录），见 tools/lib/paths.mjs
export const HOST_DIR = path.join(DSH_HOME, 'whale-cc')        // 宿主自己的状态：会话 id、队列、日志、pid
// 她的会话专用的 Claude Code 配置目录（CLAUDE_CONFIG_DIR）：她自己的登录、设置、守则、会话记录都在这里，
// 和你自己的 ~/.claude、~/.claude.json 完全分开 —— 你给自己开的权限、hooks、插件、MCP 一样都不会带进她的会话（Astra 审查 P1-3）
export const AGENT_CONFIG_DIR = path.join(HOST_DIR, 'claude-config')
export { HOME, DSH_HOME }

/** 默认配置（与 DSH 版 lib/index.js 对齐，多一段 claude） */
export const DEFAULTS = {
  owner: { mid: '', name: '' },
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    minGapMin: 10, maxVideos: DEFAULT_MAX_VIDEOS,   // 一轮最多筛几条：新装默认 5；0 = 不限（2026-10-24 主人给自己取消了这个上限）
  },
  preferences: {
    like: structuredClone(TOOL_DEFAULTS.preferences.like),   // 只是例子，和工具那边同一份（tools/lib/config.mjs）
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    keywords: [],
  },
  quota: { shareDaily: 3, autoDaily: TOOL_DEFAULTS.quota.autoDaily },   // autoDaily：她自己发的评论 / 弹幕每天各几条（新装默认 20），0 = 不限
  diary: { push: true, enabled: true },
  // 给明天的信（2026-10-26，记忆方案第二项）：她醒来那一轮写给明天的自己的便条，下次醒来附上最近两封（见 tools/lib/letters.mjs）。
  // 默认关（没写也是关）：主人重启宿主时再打开 —— config set letters.enabled true；false 随时关，不用重启
  letters: { enabled: false },
  // 读书（2026-10-28，A 版）：她在醒来那一轮、主人跟她聊天的回合（小窗、当面聊）写「想读什么」，主人批了以后宿主单独开一轮去读（见 tools/lib/webstate.mjs）。默认关
  web: structuredClone(TOOL_DEFAULTS.web),
  persona: { name: '', ownerTitle: '主人', selfClaim: '我' },
  self: { mid: '', name: '' },
  notify: { type: 'none', url: '', template: 'text', cmd: '', fallback: '' },   // fallback：主推送失败时改用的方式
  ...hookDefaults('notify'),                   // 模块的段排在这里（见上面 CFG_HOOKS）
  // listen 段最后可以多几个模块的开关（listenDefaults）
  listen: { comment: true, commentIntervalSec: 300, scope: 'both', oncePerPerson: false, allDay: false, dm: false, live: false, liveRoom: '', liveScope: 'owner', ...Object.assign({}, ...CFG_HOOKS.map((h) => h.listenDefaults)) },
  ...hookDefaults('listen'),
  share: { enabled: true, via: 'comment', minScore: 13, silentAfterDays: 3, silentStopDays: 7 },
  // Claude Code 怎么跑她
  claude: {
    path: '',                       // 空 = 自动找（PATH / Claude 桌面版自带的 claude.exe）
    model: '',                      // 空 = Claude Code 默认
    rotateDays: 7,                  // 同一个会话最多续几天，之后换新会话（靠日记接上），免得上下文无限长
    timeoutMin: 25,                 // 一个回合最长多久
  },
  studio: STUDIO_DEFAULTS,          // 她自己做视频 / 发动态（见 tools/lib/studio.mjs）
}

const KNOWN = new Set(['persona', 'preferences', 'notify', 'aliases', 'owner', 'self', 'quota', 'share', 'listen', ...hookKnown('listen'), 'diary', 'letters', 'web', 'night', 'claude', 'studio', ...hookKnown('studio')])

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const ONOFF = { true: true, false: false, on: true, off: false, yes: true, no: false, '开': true, '关': false, '1': true, '0': false }
export const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    // 底下原来不是一组设置（false、字符串、数组）时从空的开始：以前 {..."off"} 会冒出 0 / 1 / 2 这种键（2026-10-25 审查）
    out[k] = isPlain(v) ? merge(isPlain(base?.[k]) ? base[k] : {}, v) : v
  }
  return out
}

export function readConfig() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { /* 没配就用默认 */ }
  return merge(structuredClone(DEFAULTS), user)
}

/**
 * 严格地读配置：没有文件 = 默认值（ok）；有文件但读不出来（多了个逗号…）= 不 ok。
 * 写凭据这种事要先核对「是不是你自己的号」—— 配置读不出来时 readConfig() 会悄悄退回默认值（主人 mid 是空的），
 * 那样既核对不了，回写时还会把你的整份配置冲成默认值。所以登录那两条路用这个，读不出来就不写。
 * → { ok: true, cfg（和默认值合并后的）, raw（文件里原样的） } | { ok: false, error }
 */
export function readConfigStrict() {
  let text
  try { text = fs.readFileSync(CFG_FILE, 'utf8') } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, cfg: merge(structuredClone(DEFAULTS), {}), raw: {} }
    return { ok: false, error: `配置文件打不开（${e?.code ?? e?.message}）：${CFG_FILE}` }
  }
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是一个 JSON 对象')
    return { ok: true, cfg: merge(structuredClone(DEFAULTS), raw), raw }
  } catch (e) { return { ok: false, error: `配置文件读不出来（${String(e?.message ?? e).slice(0, 80)}）：${CFG_FILE} —— 先修好它：node host/cli.mjs config edit` } }
}
/** 只改配置里的「她的号」：在文件原样内容上改这一项（不把默认值写回去）；读不出来就抛错，不冲掉 */
export function setSelf(self) {
  const r = readConfigStrict()
  if (!r.ok) throw new Error(r.error)
  writeConfig({ ...r.raw, self })
}

export function writeConfig(next) {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  const tmp = CFG_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameRetry(tmp, CFG_FILE)   // Windows 上别的进程（宿主每 5 秒看一次、本地面板）正读着时改名会短暂 EPERM：重试
}

/**
 * 保存设置（等价于 DSH 版 POST /api/settings）：只收认识的顶层键，做范围校验。
 * 返回 { ok, config, schedulingChanged, warn } —— 宿主看到配置文件变了会自己重排生物钟。
 */
export function saveSettings(incoming) {
  // 配置文件读不出来（多了个逗号…）时别在默认值上改了再整份写回去 —— 那样会把你的主人 mid、推送、人设全冲掉
  const conf = readConfigStrict()
  if (!conf.ok) return { ok: false, error: conf.error }
  const cur = conf.cfg
  const filtered = {}
  for (const [k, v] of Object.entries(incoming || {})) if (KNOWN.has(k)) filtered[k] = v
  // share 原来不是一组设置（"share": false 这种）、这次整段给了一组：从「默认值 + 分享先关着」开始合并 ——
  // 以前从空的开始，开关一丢就成了「开」（2026-10-25 审查）
  const shareWasBroken = Object.hasOwn(filtered, 'share') && !isPlain(cur.share) && isPlain(filtered.share)
  if (shareWasBroken) filtered.share = { ...DEFAULTS.share, enabled: false, ...filtered.share }
  const next = merge(cur, filtered)
  // 这一次 config set 改的就是这一段：不对直接报错；改的是别的段（手改配置 / 旧版本留下的怪值）：能收拾的收拾掉，收拾不了的只提醒，
  // 不挡这次保存 —— 以前两个旧值互相卡住时，config set 哪个都改不了（2026-10-24 复核）
  const touched = (k) => Object.hasOwn(filtered, k)
  // 这次改的就是这一项（同一段里别的旧值坏了不算）
  const changed = (k, leaf) => touched(k) && JSON.stringify(cur[k]?.[leaf]) !== JSON.stringify(next[k]?.[leaf])
  const warnsEarly = []
  // 这次改的就是这一段：报错；不是：原样留着、只提醒（2026-10-25 第三轮审查：以前一个坏掉的作息窗口 / 推送地址，连 config set share.enabled false 都挡）
  // 按项判断（第四轮审查）：同一段里两个旧值都坏了，以前改哪个都被另一个挡住；改 studio.enabled 也被坏掉的配音路径挡住
  const sameVal = (a, b) => (a === null || typeof a !== 'object') && (b === null || typeof b !== 'object')
    ? String(a ?? '').trim() === String(b ?? '').trim() : JSON.stringify(a) === JSON.stringify(b)
  const leafChanged = (k, p) => touched(k) && !sameVal(p.reduce((o, x) => o?.[x], cur[k]), p.reduce((o, x) => o?.[x], next[k]))
  const refuseOrWarn = (k, paths, msg) => {
    if (paths.some((p) => leafChanged(k, Array.isArray(p) ? p : [p]))) return { ok: false, error: msg }
    warnsEarly.push(`配置里 ${k} 有一项不对（这次没改它，原样留着）：${msg}`)
    return null
  }
  // 哪一段整段被写成了一个值（config set listen true、手改成 "studio": false 这种）：以前要么悄悄存下去、要么直接崩，
  // 连 config set share.enabled false 都会被一个坏掉的 studio / night 挡住（2026-10-24 复核；2026-10-25 审查推广到每一段）。
  // share / preferences 在下面单独管（share 坏了要关着，不能换回默认的「开」）
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'share' || k === 'preferences' || !isPlain(DEFAULTS[k])) continue
    if (next[k] === undefined || isPlain(next[k])) continue
    if (touched(k)) return { ok: false, error: `${k} 要逐项设：config set ${k}.<哪一项> <值>` }
    next[k] = structuredClone(DEFAULTS[k])
    warnsEarly.push(`配置里的 ${k} 不是一组设置，换回了默认值`)
  }
  const n = next.night
  const badWin = !Array.isArray(n.windows) || !n.windows.length ? null
    : n.windows.find((w) => !isPlain(w) || !/^\d{1,2}:\d{2}$/.test(String(w.start)) || !/^\d{1,2}:\d{2}$/.test(String(w.end)))
  const winWhy = !Array.isArray(n.windows) || !n.windows.length ? '至少要有一个作息窗口'
    : badWin !== undefined ? `作息窗口格式不对：${JSON.stringify(badWin)}（要 HH:MM）` : null
  if (winWhy) { const e = refuseOrWarn('night', ['windows'], winWhy); if (e) return e }
  n.maxWakesPerDay = Math.min(12, Math.max(0, Number(n.maxWakesPerDay ?? 0) || 0))
  n.skipChance = Math.min(0.95, Math.max(0, Number(n.skipChance) || 0))
  n.minGapMin = Number.isFinite(Number(n.minGapMin)) ? Math.max(1, Number(n.minGapMin)) : 10
  n.maxVideos = videosPerWake(n.maxVideos)   // 0 = 不限；以前最多只能设 20
  // 每天最多 @ 主人几条：0 = 不限（2026-10-25 主人定，以前 0 = 一条也不发、最多 20）；「不限」也认；
  // 不是数（「3条」、空串、true）：这次改的是 quota 就报错，不然按默认 3 存并提醒（和发之前的检查同一套：shareDailyOf）
  const sd = next.quota.shareDaily
  if (sd === '不限') next.quota.shareDaily = 0
  else if (isNumberLike(sd)) next.quota.shareDaily = Math.max(0, Math.floor(Number(sd)))
  else if (sd !== undefined && changed('quota', 'shareDaily')) return { ok: false, error: `quota.shareDaily 只能是 0 或正整数（0 = 不限）：${String(sd).slice(0, 20)}` }
  else {
    if (sd !== undefined) warnsEarly.push(`配置里 quota.shareDaily 不是数字（${String(sd).slice(0, 20)}）：按默认每天 3 条存了 —— 要不限：node host/cli.mjs config set quota.shareDaily 0`)
    next.quota.shareDaily = 3
  }
  // 她自己发的评论 / 弹幕每天几条（0 = 不限）、听评论多久一次：以前不校验，填成「5条」存进去以后比较出 NaN，限额 / 间隔直接失效（2026-10-24 审查）
  const ad = next.quota.autoDaily
  const adNum = autoDailyOf(ad)   // 和发之前的检查同一套读法（负数：旧版本存的 -1 就是不限，按 0 存）
  if (Number.isFinite(adNum)) next.quota.autoDaily = adNum
  else if (changed('quota', 'autoDaily')) return { ok: false, error: `quota.autoDaily 只能是 0 或正整数（0 = 不限）：${ad}` }   // 按项判断（第五轮审查）
  else warnsEarly.push(`配置里 quota.autoDaily 不是数字（${String(ad).slice(0, 20)}）：她自己发的评论 / 弹幕先停着 —— 改成数字：node host/cli.mjs config set quota.autoDaily 0`)
  if (next.listen.commentIntervalSec !== undefined) {
    const raw = next.listen.commentIntervalSec
    const bad = raw !== null && raw !== '' && !isNumberLike(raw)
    if (bad && changed('listen', 'commentIntervalSec')) return { ok: false, error: `listen.commentIntervalSec 只能是秒数（60 到 86400）：${raw}` }
    if (bad) warnsEarly.push(`配置里 listen.commentIntervalSec 不是秒数（${String(raw).slice(0, 20)}）：换成了默认的 300 秒`)   // 按项判断（第五轮审查）
    next.listen.commentIntervalSec = listenIntervalSec(raw)   // 和调度器、comment-await 同一套：空 / 不是数字 = 300，夹在 60 到 86400 之间
  }
  // 模块的校验（第一处，和拆开之前同一个位置）：比如陌生人私信的开关和那几个数
  const ctx = { cur, next, changed, refuseOrWarn, warnsEarly, warnsLate: [], notifyKinds: NOTIFY_KINDS }
  { const e = runHooks('afterListen', ctx); if (e) return e }
  // 历史昵称 aliases：一组名字。以前不校验，写成 5 / {} 存进去，直播间弹幕监听一启动就崩（2026-10-25 第四轮审查）
  if (next.aliases !== undefined) {
    const al = next.aliases
    if (Array.isArray(al) || typeof al === 'string' || (typeof al === 'number' && Number.isFinite(al))) next.aliases = wordList(al)   // 一个数也算一个名字（2077）
    else if (touched('aliases')) return { ok: false, error: 'aliases 要是一组名字：config set aliases "旧名1、旧名2"' }
    else { next.aliases = []; warnsEarly.push('配置里的 aliases 不是一组名字，换成了空的') }
  }
  // 分享（2026-10-25）。share 整段被写成了一个值（"share": false 这种）：换回默认值但先关着分享 —— 不能因为写坏了反而打开
  if (!isPlain(next.share)) {
    if (touched('share')) return { ok: false, error: 'share 要逐项设：config set share.minScore 10 / config set share.enabled false …' }
    next.share = { ...DEFAULTS.share, enabled: false }
    warnsEarly.push('配置里的 share 不是一组设置：换回默认值，分享先关着 —— 要开：node host/cli.mjs config set share.enabled true')
  }
  // 开关：true / false；开 / 关、on / off、yes / no、1 / 0 也认。以前存进去的「关」「off」她那边不认，分享照样开着
  const en = next.share.enabled
  if (en !== undefined && typeof en !== 'boolean') {
    // 只查表里自己的键：以前 'constructor' 会查到 Object 原型上的函数，存下去丢了开关，她那边就成了「开」（2026-10-25 审查）
    const key = typeof en === 'string' || typeof en === 'number' ? String(en).trim().toLowerCase() : null
    const b = key !== null && Object.hasOwn(ONOFF, key) ? ONOFF[key] : undefined
    if (typeof b === 'boolean') next.share.enabled = b
    else if (changed('share', 'enabled')) return { ok: false, error: `share.enabled 只能是 true（开）或 false（关）：${String(en).slice(0, 20)}` }
    else {
      next.share.enabled = false
      warnsEarly.push(`配置里 share.enabled 不是 true / false（${String(en).slice(0, 20)}）：分享先关着 —— 要开：node host/cli.mjs config set share.enabled true`)
    }
  }
  // 只发第一名（share.topOnly）：true / false；写坏了按 true（只发第一名）算
  const to = next.share.topOnly
  if (to !== undefined && typeof to !== 'boolean') {
    if (changed('share', 'topOnly')) return { ok: false, error: `share.topOnly 只能是 true（只发第一名）或 false（够分就能发）：${String(to).slice(0, 20)}` }
    warnsEarly.push(`配置里 share.topOnly 不是 true / false（${String(to).slice(0, 20)}）：按「只发第一名」算 —— 改：node host/cli.mjs config set share.topOnly false`)
  }
  // 门槛：0 到 20 的整数，和她那边同一套读法（tools/lib/config.mjs minScoreOf）。以前不校验：写成空串 / true，分享那边读成 0 / 1，什么都能发。
  // 只有这次改的就是门槛才报错：别的旧值坏了不挡这次保存（不然坏门槛连 share.enabled false 都关不掉）
  const ms = next.share.minScore
  if (ms === null) next.share.minScore = 13
  else if (ms !== undefined) {
    const msNum = minScoreOf(ms)
    if (Number.isFinite(msNum)) next.share.minScore = msNum
    else if (changed('share', 'minScore')) return { ok: false, error: `share.minScore 只能是 0 到 20 的整数（比如 10）：${String(ms).slice(0, 20)}` }
    else warnsEarly.push(`配置里 share.minScore 不是 0 到 20 的整数（${String(ms).slice(0, 20)}）：她的分享会全被拦下 —— 改：node host/cli.mjs config set share.minScore 13`)
  }
  // 沉默衰减的两个天数：0 或正整数。以前不校验，写成「3天」以后算出 NaN，每天的上限和沉默衰减一起失效（2026-10-25 审查）
  for (const [leaf, d] of [['silentAfterDays', 3], ['silentStopDays', 7]]) {
    const v = next.share[leaf]
    if (v === undefined) continue
    if (isNumberLike(v) && Number(v) >= 0) next.share[leaf] = Math.floor(Number(v))
    else if (changed('share', leaf)) return { ok: false, error: `share.${leaf} 只能是 0 或正整数（天）：${String(v).slice(0, 20)}` }
    else {
      next.share[leaf] = d
      warnsEarly.push(`配置里 share.${leaf} 不是天数（${String(v).slice(0, 20)}）：换回了默认的 ${d} 天`)
    }
  }
  if (shareWasBroken) warnsEarly.push(`配置里的 share 原来不是一组设置：从默认值开始改的${next.share.enabled === false ? '，分享先关着 —— 要开：node host/cli.mjs config set share.enabled true' : ''}`)
  // 她的口味（2026-10-25）：like / dislike / keywords 都是一组词；写成用顿号隔开的一串字也认（PowerShell 会吃掉 JSON 里的引号），存成数组
  if (!isPlain(next.preferences)) {
    if (touched('preferences')) return { ok: false, error: 'preferences 要逐项设：config set preferences.like "词1、词2" / preferences.keywords … / preferences.dislike …' }
    next.preferences = structuredClone(DEFAULTS.preferences)
    warnsEarly.push('配置里的 preferences 不是一组设置，换回了默认值')
  } else {
    const pf = next.preferences
    for (const k of ['like', 'dislike', 'keywords']) {
      if (pf[k] === undefined) continue
      const why = wordListProblem(`preferences.${k}`, pf[k])
      if (!why) {
        pf[k] = wordList(pf[k])
        const joined = changed('preferences', k) && joinedWords(pf[k])
        if (joined) warnsEarly.push(`preferences.${k} 里「${joined.slice(0, 20)}」像是好几个词连在一起了：多个词用顿号隔开 —— config set preferences.${k} "词1、词2、词3"`)
      } else if (changed('preferences', k)) return { ok: false, error: why }
      else warnsEarly.push(`配置里 ${why}`)
    }
  }
  // 给明天的信的开关（2026-10-26）：true / false；开 / 关、on / off、yes / no、1 / 0 也认（和 share.enabled 同一张表）。
  // 这次改的就是它 → 不认的直接报错；不是 → 按 false（关）存、提醒一句（她那边只认 true：写坏了绝不会变成开着）
  const le = next.letters.enabled
  if (le !== undefined && typeof le !== 'boolean') {
    const key = typeof le === 'string' || typeof le === 'number' ? String(le).trim().toLowerCase() : null
    const b = key !== null && Object.hasOwn(ONOFF, key) ? ONOFF[key] : undefined
    if (typeof b === 'boolean') next.letters.enabled = b
    else if (changed('letters', 'enabled')) return { ok: false, error: `letters.enabled 只能是 true（开）或 false（关）：${String(le).slice(0, 20)}` }
    else {
      next.letters.enabled = false
      warnsEarly.push(`配置里 letters.enabled 不是 true / false（${String(le).slice(0, 20)}）：给明天的信先关着 —— 要开：node host/cli.mjs config set letters.enabled true`)
    }
  }
  // 她的权限列表（能跑哪些 node bili.mjs 子命令）是宿主启动时定的：第一次打开要重启一次宿主，她才用得上 letter
  if (next.letters.enabled === true && cur.letters?.enabled !== true) warnsEarly.push('给明天的信打开了：宿主启动时才把 letter 加进她能用的命令 —— 这一版第一次打开要重启一次宿主（node host/cli.mjs restart）；关掉（false）马上生效，不用重启')
  // 读书（2026-10-28）：开关两个（enabled 只有 true 才开、approve 只有 false 才不用批）、几个数（夹在范围里）、
  // 引擎（ddg / bing）、网站名单 allow / block（顿号隔开的一串也认；不像网站名的这次改的就报错，不是就丢掉、提醒一句）
  if (!isPlain(next.web)) {
    if (touched('web')) return { ok: false, error: 'web 要逐项设：config set web.enabled true / web.allow "zh.wikipedia.org、ctext.org" …' }
    next.web = structuredClone(DEFAULTS.web)
    warnsEarly.push('配置里的 web 不是一组设置，换回了默认值（读书关着）')
  } else {
    const w = next.web
    for (const k of ['enabled', 'approve', 'reviewNotes', 'allowTun']) {
      const v = w[k]
      if (v === undefined || typeof v === 'boolean') continue
      const key = typeof v === 'string' || typeof v === 'number' ? String(v).trim().toLowerCase() : null
      const b = key !== null && Object.hasOwn(ONOFF, key) ? ONOFF[key] : undefined
      if (typeof b === 'boolean') w[k] = b
      else if (changed('web', k)) return { ok: false, error: `web.${k} 只能是 true 或 false：${String(v).slice(0, 20)}` }
      else { w[k] = DEFAULTS.web[k]; warnsEarly.push(`配置里 web.${k} 不是 true / false：按默认（${DEFAULTS.web[k]}）`) }
    }
    for (const [k, [lo, hi]] of Object.entries({ roundsPerDay: [1, 24], pagesPerRound: [0, 60], searchesPerRound: [0, 20], notesPerRound: [1, 10], turnTimeoutMin: [3, 30] })) {
      if (w[k] === undefined) continue
      const n = Number(w[k])
      if (!isNumberLike(w[k]) || !Number.isInteger(n) || n < lo || n > hi) {
        if (changed('web', k)) return { ok: false, error: `web.${k} 要是 ${lo} 到 ${hi} 之间的整数：${String(w[k]).slice(0, 20)}` }
        w[k] = DEFAULTS.web[k]; warnsEarly.push(`配置里 web.${k} 不对：按默认（${DEFAULTS.web[k]}）`)
      } else w[k] = n
    }
    if (w.engine !== undefined && !['ddg', 'bing'].includes(w.engine)) {
      if (changed('web', 'engine')) return { ok: false, error: `web.engine 只能是 ddg 或 bing：${String(w.engine).slice(0, 20)}` }
      w.engine = DEFAULTS.web.engine
    }
    for (const k of ['allow', 'block']) {
      if (w[k] === undefined) continue
      const raw = (Array.isArray(w[k]) ? w[k] : typeof w[k] === 'string' ? w[k].split(/[、，,；;\s]+/) : [w[k]]).map((x) => String(x ?? '').trim()).filter(Boolean)
      // allow 只认网站名；block 还认 IP / 网段（挡自己家的公网 IP 用）
      const one = (x) => {
        const h = x.toLowerCase().replace(/\.+$/, '')
        if (/^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.') && !h.startsWith('.') && !h.includes('..') && !/^[\d.]+$/.test(h)) return h
        return k === 'block' ? webBlockEntry(x) : ''
      }
      const good = raw.map(one).filter(Boolean)
      if (good.length !== raw.length) {
        const badOnes = raw.filter((x) => !one(x)).slice(0, 3).join('、').slice(0, 60)
        if (changed('web', k)) return { ok: false, error: `web.${k} 里有不像网站名的：${badOnes}（只写网站名，比如 zh.wikipedia.org；不带 https://、不带路径${k === 'block' ? '；也可以写 IP 或网段，比如 203.0.113.7' : ''}）` }
        warnsEarly.push(`配置里 web.${k} 有不像网站名的，丢掉了：${badOnes}`)
      }
      w[k] = [...new Set(good)]
    }
    if (w.enabled === true && cur.web?.enabled !== true && (w.approve === false)) warnsEarly.push('读书打开了，而且她的请求不用你批（web.approve false）：她写了就会去读 —— 想先看一眼再读：config set web.approve true')
  }
  for (const who of ['owner', 'self']) if (next[who]?.mid !== undefined && next[who].mid !== '') next[who].mid = String(next[who].mid)   // mid 一律存字符串
  const c = next.claude
  const st = next.studio
  st.maxPerWeek = Math.min(14, Math.max(0, Number.isFinite(Number(st.maxPerWeek)) ? Number(st.maxPerWeek) : STUDIO_DEFAULTS.maxPerWeek))
  st.maxSeconds = Math.min(1800, Math.max(15, Number(st.maxSeconds) || 300))
  st.dynamicDaily = Math.min(10, Math.max(0, Number.isFinite(Number(st.dynamicDaily)) ? Number(st.dynamicDaily) : 2))
  if (st.aiStatement === '该视频使用人工智能合成技术') st.aiStatement = '作者声明：该视频使用人工智能合成技术'   // 老默认值少了前缀
  const acChanged = changed('studio', 'avoidCreators')   // 在收拾之前比：收拾完可能和原来一样（都是空的）
  const acRaw = (Array.isArray(st.avoidCreators) ? st.avoidCreators : typeof st.avoidCreators === 'string' ? st.avoidCreators.split(/[、，,；;\s]+/) : [st.avoidCreators])   // 顿号隔开的一串 mid 也认（2026-10-25）
    .map((x) => String(x ?? '').trim()).filter(Boolean)
  st.avoidCreators = acRaw.filter((x) => /^\d{1,20}$/.test(x))
  // 只能放 UP 主的 mid（数字）：这次改的是它、又有没存进去的，说一声（以前悄悄丢掉，整组可能被清空，第五轮审查）
  const acDropped = acRaw.filter((x) => !/^\d{1,20}$/.test(x))
  if (acDropped.length && acChanged) warnsEarly.push(`studio.avoidCreators 只能放 UP 主的 mid（数字），这几个没存：${acDropped.slice(0, 5).join('、').slice(0, 60)}`)
  if (!['none', 'openai', 'openai-compatible'].includes(st.image?.provider)) st.image = { ...st.image, provider: 'none' }
  // 背景音乐（2026-10-25）：bgmSynth 开关和 share.enabled 同一套读法（开 / 关、on / off …）；bgmVolume 要是 0–1 的数（0 = 不要背景音乐）。
  // 这次改的就是它才挡，别的旧值坏了只提醒（渲染那边也会兜底：不认的音量按默认算）
  const bs = st.bgmSynth
  if (bs !== undefined && typeof bs !== 'boolean') {
    const k = typeof bs === 'string' || typeof bs === 'number' ? String(bs).trim().toLowerCase() : null
    const b = k !== null && Object.hasOwn(ONOFF, k) ? ONOFF[k] : undefined
    if (typeof b === 'boolean') st.bgmSynth = b
    else { const e = refuseOrWarn('studio', [['bgmSynth']], `studio.bgmSynth 只能是 true（自动合成背景音乐）或 false（不合成）：${String(bs).slice(0, 20)}`); if (e) return e }
  }
  const bv = st.bgmVolume
  if (bv !== undefined) {
    const n = typeof bv === 'number' ? bv : typeof bv === 'string' && bv.trim() ? Number(bv.trim()) : NaN
    if (Number.isFinite(n) && n >= 0 && n <= 1) st.bgmVolume = n
    else { const e = refuseOrWarn('studio', [['bgmVolume']], `studio.bgmVolume 要是 0–1 之间的数（0 = 不要背景音乐）：${String(bv).slice(0, 20)}`); if (e) return e }
  }
  // VoxCPM 本地配音：主人的试听和她的渲染都会跑这个 Python、加载这个模型 —— 不能指到她能写的家里（渲染前还会再查一次）
  if (st.voxcpm !== undefined && !isPlain(st.voxcpm) && !leafChanged('studio', ['voxcpm'])) {   // 按项判断（第五轮审查）
    // 这次改的不是 studio：坏掉的 voxcpm 不挡这次保存，原样留着、只提醒（2026-10-25 审查）
    warnsEarly.push('配置里的 studio.voxcpm 不是一组设置：本地配音先用不了 —— 改：config set studio.voxcpm.python <路径> / config set studio.voxcpm.model <目录>')
  } else if (st.voxcpm !== undefined) {
    if (!isPlain(st.voxcpm)) return { ok: false, error: 'studio.voxcpm 要逐项设：config set studio.voxcpm.python <路径> / config set studio.voxcpm.model <目录>' }
    for (const k of ['python', 'model']) {
      const v = String(st.voxcpm[k] ?? '').trim()
      const why = v ? voxcpmPathProblem(k, v) : null
      if (why) { const e = refuseOrWarn('studio', [['voxcpm', k]], why); if (e) return e; continue }   // 渲染前还会再查一次
      st.voxcpm[k] = v
    }
    // 显卡门槛和等待时间：只收范围内的数字（「80」规整成 80）；不然渲染时会被悄悄丢掉、主人以为调好了（2026-10-25 审查）
    for (const [k, [lo, hi]] of Object.entries(VOXCPM_TUNING)) {
      if (st.voxcpm[k] === undefined) continue
      const raw = st.voxcpm[k]
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN
      if (Number.isFinite(n) && n >= lo && n <= hi) { st.voxcpm[k] = n; continue }
      const e = refuseOrWarn('studio', [['voxcpm', k]], `studio.voxcpm.${k} 要是 ${lo}–${hi} 之间的数字（现在是 ${String(raw).slice(0, 20)}）：渲染时不会用它`)
      if (e) return e
    }
  }
  // 模块的校验（第二处，和拆开之前同一个位置）：比如 QQ 那一段。这里的提醒进 warnsLate，排在别的提醒前面
  { const e = runHooks('afterStudio', ctx); if (e) return e }
  const nt = next.notify
  if (!nt || typeof nt !== 'object' || Array.isArray(nt)) return { ok: false, error: `notify 要逐项设：${NOTIFY_EXAMPLE} …` }
  const KINDS = NOTIFY_KINDS
  nt.fallback = String(nt.fallback ?? '').trim()
  if (nt.fallback && !KINDS.includes(nt.fallback)) { const e = refuseOrWarn('notify', ['fallback'], `notify.fallback 只能是 ${KINDS.join(' / ')}（或留空）：${nt.fallback}`); if (e) return e }
  if (nt.type && !KINDS.includes(String(nt.type))) { const e = refuseOrWarn('notify', ['type'], `notify.type 只能是 ${KINDS.join(' / ')}：${nt.type}`); if (e) return e }
  // 推送地址：要是完整的 http(s):// 地址、不带账号密码 —— 不然 fetch 的报错会把整个地址（连同里面的 key）原样打出来（2026-10-24 审查）。
  // 报错里不回显地址本身
  if (nt.url !== undefined && String(nt.url ?? '').trim()) {
    let u = null
    try { u = new URL(String(nt.url).trim()) } catch {}
    const urlWhy = !u || !['http:', 'https:'].includes(u.protocol) ? 'notify.url 要写完整的地址（以 https:// 或 http:// 开头）'
      : u.username || u.password ? 'notify.url 里不要带账号密码（xxx:yyy@ 那一段）' : null
    if (urlWhy) { const e = refuseOrWarn('notify', ['url'], urlWhy); if (e) return e } else nt.url = String(nt.url).trim()
  }
  // 模块的校验（第三处）：要等推送那一段收拾完的（比如陌生人私信开着时推送方式的那条规矩）
  { const e = runHooks('afterNotify', ctx); if (e) return e }
  c.rotateDays = Math.min(60, Math.max(1, Number(c.rotateDays) || 7))
  c.timeoutMin = Math.min(120, Math.max(5, Number(c.timeoutMin) || 25))
  delete c.permissionMode   // 已废弃：她的会话固定 dontAsk + 白名单（见 host/claude.mjs permissionArgs）
  delete next.home          // 已废弃：她的家固定在 <数据目录>/whale-work（权限边界跟着它走）
  writeConfig(next)
  const schedulingChanged = ['windows', 'skipChance', 'minGapMin'].some((key) => JSON.stringify(cur.night?.[key]) !== JSON.stringify(next.night?.[key]))
  const sdWarn = !touched('quota') ? null
    : next.quota.shareDaily === 0 ? '分享不设条数上限：她在别人视频下 @ 你多了，B 站可能限流她的号（沉默衰减照样管着）'
      : next.quota.shareDaily > 3 ? '分享条数 >3：看起来会像刷量，平台可能限流/封号' : null
  const warns = [sdWarn, ...ctx.warnsLate, ...warnsEarly].filter(Boolean)
  return { ok: true, config: next, schedulingChanged, warn: warns.length ? warns.join('\n') : null }
}

/** 按 a.b.c 路径改一项（CLI 的 `config set` 用）；值按 JSON 解析，失败就当字符串 */
export function setConfigPath(dotted, raw) {
  let value
  try { value = JSON.parse(raw) } catch {
    if (/^\s*[[{]/.test(String(raw))) {
      // 一组值（数组）写坏了：给能用的写法（以前提示「逐项设」，可一组值不让按下标改，第五轮审查）
      const defAtPath = dotted.split('.').filter(Boolean).reduce((o, x) => o?.[x], DEFAULTS)
      const listLike = Array.isArray(defAtPath) || dotted === 'aliases' || dotted === 'notify.args'
      const hint = dotted.startsWith('preferences') ? '一组词用顿号隔开就行，比如：config set preferences.like "科普、音乐、猫"'
        : ['aliases', 'studio.avoidCreators'].includes(dotted) ? `用顿号隔开就行：config set ${dotted} "值1、值2"`
          : listLike ? '这是一组值：用 node host/cli.mjs config edit 直接改'
            : '改成逐项设置，比如：config set owner.mid 12345 和 config set owner.name 你的昵称'
      return { ok: false, error: `这个值不是合法的 JSON：${raw}\n（Windows PowerShell 会吃掉参数里的双引号。${hint}）` }
    }
    value = raw
  }
  const keys = dotted.split('.').filter(Boolean)
  if (!keys.length) return { ok: false, error: '要给一个键，比如 night.skipChance' }
  if (keys[0] === 'home') return { ok: false, error: `home 已经废弃：她的家固定在 ${AI_HOME}（她的权限边界跟着这个目录走，不能挪）` }
  if (!KNOWN.has(keys[0])) return { ok: false, error: `不认识的设置：${keys[0]}（可选：${[...KNOWN].join(' / ')}）` }
  // 在完整配置上改那一项，再把整个顶层段交给 saveSettings（数组 / 标量都是整体替换）
  const conf = readConfigStrict()
  if (!conf.ok) return { ok: false, error: conf.error }
  const full = conf.cfg
  if (keys.length === 1) return saveSettings({ [keys[0]]: value })
  // 路径上哪一层「应该是一组值」（数组：aliases、studio.avoidCreators、notify.args…）就不能按下标改：以前改成 {"3":…}，整组被清空或者弹幕监听崩掉（第三、四轮审查）
  for (let i = 0; i < keys.length - 1; i += 1) {
    const at = keys.slice(0, i + 1)
    const def = at.reduce((o, x) => o?.[x], DEFAULTS)
    const stored = at.reduce((o, x) => o?.[x], conf.cfg)
    if (at.join('.') === 'aliases' || Array.isArray(def) || (def === undefined && Array.isArray(stored))) {
      const whole = ['aliases', 'studio.avoidCreators'].includes(at.join('.')) ? `config set ${at.join('.')} "值1、值2"` : 'node host/cli.mjs config edit 直接改'
      return { ok: false, error: `${at.join('.')} 是一组值，不能按下标改，要整组设：${whole}` }
    }
  }
  // 这一段原来不是一组设置（"share": false 这种）：从默认值开始改，分享先关着 —— 以前从空的开始，开关一丢就成了「开」（2026-10-25 审查）
  let reset = null
  if (!isPlain(full[keys[0]])) {
    // share 的提醒由 saveSettings 照存下去的开关写（以前在这里先写「分享先关着」，你刚把它打开也这么说）
    full[keys[0]] = keys[0] === 'share' ? { ...DEFAULTS.share, enabled: false } : structuredClone(DEFAULTS[keys[0]] ?? {})
    if (keys[0] !== 'share') reset = `配置里的 ${keys[0]} 原来不是一组设置：从默认值开始改的`
  }
  let o = full
  for (const k of keys.slice(0, -1)) o = o[k] = (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) ? o[k] : {}
  o[keys.at(-1)] = value
  const r = saveSettings({ [keys[0]]: full[keys[0]] })
  return reset && r.ok ? { ...r, warn: [reset, r.warn].filter(Boolean).join('\n') } : r
}

/** 只回"能不能用"，不回显任何凭据内容 */
export function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
    return { present: true, hasSess: !!c.sessdata, hasJct: !!c.bili_jct, hasBuvid: !!c.buvid3 }
  } catch { return { present: false, hasSess: false, hasJct: false, hasBuvid: false } }
}

/** 从用户粘的东西里抠出某个 cookie 值：整条 cookie / key=value / 带引号分号 都兜住 */
export function pickCookie(raw, key) {
  let v = String(raw ?? '').trim()
  const m = v.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'))
  if (m) return m[1].trim()
  v = v.replace(new RegExp('^' + key + '\\s*=', 'i'), '')
  return v.replace(/^["'\s]+|["';\s]+$/g, '')
}

/**
 * 原子地写凭据：先写同一目录里的临时文件，再改名盖过去 —— 写到一半断电 / 磁盘满 / 被杀，原来能用的凭据也不会坏一半。
 * 只有宿主（你跑的 cli）调；她的会话读写不了 ~/.bili-ai。
 */
export function saveCredentials(cred) {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true })
  const tmp = `${CRED_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 })
    renameRetry(tmp, CRED_FILE)   // 工具正在读凭据时改名，Windows 上会短暂 EPERM：重试
  } finally { try { fs.rmSync(tmp, { force: true }) } catch {} }
  try { fs.chmodSync(CRED_FILE, 0o600) } catch {}
}

/** 现在存着的凭据（读不出来 = null）。只在宿主进程里用，内容不打印、不进日志、不进面板 */
export function readSavedCred() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

/**
 * cookie 的值能不能原样放进请求头（RFC 6265 的 cookie-octet：看得见的 ASCII，去掉 空格 " , ; \）。
 * 复制时带进来的换行、空格、引号、中文都过不了 —— 这种值放进请求头，Node 会在本地就报错，报错原文里还带着整条 cookie。
 */
export const COOKIE_SAFE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/
const cookieOk = (v) => COOKIE_SAFE.test(String(v ?? ''))

/**
 * 拿一组 cookie 问 B站「这是谁」：只读的 nav 接口，不发任何东西。
 * → { ok: true, mid, name } | { ok: false, invalid（B站 明说没登录）, badFormat（值里有不能用的字符，没发请求）, code, message, netErr }
 * 出错信息只留「哪一类错」（超时 / ECONNRESET …）：原文里可能带着请求头，也就是 cookie。
 */
export async function whoIs({ sessdata, bili_jct, buvid3 }, { fetch: f = null } = {}) {
  if (!cookieOk(sessdata) || !cookieOk(bili_jct) || (buvid3 && !cookieOk(buvid3))) return { ok: false, invalid: false, badFormat: true, code: null }
  try {
    const r = await (f ?? globalThis.fetch)('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${sessdata}; bili_jct=${bili_jct}; buvid3=${buvid3 ?? ''}` },
      signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json().catch(() => ({}))
    if (j?.data?.isLogin && /^\d{1,20}$/.test(String(j.data.mid ?? ''))) return { ok: true, mid: String(j.data.mid), name: String(j.data.uname ?? '') }
    const code = j?.code ?? null
    return { ok: false, invalid: code === -101 || (code === 0 && j?.data?.isLogin === false), code, message: String(j?.message ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80) }
  } catch (e) {
    const sys = String(e?.cause?.code ?? e?.code ?? '')
    const netErr = e?.name === 'TimeoutError' ? '超时' : /^[A-Z][A-Z_]{2,30}$/.test(sys) ? sys : '网络错误'
    return { ok: false, invalid: false, code: null, netErr }
  }
}
const whyNot = (w) => (w.badFormat ? '凭据里有不能用的字符（空格 / 换行 / 引号 / 中文…），大概是复制时带进来的'
  : w.netErr ? `请求失败：${w.netErr}` : `nav 返回 code=${w.code ?? '?'}${w.message ? ' ' + w.message : ''}`)
export { whyNot as whoIsWhyNot }

/**
 * B站 登录状态（宿主每小时用 nav 查一次，扫码 / 手动填完也会写）：给面板和体检看，里面没有任何 cookie。
 * { state: ok | invalid | unknown | missing, checkedAt, since, mid, name, lastOkAt, code, why, notifiedAt, alertKey, knownKey }
 */
export const LOGIN_STATE_FILE = path.join(HOST_DIR, 'login-state.json')
export function readLoginState() {
  try { return JSON.parse(fs.readFileSync(LOGIN_STATE_FILE, 'utf8')) } catch { return null }
}
export function writeLoginState(next) {
  fs.mkdirSync(HOST_DIR, { recursive: true })
  const tmp = `${LOGIN_STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameRetry(tmp, LOGIN_STATE_FILE)   // 面板可能正读着
}
/** 刚用这个号登录成功（扫码 / 手动填）：登录状态直接记成有效 */
export function markLoginOk({ mid, name }, at = new Date().toISOString()) {
  const prev = readLoginState()
  const same = prev?.state === 'ok' && !prev.problem && prev.mid === mid
  try { writeLoginState({ state: 'ok', checkedAt: at, since: same ? prev.since ?? at : at, mid, name, lastOkAt: at, knownKey: 'ok|' }) } catch {}
}

/**
 * 写凭据（手动粘贴那条路）：逐字段体检 → 先用 nav 问清是哪个号 → 是你自己的号就不写 → 把昵称 + UID 给你看、confirm 点头（换了号要把新 UID 打一遍）→ 原子写入。
 * B站 不认 / 网络不通 / 配置读不出来 / 你没确认 → 原来的凭据一个字都不动。
 * verify:false（--no-verify）= 不问 B站 直接写（网络不通、你自己确认过的时候用）：登录状态改成「没核对」，等下一次检查。
 * confirm({ who, prev, switched, ownerUnknown }) → true 才写；不给就不问（程序里调用时）。
 */
export async function writeCookie(input, { verify = true, confirm = null } = {}) {
  const sessdata = pickCookie(input.sessdata, 'SESSDATA')
  const bili_jct = pickCookie(input.bili_jct, 'bili_jct')
  const buvid3 = pickCookie(input.buvid3, 'buvid3')
  const problems = []
  if (!sessdata) problems.push('SESSDATA 空着（它是 HttpOnly，document.cookie 读不到 ✗ 必须 F12 → Application → Cookies 手动复制）')
  else if (!cookieOk(sessdata)) problems.push('SESSDATA 里有不能用的字符（空格 / 换行 / 引号 / 中文…）—— 复制时带进来了，重新复制一次')
  else if (sessdata.length < 20) problems.push('SESSDATA 太短（长度 ' + sessdata.length + '）—— 大概只复制到一半')
  if (!bili_jct) problems.push('bili_jct 空着')
  else if (!/^[0-9a-fA-F]{32}$/.test(bili_jct)) problems.push('bili_jct 格式不对（长度 ' + bili_jct.length + '，B站 目前是 32 位十六进制）')
  if (buvid3 && !cookieOk(buvid3)) problems.push('buvid3 里有不能用的字符（空格 / 换行 / 引号 / 中文…）—— 重新复制一次，或者留空')
  const buvid3LooksOdd = buvid3 && !/^[0-9A-Za-z]{6,}-[0-9A-Za-z-]{18,}$/.test(buvid3)
  if (problems.length) return { ok: false, error: '凭据有问题，没写入：\n  · ' + problems.join('\n  · ') }
  const savedAt = new Date().toISOString()
  if (!verify) {
    saveCredentials({ sessdata, bili_jct, buvid3, via: 'manual-unverified', savedAt })
    // 面板别再说「原来那个号有效」：改成没核对，等宿主下一次检查（或者你跑 doctor）
    try { writeLoginState({ state: 'unknown', checkedAt: savedAt, since: savedAt, mid: null, name: null, lastOkAt: null, why: '刚手动存了没核对的凭据（--no-verify），还不知道是哪个号、有没有效' }) } catch {}
    return { ok: true, warn: buvid3LooksOdd ? 'buvid3 格式有点怪（不影响使用）' : null, detail: '已写入，但没问 B站 这是哪个号 —— 网络好了跑 node host/cli.mjs doctor 核对一下（宿主每小时也会查；是你自己的号 / 换了号会提醒你）' }
  }
  const conf = readConfigStrict()
  if (!conf.ok) return { ok: false, error: conf.error + '\n  配置读不出来就没法核对这是不是你自己的号 —— 没写入，原来的凭据没动' }
  const who = await whoIs({ sessdata, bili_jct, buvid3 })
  if (!who.ok) {
    return { ok: false, error: (who.invalid ? 'B站 不认这个 cookie ✗' : '没问到 B站 这是哪个号 ✗') + `（${whyNot(who)}）—— 没写入，原来的凭据没动。`
      + (who.invalid ? '常见原因：SESSDATA 复制截断了，或复制自已退出的浏览器会话。也可以扫码：node host/cli.mjs cookie --qr'
        : who.netErr ? '网络好了再试（或者扫码：node host/cli.mjs cookie --qr）；实在要先存下，加 --no-verify（那样存进去的没核对是哪个号）' : '') }
  }
  const cfg = conf.cfg
  if (cfg.owner?.mid && String(cfg.owner.mid) === who.mid) {
    return { ok: false, error: `这是你（主人）自己的号：${who.name}（UID ${who.mid}）—— 她得用她自己的号。没写入，原来的凭据没动。` }
  }
  // 以前她是哪个号：配置里记的；配置里没有就看旧凭据里的 UID（和扫码那条路一样）
  const old = readSavedCred()
  const prevMid = String(cfg.self?.mid || old?.dedeuserid || readLoginState()?.mid || '')
  const prev = prevMid ? { mid: prevMid, name: String(cfg.self?.mid) === prevMid ? String(cfg.self?.name ?? '') : '' } : null
  const switched = Boolean(prev && prev.mid !== who.mid)
  if (confirm && !(await confirm({ who, prev, switched, ownerUnknown: !cfg.owner?.mid }))) {
    return { ok: false, error: (switched ? '没换号' : '你没确认') + ' —— 没写入，原来的凭据没动' }
  }
  saveCredentials({ sessdata, bili_jct, buvid3, dedeuserid: who.mid, via: 'manual', savedAt })
  const self = { mid: who.mid, name: who.name }
  let warn = buvid3LooksOdd ? 'buvid3 格式有点怪（不影响使用，想要的话重新复制一次）' : null
  try { setSelf(self) } catch (e) { warn = '凭据存好了，但配置里「她的号」没更新：' + String(e?.message ?? e).slice(0, 160) }
  markLoginOk(self, savedAt)
  return {
    ok: true,
    self,
    switched,
    warn,
    detail: `已写入 ✓ 当前登录：${who.name}（mid ${who.mid}）` + (switched ? `（⚠️ 换号了：之前是 ${prev.name || '?'}（mid ${prev.mid}））` : ''),
  }
}

export function getPersona() {
  let text = ''
  try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch {}
  return text
}

export function setPersona(text) {
  text = String(text ?? '')
  if (text.length > 20000) return { ok: false, error: '太长（上限 20000 字），人设不用写论文 ✗' }
  fs.mkdirSync(path.dirname(PERSONA_FILE), { recursive: true })
  fs.writeFileSync(PERSONA_FILE, text, 'utf8')
  try { fs.chmodSync(PERSONA_FILE, 0o600) } catch {}
  const bytes = Buffer.byteLength(text, 'utf8')
  return { ok: true, bytes, detail: text.trim() ? `✓ 已注入（${bytes} 字节）—— 从下一次唤醒开始生效` : '✓ 已清空' }
}

/** node 运行时：找不到就明说（不拿别的程序顶替 —— 那会静默返回空输出） */
export function runtimeStatus() {
  try {
    const rt = resolveRuntime(DSH_HOME, { allowCurrent: true })
    return { ok: true, file: rt.file, env: rt.env }
  } catch (e) { return { ok: false, reason: String(e?.message ?? e) } }
}

/**
 * 子进程跑完的说明：有 stderr 用 stderr；被超时结束的补一句 —— 以前 stderr 是空串时 `??` 不往下走，
 * 超时的原因整个丢掉，日志里只剩「没有出错信息」（2026-10-24 审查）
 */
const failText = (err, stderr, timeout) => {
  const se = String(stderr ?? '')
  if (!err) return se
  if (err.killed) return `${se.trim() ? se.trim() + '\n' : ''}[超过 ${Math.round(timeout / 1000)} 秒没跑完，已结束]`
  // 普通的非零退出、stderr 是空的：照旧给空串 —— 调用方会改看 stdout 里的原因（以前这里换成 err.message，
  // 只剩「Command failed: <整条命令行>」，把真正的原因盖住了，2026-10-24 复核）。起不来（ENOENT 这类）才用 err.message
  if (!se.trim() && typeof err.code === 'string') return String(err.message ?? err)
  return se
}

/** 跑一条 `node tools/bili.mjs …`，返回 { ok, out, err, timedOut }（execFile 每次现取，测试里可以替换） */
export function runBili(args, { timeout = 120_000, env = {} } = {}) {
  const rt = runtimeStatus()
  if (!rt.ok) return Promise.resolve({ ok: false, out: '', err: rt.reason })
  return new Promise((resolve) => {
    execFile(rt.file, [BILI_MJS, ...args], { timeout, windowsHide: true, env: { ...rt.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? ''), err: failText(err, stderr, timeout), timedOut: Boolean(err?.killed) }))
  })
}

const logEvent = (kind, target, note) => {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.appendFileSync(path.join(DSH_HOME, 'whale-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, target, note }) + '\n')
  } catch {}
}

export function listPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')).items ?? [] } catch { return [] }
}

/** 否掉一条草稿（否掉也是反馈 → 记事件流，她下次能学到"这种不要"） */
export async function rejectDraft(id, reason = '') {
  if (!id) return { ok: false, error: '需要 id' }
  const r = await runBili(['reply-draft', 'drop', String(id)], { timeout: 20_000 })
  if (r.ok) logEvent('reply-rejected', null, `主人否掉了草稿 ${id}${reason ? '：' + String(reason).slice(0, 80) : ''}`)
  if (r.ok) await ownerFeedback('主人看了她想回的评论，没通过')
  return { ok: r.ok, out: r.out.slice(0, 300) }
}

/** 批准一条草稿：取出 → 真发 → 失败就放回队列 */
export async function approveDraft(id) {
  if (!id) return { ok: false, error: '需要 id' }
  const cfgNow = readConfig()
  const taken = await runBili(['reply-draft', 'take', String(id)], { timeout: 20_000 })
  let item = null
  try { item = JSON.parse(taken.out) } catch {}
  if (!item) return { ok: false, error: '队列里没有这条（可能已经发过）' }
  const type = String(item.type ?? '1')
  if (!['1', '11', '12', '17'].includes(type) || ![item.oid, item.root, item.parent].every((x) => /^\d{1,20}$/.test(String(x)))) {
    return { ok: false, error: '这条草稿的坐标不对（不是数字 / 类型不认识），没有发' }
  }
  // 不带 --auto：这是主人批准的回复，不占她自己的每日条数；评论区类型和 referer 由这边按类型给（不信她写的 URL）
  const args = ['comment', '--oid', item.oid, '--type', type, '--root', item.root, '--parent', item.parent,
    '--message', item.message, ...(cfgNow.listen?.oncePerPerson !== false ? ['--once-per-person'] : []), '--go']
  if (type === '1' && item.bvid) args.push('--bvid', item.bvid)
  else args.push('--referer', type === '12' ? 'https://www.bilibili.com/read/' : type === '1' ? 'https://www.bilibili.com/' : 'https://t.bilibili.com/')
  // 结果从一个只有这边知道的文件拿（不从输出里找「code=」：输出里也有她写的字段，她能写一个假的「code=0」进去）
  const resultFile = path.join(os.tmpdir(), `bw-res-${crypto.randomBytes(8).toString('hex')}.json`)
  const sent = await runBili(args, { timeout: 5 * 60_000, env: { BILI_RESULT_FILE: resultFile } })
  let res = null
  try { res = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch {}
  try { fs.rmSync(resultFile, { force: true }) } catch {}
  //   回包 code=0 → 发出去了；回包 code≠0 / 风控 → B站 明确没收 → 放回队列；
  //   走到了「发送中」却没有回包（超时 / 中途被关掉）→ 不知道发没发出去 → 不放回（免得发两遍），请主人去看一眼
  const ok = res?.code === 0
  const reached = /\[go\] 发送中/.test(sent.out)
  // 没等到结果文件、或者 comment.mjs 自己判定「不知道发没发出去」（回包读不出来 / 服务端超时）→ 都不放回
  const uncertain = (!res && reached) || res?.outcome === 'uncertain'
  const rpid = ok ? (res.rpid || null) : null
  logEvent(ok ? 'reply-sent' : uncertain ? 'reply-uncertain' : 'reply-failed', item.who || item.parent, `${ok ? '主人批准并发出' : uncertain ? '不知道发没发出去' : '发送失败'} · ${String(item.message).slice(0, 60)}`)
  await ownerFeedback('主人审了她想回的评论')
  if (uncertain) {
    const why = res ? `B站 的回包读不出来 / 服务端出错（HTTP ${res.status ?? '?'}，code=${res.code ?? '无'}）` : `没等到 B站 的回包（${String(sent.err || '超时').slice(0, 120)}）`
    return { ok: false, uncertain: true, error: `发送请求发出去了，但${why}。草稿没放回队列，免得发两遍 —— 去 oid=${item.oid} 那条评论下面看一眼：没有的话让她重写一份草稿` +
      (args.includes('--once-per-person') ? '（开着「同一个人只回一条」：确认没发出去后，先用 node host/cli.mjs replied release <对方 mid> 解除这次的预留）' : '') }
  }
  // 被「同一个人只回一条」拦下：放回队列也只会被同一条规则再拦一次 → 不放回，说清楚怎么办
  if (res?.once) {
    logEvent('reply-once-blocked', item.who || item.parent, String(item.message).slice(0, 60))
    return { ok: false, onceBlocked: true, error: res.once === 'ledger'
      ? '判重账本（~/.bili-ai/replied.json）读不了 / 结构不对，按「同一个人只回一条」这次没发；草稿没放回。修好那个文件（或者 config set listen.oncePerPerson false）再让她重写'
      : `按「同一个人只回一条」没发：30 天内已经回过这个人（${res.at ?? '?'}${res.uncertain ? '，那一次结果不确定' : ''}）。草稿没放回队列。` +
        `确认上次其实没发出去、或者你就是想再回一次：node host/cli.mjs replied release ${res.mid ?? '<mid>'}，再让她重写` }
  }
  if (!ok) {
    const back = ['reply-draft', 'add', '--oid', item.oid, '--type', type, '--message', item.message]
    for (const k of ['bvid', 'root', 'parent', 'who', 'src']) if (item[k]) back.push('--' + k, item[k])
    const b = await runBili(back, { timeout: 2 * 60_000 })
    const why = res ? `B站 回 code=${res.code}` : String(sent.err || sent.out.split('\n').filter(Boolean).pop() || '').slice(0, 200)
    if (!b.ok) return { ok: false, requeued: false, error: `没发出去（${why}），而且草稿没能放回队列：${String(b.err).slice(0, 120)}（原文：${item.message}）` }
    return { ok: false, requeued: true, error: `没发出去（${why}）`, out: sent.out.slice(-600), err: sent.err.slice(0, 400) }
  }
  return { ok, rpid, out: sent.out.slice(-600), err: sent.err.slice(0, 400) }
}

// ─────────────── 工作室：她做的视频，主人审 ───────────────

export { pendingVideos as listVideos, IMAGE_KEY_FILE, VENV_DIR }

/** 跑工作室的 Python（execFile 每次现取，测试里可以替换） */
function runStudioPy(args, { timeout = 60 * 60_000 } = {}) {
  const py = venvPython()
  if (!fs.existsSync(py)) return Promise.resolve({ ok: false, out: '', err: '工作室依赖没装：node host/cli.mjs studio-setup' })
  return new Promise((resolve) => {
    execFile(py, [STUDIO_PY, ...args], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? ''), err: failText(err, stderr, timeout), timedOut: Boolean(err?.killed) }))
  })
}

const lastJson = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()) } catch { return null } }

// B站 稿件状态：-2 被打回 · -3 网警锁定 · -4 被锁定 · -16 转码失败 → 不自动记账；-100 = 用户删除（当它不存在）；
// 其余（0 开放 · -1 待审 · -30 已提交 · -9 转码中 …）= 稿件在 B站 上，正常
const BAD_ARCHIVE_STATES = new Set([-2, -3, -4, -16])
const DELETED_ARCHIVE_STATE = -100
const ATTEMPT_SLACK_MS = 10 * 60_000
const UPLOAD_WINDOW_MS = 60 * 60_000   // 一次上传最长跑多久（runStudioPy 的超时）：B站 上稿件的创建时间只可能落在那次尝试开始后的这段时间里

/**
 * B站 上查到的同标题稿件，各是哪一次投稿尝试投出去的？（创建时间必须落在那次尝试自己的上传时间窗里）
 * 只有「恰好一条、看得出投稿时间、状态正常、对得上的是这一轮交审的尝试、BV 没记在别的作品名下、
 * 也没有别的作品用着同一个标题」才自动按它记账。其余情况一律交给主人。
 */
function attributeHits(hits, attempts, sid, id) {
  const live = hits.filter((h) => Number(h.state) !== DELETED_ARCHIVE_STATE)
  if (!live.length) return { none: true }
  const explain = live.map((h) => {
    const t = h.ctime != null ? Number(h.ctime) * 1000 : null
    const att = t == null ? null : attempts
      .filter((a) => a.title === h.title && t >= Date.parse(a.at) - ATTEMPT_SLACK_MS && t <= Date.parse(a.at) + UPLOAD_WINDOW_MS + ATTEMPT_SLACK_MS)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
    const owner = reviewRecords().find((r) => r.id !== id && r.published?.bvid === h.bvid)
    // 别的作品也用这个标题、而且它可能就是这条稿件的来源（还没发布、有不确定的尝试 / 正在上传 / 还在审）→ 分不清，交给主人
    const rival = reviewRecords().find((r) => r.id !== id && !r.published && String(r.submitted?.title ?? '').trim() === String(h.title).trim()
      && (!r.submitted?.rejectedAt || readAttempts(r.id).unresolved.length || readUploadLock(r.id)))
    return { ...h, attempt: att, mine: Boolean(att && att.submissionId === sid), bad: BAD_ARCHIVE_STATES.has(Number(h.state)), unsure: t == null, otherId: owner?.id ?? null, rivalId: rival?.id ?? null }
  })
  const one = explain.length === 1 ? explain[0] : null
  if (one && one.mine && !one.bad && !one.unsure && !one.otherId && !one.rivalId) return { mine: one }
  return { owner: explain }
}

/** 同一次投稿尝试（attempts.json 里的一条）：按开始时间、交审编号、类型认 */
const sameAttempt = (a, b) => Boolean(a && b) && a.at === b.at && a.submissionId === b.submissionId && a.kind === b.kind

const describeHits = (xs) => xs.map((h) => `${h.bvid}《${h.title}》状态 ${h.state ?? '?'}${h.unsure ? '，看不出投稿时间' : ''}${h.otherId ? `，已记在 ${h.otherId} 名下` : h.attempt ? (h.mine ? '，是这一轮交审投出去的' : `，是之前那一轮（${h.attempt.at}）投出去的`) : '，对不上任何一次投稿尝试'}${h.rivalId ? `；另一个作品 ${h.rivalId} 也用这个标题` : ''}`).join('；')

/** 放掉自己拿的上传锁（在队列锁里核对 token；队列锁拿不到也照样只放自己那一把） */
function releaseMine(id, token) {
  try { withQueueLock(() => releaseUploadLock(id, token)) } catch { try { releaseUploadLock(id, token) } catch {} }
}

/**
 * 投稿成功（或者核对后确认就是这一轮投出去的）之后的记账：published.json（防重投的根据）先写，再放锁；后面每一步出错都不能吞掉 BV。
 * 记账在队列锁里做，而且**不覆盖**已有的发布记录：主人 resolve / --force 接手时这边其实还在投 → B站 上可能有两条，原记录不动，交给主人
 */
async function finishPublished(id, item, sid, { bvid, existing = false, state = null, token = null, claim = null, ownAt = null }) {
  const record = () => {
    // claim：这个 BV 不是这次上传投出去的，是去 B站 只读核对认领的。核对那几分钟里主人可能已经 resolve / --force 接手了 ——
    // 记账前在同一把队列锁里确认这次操作还算数，不算数就作废，不能再改发布状态（真正上传投出去的 BV 不走这里，照样记）。
    // 作废时如果发布记录里已经是另一个 BV，核对看到的这一条记进 duplicates（只加证据，不改发布记录）
    if (claim) {
      const why = claim()
      if (why) {
        const p = publishedRecord(id)
        if (p && (p.bvid ?? null) !== (bvid ?? null)) notePublishedDuplicate(id, bvid)
        return { stale: why }
      }
    }
    const p = publishedRecord(id)
    const dup = p && (p.bvid ?? null) !== (bvid ?? null) ? p : null
    if (dup) notePublishedDuplicate(id, bvid)
    else if (!p) markPublished(id, { bvid: bvid ?? null, existing, state, submissionId: sid })
    // 了结哪些尝试：真正上传投出去的（ownAt = 这次上传开始的时间）只了结这次上传自己的记录 ——
    // 被 --retry 接手之后，接手的那次上传如果结果不确定，它的记录不能被这里的 BV 顺手了结（B站 上可能还有一条）
    resolveAttempts(id, `found:${bvid ?? '?'}`, ownAt ? (a) => a.submissionId === sid && a.at === ownAt : (a) => a.submissionId === sid)
    releaseUploadLock(id, token)
    return { dup }
  }
  // 发布之后还有没了结的尝试（别的批准 / 接手留下的）：B站 上可能还有一条，提醒主人
  const leftover = () => {
    let n = 0
    try { n = readAttempts(id).unresolved.length } catch {}
    return n ? `还有 ${n} 次投稿结果不确定、没了结（另一次批准或 --retry 接手留下的）—— B站 上可能还有一条：请到创作中心看一眼，多出来的删掉后用 videos resolve ${id} none 了结` : null
  }
  let dup
  try {
    let r
    try { r = withQueueLock(record) } catch (e) {
      // 队列锁一直拿不到：真正投出去的 BV 不能丢，不带锁照样记（已有记录照样不覆盖）；只读认领的不能不带锁记，下次再核对
      if (!/占着/.test(String(e?.message)) || claim) throw e
      r = record()
    }
    if (r.stale) {
      releaseMine(id, token)
      logEvent('video-claim-stale', bvid ?? id, `核对结果作废：${r.stale}`)
      return { ok: false, stale: true, bvid, state, error: `去 B站 核对的这几分钟里，这条已经被处理过了（${r.stale}）—— 这次核对的结果作废，发布状态和待审队列都没动。` +
        `核对时看到的是 ${bvid ?? '?'}（状态 ${state ?? '?'}）：如果它还在 B站 上、又不是你要的那一条，请到创作中心处理` }
    }
    dup = r.dup
  } catch (e) {
    if (claim) { releaseMine(id, token); return { ok: false, error: String(e?.message ?? e) } }
    logEvent('video-record-failed', bvid ?? id, String(e?.message ?? e).slice(0, 120))
    return { ok: false, bvid, error: `投出去了（${bvid ?? '没拿到 BV 号'}），但发布记录没写上：${String(e?.message ?? e).slice(0, 160)} —— 请主人到创作中心确认后用 videos resolve ${id} ${bvid ?? '<BV号>'} 记上，在那之前别再批准这条` }
  }
  if (dup) {
    logEvent('video-duplicate', bvid ?? id, `已经记着 ${dup.bvid ?? '?'}，这次上传又投出了 ${bvid ?? '?'}`)
    try { dequeueVideo(id, sid) } catch {}
    const more = leftover()
    return { ok: false, duplicate: true, bvid, error: `这条已经记成发布了（${dup.bvid ?? '?'}），这次上传又投出了 ${bvid ?? '（没拿到 BV 号）'} —— B站 上可能有两条，请到创作中心删掉多出来的那条。发布记录没改，多出来的这条记在 published.json 的 duplicates 里${more ? '。' + more : ''}` }
  }
  const notes = []
  const more = leftover()
  if (more) notes.push(more)
  try { dequeueVideo(id, sid) } catch (e) { notes.push('从队列里拿掉失败：' + String(e?.message ?? e).slice(0, 80)) }
  try { writeMeta(id, { status: 'published', bvid, publishedAt: new Date().toISOString() }, '主人批准并发布') } catch (e) { notes.push('作品状态没写上：' + String(e?.message ?? e).slice(0, 80)) }
  logEvent('video-published', bvid ?? id, `主人批准发布${existing ? '（B站 上已经有了，按它记账）' : ''}：${item.title}`)
  try { await runBili(['quota', 'record', '--type', 'video', '--target', bvid ? `BV:${bvid}` : id, '--note', String(item.title).slice(0, 40)], { timeout: 30_000 }) } catch {}
  ownerFeedback(`主人批准发布了视频「${String(item.title).slice(0, 40)}」`)
  return { ok: true, bvid, existing, state, notes }
}

/**
 * 她交审之后，主人又加了 / 换了参考材料（老师的讲义，见 tools/lib/reference.mjs）：交审时的查重没比过这几份。
 * 上传前用审片快照里的剧本（她写不到，指纹核对过）和这几份再比一遍：拦的、提醒的、材料读不了的，都先告诉主人、不投；
 * 主人看过、认为没问题 → videos approve <id> --reference-ok 再批。
 * 交审时比过的材料记在队列里（originality.references：id + 指纹）；老版本交的没有这一项 = 一份都没比过
 */
function referencesSinceSubmit(id, item, referenceOk) {
  // 宽松地列：某一份坏了，别的照样比（坏的那份记成「没比成」一起告诉主人）；只有整个目录读不了才什么都比不了
  let now
  try { now = listReferences(undefined, { tolerant: true }) } catch (e) {
    if (referenceOk) { logEvent('video-reference-accepted', id, '主人确认参考材料这一关不拦（参考材料目录读不了）'); return null }
    return `参考材料读不了，没法确认这条和讲义有没有重合 —— 不投（${e.message}）。修好材料再批；或者确认不用比，videos approve ${id} --reference-ok`
  }
  const seen = new Map((Array.isArray(item.originality?.references) ? item.originality.references : []).map((r) => [r?.id, r?.sha256]))
  // 坏掉的那份（说明坏了、文字不见了）一律算「变了」：交审时它还是好的（坏的话她交不了审）；只有文字、没有说明的不算数
  const fresh = now.filter((r) => (r.broken ? !r.broken.startsWith('只有文字') : seen.get(r.id) !== r.sha256))
  if (!fresh.length) return null
  let script
  try {
    const buf = fs.readFileSync(path.join(reviewDir(id), 'script.json'))
    if (crypto.createHash('sha256').update(buf).digest('hex') !== item.hashes['script.json']) {
      logEvent('video-tampered', id, '审片快照里的剧本和交审时对不上（批准前比参考材料时发现）')
      return '审片快照里的剧本和交审时对不上 —— 不投。用 videos reject 退回，让她重新交审'
    }
    script = JSON.parse(buf.toString('utf8'))
  } catch (e) { return `审片快照里的剧本读不了（${e?.code ?? 'JSON 坏了'}），没法和参考材料比 —— 不投` }
  const r = referenceOverlap(script, undefined, { ids: fresh.map((x) => x.id) })
  const names = fresh.map((x) => `「${x.name}」`).join('')
  if (!r.hits.length && !r.flags.length && !r.errors.length) { logEvent('video-reference-ok', id, `交审之后加的参考材料${names}也比过了：没有重合`); return null }
  const lines = [...r.hits.map((h) => '对上了：' + describeHit(h)), ...r.flags.map((h) => '提醒：' + describeHit(h)), ...r.errors.map((e) => '没比成：' + e)]
  if (referenceOk) { logEvent('video-reference-accepted', id, `主人确认参考材料这一关不拦（${names}）：${lines.join('；').slice(0, 200)}`); return null }
  logEvent('video-reference-blocked', id, `交审之后加的参考材料${names}：${lines.join('；').slice(0, 200)}`)
  return `她交审之后你加了 / 换了参考材料${names}，上传前用要投的这份剧本和它比了一遍 —— 先不投，你看一下：\n` +
    lines.map((s) => '  · ' + s).join('\n') +
    `\n  看过觉得没问题（比如是公认的数值、标准的一句话）：videos approve ${id} --reference-ok\n  要她改：videos reject ${id} 理由`
}

/**
 * 读书（2026-10-28）：她交审之后可能又读了网页 —— 上传前用快照里的剧本和现在所有读过的网页的指纹再比一遍。
 * 对上了先不投（主人看过觉得没问题：--reference-ok 一起放行）；没装读书 / 没读过网页 → 不比。
 * 快照里的剧本读不了、和交审时对不上：这里不比，交给后面上传锁里那道整份快照的核对（它一定会拦，话也说清是哪个文件）
 */
function webSinceSubmit(id, item, referenceOk) {
  if (!webOverlap) return null
  let script
  try {
    const buf = fs.readFileSync(path.join(reviewDir(id), 'script.json'))
    if (crypto.createHash('sha256').update(buf).digest('hex') !== item.hashes['script.json']) return null
    script = JSON.parse(buf.toString('utf8'))
  } catch { return null }
  const r = webOverlap(scriptText(script))
  if (!r.hits.length) return null
  const lines = r.hits.map((h) => describeHit(h))
  if (referenceOk) { logEvent('video-web-accepted', id, `主人确认读过的网页这一关不拦：${lines.join('；').slice(0, 200)}`); return null }
  logEvent('video-web-blocked', id, lines.join('；').slice(0, 200))
  return '上传前和她读过的网页比了一遍，有一段一样 —— 先不投，你看一下：\n' + lines.map((s) => '  · ' + s).join('\n') +
    `\n  看过觉得没问题（比如引的是古文原文）：videos approve ${id} --reference-ok\n  要她改：videos reject ${id} 理由`
}

/** 上传副本里的剧本和读过的网页撞了 → 一句话；没撞上 / 没装读书 → null（副本已经核过指纹，读不了就当撞上：不投） */
function webCopyHits(file) {
  if (!webOverlap) return null
  let script
  try { script = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return `副本里的剧本读不了（${e?.code ?? 'error'}）` }
  const r = webOverlap(scriptText(script))
  return r.hits.length ? r.hits.map((h) => describeHit(h)).join('；') : null
}

/** 现在有哪些参考材料（id + 指纹）：批准途中（核对 B站 那几分钟）材料变了，上传前就停下 */
function referenceSnapshot() {
  try { return JSON.stringify(listReferences(undefined, { tolerant: true }).map((r) => [r.id, r.sha256, r.broken ?? ''])) } catch { return '读不了' }
}

/**
 * 批准 = 投稿。闸门：
 *   ① 投过的不再投：快照目录里有 published.json
 *   ② 审什么投什么：从审片快照（她写不到）复制一份私有副本、核对指纹、从副本上传；查重报告必须就是这一份剧本的
 *   ③ 一次只有一个在投：上传锁是独占创建的文件；「拿上传锁 + 再确认还在队列里」在队列锁里一起做 —— 和退回互斥
 *   ④ 结果不确定的投稿（上传报错 / 中途崩掉）记进 attempts.json，**退回、重交都不会清掉**。
 *      还有没了结的尝试时，投之前先去 B站 查：没查到 → 了结，照常投；查到了而且就是这一轮交审投出去的 → 按它记账，不重投；
 *      别的情况（以前那一轮投出去的、分不清是哪一轮的、被打回 / 锁定的）→ 不投，请主人去创作中心确认后用 videos resolve
 *   ⑤ 她交审之后主人又加了 / 换了参考材料（讲义）：上传前用快照里的剧本和新材料再比一遍（referencesSinceSubmit；主人看过可以 --reference-ok）
 */
export async function approveVideo(id, opts = {}) {
  // 防重投的记录读不出来（文件坏了）会抛错：转成一句给主人的话，什么都不投
  try { return await approveVideoInner(id, opts) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
async function approveVideoInner(id, { retry = false, referenceOk = false } = {}) {
  const item0 = pendingVideos().find((x) => x.id === id)
  if (!item0) return { ok: false, error: '队列里没有这条（可能已经处理过）' }
  const pub = publishedRecord(id)
  if (pub) return { ok: false, error: `这条已经发布过了（${pub.bvid ?? '?'}），不会再投` }
  if (!item0.hashes || !item0.snapshot || !item0.originality?.scriptSha) {
    // 旧版本交的审：没有快照 / 查重报告没绑定剧本，没法确认要投的就是查过、审过的那一份。直接退回（腾出在审名额），她重新渲染再交
    const why = '旧版本交的审（没有审片快照，或查重报告没绑定剧本）：请重新 studio render 再交'
    const rj = rejectVideo(id, why)
    return { ok: false, error: rj.ok ? `这条是旧版本交的审，不能投 —— 已经替你退回（理由：${why}）` : rj.error }
  }
  if (item0.originality.scriptSha !== item0.hashes['script.json']) {
    logEvent('video-tampered', id, '查重报告查的不是交审的这份剧本')
    return { ok: false, error: '查重报告查的不是交审的这份剧本 —— 不投。用 videos reject 退回，让她重新交审' }
  }
  const refSnap = referenceSnapshot()
  const refProblem = referencesSinceSubmit(id, item0, referenceOk)
  if (refProblem) return { ok: false, error: refProblem }
  const webProblem = webSinceSubmit(id, item0, referenceOk)
  if (webProblem) return { ok: false, error: webProblem }
  const sid = subId(item0)
  // ③ 拿上传锁 + 再确认（队列锁里做）
  let got
  try {
    got = withQueueLock(() => {
      let lock = acquireUploadLock(id, { submissionId: sid, title: item0.title })
      if (!lock.ok) {
        if (uploadLockLive(lock.lock) && !retry) {
          return { needRetry: true, error: `正在投稿（${lock.lock.at ?? '?'} 开始，进程 ${lock.lock.pid ?? '?'}）—— 等它投完。确认那个进程其实已经不在跑了，再用 videos approve ${id} --retry` }
        }
        crashedLockToAttempt(id, lock.lock)   // 那个进程已经不在了（或者主人确认它不在跑）：当成一次结果不确定的尝试
        lock = acquireUploadLock(id, { submissionId: sid, title: item0.title })
        if (!lock.ok) return { error: '另一个批准刚刚拿到了上传锁，这次不投' }
      }
      // 拿到上传锁**之后**再确认：前一个批准是先写 published.json 再放锁的，所以这里一定看得到；这一轮也必须还在队列里
      const cur = pendingVideos().find((x) => x.id === id)
      const p = publishedRecord(id)
      if (p || !cur || subId(cur) !== sid) {
        releaseUploadLock(id, lock.token)
        return { error: p ? `这条刚刚已经发布了（${p.bvid ?? '?'}），不会再投` : '这条刚刚被处理掉了（不在队列里了，或者已经是新的一轮交审），不投' }
      }
      return { item: cur, token: lock.token }
    })
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  if (got.error) return { ok: false, error: got.error, needRetry: Boolean(got.needRetry) }
  const { item, token } = got
  const unlocked = (res) => { releaseMine(id, token); return res }
  // 拿到上传锁之后、真正开始上传之前出了意外（attempts.json 读不了、复制副本失败…）：放掉自己的锁再报错 ——
  // 不然下次批准会把这把锁当成「上传途中崩掉」，记一次其实没发生过的不确定尝试
  let uploadStarted = false
  try {
    // ④ 还有没了结的投稿尝试：先去 B站 核对
    const att = readAttempts(id)
    let checked = []   // 核对过、B站 上没有的那几次尝试（上传前在队列锁里了结）
    if (att.unresolved.length) {
      const titles = [...new Set([...att.unresolved.map((a) => a.title).filter(Boolean), item.title])]
      const since = Math.min(...att.unresolved.map((a) => Date.parse(a.at)).filter(Number.isFinite))
      const r = await runStudioPy(['existing', '--cred', CRED_FILE, '--titles', JSON.stringify(titles), ...(Number.isFinite(since) ? ['--since', String(Math.floor(since / 1000))] : [])], { timeout: 3 * 60_000 })
      const j = lastJson(r.out)
      if (!j?.ok) {
        return unlocked({ ok: false, error: `之前有 ${att.unresolved.length} 次投稿结果不确定（B站 可能其实已经收到了），要先去 B站 核对，但没查成（${String(j?.error ?? r.err).slice(0, 160)}）—— 没有上传。\n` +
          `可以稍后再试；一直查不成的话，去创作中心看一眼，然后用 videos resolve ${id} none（B站 上没有）或 videos resolve ${id} <BV号>（就是那一条）了结` })
      }
      const d = attributeHits(j.hits ?? [], att.unresolved, sid, id)
      if (d.mine) {
        // 认领之前在队列锁里再确认：上传锁还是这次批准的、这一轮还在队列里、还没有发布记录、被认领的那次尝试还没了结
        const claimed = d.mine.attempt
        const claim = () => {
          if (readUploadLock(id)?.token !== token) return '上传锁已经不是这次批准的了（主人 --force / --retry 接手过）'
          if (!pendingVideos().some((x) => x.id === id && subId(x) === sid)) return '这一轮交审已经不在队列里了'
          const p = publishedRecord(id)
          if (p) return `已经有发布记录了（${p.bvid ?? '?'}）`
          if (!readAttempts(id).unresolved.some((a) => sameAttempt(a, claimed))) return '那次结果不确定的投稿已经被了结了（主人 videos resolve 过）'
          return null
        }
        const res = await finishPublished(id, item, sid, { bvid: d.mine.bvid, existing: true, state: d.mine.state, token, claim })
        if (res.ok) logEvent('video-found-existing', d.mine.bvid, `核对 B站：这一轮交审之前的投稿其实已经成功了（${d.mine.bvid}）`)
        return res
      }
      if (d.owner) {
        return unlocked({ ok: false, needResolve: true, error: `之前有投稿结果不确定，B站 上查到了同标题的稿件：${describeHits(d.owner)}。没有上传。\n` +
          `请到创作中心看一下：如果是要的就是这一条，用 videos resolve ${id} <BV号> 记成已发布；如果是多出来的、你已经删掉了，用 videos resolve ${id} none，然后再批准` })
      }
      checked = att.unresolved   // 核对过：B站 上没有 → 这些尝试都没投出去（下面上传前了结）
    }

    // 上传：从私有副本上传 —— 上传那几分钟里快照被动过也影响不到上传的字节
    const copy = uploadCopy(id)
    try {
      const changed = Object.keys(item.hashes).filter((f) => item.hashes[f] !== copy.hashes[f])
      if (changed.length) {
        logEvent('video-tampered', id, `审片快照对不上：${changed.join('、')}`)
        return unlocked({ ok: false, error: `审片快照里这些文件和交审时对不上：${changed.join('、')} —— 不投。用 videos reject 退回，让她重新交审` })
      }
      // 真正上传之前在队列锁里再确认一次（核对 B站 那几分钟里，主人可能 --force 退回 / resolve / --retry 接手了）：
      // 上传锁还是自己的、还没有发布记录、这一轮还在队列里，才投；核对过、没查到的那几次尝试在这里了结（只了结核对过的那几次）
      const gone = withQueueLock(() => {
        if (readUploadLock(id)?.token !== token) return '上传锁已经被接手了（主人用了 --force / --retry）'
        const p = publishedRecord(id)
        if (p) return `这条已经记成发布了（${p.bvid ?? '?'}）`
        if (!pendingVideos().some((x) => x.id === id && subId(x) === sid)) return '这一轮交审已经不在队列里了（被退回 / 处理掉了）'
        if (!referenceOk && referenceSnapshot() !== refSnap) return '批准途中参考材料变了（刚加 / 换了讲义）：再批一次，会先和新的讲义比'
        // 批准途中（核对 B站 那几分钟）她可能又读了网页：用要上传的这份副本的剧本最后再比一遍
        const late = referenceOk ? null : webCopyHits(path.join(copy.dir, 'script.json'))
        if (late) {
          logEvent('video-web-blocked', id, late.slice(0, 200))
          return `上传前最后和她读过的网页比了一遍，有一段一样（${late}）：先不投，你看一下。没问题：videos approve ${id} --reference-ok；要她改：videos reject ${id} 理由`
        }
        if (checked.length) resolveAttempts(id, 'not-found', (a) => checked.some((c) => sameAttempt(a, c)))
        return null
      })
      if (gone) return unlocked({ ok: false, error: `${gone} —— 没有上传` })
      const startedAt = readUploadLock(id)?.at ?? new Date().toISOString()
      uploadStarted = true
      const r = await runStudioPy(['upload', copy.dir, '--cred', CRED_FILE, '--ai-statement', studioConfig().aiStatement ?? ''])
      const j = lastJson(r.out)
      if (!j?.ok && j?.notStarted === true) {
        // studio.py 上传前就挡下了（分区号 / 创作声明 / 没有成片）：一个字节都没传，不记成「结果不确定」，也不说「B站 可能收到了」
        const err = String(j.error ?? '').slice(0, 300)
        const rel = () => releaseUploadLock(id, token)
        try { withQueueLock(rel) } catch (e) { if (!/占着/.test(String(e?.message))) throw e; rel() }
        logEvent('video-upload-refused', id, err.slice(0, 120))
        return { ok: false, error: err }
      }
      if (!j?.ok) {
        const err = String(j?.error ?? r.err).slice(0, 300)
        // 上传报错 ≠ 没投出去（可能是响应丢了 / 超时）：记成一次结果不确定的尝试 —— 退回、重交都清不掉，下次批准一定先去 B站 核对
        const note = () => { addUncertainAttempt(id, { at: startedAt, submissionId: sid, title: item.title, error: err }); releaseUploadLock(id, token) }
        // 队列锁一直拿不到也要记下这次尝试；记不上（attempts.json 坏了）就抛出去、锁留着：下次会当成崩掉的上传记进去
        try { withQueueLock(note) } catch (e) { if (!/占着/.test(String(e?.message))) throw e; note() }
        logEvent('video-upload-failed', id, err.slice(0, 120))
        return { ok: false, uncertain: true, error: `${err}\n（B站 那边可能其实已经收到了：已经记下这次尝试，下次批准会先去 B站 核对，不会直接重投）` }
      }
      return await finishPublished(id, item, sid, { bvid: j.bvid ?? null, token, ownAt: startedAt })
    } finally {
      copy.cleanup()
    }
  } catch (e) {
    if (!uploadStarted) releaseMine(id, token)
    throw e
  }
}

/**
 * 否掉：她下次 `studio list` 能看到理由（也进事件流 → 偏好校准）。
 * 正在上传的不能否（上传和退回在队列锁里互斥）；结果不确定的投稿尝试不会因为退回而清掉
 */
export function rejectVideo(id, reason = '', { force = false } = {}) {
  let r
  try {
    r = withQueueLock(() => {
      const it = pendingVideos().find((x) => x.id === id)
      if (!it) return { error: '队列里没有这条' }
      const lock = readUploadLock(id)
      if (lock && uploadLockLive(lock) && !force) {
        return { error: `正在投稿（${lock.at ?? '?'} 开始，进程 ${lock.pid ?? '?'}）—— 投稿进行中不能退回（B站 可能已经收到了）。等它结束：投成功了就去创作中心处理；投失败了再退回。` +
          `确认那个投稿进程其实已经不在了（比如电脑重启过），用 videos reject ${id} --force（会记成一次结果不确定的投稿）` }
      }
      if (lock) crashedLockToAttempt(id, lock)   // 上次崩在上传途中：记成不确定的尝试，再退回
      savePendingVideos(pendingVideos().filter((x) => !(x.id === id && subId(x) === subId(it))))
      markRejected(id)   // 名额 / 集数还给她（账在 ~/.bili-ai，她改不了）
      return { item: it }
    })
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  if (r.error) return { ok: false, error: r.error }
  try { writeMeta(id, { status: 'rejected', rejectReason: String(reason).slice(0, 200) || '（没说理由）' }, '主人没通过') } catch {}
  logEvent('video-rejected', id, `主人否掉了视频「${r.item.title}」${reason ? '：' + String(reason).slice(0, 80) : ''}`)
  ownerFeedback(`主人看了她的视频「${String(r.item.title).slice(0, 40)}」，没通过`)
  return { ok: true, uncertain: readAttempts(id).unresolved.length }
}

/**
 * 主人亲自了结「结果不确定」的投稿尝试（去创作中心看过之后）：
 *   videos resolve <id> none       B站 上没有 / 多出来的已经删掉了 → 了结，之后可以照常批准
 *   videos resolve <id> BV1xxxx    这个作品在 B站 上就是这一条 → 记成已发布（以后再也不会投它），从队列里拿掉
 */
export async function resolveVideo(id, what, { force = false } = {}) {
  const v = String(what ?? '').trim()
  if (v !== 'none' && !/^BV[0-9A-Za-z]{10}$/.test(v)) return { ok: false, error: '要写 none（B站 上没有 / 已删掉），或者 B站 上那一条的 BV 号' }
  // 判断和改状态都在队列锁里做（和批准拿上传锁、退回同一把锁）：
  //   批准先拿到上传锁 → 这里看得到、拒绝；这里先记了发布 → 批准拿到上传锁后看得到 published.json、不投
  let r
  try {
    r = withQueueLock(() => {
      const lock = readUploadLock(id)
      if (lock && uploadLockLive(lock) && !force) return { error: `正在投稿（${lock.at ?? '?'} 开始，进程 ${lock.pid ?? '?'}），等它结束再处理；确认它其实已经不在了，加 --force` }
      if (lock) crashedLockToAttempt(id, lock)   // 只清掉刚才判断过的那一把
      if (v === 'none') return { none: resolveAttempts(id, 'owner:none') }
      const other = reviewRecords().find((x) => x.id !== id && x.published?.bvid === v)
      if (other) return { error: `${v} 已经记在 ${other.id} 名下了` }
      const p = publishedRecord(id)
      if (p) return { error: `这条已经记过发布了（${p.bvid ?? '?'}）` }
      const item = pendingVideos().find((x) => x.id === id) ?? { id, title: readJson(path.join(reviewDir(id), 'submitted.json'))?.title ?? id }
      markPublished(id, { bvid: v, existing: true, state: null, submissionId: subId(item), by: 'owner' })
      resolveAttempts(id, `owner:${v}`)
      return { item }
    })
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  if (r.error) return { ok: false, error: r.error }
  if (r.none != null) {
    logEvent('video-attempts-resolved', id, `主人确认 B站 上没有 / 已删掉（了结 ${r.none} 次不确定的投稿）`)
    return { ok: true, resolved: r.none }
  }
  // 发布记录已经在锁里写好了；这里只做后续（出队、作品状态、记账、反馈），finishPublished 看到同一个 BV 不会再写
  return finishPublished(id, r.item, subId(r.item), { bvid: v, existing: true })
}

/** 主人有表态（审片、审草稿、确认频道设定、当面聊…）→ 记一次反馈（沉默衰减清零）。记不上不影响主流程 */
export function ownerFeedback(note) {
  return runBili(['quota', 'react', '--note', String(note).slice(0, 80)], { timeout: 30_000 }).catch(() => null)
}

/** 主人审的永远是快照（就是会被上传的那一份）。不退回作品目录：那一份她还能改 */
export function videoFile(id) {
  return path.join(reviewDir(id), 'final.mp4')
}

export function setImageKey(key) {
  key = String(key ?? '').trim()
  fs.mkdirSync(path.dirname(IMAGE_KEY_FILE), { recursive: true })
  if (!key) { fs.rmSync(IMAGE_KEY_FILE, { force: true }); return { ok: true, detail: '已删除配图 key' } }
  fs.writeFileSync(IMAGE_KEY_FILE, key + '\n')
  try { fs.chmodSync(IMAGE_KEY_FILE, 0o600) } catch {}
  return { ok: true, detail: `已保存（${key.slice(0, 4)}…，不会回显）` }
}

export { readMeta }

// ─────────────── 「同一个人只回一条」的判重记录：主人看 / 解除 ───────────────
export const REPLIED_FILE = path.join(HOME, '.bili-ai', 'replied.json')
/** 30 天内回过谁（含正在发 / 结果不确定的预留）。账本读不了 → 抛错 */
export function listReplied() {
  let raw
  try { raw = fs.readFileSync(REPLIED_FILE, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return []; throw e }
  const led = JSON.parse(raw)
  return Object.entries(led?.byUid ?? {}).map(([mid, list]) => ({ mid, list: Array.isArray(list) ? list : [] }))
}
/** 解除一个人的判重记录：主人确认上次其实没发出去（结果不确定 / 没等到回包），或者就是想再回这个人一次 */
export function releaseReplied(mid) {
  mid = String(mid ?? '').trim()
  if (!/^\d{1,20}$/.test(mid)) return { ok: false, error: '要给对方的 mid（数字）：replied release <mid>' }
  let n = 0
  try {
    updateJsonLocked(REPLIED_FILE, (led) => {
      if (!led || typeof led !== 'object' || !led.byUid || typeof led.byUid !== 'object' || Array.isArray(led.byUid)) throw new Error('replied.json 结构不对')
      n = Array.isArray(led.byUid[mid]) ? led.byUid[mid].length : 0
      delete led.byUid[mid]
      return led
    }, { byUid: {} })
  } catch (e) {
    return { ok: false, error: `${String(e?.message ?? e).slice(0, 160)} —— 账本坏了的话，看一下或删掉 ${REPLIED_FILE}（删掉 = 30 天内回过谁的记录全清空）` }
  }
  logEvent('replied-released', mid, `主人解除了对 ${mid} 的「同一个人只回一条」记录（${n} 条）`)
  return { ok: true, removed: n }
}

/** 今天的状态（等价于 GET /api/status） */
export function status() {
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
  const quota = readJson(path.join(HOME, '.bili-ai', 'quota.json')) ?? { log: [] }
  const today = new Date().toLocaleDateString('sv-SE')
  // 模块登记的私下记录（PRIVATE_LEDGER，比如回私信的）不算「对外发言」（面板另有一栏）
  const todays = (quota.log ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today && !PRIVATE_LEDGER.has(x.type))
  const night = readJson(path.join(DSH_HOME, 'whale-night.json'))
  const replied = readJson(path.join(HOME, '.bili-ai', 'replied.json'))
  return {
    today,
    shares: todays.filter((x) => x.share).length,
    sharesMax: (() => { const n = shareDailyOf(readConfig().quota?.shareDaily); return Number.isFinite(n) ? n : null })(),   // null = 不限
    sharesOn: shareEnabled(readConfig()),   // 停分享现在用 share.enabled false（以前用 shareDaily 0）：状态行要能看出来
    commentsToday: todays.length,
    repliedPeople: Object.keys(replied?.byUid ?? {}).length,
    pending: listPending().length,
    pendingVideos: pendingVideos().length,
    plan: night ? { date: night.date, action: night.action, atText: night.atText ?? null, wakes: Number(night.wakes ?? 0), windows: night.usedWindows ?? [] } : null,
    host: readJson(path.join(HOST_DIR, 'daemon.json')),
    session: readJson(path.join(HOST_DIR, 'session.json')),
  }
}
