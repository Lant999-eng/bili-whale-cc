// 「她的小窗」的服务端：一个小进程，把她这会儿在干什么翻成短短的中文事件，推给 Edge 小窗（host/window-ui/）和桌宠（host/pet.ps1）；
// 小窗底下的输入框和按钮（跟她说话、叫醒她、启动宿主、审视频 / 频道设定）也从这里过。
//   node host/window.mjs [--port 8766]   平时不用直接跑：node host/cli.mjs window 会按需在后台起它（cli 那边的逻辑在本文件最后的 windowCommand）
//
// 规矩：
//   · 自己只看不动。只写 <数据目录>/whale-cc/window.json（一次性口令 + 桌宠令牌 + 正在替主人做的事，先写临时文件再改名）；只读 window-ctl.json（cli 写的「要不要桌宠」）
//     和 window-chat.jsonl（cli say 记的原话）。不调宿主的 isBusy / kick / session()，不碰队列，不起她的回合，不连 B站、不连别的聊天软件。宿主停了这里照样跑，显示「离线」。
//   · 主人在小窗里点的事，一律是替他跑 cli（node host/cli.mjs …，参数是数组、不经过 shell）：白名单里的几样（ACTS），参数在这里先查一遍
//     （视频 id 要是现在真等审的那条、频道指纹是十六进制、要说的话 ≤2000 字），cli 照它平时的规矩再查一遍。投稿要点两次：
//     第一次只拿到一个两分钟内有效、只能用一次、绑着这个窗口和这条视频的确认口令，带着它再来一次才真投。
//     只认小窗页面自己（cookie 那个窗口；桌宠的令牌不行）：POST、Origin 是这个服务自己、Sec-Fetch-Site 是 same-origin、JSON、
//     还要带这个窗口自己的操作令牌（/api/me 给，别的网页读不到）；每个窗口一分钟最多 30 次。
//   · 聊天的原话和她的回复只给小窗页面（快照里的 chat、SSE 的 chat 事件）：桌宠拿到的快照里没有 —— 桌宠没有「遮住私话」
//   · 她的会话记录只读 claude-config/projects/<她家目录的名字>/<uuid>.jsonl 这一种：uuid 格式对、是普通文件（不是链接 / 联接、没有别的硬链接）、
//     真实路径就在那个目录里。那个配置目录里还放着她的登录凭据（.credentials.json、sessions/*.key），别的一概不列、不开。
//   · 原始行到不了页面：翻译在 liveview.mjs 里做（白名单里的短事件，每个字符串 ≤80，凭据样子的抹掉 / 整条丢）；
//     服务端自己往快照里拼的字（标题、作息理由、回合 id）也过一遍同样的净化。
//   · 只监听 127.0.0.1；Host 头只认 127.0.0.1 / localhost:端口（挡 DNS 重绑定）；只接 GET / HEAD（和 POST /api/act）；别的网站来的请求不理；不发 CORS 头。
//     这台电脑上别的本地账号也连得上回环地址（CodexSandboxOnline 没被挡）→ 光看 Host 不够，要口令：
//     cli 从 window.json（只有主人读得到）拿一次性口令 → /?k=口令 换成 HttpOnly + SameSite=Strict 的 cookie；桌宠用环境变量给的令牌（X-Whale-Pet 头）。
//   · 记录要晚 2–25 秒才落盘（claude -p 一条回复写完才落一次）：时间一律用记录里的 t，计算「刚刚」用服务端收到的时刻（translator.recent 的 rx）；
//     开机重放出来的旧事件例外（translator.settle()：按它们自己的 t 算，开小窗那一刻不是「刚刚」）。
//   · 回合的时刻处处说开始（每组的回合头、turn.at、lastTurn.at），结束另给（turn_end 的 t、lastTurn.endedAt）：结果日志的 at 是结束时写的，要减用时。
import './env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT, HOST_DIR, DSH_HOME, AGENT_CONFIG_DIR, readConfig } from './core.mjs'
import { STATE as DAEMON_FILE, daemonAlive, pidAlive } from './state.mjs'
import { RUNNING_FILE, SHOTS_DIR, killTree } from './claude.mjs'
import { collect, PRIVATE_SEND_TYPES } from './dashboard.mjs'
import { readTurnLogs, turnCosts } from './turncost.mjs'
import { workDir } from './workdir.mjs'
import { VIEW_VERSION, MAX_LINE, createTranslator, stateOf, kindOf, isOwnerKind, clean, redact, sanitizeEvent, whenText } from './liveview.mjs'
import { listCast, CAST_DIR, STUDIO_DIR, TALK_DIR } from '../tools/lib/studio.mjs'
import { readWatch } from '../tools/lib/watchlog.mjs'
import { isPending as planPending, inWindow as nightOpen } from '../tools/lib/night-plan.mjs'
import { readNightConfig } from '../tools/lib/night-config.mjs'
import { personaName } from '../tools/lib/config.mjs'
import { cmdLine, cmdLineChecked, renameRetry, writeJsonAtomic } from '../tools/lib/filelock.mjs'
import { CHAT_FILE, SAY_MAX, REPLY_MAX, readChat, chatView, normalizeSay, isWinId } from './winchat.mjs'
import { VIDEO_ID_RE, TAG_SHOW, TAG_LEN, videoCards, channelCard } from './review.mjs'

const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const UI_DIR = path.join(HERE, 'window-ui')
const PET_PS1 = path.join(HERE, 'pet.ps1')
const CLI = path.join(HERE, 'cli.mjs')
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')   // 绝对路径：不让 PATH 里的同名程序顶替
export const DEFAULT_PORT = 8766                                  // 固定端口：Edge 按地址记窗口放在哪
export const INFO_FILE = path.join(HOST_DIR, 'window.json')       // { pid, port, startedAt, code, codeExpiresAt, petToken }：这个服务唯一会写的文件
export const CTL_FILE = path.join(HOST_DIR, 'window-ctl.json')    // { pet }：cli 写，这里每 2 秒读一次
export const EDGE_PROFILE = path.join(HOST_DIR, 'window-edge')    // 小窗专用的 Edge 配置（不登录、不同步）
const LOG_DIR = path.join(HOST_DIR, 'logs')
const SESSION_FILE = path.join(HOST_DIR, 'session.json')
const NIGHT_FILE = path.join(DSH_HOME, 'whale-night.json')
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/   // 只认 Claude Code 自己起的小写 uuid
const BV_ONLY = /^BV[0-9A-Za-z]{10}$/
const DROP_RE = /SESSDATA|bili_jct|cookie|token|secret|password|api[-_]?key/i
const POLL_MS = 750, CTL_MS = 2000, SLOW_MS = 30_000, CODE_TTL = 60_000, CODE_ROTATE = 30_000
// 心跳：SSE 每 10 秒发一条 event: hb（{ at }）。注释行（:hb）EventSource 看不见 —— 服务卡死 / 被停掉时页面要靠「多久没听到心跳」认出来，
// 不然它会一直拿最后那份快照显示「醒着」、计时照走、「宿主心跳 615 秒前」
export const BEAT_MS = 10_000
const RUN_TAIL_MS = 60_000                                        // running.json 没了以后，还按那个回合认记录尾巴多久（落盘晚 2–25 秒；再久就是它没收尾就崩了）
const VIEWER_WAIT_MS = 10_000                                     // cli 等一个正在起的小窗服务最多多久
const RING = 500, FEED = 150, MAX_CLIENTS = 4, MAX_SESSIONS = 16
// 小窗里能点的事 → 替主人跑的 cli（参数在 actArgs 里拼）、最多等多久、是不是「审」（同一时间只跑一件）。
// 投稿要上传：给 70 分钟（core 自己最多等上传锁 3 分钟 + 上传 60 分钟，比它短就会把正常的上传掐断）；跟她说给 2 分钟（cli say 只入队，平时一两秒）
export const ACTS = {
  say: { label: '跟她说', ms: 120_000 }, wake: { label: '叫醒她', ms: 60_000 }, start: { label: '启动宿主', ms: 90_000 }, play: { label: '看片', ms: 30_000 },
  approve: { label: '投稿', ms: 70 * 60_000, review: true }, reject: { label: '退回视频', ms: 60_000, review: true },
  'channel-approve': { label: '确认频道设定', ms: 60_000, review: true }, 'channel-reject': { label: '退回频道设定', ms: 60_000, review: true },
}
const ACT_BODY_MAX = 16 * 1024, ACT_RATE = 30, ACT_WAIT_MS = 15_000, CONFIRM_TTL = 120_000, JOBS_KEEP = 20, JOBS_RUNNING_MAX = 3, OUT_MAX = 6000
const REASON_MAX = 200, CHANNEL_NOTE_MAX = 2000   // 退回的理由：core 只存前 200 字（多写的她看不到）
const DESC_SHOW = 6000                            // 审核面板里简介最多显示几个字：比 B站 的简介上限大得多 —— 超过了就不让在小窗里投（主人没看全会发出去的字）
export const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
const BASE_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': CSP, 'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
}
const STATIC = { '/window': ['index.html', 'text/html; charset=utf-8'], '/window.js': ['window.js', 'text/javascript; charset=utf-8'],
  '/player.mjs': ['player.mjs', 'text/javascript; charset=utf-8'], '/window.css': ['window.css', 'text/css; charset=utf-8'] }   // window.js 用 import './player.mjs'
const EXPIRED = '这个小窗要从命令行打开：node host/cli.mjs window（地址里的口令一分钟内有效、只能用一次）'
const EMPTY_TODAY = { turns: 0, costUsd: null, watched: 0, watchedList: [], sent: 0, dmToOwner: 0, pending: 0, pendingVideos: 0, pendingDrafts: 0, uncertain: 0 }
const isChatId = (id) => typeof id === 'string' && /^chat-\d+$/.test(id)   // liveview 起的「当面聊」假回合

// ─────────────── 小工具 ───────────────
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
/** 往前数 back 个日历日（从中午往回退：夏令时那天「减 24 小时」会跳过 / 重复一天） */
const dayBack = (now, back) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - back); return localDay(d) }
const pad = (n) => String(n).padStart(2, '0')
const hhmm = (ms) => { const d = new Date(ms); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const byAt = (a, b) => Date.parse(a?.at) - Date.parse(b?.at)
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
/**
 * 小窗的名字（窗口标题的开头、立绘的 alt）：persona.name，没起名字 = bili-whale（tools/lib/config.mjs 的 personaName，面板标题也用它）。
 * 服务把它填进页面，window.js 从页面标题拿；cli window --top 按同一个名字找窗口 —— 两边都现读配置（改了名字，开着的小窗刷新一下才换）
 */
const windowName = () => { try { return personaName(readConfig()) } catch { return personaName({}) } }
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
/** index.html 里写的是 bili-whale（没换也能看）：标题和立绘的 alt 换成她的名字。名字一律转义；用函数替换（名字里的 $& 不会被当成替换模式） */
export const withName = (html, name) => String(html)
  .replace('<title>bili-whale</title>', () => `<title>${escHtml(name)}</title>`)
  .replace('<img id="sp-closed" class="frame" alt="bili-whale">', () => `<img id="sp-closed" class="frame" alt="${escHtml(name)}">`)
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()
/** 比口令 / 令牌：先各自哈希成一样长再 timingSafeEqual（长度不同也不提前返回） */
export const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b))
/** 服务端自己拼进快照的字：和事件一样去控制字符、抹凭据样子；抹完还认得出凭据字样就不要了 */
function safe(s, n = 80) {
  if (typeof s !== 'string') return null
  const t = clean(redact(clean(s, 4000)), n)
  return t && !DROP_RE.test(t) ? t : null
}
/**
 * 多行的字（聊天的原话和她的回复、她写的简介 / 频道设定、cli 的输出）：换行留着，看不见的字去掉，按字符截短（cut：截过）。
 * scrub：凭据样子的抹掉（聊天、cli 输出）。审核面板里她写的简介 / 设定不抹 —— 那是会原样发出去的字，主人得看到真的那一份；
 * 去掉了看不见的字就带上 invisible，页面提醒一句。看不见的字：Unicode 说「默认不显示」的（Default_Ignorable：零宽、方向控制、软连字符、
 * 韩文填充符、变体选择符、标签字符、保留的那一大段…）和格式字符（\p{Cf}），表情里正常的除外（见 HIDDEN_RE）；
 * C0 / C1 控制字符和行 / 段分隔符（这两种换成空格，别的直接去掉）
 */
// 表情里正常的不算：FE0E / FE0F 跟在表情、# * 数字后面；ZWJ（\u200d）夹在两个表情中间（「女人 + ZWJ + 电脑」这种表情）。英格兰旗这类用标签字符拼的旗子照样算（标签字符能藏整句话）
const HIDDEN_RE = new RegExp([
  String.raw`(?![\ufe0e\ufe0f\u200d])[\p{Default_Ignorable_Code_Point}\p{Cf}]`,
  String.raw`(?<![\p{Extended_Pictographic}#*0-9])[\ufe0e\ufe0f]`,
  String.raw`(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}][\ufe0e\ufe0f]?)\u200d|\u200d(?!\p{Extended_Pictographic})`,
].join('|'), 'gu')
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g
function multiline(s, n, { scrub = true } = {}) {
  const raw = String(s ?? '').replace(/\r\n?/g, '\n')
  const invisible = new RegExp(HIDDEN_RE.source, 'u').test(raw) || new RegExp(CTRL_RE.source).test(raw)
  let t = raw.replace(HIDDEN_RE, '').replace(CTRL_RE, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (scrub) t = redact(t)
  const chars = [...t]
  const cut = chars.length > n
  if (cut) t = chars.slice(0, n - 1).join('') + '…'
  return { text: t, invisible, cut }
}
const mtext = (s, n, o) => multiline(s, n, o).text
/** window.json 里有口令和桌宠令牌：先写临时文件再改名（cli 不会读到写了一半的）；POSIX 上只给自己读写（Windows 上数据目录本来只有主人能读） */
function writeInfo(obj) {
  fs.mkdirSync(path.dirname(INFO_FILE), { recursive: true })
  const tmp = `${INFO_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameRetry(tmp, INFO_FILE)
}

// ─────────────── 她的会话记录：只认这一种路径 ───────────────
/** Claude Code 给会话记录目录起名的规矩：工作目录里不是字母数字的字符都换成 '-'（C:\Users\Alice\.bili-whale\whale-work → C--Users-Alice--bili-whale-whale-work）。
 *  超过 200 个字符它会截短再加一段哈希 —— 那种不认（她的家远没那么长）：宁可看不到，也不去列 projects/ 猜 */
export function slugOf(dir) { const s = String(dir ?? '').replace(/[^A-Za-z0-9]/g, '-'); return s && s.length <= 200 ? s : null }
export function transcriptDir(configDir = AGENT_CONFIG_DIR, home = workDir()) { const s = slugOf(home); return s ? path.join(configDir, 'projects', s) : null }

/**
 * root 里的普通文件：root 是真目录（不是链接 / 联接）；文件本身不是链接；flat 时必须直接在 root 下；single 时不能有别的硬链接
 * （一个指向凭据的硬链接看上去就是普通文件）；真实路径还在 root 里。返回 bigint 的 lstat（拿 ino 对打开后的文件），不合格 = null
 */
export function plainFileIn(root, file, { single = false, flat = false } = {}) {
  try {
    if (!fs.lstatSync(root).isDirectory()) return null                    // lstat 看链接 / 联接就是链接，不是目录
    const st = fs.lstatSync(file, { bigint: true })
    if (!st.isFile() || st.isSymbolicLink() || (single && st.nlink !== 1n)) return null
    const realRoot = fs.realpathSync.native(root), real = fs.realpathSync.native(file)
    const rel = path.relative(realRoot, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || (flat && !samePath(path.dirname(real), realRoot))) return null
    return st
  } catch { return null }
}
/** 读哪个会话：running.json 的 → session.json 的 → 那一个目录里最新的 <uuid>.jsonl（只列这一个目录） */
export function pickSession(dir, candidates = []) {
  for (const id of candidates) if (typeof id === 'string' && UUID_RE.test(id)) return id
  if (!dir) return null
  let best = null
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const id = e.name.endsWith('.jsonl') ? e.name.slice(0, -6) : ''
      if (!e.isFile() || !UUID_RE.test(id)) continue
      const st = plainFileIn(dir, path.join(dir, e.name), { single: true, flat: true })
      if (st && (!best || Number(st.mtimeMs) > best.t)) best = { id, t: Number(st.mtimeMs) }
    }
  } catch {}
  return best?.id ?? null
}
/** 打开前查一遍、打开后用 ino 再对一遍（查完到打开之间被换成别的文件就不读） */
function openPlain(dir, file) {
  const st = plainFileIn(dir, file, { single: true, flat: true })
  if (!st) return null
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const f = fs.fstatSync(fd, { bigint: true })
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) { fs.closeSync(fd); return null }
    return { fd, size: Number(f.size), ino: f.ino }
  } catch { if (fd !== undefined) try { fs.closeSync(fd) } catch {} return null }
}
function readAt(fd, pos, len) {
  const buf = Buffer.alloc(Math.max(0, len))
  let n = 0
  while (n < buf.length) { const r = fs.readSync(fd, buf, n, buf.length - n, pos + n); if (!r) break; n += r }
  return n < buf.length ? buf.subarray(0, n) : buf
}
function lineStartBefore(fd, pos) {
  for (let end = pos; end > 0 && pos - end <= MAX_LINE;) {
    const start = Math.max(0, end - 65536)
    const i = readAt(fd, start, end - start).lastIndexOf(0x0a)
    if (i >= 0) return start + i + 1
    end = start
    if (!end) return 0
  }
  return pos > MAX_LINE ? -1 : 0
}
function parseLineAt(fd, at, size) {
  let buf = Buffer.alloc(0)
  for (let p = at; p < size && buf.length <= MAX_LINE;) {
    const b = readAt(fd, p, Math.min(65536, size - p))
    if (!b.length) break
    const i = b.indexOf(0x0a)
    buf = Buffer.concat([buf, i >= 0 ? b.subarray(0, i) : b])
    if (i >= 0) break
    p += b.length
  }
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}
const ENQ = Buffer.from('"operation":"enqueue"')
/**
 * 往回找最后一个 enqueue 行（= 最近一回合的开头）：一块 1 MB 往前翻，最多翻 64 MB（一个会话 7 天也就二三十 MB）。
 * 记录里字符串里的引号都是转义过的，原样的 "operation":"enqueue" 只会是真的字段；还是整行解析一遍确认
 */
export function lastEnqueue(fd, size, { chunk = 1 << 20, maxBack = 64 << 20 } = {}) {
  const floor = Math.max(0, size - maxBack)
  let end = size, carry = Buffer.alloc(0)
  while (end > floor) {
    const start = Math.max(floor, end - chunk)
    const buf = readAt(fd, start, end - start)
    const hay = carry.length ? Buffer.concat([buf, carry]) : buf          // 模式可能跨两块
    for (let i = hay.lastIndexOf(ENQ); i >= 0; i = i > 0 ? hay.lastIndexOf(ENQ, i - 1) : -1) {
      const at = lineStartBefore(fd, start + i)
      const o = at >= 0 ? parseLineAt(fd, at, size) : null
      if (o?.type === 'queue-operation' && o.operation === 'enqueue') return { offset: at, ts: typeof o.timestamp === 'string' ? o.timestamp : null }
    }
    carry = hay.subarray(0, Math.min(hay.length, ENQ.length - 1))       // 下一块（更靠前）要接上的：这一段开头的几个字节
    end = start
  }
  return null
}

/**
 * 跟着读一个会话记录文件：每次 打开 → 读新增的 → 关上（不一直占着：Claude Code 写、轮换都不受影响）。
 * 只交出完整的行（最后半行留到下次）；一行超过 4 MB 整行跳过；文件换了 / 变短了 / 被替换了 → 从最后一个 enqueue 重新开始（start 给出那一行的时间）。
 * poll(dir, uuid) → { lines, reset, start, more }
 */
export function createTailer({ maxLine = MAX_LINE, maxRead = 16 << 20 } = {}) {
  let cur = null
  return {
    get file() { return cur?.file ?? null },
    get offset() { return cur?.offset ?? null },
    reset() { cur = null },
    poll(dir, id) {
      const out = { lines: [], reset: false, start: null, more: false }
      const file = dir && typeof id === 'string' && UUID_RE.test(id) ? path.join(dir, id + '.jsonl') : null
      const h = file ? openPlain(dir, file) : null
      if (!h) return out
      try {
        if (!cur || cur.file !== file || cur.ino !== h.ino || h.size < cur.offset) {
          const e = lastEnqueue(h.fd, h.size)
          cur = { file, ino: h.ino, offset: e?.offset ?? 0, parts: [], len: 0, skip: false }
          out.reset = true
          out.start = e
        }
        const want = Math.min(h.size - cur.offset, maxRead)
        if (want <= 0) return out
        const buf = readAt(h.fd, cur.offset, want)
        cur.offset += buf.length
        out.more = h.size > cur.offset
        let s = 0
        for (let i = buf.indexOf(0x0a); i >= 0; i = buf.indexOf(0x0a, s)) {
          const piece = buf.subarray(s, i)
          s = i + 1
          const tooLong = cur.skip || cur.len + piece.length > maxLine
          const line = tooLong ? '' : (cur.len ? Buffer.concat([...cur.parts, piece]) : piece).toString('utf8')
          cur.parts = []; cur.len = 0; cur.skip = false
          if (line.trim()) out.lines.push(line)
        }
        const rest = buf.subarray(s)
        if (rest.length && !cur.skip) {
          if (cur.len + rest.length > maxLine) { cur.parts = []; cur.len = 0; cur.skip = true }   // 超长：这一行剩下的读到换行为止都扔掉
          else { cur.parts.push(rest); cur.len += rest.length }
        }
        return out
      } finally { try { fs.closeSync(h.fd) } catch {} }
    },
  }
}

// ─────────────── 立绘：只认 listCast() 里真有的名字 ───────────────
/** /sprite/<换装>/<表情>.png 或 /sprite/<换装>/说话/<表情>.png（段已经 decodeURIComponent 过）→ { root, file } | null */
export function spriteTarget(cast, segs) {
  if (!cast || !Array.isArray(cast.outfits) || !Array.isArray(segs)) return null
  const talk = segs.length === 3 && segs[1] === TALK_DIR
  if (!(segs.length === 2 || talk)) return null
  const outfit = segs[0], last = segs[segs.length - 1]
  if (typeof last !== 'string' || !last.endsWith('.png')) return null
  const expr = last.slice(0, -4)
  const o = cast.outfits.find((x) => x?.name === outfit)
  if (!o || !(talk ? o.talking : o.exprs)?.includes(expr)) return null
  const root = path.join(CAST_DIR, cast.id, 'sprites')
  return { root, file: path.join(root, outfit, ...(talk ? [TALK_DIR] : []), expr + '.png') }
}
/** 她是哪个角色：配置里的 studio.host → 第一个找到的角色 → 没有 */
function castOf(cfg) {
  const all = listCast()
  const want = typeof cfg?.studio?.host === 'string' ? cfg.studio.host : ''
  const c = all.find((x) => x.id === want) ?? all[0]
  if (!c) return null
  const outfits = (c.outfits ?? []).map((o) => ({ name: o.name, exprs: [...(o.exprs ?? [])], talking: [...(o.talking ?? [])] }))
  return { id: c.id, outfits, defaultOutfit: outfits.some((o) => o.name === c.defaultOutfit) ? c.defaultOutfit : outfits[0]?.name ?? null }
}

// ─────────────── 一次性口令 ───────────────
/** 每个口令最多活 60 秒；30 秒换一个新的（cli 读到的那个总还有半分钟以上）；当前和上一个都认；用过一次马上作废、换新的 */
export function createCodes({ now = Date.now, ttl = CODE_TTL, onChange = () => {} } = {}) {
  let list = []
  const make = () => { const t = now(); list = [{ code: crypto.randomBytes(18).toString('base64url'), exp: t + ttl }, ...list.filter((c) => c.exp > t)].slice(0, 2); onChange(list[0]) }
  make()
  return {
    current: () => list[0],
    rotate: make,
    redeem(k) {
      if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) return false
      const t = now()
      let hit = null
      for (const c of list) if (safeEq(c.code, k) && c.exp > t) hit = c   // 每个都比一遍：别让「第几个对上」从耗时里看出来
      if (!hit) return false
      list = list.filter((c) => c !== hit)
      make()
      return true
    },
  }
}

/** 排着的回合 id → { dm（主人找她的：B站 私信，和模块登记的主人找她的回合）, win（主人在小窗里说的）, total } */
export function queuedCounts(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string')
  return { dm: list.filter((x) => isOwnerKind(kindOf(x).kind) && !isWinId(x)).length, win: list.filter(isWinId).length, total: list.length }
}

/**
 * 今天「发出」了几条 = 公开发到 B站 上的（评论 / 动态 / 弹幕 / 投稿）。分享私信是发给主人的：账本里记成 type dm，「给你私信」里已经数过一次了；
 * 模块登记的不算公开发言的种类（PRIVATE_SEND_TYPES：面板那边已经不把它放进 sends，这里再挡一道）—— 也不算
 */
export function sentToday(items, day) {
  return (Array.isArray(items) ? items : []).filter((x) => x?.status === 'success' && x.type !== 'dm' && !PRIVATE_SEND_TYPES.has(x.type) && localDay(x.at) === day).length
}

/** 审核面板的数据：她写的字净化、截短（简介 / 设定不抹凭据样子：见 multiline） */
export function reviewData() {
  const s = (v, n) => mtext(v, n, { scrub: false })
  const videos = videoCards().slice(0, 20).map((c) => {
    const desc = c.meta ? multiline(c.meta.desc, DESC_SHOW, { scrub: false }) : null
    const title = multiline(c.title, 80, { scrub: false })
    return {
      id: c.id, sub: c.sub ?? null, title: title.text || c.id, titleInvisible: title.invisible, seconds: c.seconds, at: c.at, reason: s(c.reason, 600),
      outfits: c.outfits.slice(0, 6).map(([k, v]) => [s(k, 20), s(v, 20)]), checked: c.checked,
      flags: c.flags.slice(0, 8).map((x) => s(x, 200)), notes: c.notes.slice(0, 6).map((x) => s(x, 200)),
      references: c.references ? c.references.slice(0, 8).map((x) => s(x, 40)) : null, history: c.history.map((x) => s(x, 200)),
      meta: c.meta ? { tags: c.meta.tags.slice(0, TAG_SHOW).map((x) => s(x, TAG_LEN)), tagsInvisible: c.meta.tags.slice(0, TAG_SHOW).some((x) => multiline(x, TAG_LEN, { scrub: false }).invisible),
        desc: desc.text, descLen: c.meta.descLen, descDropped: c.meta.descDropped, descCut: desc.cut, invisible: desc.invisible,
        tid: c.meta.tid == null ? null : s(String(c.meta.tid), 12), part: c.meta.part ? s(c.meta.part, 30) : null, partKnown: c.meta.partKnown } : null,
      hasFile: c.hasFile,
    }
  })
  const ch = channelCard()
  const channel = ch ? { ...ch, ...(() => { const m = multiline(ch.text, 8000, { scrub: false }); return { text: m.text, invisible: m.invisible, cut: m.cut, len: [...String(ch.text)].length } })() } : null
  if (channel && typeof channel.sha === 'string') channel.sha = /^[0-9a-f]{12,64}$/.test(channel.sha) ? channel.sha : null
  return { videos, channel }
}

/**
 * 小窗里点的事 → cli 参数（数组：不经过 shell）。查不过 → { error }。videoIds：现在真等审的视频 id（批准 / 退回 / 看片只认它们）。
 * 退回的理由不能用「-」开头：cli 的 videos reject 会把单独一个 --force 当开关
 */
export function actArgs(act, body = {}, { videoIds = [] } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const vid = () => {
    const id = typeof b.id === 'string' ? b.id : ''
    if (!VIDEO_ID_RE.test(id)) return { error: '视频 id 不对' }
    if (!videoIds.includes(id)) return { error: '这条视频现在不在等你审的单子里（刷新一下审核面板）' }
    return { id }
  }
  // utf16：按 UTF-16 算长度（core 存退回理由是 .slice(0, 200)：按字符数放行的话，带表情的长理由会被它截掉一截）
  const note = (max, what, { utf16 = false } = {}) => {
    const t = (typeof b.text === 'string' ? b.text : '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim()
    if (!t) return { error: `写一下${what}` }
    if ((utf16 ? t.length : [...t].length) > max) return { error: `${what}太长了（最多 ${max} 字${utf16 ? '，表情算两个' : ''}）` }
    if (t.startsWith('-')) return { error: `${what}别用「-」开头` }
    return { t }
  }
  switch (act) {
    case 'say': { const n = normalizeSay(typeof b.text === 'string' ? b.text : ''); return n.error ? { error: n.error } : { args: ['say', '--stdin'], input: n.text } }
    case 'wake': return { args: ['wake', '--queue-only'] }
    case 'start': return { args: ['start'] }
    case 'play': { const v = vid(); return v.error ? v : { args: ['videos', 'play', v.id] } }
    case 'approve': { const v = vid(); return v.error ? v : { args: ['videos', 'approve', v.id] } }
    case 'reject': { const v = vid(); if (v.error) return v; const r = note(REASON_MAX, '退回的理由', { utf16: true }); return r.error ? r : { args: ['videos', 'reject', v.id, r.t] } }
    case 'channel-approve': { const sha = (typeof b.sha === 'string' ? b.sha : '').toLowerCase(); return /^[0-9a-f]{12,64}$/.test(sha) ? { args: ['channel', 'approve', sha] } : { error: '频道设定的指纹不对（刷新一下审核面板）' } }
    case 'channel-reject': { const r = note(CHANNEL_NOTE_MAX, '意见'); return r.error ? r : { args: ['channel', 'reject', r.t] } }
    default: return { error: '不认识的操作' }
  }
}

/** cli 的输出：去掉终端颜色、控制字符，凭据样子抹掉，太长留头尾 */
export function tidyOut(s) {
  const t = mtext(String(s ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''), 64 * 1024)
  const c = [...t]
  if (c.length <= OUT_MAX) return t
  return c.slice(0, OUT_MAX / 2).join('') + '\n…（中间省略）…\n' + c.slice(-OUT_MAX / 2).join('')
}

/**
 * 跑一次 cli：node <cli.mjs> …args（不经过 shell），input 从标准输入喂进去；超时就整棵进程树结束掉。→ { ok, code, out }
 * 测试用：BILI_WHALE_WINDOW_NO_EDGE=1 时才认 BILI_WHALE_WINDOW_ACT_STUB（拿它顶替 cli.mjs：看参数、标准输入对不对，不碰真的队列 / B站）
 */
export function runCli(args, { input = null, ms = 60_000, env = process.env } = {}) {
  const stub = env.BILI_WHALE_WINDOW_NO_EDGE === '1' && env.BILI_WHALE_WINDOW_ACT_STUB ? env.BILI_WHALE_WINDOW_ACT_STUB : null
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [stub ?? CLI, ...args], { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, BILI_WHALE_FROM_WINDOW: '1' } })
    } catch (e) { resolve({ ok: false, code: null, out: '没跑起来：' + String(e?.message ?? e).slice(0, 160) }); return }
    let out = '', done = false
    const take = (d) => { if (out.length < 256 * 1024) out += d }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', take); child.stderr.on('data', take)
    const finish = (code, why = '', timedOut = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out: tidyOut(out + (why ? `\n${why}` : '')), timedOut })
    }
    const timer = setTimeout(() => { try { killTree(child.pid) } catch {}; finish(null, `超过 ${Math.round(ms / 1000)} 秒还没做完，停掉了`, true) }, ms)
    timer.unref?.()
    child.on('error', (e) => finish(null, '没跑起来：' + String(e?.message ?? e).slice(0, 160)))
    child.on('close', (code) => finish(code))
    child.stdin.on('error', () => {})
    child.stdin.end(input == null ? '' : String(input), 'utf8')
  })
}

/** 给桌宠的事件：桌宠没有「遮住私话」—— 标了 private 的（她回主人的话、主人回合里的文件名）不带原话。它现在只念 caption，以后改了也别顺手显示出来 */
export function petEvent(ev) {
  if (ev?.private !== true || !('text' in ev)) return ev
  const { text: _t, ...rest } = ev
  return rest
}

/**
 * 做完的事给页面看的输出。投稿等到超时被停掉：B站 可能已经收到了 —— 别让主人以为「没投上」再投一次。
 * 只看 timedOut：没跑起来（code 也是 null）那次根本没投
 */
export function jobOut(act, args, r) {
  if (act !== 'approve' || !r?.timedOut) return r?.out ?? ''
  const id = VIDEO_ID_RE.test(String(args?.[2] ?? '')) ? args[2] : '<视频 id>'
  return `${r.out}\n结果说不准：可能已经投上了。先去 B站 创作中心看看，再在终端里 node host/cli.mjs videos resolve ${id} none（没投上）或 <BV号>（投上了）`
}

// ─────────────── 她现在怎么样（轮询宿主的文件 + 跟着读会话记录） ───────────────
function createLive({ emit, log, onChat = () => {} }) {
  const tr = createTranslator({ titleOf: (bv) => { const r = readWatch(bv); return typeof r?.title === 'string' ? r.title : null } })
  const tailer = createTailer()
  const P = {
    booted: false, bootAt: null, cfg: {}, night: null, inWindow: null, ctxDays: 8, maxMs: 30 * 60_000, cast: null, projDir: null, today: { ...EMPTY_TODAY },
    host: { state: 'offline', label: '宿主还没启动过', heartbeatAgeSec: null }, chatting: false, run: null, active: null, lastRunId: null, runGoneAt: null,
    queued: { dm: 0, total: 0 }, planRaw: null, plan: null, logs: [], costs: new Map(), logged: new Set(), logSig: '', handled: new Set(),
    lastTurn: null, started: new Set(), shown: new Set(), closed: new Set(), segTurn: null, chat: null, newest: { t: 0, id: null }, script: null,
    queueIds: [], winChat: [], winSig: '', channelWaiting: false,   // 小窗里的聊天（winChat；chat 是 cli open 当面聊的假回合）
  }
  const cache = new Map()
  /** 小 JSON 文件：大小 / 修改时间没变就用上次读的（每 0.75 秒一轮，别反复解析） */
  function cachedJson(f) {
    let sig = '-'
    try { const s = fs.statSync(f); sig = `${s.size}:${s.mtimeMs}` } catch {}
    const c = cache.get(f)
    if (c && c.sig === sig) return c.v
    const v = sig === '-' ? null : readJson(f)
    cache.set(f, { sig, v })
    return v
  }
  const remember = (set, v, cap = 500) => { set.add(v); if (set.size > cap) set.delete(set.values().next().value) }
  const out = (evs) => {
    for (const e of evs ?? []) {
      if (e?.kind === 'turn_end' && typeof e.turn === 'string') remember(P.closed, e.turn)
      if (e?.kind === 'turn_start' && typeof e.turn === 'string') {
        remember(P.shown, e.turn)
        if (isChatId(e.turn)) P.chat = { id: e.turn, at: e.t ?? new Date().toISOString() }
      }
      emit(e)
    }
  }

  function slow(now = Date.now()) {
    try {
      const cfg = readConfig()
      P.cfg = cfg
      P.ctxDays = Math.max(8, (Number(cfg?.claude?.rotateDays) || 7) + 1)          // costUsd 是会话累计：要看到同一会话前面的回合
      P.maxMs = (Number(cfg?.claude?.timeoutMin ?? 25) + 5) * 60_000
    } catch {}
    // 醒的窗口和调度引擎读的同一份（配置的 night + 老的 whale-night.config.json）：白天 / 夜里的分界和它排计划时一致
    try { P.night = readNightConfig() } catch { P.night = null }
    try { P.cast = castOf(P.cfg) } catch { P.cast = null }
    P.projDir = transcriptDir()
    refreshToday(now)
  }
  /** 「今天」那一条：和面板同一套真相规矩（只认代码记的账本）；light = 不起 PowerShell 查进程 */
  function refreshToday(now = Date.now()) {
    try {
      const s = collect({ now, light: true }), day = localDay(now)
      const views = Array.isArray(s?.views?.items) ? s.views.items : []
      const sends = Array.isArray(s?.sends?.items) ? s.sends.items : []
      const vids = Array.isArray(s?.videos?.items) ? s.videos.items : []
      const drafts = Array.isArray(s?.drafts?.items) ? s.drafts.items.length : 0, waiting = vids.filter((v) => v?.status === 'triggered').length
      P.today = {
        turns: num(s?.usage?.turns) ?? 0,
        costUsd: num(s?.usage?.costUsd),                                         // 已经是按回合相减过的（turncost.mjs）
        watched: views.length,
        watchedList: views.filter((v) => BV_ONLY.test(String(v?.bv ?? ''))).slice(0, 6).map((v) => { const t = safe(v.title, 40); return { bv: v.bv, ...(t ? { title: t } : {}) } }),
        sent: sentToday(sends, day),                                               // 「发出」= 公开发到 B站 上的：分享私信、模块登记的私信都不算（见 sentToday）
        dmToOwner: num(s?.sends?.dmToOwner) ?? 0,
        // 「等你审」= 真等主人点头的：等审的视频 + 回复草稿。投稿结果不确定的另算 uncertain —— 那是要去 B站 核对（videos resolve / approve --retry），
        // 不是审；而且 cli videos 只列等审的，混在一起时照着提示去看会是「没有等你审的视频」
        pending: waiting + drafts, pendingVideos: waiting, pendingDrafts: drafts,
        uncertain: vids.filter((v) => v?.status === 'uncertain').length,
        channelWaiting: (() => { try { return channelCard()?.state === 'waiting' } catch { return false } })(),   // 她交了频道设定、等你确认（小窗的「审核」按钮跟着亮）
      }
    } catch (e) { log('今天的数据读不出来：' + String(e?.message ?? e).slice(0, 160)) }
  }
  /**
   * 小窗里的聊天：cli say 记的原话 + 队列 / 正在跑的 / 结果日志 → chatView（host/winchat.mjs）。变了就推给小窗页面（onChat，桌宠收不到）。
   * 她的回复是她写的字：去控制字符、抹凭据样子，最多 2000 字；主人的原话也过一遍（只去控制字符和凭据样子）
   */
  let chatFileSig = ''
  const lostSince = new Map()   // 回合 id → 第一次「哪儿都找不到」的时刻
  function refreshChat(now = Date.now()) {
    let sig = '-'
    try { const s = fs.statSync(CHAT_FILE); sig = `${s.size}:${s.mtimeMs}` } catch {}
    if (sig !== chatFileSig) { chatFileSig = sig; P.chatEntries = sig === '-' ? [] : readChat(CHAT_FILE) }
    const before = new Map((P.winChat ?? []).map((x) => [x.id, x]))
    const view = chatView({ entries: P.chatEntries ?? [], queue: P.queueIds, active: P.active?.id ?? null, logs: P.logs, now }).map((c) => {
      // 刚还在排 / 在跑、这一下哪儿都找不到：多半是宿主刚把它从队列里拿掉、结果日志还没读到（每 0.75 秒读一轮，先后不齐）——
      // 先照旧显示 2 秒，还找不到才算「没收到」。一开始就找不到的（小窗刚开）直接显示
      const old = before.get(c.id)
      if (c.state === 'lost' && old && old.state !== 'lost') {
        const t0 = lostSince.get(c.id) ?? now
        lostSince.set(c.id, t0)
        if (now - t0 < 2000) return old
      }
      if (c.state !== 'lost') lostSince.delete(c.id)
      return {
        id: c.id, at: c.at, text: mtext(c.text, SAY_MAX), state: c.state, ...(c.ahead != null ? { ahead: c.ahead } : {}),
        ...(c.reply ? { reply: mtext(c.reply, REPLY_MAX) } : {}), ...(c.error ? { error: mtext(c.error, 160) } : {}),
        ...(c.replyAt ? { replyAt: c.replyAt } : {}), ...(c.ms != null ? { ms: c.ms } : {}),
      }
    })
    if (lostSince.size > 100) lostSince.clear()
    const s = JSON.stringify(view)
    if (s === P.winSig) return
    P.winSig = s
    P.winChat = view
    onChat(view)
  }
  let todayTimer = null
  const soonToday = () => { clearTimeout(todayTimer); todayTimer = setTimeout(() => refreshToday(), 1500); todayTimer.unref?.() }

  /** 结果日志：今天 / 昨天两个文件变了才重读（往前读 rotateDays+1 天当算花费的上下文）；返回新出现的、6 小时内的回合 */
  function readLogs(now) {
    const sig = [0, 1].map((b) => { try { const s = fs.statSync(path.join(LOG_DIR, `${dayBack(now, b)}.jsonl`)); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }).join('|') + '|' + localDay(now) + '|' + P.ctxDays
    if (sig === P.logSig) return []
    P.logSig = sig
    const lines = readTurnLogs(LOG_DIR, { days: P.ctxDays, now })
    P.logs = lines
    P.costs = turnCosts(lines)
    P.logged = new Set(lines.map((l) => l?.id).filter((x) => typeof x === 'string'))
    P.lastTurn = lastTurnOf(now)
    const fresh = []
    for (const l of lines) if (typeof l?.id === 'string' && !P.handled.has(l.id)) { P.handled.add(l.id); fresh.push(l) }
    return fresh.filter((l) => now - Date.parse(l.at) < 6 * 3600_000).sort(byAt)
  }
  function lastTurnOf(now) {
    let best = null
    for (const l of P.logs) { const t = Date.parse(l?.at); if (typeof l?.id === 'string' && Number.isFinite(t) && (!best || t >= best.t)) best = { l, t } }
    if (!best || now - best.t > 36 * 3600_000) return null                     // 太久以前的「上一回合 · 22:10」会被当成今天的
    const id = safe(best.l.id)
    // at = 开始的时刻（结果日志的 at 是结束时写的，减去用时）：和动态里每组的标题、正在跑的 turn.at 一样都说「几点开始的」；
    // endedAt = 结束的时刻：stateOf 拿它算「刚做完 / 一小时内没做完」（不拿服务端读到它的时刻 —— 开机重放时那全是开机那一刻）
    return id ? { id, kindLabel: kindOf(best.l.id).kindLabel, at: new Date(startOf(best.l)).toISOString(), endedAt: new Date(best.t).toISOString(),
      durationMs: num(best.l.ms), costUsd: P.costs.get(best.l.id) ?? null, ok: typeof best.l.ok === 'boolean' ? best.l.ok : null } : null
  }
  /** 结果日志那一行的回合是几点开始的：结束时刻 − 用时（用时不知道 / 不像话就只能说结束的时刻） */
  function startOf(l) {
    const end = Date.parse(l?.at), ms = num(l?.ms)
    return ms !== null && ms >= 0 && ms < 48 * 3600_000 ? end - ms : end
  }
  /**
   * 只在结果日志里见过的回合（小窗开之前就结束了 / 短得没赶上 running.json）：收尾前先补一个回合头，时间是开始的时刻。
   * 页面按每组第一条的时间起标题：不补的话这组只有「做完了」那一行，标题就成了结束的时刻 —— 同一个 15:02–15:06 的私信回合，
   * 看着它跑是「15:02」，小窗重开以后变「15:06」。直接发（不经翻译器）：翻译器一认它就会把后面读到的行记到这个早结束的回合上
   */
  function openTurn(l) {
    if (typeof l?.id !== 'string' || P.shown.has(l.id) || P.closed.has(l.id)) return
    const t = startOf(l)
    if (!Number.isFinite(t)) return
    const ev = sanitizeEvent({ kind: 'turn_start', turn: l.id, t: new Date(t).toISOString(), cap: kindOf(l.id).kindLabel })
    if (ev) out([ev])
  }
  const endArgs = (l) => ({ id: l.id, ok: typeof l.ok === 'boolean' ? l.ok : undefined, costUsd: P.costs.get(l.id) ?? undefined, durationMs: num(l.ms) ?? undefined, at: l.at })

  function readHost(now) {
    const d = cachedJson(DAEMON_FILE)
    const pj = readJson(path.join(HOST_DIR, 'paused.json'))
    P.chatting = Boolean(pj?.pid && pidAlive(pj.pid))
    const hb = Date.parse(d?.heartbeat ?? '')
    const age = Number.isFinite(hb) ? Math.max(0, Math.round((now - hb) / 1000)) : null
    P.host = P.chatting ? { state: 'paused', label: '你在和她当面聊', heartbeatAgeSec: age }
      : daemonAlive(d) ? { state: 'online', label: '在线', heartbeatAgeSec: age }
        : { state: 'offline', label: d ? '宿主没在跑' : '宿主还没启动过', heartbeatAgeSec: age }
    // 醒没醒：看 running.json（宿主心跳 30 秒才写一次，里面的 running 会落后）；进程还在、还没有结果记录、没超时才算
    const run = readJson(RUNNING_FILE)
    P.run = run && typeof run === 'object' && !Array.isArray(run) ? run : null
    const id = typeof P.run?.id === 'string' && P.run.id ? P.run.id : null
    const at = Date.parse(P.run?.at ?? '')
    P.active = id && !P.logged.has(id) && pidAlive(P.run.pid) && !(Number.isFinite(at) && now - at > P.maxMs)
      ? { id, at: new Date(Number.isFinite(at) ? at : now).toISOString() } : null
    if (P.active) { P.lastRunId = P.active.id; P.runGoneAt = null } else P.runGoneAt ??= now
    // 现在在不在醒的窗口里（和调度一样用 night-plan 的 inWindow）：不在 = 白天，stateOf 给「白天不醒」，不画睡觉的 zz
    try { P.inWindow = P.night ? nightOpen(P.night, now) : null } catch { P.inWindow = null }   // 时间写坏了（引擎会抛错）→ 不知道，照旧
    // 排着的：只看 id（text 是整段提示词，里面有主人的私信）；队列里也留着正在跑的那个
    const q = cachedJson(path.join(HOST_DIR, 'queue.json'))
    P.queueIds = (Array.isArray(q) ? q : []).map((x) => x?.id).filter((x) => typeof x === 'string' && !P.logged.has(x))   // 按队列的顺序（聊天里「前面还有几个」）
    const waiting = P.queueIds.filter((x) => x !== P.active?.id)
    P.queued = queuedCounts(waiting)
    P.planRaw = cachedJson(NIGHT_FILE)
    P.plan = planOf(P.planRaw, now)
  }
  /**
   * 作息 → { text, when?, atMs, action, reason, startsAt?, endsAt?, woke?（done 才有） }。倒计时只用 atMs（2026-10-25 是夏令时结束那晚，atText 的 02:10 有两个）。
   *   when：按本地日历说是哪天（liveview.whenText：「02:10」「今晚 20:30」「明早 07:30」「明天 14:00」「后天 20:00」…）——
   *     光写 HH:MM 的话凌晨 02:20 看到的「03:30 醒 · 还有 26:09:59」读着像一小时后；页面跑在浏览器里引不了 liveview，所以这里算好给它
   *   text：说实际的事：要醒（看视频 / 只写日记）、醒过了（看了 / 只写了日记）、今晚不醒了。调度引擎的理由（「今天可用窗口已结束或已经处理」）
   *     只放 reason，不当句子念 —— 刚醒过就念「今晚不醒了：…」像是说她没醒
   *   startsAt / endsAt：这次计划所在那段窗口（stateOf 用 startsAt 分「今晚还要醒」和「已经排到明晚」）
   */
  function planOf(st, now) {
    if (!st || typeof st !== 'object') return null
    const atMs = num(st.atMs), reason = safe(st.reason, 60)
    if (planPending(st, now)) {
      const when = safe(whenText(atMs, now), 20) ?? hhmm(atMs)
      return { text: safe(`${when} 醒（${st.action === 'skip' ? '只写日记' : '醒来看视频'}）`), when, atMs, action: st.action, reason, startsAt: num(st.startsAt), endsAt: num(st.endsAt) }
    }
    if (st.date !== localDay(now)) return null
    // 醒过了、调度还没排下一次：fired + wake = 看了视频（woke）；fired + skip = 醒了只写日记
    // woke：这一晚醒过没有（stateOf 拿它决定说「今晚的事做完了」还是只说「在睡觉」—— 一次都没醒就不能说做完了）
    if (st.fired || st.woke) return { text: st.woke === true || st.action !== 'skip' ? '今晚已经醒过了' : '今晚醒过了，只写了日记', atMs, action: 'done', woke: true, reason }
    if (st.action === 'done') {
      // done 是调度引擎排不出下一次了：这一晚醒过（wokeAt 还在这一晚里）就说醒过了；一次都没醒（窗口设成 0 次、间隔排不下）才是「不醒了」
      const t = Date.parse(st.wokeAt ?? ''), woke = Number.isFinite(t) && t <= now && now - t < 18 * 3600_000
      return { text: woke ? '今晚已经醒过了' : '今晚不醒了', atMs: null, action: 'done', woke, reason }
    }
    return null
  }

  /** 回合开头（running.json 一出现就补，记录里的 enqueue 要晚几秒才落盘） */
  function startTurn(a) {
    remember(P.started, a.id)
    const sub = kindOf(a.id).kind === 'night' && P.planRaw?.action === 'skip' ? '今晚不看、只写日记' : undefined
    out(tr.turnStart({ id: a.id, at: a.at, sub }))
    if (!P.segTurn) P.segTurn = a.id
  }
  /**
   * 喂一行时给翻译器的回合 id 提示：正在跑的；running.json 刚没了就用最近见到的那个（落盘慢，回合的尾巴可能在它删掉之后才读到）——
   * 但只认一分钟：那个回合要是没收尾就崩了（没有结果日志），之后主人 cli open 当面聊的提示词会一直被当成它的，聊天记到早结束的回合底下。
   * 没有提示 = 宿主没在跑回合：这时冒出来的提示词行就是当面聊，翻译器另起一个 chat-<毫秒> 的假回合
   */
  function hintNow(now = Date.now()) {
    if (P.active) return P.active.id
    const h = P.lastRunId
    return h && !P.closed.has(h) && !(P.runGoneAt != null && now - P.runGoneAt > RUN_TAIL_MS) ? h : null
  }
  function feedLine(line) {
    const hint = hintNow()
    const evs = tr.feed(line, { turnId: hint })
    // 跟着翻译器记「眼下这一段是哪个回合」：步数 / token / 进行中的工具只在对得上正在跑的回合时报（新回合的 enqueue 落盘前，那些还是上一回合的）
    let enq = false
    if (line.includes('"queue-operation"') && line.includes('"enqueue"')) { try { const o = JSON.parse(line); enq = o?.type === 'queue-operation' && o.operation === 'enqueue' } catch {} }
    // 和翻译器一样：当面聊里主人又打了一句（排进队，没有回合 id）还是同一场；宿主的回合 id 来了就换成宿主的
    if (enq) P.segTurn = hint ?? (isChatId(P.segTurn) ? P.segTurn : null)
    else if (hint && (!P.segTurn || isChatId(P.segTurn))) P.segTurn = hint
    for (const e of evs) if (e?.kind === 'turn_start' && isChatId(e.turn)) P.segTurn = e.turn   // 翻译器刚起了一场当面聊
    out(evs)
  }
  function sessionNow(now) {
    const dir = P.projDir
    if (!dir) return null
    const cands = [P.run?.sessionId, cachedJson(SESSION_FILE)?.id]
    if (cands.some((x) => typeof x === 'string' && UUID_RE.test(x))) return pickSession(dir, cands)
    if (now - P.newest.t > 10_000) P.newest = { t: now, id: pickSession(dir, []) }   // 都没有才去列那一个目录，十秒一次
    return P.newest.id
  }
  function tail(now) {
    const sid = sessionNow(now)
    for (let i = 0; i < 8; i += 1) {
      const r = tailer.poll(P.projDir, sid)
      for (const line of r.lines) feedLine(line)
      if (!r.more) break
    }
  }

  function boot(now = Date.now()) {
    P.bootAt = now                                    // 给 stateOf 的 since：这之前就结束的回合不再闪「这回合做完了」
    slow(now)
    readLogs(now)                                     // 开机前就有的结果都记成「处理过」：不在动态里重复收尾
    readHost(now)
    const sid = sessionNow(now)
    const first = tailer.poll(P.projDir, sid)         // 第一次读：从最后一个 enqueue 开始，只重建最近这一回合
    const startT = Date.parse(first.start?.ts ?? '')
    let hint = null, endLine = null
    if (P.active && (!P.run?.sessionId || P.run.sessionId === sid)) hint = P.active.id
    else if (Number.isFinite(startT)) endLine = P.logs.filter((l) => l?.sessionId === sid && typeof l.id === 'string' && Date.parse(l.at) >= startT - 5000).sort(byAt)[0] ?? null
    hint ??= endLine?.id ?? null
    // 今天更早的回合：只给回合头（开始的时刻）+ 一行小结（多久、花了多少、成没成）
    const day = localDay(now)
    const earlier = P.logs.filter((l) => typeof l?.id === 'string' && l.id !== hint && localDay(l.at) === day && !(Date.parse(l.at) >= startT)).sort(byAt).slice(-30)
    for (const l of earlier) { openTurn(l); out(tr.turnEnd(endArgs(l))) }
    if (P.active) startTurn(P.active)
    P.lastRunId = hint
    for (const line of first.lines) feedLine(line)
    for (let i = 0; i < 16 && first.more; i += 1) { const r = tailer.poll(P.projDir, sid); r.lines.forEach(feedLine); if (!r.more) break }
    if (endLine) { openTurn(endLine); out(tr.turnEnd(endArgs(endLine))) }
    try { refreshChat(now) } catch (e) { log('小窗的聊天记录读不出来：' + String(e?.message ?? e).slice(0, 160)) }
    // 重放出来的事件按它们自己的时间算「多久以前」：不然开小窗那一刻，几分钟前的出错 / 说话都像刚发生的（别扭 4 秒、嘴动）
    tr.settle()
    P.booted = true
  }
  function tick(now = Date.now()) {
    // 先看结果日志、再读记录、最后才收尾：日志那行是 claude 退出以后才写的，那时记录早就全落盘了 ——
    // 这样同一轮里先把记录读完，回合的尾巴不会跑到「这回合做完了」后面
    const ends = readLogs(now)
    readHost(now)
    if (P.active && !P.started.has(P.active.id)) startTurn(P.active)
    tail(now)
    for (const l of ends) { openTurn(l); out(tr.turnEnd(endArgs(l))) }
    if (ends.length) soonToday()
    try { refreshChat(now) } catch (e) { log('小窗的聊天记录读不出来：' + String(e?.message ?? e).slice(0, 160)) }
  }

  /** 剧本里给她换了装（outfit.<角色 id>）就跟着换：她写的文件，只当提示 —— 只认普通文件、1 MB 以内、名字是真有的那套 */
  function scriptOutfit(id, castId) {
    const f = path.join(STUDIO_DIR, id, 'script.json')
    let st
    try { st = fs.lstatSync(f) } catch { return null }
    if (!st.isFile() || st.size > 1 << 20) return null
    const sig = `${f}|${st.size}|${st.mtimeMs}`
    if (P.script?.sig !== sig) { const j = readJson(f); P.script = { sig, v: typeof j?.outfit?.[castId] === 'string' ? j.outfit[castId] : null } }
    return P.script.v
  }
  function outfitNow() {
    const c = P.cast
    if (!c) return { outfit: null, exprs: [], talkingExprs: [] }
    let name = c.defaultOutfit
    const sid = P.active ? tr.studio() : null
    if (typeof sid === 'string' && /^[0-9A-Za-z_-]{3,80}$/.test(sid)) { const w = scriptOutfit(sid, c.id); if (w && c.outfits.some((o) => o.name === w)) name = w }
    const o = c.outfits.find((x) => x.name === name) ?? c.outfits[0]
    return o ? { outfit: o.name, exprs: [...o.exprs], talkingExprs: [...o.talking] } : { outfit: null, exprs: [], talkingExprs: [] }
  }
  /** pet：给桌宠的那份 —— 不带聊天（原话和她的回复）：桌宠没有「遮住私话」（feed 里标了 private 的原话，调用方先去掉：见 petEvent） */
  function snapshot(now = Date.now(), feed = [], { pet = false } = {}) {
    const fit = outfitNow()
    // 主人 cli open 当面聊（paused.json 的进程还在）、翻译器正记在一场聊天底下：快照里也给这个假回合（种类 chat「你在和她当面聊」，
    // 从第一句算的计时、步数、新 token、进行中的工具），页面把它当一个醒着的回合画；聊完（paused.json 没了）就没了。
    // 表情和 caption 还是按「当面聊」算（stateOf 的 chatting）：聊天里她回完一句就是在等主人，不能按回合里那样一直「在想…」
    const a = P.active, chat = !a && P.chatting && P.chat && P.segTurn === P.chat.id ? P.chat : null, cur = a ?? chat
    const mine = Boolean(cur && P.segTurn === cur.id)
    const inflight = mine ? tr.inflight() : []
    const u = mine ? tr.usage() : { steps: 0, tokens: 0 }
    const st = stateOf({ host: P.host, turn: a ? { id: a.id, at: a.at } : null, inflight: a ? inflight : [], recent: tr.recent(), plan: P.plan, queued: P.queued,
      chatting: P.chatting, lastTurn: P.lastTurn, inWindow: P.inWindow, since: P.bootAt ?? undefined, now, exprs: fit.exprs.length ? fit.exprs : undefined })
    return {
      v: VIEW_VERSION, at: new Date(now).toISOString(),
      host: { ...P.host },
      turn: cur ? { id: safe(cur.id) ?? '?', ...kindOf(cur.id), at: cur.at, steps: u.steps, tokens: u.tokens, inflight } : null,
      state: st.state, expr: st.expr ?? null, talking: st.talking === true, caption: safe(st.caption) ?? '',   // 只是动作说明：她说的原话不进快照（桌宠没有「遮住私话」）
      outfit: fit.outfit, exprs: fit.exprs, talkingExprs: fit.talkingExprs,
      plan: P.plan, queued: { ...P.queued }, lastTurn: P.lastTurn, today: P.today ?? { ...EMPTY_TODAY },
      ...(pet ? {} : { chat: P.winChat }),
      feed,
    }
  }
  return { boot, tick, slow, snapshot, P, cast: () => P.cast, refreshToday: () => refreshToday(), refreshChat: () => refreshChat() }
}

// ─────────────── 桌宠（host/pet.ps1）：小窗服务的子进程，不脱离（脱离的 PowerShell 画不出来；服务一停它跟着走） ───────────────
const PET_DELAYS = [2000, 5000, 15_000, 30_000, 60_000]
function createPet({ port, token, log, env = process.env }) {
  let child = null, blocked = false, tries = 0, nextAt = 0, startedAt = 0, tail = '', warned = false
  // 测试用：BILI_WHALE_WINDOW_NO_EDGE=1 时一律不起任何窗口；只有那时才认 BILI_WHALE_WINDOW_PET_STUB（拿 node 跑一个假桌宠，看环境变量 / 重启策略）
  const noGui = env.BILI_WHALE_WINDOW_NO_EDGE === '1'
  const stub = noGui && env.BILI_WHALE_WINDOW_PET_STUB ? env.BILI_WHALE_WINDOW_PET_STUB : null
  function start() {
    if ((noGui && !stub) || (!stub && process.platform !== 'win32')) {
      if (!warned) { warned = true; log(noGui ? '桌宠：BILI_WHALE_WINDOW_NO_EDGE=1，不起桌宠' : '桌宠只能在 Windows 上跑') }
      return
    }
    const [cmd, args] = stub ? [process.execPath, [stub]]
      : [PS, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', PET_PS1]]
    startedAt = Date.now()
    let me
    try {
      // 令牌只走环境变量（命令行别的进程看得到；PowerShell 还会把 '-' 开头的值当参数名）
      me = spawn(cmd, args, { cwd: ROOT, windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...env, WHALE_PET_URL: `http://127.0.0.1:${port}`, WHALE_PET_TOKEN: token, WHALE_PET_NODE: process.execPath, WHALE_PET_CLI: CLI } })
    } catch (e) { nextAt = Date.now() + 60_000; log('桌宠起不来：' + String(e?.message ?? e).slice(0, 160)); return }
    child = me
    me.stderr.setEncoding('utf8')
    me.stderr.on('data', (d) => { tail = (tail + d).slice(-2048) })        // 只留在内存里（「桌宠停了」时看原因），不写盘
    me.on('error', () => {})
    me.on('exit', (code) => {
      if (child !== me) return                                               // 是我们关掉的
      child = null
      const now = Date.now()
      if (now - startedAt > 5 * 60_000) tries = 0
      if (code === 2) { blocked = true; log('桌宠在这台电脑上跑不了：' + (tail.trim().split('\n').pop() ?? '').slice(0, 160) + '（window --pet off 再 on 才会再试）'); return }
      // 0 = 主人点了「关闭桌宠」（cli 已经写了 pet:false）：等 10 秒再看 window-ctl.json；别的退出码按退避重启
      nextAt = now + (code === 0 ? 10_000 : PET_DELAYS[Math.min(tries++, PET_DELAYS.length - 1)])
    })
  }
  return {
    sync(on) {
      if (!on) { blocked = false; tries = 0; nextAt = 0; if (child) { const c = child; child = null; try { c.kill() } catch {} } return }
      if (!child && !blocked && Date.now() >= nextAt) start()
    },
    kill() { const c = child; child = null; if (c) try { c.kill() } catch {} },
    /** 主人又说了一次「要桌宠」：关掉现在这个（可能藏着）、忘掉退避和「这台电脑跑不了」，马上重起 */
    restart() { const c = child; child = null; if (c) try { c.kill() } catch {}; blocked = false; tries = 0; nextAt = 0; start() },
    get running() { return Boolean(child) },
  }
}

// ─────────────── 服务 ───────────────
export async function startViewer({ port = DEFAULT_PORT, log = (m) => console.log(m), env = process.env } = {}) {
  const prev = readJson(INFO_FILE)
  if (prev?.pid && prev.pid !== process.pid && pidAlive(prev.pid) && Number.isInteger(prev.port) && await probe(prev.port) && isViewerPid(prev.pid)) {
    log(`已经有一个小窗服务在跑了（127.0.0.1:${prev.port}，pid ${prev.pid}）`)
    return null
  }
  const startedAt = new Date().toISOString()
  const petToken = crypto.randomBytes(32).toString('base64url')
  let ready = false
  const jobs = []                                       // 最近替主人做的事（最多 20 件，只在内存里）
  let jobSeq = 0
  // busy：正在替主人投稿（window.json 里记着：window --stop 看到就先不停 —— 停了投稿会断在半路）
  const busy = () => jobs.filter((j) => j.state === 'running' && j.act === 'approve').map((j) => j.label)
  const save = () => { if (!ready) return; const c = codes.current(); try { writeInfo({ pid: process.pid, port, startedAt, code: c.code, codeExpiresAt: new Date(c.exp).toISOString(), petToken, busy: busy() }) } catch (e) { log('window.json 没写成：' + String(e?.message ?? e).slice(0, 160)) } }
  const codes = createCodes({ onChange: save })
  const sessions = []                                   // 换到 cookie 的窗口（只在内存里：服务重启后要再从 cli 开一次）
  const sessInfo = new Map()                            // cookie → { sid, act（这个窗口的操作令牌）, hits（最近一分钟点了几次） }
  const confirms = new Map()                            // 投稿的确认口令 → { sid, id, exp }
  const clients = new Set()                             // SSE：{ res, kind: 'window' | 'pet' }
  const ring = []
  let seq = 0
  const said = new Map()
  const warn = (m) => { const t = Date.now(); if ((said.get(m) ?? 0) > t) return; if (said.size > 200) said.clear(); said.set(m, t + 60_000); log(m) }   // 同一句一分钟最多一次：window.out 不被刷屏

  const write = (c, event, data, id) => {
    try {
      if (c.res.writableLength > 1 << 20) { clients.delete(c); c.res.destroy(); return }   // 收得太慢的窗口：断开，让它重连补
      c.res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch { clients.delete(c) }
  }
  const evFor = (c, ev) => (c.kind === 'pet' ? petEvent(ev) : ev)
  const emit = (e) => {
    if (!e) return
    const ev = { seq: ++seq, ...e }
    ring.push(ev)
    if (ring.length > RING) ring.shift()
    for (const c of clients) write(c, 'ev', evFor(c, ev), ev.seq)
  }
  // 只给小窗页面的（聊天、替主人做的事）：桌宠的连接收不到。不带 id：不动断线续传的序号（重连时快照里有最新的）
  const toWindows = (event, data) => { for (const c of clients) if (c.kind === 'window') write(c, event, data, null) }
  const live = createLive({ emit, log: warn, onChat: (chat) => toWindows('chat', { chat }) })
  // viewer：这个服务自己什么时候起的、心跳几秒一次 —— 页面拿「多久没听到 hello / ev / hb、轮询也失败」认出服务停了 / 卡住了，
  // 不再拿最后那份快照接着显示「醒着」；startedAt 变了 = 服务重启过（cookie 失效，要从命令行再开）
  const snapshot = (now = Date.now(), pet = false) => ({ ...live.snapshot(now, pet ? ring.slice(-FEED).map(petEvent) : ring.slice(-FEED), { pet }), viewer: { startedAt, beatSec: BEAT_MS / 1000 } })

  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  /** cookie 对得上的那个窗口（{ sid, act, hits }）；没有 = null */
  function sessionOf(req) {
    const m = /(?:^|;\s*)whale_win=([A-Za-z0-9_-]{20,100})(?:;|$)/.exec(String(req.headers.cookie ?? ''))
    if (!m) return null
    let hit = null
    for (const s of sessions) if (safeEq(s, m[1])) hit = s      // 每个都比一遍
    return hit ? sessInfo.get(hit) ?? null : null
  }
  function authOf(req) {
    const pet = req.headers['x-whale-pet']
    if (typeof pet === 'string' && pet && safeEq(pet, petToken)) return 'pet'
    return sessionOf(req) ? 'window' : null
  }

  const jobView = (j) => ({ id: j.id, act: j.act, label: j.label, state: j.state, ok: j.ok, code: j.code, out: j.out, at: j.at, endedAt: j.endedAt })
  /** 替主人跑一次 cli（不等它）：开始、做完都推给小窗页面；投稿的话 window.json 记着「正在投稿」 */
  function startJob(act, label, args, input) {
    const j = { id: `j${++jobSeq}`, act, label, state: 'running', ok: null, code: null, out: '', at: new Date().toISOString(), endedAt: null }
    jobs.push(j)
    for (let i = 0; jobs.length > JOBS_KEEP && i < jobs.length;) { if (jobs[i].state !== 'running') jobs.splice(i, 1); else i += 1 }   // 只扔做完的
    if (act === 'approve') save()
    toWindows('job', jobView(j))
    // 测试用：BILI_WHALE_WINDOW_NO_EDGE=1 时才认 BILI_WHALE_WINDOW_ACT_MS（把每件事最多等多久压短，测「投稿超时 → 结果说不准」）
    const testMs = env.BILI_WHALE_WINDOW_NO_EDGE === '1' ? Number(env.BILI_WHALE_WINDOW_ACT_MS) : NaN
    j.done = runCli(args, { input, ms: Number.isInteger(testMs) && testMs > 0 ? testMs : ACTS[act].ms, env }).then((r) => {
      Object.assign(j, { state: 'done', ok: r.ok, code: r.code, out: jobOut(act, args, r), endedAt: new Date().toISOString() })
      if (act === 'approve') save()
      toWindows('job', jobView(j))
      if (ACTS[act].review || act === 'start') { try { live.refreshToday() } catch {} }
      if (act === 'say') { try { live.refreshChat() } catch {} }
      return j
    })
    return j
  }
  /** 请求体：最多 max 字节；多了就读完扔掉、报错（不掐连接：页面还要收到为什么） */
  const readBody = (req, max) => new Promise((resolve, reject) => {
    const parts = []
    let n = 0
    req.on('data', (d) => { n += d.length; if (n <= max) parts.push(d) })
    req.on('end', () => (n > max ? reject(new Error('太大了')) : resolve(Buffer.concat(parts).toString('utf8'))))
    req.on('error', reject)
  })
  /**
   * POST /api/act { act, …参数 }：小窗里点的事。规矩见文件开头：只认小窗页面自己、带操作令牌、限速；参数先查（actArgs）再替主人跑 cli。
   * 投稿：不带 confirm → 只回一个确认口令（两分钟、一次、绑这个窗口和这条视频）；带上它再来一次才真投。
   * 回：{ ok, job }（等最多 15 秒：快的直接带着结果；投稿这种慢的先回「在做」，做完由 SSE 的 job 事件推过去）/ { ok: false, error }
   */
  async function postAct(req, send) {
    const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj))
    const bad = (code, error) => json(code, { ok: false, error })
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() !== 'same-origin' || !origins.has(String(req.headers.origin ?? '').toLowerCase())) return bad(403, '只接小窗页面自己发的')
    const s = sessionOf(req)
    if (!s) return bad(403, EXPIRED)
    const tok = req.headers['x-whale-act']
    if (typeof tok !== 'string' || !safeEq(tok, s.act)) return bad(403, '这个窗口的操作令牌不对：刷新一下小窗（F5）')
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) return bad(415, '要 JSON')
    const t = Date.now()
    s.hits = s.hits.filter((x) => t - x < 60_000)
    if (s.hits.length >= ACT_RATE) return bad(429, '点得太快了，等一会儿再点')
    s.hits.push(t)
    let b
    try { b = JSON.parse(await readBody(req, ACT_BODY_MAX)) } catch (e) { return bad(e?.message === '太大了' ? 413 : 400, e?.message === '太大了' ? '内容太长了' : '不是 JSON') }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(400, '不是 JSON 对象')
    const act = String(b.act ?? '')
    if (!Object.hasOwn(ACTS, act)) return bad(400, '不认识的操作')
    const running = jobs.filter((x) => x.state === 'running')
    if (running.length >= JOBS_RUNNING_MAX) return bad(409, '手上的事太多了：等前面的做完再点')
    const sameKind = running.find((x) => x.act === act || (ACTS[act].review && ACTS[x.act]?.review))
    if (sameKind) return bad(409, `「${sameKind.label}」还在做：等它做完再点`)   // 跟她说也一次一句：几个 cli say 同时数「排着几句」会一起超过 5 句
    const cards = ['play', 'approve', 'reject'].includes(act) ? videoCards() : []
    const a = actArgs(act, b, { videoIds: cards.map((c) => c.id) })
    if (a.error) return bad(400, a.error)
    let label = ACTS[act].label
    if (act === 'channel-approve' || act === 'channel-reject') {
      // 要对上主人看到的那一版：她又交了一版，旧卡片上的「确认 / 退回」就不替他做（cli 的 channel approve 自己也比指纹；退回不比）
      const ch = (() => { try { return channelCard() } catch { return null } })()
      if (ch?.kind !== 'submitted') return bad(409, '现在没有她交上来的频道设定：刷新一下审核面板')
      if ((typeof b.sha === 'string' ? b.sha.toLowerCase() : '') !== ch.sha) return bad(409, '她又交了一版频道设定：刷新一下审核面板，看新的那一版')
    }
    if (act === 'approve' || act === 'reject' || act === 'play') {
      const vid = String(b.id), card = cards.find((c) => c.id === vid)
      // 她退回后重交：id 不变、这一轮交审的编号变了 —— 批 / 退的得是主人看到的那一版
      if (act !== 'play' && card?.sub && b.sub !== card.sub) return bad(409, '她重新交过这条视频了：刷新一下审核面板，看新的那一版')
      // 标题是会发出去的字：不抹凭据样子（不然标题里有 token 之类的词，确认框就只剩一个 id）
      const title = mtext(card?.title ?? '', 80, { scrub: false }) || vid
      label = `${label}《${title}》`
      if (act === 'approve') {
        for (const [k, v] of confirms) if (v.exp < t) confirms.delete(k)
        if (b.confirm == null) {
          const c = crypto.randomBytes(18).toString('base64url')
          confirms.set(c, { sid: s.sid, id: vid, sub: card?.sub ?? null, exp: t + CONFIRM_TTL })
          if (confirms.size > 50) confirms.delete(confirms.keys().next().value)
          return json(200, { ok: true, need: 'confirm', confirm: c, id: vid, title, seconds: card?.seconds ?? null, expiresInSec: CONFIRM_TTL / 1000 })
        }
        let hit = null
        for (const [k, v] of confirms) if (typeof b.confirm === 'string' && safeEq(k, b.confirm)) hit = [k, v]
        if (!hit || hit[1].sid !== s.sid || hit[1].id !== vid || hit[1].sub !== (card?.sub ?? null) || hit[1].exp < t) return bad(409, '这次确认过期了（或者不是这条视频的这一版）：再点一次「投稿」')
        confirms.delete(hit[0])
      }
    }
    const job = startJob(act, label, a.args, a.input)
    await Promise.race([job.done, new Promise((r) => { const w = setTimeout(r, ACT_WAIT_MS); w.unref?.() })])
    return json(200, { ok: true, job: jobView(job) })
  }
  function sendFile(req, res, send, root, file, type, maxAge, single) {
    const st = plainFileIn(root, file, { single })
    if (!st || st.size > 32n << 20n) return send(404, 'text/plain; charset=utf-8', 'not found')
    const etag = `"${st.mtimeMs}-${st.size}"`
    const extra = { 'cache-control': `private, max-age=${maxAge}`, etag }
    if (req.headers['if-none-match'] === etag) return send(304, type, '', extra)
    let body
    try { body = fs.readFileSync(file) } catch { return send(404, 'text/plain; charset=utf-8', 'not found') }
    return send(200, type, body, extra)
  }
  function openEvents(req, res, kind, send) {
    if (clients.size >= MAX_CLIENTS) return send(503, 'text/plain; charset=utf-8', '开着的小窗太多了（最多 4 个）', { 'retry-after': '30' })
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' })
    if (req.method === 'HEAD') return res.end()
    const c = { res, kind }
    clients.add(c)
    const drop = () => clients.delete(c)
    req.on('close', drop); res.on('close', drop); res.on('error', drop)
    res.write('retry: 3000\n\n')
    // 断线重连（浏览器带着 Last-Event-ID）：环里还接得上就先补发漏掉的，再给一份快照（快照里的旧事件页面按序号丢掉）；服务重启过（序号对不上）就只给快照
    const last = Number(req.headers['last-event-id'])
    if (Number.isInteger(last) && last > 0 && last <= seq && ring.length && last >= ring[0].seq - 1) for (const ev of ring) if (ev.seq > last) write(c, 'ev', evFor(c, ev), ev.seq)
    write(c, 'hello', snapshot(Date.now(), kind === 'pet'), seq)
  }

  function handle(req, res) {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { ...BASE_HEADERS, 'content-type': type, ...extra }); res.end(req.method === 'HEAD' || code === 304 ? undefined : body) }
    const text = (code, msg, extra) => send(code, 'text/plain; charset=utf-8', msg, extra)
    if (!allowed.has(String(req.headers.host ?? '').toLowerCase())) return text(421, `只能从本机打开：http://127.0.0.1:${port}/`)
    const raw = String(req.url ?? '/'), qi = raw.indexOf('?')
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw, query = qi >= 0 ? raw.slice(qi + 1) : ''
    // 唯一能改东西的入口：小窗里点的事（规矩全在 postAct 里）
    if (req.method === 'POST' && pathname === '/api/act') {
      postAct(req, send).catch((e) => { warn('小窗的操作出错：' + String(e?.message ?? e).slice(0, 160)); try { send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '小窗服务出错了' })) } catch {} })
      return
    }
    if (pathname === '/api/act') return text(405, '小窗里点的事只能 POST', { allow: 'POST' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, '这里只能看', { allow: 'GET, HEAD' })
    // 只认自己页面发的（same-origin）和地址栏直接打开的（none）；别的网站（连同本机别的端口：同站）来的一律不理
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site && site !== 'same-origin' && site !== 'none') return text(403, '不接别的网页发来的请求')
    if (pathname === '/health') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, v: VIEW_VERSION }))   // 给 cli 探活：不带任何数据
    const who = authOf(req)
    if (pathname === '/') {
      // HEAD 不兑换（预取 / 探测别把一次性口令用掉）
      const k = req.method === 'GET' ? new URLSearchParams(query).get('k') : null
      if (k && codes.redeem(k)) {
        const sid = crypto.randomBytes(32).toString('base64url')
        sessions.push(sid)
        sessInfo.set(sid, { sid, act: crypto.randomBytes(24).toString('base64url'), hits: [] })
        if (sessions.length > MAX_SESSIONS) sessInfo.delete(sessions.shift())
        return text(302, '', { location: '/window', 'set-cookie': `whale_win=${sid}; HttpOnly; SameSite=Strict; Path=/` })
      }
      return who ? text(302, '', { location: '/window' }) : text(403, EXPIRED)
    }
    if (!who) return text(403, EXPIRED)
    const st = STATIC[pathname]
    if (st) {
      let body
      try { body = fs.readFileSync(path.join(UI_DIR, st[0])) } catch { return text(404, 'not found') }
      if (pathname === '/window') body = withName(body.toString('utf8'), windowName())   // 标题、立绘的 alt 换成她的名字（window.js 从标题拿名字）
      return send(200, st[1], body)
    }
    if (pathname === '/events') return openEvents(req, res, who, send)
    if (pathname === '/api/live') return send(200, 'application/json; charset=utf-8', JSON.stringify(snapshot(Date.now(), who === 'pet')))
    // 下面这几样只给小窗页面（桌宠的令牌不行）：这个窗口的操作令牌、审核面板、最近替你做的事
    if (pathname === '/api/me' || pathname === '/api/review' || pathname === '/api/jobs') {
      if (who !== 'window') return text(403, '只给小窗页面')
      const j = (o) => send(200, 'application/json; charset=utf-8', JSON.stringify(o))
      if (pathname === '/api/me') return j({ act: sessionOf(req)?.act ?? null, sayMax: SAY_MAX, acts: Object.keys(ACTS) })
      if (pathname === '/api/jobs') return j({ jobs: jobs.map(jobView) })
      let data
      try { data = reviewData() } catch (e) { return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: '审核的数据读不出来：' + String(e?.message ?? e).slice(0, 120) })) }
      return j(data)
    }
    if (pathname === '/api/windows') return send(200, 'application/json; charset=utf-8', JSON.stringify({ windows: [...clients].filter((c) => c.kind === 'window').length }))   // cli：已经开着就不再开第二个
    if (pathname.startsWith('/sprite/')) {
      let segs
      try { segs = pathname.slice(8).split('/').map((s) => decodeURIComponent(s)) } catch { return text(404, 'not found') }
      const t = spriteTarget(live.cast(), segs)
      return t ? sendFile(req, res, send, t.root, t.file, 'image/png', 86400, false) : text(404, 'not found')
    }
    const bv = /^\/cover\/(BV[0-9A-Za-z]{10})$/.exec(pathname)?.[1]
    if (bv) { const root = path.join(SHOTS_DIR, 'covers'); return sendFile(req, res, send, root, path.join(root, bv + '.jpg'), 'image/jpeg', 600, true) }
    return text(404, 'not found')
  }

  const server = http.createServer((req, res) => {
    try { handle(req, res) } catch (e) { warn('小窗出错：' + String(e?.message ?? e).slice(0, 160)); try { res.writeHead(500, BASE_HEADERS); res.end() } catch {} }
  })
  server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch {} })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  } catch (e) {
    log(e?.code === 'EADDRINUSE' ? `端口 ${port} 被占用了：换一个（node host/cli.mjs window --port ${port + 1}）` : '小窗服务起不来：' + String(e?.message ?? e).slice(0, 200))
    return null
  }
  server.on('error', (e) => warn('小窗服务出错：' + String(e?.message ?? e).slice(0, 160)))
  ready = true
  save()
  try { live.boot() } catch (e) { warn('开头那一回合没读出来：' + String(e?.message ?? e).slice(0, 160)) }

  const pet = createPet({ port, token: petToken, log: warn, env })
  let ctlAt                                             // window-ctl.json 上次的 at（cli 每次 --pet 都写一个新的）
  const syncPet = () => {
    try {
      const c = readJson(CTL_FILE), on = c?.pet === true, at = typeof c?.at === 'string' ? c.at : null
      // 主人又跑了一次 --pet on（at 变了）：她可能正被「隐藏 10 分钟」藏着，或者上次在这台电脑上没起来 —— 重起一个，
      // cli 说的「几秒内她会出现」才算数（第一次读到的不算「又」：那是服务刚起）
      if (on && ctlAt !== undefined && at && at !== ctlAt) pet.restart()
      else pet.sync(on)
      ctlAt = at
    } catch {}
  }
  syncPet()
  const timers = [
    setInterval(() => { try { live.tick() } catch (e) { warn('读她的状态出错：' + String(e?.message ?? e).slice(0, 160)) } }, POLL_MS),
    setInterval(syncPet, CTL_MS),
    setInterval(() => { try { live.slow() } catch {} }, SLOW_MS),
    // 心跳是一条有名字的事件（不带 id：不动断线续传的序号），页面听得到；顺带保持连接不被中间什么东西当成闲置掐掉
    setInterval(() => { const at = new Date().toISOString(); for (const c of clients) write(c, 'hb', { at }, null) }, BEAT_MS),
    setInterval(() => codes.rotate(), CODE_ROTATE),
  ]
  log(`小窗服务：http://127.0.0.1:${port}/（pid ${process.pid}；打开窗口用 node host/cli.mjs window）`)
  const close = () => {
    for (const t of timers) clearInterval(t)
    pet.kill()
    for (const c of clients) try { c.res.end() } catch {}
    try { server.close() } catch {}
    try { if (readJson(INFO_FILE)?.pid === process.pid) fs.rmSync(INFO_FILE, { force: true }) } catch {}
  }
  return { server, port, close, live, pet }
}

/** 探活：/health 返回 { ok: true } 才算是小窗服务（端口上可能是别的程序） */
export function probe(port, timeout = 1500) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: `127.0.0.1:${port}` }, timeout }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { if (b.length < 4096) b += d })
      res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(b)?.ok === true) } catch { resolve(false) } })
    })
    r.on('timeout', () => r.destroy())
    r.on('error', () => resolve(false))
  })
}
/** 有几个小窗页面连着（用桌宠令牌问；cli 用来避免重复开窗口） */
function openWindows(info) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: info.port, path: '/api/windows', headers: { host: `127.0.0.1:${info.port}`, 'x-whale-pet': String(info.petToken ?? '') }, timeout: 2000 }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { if (b.length < 4096) b += d })
      res.on('end', () => { try { resolve(Number(JSON.parse(b)?.windows) || 0) } catch { resolve(0) } })
    })
    r.on('timeout', () => r.destroy())
    r.on('error', () => resolve(0))
  })
}

// ─────────────── cli：node host/cli.mjs window …（cli.mjs 只是转到这里：这边能在进程里单测） ───────────────
export const WINDOW_USAGE = '用法：node host/cli.mjs window [--with-pet] [--no-open] [--top] [--pet on|off] [--stop [--force]] [--port 8766] [--out 文件]'
export function parseWindowArgs(argv = []) {
  const a = { stop: false, noOpen: false, top: false, pet: null, port: null, withPet: false, out: null, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i]
    if (x === '--stop') a.stop = true
    else if (x === '--force') a.force = true   // 只和 --stop 一起：小窗正在替你投稿也停
    else if (x === '--no-open') a.noOpen = true
    else if (x === '--top') a.top = true
    else if (x === '--with-pet') a.withPet = true   // 开小窗，桌宠也一起出来（桌面上那个以她名字命名的按钮用）
    else if (x === '--pet') { const v = argv[++i]; if (v !== 'on' && v !== 'off') return { error: '--pet 后面要跟 on 或 off' }; a.pet = v }
    else if (x === '--port') { const p = Number(argv[++i]); if (!Number.isInteger(p) || p < 1024 || p > 65535) return { error: '--port 要是 1024–65535 之间的数' }; a.port = p }
    else if (x === '--out') { const f = argv[++i]; if (!f || f.startsWith('--')) return { error: '--out 后面要跟一个文件' }; a.out = f }   // 说的话写进这个文件（按钮的脚本读它，没有控制台）
    else return { error: `不认识的参数：${String(x).slice(0, 40)}` }
  }
  if (a.withPet && (a.pet || a.stop || a.noOpen)) return { error: '--with-pet 不能和 --pet / --stop / --no-open 一起用' }
  if (a.force && !a.stop) return { error: '--force 只能和 --stop 一起用' }
  return a
}
/** 默认端口：环境变量 BILI_WHALE_WINDOW_PORT 能换（测试里跑桌面按钮的脚本时用，别碰主人机器上开着的那个 8766） */
const defaultPort = () => { const p = Number(process.env.BILI_WHALE_WINDOW_PORT); return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT }
/** Edge 的参数：单独的配置目录、不同步、不隐式登录（不加这两个，新配置会自己登录主人的微软账号开始同步） */
export function edgeArgs({ port, code, profile = EDGE_PROFILE, pos = null }) {
  return [`--app=http://127.0.0.1:${port}/?k=${code}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-features=msImplicitSignin', '--window-size=440,760', ...(pos ? [`--window-position=${pos.x},${pos.y}`] : [])]
}
function regAppPath() {
  if (process.platform !== 'win32') return null
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const r = spawnSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(String(r.stdout ?? ''))
  return m ? m[1].replace(/^"|"$/g, '') : null
}
/** 找 msedge.exe：注册表 App Paths → Program Files (x86) → Program Files → 用户目录里装的 */
export function findEdge({ env = process.env, reg = regAppPath, exists = (f) => { try { return fs.statSync(f).isFile() } catch { return false } } } = {}) {
  const cands = []
  try { const r = reg(); if (r) cands.push(r) } catch {}
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) if (base) cands.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  return cands.find((f) => path.isAbsolute(f) && /(^|[\\/])msedge\.exe$/i.test(f) && exists(f)) ?? null
}
/** 小窗这个 Edge 配置是不是登录了账号（只看有没有，不看、不打印内容） */
export function signedIn(prefs) {
  if (!prefs || typeof prefs !== 'object') return null
  const has = (v) => typeof v === 'string' && v !== ''
  return (Array.isArray(prefs.account_info) && prefs.account_info.length > 0) || has(prefs.sync?.gaia_id) || has(prefs.google?.services?.last_gaia_id)
}
// 这几段 PowerShell 只查东西 / 动小窗那一个窗口，不开新窗口。参数一律走环境变量（-EncodedCommand 里不拼路径）
export const PS_WORKAREA = `Add-Type -AssemblyName System.Windows.Forms
$a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
'{0} {1} {2} {3}' -f $a.Left, $a.Top, $a.Right, $a.Bottom`
export const PS_EDGE_WINDOW = `$ErrorActionPreference = 'Stop'
$sig = @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
$W = Add-Type -MemberDefinition $sig -Name WhaleWindow -Namespace BiliWhale -PassThru
$dir = [string]$env:WHALE_EDGE_PROFILE
$title = [string]$env:WHALE_EDGE_TITLE
if (-not $dir -or -not $title) { 0; exit }
$ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { [int]$_.ProcessId })
if ($ids.Count -eq 0) { 0; exit }
$n = 0
foreach ($p in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero -or -not $p.MainWindowTitle.StartsWith($title)) { continue }
  if ($env:WHALE_EDGE_ACTION -eq 'top') { [void]$W::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x13) }
  else { if ($W::IsIconic($h)) { [void]$W::ShowWindow($h, 9) }; [void]$W::SetForegroundWindow($h) }
  $n++
}
$n`
export const PS_EDGE_KILL = `$dir = [string]$env:WHALE_EDGE_PROFILE
if (-not $dir) { exit }
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
function runPs(script, env = {}, timeout = 30_000) {
  if (process.platform !== 'win32') return null
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, ...env } })
  return r.status === 0 ? String(r.stdout ?? '').trim() : null
}
/** 小窗贴着工作区右边（Edge 的 --window-position 按缩放后的坐标算；WinForms 在没声明 DPI 感知的 PowerShell 里给的也是缩放后的） */
function workAreaPos() {
  const m = /^(-?\d+) (-?\d+) (-?\d+) (-?\d+)$/m.exec(runPs(PS_WORKAREA, {}, 20_000) ?? '')
  if (!m) return null
  const [l, t, r, b] = m.slice(1).map(Number)
  return { x: Math.max(l, r - 440 - 12), y: t + (b - t >= 760 + 24 ? 12 : 0) }
}
const edgeWindows = (action) => Number(runPs(PS_EDGE_WINDOW, { WHALE_EDGE_PROFILE: EDGE_PROFILE, WHALE_EDGE_ACTION: action, WHALE_EDGE_TITLE: windowName() }) ?? 0) || 0
async function checkSignIn({ waitMs = 6000, maxMs = 15_000 } = {}) {
  const f = path.join(EDGE_PROFILE, 'Default', 'Preferences'), t0 = Date.now()
  await sleep(waitMs)
  for (;;) {
    const p = readJson(f)
    if (p) return signedIn(p)
    if (Date.now() - t0 > maxMs) return null
    await sleep(1000)
  }
}

/**
 * window.json 记的 pid 真是小窗服务（node …window.mjs）：小窗服务停了、pid 被别的程序重用、端口又被别人（这台电脑上别的本地账号）占上的话，
 * 光看「进程在 + /health 应答」会把 Edge 开到别人的服务上、把桌宠令牌发过去。查不了（PowerShell / WMI 出错）就照旧信；同一个 pid 只查一次
 */
const viewerPids = new Map()
export function isViewerPid(pid) {
  if (!viewerPids.has(pid)) { const c = cmdLineChecked(pid); viewerPids.set(pid, c == null ? true : /window.mjs/i.test(c)) }
  return viewerPids.get(pid)
}
/** window.json 里记的那个服务能用：进程在、是小窗服务、/health 应答 → 那份 window.json；不然 null */
async function liveViewer() {
  const j = readJson(INFO_FILE)
  return j?.pid && pidAlive(j.pid) && Number.isInteger(j.port) && await probe(j.port) && isViewerPid(j.pid) ? j : null
}
/** 一个文件最后一行非空的字（window.out：服务起不来时它自己说的原因，比如「端口被占用了：换一个 --port」） */
function lastLine(f) {
  let fd
  try {
    fd = fs.openSync(f, 'r')
    const size = fs.fstatSync(fd).size
    return readAt(fd, Math.max(0, size - 4096), Math.min(size, 4096)).toString('utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() ?? ''
  } catch { return '' } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

async function ensureViewer(want, log) {
  const info = readJson(INFO_FILE)
  if (info?.pid && pidAlive(info.pid) && Number.isInteger(info.port) && isViewerPid(info.pid)) {
    let j = await probe(info.port) ? info : null
    // 进程在、/health 没应答：多半是另一个 cli window（或者点桌宠）刚起的服务 —— window.json 一写好它就同步重建开头那一回合、读今天的数据，
    // 那一两秒不接请求。是小窗服务就等它（最多 10 秒），别再起第二个（第二个会撞端口退出，这边就成了「没起来」）
    if (!j && isViewerPid(info.pid)) {
      log('小窗服务正在起，等它一下…')
      const t0 = Date.now()
      while (!j && Date.now() - t0 < VIEWER_WAIT_MS && pidAlive(info.pid)) { await sleep(250); j = await liveViewer() }
    }
    if (j) {
      if (want && want !== j.port) log(`小窗服务已经在 ${j.port} 端口跑着了（没换成 ${want}；要换先 window --stop）`)
      return j
    }
  }
  const port = want ?? defaultPort()
  fs.mkdirSync(HOST_DIR, { recursive: true })
  // 和 cli start 起宿主一样：脱离、不弹窗；输出进 window.out（起不来时看这里）
  const outFile = path.join(HOST_DIR, 'window.out')
  const outFd = fs.openSync(outFile, 'a')
  let child
  try { child = spawn(process.execPath, [SELF, '--port', String(port)], { detached: true, stdio: ['ignore', outFd, outFd], windowsHide: true, cwd: ROOT, env: { ...process.env, DSH_HOME } }) }
  finally { fs.closeSync(outFd) }
  child.on('error', () => {})
  child.unref()
  const t0 = Date.now()
  let exitedAt = null
  while (Date.now() - t0 < VIEWER_WAIT_MS) {
    await sleep(250)
    // 不只认自己起的那个：两个 cli window 同时跑（终端里一个、点桌宠一个），输的那个服务看见已经有一个了就自己退出 —— 用赢的那个
    const j = await liveViewer()
    if (j) { log(j.pid === child.pid ? `✓ 小窗服务起来了（127.0.0.1:${j.port}，pid ${j.pid}）` : `✓ 小窗服务在跑（刚有别的命令起了一个：127.0.0.1:${j.port}，pid ${j.pid}）`); return j }
    if (child.exitCode === null) continue
    exitedAt ??= Date.now()
    // 我们起的退出了：window.json 记着另一个还活着的服务（它正在重建开头那一回合、还没应答）就接着等；
    // 没有的话再给一秒（赢的那个可能刚监听上、还没写 window.json），然后就是真起不来
    const o = readJson(INFO_FILE)
    if (!(o?.pid && o.pid !== child.pid && pidAlive(o.pid)) && Date.now() - exitedAt > 1000) break
  }
  const why = clean(lastLine(outFile), 200)
  log(`小窗服务没起来${why ? '：' + why : ''}（全部输出在 ${outFile}）`)
  return null
}
async function stopViewer(log, { force = false } = {}) {
  const info = readJson(INFO_FILE), pid = Number(info?.pid)
  const drop = () => { try { if (readJson(INFO_FILE)?.pid === info?.pid) fs.rmSync(INFO_FILE, { force: true }) } catch {} }
  if (!pid || !pidAlive(pid)) { if (info) drop(); log('小窗服务没在跑'); return 0 }
  // 进程号会被系统复用（比如重启过）：命令行里是 window.mjs 才结束
  if (!/window\.mjs/i.test(cmdLine(pid))) { log(`window.json 里记的进程 ${pid} 不是小窗服务（进程号可能被别的程序用了）：没动它`); drop(); return 1 }
  // 小窗正替你投稿（上传要几分钟）：停了投稿会断在半路（B站 可能收到了、也可能没有）—— 先不停，除非 --force
  const busyNow = Array.isArray(info?.busy) ? info.busy.filter((x) => typeof x === 'string').map((x) => clean(x, 60)) : []
  if (busyNow.length && !force) {
    log(`小窗正在替你做：${busyNow.join('、')} —— 等它做完再停（小窗里看得到进度）。一定要现在停：node host/cli.mjs window --stop --force（投稿会断在半路，之后要去创作中心核对、再 videos resolve）`)
    return 1
  }
  killTree(pid)                                         // 整棵树：桌宠是它的子进程
  for (let i = 0; i < 30 && pidAlive(pid); i += 1) await sleep(100)
  if (pidAlive(pid)) { try { process.kill(pid) } catch {} }
  drop()
  log('✓ 小窗服务停了（桌宠跟着停了；Edge 里的小窗还开着的话会显示连不上，直接关掉就行）')
  // 「要不要桌宠」记在 window-ctl.json 里，--stop 不改它：下次起服务她会跟着回来 —— 说清楚，免得以为关掉了
  if (readJson(CTL_FILE)?.pet === true) log('  桌宠的开关还开着：下次 node host/cli.mjs window 她会跟着回来；不要她就先 node host/cli.mjs window --pet off')
  return 0
}

/** node host/cli.mjs window [--with-pet] [--no-open] [--top] [--pet on|off] [--stop] [--port N] [--out 文件] → 退出码 */
export async function windowCommand(argv = [], { log = (m) => console.log(m), env = process.env } = {}) {
  const a = parseWindowArgs(argv)
  if (a.error) { log(`${a.error}\n${WINDOW_USAGE}`); return 2 }
  if (a.out) {
    // 桌面按钮的脚本没有控制台：说的话整段写进 --out 的文件（新写），它读了再决定要不要弹框
    const lines = []
    const rest = argv.filter((x, i) => x !== '--out' && argv[i - 1] !== '--out')
    let code = 1
    try { code = await windowCommand(rest, { log: (m) => lines.push(String(m)), env }) } finally {
      try { fs.writeFileSync(a.out, lines.join('\n') + '\n', 'utf8') } catch {}
    }
    return code
  }
  if (a.stop) return stopViewer(log, { force: a.force })
  // --with-pet：先把「桌宠开着」记下来（服务每 2 秒看一次，起来 / 已经在跑都会把她叫出来），再照常开小窗
  if (a.withPet && process.platform === 'win32') writeJsonAtomic(CTL_FILE, { pet: true, at: new Date().toISOString() })
  // 测试 / 没有图形界面时：BILI_WHALE_WINDOW_NO_EDGE=1 → 不开 Edge、不跑任何 PowerShell 窗口操作，只打印地址
  const noGui = env.BILI_WHALE_WINDOW_NO_EDGE === '1'
  if (a.pet) {
    if (a.pet === 'on' && process.platform !== 'win32') { log('桌宠只能在 Windows 上用'); return 1 }
    writeJsonAtomic(CTL_FILE, { pet: a.pet === 'on', at: new Date().toISOString() })
    const v = await ensureViewer(a.port, log)
    if (!v) return 1
    // 她站在工作区右下角、小窗那一栏的左边（pet.ps1 的 Place-Home：不挡小窗底下的「今天」）；
    // 已经开着的再 --pet on 一次，服务会重起她（藏起来了的也马上回来）—— 见 startViewer 的 syncPet
    log(a.pet === 'on' ? '✓ 桌宠开了：几秒内她会出现在屏幕右下角、小窗左边（点她开小窗；右键能藏 10 分钟或关掉；藏起来了想马上叫回来，再跑一次这条命令）'
      : '✓ 桌宠关了（小窗服务还在；全停：node host/cli.mjs window --stop）')
    return 0
  }
  const v = await ensureViewer(a.port, log)
  if (!v) return 1
  if (a.withPet) log(process.platform === 'win32' ? '✓ 桌宠也开了：几秒内出现在屏幕右下角、小窗左边' : '桌宠只能在 Windows 上用（小窗照开）')
  if (a.noOpen) { log(`小窗服务在跑：127.0.0.1:${v.port}（pid ${v.pid}）。打开窗口：node host/cli.mjs window`); return 0 }
  // 已经开着一个了：不再开第二个（点桌宠会跑这条命令），把它切到前面
  if (await openWindows(v) > 0) {
    if (noGui) { log('小窗已经开着了'); return 0 }
    const n = edgeWindows(a.top ? 'top' : 'front')
    log(n > 0 ? (a.top ? '✓ 小窗已经开着了：放到最上面了（只这一次）' : '✓ 小窗已经开着了：切到前面了') : `小窗已经开着了（在任务栏上找「${windowName()}」）`)
    return 0
  }
  const cur = readJson(INFO_FILE)
  const code = cur?.pid === v.pid && cur.code ? cur.code : v.code       // 刚才那个口令可能已经被换掉了：用最新的
  const url = `http://127.0.0.1:${v.port}/?k=${code}`
  if (noGui) { log(`打开这个地址（一分钟内有效、只能用一次）：${url}`); return 0 }
  const edge = findEdge({ env })
  if (!edge) {
    log(`没找到 Microsoft Edge。用浏览器打开这个地址（一分钟内有效、只能用一次）：\n  ${url}\n  （登录用的 cookie 会存在那个浏览器里；只有这台电脑打得开）`)
    return 3   // 窗口没开出来：桌面按钮看到非 0 才会弹框把地址给你（以前是 0，按了按钮什么都不出来）
  }
  try {
    const child = spawn(edge, edgeArgs({ port: v.port, code, pos: workAreaPos() }), { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch (e) { log('Edge 没打开：' + String(e?.message ?? e).slice(0, 160) + `\n用浏览器打开（一分钟内有效）：${url}`); return 1 }
  log('✓ 开了「她的小窗」（Edge 应用窗口，用单独的、不登录的配置：' + EDGE_PROFILE + '）')
  log('  在核对这个窗口没登录你的微软账号…')
  const signed = await checkSignIn()
  if (signed === true) {
    runPs(PS_EDGE_KILL, { WHALE_EDGE_PROFILE: EDGE_PROFILE })
    log(`⚠️ 小窗用的 Edge 配置登录了一个微软账号（Edge 改了规则？）：已经把它关掉了。先别用小窗 —— 删掉 ${EDGE_PROFILE} 再试；还这样就告诉 Claude`)
    return 1
  }
  log(signed === false ? '  ✓ 没登录账号、不同步' : '  没来得及核对（Edge 还没写好配置）：下次打开时会再看')
  if (a.top) { const n = edgeWindows('top'); log(n > 0 ? '✓ 放到最上面了（只这一次；关掉再开就不置顶了）' : '没找到小窗那个窗口，没能置顶') }
  return 0
}

// ─────────────── 直接跑：node host/window.mjs [--port N] ───────────────
const isMain = (() => { try { return samePath(path.resolve(process.argv[1] ?? ''), SELF) } catch { return false } })()
if (isMain) {
  for (const s of [process.stdout, process.stderr]) s.on('error', () => {})   // 输出管道断了也接着跑
  const i = process.argv.indexOf('--port')
  const port = i >= 0 ? Number(process.argv[i + 1]) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.log('--port 要是 1024–65535 之间的数'); process.exit(2) }
  const v = await startViewer({ port })
  if (!v) process.exit(1)
  const stop = () => { v.close(); process.exit(0) }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop)
  process.on('uncaughtException', (e) => { console.error('小窗服务出错退出：' + String(e?.stack ?? e).slice(0, 400)); v.close(); process.exit(1) })
}
