// 本地面板（只读）：主人在自己电脑上看她现在怎么样、今天做了什么、哪些在等主人、哪里出了错、花了多少。
//   node host/cli.mjs dashboard [--port 8765]   只监听 127.0.0.1，浏览器打开打印出来的一次性链接；每 20 秒自己刷新
//                                               面板已经开着：再跑一次只打印一个新的一次性链接（不起第二个）
//   node host/cli.mjs dashboard --json          不起服务，打印一次和页面同样的数据（排查 / 测试用）
//
// 规矩：
//   · 只读：除了自己的 <数据目录>/whale-cc/dashboard.json（一次性口令，见下面「门」）、删掉 cli 放的条子 dashboard.want，不改任何文件、不访问 B站、不起她的回合
//     （宿主的 isBusy / kick / session() 会改文件，一律不碰）。和宿主分开跑 —— 宿主停了这里照样能看，显示「离线」。
//   · 门（2026-10-26 主人定的 A 方案，照小窗服务 host/window.mjs 的做法）：页面里有她回主人的话（私信 / 小窗）、模块那几栏里私密的来回和摘录，
//     而这台电脑上别的程序、别的本地账号也连得上回环地址 → 光看 Host 不够。没有有效 cookie 的请求（页面、/api/state、别的路径）
//     一律只拿到一句固定的话（401），没有任何数据。cookie 这样来：cli 打印的链接 /?k=口令 → 一次性口令（10 分钟内有效、只能用一次、
//     比较时间不随内容变）换成 HttpOnly + SameSite=Strict、Path=/、不带 Domain 的 cookie，303 跳回不带口令的 /；会话令牌只在这个进程的内存里，
//     12 小时后作废、2 小时没用过也作废（cookie 不分端口：同一个浏览器再打开本机别的端口上的网页服务，那个服务也收得到它 —— 至少别让偷到的一直能用）。
//     口令是 32 位十六进制（不用 base64url：Windows Terminal 认链接时不把末尾的「-」算进去，点开就少一位）。
//     口令写在 dashboard.json（只有主人读得到的数据目录；先写临时文件再改名；5 分钟换一个、兑换后马上换；没过期的都认；退出时删掉）。
//     面板开着时主人要新链接（换浏览器、链接过期了）就再跑一次 cli dashboard：它在同一个目录里放一张条子 dashboard.want（一个随机 id），
//     面板每 0.2 秒看一眼，看到就删掉条子、发一个新口令写进 dashboard.json（mintFor = 那个 id），cli 读到对得上的才打印 —— 每次都是新的。
//     放得了条子的本来就读得到 dashboard.json，这条路不多给谁什么；HTTP 上没有发口令的路。口令、令牌不进任何日志。
//   · 「成功」只认代码写的账本 / 结果文件：额度账本 quota.json、审片发布记录 review/<id>/published.json、观众记忆里工具记下的交流、
//     模块那几栏各自的记录…
//     她回合结束时说的话、她的日记、事件流 whale-log.jsonl 都是她写得到的，只当「她说的（没核实）」，日记里写「我发了」不算发了。
//   · 状态分五种：已触发（排着 / 等你审）· 进行中 · 成功 · 失败 · 不确定（结果不明，可能其实成了）；另有「不知道」（文件坏了 / 读不出来）。
//   · 凭据、推送地址、她的 Claude 配置目录一律不读不显示（B站 登录状态看宿主每小时查完写的 login-state.json，里面没有 cookie）；她和观众写的字一律转义、去掉控制字符和改变方向的字符。
//   · 以后加「批准 / 退回」按钮，也必须调 host/core.mjs 里现有的 approveVideo / rejectVideo / approveDraft / rejectDraft，
//     看的是同一份审片快照（core.videoFile(id) 所在的 review/<id>/）。这一版只给出对应的命令。
import './env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { cmdLineChecked, renameRetry } from '../tools/lib/filelock.mjs'
import { HOST_DIR, DSH_HOME, HOME, CFG_FILE, PENDING_FILE, LOGIN_STATE_FILE, readConfig, listPending, listVideos, videoFile } from './core.mjs'
import { STATE as DAEMON_FILE, daemonAlive, pidAlive } from './state.mjs'
import { RUNNING_FILE, SHOTS_DIR, liveTurn, isOurTurn, sessionProcs } from './claude.mjs'
import { readTurnLogs as readLogLines, turnCosts } from './turncost.mjs'
import { reviewRecords, publishedRecord, readAttempts, readUploadLock, uploadLockLive, IMAGE_LEDGERS, SUBS_DIR, PENDING_VIDEOS } from '../tools/lib/studio.mjs'
import { QUOTA_FILE } from '../tools/lib/ledger.mjs'
import { MEMORY_DIR } from '../tools/lib/memory.mjs'
import { diaryPath, privateDiaryPath } from '../tools/lib/paths.mjs'
import { recentWatches, scopeOf } from '../tools/lib/watchlog.mjs'
import { isPending as planPending } from '../tools/lib/night-plan.mjs'
import { apiState } from '../tools/lib/bili-api.mjs'
import { optionalHook } from './modules.mjs'
import { RESERVED_PRIVATE_LEDGER_TYPES, RESERVED_PRIVATE_CHANNELS } from '../tools/lib/turn-ids.mjs'
import { readLetters, latestLetters, lettersEnabled, OWNER_KIND_LABEL } from '../tools/lib/letters.mjs'
import { webOpts, personaName } from '../tools/lib/config.mjs'
import { listRequests, readNotes, readVisits } from '../tools/lib/webstate.mjs'

const AI_DIR = path.join(HOME, '.bili-ai')
const UNCERTAIN_AFTER_MS = 10 * 60_000          // 预留了却一直没落账：工具早就该结束了 → 结果不确定
const DAY_MS = 86_400_000

// ─────────────── 小工具 ───────────────
const localDay = (t) => new Date(t).toLocaleDateString('sv-SE')
const localTime = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('sv-SE', { hour12: false }).slice(0, 16) }
/** 别人写的字：去掉控制字符和改变书写方向的字符（换行可保留），再截短 */
const clean = (s, n = 200, keepNl = false) => {
  const t = String(s ?? '').replace(keepNl ? /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g : /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, keepNl ? '' : ' ')
  return t.length > n ? t.slice(0, n) + '…' : t
}
// 万一哪段日志里带了 cookie / 密钥的样子，显示前抹掉（工具本身已经不打印这些，这里是兜底）
const redact = (s) => String(s ?? '').replace(/SESSDATA=[^;\s]+/gi, 'SESSDATA=***').replace(/bili_jct=[^;\s&]+/gi, 'bili_jct=***').replace(/csrf(_token)?=[^&\s]+/gi, 'csrf=***').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***').replace(/\b(access_token|token|sendkey|secret|key)=[^&\s"']+/gi, '$1=***')
const BV_RE = /^BV[0-9A-Za-z]{10}$/
const NUM_RE = /^\d{1,20}$/
const bvLink = (bv) => (BV_RE.test(String(bv ?? '')) ? `https://www.bilibili.com/video/${bv}/` : null)
// BV 号 ↔ av 号是固定算法（B站 公开的），离线就能换算：用来核对她标的 --bvid 是不是真的就是评论发到的那个视频（视频评论区 type=1 的 oid 就是 av 号）
const BV_DATA = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'
export function bv2av(bv) {
  if (!BV_RE.test(String(bv ?? ''))) return null
  const a = Array.from(bv);
  [a[3], a[9]] = [a[9], a[3]];
  [a[4], a[7]] = [a[7], a[4]]
  const t = a.slice(3).reduce((p, c) => p * 58n + BigInt(BV_DATA.indexOf(c)), 0n)
  return String((t & 2251799813685247n) ^ 23442827791579n)
}
/** 她标的视频对不对得上评论真正发到的地方（只有视频评论区 type=1 能核对） */
const bvMatches = (bv, type, oid) => Number(type ?? 1) === 1 && NUM_RE.test(String(oid ?? '')) && bv2av(bv) === String(oid)
const TYPE_NAME = { 1: '视频评论区', 11: '动态（图文）评论区', 12: '专栏评论区', 17: '动态评论区' }

/** 读 JSON：不存在 = missing；存在但读不出来 = corrupt（先再读一次：有的文件不是原子写的，可能正好读到一半） */
function readJsonFile(f) {
  for (let i = 0; i < 2; i += 1) {
    let raw
    try { raw = fs.readFileSync(f, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return { missing: true, value: null }; if (i) return { corrupt: true, value: null, why: e?.code ?? String(e) }; continue }
    try { return { value: JSON.parse(raw.replace(/^\uFEFF/, '')) } } catch { if (i) return { corrupt: true, value: null, why: '不是完整的 JSON' } }
  }
  return { corrupt: true, value: null }
}
/** 读文本文件的最后 maxBytes 字节（大日志只看尾巴） */
function tailText(f, maxBytes = 256 * 1024) {
  let fd
  try {
    fd = fs.openSync(f, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    let s = buf.toString('utf8')
    if (len < size) s = s.slice(s.indexOf('\n') + 1)    // 第一行多半被截断了
    return s
  } catch { return '' } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}
/** 带时间戳的日志：一条可能跨好几行（堆栈），按开头的 ISO 时间分组 */
function logEntries(text) {
  const out = []
  for (const l of String(text).split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/.exec(l)
    if (m) out.push({ at: m[1], text: m[2] })
    else if (out.length && l.trim()) out[out.length - 1].text += '\n' + l
  }
  return out
}
const safely = (fn) => { try { return fn() } catch (e) { return { error: clean(redact(e?.message ?? e), 300) } } }
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

// ─────────────── 模块的几栏（可拔掉的模块自己带的：host/<模块>-panel.mjs；没装就没有这个文件，面板上也就没有那几栏） ───────────────
// 每个模块的面板文件导出：
//   panels —— 快照里的几块，按这个顺序收、按这个顺序排在顶上那一排：{ key（快照里的键）, collect(now, cfg, h), fact(快照里这一块, h) → { text, bad } | null,
//             errorLogs?: [{ file, from }]（「最近的错误」里另标的日志）, important?(这一块, { recent }, h) → [{ at, from, text }], flags?(这一块, h) → [句子],
//             sendTypes?（额度账本里不算公开发言的种类：「今天发出去的」不列，小窗的「发出」不数）, sendsNote?(这一块, h)（「今天发出去的」底下补一句，已转义的 HTML）,
//             slot?: 'afterSends' + html(这一块, h)（排在「今天发出去的」后面的一栏） }
//   turn —— 这个模块的回合在「她的回合」里怎么说：{ re, kind, label, after（排在哪种后面，只为好读：前缀互不重叠）, rerun?, resendNote?, replied?(id), repliedNote?(r) }
//   privateChannels —— 观众记忆里这些 channel 的交流是私密的来回（没有评论区的位置）
// 顺序有用（快照里的键、顶上那一排、页面上的栏都按它排），和拆开之前一个样。面板文件不引用这里（顶层 await 遇到循环引用会卡死）：用到的小工具从 h 传过去
const HOOKS = [await optionalHook('qq', 'qq-panel.mjs'), await optionalHook('sdm', 'sdm-panel.mjs')].filter(Boolean)
const PANELS = HOOKS.flatMap((m) => m.panels ?? [])
const TURN_HOOKS = HOOKS.map((m) => m.turn).filter(Boolean)
const H = { readJsonFile, clean, redact, localDay, localTime, isoOrNull, NUM_RE, DAY_MS }
/** 额度账本里记着、却不是公开发到 B站 上的种类（模块登记的）：「今天发出去的」不列，小窗的「发出」也不数（host/window.mjs sentToday） */
//   模块没装也照样挡核心记着的那几种（tools/lib/turn-ids.mjs：拔掉以后留下的旧记录不能变成公开的）
export const PRIVATE_SEND_TYPES = new Set([...RESERVED_PRIVATE_LEDGER_TYPES, ...PANELS.flatMap((p) => p.sendTypes ?? [])])
/** 模块的一块单独算顶上那一格（cli doctor 用，和面板同一句话）：没有这一块 → null */
export function panelFact(key, now, cfg) {
  const p = PANELS.find((x) => x.key === key)
  return p ? p.fact(p.collect(now, cfg, H), H) : null
}

// ─────────────── 宿主 ───────────────
function hostState(now) {
  const d = readJsonFile(DAEMON_FILE)
  const st = d.value
  const paused = readJsonFile(path.join(HOST_DIR, 'paused.json')).value
  const out = { paused: paused?.pid && pidAlive(paused.pid) ? { since: paused.at ?? null } : null }
  if (d.missing) return { ...out, state: 'never', label: '没启动过' }
  if (d.corrupt || !st) return { ...out, state: 'unknown', label: '状态文件读不出来' }
  const age = now - Date.parse(st.heartbeat ?? 0)
  const base = { ...out, pid: st.pid ?? null, startedAt: st.startedAt ?? null, heartbeat: st.heartbeat ?? null, heartbeatAgeSec: Number.isFinite(age) ? Math.round(age / 1000) : null,
    stoppedAt: st.stoppedAt ?? null, scheduler: st.scheduler ? { ok: Boolean(st.scheduler.ok), reason: clean(st.scheduler.reason, 200) } : null, claudeFound: Boolean(st.claude),
    running: st.running ?? null, queued: Number(st.queued ?? 0) }
  if (daemonAlive(st)) return { ...base, state: 'online', label: '在线' }
  // 心跳停了 10 分钟以上：就算那个进程号还在，也多半是机器重启后被别的程序用了 —— 按离线算
  if (st.pid && pidAlive(st.pid) && age < 10 * 60_000) return { ...base, state: 'unresponsive', label: '进程在，但心跳停了' }
  if (!st.pid && st.stoppedAt) return { ...base, state: 'stopped', label: '已停止（离线）' }
  return { ...base, state: 'crashed', label: `离线（没正常退出；心跳停在 ${localTime(st.heartbeat)}）` }
}

// ─────────────── 回合（宿主叫醒她的每一次） ───────────────
// 模块的回合（turn.re / kind / label）插在它说的那一种后面
const KINDS = [[/^bili-whale-dm-/, 'dm', '主人私信'], [/^bili-whale-win-/, 'win', '主人在小窗里说'], [/^bili-whale-listen-/, 'listen', '有人找她'], [/^bili-whale-live-/, 'live', '直播间'],
  [/^bili-whale-\d+$/, 'night', '按作息醒来'], [/^manual-/, 'manual', '你手动叫醒'], [/^bili-whale-preview-/, 'preview', '预览']]
for (const t of TURN_HOOKS) { const i = KINDS.findIndex(([, k]) => k === t.after); KINDS.splice(i < 0 ? KINDS.length : i + 1, 0, [t.re, t.kind, t.label]) }
export const kindOf = (id) => { for (const [re, k, label] of KINDS) if (re.test(String(id))) return { kind: k, kindLabel: label }; return { kind: 'other', kindLabel: '其它' } }
const turnHook = (id) => TURN_HOOKS.find((t) => t.re.test(String(id))) ?? null
// 主人找她的回合（私信，和模块登记了 rerun 的）：宿主断了会重跑一次（host/claude.mjs）；没处理完的时候提醒主人要紧的再发
const ownerTurn = (id) => /^bili-whale-dm-/.test(String(id)) || Boolean(turnHook(id)?.rerun)
// 模块的回合没处理完怎么说（resendNote）：比如不是主人的回合不重跑（免得回两遍），一条都没回上的过一会儿再交给她一次
const resendNote = (id) => (String(id).startsWith('bili-whale-dm-') ? '（这批私信要紧的话再发一次）' : turnHook(id)?.resendNote ?? '')
/**
 * 模块的回合她已经回过主人几条（回复记录，只读）→ { n, unsure（其中说不准发出去没有的）, note（怎么说） }；一条没有 / 没登记 / 读不出来 = null。
 * 宿主再启动时看到回过就不重跑、也不叫主人重发（host/claude.mjs #orphanAlive / #dmLost）—— 面板照同样的说（2026-10-25 第二轮审查）
 */
function repliedFor(id) {
  const t = turnHook(id)
  const r = typeof t?.replied === 'function' ? t.replied(id) : null
  return r ? { ...r, note: t.repliedNote(r) } : null
}
const unsureText = (r) => (r.unsure ? `（其中 ${r.unsure} 条说不准发出去没有）` : '')

// 回合结果日志：往前多读几天 —— 里面的 costUsd 是会话累计，算每一轮花的要看到同一会话前面的回合（会话 rotateDays 天一换；见 turncost.mjs）
const readTurnLogs = (now, cfg) => readLogLines(path.join(HOST_DIR, 'logs'), { now, days: Math.max(8, Number(cfg?.claude?.rotateDays ?? 7) + 1) })

function turnsState(now, host, cfg, light = false) {
  const q = readJsonFile(path.join(HOST_DIR, 'queue.json'))
  const queue = Array.isArray(q.value) ? q.value : []
  const run = readJsonFile(RUNNING_FILE).value
  const logs = readTurnLogs(now, cfg)
  const costs = turnCosts(logs)                                  // id → 这一轮花的（不是会话累计）
  const logged = new Set(logs.map((l) => l.id))
  // 正在跑的那个：宿主在线时先信 running.json（进程还在、还没有结果记录）—— 心跳 30 秒才写一次，里面的 running 可能还是刚跑完的上一个；
  // 宿主不在线时，前台 `cli wake` 也可能在跑（要查进程，慢，只在这时查）
  let runningId = null, runningAt = null, runningNote = null, stuck = null
  const maxMs = (Number(cfg.claude?.timeoutMin ?? 25) + 5) * 60_000
  // 同一会话的进程还在不在（经 claude.cmd 启动时记下的是 cmd.exe；宿主崩了之后 claude 本身可能还在跑）—— 要查进程，慢，只在需要时查
  // light（小窗每 30 秒要一次）：不起 PowerShell 查进程，只看记下的进程号在不在 —— 可能认错，只影响「进行中」这一格（小窗自己看 running.json）
  const leftoverAlive = (r) => Boolean(r?.sessionId) && (light ? pidAlive(r.pid) : isOurTurn(r) || sessionProcs(r.sessionId).length > 0)
  if (host.state === 'online') {
    if (run?.id && run.pid && pidAlive(run.pid) && !logged.has(run.id)) { runningId = run.id; runningAt = run.at }
    else if (host.running && !logged.has(host.running)) runningId = host.running
    else if (run?.id && !logged.has(run.id) && leftoverAlive(run)) { runningId = run.id; runningAt = run.at; runningNote = '上一个宿主留下的、还在跑：宿主在等它跑完' }
  } else if (run?.id && !logged.has(run.id)) {
    const lt = Date.now() - Date.parse(run.at ?? 0) < maxMs ? (light ? (pidAlive(run.pid) ? run : null) : liveTurn()) : null
    if (lt) { runningId = lt.id; runningAt = lt.at; runningNote = '宿主不在线：没人会结束它；宿主再启动时超时的会被结束' }
    else if (leftoverAlive(run)) {
      // 过了时限还在跑：下次启动宿主会把它结束、不重跑（和 #orphanAlive 的「跑太久」一样）
      runningId = run.id; runningAt = run.at
      const r = repliedFor(run.id)
      runningNote = '跑太久了，还没停：下次启动宿主会结束它、不重跑' + (r ? `；${r.note}${unsureText(r)}` : resendNote(run.id))
    } else {
      // 和下次启动宿主时的处理一样说（host/claude.mjs #orphanAlive）：主人找她的回合（ownerTurn）、不是主人停的、还没重跑过 → 重跑一次；别的都丢掉。
      // 模块的回合她已经回过主人（repliedFor）：不重跑，也不叫主人重发（重发了她会把同样的事再回一遍）
      const item = queue.find((x) => x.id === run.id)
      const r = repliedFor(run.id)
      const note = r ? `${run.stoppedByOwner ? '你停掉宿主时' : '宿主断的时候'}它没跑完；${r.note}：不会重跑${unsureText(r)}`
        : run.stoppedByOwner ? '你停掉宿主时它没跑完：不会重跑' + resendNote(run.id)
          : ownerTurn(run.id) && item && !item.orphanRetry ? '宿主断的时候它没跑完：下次启动宿主会重跑一次'
            : '宿主断的时候它没跑完：下次启动宿主时会丢掉、不重跑' + resendNote(run.id)
      stuck = { id: run.id, ...kindOf(run.id), at: run.at, note }
    }
  }
  const timeoutMin = Number(cfg.claude?.timeoutMin ?? 25)
  const items = []
  for (const it of queue) {
    if (it.id === runningId || it.id === stuck?.id || logged.has(it.id)) continue
    items.push({ id: it.id, ...kindOf(it.id), at: it.at ?? null, status: 'triggered', note: it.orphanRetry ? '半路断过，等着重跑一次' : '排着' })
  }
  if (runningId) items.push({ id: runningId, ...kindOf(runningId), at: runningAt, status: 'running',
    note: [runningAt ? `已经跑了 ${Math.round((now - Date.parse(runningAt)) / 60000)} 分钟` : '', runningNote ?? (runningAt ? `（超过 ${timeoutMin} 分钟会被结束）` : '')].filter(Boolean).join(' · ') })
  // 跑完的：看结果日志（只说明「回合跑完了」，她做没做成要看下面的账本）；失败的另外留 24 小时给「最近的错误」
  const today = localDay(now)
  const recentFails = []
  for (const l of logs) {
    const isToday = localDay(l.at) === today, recentFail = !l.ok && now - Date.parse(l.at) < DAY_MS
    if (!isToday && !recentFail) continue                       // 往前多读的那几天只当算费用的上下文
    const timeout = !l.ok && /超时，已终止/.test(String(l.result ?? ''))
    const row = { id: l.id, ...kindOf(l.id), at: l.at, status: l.ok ? 'success' : 'fail', costUsd: costs.get(l.id) ?? null, ms: l.ms ?? null,
      note: l.ok ? '回合跑完了（她做没做成，看「今天发出去的」）' : timeout ? '超时，被结束了' : '回合失败',
      said: l.ok ? clean(redact(l.result), 300) : null, why: l.ok ? null : clean(redact(l.result), 300) }
    if (recentFail) recentFails.push(row)
    if (isToday) items.push(row)
  }
  // 标了「处理过」却没有结果日志：半路断了 / 被结束了 / 换过宿主 —— 不知道结果
  const done = readJsonFile(path.join(HOST_DIR, 'turns-done.json')).value
  for (const d of Array.isArray(done) ? done : []) {
    if (logged.has(d.id) || localDay(d.at) !== today || items.some((x) => x.id === d.id)) continue
    items.push({ id: d.id, ...kindOf(d.id), at: d.at, status: 'unknown', note: '没有结果记录（半路断了、被结束了，或者是上一个宿主跑的）—— 看「最近的错误」' })
  }
  if (stuck) items.push({ ...stuck, status: 'uncertain' })
  items.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  return { items, recentFails, queueCorrupt: Boolean(q.corrupt) }
}

// ─────────────── 她的 B站 登录（宿主每小时用 nav 查一次写的 login-state.json；凭据本身不读） ───────────────
const LOGIN_STALE_MIN = 150   // 宿主每小时查一次：两个半小时没更新 = 宿主没在跑，或者查的那段出了问题
function loginState(now, cfg) {
  const self = cfg?.self?.mid ? { mid: clean(cfg.self.mid, 20), name: clean(cfg.self.name, 40) } : null
  const f = readJsonFile(LOGIN_STATE_FILE)
  if (f.missing) return { state: 'never', self }
  if (f.corrupt || !f.value) return { state: 'corrupt', self }
  const v = f.value
  const age = (now - Date.parse(v.checkedAt ?? '')) / 60_000
  const state = ['ok', 'invalid', 'unknown', 'missing'].includes(v.state) ? v.state : 'corrupt'
  return {
    state, self,
    mid: v.mid ? clean(v.mid, 20) : null, name: v.name ? clean(v.name, 40) : null,
    checkedAt: v.checkedAt ?? null, since: v.since ?? null, lastOkAt: v.lastOkAt ?? null,
    why: v.why ? clean(redact(v.why), 160) : null,
    problem: ['owner', 'mismatch'].includes(v.problem) ? v.problem : null, expected: v.expected ? clean(v.expected, 20) : null,
    stale: !Number.isFinite(age) || age > LOGIN_STALE_MIN,
  }
}
const RELOGIN = '重新扫码：node host/cli.mjs cookie --qr'
/** 顶上那一格：登录现在怎么样（一句话） */
function loginFact(l) {
  if (!l || l.error) return '她的 B站 登录：不知道（读不出来）'
  const who = l.name || l.mid ? `${l.name || '?'}（UID ${l.mid ?? '?'}）` : ''
  const checked = l.checkedAt ? `，${localTime(l.checkedAt)} 查的${l.stale ? ' —— 这条记录很久没更新了，宿主可能没在跑' : ''}` : ''
  if (l.state === 'never') return '她的 B站 登录：还没查过（宿主启动 20 秒后查一次，之后每小时一次；或者跑 node host/cli.mjs doctor）'
  if (l.state === 'corrupt') return '她的 B站 登录：状态文件读不出来'
  if (l.state === 'ok') return `她的 B站 登录：有效 · ${who}${checked}`
  if (l.state === 'invalid') return `她的 B站 登录：失效了${checked}`
  if (l.state === 'missing') return '她的 B站 登录：还没登录'
  return `她的 B站 登录：上次没查到${checked}${l.lastOkAt ? `（最后一次确认有效：${localTime(l.lastOkAt)}）` : ''}`
}

// ─────────────── 作息 ───────────────
function planState(now) {
  const p = readJsonFile(path.join(DSH_HOME, 'whale-night.json'))
  if (p.missing) return { text: '还没排过（宿主没跑过）' }
  if (p.corrupt) return { text: '作息文件读不出来' }
  const st = p.value
  if (st.date && st.date !== localDay(now) && !planPending(st, now)) return { text: '今天的作息还没排（宿主离线，或者还没到下一次检查）' }
  if (st.action === 'done') return { text: `今天不再醒了：${clean(st.reason, 80)}` }
  if (planPending(st, now)) return { text: `下一次：${clean(st.atText, 20)}（${st.action === 'skip' ? '只写日记' : '醒来看视频'}）`, at: st.atText }
  if (!st.fired && Number(st.endsAt) < now) return { text: `错过了 ${clean(st.atText, 20)} 那次（宿主当时不在线）`, missed: true }
  return { text: st.fired ? `已叫醒过（${clean(st.atText, 20)}）` : '—' }
}

// ─────────────── 今天发出去的（只认账本） ───────────────
const TYPE_LABEL = { comment: '评论 / 回复', dm: '分享私信', dynamic: '动态', danmaku: '弹幕', 'dynamic-edit': '改动态', video: '投稿' }
const ws = (x) => String(x ?? '').replace(/\s+/g, ' ').trim()
/**
 * 她那条回复真正在哪：type / oid 是评论真发到的地方（工具按它发）；BV 号、动态号是她自己标的 ——
 * 视频评论区（type 1）直接用 av 号链过去（就是真地方），她标的 BV 能换算核对；动态评论区（type 17）的 oid 就是动态号；
 * 图文动态（type 11）的 oid 不是动态号，只能用她标的动态号，标明「没核对」
 */
function place(target, rpid = null) {
  const type = Number(target?.type ?? 1), oid = String(target?.oid ?? '')
  const bv = BV_RE.test(String(target?.bvid ?? '')) ? String(target.bvid) : null
  const dyn = NUM_RE.test(String(target?.dyn ?? '')) ? String(target.dyn) : null
  const anchor = rpid && NUM_RE.test(String(rpid)) ? `#reply${rpid}` : ''
  if (type === 1 && NUM_RE.test(oid)) {
    const ok = bv && bvMatches(bv, 1, oid)
    return { link: `https://www.bilibili.com/video/av${oid}/${anchor}`, where: ok ? bv : `av${oid}`, warn: bv && !ok ? `她标的 ${bv} 和真正发到的视频对不上` : null }
  }
  if (type === 17 && NUM_RE.test(oid)) return { link: `https://t.bilibili.com/${oid}${anchor}`, where: `动态 ${oid}`, warn: null }
  if (dyn) return { link: `https://t.bilibili.com/${dyn}${anchor}`, where: `动态 ${dyn}（她标的，没核对）`, warn: null, unverified: true }
  return { link: null, where: `${TYPE_NAME[type] ?? 'type ' + type} oid=${clean(oid, 24)}`, warn: null }
}
/**
 * 不是评论区的交流记录：模块登记的私密 channel（privateChannels）、别的私密来回 —— 没有评论区的位置，不能当成「她回（视频评论区 oid=）」列出来，
 * 也别挤掉真的评论回复（2026-10-25 审查）。旧记录没有 channel / visibility：算评论区的
 */
const PRIVATE_CHANNELS = new Set([...RESERVED_PRIVATE_CHANNELS, ...HOOKS.flatMap((m) => m.privateChannels ?? [])])
const privateExchange = (e) => PRIVATE_CHANNELS.has(e?.channel) || e?.visibility === 'private'
/** 观众记忆里工具记下的交流（她回了谁、回复编号、真正发到的地方）：给评论配上能点的链接 */
function memoryExchanges(now) {
  const out = []
  let files = []
  try { files = fs.readdirSync(MEMORY_DIR).filter((x) => /^\d{1,20}\.json$/.test(x)) } catch { return out }
  for (const file of files) {
    const doc = readJsonFile(path.join(MEMORY_DIR, file)).value
    for (const e of Array.isArray(doc?.entries) ? doc.entries : []) {
      if (e.kind !== 'exchange' || e.by !== 'tool' || privateExchange(e) || now - Date.parse(e.at) > 3 * DAY_MS) continue
      out.push({ at: e.at, uid: String(doc.uid ?? file.slice(0, -5)), name: doc.names?.at?.(-1)?.name ?? '', rpid: NUM_RE.test(String(e.herMsgId ?? '')) ? String(e.herMsgId) : null, target: e.target ?? {}, her: ws(e.her) })
    }
  }
  return out
}
function sendsToday(now) {
  const today = localDay(now)
  const q = readJsonFile(QUOTA_FILE)
  const out = { items: [], corrupt: Boolean(q.corrupt) }
  const ex = safely(() => memoryExchanges(now))
  const exchanges = Array.isArray(ex) ? ex : []
  const used = new Set()
  for (const e of Array.isArray(q.value?.log) ? q.value.log : []) {
    // 模块登记的种类（PRIVATE_SEND_TYPES）不是公开发到 B站 上的：列在模块自己那一栏，这里不再列一遍 ——
    // 小窗的「发出」也数这张表，混进来就被当成公开发言（2026-10-26）
    if (PRIVATE_SEND_TYPES.has(e?.type)) continue
    const age = now - Date.parse(e.at)
    const status = e.uncertain ? 'uncertain' : e.pending ? (age > UNCERTAIN_AFTER_MS ? 'uncertain' : 'running') : 'success'
    // 今天的全列；没了结的（进行中 / 不确定）往前看两天 —— 不能一过半夜就从面板上消失
    if (localDay(e.at) !== today && !(status !== 'success' && age < 2 * DAY_MS)) continue
    const target = String(e.target ?? '')
    let link = null, where = clean(target, 60), warn = null
    const bv = /^BV:(BV[0-9A-Za-z]{10})$/.exec(target)?.[1]
    if (bv) {
      link = bvLink(bv)
      // 分享（@主人）发之前核对过 BV 就是评论发到的视频；别的评论的 BV 只是她标的
      if (e.type === 'comment' && !e.share) where = `${bv}（她标的视频，没核对）`
    } else if (/^dyn:\d{1,20}$/.test(target)) link = `https://t.bilibili.com/${target.slice(4)}`
    else if (/^room:\d{1,20}$/.test(target)) link = `https://live.bilibili.com/${target.slice(5)}`
    const row = { at: e.at, type: e.type, typeLabel: TYPE_LABEL[e.type] ?? clean(e.type, 20), status, auto: Boolean(e.auto), share: Boolean(e.share), where, link, replyTo: null, warn,
      _target: target, _note: e.note, _t0: Date.parse(e.committedAt ?? e.at),
      note: clean(e.note, 60), why: status === 'uncertain' ? '发出去了但没收到明确结果（可能其实发成了）：去 B站 上看一眼' : status === 'running' ? '正在发（10 分钟后还在这里就算结果不确定）' : null }
    out.items.push(row)
  }
  // 回复：在观众记忆里找同一条 —— 她回的话对得上、同一个地方、记忆在发出之后 5 分钟内记下；所有能配的按时间差从小到大一对一配
  const pairs = []
  for (const r of out.items) {
    if (r.type !== 'comment' || r.status !== 'success') continue
    const bv = /^BV:(BV[0-9A-Za-z]{10})$/.exec(r._target)?.[1], oid = /^oid:(\d+)$/.exec(r._target)?.[1]
    const note = ws(r._note).replace(/…$/, '').slice(0, 20)
    if (!note) continue
    for (const x of exchanges) {
      const d = Date.parse(x.at) - r._t0
      if (d < -5000 || d > 5 * 60_000 || !x.her.startsWith(note)) continue
      if ((bv && x.target?.bvid === bv) || (oid && String(x.target?.oid) === oid) || (!bv && !oid)) pairs.push({ r, x, d: Math.abs(d) })
    }
  }
  pairs.sort((a, b) => a.d - b.d)
  for (const { r, x } of pairs) {
    if (r.replyTo || used.has(x)) continue
    used.add(x)
    const p = place(x.target, x.rpid)
    Object.assign(r, { link: p.link, where: p.where, warn: p.warn, replyTo: x.name ? clean(x.name, 30) : `UID ${x.uid}` })
  }
  for (const r of out.items) { delete r._target; delete r._note; delete r._t0 }
  out.items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  // 给主人的私信（含自动报备）：只有一个数
  const dq = readJsonFile(path.join(AI_DIR, 'dm-quota.json')).value
  out.dmToOwner = dq?.date === today ? Number(dq.count ?? 0) : 0
  return out
}

// ─────────────── 今天看过的（只认工具留下的文件） ───────────────
function viewsToday(now) {
  const today = localDay(now)
  const byBv = new Map()
  const add = (bv, what, at, extra = {}) => {
    if (!BV_RE.test(bv)) return
    const v = byBv.get(bv) ?? { bv, link: bvLink(bv), evidence: [], at: null, title: null }
    if (!v.evidence.includes(what)) v.evidence.push(what)
    if (!v.at || at > v.at) v.at = at
    Object.assign(v, Object.fromEntries(Object.entries(extra).filter(([, x]) => x)))
    byBv.set(bv, v)
  }
  const statToday = (f) => { try { const t = fs.statSync(f).mtime; return localDay(t) === today ? t.toISOString() : null } catch { return null } }
  try { for (const f of fs.readdirSync(path.join(SHOTS_DIR, 'covers'))) { const m = /^(BV[0-9A-Za-z]{10})\.jpg$/.exec(f); if (m) { const at = statToday(path.join(SHOTS_DIR, 'covers', f)); if (at) add(m[1], '封面 / 简介', at) } } } catch {}
  try {
    for (const f of fs.readdirSync(SUBS_DIR)) {
      const m = /^(BV[0-9A-Za-z]{10})-.+\.txt$/.exec(f)
      if (!m || f.endsWith('-plain.txt') || f.endsWith('-debrief.txt')) continue
      const at = statToday(path.join(SUBS_DIR, f))
      if (!at) continue
      let title = null
      try { title = clean(fs.readFileSync(path.join(SUBS_DIR, f), 'utf8').split(/\r?\n/)[0], 80) } catch {}
      add(m[1], '字幕', at, { title })
    }
  } catch {}
  try {
    for (const f of fs.readdirSync(path.join(SHOTS_DIR, 'video'))) {
      const m = /^(BV[0-9A-Za-z]{10})-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-\d+x\d+\.jpg$/.exec(f)
      if (!m) continue
      const at = `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`
      if (localDay(at) === today) add(m[1], '抽帧看画面', at)
    }
  } catch {}
  const fav = readJsonFile(path.join(AI_DIR, 'favorites.json'))
  for (const it of Array.isArray(fav.value?.items) ? fav.value.items : []) {
    if (localDay(it.at) !== today) continue
    add(String(it.bv), it.pending ? '收藏（结果不确定）' : '收藏', it.at, { title: it.title ? clean(it.title, 80) : null })
  }
  // 看片记录（tools/lib/watchlog.mjs）：工具取素材时记的 → 看的范围（按记下的素材算）；她记的理解是她写的，只当「她说的」
  // 「今天看过」= 今天真的取到了东西（只失败了的那次不算）；读不出来的记录按文件修改时间算
  const watches = safely(() => recentWatches(now - DAY_MS))
  for (const r of Array.isArray(watches) ? watches : []) {
    if (!r?.bvid || !r.lastOkAt || localDay(r.lastOkAt) !== today) continue
    if (r.corrupt) { add(r.bvid, '看片记录（读不出来）', r.lastOkAt); continue }
    add(r.bvid, '看片记录', r.lastOkAt, { title: r.title ? clean(r.title, 80) : null })
    const v = byBv.get(r.bvid)
    if (!v) continue
    v.scope = clean(scopeOf(r).label, 80)
    const last = Array.isArray(r.notes) ? r.notes.at(-1) : null
    if (last?.text) { v.note = clean(last.text, 300); v.noteScope = clean(last.label, 80) }
  }
  return { items: [...byBv.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))), favCorrupt: Boolean(fav.corrupt) }
}

// ─────────────── 视频（审片 / 投稿） ───────────────
function videosState(now) {
  const out = { items: [], corrupt: false }
  const pv = readJsonFile(PENDING_VIDEOS)
  out.corrupt = Boolean(pv.corrupt)
  const pending = safely(() => listVideos())
  const pendingList = Array.isArray(pending) ? pending : []
  const recs = safely(() => reviewRecords())
  const ids = new Set([...pendingList.map((x) => x.id), ...(Array.isArray(recs) ? recs.map((r) => r.id) : [])])
  for (const id of ids) {
    const p = pendingList.find((x) => x.id === id)
    const r = Array.isArray(recs) ? recs.find((x) => x.id === id) : null
    const item = { id: clean(id, 80), title: clean(p?.title ?? r?.submitted?.title ?? '', 100), at: p?.at ?? r?.submitted?.at ?? null, notes: [] }
    try {
      const pub = publishedRecord(id)
      if (pub) {
        Object.assign(item, { status: 'success', label: pub.existing ? '已在 B站 上（核对 / 主人认领）' : '已投稿', at: pub.at, bvid: BV_RE.test(String(pub.bvid ?? '')) ? pub.bvid : null })
        item.link = bvLink(item.bvid)
        if (!item.bvid) item.notes.push('投稿成功但没拿到 BV 号：去创作中心看一眼')
        if (Array.isArray(pub.duplicates) && pub.duplicates.length) item.notes.push(`B站 上可能多了 ${pub.duplicates.length} 份：去创作中心删掉多的`)
        const att = readAttempts(id)
        if (att.unresolved.length) item.notes.push(`还有 ${att.unresolved.length} 次结果不确定的上传没了结`)
        out.items.push(item); continue
      }
      const lock = readUploadLock(id)
      if (lock) {
        if (!lock.unreadable && uploadLockLive(lock)) Object.assign(item, { status: 'running', label: '正在投稿（含投稿前去 B站 核对）' })
        else Object.assign(item, { status: 'uncertain', label: '上次投稿半路断了，结果不确定', cmd: `node host/cli.mjs videos approve ${id} --retry` })
        out.items.push(item); continue
      }
      const att = readAttempts(id)
      const attNotes = att.unresolved.slice(-2).map((a) => `${localTime(a.at)}：${clean(redact(a.error), 120)}`)
      if (p) {
        // 还在等审：照样给审片快照和命令；以前有结果不确定的上传就附上提醒（批准时会先去 B站 核对，不会重复投）
        Object.assign(item, { status: 'triggered', label: '等你审', cmd: `node host/cli.mjs videos play ${id}`, snapshot: videoFile(id) })
        if (att.unresolved.length) item.notes.push(`以前有 ${att.unresolved.length} 次上传结果不确定（批准时会先去 B站 核对）`, ...attNotes)
        out.items.push(item); continue
      }
      if (att.unresolved.length) {
        Object.assign(item, { status: 'uncertain', label: '投稿结果不确定（B站 可能收到了）', cmd: `node host/cli.mjs videos resolve ${id} none|<BV号>` })
        item.notes.push(...attNotes)
        out.items.push(item); continue
      }
      if (r?.submitted?.rejectedAt) { Object.assign(item, { status: 'rejected', label: '你退回了', at: r.submitted.rejectedAt }); if (now - Date.parse(item.at) < 14 * DAY_MS) out.items.push(item); continue }
      Object.assign(item, { status: 'unknown', label: '有记录、但看不出结果' })
      if (now - Date.parse(item.at ?? 0) < 14 * DAY_MS) out.items.push(item)
    } catch (e) {
      Object.assign(item, { status: 'unknown', label: '记录读不出来：' + clean(e?.message ?? e, 120) })
      out.items.push(item)
    }
  }
  // 排序：等你审 / 不确定 / 进行中在前，其余按时间
  const rank = { triggered: 0, uncertain: 1, running: 2, unknown: 3 }
  out.items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.at ?? '').localeCompare(String(a.at ?? '')))
  return out
}

// ─────────────── 待审回复草稿 ───────────────
function draftsState() {
  const f = readJsonFile(PENDING_FILE)
  const items = (Array.isArray(f.value?.items) ? f.value.items : listPending()).map((d) => {
    const p = place({ type: d.type, oid: d.oid, bvid: d.bvid })
    return {
      id: clean(d.id, 20), at: d.at, verified: Boolean(d.real),
      who: d.real?.name ? clean(d.real.name, 30) : clean(d.who, 30) + '（她写的名字，没核实）',
      their: d.real ? clean(d.real.text, 120) : clean(d.src, 120), theirLabel: d.real ? 'TA 说' : '她转述 TA 说的（没核实）',
      message: clean(d.message, 200), link: p.link, where: p.where, warn: p.warn,
    }
  })
  return { items, corrupt: Boolean(f.corrupt), cmd: 'node host/cli.mjs pending' }
}

// ─────────────── 最近的错误（24 小时内）和还没了结的 ───────────────
const ERROR_MARK = /✗|⚠️|失败|异常|出错|没处理成|跑太久|未捕获|未处理|找不到|没起来|读不了|坏了|没写成|没取到|半路断了|重载失败/
const VIEWER_TEXT_LINE = /^\[bili-whale\] (监听命中|直播间)/       // 这几行里带着观众的昵称 / 弹幕，不拿来判断是不是错误
function errorsState(now, s) {
  const recent = (at) => now - Date.parse(at) < DAY_MS
  // 日志里的错误：同样的（去掉数字之后一样）合成一行，记次数和最近一次
  const grouped = new Map()
  const addLog = (at, from, text) => {
    const key = from + '|' + text.replace(/\d+/g, '#').slice(0, 120)
    const g = grouped.get(key)
    if (!g) grouped.set(key, { at, from, text, count: 1, firstAt: at })
    else { g.count += 1; if (at > g.at) { g.at = at; g.text = text } if (at < g.firstAt) g.firstAt = at }
  }
  for (const e of logEntries(tailText(path.join(HOST_DIR, 'daemon.log')))) if (recent(e.at) && !VIEWER_TEXT_LINE.test(e.text) && ERROR_MARK.test(e.text)) addLog(e.at, '宿主日志', clean(redact(e.text), 400))
  for (const e of logEntries(tailText(path.join(AI_DIR, 'dm-tick-err.log'), 64 * 1024))) if (recent(e.at)) addLog(e.at, '收主人私信', clean(redact(e.text), 300))
  // 模块自己的出错日志单独标（不混进「收主人私信」）
  for (const p of PANELS) for (const g of p.errorLogs ?? []) for (const e of logEntries(tailText(g.file, 64 * 1024))) if (recent(e.at)) addLog(e.at, g.from, clean(redact(e.text), 300))
  const logs = [...grouped.values()].map((g) => (g.count > 1 ? { ...g, text: `${g.text}\n（24 小时内 ${g.count} 次，最早 ${localTime(g.firstAt)}）` } : g))
  // 要你处理的：一条不丢
  const important = []
  for (const t of s.turns?.recentFails ?? []) important.push({ at: t.at, from: '回合失败', text: `${t.kindLabel}（${clean(t.id, 60)}）：${t.why ?? ''}` })
  for (const x of s.sends?.items ?? []) if (x.status === 'uncertain') important.push({ at: x.at, from: '发出去的结果不确定', text: `${x.typeLabel} ${x.where}：${x.why}` })
  for (const v of s.videos?.items ?? []) if (v.status === 'uncertain') important.push({ at: v.at, from: '投稿结果不确定', text: `${v.title || v.id}：${v.label}` })
  for (const t of s.turns?.items ?? []) if (t.status === 'uncertain') important.push({ at: t.at, from: '回合半路断了', text: `${t.kindLabel}（${clean(t.id, 60)}）：${t.note}` })
  // 模块那几块里要你处理的（结果说不准的、要你知道的事）
  for (const p of PANELS) if (p.important) important.push(...p.important(s[p.key], { recent }, H))
  const byTime = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))
  const out = [...important, ...logs.sort(byTime).slice(0, 30)].sort(byTime)
  // 不带时间的状态问题（放最前面）
  const flags = []
  const ban = safely(() => apiState())
  if (ban?.banned) flags.push(`B站 风控熔断中：还有约 ${ban.banMinutesLeft} 分钟（${clean(ban.banWhy, 80)}）—— 这期间所有发言都会被拦下`)
  if (s.sends?.corrupt) flags.push('额度账本 quota.json 读不出来：她现在所有发言都会被拒绝，请看一下这个文件')
  if (s.videos?.corrupt) flags.push('待审视频队列 pending-videos.json 读不出来')
  if (s.drafts?.corrupt) flags.push('待审回复 pending-replies.json 读不出来')
  if (s.turns?.queueCorrupt) flags.push('宿主的回合队列 queue.json 读不出来')
  if (s.memory?.corrupt) flags.push(`有 ${s.memory.corrupt} 个观众记忆文件读不出来（记忆功能会跳过这些人）`)
  for (const p of PANELS) if (p.flags) flags.push(...p.flags(s[p.key], H))
  const cfg = readJsonFile(CFG_FILE)
  if (cfg.corrupt) flags.push('配置文件读不出来：宿主和工具现在用的是默认设置')
  if (s.host?.scheduler && !s.host.scheduler.ok) flags.push('生物钟没起来：' + s.host.scheduler.reason)
  if (s.host?.state === 'online' && !s.host.claudeFound) flags.push('宿主找不到 claude：到点叫不醒她')
  const l = s.login
  if (l?.state === 'invalid') flags.push(`她的 B站 登录失效了（${l.why ?? '?'}；${localTime(l.since)} 起）：她现在看不了、也发不了东西。${RELOGIN}`)
  if (l?.state === 'missing') flags.push(`还没登录她那个 B站 号。${RELOGIN}（或者 node host/cli.mjs cookie 手动粘贴）`)
  if (l?.state === 'ok' && l.problem === 'owner') flags.push(`存着的 B站 登录是你自己的号（UID ${l.mid}）：她会用你的号说话。${RELOGIN}，扫她的号`)
  if (l?.state === 'ok' && l.problem === 'mismatch') flags.push(`存着的 B站 登录是 ${l.name || '?'}（UID ${l.mid}），和配置里她的号（UID ${l.expected}）不一样 —— 换号了？没打算换的话 ${RELOGIN}`)
  let startup = null
  if (s.host?.state && s.host.state !== 'online') {
    const t = tailText(path.join(HOST_DIR, 'daemon.out'), 4096).split(/\r?\n/).filter((l) => l.trim()).slice(-6)
    if (t.length) startup = t.map((l) => clean(redact(l), 200))
  }
  return { flags, items: out, startup }
}

// ─────────────── 用量 ───────────────
// 回合行里的 costUsd 已经是每一轮花的（turncost.mjs 按同一会话的累计相减）：直接加 = 今天花的；以前加的是累计，同一会话的早回合被算了好几遍
function usageState(now, turns) {
  const done = (turns?.items ?? []).filter((t) => t.status === 'success' || t.status === 'fail')
  const known = done.filter((t) => typeof t.costUsd === 'number')
  const unknown = (turns?.items ?? []).filter((t) => (t.status === 'success' || t.status === 'fail') ? typeof t.costUsd !== 'number' : t.status === 'unknown').length
  const images = []
  try {
    for (const f of fs.readdirSync(IMAGE_LEDGERS)) {
      if (!/^[0-9A-Za-z_-]{3,80}\.json$/.test(f)) continue
      const j = readJsonFile(path.join(IMAGE_LEDGERS, f)).value
      if (j && typeof j.used === 'number') images.push({ id: f.slice(0, -5), used: j.used, limit: j.limit ?? null })
    }
  } catch {}
  return {
    turns: done.length, ok: done.filter((t) => t.status === 'success').length, fail: done.filter((t) => t.status === 'fail').length,
    costUsd: known.length ? Math.round(known.reduce((n, t) => n + t.costUsd, 0) * 10000) / 10000 : null, costKnown: known.length, costUnknown: unknown,
    images: images.slice(-10),
  }
}

// ─────────────── 观众记忆 ───────────────
function memoryState(now) {
  let files = []
  try { files = fs.readdirSync(MEMORY_DIR).filter((f) => /^\d{1,20}\.json$/.test(f)) } catch { return { viewers: 0, corrupt: 0, recent: [], notes: [] } }
  let corrupt = 0
  const recent = [], notes = []
  for (const f of files) {
    const r = readJsonFile(path.join(MEMORY_DIR, f))
    if (r.corrupt || !Array.isArray(r.value?.entries)) { corrupt += 1; continue }
    const uid = f.slice(0, -5)
    const name = clean(r.value.names?.at?.(-1)?.name ?? '', 30)
    for (const e of r.value.entries) {
      if (e.status === 'deleted' || e.status === 'superseded') continue
      // 「最近一天她回过的」只列评论区的回复：私密的来回不算（没有评论区的位置可链）
      if (e.kind === 'exchange' && !privateExchange(e) && now - Date.parse(e.at) < DAY_MS) { const p = place(e.target, e.herMsgId); recent.push({ at: e.at, uid, name, their: clean(e.text, 100), her: clean(e.her, 100), link: p.link, where: p.where, warn: p.warn }) }
      if (['preference', 'guess', 'todo'].includes(e.kind) && e.status !== 'done') notes.push({ at: e.at, uid, name, kind: e.kind, text: clean(e.text, 120), private: e.visibility === 'private', by: e.by })
    }
  }
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  notes.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return { viewers: files.length, corrupt, recent: recent.slice(0, 20), notes: notes.slice(0, 20) }
}

// ─────────────── 日记（她写的，只当「她说的」） ───────────────
function diaryState() {
  const read = (f, lines) => {
    if (!fs.existsSync(f)) return null
    const t = tailText(f, 64 * 1024)
    return clean(t.replace(/^\uFEFF/, ''), 200_000, true).split('\n').slice(-lines).map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l)).join('\n')
  }
  return { letter: read(diaryPath, 60), private: read(privateDiaryPath, 40) }
}

// ─────────────── 她给明天的信（她写的，只当「她说的」；宿主收着，醒来时最近两封附在提示里，见 tools/lib/letters.mjs） ───────────────
// 开关关着、也一封都没有：不显示这一栏（show: false）
function lettersState(now, cfg) {
  const r = readLetters({ cfg })
  const on = lettersEnabled(cfg)
  const next = new Set(on ? latestLetters({ now, cfg }).map((x) => x.id) : [])
  const items = r.letters.slice(-5).reverse().map((x) => ({ id: x.id, at: x.at, kindLabel: OWNER_KIND_LABEL[x.kind] ?? '', text: clean(x.text, 400),
    hidden: r.hidden.has(x.id), reason: clean(r.hidden.get(x.id)?.reason ?? '', 80), next: next.has(x.id) }))
  return { enabled: on, items, total: r.letters.length, corrupt: r.corrupt, broken: r.broken ? clean(r.broken, 60) : null, show: on || r.letters.length > 0 || r.corrupt > 0 || Boolean(r.broken) }
}

// ─────────────── 她读了什么（读书方案 A 版，2026-10-28；见 tools/lib/webstate.mjs） ───────────────
// 题目、笔记是她写的，网页标题是网页上的：一律 clean / esc。开关关着、也什么都没有：不显示这一栏
const WEB_STATUS = { pending: '等你批', approved: '批了', queued: '排着', started: '正在读', done: '读完了', rejected: '没批', dropped: '停下 / 没读成', expired: '作废了' }
function webState(now, cfg) {
  const o = webOpts(cfg)
  const reqs = listRequests().slice(-5).reverse().map((r) => ({ id: clean(r.id, 30), at: r.at, by: r.by === 'owner' ? '你加的' : '她写的', status: WEB_STATUS[r.status] ?? '?',
    topic: clean(r.topic, 60), start: (Array.isArray(r.start) ? r.start : []).slice(0, 3).map((u) => clean(u, 160)),
    used: r.used ? `打开 ${Number(r.used.pages) || 0} 页 · 搜索 ${Number(r.used.searches) || 0} 次 · 笔记 ${Number(r.used.notes) || 0} 条` : '' }))
  const { notes, hidden, delivered, okd } = readNotes()
  const items = notes.slice(-5).reverse().map((x) => ({ id: clean(x.id, 30), at: x.at, topic: clean(x.topic, 60), title: clean(x.title, 40), text: clean(x.text, 900),
    sources: clean(x.sources.join('、'), 200), state: hidden.has(x.id) ? 'hidden' : delivered.has(x.id) ? 'delivered' : o.reviewNotes && !okd.has(x.id) ? 'review' : 'waiting' }))
  const day = localDay(now)
  const visits = readVisits({ n: 300 }).filter((v) => localDay(Date.parse(v.at)) === day)
  return { enabled: o.enabled, approve: o.approve, reqs, items, total: notes.length, today: { opened: visits.filter((v) => v.kind !== 'search' && v.ok).length, searched: visits.filter((v) => v.kind === 'search').length,
    hosts: clean([...new Set(visits.filter((v) => v.ok).map((v) => String(v.host ?? '')))].slice(0, 8).join('、'), 200) },
    show: o.enabled || reqs.length > 0 || notes.length > 0 }
}

/**
 * 面板上的全部数据（每一块单独兜错：一块读坏了不影响别的块）。
 * light：不起 PowerShell 查进程（liveTurn / isOurTurn / sessionProcs，一次要一两秒）—— 小窗每 30 秒拿一次「今天」用
 */
export function collect({ now = Date.now(), light = false } = {}) {
  const cfg = safely(() => readConfig())
  const s = { at: new Date(now).toISOString(), today: localDay(now), paths: { dataDir: DSH_HOME, ownerDir: AI_DIR } }
  s.name = personaName(cfg?.error ? {} : cfg)   // 标题上的名字（persona.name；没起名字 = bili-whale）
  s.host = safely(() => hostState(now))
  s.turns = safely(() => turnsState(now, s.host, cfg?.error ? {} : cfg, Boolean(light)))
  s.plan = safely(() => planState(now))
  s.sends = safely(() => sendsToday(now))
  s.views = safely(() => viewsToday(now))
  s.videos = safely(() => videosState(now))
  s.drafts = safely(() => draftsState())
  s.memory = safely(() => memoryState(now))
  s.usage = safely(() => usageState(now, s.turns))
  s.login = safely(() => loginState(now, cfg?.error ? {} : cfg))
  for (const p of PANELS) s[p.key] = safely(() => p.collect(now, cfg?.error ? {} : cfg, H))   // 模块的几块（没装的模块没有）
  s.errors = safely(() => errorsState(now, s))
  s.diary = safely(() => diaryState())
  s.letters = safely(() => lettersState(now, cfg?.error ? {} : cfg))
  s.web = safely(() => webState(now, cfg?.error ? {} : cfg))
  return s
}

// ─────────────── 页面 ───────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const STATUS = { triggered: ['已触发', 'st-trig'], running: ['进行中', 'st-run'], success: ['成功', 'st-ok'], fail: ['失败', 'st-fail'], uncertain: ['不确定', 'st-unc'], unknown: ['不知道', 'st-unk'], rejected: ['退回', 'st-unk'] }
const chip = (st, label) => { const [t, c] = STATUS[st] ?? [st, 'st-unk']; return `<span class="chip ${c}">${esc(label ?? t)}</span>` }
const a = (href, text) => (href && /^https:\/\/(www\.bilibili\.com|t\.bilibili\.com|live\.bilibili\.com|space\.bilibili\.com)\//.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(text)}</a>` : esc(text))
const when = (t) => (t ? `<time>${esc(localTime(t))}</time>` : '')
const errBox = (x) => (x?.error ? `<p class="err">这一块读不出来：${esc(x.error)}</p>` : '')
const empty = (t) => `<p class="empty">${esc(t)}</p>`

export function render(s) {
  const h = s.host ?? {}
  const name = typeof s.name === 'string' && s.name ? s.name : 'bili-whale'   // 老快照里没有：用不带名字的
  const hostChip = h.state === 'online' ? chip('success', '在线') : h.state === 'unresponsive' ? chip('uncertain', h.label) : chip('fail', h.label ?? '离线')
  const sec = (title, body, note = '') => `<section><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}</section>`
  const rows = (list, cols) => `<div class="tbl"><table><tbody>${list.map((r) => `<tr>${cols.map((c) => `<td>${c(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`

  const turns = s.turns?.items ?? []
  const sends = s.sends?.items ?? []
  const views = s.views?.items ?? []
  const vids = s.videos?.items ?? []
  const drafts = s.drafts?.items ?? []
  const errs = s.errors ?? {}
  const u = s.usage ?? {}
  const mem = s.memory ?? {}
  const sendsToday = sends.filter((x) => localDay(x.at) === s.today)
  const olderOpen = sends.filter((x) => localDay(x.at) !== s.today && x.status !== 'success').length
  const waiting = vids.filter((v) => v.status === 'triggered' || v.status === 'uncertain').length + drafts.length
  // 模块的几块（老快照里没有这一块、关着又从来没有过的：fact / html 自己说不显示）。别人写的字一律 esc（传过去的就是这里的 esc、a、rows…）
  const hh = { ...H, esc, chip, a, when, errBox, empty, sec, rows }
  const panelFacts = PANELS.map((p) => { const f = p.fact?.(s[p.key], hh); return f ? `<span${f.bad ? ' class="err"' : ''}>${esc(f.text)}</span>` : '' }).join('')
  const sendsNotes = PANELS.map((p) => p.sendsNote?.(s[p.key], hh) ?? '').join('')
  const afterSends = PANELS.filter((p) => p.slot === 'afterSends' && typeof p.html === 'function').map((p) => p.html(s[p.key], hh)).join('')
  // 她给明天的信（老快照里没有这一块、开关关着又一封都没有：不显示）。她写的字一律 esc
  const lt = s.letters ?? {}
  const lettersBody = () => `<p>开关：${lt.enabled ? '开着（下次醒来附上最近两封：7 天以内、没收起的）' : '关着（默认）—— 打开：<code>node host/cli.mjs config set letters.enabled true</code>（这一版第一次打开要重启一次宿主）'}${lt.total > lt.items?.length ? ` · 一共 ${esc(lt.total)} 封，这里列最近 ${esc(lt.items.length)} 封` : ''}</p>`
    + (lt.broken ? `<p class="err">信箱读不出来（${esc(lt.broken)}）：~/.bili-ai/letters.jsonl</p>` : '')
    + (lt.corrupt ? `<p class="st-unc">有 ${esc(lt.corrupt)} 行读不出来 / 没通过检查：不附上、不列</p>` : '')
    + (lt.items?.length ? rows(lt.items, [(r) => when(r.at), (r) => (r.hidden ? chip('unknown', '已收起') : r.next ? chip('success', '下次醒来会附上') : ''),
      (r) => `<span class="k"><code>${esc(r.id)}</code></span><div class="hers">${esc(r.kindLabel)}</div>`, (r) => `${esc(r.text)}${r.hidden && r.reason ? `<div class="hers">收起的理由：${esc(r.reason)}</div>` : ''}`]) : empty('还没有'))
  const lettersHtml = s.letters && (s.letters.error || lt.show) ? sec('她给明天的信', errBox(s.letters) + (s.letters.error ? '' : lettersBody()),
    '她写给自己的便条，醒来时最近两封附在提示里；她改不了也删不掉；收起：node host/cli.mjs letters hide <id>') : ''
  // 她读了什么（老快照里没有这一块、开关关着又什么都没有：不显示）
  const wb = s.web ?? {}
  const webBody = () => `<p>开关：${wb.enabled ? `开着${wb.approve ? '（她的请求要你批：node host/cli.mjs web approve &lt;编号&gt;）' : '（她的请求不用批）'}` : '关着（默认）—— 打开：<code>node host/cli.mjs config set web.enabled true</code>'}`
    + ` · 今天打开 ${esc(wb.today?.opened ?? 0)} 页、搜索 ${esc(wb.today?.searched ?? 0)} 次${wb.today?.hosts ? `（${esc(wb.today.hosts)}）` : ''}</p>`
    + (wb.reqs?.length ? `<details open><summary>最近的读书请求</summary>${rows(wb.reqs, [(r) => when(r.at), (r) => chip(r.status === '等你批' ? 'unknown' : r.status === '读完了' ? 'success' : 'unknown', r.status),
      (r) => `<span class="k"><code>${esc(r.id)}</code></span><div class="hers">${esc(r.by)}${r.used ? ' · ' + esc(r.used) : ''}</div>`,
      (r) => `「${esc(r.topic)}」${r.start.map((u) => `<div class="hers">起点：${esc(u)}</div>`).join('')}`])}</details>` : '')
    + (wb.items?.length ? rows(wb.items, [(r) => when(r.at), (r) => (r.state === 'hidden' ? chip('unknown', '已收起') : r.state === 'review' ? chip('unknown', '等你看（web ok 放行）') : r.state === 'waiting' ? chip('success', '下次醒来会附上') : ''),
      (r) => `<span class="k"><code>${esc(r.id)}</code></span><div class="hers">想读：${esc(r.topic)}</div><div class="hers">读了：${esc(r.sources || '—')}</div>`,
      (r) => `${r.title ? `《${esc(r.title)}》<br>` : ''}${esc(r.text)}`]) : empty('还没有笔记'))
  const webHtml = s.web && (s.web.error || wb.show) ? sec('她读了什么', errBox(s.web) + (s.web.error ? '' : webBody()),
    '读书回合是宿主单独开的一轮：那一轮看不到日记、私信、你的事，也发不了东西；笔记是她的话，下次醒来附给她（标明是素材）。全文 / 收起：node host/cli.mjs web notes · web hide <编号>；停下一轮：web stop <请求编号>') : ''

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="20"><meta name="referrer" content="no-referrer"><title>${esc(name)} · 本地面板</title>
<style>
:root{--bg:#f7f7f5;--paper:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--ok:#1f7a3a;--fail:#b3261e;--unc:#9a6400;--run:#1f5fae;--trig:#5b5b8f}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--paper:#1e1e21;--ink:#ececec;--muted:#a0a0a6;--line:#333338;--ok:#5fd07d;--fail:#ff8a80;--unc:#f0b44c;--run:#7fb2ff;--trig:#b3b3ee}}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 48px;display:grid;gap:18px}
header{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:baseline}h1{font-size:20px;margin:0}
.facts{display:flex;flex-wrap:wrap;gap:8px}.facts span{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:3px 9px;font-size:13px}
section{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:14px 16px}h2{font-size:16px;margin:0 0 8px}
.note{color:var(--muted);font-size:12.5px;margin:0 0 8px}.empty{color:var(--muted);margin:0}.err{color:var(--fail)}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%}td{border-top:1px solid var(--line);padding:6px 8px;vertical-align:top;font-size:13.5px}
tr:first-child td{border-top:0}time{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.chip{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 8px;font-size:12px;white-space:nowrap}
.st-ok{color:var(--ok)}.st-fail{color:var(--fail)}.st-unc{color:var(--unc)}.st-run{color:var(--run)}.st-trig{color:var(--trig)}.st-unk{color:var(--muted)}
.hers{color:var(--muted);font-size:12.5px}.k{white-space:nowrap}code{font-size:12.5px;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 ui-monospace,Consolas,monospace;margin:6px 0 0;max-height:420px;overflow:auto}
.flags{border-left:3px solid var(--fail);padding-left:10px;margin:0 0 8px}a{color:var(--run)}details summary{cursor:pointer}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:18px}
.wrap>*,.grid2>*,section{min-width:0}td{overflow-wrap:anywhere}
</style></head><body><div class="wrap">
<header><h1>${esc(name)} · 本地面板</h1>${hostChip}<span class="note">${esc(localTime(s.at))} 更新 · 每 20 秒刷新 · 只读</span></header>
<div class="facts"><span>宿主：${esc(h.label ?? '?')}${h.heartbeat ? `（心跳 ${esc(h.heartbeatAgeSec)} 秒前）` : ''}</span>${h.paused ? `<span>你正在当面跟她聊（cli open），宿主在等</span>` : ''}<span>${esc(s.plan?.text ?? '')}</span><span>等你处理：${waiting} 件</span><span${['invalid', 'missing'].includes(s.login?.state) || s.login?.problem ? ' class="err"' : ''}>${esc(loginFact(s.login))}</span>${panelFacts}<span>今天发出去：${sendsToday.filter((x) => x.status === 'success').length} 条${sendsToday.some((x) => x.status === 'uncertain') ? `，<b class="st-unc">${sendsToday.filter((x) => x.status === 'uncertain').length} 条不确定</b>` : ''}${olderOpen ? `；前两天还有 <b class="st-unc">${olderOpen} 条</b>没了结` : ''}</span></div>
${errs.flags?.length || errs.items?.length || errs.startup ? sec('最近的错误（24 小时内）和还没了结的', `${errs.flags?.length ? `<div class="flags">${errs.flags.map((f) => `<p class="err">${esc(f)}</p>`).join('')}</div>` : ''}${errs.startup ? `<p class="note">宿主启动输出的最后几行：</p><pre>${esc(errs.startup.join('\n'))}</pre>` : ''}${errs.items?.length ? rows(errs.items, [(r) => when(r.at), (r) => `<span class="k">${esc(r.from)}</span>`, (r) => `<pre>${esc(r.text)}</pre>`]) : ''}`) : ''}
${sec('她的回合', errBox(s.turns) + (turns.length ? rows(turns, [(r) => when(r.at), (r) => chip(r.status), (r) => `<span class="k">${esc(r.kindLabel)}</span>`, (r) => `${esc(r.note ?? '')}${r.costUsd != null ? ` · $${esc(Math.round(r.costUsd * 10000) / 10000)}` : ''}${r.said ? `<div class="hers">她最后说的（没核实）：${esc(r.said)}</div>` : ''}${r.why ? `<div class="err">${esc(r.why)}</div>` : ''}`]) : empty('今天还没有回合')), '「成功」只说明这一回合跑完了；她说「我发了」不算数，发没发成看下面「今天发出去的」（来自代码记的账本）。')}
<div class="grid2">
${sec('等你审的视频 / 投稿', errBox(s.videos) + (vids.length ? rows(vids, [(r) => chip(r.status, r.label), (r) => `${a(r.link, r.title || r.id)}${r.bvid ? ` <code>${esc(r.bvid)}</code>` : ''}${r.notes?.length ? `<div class="hers">${r.notes.map(esc).join('<br>')}</div>` : ''}${r.cmd ? `<div><code>${esc(r.cmd)}</code></div>` : ''}${r.snapshot ? `<div class="hers">审片快照：<code>${esc(r.snapshot)}</code></div>` : ''}`, (r) => when(r.at)]) : empty('没有')), '批准 / 退回请用命令（会走和以前一样的批准流程、看同一份审片快照）：node host/cli.mjs videos')}
${sec('等你审的回复草稿', errBox(s.drafts) + (drafts.length ? rows(drafts, [(r) => when(r.at), (r) => `${esc(r.who)} · 发到 ${a(r.link, r.where)}${r.warn ? `<div class="st-unc">${esc(r.warn)}</div>` : ''}<div class="hers">${esc(r.theirLabel)}：${esc(r.their)}</div><div>她想回：${esc(r.message)}</div>`]) : empty('没有')), drafts.length ? '批准 / 否掉：node host/cli.mjs pending' : '')}
</div>
${sec('今天发出去的', errBox(s.sends) + (sends.length ? rows(sends, [(r) => when(r.at), (r) => chip(r.status), (r) => `<span class="k">${esc(r.typeLabel)}${r.share ? '（分享）' : ''}${r.auto ? '' : '（你授权的）'}</span>`, (r) => `${r.replyTo ? `回复 ${esc(r.replyTo)} · ` : ''}${a(r.link, r.where)}${r.warn ? `<div class="st-unc">${esc(r.warn)}</div>` : ''}<div class="hers">${esc(r.note)}</div>${r.why ? `<div class="st-unc">${esc(r.why)}</div>` : ''}`]) : empty('今天还没发过')) + `<p class="note">给你的私信（含自动报备）今天 ${esc(s.sends?.dmToOwner ?? 0)} 条。${sendsNotes}</p>`, '只认额度账本里落了账的：发成功才落账；「不确定」= 发出去了但没收到明确结果。')}
${afterSends}
${sec('今天看过的', errBox(s.views) + (views.length ? rows(views, [(r) => when(r.at), (r) => `${a(r.link, r.title || r.bv)} <code>${esc(r.bv)}</code>`, (r) => `${esc(r.evidence.join(' · '))}${r.scope ? `<div>看的范围：${esc(r.scope)}</div>` : ''}${r.note ? `<div class="hers">她记的理解（她写的，当时的范围：${esc(r.noteScope)}）：${esc(r.note)}</div>` : ''}`]) : empty('今天还没看过')), '来自她的工具留下的文件（封面、字幕、抽帧、收藏）和看片记录：说明她取过这些视频的内容。「看的范围」是工具按取到的素材算的；她记的理解是她写的。')}
<div class="grid2">
${sec('用量（今天）', errBox(s.usage) + `<p>回合 ${esc(u.turns ?? 0)} 个（成功 ${esc(u.ok ?? 0)}，失败 ${esc(u.fail ?? 0)}）</p><p>Claude 费用：${u.costUsd == null ? '不知道' : `$${esc(u.costUsd)}`}（有记录的 ${esc(u.costKnown ?? 0)} 个回合${u.costUnknown ? `；另有 ${esc(u.costUnknown)} 个回合没有费用记录，不当 0 算` : ''}）</p>${u.images?.length ? `<p>AI 出图（按视频累计）：${u.images.map((i) => `${esc(i.id)} ${esc(i.used)}${i.limit ? '/' + esc(i.limit) : ''}`).join('，')}</p>` : ''}`, '费用是 claude 自己报的（它报的是整个会话的累计，这里按回合相减）；用订阅登录时这是按 API 价格的估算，不是账单。')}
${sec('观众记忆', errBox(s.memory) + `<p>记得 ${esc(mem.viewers ?? 0)} 个人${mem.corrupt ? `，<span class="err">${esc(mem.corrupt)} 个读不出来</span>` : ''}。看某人：<code>node tools/bili.mjs memory show --uid &lt;UID&gt;</code>（改 / 删：<code>memory correct</code> / <code>memory forget</code> --uid … --id …）</p>${mem.recent?.length ? `<p class="note">最近一天她回过的：</p>` + rows(mem.recent, [(r) => when(r.at), (r) => `${a(`https://space.bilibili.com/${r.uid}/`, r.name || r.uid)}<div class="hers">TA：${esc(r.their)}</div><div>她回（${a(r.link, r.where)}）：${esc(r.her)}</div>${r.warn ? `<div class="st-unc">${esc(r.warn)}</div>` : ''}`]) : ''}${mem.notes?.length ? `<p class="note">记下的偏好 / 推测 / 答应过的事：</p>` + rows(mem.notes, [(r) => when(r.at), (r) => `${esc(r.name || r.uid)} · ${esc({ preference: '偏好', guess: '推测', todo: '待办' }[r.kind])}${r.private ? '（私密）' : ''}`, (r) => esc(r.text)]) : ''}`)}
</div>
${sec('她的日记', errBox(s.diary) + `<details open><summary>给你的信（最后 60 行）</summary><pre>${esc(s.diary?.letter ?? '（还没有）')}</pre></details><details><summary>她自己的日记（最后 40 行）</summary><pre>${esc(s.diary?.private ?? '（还没有）')}</pre></details>`, '她写的，不算数：日记里说「我发了」「看了」不代表真的做了，以上面的账本为准。')}
${lettersHtml}
${webHtml}
<p class="note">数据目录 <code>${esc(s.paths?.dataDir)}</code> · 主人目录 <code>${esc(s.paths?.ownerDir)}</code></p>
</div></body></html>`
}

// ─────────────── 门：一次性口令 → cookie（照 host/window.mjs；那边的不 import：window.mjs 自己 import 这个文件） ───────────────
export const DASH_INFO_FILE = path.join(HOST_DIR, 'dashboard.json')   // { pid, port, startedAt, code, codeExpiresAt[, mintFor] }：面板唯一会写的文件
/** cli 要新口令时放的条子（和 dashboard.json 同一个目录）：{ id }；面板看到就删掉 */
export const wantFileOf = (infoFile) => infoFile.replace(/\.json$/i, '') + '.want'
export const CODE_TTL = 10 * 60_000                                   // 口令最多活 10 分钟；一半时间换一个新的（再跑 cli 读到的那个总还有 5 分钟以上）
export const COOKIE = 'whale_dash'                                    // 和小窗的 whale_win 分开：cookie 不分端口，同一个浏览器里两个都会带上
export const SESSION_MAX_AGE = 12 * 3600_000                          // 换到的登录最多认 12 小时（页面每 20 秒刷新也不续）
export const SESSION_IDLE = 2 * 3600_000                              // 2 小时没用过（标签页关了、电脑睡了）就作废
const MAX_SESSIONS = 16                                               // 换到 cookie 的浏览器最多记几个（多了扔最早的）
const MAX_CODES = 8                                                   // 同时认的口令最多几个（平常 2–3 个：到点换的 + 再跑 cli 要的；多了扔最早的）
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/
const MINT_RE = /^[0-9a-f]{32}$/
const SID_RE = /^[A-Za-z0-9_-]{43}$/                                  // 32 字节随机数的 base64url
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()
/** 比口令 / 会话令牌：先各自哈希成一样长再 timingSafeEqual（长度不同也不提前返回） */
export const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b))
/** 新口令：16 字节随机数的十六进制（32 位，末尾总是字母或数字 —— Windows Terminal 点链接时末尾的「-」会被丢掉） */
const newCode = () => crypto.randomBytes(16).toString('hex')

/**
 * 一次性口令：每个最多活 ttl，没过期的都认（最多 MAX_CODES 个）；调用方每 ttl/2 rotate() 一次；用过一次马上作废、换新的。
 * rotate(mintFor)：cli 要的新口令带上那张条子的 id。onChange(当前那个)：换了就告诉调用方（写 dashboard.json）
 */
export function createCodes({ now = Date.now, ttl = CODE_TTL, onChange = () => {} } = {}) {
  let list = []
  const make = (mintFor = null) => { const t = now(); list = [{ code: newCode(), exp: t + ttl, mintFor }, ...list.filter((c) => c.exp > t)].slice(0, MAX_CODES); onChange(list[0]) }
  make()
  return {
    current: () => list[0],
    rotate: (mintFor) => make(typeof mintFor === 'string' ? mintFor : null),
    redeem(k) {
      if (typeof k !== 'string' || !CODE_RE.test(k)) return false
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
/** 换到 cookie 的会话令牌：只在内存里（面板重启后要再从 cli 拿链接）；换到后 maxAge 作废、idle 没用过也作废 */
export function createSessions({ max = MAX_SESSIONS, now = Date.now, maxAge = SESSION_MAX_AGE, idle = SESSION_IDLE } = {}) {
  let list = []   // { sid, born, seen }
  const prune = (t) => { list = list.filter((x) => t - x.born < maxAge && t - x.seen < idle) }
  // Cookie 头里所有叫 whale_dash 的（最多看 4 个）：格式不对的直接不认
  const sidsOf = (h) => [...String(h ?? '').matchAll(new RegExp(`(?:^|;)\\s*${COOKIE}=([^;]*)`, 'g'))].map((m) => m[1].trim()).filter((v) => SID_RE.test(v)).slice(0, 4)
  return {
    add() { const t = now(); prune(t); const sid = crypto.randomBytes(32).toString('base64url'); list.push({ sid, born: t, seen: t }); if (list.length > max) list.shift(); return sid },
    has(cookieHeader) {
      const t = now()
      prune(t)
      let hit = null
      for (const v of sidsOf(cookieHeader)) for (const x of list) if (safeEq(x.sid, v)) hit = x   // 每个都比一遍
      if (hit) hit.seen = t
      return Boolean(hit)
    },
  }
}
/** dashboard.json：先写临时文件再改名（cli 不会读到写了一半的）；POSIX 上只给自己读写（Windows 上数据目录本来只有主人能读） */
function writeInfo(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameRetry(tmp, file)
}
/** 探活：/health 返回 { ok, app: 'dashboard', startedAt } 才算是面板（端口上可能是别的程序）；不是 = null */
export function probeDashboard(port, timeout = 1500) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: `127.0.0.1:${port}` }, timeout }, (res) => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { if (b.length < 4096) b += d })
      res.on('end', () => { try { const j = JSON.parse(b); resolve(res.statusCode === 200 && j?.ok === true && j.app === 'dashboard' ? j : null) } catch { resolve(null) } })
    })
    r.on('timeout', () => r.destroy())
    r.on('error', () => resolve(null))
  })
}
/**
 * dashboard.json 记的那个面板还在跑：进程在、/health 应答而且 startedAt 对得上、进程的命令行是面板（查不了就照旧信，同 window.mjs 的 isViewerPid）
 * → 那份记录（cli 拿里面的口令拼一个新链接）；不然 null。面板被硬关掉时会留下这个文件：进程不在了就不认，里面的口令也早就没用了
 */
export async function liveDashboard({ file = DASH_INFO_FILE } = {}) {
  const j = readJsonFile(file).value
  if (!isObj(j) || !Number.isInteger(j.pid) || !Number.isInteger(j.port) || typeof j.code !== 'string' || !CODE_RE.test(j.code)) return null
  if (j.pid === process.pid || !pidAlive(j.pid)) return null
  const h = await probeDashboard(j.port)
  if (!h || h.startedAt !== j.startedAt) return null
  const c = cmdLineChecked(j.pid)
  return c == null || /dashboard/i.test(c) ? j : null
}
/**
 * 再跑一次 cli dashboard 时要一个新口令（不把上次打印过、可能已经给了别的浏览器的那个再给一遍）：
 * 在 dashboard.json 旁边放条子 { id }（先写临时文件再改名），等面板把 mintFor = id 的新口令写进 dashboard.json → 那份记录；
 * 等不到（旧版本的面板、面板正好关了）→ null，条子还是自己的就收回
 */
export async function requestCode(live, { file = DASH_INFO_FILE, timeout = 4000 } = {}) {
  const want = wantFileOf(file), id = crypto.randomBytes(16).toString('hex')
  try { writeInfo(want, { id }) } catch { return null }
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 50))
    const j = readJsonFile(file).value
    if (isObj(j) && j.pid === live?.pid && j.startedAt === live?.startedAt && j.mintFor === id && typeof j.code === 'string' && CODE_RE.test(j.code)) return j
  }
  try { if (readJsonFile(want).value?.id === id) fs.rmSync(want, { force: true }) } catch {}
  return null
}

// ─────────────── 服务 ───────────────
const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
}
// 没登录（没有 cookie、cookie 不对、面板重启过）：只给这一句固定的话，没有任何数据
export const LOCKED_TEXT = '这个面板要从命令行打开：在终端里跑 node host/cli.mjs dashboard，点它打印的链接（10 分钟内有效、只能用一次）。换了浏览器、链接过期了、登录过期了（12 小时，或 2 小时没打开）、面板重启过：再跑一次这条命令拿新链接（面板开着的话不会起第二个）。'
// 标题上的名字在起面板时读一次（persona.name；改了名字重开面板才换）；页面别的地方一个字都不变
const lockedHtml = (name) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(name)} · 本地面板</title>
<style>:root{--bg:#f7f7f5;--ink:#1d1d1f}@media (prefers-color-scheme:dark){:root{--bg:#151517;--ink:#ececec}}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}code{word-break:break-all}</style>
</head><body><main><h1>要从命令行打开</h1><p>在终端里跑 <code>node host/cli.mjs dashboard</code>，点它打印的链接（10 分钟内有效、只能用一次）。</p><p>换了浏览器、链接过期了、登录过期了（12 小时，或 2 小时没打开）、面板重启过：再跑一次这条命令拿新链接（面板开着的话不会起第二个）。</p></main></body></html>`

/**
 * 起面板：只监听 127.0.0.1；只认 Host 是 127.0.0.1 / localhost 的请求（挡住别的网页借 DNS 重绑定来读）；只读（只接受 GET / HEAD）；
 * 别的网页发来的（Sec-Fetch-Site 不是 same-origin / none、Origin 不是自己）不理；没有有效 cookie 的只拿到 401 那一句（见文件开头「门」）。
 * 返回 http.Server，另外带 link()（当前口令拼的链接：只给 cli 打印到主人的终端）和 stop()（删掉自己的 dashboard.json、关服务）。
 * codeTtl / infoFile / sessionMaxAge / sessionIdle 是给测试的
 */
export function startDashboard({ port = 8765, host = '127.0.0.1', cacheMs = 5000, codeTtl = CODE_TTL, infoFile = DASH_INFO_FILE, sessionMaxAge = SESSION_MAX_AGE, sessionIdle = SESSION_IDLE, log = () => {} } = {}) {
  let cache = null
  const snapshot = () => { if (!cache || Date.now() - cache.t > cacheMs) cache = { t: Date.now(), v: collect() }; return cache.v }
  const LOCKED_HTML = lockedHtml(personaName((() => { try { return readConfig() } catch { return {} } })()))
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const startedAt = new Date().toISOString()
  let listening = false, closed = false, warned = false
  // 只在真监听上以后写（端口被占用时不留文件）；写不成只说一句（不带口令；接着写不成不再说，写成过一次再说）
  const save = (c) => {
    if (!listening || closed || !c) return
    try { writeInfo(infoFile, { pid: process.pid, port, startedAt, code: c.code, codeExpiresAt: new Date(c.exp).toISOString(), ...(c.mintFor ? { mintFor: c.mintFor } : {}) }); warned = false } catch (e) {
      if (!warned) log('dashboard.json 没写成（面板开着时再跑 cli dashboard 拿不到新链接；要新链接就 Ctrl+C 再开）：' + clean(e?.code ?? e?.message ?? e, 120))
      warned = true
    }
  }
  const codes = createCodes({ ttl: codeTtl, onChange: save })
  const sessions = createSessions({ maxAge: sessionMaxAge, idle: sessionIdle })
  // cli 要新口令（requestCode）：看到条子就删掉、发一个带 mintFor 的新口令；id 不对的只删不发；读不出来的（正在写？）下一趟再看，放了 2 秒还读不出来就删
  const want = wantFileOf(infoFile)
  const checkWant = () => {
    if (!listening || closed || !fs.existsSync(want)) return
    const r = readJsonFile(want)
    if (r.corrupt) { if (Date.now() - fs.statSync(want).mtimeMs > 2000) fs.rmSync(want, { force: true }); return }
    fs.rmSync(want, { force: true })
    if (isObj(r.value) && typeof r.value.id === 'string' && MINT_RE.test(r.value.id)) codes.rotate(r.value.id)
  }
  const drop = () => { try { const j = readJsonFile(infoFile).value; if (j?.pid === process.pid && j.startedAt === startedAt) fs.rmSync(infoFile, { force: true }) } catch {} }
  const server = http.createServer((req, res) => {
    try { handle(req, res) } catch (e) { try { res.writeHead(500, SECURITY_HEADERS); res.end() } catch {} }
  })
  const handle = (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...SECURITY_HEADERS, ...extra }); res.end(req.method === 'HEAD' ? undefined : body) }
    const text = (code, msg, extra) => send(code, 'text/plain; charset=utf-8', msg, extra)
    if (!allowed.has(String(req.headers.host ?? '').toLowerCase())) return text(421, '只能从本机打开：http://127.0.0.1:' + port + '/')
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, '这个面板只读', { allow: 'GET, HEAD' })
    // 只认面板自己的页面（每 20 秒刷新：same-origin）和地址栏 / 终端里点开的（none）；别的网站、本机别的端口上的网页（对 cookie 来说算同站）来的一律不理
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site && site !== 'same-origin' && site !== 'none') return text(403, '不接别的网页发来的请求')
    if (req.headers.origin !== undefined && !origins.has(String(req.headers.origin).toLowerCase())) return text(403, '不接别的网页发来的请求')
    const raw = String(req.url ?? '/'), qi = raw.search(/[?#]/)
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw
    const query = qi >= 0 && raw[qi] === '?' ? raw.slice(qi + 1).split('#')[0] : ''
    if (pathname === '/health') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, app: 'dashboard', startedAt }))   // 给 cli 探活：不带任何数据
    if (pathname === '/') {
      let k = null
      try { k = new URLSearchParams(query).get('k') } catch {}
      if (k !== null) {
        // 口令换 cookie（HEAD 不兑换：预取 / 探测别把口令用掉）。换没换成都 303 回不带口令的 /：地址栏、历史记录、每 20 秒的刷新里都不留口令；
        // 没换成的话 / 给的就是 401 那一句（不说是口令不对、用过了还是过期了）
        if (req.method === 'GET' && codes.redeem(k)) return text(303, '', { location: '/', 'set-cookie': `${COOKIE}=${sessions.add()}; HttpOnly; SameSite=Strict; Path=/` })
        return text(303, '', { location: '/' })
      }
    }
    if (!sessions.has(req.headers.cookie)) {
      return pathname.startsWith('/api/') ? send(401, 'application/json; charset=utf-8', JSON.stringify({ error: 'locked', message: LOCKED_TEXT })) : send(401, 'text/html; charset=utf-8', LOCKED_HTML)
    }
    try {
      if (pathname === '/') return send(200, 'text/html; charset=utf-8', render(snapshot()))
      if (pathname === '/api/state') return send(200, 'application/json; charset=utf-8', JSON.stringify(snapshot()))
      return text(404, 'not found')
    } catch (e) {
      return text(500, '面板出错：' + clean(redact(e?.message ?? e), 300))
    }
  }
  const timer = setInterval(() => codes.rotate(), Math.max(100, Math.floor(codeTtl / 2)))
  timer.unref?.()
  const wantTimer = setInterval(() => { try { checkWant() } catch {} }, 200)
  wantTimer.unref?.()
  // 上一个面板被硬关掉时可能留下一张没人要的条子：起来时先扔掉
  server.on('listening', () => {
    listening = true
    try { fs.rmSync(want, { force: true }) } catch {}
    save(codes.current())
  })
  server.on('close', () => { closed = true; clearInterval(timer); clearInterval(wantTimer); drop() })
  server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch {} })
  server.link = () => `http://127.0.0.1:${port}/?k=${codes.current().code}`
  // 先同步删掉 dashboard.json 再关（浏览器的长连接会让 close 迟迟不结束）
  server.stop = () => { if (closed) return; closed = true; clearInterval(timer); clearInterval(wantTimer); drop(); try { server.close(); server.closeAllConnections?.() } catch {} }
  server.listen(port, host)
  return server
}
