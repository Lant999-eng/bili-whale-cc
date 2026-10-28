// 「她的小窗」页面脚本：只把服务器（host/window.mjs）翻译好的短事件画出来。
//   · 字一律 textContent：视频标题、评论片段是别人写的字，不拼 HTML、不 eval；能点出去的链接只有 B站 自己的地址。
//   · /events（SSE）：hello = 整份快照（替换状态），ev = 一条新事件（交给字幕播放器按节奏放），hb = 服务器每 10 秒的心跳；断了自己重连。
//     /api/live 每 10 秒（断线时 3 秒）再取一次快照：宿主在不在、作息、今天这些慢变的状态不靠事件也能跟上。
//   · 小窗服务停了 / 卡住了（SSE 断了且轮询失败，或者 2.5 个心跳什么都没听到）：页面自己认出来，变灰、计时停下、
//     只说「小窗服务停了」—— 不拿最后那份快照接着说「醒着」、接着走表。
//   · 节奏、表情、格式化这些纯逻辑在 player.mjs（node 里能单测）。
import {
  PACE, createPlayer, overlayFor, pickExpr, spriteUrl, captionOf, textLineOf, shouldMask, glyphOf, kindLabelOf, isChatId, chipOf, LOST_CHIP, silentLimitMs,
  planLine, queuedLine, todayStrip, inflightChips, summaryOf, STATE_CAP, fmtClock, fmtDurCN, fmtCost, fmtTokens, hhmm, hhmmss, todPhase, toMs, clip, isBV, bvLink,
  coverUrl, safeHref, chatStateText, reviewCount, fmtSeconds,
} from './player.mjs'

const D = globalThis.document
// 她的名字：服务给页面的标题填好了（persona.name，没起名字 = bili-whale）。在改标题之前先记下来 —— 后面的标题都以它开头
const NAME = String(D.title || '').trim() || 'bili-whale'
const IDS = ['top', 'chip', 'kind', 'timer', 'steps', 'meter', 'eye', 'conn', 'stage', 'sprite', 'sp-closed', 'sp-open', 'zz', 'sp-none', 'bubble', 'cap', 'capsub', 'captext', 'chips', 'cover', 'cover-img', 'idle', 'plan', 'queued', 'hostline', 'last', 'feed', 'feed-empty', 'more', 't-stats', 't-covers', 't-review',
  'tab-feed', 'tab-chat', 'chat-badge', 'feedwrap', 'chatwrap', 'chatlog', 'chat-empty', 'say', 'send', 'say-st', 'b-start', 'b-wake', 'b-review', 'review-badge', 'sheet', 'sheet-h', 'sheet-x', 'sheet-body', 'toast', 'toast-h', 'toast-x', 'toast-out']
const E = Object.fromEntries(IDS.map((id) => [id, D.getElementById(id)]))
const el = (tag, cls, text) => { const e = D.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e }
const setText = (e, t) => { const v = String(t ?? ''); if (e.textContent !== v) e.textContent = v }
const vis = (e, on) => { if (e.hidden === Boolean(on)) e.hidden = !on }
const link = (a, href) => { const h = safeHref(href); if (h) { a.href = h; a.target = '_blank'; a.rel = 'noreferrer noopener' } else a.removeAttribute('href') }

// 「遮住私话」：录屏 / 共享屏幕时打开。默认关（主人选的：她对你说的话直接显示，最多 80 字）
const LS_KEY = 'whale-window.hide-private'
const loadHide = () => { try { return globalThis.localStorage?.getItem(LS_KEY) === '1' } catch { return false } }
const saveHide = (v) => { try { globalThis.localStorage?.setItem(LS_KEY, v ? '1' : '0') } catch {} }
const reduceMotion = (() => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true } catch { return false } })()
const EXPIRED = '这个窗口的登录失效了（小窗服务重启过）：在命令行再跑一次 node host/cli.mjs window'
const LOST = '小窗服务停了（或卡住了）：在命令行跑 node host/cli.mjs window 重新打开'
const LOST_HOST = '小窗服务停了：这里看不到她现在的状态'
const EXPIRED_HOST = '这个窗口和小窗服务断开了：这里看不到她现在的状态'   // 服务是重启了不是停了：别说「停了」
const REPLACED_HOST = '这个窗口不再连小窗服务了：这里看不到她现在的状态'   // 认出端口上回应的不是原来那个（见 REPLACED）：也别说「停了」
// 这个端口上回应的已经不是开这个窗口的那个服务（startedAt 对不上）。两种情况页面分不出来：小窗服务重启过、又开了一个新的小窗
// （同一个 Edge 配置共用 cookie，新窗口的 cookie 让旧窗口也拿到了新服务的快照），或者别的程序占了这个端口在冒充 ——
// 所以一律不认：之后它给的一概不显示，也不再往它那儿发任何话（「先 403 再 200」冒充的也做得出来，不能拿它当「正常重启」的证据）
const REPLACED = '小窗服务重启过（或者这个端口上换了别的程序）：这个窗口不再显示、也不再替你做事 —— 用新开的那个小窗（没有的话在命令行跑 node host/cli.mjs window）'
const RECENT_MS = 15 * 60_000   // 回合结束后 15 分钟内，顶栏还留着「这回合 $x」
const MAX_GROUPS = 40
const POLL_TIMEOUT_MS = 8000    // 服务卡住（连接还在、就是不回）时轮询别一直挂着：挂着就永远轮不到下一次，也认不出它停了
const METER_TIP = '这回合新用的 token：输入 + 输出 + 写进缓存的，不算缓存重读'

const S = {
  snap: {}, snapAt: 0, booted: false, lastSeq: 0, sseUp: false,
  lost: false,                  // 页面认定小窗服务停了 / 卡住了（不是宿主离线：那是服务器在快照里说的）
  lostWhy: '',                  // 横幅那句（LOST / EXPIRED）：宿主那行跟着它说
  heardAt: 0,                   // 最后一次听到服务器：hello / ev / hb / 轮询成功
  viewerStart: null,            // 第一份快照里的 viewer.startedAt：这个窗口认的就是这个服务（见 REPLACED）
  dead: false,                  // 认出端口上换了别的程序：不再连、不再显示、不再发
  helloOk: false,               // 这条 SSE 连接的 hello 对过了：之前来的 chat / job 不收，ev 先攒着、对过了才排进去（见 connect）
  groups: new Map(),            // 回合 id → { box, head, list, rows(toolId→行), events, textRows, summary, end }
  inflight: new Map(),          // toolId → { toolId, cap, bv, title, since, activity }（念到的 tool_start 进、tool_end 出）
  turn: null,                   // { id, at, steps, tokens, ended, endAt, costUsd, durationMs, cut }（cut = 服务停了、页面先在这里停表）
  current: null, shownAt: 0, overlay: null,
  hide: loadHide(), follow: true, unseen: 0,
  sprite: { want: '', key: '', failed: '', failAt: 0 }, flap: null, mouth: false,
  coverFail: new Map(), todayKey: '',
}
const player = createPlayer()
// 小窗里点的事：token = 这个窗口的操作令牌（/api/me 给）；chat = 服务器给的聊天记录；seen = 已经看过的回复（未读的数在「聊天」上）；
// draft = 发出去还没确定交上的那句（没交上就放回输入框）；handled = 已经提示过结果的事（SSE 和 /api/jobs 都会报同一件）；
// 审核面板重画时要留着的：openReject / drafts（打开的退回框和里面的字）、confirm（投稿的确认框）、notes（卡片底下那句），都按「哪张卡片的哪一版」记
const A = { token: null, sayMax: 2000, chat: [], chatKey: '', seen: new Set(), seeded: false, tab: 'feed', sending: false, draft: null, wakeArmed: 0,
  jobs: new Map(), handled: new Set(), jobsSynced: false, review: null, reviewKey: '', sheetOpen: false, toastTimer: null,
  openReject: new Set(), drafts: new Map(), confirm: new Map(), notes: new Map(), boxes: new Map(), notePaint: new Map(), rejectJob: new Map() }

// ─────────────── 收事件 ───────────────
const okEvent = (e) => e && typeof e === 'object' && typeof e.kind === 'string'
const bySeq = (a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)
function accept(ev, now) {
  if (!okEvent(ev)) return
  if (Number.isFinite(ev.seq)) { if (ev.seq <= S.lastSeq) return; S.lastSeq = ev.seq }   // 服务器的序号只增：快照 / 断线重连补发的旧事件丢掉
  ev._arr = now
  player.push(ev, now)
}

/** 收一份快照（hello / 轮询）。对不上这个窗口认的服务 → 不收，返回 false */
function onSnapshot(s, how) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || S.dead) return false
  const vs = typeof s.viewer?.startedAt === 'string' ? s.viewer.startedAt : null
  if (S.viewerStart && vs !== S.viewerStart) { die(); return false }
  if (vs) S.viewerStart = vs
  const now = Date.now()
  const feed = (Array.isArray(s.feed) ? s.feed : []).filter(okEvent).sort(bySeq)
  const { feed: _drop, ...base } = s
  S.snap = base; S.snapAt = now
  const wasLost = S.lost
  regain(now)
  const maxSeq = feed.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0)
  // 第一次，或新连上的 hello 序号反而比我们见过的小：整列重画、不重播；平时只把没见过的排进播放器。
  // 轮询来的快照可能比 SSE 刚推来的事件旧一点，序号小不说明什么 —— 只认 hello
  if (!S.booted || (how === 'hello' && maxSeq < S.lastSeq)) rebuild(feed, now)
  else if (!(how === 'poll' && awaitingReplay(feed))) for (const ev of feed) accept(ev, now)
  S.booted = true
  reconcileTurn(now)
  for (const g of S.groups.values()) if (g.end && g.id === base.lastTurn?.id) paintSummary(g)
  renderToday()
  if (Array.isArray(base.chat)) renderChat(base.chat)
  renderDock()
  render(now)
  // 新连上 / 接回来：操作令牌重拿一次（共用的 Edge 配置里 cookie 可能被另一个小窗换掉了），替你做的事对一遍（断开时漏掉的 job 事件）
  if (how === 'hello' || wasLost) { fetchToken(); syncJobs() }
  // 等你审的变了（她又交了 / 别处批掉了）：开着的审核面板重读
  const t = base.today && typeof base.today === 'object' ? base.today : {}
  const rk = JSON.stringify([t.pendingVideos ?? t.pending ?? null, t.channelWaiting ?? null])
  if (rk !== A.reviewKey) { const had = A.reviewKey; A.reviewKey = rk; if (had && A.sheetOpen) loadReview() }
  return true
}
/** 认出端口上换了别的程序（见 REPLACED）：断开、不再轮询、横幅说清楚；之后 act() 一律不发 */
function die() {
  if (S.dead) return
  S.dead = true; A.token = null; S.helloOk = false
  try { es?.close() } catch {}
  clearTimeout(esTimer); clearTimeout(pollTimer); pollTimer = null
  if (A.sheetOpen) closeSheet()
  lose(REPLACED)
  renderDock()   // 已经认定停了时 lose() 不重画底下：输入框的提示、审核按钮都换成「不能用了」
}

function rebuild(feed, now) {
  E.feed.replaceChildren(); S.groups.clear(); S.inflight.clear(); player.reset(); vis(E['feed-empty'], true)
  S.current = null; S.overlay = null; S.turn = null; S.unseen = 0; S.lastSeq = 0
  for (const ev of feed) { if (Number.isFinite(ev.seq)) S.lastSeq = Math.max(S.lastSeq, ev.seq); ev._arr = now; reveal(ev, now, true) }
  // 还在跑的以服务器为准（最早那条 tool_start 可能已经掉出最近 150 条）
  const st = S.snap.turn
  if (st?.id) seedInflight(st)
  else S.inflight.clear()
  S.follow = true; scrollEnd(); paintMore()
}

/** 服务器说的回合和页面念到的对一下：播放器念完了才认服务器的（不然顶栏会比气泡先跳） */
function reconcileTurn(now) {
  const st = S.snap.turn, idle = player.waiting === 0
  if (st?.id) {
    if (!S.turn || (S.turn.id !== st.id && (idle || S.turn.ended))) S.turn = { id: st.id, at: toMs(st.at) || now, steps: 0, tokens: 0, ended: false }
    if (S.turn.id === st.id) {
      if (Number.isFinite(toMs(st.at))) S.turn.at = toMs(st.at)
      S.turn.steps = Math.max(S.turn.steps || 0, Number(st.steps) || 0)
      S.turn.tokens = Math.max(S.turn.tokens || 0, Number(st.tokens) || 0)
    }
  } else if (S.turn && !S.turn.ended && idle) { S.turn.ended = true; S.turn.endAt = now; S.inflight.clear() }   // 漏了结束事件也不会一直「醒着」
}
const activeTurn = () => (S.turn && !S.turn.ended ? S.turn : null)
const seedInflight = (st) => { for (const x of Array.isArray(st?.inflight) ? st.inflight : []) if (x?.toolId && !S.inflight.has(x.toolId)) S.inflight.set(x.toolId, x) }

// ─────────────── 小窗服务还在不在 ───────────────
/** 认定服务停了 / 卡住了：横幅只设这一句（之后 SSE 每次重连失败都不再改它，免得两句话来回跳），计时和「还在跑」都停下 */
function lose(msg) {
  if (S.dead && msg !== REPLACED) return   // 认定换了服务以后：还在路上的轮询回来了，别拿「停了」盖掉那句
  setConn(msg)
  S.lostWhy = msg
  if (S.lost) return
  S.lost = true
  // 这回合在页面上先「断在这里」：不再走表；服务回来时快照里还是这一回合，就接着算（regain）
  if (S.turn && !S.turn.ended) Object.assign(S.turn, { ended: true, cut: true, endAt: Date.now() })
  S.inflight.clear(); S.overlay = null
  mouth(false)
  renderDock()
  render(Date.now())
}
/** 又听到服务器了（新快照已经放进 S.snap）：撤掉「停了」，断在半路的回合要是还在跑就接上 */
function regain(now) {
  S.heardAt = now
  if (!S.lost) return
  S.lost = false
  const st = S.snap.turn
  if (S.turn?.cut && st?.id === S.turn.id) { Object.assign(S.turn, { ended: false, cut: false }); delete S.turn.endAt; seedInflight(st) }
}
/** hb / ev：服务还活着。之前认定它停了的话，马上取一份快照把画面接回来 */
function heard(now) { S.heardAt = now; if (S.lost && !polling) poll() }

// ─────────────── 动态列表 ───────────────
function groupFor(ev, now) {
  const id = typeof ev.turn === 'string' ? ev.turn : ''
  let g = S.groups.get(id)
  if (!g) {
    const box = el('section', 'turn'), head = el('h3', 'turn-h'), list = el('div', 'rows')
    box.append(head, list)
    // 组标题说「几点开始的」：第一条要是收尾（回合头早掉出最近 150 条了），就拿结束时刻减用时，别把结束时刻当开始
    const t = toMs(ev.t), start = ev.kind === 'turn_end' && Number.isFinite(ev.durationMs) && ev.durationMs >= 0 ? t - ev.durationMs : t
    g = { id, box, head, list, rows: new Map(), events: [], textRows: [], at: start || ev._arr || now, sub: '', summary: null, end: null }
    S.groups.set(id, g)
    E.feed.append(box)
    while (S.groups.size > MAX_GROUPS) { const [k, old] = S.groups.entries().next().value; old.box.remove(); S.groups.delete(k) }
    paintHead(g)
  }
  return g
}
function paintHead(g) {
  const label = g.id ? kindLabelOf(g.id, S.snap.turn?.id === g.id ? S.snap.turn.kindLabel : null) : '回合之外'
  g.head.replaceChildren(el('time', 'ht', hhmm(g.at)), el('span', 'hk', label))
  if (g.sub) g.head.append(el('span', 'hs', '· ' + g.sub))
}

function reveal(ev, now, silent) {
  const g = groupFor(ev, now)
  g.events.push(ev)
  switch (ev.kind) {
    case 'turn_start':
      if (S.turn?.id !== ev.turn || S.turn.ended) S.turn = { id: ev.turn, at: toMs(ev.t) || now, steps: 0, tokens: 0, ended: false }   // 快照先报了这回合：步数别清零
      S.inflight.clear()
      g.at = toMs(ev.t) || g.at; g.sub = ev.sub ? clip(ev.sub, 30) : ''
      paintHead(g)
      break
    case 'thinking': break
    case 'tool_start':
      if (ev.toolId) S.inflight.set(ev.toolId, { toolId: ev.toolId, cap: ev.cap, bv: ev.bv, title: ev.title, since: ev.t ?? ev._arr ?? now, activity: ev.activity })
      addRow(g, ev)
      break
    case 'tool_end': case 'denied': {
      // 被拦下的命令：服务器发 denied 代替 tool_end（带同一个 toolId）—— 一样要收掉「还在跑」的小牌子、并进那一行
      if (ev.toolId) S.inflight.delete(ev.toolId)
      const r = ev.toolId && g.rows.get(ev.toolId)
      if (r) setResult(r, ev); else addRow(g, ev)
      break
    }
    case 'turn_end':
      S.inflight.clear()
      if (!S.turn || S.turn.id !== ev.turn) S.turn = { id: ev.turn, at: g.at, steps: 0, tokens: 0 }
      Object.assign(S.turn, { ended: true, cut: false, endAt: toMs(ev.t) || now, seenEnd: now, costUsd: ev.costUsd, durationMs: ev.durationMs })
      g.end = ev
      if (!g.summary) g.summary = el('div', 'sum')
      g.box.append(g.summary)
      paintSummary(g)
      break
    default: addRow(g, ev)   // said / retry / note
  }
  if (S.turn && ev.turn === S.turn.id) {
    if (Number.isFinite(ev.steps)) S.turn.steps = Math.max(S.turn.steps || 0, ev.steps)
    if (Number.isFinite(ev.tokens)) S.turn.tokens = Math.max(S.turn.tokens || 0, ev.tokens)
  }
  vis(E['feed-empty'], false)
  if (silent) return
  if (ev.kind === 'turn_start' || ev.kind === 'turn_end') soonPoll()   // 回合开始 / 结束：快照（种类、作息、今天）早点跟上
  if (S.follow) scrollEnd()
  else if (ev.kind !== 'thinking') { S.unseen += 1; paintMore() }
}

function addRow(g, ev) {
  const row = el('div', 'row k-' + ev.kind)
  const glyph = el('span', 'g', glyphOf(ev))
  glyph.dataset.g = glyph.textContent
  const body = el('div', 'b')
  const cap = el(isBV(ev.bv) ? 'a' : 'span', 'c')
  if (isBV(ev.bv)) link(cap, bvLink(ev.bv))
  body.append(cap)
  if (ev.sub && ev.kind !== 'said') body.append(el('div', 'sub', clip(ev.sub)))
  const txt = el('div', 'txt'), res = el('div', 'res')
  res.hidden = true
  body.append(txt, res)
  row.append(el('time', 't', hhmmss(ev.t ?? ev._arr)), glyph, body)
  const r = { row, cap, txt, res, ev }
  paintRow(r)
  if (ev.kind === 'tool_end') setResult(r, ev, true)
  if (ev.kind === 'retry' || ev.kind === 'denied' || (ev.kind === 'note' && ev.glyph === '错')) row.classList.add('err')
  g.list.append(row)
  if (ev.kind === 'tool_start' && ev.toolId) g.rows.set(ev.toolId, r)
  if (ev.kind === 'said' || ev.text) g.textRows.push(r)
  return r
}
function paintRow(r) {
  setText(r.cap, captionOf(r.ev, S.hide))
  const t = textLineOf(r.ev, S.hide)
  setText(r.txt, t ?? ''); vis(r.txt, Boolean(t))
  r.row.classList.toggle('masked', shouldMask(r.ev, S.hide))
}
function setResult(r, end, standalone = false) {
  // 没有专门的结果说法时，服务器的结束事件就沿用开始那句（「在给你发私信」）：别在同一行再念一遍；出错用它给的原因（退出码）
  const same = !end.cap || end.cap === r.ev.cap
  if (!standalone) { setText(r.res, clip(end.ok === false ? end.sub || (same ? '出错了' : end.cap) : same ? '好了' : end.cap)); vis(r.res, true) }
  r.row.classList.add('done')
  r.row.classList.toggle('err', end.ok === false)
}
function paintSummary(g) {
  const lt = S.snap.lastTurn, end = { ...g.end }
  // 宿主的结果日志（快照的 lastTurn）是这一回合的定论：花费是按会话累计相减的、用时是宿主量的；
  // 转录算的（cost-state 相减、首尾时间戳相减）会差几秒 —— 有日志就用日志，顶栏 / 小结 / 「上一回合」三处才对得上
  if (lt && lt.id === g.id) {
    if (typeof lt.costUsd === 'number') end.costUsd = lt.costUsd
    if (Number.isFinite(lt.durationMs)) end.durationMs = lt.durationMs
  }
  setText(g.summary, summaryOf(end, g.events) || (end.ok === false ? '这回合没跑完' : '这回合结束了'))
  g.summary.classList.toggle('fail', end.ok === false)
}

const nearEnd = () => E.feed.scrollHeight - E.feed.scrollTop - E.feed.clientHeight < 48
function scrollEnd() { E.feed.scrollTop = E.feed.scrollHeight; S.unseen = 0; paintMore() }
function paintMore() { vis(E.more, S.unseen > 0); setText(E.more, `${S.unseen} 条新动态 ↓`) }

// ─────────────── 播放 ───────────────
function onShow(ev, now) {
  S.current = ev; S.shownAt = now
  const o = overlayFor(ev)
  if (o) S.overlay = { expr: o.expr, talkUntil: now + o.talkMs, until: now + o.holdMs }
}

let tickN = 0
function loop() {
  const now = Date.now()
  watchdog(now)
  const out = player.tick(now)
  for (const ev of out.reveal) reveal(ev, now, false)
  if (out.show) onShow(out.show, now)
  if (out.reveal.length) reconcileTurn(now)
  if (out.reveal.length || tickN++ % 2 === 0) render(now)   // 有新动态马上画；否则每 0.2 秒画一次（计时、倒计时）
}
/**
 * SSE 看着还连着、可服务器 2.5 个心跳什么都没说，轮询也没成（失败了 / 超时了；正在等的那次先等它回来）：
 * 服务卡住了，或者连接半死（睡眠唤醒后 TCP 早断了，浏览器还不知道）。认定停了，再主动重连一次 —— 活着的服务马上回 hello
 */
function watchdog(now) {
  if (!S.booted || S.lost || polling || now - S.heardAt <= silentLimitMs(S.snap.viewer)) return
  lose(LOST)
  S.sseUp = false
  try { es?.close() } catch {}
  retryLater()
  schedulePoll(3000)
}

// ─────────────── 画 ───────────────
function render(now) { renderTop(now); renderStage(now) }

function renderTop(now) {
  const s = S.snap, t = S.lost ? null : activeTurn()
  const chip = S.lost ? LOST_CHIP : chipOf(s, Boolean(t), t?.id)
  setText(E.chip, chip.text)
  if (E.chip.className !== 'chip ' + chip.cls) E.chip.className = 'chip ' + chip.cls
  const title = NAME + ' · ' + chip.text
  if (D.title !== title) D.title = title   // 标题要以她的名字开头：cli window --top 按这个找窗口
  const lt = s.lastTurn
  // 刚结束的回合留 15 分钟「这回合 $x」。当面聊不是宿主的回合，没有花费可算；服务停了断在半路的，日志认了它才算结束
  const done = !S.lost && S.turn?.ended && !isChatId(S.turn.id) && (!S.turn.cut || lt?.id === S.turn.id) && now - (S.turn.endAt || 0) < RECENT_MS ? S.turn : null
  if (t) {
    setText(E.kind, kindLabelOf(t.id, s.turn?.id === t.id ? s.turn.kindLabel : null))
    setText(E.timer, fmtClock(now - t.at))
    setText(E.steps, t.steps ? `${t.steps} 步` : '')
    // 新 token = 输入 + 输出 + 写进缓存的；缓存重读不算（便宜，又按「步数 × 上下文」涨，一回合就上百万，看着吓人）
    setText(E.meter, t.tokens ? `${fmtTokens(t.tokens)} 新 token` : '')
    if (E.meter.title !== METER_TIP) E.meter.title = METER_TIP
  } else if (done) {
    if (E.meter.title) E.meter.title = ''
    const mine = lt?.id === done.id ? lt : null      // 和小结一样：先认宿主日志的
    const cost = typeof mine?.costUsd === 'number' ? mine.costUsd : typeof done.costUsd === 'number' ? done.costUsd : null
    const dur = Number.isFinite(mine?.durationMs) ? mine.durationMs : Number.isFinite(done.durationMs) ? done.durationMs : null
    setText(E.kind, kindLabelOf(done.id, lt?.id === done.id ? lt.kindLabel : null))
    setText(E.timer, Number.isFinite(dur) ? '用了 ' + fmtClock(dur) : '')
    setText(E.steps, done.steps ? `${done.steps} 步` : '')
    setText(E.meter, fmtCost(cost) ? `这回合 ${fmtCost(cost)}` : '这回合 · 花费待算')
  } else { for (const k of ['kind', 'timer', 'steps', 'meter']) setText(E[k], ''); if (E.meter.title) E.meter.title = '' }
}

function renderStage(now) {
  // lost：小窗服务停了 / 卡住了 —— 和宿主离线一样画成灰的；手上那份快照不再当真（不说「醒着」、不走表、不倒计时）
  const s = S.snap, active = S.lost ? null : activeTurn(), off = S.lost || s.host?.state === 'offline'
  // 页面已经念完结束事件、服务器那边还没收尾（它等 logs 那行，要晚几秒）：别退回服务器那份过时的「在想…」（最多等一分钟）
  const stale = Boolean(S.turn?.ended && s.turn?.id === S.turn.id && now - (S.turn.seenEnd ?? 0) < 60_000)
  const ov = !off && S.overlay && (now < S.overlay.until || stale) ? S.overlay : null
  const talking = !off && !D.hidden && (ov ? now < ov.talkUntil : Boolean(s.talking) && now - S.snapAt < PACE.talkMaxMs)
  setSprite(s.outfit, pickExpr(off ? '困' : ov ? ov.expr : s.expr || 'neutral', s.exprs), talking, now)
  E.stage.classList.toggle('offline', off)
  // zz + 呼吸只给「在睡觉、等下一次醒」：白天（day）是平常的样子；今晚的事做完了（night_done）是困的脸，但不画 zz
  E.stage.classList.toggle('asleep', !off && !ov && !active && s.state === 'asleep')
  const tod = todPhase(new Date(now))
  if (E.stage.dataset.tod !== tod) E.stage.dataset.tod = tod
  const plan = !active && !off ? planLine(s.plan, now) : null

  // 气泡：回合里念到的那条（还在跑的带上已用时间，从转录里的时间算，不受延迟影响）；回合外是服务器给的状态
  const cur = S.current
  const fresh = !S.lost && cur && (active ? !cur.turn || cur.turn === active.id : stale || (S.overlay && now < S.overlay.until) || now - S.shownAt < PACE.minMs)
  let line, sub = '', text = null, bv = null
  if (S.lost) line = '连不上小窗服务'
  else if (fresh) {
    line = captionOf(cur, S.hide)
    const fly = cur.kind === 'tool_start' && cur.toolId ? S.inflight.get(cur.toolId) : null
    if (fly) line += ' · ' + fmtClock(now - (toMs(fly.since) || cur._arr || now))
    sub = cur.kind === 'said' ? '' : clip(cur.sub ?? '')
    text = textLineOf(cur, S.hide)
    bv = cur.bv
  } else if (s.state === 'asleep' && plan) {
    // 服务器的 caption 是给桌宠的整句（「在睡觉 · 02:10 醒」）；这里底下就是作息那行（几点、做什么、还有多久），气泡只说在睡觉
    line = STATE_CAP.asleep
  } else {
    const c = typeof s.caption === 'string' ? s.caption : s.caption?.cap
    line = clip(c || STATE_CAP[s.state] || (active ? '在忙' : s.host ? '…' : '正在连上她…'))
  }
  setText(E.cap, line)
  setText(E.capsub, sub); vis(E.capsub, Boolean(sub))
  setText(E.captext, text ?? ''); vis(E.captext, Boolean(text))
  E.bubble.classList.toggle('said', Boolean(fresh && cur.kind === 'said'))
  E.bubble.classList.toggle('masked', Boolean(fresh && shouldMask(cur, S.hide)))

  // 还在跑的工具 + 她正在看的那条视频的封面
  const fly = [...S.inflight.values()]
  const chips = active ? inflightChips(fly, fresh ? cur.toolId : null) : []
  const key = chips.map((c) => c.text + (c.since ? ' · ' + fmtClock(now - c.since) : '')).join('\n')
  if (E.chips.dataset.key !== key) { E.chips.dataset.key = key; E.chips.replaceChildren(...(key ? key.split('\n').map((t) => el('span', 'fly', t)) : [])) }
  if (!isBV(bv) && active) bv = fly.find((x) => isBV(x.bv))?.bv
  paintCover(active && isBV(bv) ? bv : null, now)

  // 回合之间：作息倒计时 / 排着的回合 / 宿主心跳 / 上一回合。每行只补气泡和顶上牌子没说的（同一句话不在一屏上出现两三次）
  vis(E.idle, !active || off)
  setText(E.plan, plan ?? ''); vis(E.plan, Boolean(plan))
  const q = active || S.lost ? '' : queuedLine(s.queued, s.state)
  setText(E.queued, q); vis(E.queued, Boolean(q))
  E.hostline.classList.toggle('bad', off)
  const age = Number(s.host?.heartbeatAgeSec)
  setText(E.hostline, S.lost ? (S.lostWhy === REPLACED ? REPLACED_HOST : S.lostWhy === EXPIRED ? EXPIRED_HOST : LOST_HOST) : !s.host ? '' : off ? '开宿主：node host/cli.mjs start'
    : s.host.state === 'paused' ? '宿主在等你们聊完再叫醒她'
    : Number.isFinite(age) ? `宿主在线 · 心跳 ${Math.round(age + (now - S.snapAt) / 1000)} 秒前` : clip(s.host.label || '宿主在线', 40))
  // 页面已经念完这回合的结束、服务器的 lastTurn 还是更早那一回合（宿主的日志那行要晚几秒）：先不显示那张过时的「上一回合」
  const ltStale = Boolean(S.turn?.ended && s.lastTurn?.id !== S.turn.id && now - (S.turn.seenEnd ?? 0) < 60_000)
  paintLast(active || ltStale || S.lost ? null : s.lastTurn)
}

function paintLast(lt) {
  const key = lt ? JSON.stringify([lt.id, lt.at, lt.durationMs, lt.costUsd, lt.ok]) : ''
  if (E.last.dataset.key === key) return
  E.last.dataset.key = key
  vis(E.last, Boolean(lt))
  if (!lt) return E.last.replaceChildren()
  const meta = [fmtDurCN(lt.durationMs), fmtCost(lt.costUsd) ?? '花费待算'].filter(Boolean).join(' · ')
  const ok = el('span', lt.ok === false ? 'bad' : 'good', lt.ok === false ? '没跑完' : '跑完了')
  // lt.at 是这回合开始的时刻（服务器拿结果日志的结束时刻减用时；endedAt 才是结束）：和动态里每组的标题说的是同一个钟点
  E.last.replaceChildren(el('div', 'lt-h', `上一回合 · ${hhmm(lt.at)} ${kindLabelOf(lt.id, lt.kindLabel)}`), el('div', 'lt-m', meta), ok)
}

function paintCover(bv, now) {
  const failAt = bv ? S.coverFail.get(bv) : null
  const want = bv && !(failAt && now - failAt < 15_000) ? bv : null   // 封面可能还没下载完：失败了 15 秒后再试
  if (E.cover.dataset.bv === (want ?? '')) return
  E.cover.dataset.bv = want ?? ''
  if (!want) { vis(E.cover, false); return }
  link(E.cover, bvLink(want))
  E['cover-img'].src = coverUrl(want)
  vis(E.cover, true)
}

// ─────────────── 立绘 + 张嘴 ───────────────
function setSprite(outfit, expr, talking, now) {
  const hasTalk = Array.isArray(S.snap.talkingExprs) && S.snap.talkingExprs.includes(expr)
  const key = outfit && expr ? `${outfit}/${expr}` : ''
  if (key !== S.sprite.want && !(key === S.sprite.failed && now - S.sprite.failAt < 15_000)) {
    S.sprite.want = key
    if (key) loadPair(outfit, expr, hasTalk, key)
    else if (!S.sprite.key) vis(E['sp-none'], Boolean(S.snap.host))
  }
  mouth(talking && hasTalk && S.sprite.key === key)
}
const decode = (url) => { const im = new Image(); im.src = url; return im.decode().then(() => url) }
async function loadPair(outfit, expr, hasTalk, key) {
  // 先在后台把闭嘴 / 张嘴两张都解好再一起换上：换表情不闪，张嘴切的是已经解好的图
  const closed = spriteUrl(outfit, expr, false), open = hasTalk ? spriteUrl(outfit, expr, true) : null
  let gotOpen = false
  try { await decode(closed) } catch { if (S.sprite.want === key) { S.sprite.want = ''; S.sprite.failed = key; S.sprite.failAt = Date.now(); if (!S.sprite.key) vis(E['sp-none'], true) } return }
  if (open) { try { await decode(open); gotOpen = true } catch {} }
  if (S.sprite.want !== key) return   // 等图的时候表情又变了：这一对作废
  E['sp-closed'].src = closed
  if (gotOpen) E['sp-open'].src = open; else E['sp-open'].removeAttribute('src')
  vis(E['sp-open'], gotOpen)
  S.sprite.key = gotOpen ? key : key + '#closed'
  vis(E['sp-none'], false)
}
function mouth(on) {
  on = on && !reduceMotion
  if (on && !S.flap) {
    // 一张一合大约每秒 7 下，带点随机，不像节拍器
    const step = () => { S.mouth = !S.mouth; E.sprite.classList.toggle('talk', S.mouth); S.flap = setTimeout(step, 110 + Math.floor(Math.random() * 60)) }
    step()
  } else if (!on && S.flap) { clearTimeout(S.flap); S.flap = null; S.mouth = false; E.sprite.classList.remove('talk') }
}

// ─────────────── 今天 ───────────────
function renderToday() {
  const t = S.snap.today
  const key = t ? JSON.stringify(t) : ''
  if (S.todayKey === key) return
  S.todayKey = key
  const strip = todayStrip(t)
  if (!strip) { E['t-stats'].replaceChildren(el('span', 'st dim', '还没有今天的数据')); E['t-covers'].replaceChildren(); vis(E['t-review'], false); return }
  E['t-stats'].replaceChildren(...strip.stats.map(([s, c]) => el('span', 'st' + (c ? ' ' + c : ''), s)))
  const list = (Array.isArray(t.watchedList) ? t.watchedList : []).filter((x) => isBV(x?.bv)).slice(0, 6)
  E['t-covers'].replaceChildren(...list.map((x) => {
    const a = el('a', 'cv'), img = el('img'), name = clip(x.title || x.bv, 40)
    link(a, bvLink(x.bv)); a.title = name
    img.alt = name; img.loading = 'lazy'
    img.addEventListener('error', () => { img.hidden = true; a.classList.add('nocover') })
    img.src = coverUrl(x.bv)
    a.append(img, el('span', 'cv-t', name))
    return a
  }))
  vis(E['t-covers'], list.length > 0)
  setText(E['t-review'], strip.review)
  vis(E['t-review'], Boolean(strip.review))
}

// ─────────────── 小窗里点的事：跟她说话、叫醒她、启动宿主、审核 ───────────────
// 都是请服务器替你跑 node host/cli.mjs …（POST /api/act，带这个窗口的操作令牌）；服务器和 cli 各查一遍参数。投稿要点两次。
async function fetchToken() {
  if (S.dead) return null
  try {
    const r = await globalThis.fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' })
    if (r.ok) {
      const j = await r.json()
      if (S.dead) return null   // 等它回来的时候认出换了服务：它给的令牌不要
      A.token = j?.act ?? null; if (Number.isInteger(j?.sayMax) && j.sayMax > 0) A.sayMax = j.sayMax
    }
  } catch {}
  return S.dead ? null : A.token
}
async function act(body) {
  if (S.dead) return { ok: false, error: REPLACED }
  if (S.lost) return { ok: false, error: '连不上小窗服务：等它回来再点' }
  if (!A.token && !(await fetchToken())) return S.dead ? { ok: false, error: REPLACED } : { ok: false, error: '拿不到这个窗口的操作令牌：从命令行重开一次小窗（node host/cli.mjs window）' }
  // 每次等完都再看一眼：等的时候认出换了服务，就不再发、它回的也不显示
  if (S.dead) return { ok: false, error: REPLACED }
  let r
  try {
    r = await globalThis.fetch('/api/act', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-whale-act': A.token }, body: JSON.stringify(body) })
  } catch { return { ok: false, error: S.dead ? REPLACED : '连不上小窗服务' } }
  let j = null
  try { j = await r.json() } catch {}
  if (S.dead) return { ok: false, error: REPLACED }
  if (r.status === 403) A.token = null                       // 令牌 / cookie 作废了：下次重新拿
  // 服务器先回「在做」：先记上（它的 job 事件可能没收到，比如正在重连），不然「进行中」不挂、按钮也不灰
  if (j && typeof j === 'object' && j.job?.state === 'running') onJob(j.job)
  return j && typeof j === 'object' ? j : { ok: false, error: `小窗服务回了 ${r.status}` }
}
const jobFailed = (j) => j && j.state === 'done' && j.ok === false
/** 这件事最新的样子：「做完了」的 job 事件可能比 /api/act 的回应先到 —— 那就以事件为准 */
const latest = (j) => (j && typeof j.id === 'string' && A.jobs.get(j.id)?.state === 'done' ? A.jobs.get(j.id) : j)
const firstLine = (s) => clip(String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).pop() ?? '', 120)

// ── 聊天 ──
function showTab(which) {
  A.tab = which
  const chat = which === 'chat'
  E['tab-feed'].classList.toggle('on', !chat); E['tab-chat'].classList.toggle('on', chat)
  E['tab-feed'].setAttribute('aria-selected', String(!chat)); E['tab-chat'].setAttribute('aria-selected', String(chat))
  vis(E.feedwrap, !chat); vis(E.chatwrap, chat)
  if (chat) { for (const c of A.chat) if (c.reply) A.seen.add(c.id); paintBadge(); E.chatlog.scrollTop = E.chatlog.scrollHeight }
  else if (S.follow) scrollEnd()
}
function paintBadge() {
  const n = A.tab === 'chat' ? 0 : A.chat.filter((c) => c.reply && !A.seen.has(c.id)).length
  setText(E['chat-badge'], n ? String(n) : ''); vis(E['chat-badge'], n > 0)
}
function renderChat(list) {
  A.chat = (Array.isArray(list) ? list : []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string')
  // 第一次拿到的回复都算看过（开小窗之前的）；之后新来的回复在「聊天」上记未读
  if (!A.seeded) { A.seeded = true; for (const c of A.chat) if (c.reply) A.seen.add(c.id) }
  if (A.tab === 'chat') for (const c of A.chat) if (c.reply) A.seen.add(c.id)
  paintBadge()
  const key = JSON.stringify([S.hide, A.chat])
  if (key === A.chatKey) return
  A.chatKey = key
  const near = E.chatlog.scrollHeight - E.chatlog.scrollTop - E.chatlog.clientHeight < 60
  const masked = (t) => (S.hide ? '（遮住了）' : t)
  E.chatlog.replaceChildren(...A.chat.map((c) => {
    const box = el('div', 'ex')
    const me = el('div', 'msg me' + (S.hide ? ' masked' : ''))
    me.append(el('p', 'mt', masked(c.text)), el('time', 'mtime', hhmm(c.at)))
    box.append(me)
    const st = chatStateText(c)
    // 没做完的原因（服务器从出错信息里挑的一行）：可能带着她的话，跟着「遮住私话」
    if (st) box.append(el('p', 'mstate ' + (c.state === 'lost' || c.state === 'failed' ? 'bad' : 'wait'), st + (c.state === 'failed' && c.error ? '：' + masked(c.error) : '')))
    if (c.reply) {
      const her = el('div', 'msg her' + (S.hide ? ' masked' : ''))
      her.append(el('p', 'mt', masked(c.reply)), el('time', 'mtime', c.replyAt ? hhmm(c.replyAt) : ''))
      box.append(her)
    }
    return box
  }))
  vis(E['chat-empty'], A.chat.length === 0)
  if (near || A.tab !== 'chat') E.chatlog.scrollTop = E.chatlog.scrollHeight
}

// ── 输入框 + 按钮 ──
const hostOff = () => !S.snap?.host || S.snap.host.state === 'offline'
function sayStatus(msg, cls = '') { setText(E['say-st'], msg ?? ''); E['say-st'].className = 'say-st' + (cls ? ' ' + cls : '') }
function renderDock() {
  const off = hostOff() || S.lost
  vis(E['b-start'], Boolean(S.snap?.host) && S.snap.host.state === 'offline' && !S.lost)
  E.send.disabled = A.sending || S.lost
  E.say.placeholder = S.dead ? '这个窗口不能用了：从命令行重开' : S.lost ? '连不上小窗服务' : off ? '宿主没在跑：先点「启动宿主」，她才收得到' : '跟她说点什么…（Enter 发送，Shift+Enter 换行）'
  E['b-wake'].disabled = off || [...A.jobs.values()].some((j) => j.act === 'wake' && j.state === 'running')
  E['b-start'].disabled = S.lost || [...A.jobs.values()].some((j) => j.act === 'start' && j.state === 'running')
  E['b-review'].disabled = S.dead
  const n = reviewCount(S.snap?.today)
  setText(E['review-badge'], n ? String(n) : ''); vis(E['review-badge'], n > 0)
  E['b-review'].classList.toggle('hot', n > 0)
}
async function send() {
  const text = E.say.value.trim()
  if (!text || A.sending) return
  // 按字符数（emoji 算一个）：和服务器、cli 算的一样。不用 maxlength —— 它按 UTF-16 截，粘贴长的会悄悄截掉一截再发出去
  const n = [...text].length
  if (n > A.sayMax) { sayStatus(`太长了（${n} 字；一句最多 ${A.sayMax} 字）`, 'bad'); return }
  if (hostOff()) { sayStatus('宿主没在跑：先点「启动宿主」', 'bad'); return }
  // 发着的时候输入框只读：不然这时打的字会跟着「发出去了」一起被清掉
  A.sending = true; E.say.readOnly = true; renderDock(); sayStatus('正在交给她…')
  const r = await act({ act: 'say', text })
  A.sending = false; E.say.readOnly = false
  const job = r.ok ? latest(r.job) : r.job   // 不然「做完了」先到时这句会一直挂着「正在交给她…」
  if (r.ok && job && !jobFailed(job)) {
    E.say.value = ''; fitSay()
    // 15 秒还没做完（服务器先回了「在做」）：记着这句，最后没交上就放回输入框；做完了会由 job 事件说结果
    A.draft = job.state === 'running' ? { job: job.id, text } : null
    sayStatus(job.state === 'running' ? '正在交给她…' : firstLine(job.out) || '交给她了', job.state === 'running' ? '' : 'ok')
    showTab('chat')
  } else sayStatus(r.ok ? firstLine(job?.out) || '没交给她' : r.error || '没交给她', 'bad')
  renderDock()
}
// 高度 = 内容 + 上下边框（box-sizing: border-box：光用 scrollHeight 会差 2px，一行就出滚动条）
function fitSay() { E.say.style.height = 'auto'; E.say.style.height = Math.min(120, E.say.scrollHeight + ((E.say.offsetHeight - E.say.clientHeight) || 0)) + 'px' }
E.say.addEventListener('input', fitSay)
E.say.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send() }   // 输入法选字时的回车不算
})
E.send.addEventListener('click', send)
E['tab-feed'].addEventListener('click', () => showTab('feed'))
E['tab-chat'].addEventListener('click', () => showTab('chat'))
E['b-start'].addEventListener('click', async () => {
  sayStatus('正在启动宿主…')
  const r = await act({ act: 'start' })
  if (!r.ok) sayStatus(r.error || '没启动成', 'bad')
  else if (r.job?.state === 'done') { sayStatus(firstLine(r.job.out) || (r.job.ok ? '宿主起来了' : '没启动成'), r.job.ok ? 'ok' : 'bad'); soonPoll(500) }
  renderDock()
})
// 叫醒一轮大约 $1：点两下（第一下变成「再点一下叫醒」，4 秒内再点才算；半秒内的第二下是双击，不算）
E['b-wake'].addEventListener('click', async () => {
  const now = Date.now()
  if (now - A.wakeArmed > 4000) { A.wakeArmed = now; setText(E['b-wake'], '再点一下叫醒'); setTimeout(() => { if (Date.now() - A.wakeArmed >= 4000) setText(E['b-wake'], '叫醒她') }, 4100); return }
  if (now - A.wakeArmed < 500) return
  A.wakeArmed = 0; setText(E['b-wake'], '叫醒她')
  sayStatus('正在叫醒她…')
  const r = await act({ act: 'wake' })
  if (!r.ok) sayStatus(r.error || '没叫醒', 'bad')
  else if (r.job?.state === 'done') sayStatus(firstLine(r.job.out) || (r.job.ok ? '叫醒了' : '没叫醒'), r.job.ok ? 'ok' : 'bad')
  renderDock()
})

// ── 替你做的事做完了：提示一下（跟她说话的结果只在输入框底下说） ──
const REVIEW_ACTS = ['approve', 'reject', 'channel-approve', 'channel-reject']
function onJob(j) {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || S.dead) return
  // 已经做完的事不会再「进行中」：/api/jobs 的回应比 job 事件晚到时带的是旧状态，别让按钮一直灰着
  if (j.state !== 'done' && (A.jobs.get(j.id)?.state === 'done' || A.handled.has(j.id))) return
  A.jobs.set(j.id, j)
  if (A.jobs.size > 30) A.jobs.delete(A.jobs.keys().next().value)
  renderDock()
  const reviewAct = REVIEW_ACTS.includes(j.act)
  if (A.sheetOpen && A.review && reviewAct && j.state !== 'done') paintReview()   // 「进行中」挂上去；做完了下面会重读一遍
  if (j.state !== 'done' || A.handled.has(j.id)) return
  A.handled.add(j.id)
  if (A.handled.size > 200) A.handled.delete(A.handled.values().next().value)
  if (j.act === 'say') {
    const d = A.draft?.job === j.id ? A.draft : null
    if (d) A.draft = null
    if (j.ok) { sayStatus(firstLine(j.out) || '交给她了', 'ok'); return }
    sayStatus(firstLine(j.out) || '没交给她', 'bad')
    if (d && !E.say.value.trim()) { E.say.value = d.text; fitSay() }   // 没交上：那句放回输入框（你已经在打新的就不动）
    return
  }
  if (j.act === 'start') { sayStatus(firstLine(j.out) || (j.ok ? '宿主起来了' : '没启动成'), j.ok ? 'ok' : 'bad'); soonPoll(500); return }
  if (j.act === 'wake') { sayStatus(firstLine(j.out) || (j.ok ? '叫醒了' : '没叫醒'), j.ok ? 'ok' : 'bad'); return }
  if (j.act === 'play') { if (!j.ok) toast(`✗ ${clip(j.label || '', 60)}`, j.out, false); return }
  toast(`${j.ok ? '✓' : '✗'} ${clip(j.label || '', 60)}`, j.out, j.ok)
  // 等着结果的退回框：退成了关掉（频道设定退回后指纹不变，不清的话下次还开着）；没退成就留着，理由还在
  const rk = A.rejectJob.get(j.id)
  if (rk) { A.rejectJob.delete(j.id); if (j.ok) { A.openReject.delete(rk); A.drafts.delete(rk) } }
  A.notes.clear()                                       // 卡片底下「投稿中…」那种话：结果在右下角了
  if (A.sheetOpen && reviewAct) loadReview()
}
/**
 * 从服务器拿一份全的「替你做的事」（hello / 接回来时）：断开那会儿漏掉的 job 事件补上 —— 还在做的照样挂着「进行中」、按钮照样不能点，
 * 做完了没提示过的照样提示。第一次拿（刚开 / 刷新了页面）：之前做完的不重复提示，只提示 2 分钟内刚做完的审核（比如投稿时刷新了页面）
 */
async function syncJobs() {
  if (S.dead) return
  let list = null
  try { const r = await globalThis.fetch('/api/jobs', { cache: 'no-store', credentials: 'same-origin' }); if (r.ok) list = (await r.json())?.jobs } catch {}
  if (!Array.isArray(list) || S.dead) return
  const first = !A.jobsSynced
  A.jobsSynced = true
  for (const j of list) {
    if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue
    if (first && j.state === 'done' && !A.handled.has(j.id)) {
      A.handled.add(j.id); A.jobs.set(j.id, j)
      if (REVIEW_ACTS.includes(j.act) && Date.now() - toMs(j.endedAt) < 120_000) toast(`${j.ok ? '✓' : '✗'} ${clip(j.label || '', 60)}`, j.out, j.ok)
      continue
    }
    onJob(j)
  }
  renderDock()
  if (A.sheetOpen && A.review) paintReview()
}
function toast(head, out, ok) {
  setText(E['toast-h'], head); setText(E['toast-out'], out || ''); vis(E['toast-out'], Boolean(out))
  E.toast.classList.toggle('bad', !ok)
  vis(E.toast, true)
  clearTimeout(A.toastTimer)
  if (ok) A.toastTimer = setTimeout(() => vis(E.toast, false), 15_000)   // 出错的留着，等你看
}
E['toast-x'].addEventListener('click', () => { clearTimeout(A.toastTimer); vis(E.toast, false) })

// ── 审核面板 ──
async function loadReview() {
  if (S.dead) return
  try {
    const r = await globalThis.fetch('/api/review', { cache: 'no-store', credentials: 'same-origin' })
    A.review = r.ok ? await r.json() : { error: `读不出来（${r.status}）` }
  } catch { A.review = { error: '连不上小窗服务' } }
  if (A.sheetOpen) paintReview()
}
// 面板开着时，后面的页面（输入框、按钮）键盘也到不了：都设 inert（右下角的提示除外：结果要能关）
function setInert(on) { for (const c of [...(D.body?.children ?? [])]) if (c !== E.sheet && c !== E.toast) c.inert = on }
function openSheet() { if (S.dead) return; A.sheetOpen = true; vis(E.sheet, true); setInert(true); if (!A.review) E['sheet-body'].replaceChildren(el('p', 'dim', '正在读…')); loadReview(); E['sheet-x'].focus?.() }
function closeSheet() { A.sheetOpen = false; vis(E.sheet, false); setInert(false); E['b-review'].focus?.() }
E['b-review'].addEventListener('click', openSheet)
E['sheet-x'].addEventListener('click', closeSheet)
D.addEventListener('keydown', (e) => { if (e.key === 'Escape' && A.sheetOpen) closeSheet() })
const runningFor = (pred) => [...A.jobs.values()].find((j) => j.state === 'running' && pred(j))
const reviewBusy = () => runningFor((j) => REVIEW_ACTS.includes(j.act))   // 服务器同一时间只审一件：视频和频道设定都看这一个
const kv = (k, v, cls = '') => { const p = el('p', 'kv' + (cls ? ' ' + cls : '')); p.append(el('b', '', k), el('span', '', v)); return p }
const btn = (text, cls, on) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.addEventListener('click', on); return b }
// 卡片的「哪一版」：视频 = id + 这一轮交审的编号；频道设定 = 指纹。她重交了就是另一张卡片，旧的框和草稿不带过去
const vKey = (v) => `v:${v.id}|${v.sub ?? ''}`
const cKey = (ch) => `c:${ch.sha ?? ''}`
/** 卡片底下那句话（记在 A.notes 里：面板重画后还在） */
function noteFor(key) {
  const note = el('p', 'note small')
  const paint = (n) => { setText(note, n?.t ?? ''); note.className = 'note small' + (n?.cls ? ' ' + n.cls : ''); vis(note, Boolean(n?.t)) }
  paint(A.notes.get(key))
  A.notePaint.set(key, paint)
  // 说的时候卡片可能已经重画过（job 事件来得比按钮的回应早）：画到现在那张卡片上
  return { note, say: (t, cls = '') => { const n = { t, cls }; A.notes.set(key, n); (A.notePaint.get(key) ?? paint)(n) }, show: paint }
}
/**
 * 点了退回、服务器回了：退成了才关框（返回 true）。没退成 → 框和写好的理由留着，改一下再点；
 * 还在退（服务器 15 秒先回了「在做」）→ 也先留着，记下是哪张卡片的，做完了由 onJob 定：退成了关框，没退成留着
 */
function rejectDone(r, key, say) {
  if (!r.ok) { say(r.error, 'bad'); return false }
  const j = latest(r.job)
  if (j?.state === 'running') { A.rejectJob.set(j.id, key); say('退回中…'); return false }
  say(firstLine(j?.out) || '退回了', jobFailed(j) ? 'bad' : 'ok')
  return !jobFailed(j)
}
/** 退回框（视频 / 频道设定共用）：开着的框和里面的字记在 A 里，面板重画后照样开着 */
function rejectBox(key, slot, { rows, max, placeholder, send }) {
  let box = null
  const open = (focus) => {
    if (box) return
    A.openReject.add(key)
    box = el('div', 'reject')
    const ta = el('textarea', 'say small'); ta.rows = rows; ta.maxLength = max; ta.placeholder = placeholder
    ta.dataset.k = key; ta.value = A.drafts.get(key) ?? ''
    ta.addEventListener('input', () => A.drafts.set(key, ta.value))
    A.boxes.set(key, ta)
    const close = () => { A.openReject.delete(key); A.drafts.delete(key); A.boxes.delete(key); box?.remove(); box = null }
    const go = btn('退回', 'no', async () => {
      const text = ta.value.trim()
      if (!text) return ta.focus?.()
      go.disabled = true
      if (await send(text)) close()
      else go.disabled = Boolean(reviewBusy())   // 还在退（或别的在审）：先别让再点一次
    })
    if (reviewBusy()) go.disabled = true
    const acts = el('div', 'acts'); acts.append(go, btn('算了', '', close))
    box.append(ta, acts)
    slot.append(box)
    if (focus) ta.focus?.()
  }
  if (A.openReject.has(key)) open(false)
  return open
}

function paintReview() {
  const R = A.review, body = E['sheet-body']
  if (!R) return
  if (R.error) return body.replaceChildren(el('p', 'bad', R.error))
  const vids = Array.isArray(R.videos) ? R.videos : [], ch = R.channel && typeof R.channel === 'object' ? R.channel : null
  // 重画前记下光标在哪个退回框里（重画会换掉元素）：画完放回去
  const ae = D.activeElement, focusKey = typeof ae?.dataset?.k === 'string' ? ae.dataset.k : null
  const sel = focusKey ? [ae.selectionStart, ae.selectionEnd] : null
  // 已经不在单子上的卡片：它的框、草稿、确认、那句话都扔掉
  const keys = new Set([...vids.map(vKey), ...(ch ? [cKey(ch)] : [])])
  for (const k of [...A.openReject]) if (!keys.has(k)) A.openReject.delete(k)
  for (const m of [A.drafts, A.confirm, A.notes]) for (const k of [...m.keys()]) if (!keys.has(k)) m.delete(k)
  A.boxes = new Map(); A.notePaint = new Map()
  const out = []
  if (!vids.length && !(ch && (ch.state === 'waiting' || ch.kind === 'draft'))) out.push(el('p', 'dim', '没有等你审的视频，也没有等你确认的频道设定。'))
  for (const v of vids) out.push(videoCard(v))
  if (ch) out.push(channelCard(ch))
  out.push(el('p', 'dim small', '这里的按钮都是替你跑 node host/cli.mjs videos / channel，和在终端里一样。'))
  body.replaceChildren(...out)
  const ta = focusKey ? A.boxes.get(focusKey) : null
  if (ta) { ta.focus?.(); try { if (sel) ta.setSelectionRange(sel[0], sel[1]) } catch {} }
}

function videoCard(v) {
  const key = vKey(v)
  const card = el('section', 'card')
  card.append(el('h4', 'card-h', v.title || v.id))
  if (v.titleInvisible) card.append(el('p', 'warn small', '⚠️ 标题里有看不见的字符，这里没显示出来；发出去会原样带着'))
  const meta = [fmtSeconds(v.seconds), v.outfits?.length ? '换装：' + v.outfits.map(([k, o]) => `${k} 穿${o}`).join('、') : '', v.at ? '交审 ' + hhmm(v.at) : ''].filter(Boolean).join(' · ')
  if (meta) card.append(el('p', 'dim', meta))
  if (v.reason) card.append(kv('她为什么想发', v.reason))
  if (v.flags?.length) card.append(kv('⚠️ 和参考材料对得上（没拦，你看一下）', v.flags.join('；'), 'warn'))
  const refs = Array.isArray(v.references) ? (v.references.length ? `（也和参考材料${v.references.map((r) => `「${r}」`).join('')}比过）` : '（交审时还没有参考材料）') : ''
  card.append(kv('原创查重', (v.checked ? '通过' : '（老版本交的，没查）') + refs + (v.notes?.length ? ' · ⚠️ ' + v.notes.join('；') : '')))
  const cut = Boolean(v.meta?.descCut)
  if (v.meta) {
    const part = v.meta.part ? `（${v.meta.part}）` : v.meta.partKnown ? '（⚠️ 不是投稿用的子分区，上传前会被挡下）' : ''
    card.append(kv('分区 / 标签', `tid=${v.meta.tid ?? '?'}${part} · ${v.meta.tags?.length ? v.meta.tags.join(' / ') : '（无）'} / AI生成`))
    if (v.meta.tagsInvisible) card.append(el('p', 'warn small', '⚠️ 标签里有看不见的字符，这里没显示出来；发出去会原样带着'))
    const d = el('div', 'desc', v.meta.desc || '（空）')
    card.append(el('b', 'kh', `简介${cut ? `（共 ${v.meta.descLen} 字，只显示了前面）` : ''}：末尾会自动加 AI 创作声明`), d)
    if (v.meta.invisible) card.append(el('p', 'warn small', '⚠️ 简介里有看不见的字符（零宽 / 方向符号之类），这里没显示出来；发出去会原样带着'))
    if (v.meta.descDropped > 0) card.append(el('p', 'warn small', `⚠️ 她写的简介一共 ${v.meta.descLen} 字，B站 的简介放不下（还要留地方给 AI 创作声明）：后面 ${v.meta.descDropped} 字不会发出去。上面显示的就是会发出去的那一截`))
    if (cut) card.append(el('p', 'warn small', '⚠️ 简介太长，这里显示不全：不在小窗里投（看全了再在终端里投）'))
  } else card.append(el('p', 'warn', '⚠️ 读不到快照里的剧本'))
  if (v.history?.length) card.append(kv('她的作品记录（她写的，仅供参考）', v.history.join(' · '), 'dim'))
  if (!v.hasFile) card.append(el('p', 'warn', '⚠️ 找不到审片快照里的成片'))

  const busy = reviewBusy()
  const row = el('div', 'acts'), slot = el('div', 'slot')
  const { note, say, show } = noteFor(key)
  if (busy) show({ t: busy.act === 'approve' ? `「${busy.label}」进行中：上传 + 提交，视频大的话要几分钟…` : `「${busy.label}」进行中…` })
  const ids = { id: v.id, sub: v.sub ?? null }
  const play = btn('看片', '', async () => { const r = await act({ act: 'play', ...ids }); say(r.ok ? firstLine(r.job?.out) || '用默认播放器打开了' : r.error, r.ok && !jobFailed(r.job) ? '' : 'bad') })
  // 第二下：写清楚会发生什么，点「确认投稿」才真投（确认口令两分钟内有效、只能用一次）。面板重画后照样在
  const showConfirm = (c) => {
    const box = el('div', 'confirm')
    box.append(el('p', '', `会用她的 B站 号公开投稿《${c.title || v.title}》${fmtSeconds(c.seconds) ? `（${fmtSeconds(c.seconds)}）` : ''}。B站 还要审核，过了才公开。确认投稿？`))
    const drop = () => { if (A.confirm.get(key) === c) A.confirm.delete(key); box.remove() }
    const yes = btn('确认投稿', 'go', async () => {
      yes.disabled = true; no.disabled = true
      drop()
      const r2 = await act({ act: 'approve', ...ids, confirm: c.confirm })
      if (!r2.ok) return say(r2.error || '没投出去', 'bad')
      if (r2.job?.state === 'running') say('投稿中（上传 + 提交，视频大的话要几分钟）…结果会在这里和右下角提示')
      else say(firstLine(r2.job?.out) || (r2.job?.ok ? '投好了' : '没投出去'), r2.job?.ok ? 'ok' : 'bad')
    })
    const no = btn('算了', '', drop)
    if (busy) yes.disabled = true
    const acts = el('div', 'acts'); acts.append(yes, no); box.append(acts)
    slot.append(box)
    setTimeout(drop, Math.max(0, c.exp - Date.now()))   // 口令两分钟就过期：别留一个点了也没用的按钮
  }
  const approve = btn('投稿', 'go', async () => {
    approve.disabled = true
    const r = await act({ act: 'approve', ...ids })
    approve.disabled = false
    if (!r.ok || r.need !== 'confirm') return say(r.error || '没拿到确认', 'bad')
    const c = { confirm: r.confirm, title: r.title, seconds: r.seconds, exp: Date.now() + Math.min(115, Number(r.expiresInSec) || 115) * 1000 }
    A.confirm.set(key, c)
    paintReview()
  })
  const reject = btn('退回', 'no', () => openReject(true))
  const openReject = rejectBox(key, slot, {
    rows: 2, max: 200, placeholder: '退回的理由（最多 200 字；会写进她的作品记录，她下次能看到）',
    send: async (text) => {
      const r = await act({ act: 'reject', ...ids, text })
      return rejectDone(r, key, say)
    },
  })
  if (busy) { approve.disabled = true; reject.disabled = true }
  if (cut) approve.disabled = true
  row.append(play, approve, reject)
  card.append(row, slot, note)
  const c0 = A.confirm.get(key)
  if (c0 && c0.exp > Date.now()) showConfirm(c0)
  return card
}

function channelCard(ch) {
  const key = cKey(ch)
  const card = el('section', 'card')
  const stateText = { waiting: '等你确认（确认了她才能交审视频）', approved: '已确认', rejected: '你退回了，等她改了重新交', draft: '草稿：她还没交给你确认（确认不了）' }[ch.state] ?? ''
  card.append(el('h4', 'card-h', '她的频道设定'), el('p', ch.state === 'waiting' ? 'warn' : 'dim', stateText + (ch.at ? ` · ${hhmm(ch.at)} 交上来的` : '') + (ch.sha ? ` · 指纹 ${String(ch.sha).slice(0, 12)}` : '')))
  const cur = { missing: '⚠️ 她现在的频道设定文件不见了：交审视频会被拦，要她重新写、重新交', 'other-approved': '⚠️ 她现在文件里的是你以前确认过的另一版：交审视频按那一版算', other: '⚠️ 她现在文件里的和上面这版不一样：交审视频会被拦，要她重新交' }[ch.current]
  if (cur) card.append(el('p', 'warn small', cur))
  card.append(el('div', 'desc tall', ch.text || '（空）'))
  if (ch.cut) card.append(el('p', 'warn small', `⚠️ 共 ${ch.len} 字，这里只显示了前面：不在小窗里确认（全文：node host/cli.mjs channel）`))
  if (ch.invisible) card.append(el('p', 'warn small', '⚠️ 里面有看不见的字符（零宽 / 方向符号之类），这里没显示出来'))
  const row = el('div', 'acts'), slot = el('div', 'slot')
  const { note, say, show } = noteFor(key)
  const busy = reviewBusy()
  if (busy) show({ t: `「${busy.label}」进行中…` })
  if (ch.kind === 'submitted' && ch.state === 'waiting' && ch.sha) {
    const ok = btn('确认这一版', 'go', async () => {
      ok.disabled = true
      const r = await act({ act: 'channel-approve', sha: ch.sha })
      ok.disabled = false
      say(r.ok ? firstLine(r.job?.out) || '确认了' : r.error, r.ok && !jobFailed(r.job) ? 'ok' : 'bad')
    })
    if (busy || ch.cut) ok.disabled = true
    row.append(ok)
  }
  if (ch.kind === 'submitted' && ch.state !== 'rejected' && ch.sha) {
    const no = btn('退回（写意见）', 'no', () => openReject(true))
    const openReject = rejectBox(key, slot, {
      rows: 3, max: 2000, placeholder: '你的意见（写进她的 channel-feedback.md，她下次醒来照着改）',
      send: async (text) => {
        const r = await act({ act: 'channel-reject', sha: ch.sha, text })
        return rejectDone(r, key, say)
      },
    })
    if (busy) no.disabled = true
    row.append(no)
  }
  if (row.childElementCount ?? row.children?.length) card.append(row, slot, note)
  return card
}

// ─────────────── 连接 ───────────────
function setConn(msg) { if (S.dead && msg !== REPLACED) return; setText(E.conn, msg ?? ''); vis(E.conn, Boolean(msg)) }
let es = null, esRetry = 1000, esTimer = null, esBroken = false, esDropAt = 0
// 断线后浏览器自己重连（服务器说 3 秒一次），连上时先补发漏掉的 ev、再给 hello。这几秒里的轮询快照只有最近 150 条：
// 和见过的接不上（中间断了一截）就先不排进去 —— 排了 S.lastSeq 就越过了那一截，补发来的全会被当成旧的扔掉。重连一直不成（等太久）就照常排
const REPLAY_WAIT_MS = 8000
function awaitingReplay(feed) {
  if (!esBroken || es?.readyState !== 0 || !esDropAt || Date.now() - esDropAt > REPLAY_WAIT_MS) return false
  const lo = feed.reduce((m, e) => (Number.isFinite(e.seq) ? Math.min(m, e.seq) : m), Infinity)
  return lo !== Infinity && lo > S.lastSeq + 1
}
function connect() {
  clearTimeout(esTimer)
  if (S.dead) return
  S.helloOk = false; esDropAt = 0   // 新开的 EventSource 不带 Last-Event-ID：服务器不补发，没什么可等的
  try { es = new globalThis.EventSource('/events') } catch { return retryLater() }
  // 断线重连时服务器先补发漏掉的 ev、再给 hello（快照里只有最近 150 条）：hello 之前来的先攒着，hello 对过了才和快照一起排进去
  let early = []
  // hello 对过了（是这个窗口认的那个服务）才收这条连接上的 ev / chat / job：断线重连时，浏览器连上的可能已经不是原来那个服务
  es.addEventListener('hello', (m) => {
    if (S.dead) return
    const snap = parse(m.data)
    const pending = early; early = []
    if (S.viewerStart && snap?.viewer?.startedAt !== S.viewerStart) return die()
    if (pending.length && snap && typeof snap === 'object' && Array.isArray(snap.feed)) {
      const bySeqNo = new Map()
      for (const ev of [...pending, ...snap.feed]) if (okEvent(ev) && Number.isFinite(ev.seq)) bySeqNo.set(ev.seq, ev)
      snap.feed = [...bySeqNo.values()]
    }
    S.sseUp = true; esBroken = false; esRetry = 1000; esDropAt = 0; setConn(null)
    S.helloOk = onSnapshot(snap, 'hello')
  })
  es.addEventListener('ev', (m) => {
    if (S.dead) return
    const ev = parse(m.data)
    if (!S.helloOk) { if (okEvent(ev) && early.length < 600) early.push(ev); return }
    const now = Date.now(); heard(now); if (okEvent(ev)) accept(ev, now)
  })
  es.addEventListener('hb', () => { if (!S.dead) heard(Date.now()) })
  es.addEventListener('chat', (m) => { if (S.dead || !S.helloOk) return; heard(Date.now()); const d = parse(m.data); if (Array.isArray(d?.chat)) renderChat(d.chat) })
  es.addEventListener('job', (m) => { if (S.dead || !S.helloOk) return; heard(Date.now()); onJob(parse(m.data)) })
  es.addEventListener('error', () => {
    S.sseUp = false; esBroken = true; S.helloOk = false; early = []
    if (S.dead) return
    if (es.readyState === 2) { es.close(); retryLater(); poll() }   // 2 = CLOSED：浏览器不再自己重连（403 / 服务满了），我们隔一会儿再连
    else {
      // 浏览器自己在重连（服务器说 3 秒一次）：每次失败都会来这里。已经认定服务停了就别再改横幅 —— 不然两句话 3 秒一换。
      // 马上取一次快照：取不到（服务真停了）就认定停了，不用等满轮询的 10 秒
      if (!S.lost) setConn('和小窗服务断开了，正在重连…')
      if (!esDropAt) esDropAt = Date.now()   // 从第一次断开算：一直重连不成就别一直压着轮询来的动态
      soonPoll(1000)
    }
  })
}
function retryLater() { clearTimeout(esTimer); if (S.dead) return; esTimer = setTimeout(connect, esRetry); esRetry = Math.min(esRetry * 2, 30_000) }
const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

let pollTimer = null, pollDue = 0, polling = false
async function poll() {
  clearTimeout(pollTimer); pollTimer = null
  if (polling || S.dead) return  // 上一次还没回来：等它回来再排下一次，别排出两条轮询链
  polling = true
  const ac = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  const cut = setTimeout(() => { try { ac?.abort() } catch {} }, POLL_TIMEOUT_MS)
  try {
    const r = await globalThis.fetch('/api/live', { cache: 'no-store', credentials: 'same-origin', ...(ac ? { signal: ac.signal } : {}) })
    if (r.status === 401 || r.status === 403) lose(EXPIRED)        // 服务重启过，这个窗口的 cookie 作废了：手上那份快照也不能再当真
    else if (r.ok) { if (onSnapshot(await r.json(), 'poll') && esBroken && !S.sseUp) setConn('实时连接断了，先每几秒刷新一次…') }
    else if (!S.sseUp) lose(LOST)
  } catch { if (!S.sseUp) lose(LOST) } finally { clearTimeout(cut); polling = false }
  if (!D.hidden && !pollTimer && !S.dead) schedulePoll(S.sseUp ? 10_000 : 3000)
}
function schedulePoll(ms) { clearTimeout(pollTimer); if (S.dead) return; pollDue = Date.now() + ms; pollTimer = setTimeout(poll, ms) }
/** 早一点再取一次快照（已经排着更早的一次就不往后推） */
function soonPoll(ms = 2000) { if (D.hidden || polling || (pollTimer && pollDue <= Date.now() + ms)) return; schedulePoll(ms) }

// ─────────────── 交互 ───────────────
function paintEye() { E.eye.setAttribute('aria-pressed', S.hide ? 'true' : 'false'); E.eye.classList.toggle('on', S.hide) }
E.eye.addEventListener('click', () => {
  S.hide = !S.hide; saveHide(S.hide); paintEye()
  for (const g of S.groups.values()) for (const r of g.textRows) paintRow(r)
  A.chatKey = ''; renderChat(A.chat)
  render(Date.now())
})
E.feed.addEventListener('scroll', () => { S.follow = nearEnd(); if (S.follow && S.unseen) { S.unseen = 0; paintMore() } })
E.more.addEventListener('click', () => { S.follow = true; scrollEnd() })
E['cover-img'].addEventListener('error', () => {
  // 封面多半是还没下载完（debrief 才去抓）：记下失败时间，15 秒后再试；按出错那张图的地址认 BV，别把刚换上的另一条算成失败
  const bv = /\/cover\/(BV[0-9A-Za-z]{10})$/.exec(String(E['cover-img'].src ?? ''))?.[1]
  if (!bv) return
  S.coverFail.set(bv, Date.now())
  if (E.cover.dataset.bv === bv) { E.cover.dataset.bv = ''; vis(E.cover, false) }
})

// 窗口藏起来时停掉张嘴和计时（事件照收，回来时落后太多会直接跳到最新）
let loopTimer = null
function wake() { if (!loopTimer) loopTimer = setInterval(loop, 100); poll() }
function sleep() { clearInterval(loopTimer); loopTimer = null; clearTimeout(pollTimer); pollTimer = null; mouth(false) }
D.addEventListener('visibilitychange', () => (D.hidden ? sleep() : wake()))

paintEye()
renderToday()
renderDock()
fetchToken()
connect()
if (!D.hidden) wake()
