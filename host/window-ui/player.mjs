// 「她的小窗」页面的纯逻辑：window.js 和 node 测试共用。不碰 DOM、不读时钟 —— 「现在」一律由调用方传进来，测试才能拨表。
//   · 字幕播放器：转录是一整条回复写一次盘，几秒钟的动作常常一批落下来。一条条念：每条至少停 1.5 秒才看得清；
//     排着的有 4 条以上就每条 0.6 秒赶一赶；最早那条已经等了 10 秒以上 → 直接跳到最新（中间的照样进动态列表，只是不再念）。
//     动态列表也由它放行：气泡里念到哪条，列表就长到哪条，两边对得上。
//   · 事件 → 立绘表情 / 张嘴的临时覆盖：服务器给的是「此刻」的状态，可页面念的可能是几秒前那条；表情要跟着正在念的那条走。
//   · 格式化、链接白名单、「遮住私话」的判断。

export const PACE = Object.freeze({ minMs: 1500, fastMs: 600, fastAt: 4, behindMs: 10_000, talkPerChar: 120, talkMaxMs: 6000 })
export const MAX_TEXT = 80
const UNTIL_NEXT = 120_000   // 「直到下一条」的表情最多撑两分钟：漏了结束事件也不会卡在一个表情上，之后交还服务器的状态

/** 截短到 n 个字（按字符算，不把表情 / 生僻字的代理对劈开） */
export const clip = (s, n = MAX_TEXT) => { const a = Array.from(String(s ?? '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join('') }
export const toMs = (t) => (typeof t === 'number' ? t : typeof t === 'string' && t ? Date.parse(t) : NaN)

/** 张嘴多久：每个字 120 毫秒，最多 6 秒（她的原话优先，没有就按字幕长度） */
export const talkMsOf = (ev, pace = PACE) => Math.min(pace.talkMaxMs, Array.from(String(ev?.text || ev?.cap || '')).length * pace.talkPerChar)

/** 轻事件：「在想…」、顺利结束的工具 —— 后面还排着别的就不占字幕时间；出错不算轻，要让人看见 */
export const isLight = (ev) => ev?.kind === 'thinking' || (ev?.kind === 'tool_end' && ev.ok !== false)

/** 这条字幕至少停多久：轻事件 0；积压 ≥4 条时 0.6 秒；她说的话按字数（1.5–6 秒）；其余 1.5 秒 */
export function dwellOf(ev, waiting, pace = PACE) {
  if (isLight(ev)) return 0
  if (waiting >= pace.fastAt) return pace.fastMs
  return ev?.kind === 'said' ? Math.max(pace.minMs, talkMsOf(ev, pace)) : pace.minMs
}

/** 字幕播放器。push 进来的事件按到达顺序排队；tick(now) 返回这一刻该放进列表的（reveal）和该换上气泡的（show） */
export function createPlayer(pace = PACE) {
  let queue = [], current = null, shownAt = 0
  return {
    push(ev, now) { if (ev) queue.push({ ev, at: now }) },
    tick(now) {
      const out = { reveal: [], show: null, skipped: 0 }
      if (!queue.length) return out
      if (now - queue[0].at > pace.behindMs) {
        // 落后太多（窗口藏起来过 / 一下子落了一大批）：全部放进列表，气泡直接换成最新那条
        const all = queue.splice(0)
        out.reveal = all.map((x) => x.ev)
        out.skipped = all.length - 1
        current = out.show = all[all.length - 1].ev
        shownAt = now
        return out
      }
      while (queue.length && !(current && now - shownAt < dwellOf(current, queue.length, pace))) {
        const { ev } = queue.shift()
        out.reveal.push(ev)   // 轻事件 dwellOf=0：后面还有就马上被下一条顶掉
        current = out.show = ev
        shownAt = now
      }
      return out
    },
    get waiting() { return queue.length },
    get current() { return current },
    get shownAt() { return shownAt },
    reset() { queue = []; current = null; shownAt = 0 },
  }
}

// ─────────────── 表情 ───────────────
const ACT_EXPR = { watch: '浅笑', read: '浅笑', search: '浅笑', write: '浅笑', make: '浅笑', send: '浅笑', think: '想事情', other: 'neutral' }

/** 念到这条时立绘该怎样：{ expr, talkMs, holdMs }；null = 不改（沿用上一条的） */
export function overlayFor(ev, pace = PACE) {
  switch (ev?.kind) {
    case 'turn_start': return { expr: '小吃惊', talkMs: 0, holdMs: 1500 }
    case 'thinking': return { expr: '想事情', talkMs: 0, holdMs: UNTIL_NEXT }
    case 'tool_start': return { expr: ACT_EXPR[ev.activity] ?? 'neutral', talkMs: ev.activity === 'send' ? talkMsOf(ev, pace) : 0, holdMs: UNTIL_NEXT }
    case 'said': return { expr: '浅笑', talkMs: talkMsOf(ev, pace), holdMs: UNTIL_NEXT }
    case 'tool_end': return ev.ok === false ? { expr: '别扭', talkMs: 0, holdMs: 4000 } : null
    case 'retry': case 'denied': return { expr: '别扭', talkMs: 0, holdMs: 4000 }
    case 'turn_end': return ev.ok === false ? { expr: '低落', talkMs: 0, holdMs: 4000 } : { expr: '浅笑', talkMs: 0, holdMs: 3000 }
    case 'note': return ev.glyph === '错' ? { expr: '别扭', talkMs: 0, holdMs: 4000 } : null   // 「模型接口出错了」这类提示：和 stateOf 一样别扭 4 秒
    default: return null
  }
}

/** 想要的表情没有这张图：退到 neutral，再退到第一张；一张都没有 → null（不去要图，免得一串 404） */
export function pickExpr(want, available) {
  const list = Array.isArray(available) ? available : []
  return list.includes(want) ? want : list.includes('neutral') ? 'neutral' : list[0] ?? null
}
export const spriteUrl = (outfit, expr, open = false) => `/sprite/${encodeURIComponent(outfit)}/${open ? encodeURIComponent('说话') + '/' : ''}${encodeURIComponent(expr)}.png`

// ─────────────── 字幕文字 ───────────────
const KIND_CAP = { thinking: '在想…', turn_start: '醒了', turn_end: '这回合结束了', retry: '网络不太顺，重试中', denied: '想跑一条不允许的命令，被拦下了', tool_start: '在忙', tool_end: '做完了', note: '' }
// 服务器没给 caption 时的兜底（和 liveview.stateOf 的说法一致）。asleep 只说「在睡觉」：几点醒、还有多久由作息那行说，气泡里不再念一遍
export const STATE_CAP = { offline: '宿主没在跑', asleep: '在睡觉', night_done: '在睡觉 · 今晚的事做完了', day: '白天不醒，私信随时能叫醒她', done: '这回合做完了',
  dm_queued: '你的私信到了，马上醒', queued: '有人找她，马上醒', starting: '她醒了', thinking: '在想…', paused: '你在和她当面聊', chatting: '你正在和她当面聊', failed: '上一回合没做完' }

/** 「遮住私话」打开时要遮的：标了 private 的原话，以及所有「她说」（回合最后那句给你的话在回合结束前认不出来，只能一起遮） */
export const shouldMask = (ev, hide) => Boolean(hide && (ev?.kind === 'said' || (ev?.private && ev?.text)))

/** 一行字幕。「她说」只用她的原话（cap 一概不显示，免得服务器把原话也塞进 cap 时遮不住） */
export function captionOf(ev, hide) {
  if (ev?.kind === 'said') return hide ? '她说了句话（遮住了）' : ev.text ? `她说：「${clip(ev.text)}」` : '她说了句话'
  return clip(ev?.cap || KIND_CAP[ev?.kind] || '')
}
/** 字幕下面那行原话（私信 / 报备的内容）；没有 → null */
export const textLineOf = (ev, hide) => (ev?.kind === 'said' || !ev?.text ? null : shouldMask(ev, hide) ? '（这句遮住了）' : `“${clip(ev.text)}”`)

const ACT_GLYPH = { watch: '看', read: '读', write: '写', send: '发', think: '想', search: '找', make: '做' }
const GLYPHS = new Set(['看', '写', '发', '想', '错', '找', '记', '做', '读'])
export function glyphOf(ev) {
  if (ev?.kind === 'said') return '说'
  if (ev?.kind === 'retry' || ev?.kind === 'denied' || (ev?.kind === 'tool_end' && ev.ok === false)) return '错'
  return GLYPHS.has(ev?.glyph) ? ev.glyph : ACT_GLYPH[ev?.activity] ?? (ev?.kind === 'note' ? '记' : '·')
}

// 回合 id 的前缀就是回合种类（scheduler / cli 起的名字）；页面上用对主人说话的口吻。
// chat-<毫秒> 是服务器给主人 cli open 当面聊起的假回合：没有宿主的回合 id、永远没有 turn_end，聊完（paused.json 没了）就从快照里消失
const KINDS = [[/^bili-whale-dm-/, '你发来私信'], [/^bili-whale-win-/, '你在小窗里找她'], [/^bili-whale-listen-/, '有人找她'], [/^bili-whale-live-/, '直播间有人喊她'],
  [/^bili-whale-\d+$/, '按作息醒来'], [/^manual-/, '你叫醒了她'], [/^bili-whale-preview-/, '预览'], [/^chat-/, '你在和她当面聊']]
export const kindLabelOf = (id, fallback) => { for (const [re, l] of KINDS) if (re.test(String(id ?? ''))) return l; return fallback ? clip(fallback, 20) : '醒来' }
export const isChatId = (id) => /^chat-/.test(String(id ?? ''))

/**
 * 顶上的状态牌。只是一个短牌子：旁边的回合种类（「你在和她当面聊」）、气泡（「你正在和她当面聊」）已经把话说全了，
 * 牌子再说一遍就是同一句话在一屏上出现三次。当面聊的假回合跑着时牌子说「醒着」（粉色），种类那里说是在当面聊
 */
export function chipOf(snap, active, activeId) {
  if (!snap?.host) return { text: '连接中', cls: 'wait' }
  if (snap.host.state === 'offline') return { text: '宿主离线', cls: 'off' }
  if (active) return { text: '醒着', cls: isChatId(activeId) ? 'chat' : 'awake' }
  if (snap.state === 'chatting' || snap.state === 'paused' || snap.host.state === 'paused') return { text: '当面聊', cls: 'chat' }
  return { text: '睡着', cls: 'sleep' }
}
/** 小窗服务停了 / 卡住了（页面判断的，不是服务器说的）：牌子只说连不上，别拿最后那份快照接着说「醒着」 */
export const LOST_CHIP = Object.freeze({ text: '连不上', cls: 'off' })

/**
 * 多久听不到服务器就算它停了：服务器每 beatSec 秒发一次心跳（hb），页面另外每 10 秒轮询一次快照。
 * 两样都 2.5 个心跳没动静（大约 25 秒）才算：一次心跳赶上 GC / 杀毒扫一下晚几秒不至于误报
 */
export const silentLimitMs = (viewer) => { const b = Number(viewer?.beatSec); return Math.round((Number.isFinite(b) && b >= 1 && b <= 300 ? b : 10) * 2500) }

// ─────────────── 时间 / 钱 ───────────────
const pad = (n) => String(n).padStart(2, '0')
/** 2:41 / 1:02:03 */
export function fmtClock(ms) {
  const s = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
/** 3 分 17 秒 / 45 秒 / 1 小时 2 分 */
export function fmtDurCN(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
}
export const fmtCost = (usd) => (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? '$' + (usd >= 0.1 || usd === 0 ? usd.toFixed(2) : usd.toFixed(3)) : null)
export const fmtTokens = (n) => (!Number.isFinite(n) || n < 0 ? '' : n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : String(Math.round(n)))
// 本地钟点（倒计时那晚是夏令时结束的夜里：一律从绝对毫秒算，不碰 atText）
export const hhmm = (t) => { const d = new Date(toMs(t)); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const hhmmss = (t) => { const d = new Date(toMs(t)); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
export const todPhase = (d) => { const h = d.getHours(); return h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night' }

/**
 * 某个时刻是哪天（按本地日历；正午相减再四舍五入，夏令时那天 23 / 25 小时也算一天）。
 * 只是兜底：服务器在 plan.when 里给好了（liveview.whenText，和桌宠气泡同一个说法：「今晚 20:30」「明早 07:30」…），页面引不了 liveview。
 * 12 小时内的后半夜（凌晨 02:10 醒）照常只说钟点 —— 那是「今晚」的事，说「明天 02:10」反而像要等一整天
 */
export function whenLabel(at, now) {
  const a = new Date(toMs(at)), n = new Date(toMs(now))
  if (isNaN(a) || isNaN(n)) return ''
  const noon = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  const d = Math.round((noon(a) - noon(n)) / 86_400_000), t = hhmm(a.getTime()), h = a.getHours()
  if (d <= 0 || (d === 1 && a - n < 12 * 3600_000 && h < 6)) return t
  if (d === 1) return (h < 6 ? '明天凌晨 ' : h < 12 ? '明早 ' : h >= 18 ? '明晚 ' : '明天 ') + t
  if (d === 2) return '后天 ' + t
  return `${a.getMonth() + 1}月${a.getDate()}日 ${t}`
}

/**
 * 回合之间那行：「明晚 20:30 醒（只写日记）· 还有 26:09:59」。哪天用服务器的 plan.when（没有就自己按日历算）——
 * 光写「03:30 醒 · 还有 26:09:59」读着像一小时后。倒计时只认 atMs（夏令时结束那夜 02:10 有两个）。
 * 不是「要醒」的计划（醒过了 / 今晚不醒了）就念服务器的 plan.text：那是按实际发生的事写的
 */
export function planLine(plan, now) {
  if (!plan || typeof plan !== 'object') return null
  const at = Number(plan.atMs), pending = plan.action === 'wake' || plan.action === 'skip'
  const what = plan.action === 'skip' ? '只写日记' : '醒来看视频'
  const when = typeof plan.when === 'string' && plan.when.trim() ? clip(plan.when.trim(), 20) : whenLabel(at, now)
  if (pending && Number.isFinite(at) && at > now) return `${when} 醒（${what}）· 还有 ${fmtClock(at - now)}`
  if (pending && Number.isFinite(at) && now - at < 10 * 60_000) return `${hhmm(at)} 该醒了（${what}）· 宿主一分钟内叫她`
  return plan.text ? clip(plan.text) : null
}

/**
 * 回合之间「还排着」那行。气泡已经说了「你的私信到了，马上醒」时，只排着那一条私信就不再说一遍；
 * 排着别的才说几个、其中几个是私信。queued 认三种写法：数字 / id 数组 / { dm, total }
 */
export function queuedLine(queued, state) {
  const q = queued
  const n = Array.isArray(q) ? q.length : q && typeof q === 'object' ? Number(q.total) || 0 : Number(q) || 0
  const idOf = (x) => String(typeof x === 'string' ? x : x?.id ?? '')
  const dm = Array.isArray(q) ? q.filter((x) => /^bili-whale-dm-/.test(idOf(x))).length
    : q && typeof q === 'object' ? Number(q.dm) || 0 : 0
  const win = Array.isArray(q) ? q.filter((x) => isWinId(idOf(x))).length : q && typeof q === 'object' ? Number(q.win) || 0 : 0
  if (n <= 0 || (state === 'dm_queued' && n === 1)) return ''
  const part = dm <= 0 && win <= 0 ? '' : dm >= n ? (n === 1 ? '（是你的私信）' : '（都是你的私信）') : win >= n ? '（都是你在小窗里说的）'
    : `（${[dm > 0 && `${dm} 个是你的私信`, win > 0 && `${win} 句是你在小窗里说的`].filter(Boolean).join('，')}）`
  return `还排着 ${n} 个回合${part}`
}

// ─────────────── 小窗里的聊天 / 审核（服务器给的是净化过的数据；字一律 textContent） ───────────────
export const isWinId = (id) => /^bili-whale-win-/.test(String(id ?? ''))
/** 你说的那句现在怎么样了（服务器 chatView 的 state） */
export function chatStateText(c) {
  if (!c || typeof c !== 'object') return ''
  switch (c.state) {
    case 'queued': return Number(c.ahead) > 0 ? `排着，前面还有 ${Number(c.ahead)} 个回合` : '交给她了，马上轮到'
    case 'running': return '她在回…'
    case 'done': return c.reply ? '' : '她这回合做完了，没留话'
    case 'failed': return '这一回合没做完'
    // 也可能是做完了、只是宿主重启时没留下结果：别一口咬定「没收到」，免得主人再说一遍、她做两次
    case 'lost': return '没等到她的回复记录（宿主可能重启过）：去「动态」看看她做了没有，要紧的话再说一次'
    default: return ''
  }
}
/** 「审核」按钮上的数：等你审的视频 + 等你确认的频道设定 */
export function reviewCount(today) {
  const t = today && typeof today === 'object' ? today : {}
  const v = Number(t.pendingVideos ?? t.pending)
  return (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0) + (t.channelWaiting === true ? 1 : 0)
}
/** 视频多长：「1 分 12 秒」/「45 秒」 */
export const fmtSeconds = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? fmtDurCN(Number(s) * 1000) : '')

/**
 * 底下「今天」那一条：{ stats: [[文字, 样式]], review: 提示那行 }。
 *   「发出」= 公开发到 B站 的（服务器已经不算分享给主人的私信，那是「给你私信」）；
 *   「等你审」= 等审的视频 + 回复草稿；投稿结果不确定的另算「要你核对」—— 那要去 B站 / 面板核对，不是审，
 *   照着「审：videos」去看会是「没有等你审的视频」。提示只写有事的那几条命令
 */
export function todayStrip(t) {
  if (!t || typeof t !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0)
  const pending = num(t.pending), uncertain = num(t.uncertain)
  const stats = [[`回合 ${num(t.turns)}`, ''], [`看了 ${num(t.watched)} 条`, ''], [`发出 ${num(t.sent)} 条`, ''], [`给你私信 ${num(t.dmToOwner)} 条`, ''],
    [`等你审 ${pending} 件`, pending > 0 ? 'hot' : '']]
  if (uncertain > 0) stats.push([`要你核对 ${uncertain} 件`, 'hot'])
  stats.push([`花了 ${fmtCost(t.costUsd) ?? '—'}`, ''])
  // 老一点的服务器没有分开的两个数：有等审的就两条命令都给
  const split = t.pendingVideos != null || t.pendingDrafts != null
  const cmds = split ? [num(t.pendingVideos) > 0 && 'node host/cli.mjs videos', num(t.pendingDrafts) > 0 && 'node host/cli.mjs pending'].filter(Boolean)
    : pending > 0 ? ['node host/cli.mjs videos', 'node host/cli.mjs pending'] : []
  const review = [cmds.length ? '审：' + cmds.join(' · ') : '', uncertain > 0 ? '核对投稿结果：node host/cli.mjs dashboard' : ''].filter(Boolean).join('；')
  return { stats, review }
}

/** 气泡下面「还在跑的」小牌子：两条以上在看视频就并成一块「同时在看 N 条视频」；气泡里那条不重复 */
export function inflightChips(list, bubbleToolId, max = 3) {
  const all = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object')
  const watch = all.filter((x) => x.activity === 'watch')
  const out = []
  if (watch.length >= 2) out.push({ text: `同时在看 ${watch.length} 条视频`, since: Math.min(...watch.map((x) => toMs(x.since)).filter(Number.isFinite)) })
  for (const x of all) {
    if ((watch.length >= 2 && x.activity === 'watch') || (bubbleToolId && x.toolId === bubbleToolId)) continue
    out.push({ text: clip(x.cap || '在忙', 40), since: toMs(x.since) })
  }
  for (const c of out) if (!Number.isFinite(c.since)) c.since = null
  return out.length > max ? [...out.slice(0, max), { text: `还有 ${out.length - max} 件`, since: null }] : out
}

/**
 * 回合结束的小结：「3 分 17 秒 · 39 步 · $1.37 · 看了 4 条 · 写了日记」。看了几条 = 这回合里看过的不同 BV：
 * 抽帧看（watch）和只读字幕评论的初筛（debrief --no-frames、字幕、视频信息…服务器标 seen）都算 —— 她一晚上多半是后者，
 * 只数抽帧的话小结说「看了 1 条」，底下「今天」却说看了 6 条
 */
export function summaryOf(end, evs = []) {
  const parts = []
  if (Number.isFinite(end?.durationMs)) parts.push(fmtDurCN(end.durationMs))
  if (Number.isFinite(end?.steps) && end.steps > 0) parts.push(`${end.steps} 步`)
  const cost = fmtCost(end?.costUsd)
  if (cost) parts.push(cost)
  const starts = evs.filter((e) => e?.kind === 'tool_start')
  const watched = new Set(starts.filter((e) => (e.activity === 'watch' || e.seen === true) && isBV(e.bv)).map((e) => e.bv))
  if (watched.size) parts.push(`看了 ${watched.size} 条`)
  if (starts.some((e) => e.activity === 'write' && /日记/.test(e.cap ?? ''))) parts.push('写了日记')
  if (end?.ok === false) parts.push('没跑完')
  return parts.join(' · ')
}

// ─────────────── 链接（和面板的 a() 一个意思：能点出去的只有 B站 自己的地址） ───────────────
const BV_RE = /^BV[0-9A-Za-z]{10}$/
export const isBV = (bv) => BV_RE.test(String(bv ?? ''))
export const bvLink = (bv) => (isBV(bv) ? `https://www.bilibili.com/video/${bv}/` : null)
export const coverUrl = (bv) => (isBV(bv) ? `/cover/${bv}` : null)
export const safeHref = (href) => (typeof href === 'string' && /^https:\/\/((www|t|live|space|m)\.bilibili\.com|b23\.tv)\/[^\s"'<>\\]*$/.test(href) ? href : null)
