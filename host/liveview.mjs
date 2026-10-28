// 「她的小窗」的翻译层：她会话记录（claude-config/projects/<她的目录>/<uuid>.jsonl）里的一行 → 几条白名单里的中文短事件。
//   页面和桌宠只拿得到这里挑出来的事实：在看哪条视频、在写哪本日记、出没出错、她说了什么（≤80 字）。
//   为什么在服务端翻：原始行里有主人的私信原文（排队内容 / 提示词 / last-prompt / ai-title）、她的私密日记（Read 结果、Edit 前后文、
//   originalFile）、附件里的邮箱和组织号、整段工具输出和图片 base64 —— 这些一个字都不能到页面上。
// 规矩：
//   · 纯的：不碰文件。标题缓存里没有的 BV 问注入的 titleOf（服务端给的是看片记录 readWatch），时间用注入的 now
//   · 永不抛错：坏 JSON / 超长行 / 不认识的类型 → []（Claude Code 的记录格式不是稳定接口，随时会多出新类型、改字段）
//   · 只取认识的字段：toolUseResult 整个不看；工具输出只从几种结构化结果里抠标题和条数，别的原样丢掉
//   · 出去的每个字符串：clean()（控制 / 方向 / 零宽字符）→ 路径只留文件名 → 去掉 base64 → redact()（凭据样子）→ ≤80 字；
//     抹完还认得出凭据字样的，整条事件丢掉（宁可少一行，也不冒险）
//   · 不从 dashboard.mjs 拿 clean/redact：这里多了零宽字符、路径、更多凭据样式；而且这个模块要能单独加载、单独测（不拉起面板那一堆依赖）
//   · 可拔掉的模块自己的回合标签、字幕（host/<模块>-live.mjs，什么都不 import）：文件在才认识。这里不碰文件系统，所以不看报到单，
//     只看那个文件 import 不 import 得到：找不到 = 模块没装；别的错照样抛（和以前写死在这里时一样，坏了就是坏了）
export const VIEW_VERSION = 1
export const MAX_LINE = 4 * 1024 * 1024          // 和读记录那边的单行上限一样：带图片的行实测近 1 MB
export const EXPRS = ['neutral', '浅笑', '困', '想事情', '别扭', '低落', '小吃惊']
export const EVENT_KINDS = ['turn_start', 'thinking', 'tool_start', 'tool_end', 'said', 'retry', 'denied', 'turn_end', 'note']
export const GLYPHS = ['看', '写', '发', '想', '错', '找', '记', '做', '读']
export const ACTIVITIES = ['watch', 'read', 'write', 'send', 'think', 'search', 'make', 'other']

const MAX = 80, TITLE_MAX = 40
const BV_RE = /BV[0-9A-Za-z]{10}/
const BV_ONLY = /^BV[0-9A-Za-z]{10}$/
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$/
const DROP_RE = /SESSDATA|bili_jct|cookie|token|secret|password|api[-_]?key/i
const PRIVATE_DIARY_RE = /whale-diary-private/i
const PRIVATE_CAP = { read: '在翻只给自己看的日记', write: '在写只给自己看的日记' }   // 碰到私密日记：只有这一句，别的（路径、字数、内容）一概不出
const RESULT_SCAN = 512 * 1024                   // 抠标题只看结果的前 512 KB（debrief 一般几十 KB）

// ─────────────── 净化 ───────────────
/** 截短但不劈开代理对（emoji / 生僻字），截了的话末尾带「…」，总长 ≤ n */
function cut(s, n) {
  if (s.length <= n) return s
  let out = ''
  for (const ch of s) { if (out.length + ch.length > n - 1) break; out += ch }
  return out + '…'
}
/** 别人（和她）写的字：零宽 / 方向标记直接去掉（看不见，却能把字的顺序搅乱、把凭据字样拆开躲过检查），控制字符换成空格，空白并成一个，再截短 */
export function clean(s, n = MAX) {
  const t = String(s ?? '')
    .replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u061c\u180e\u00ad]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return cut(t, n)
}
/** 凭据样子的值抹成 ***（工具本身不打印这些；字幕地址里的 auth_key/upsig/deadline、Cookie 头、DedeUserID、buvid 是 B站 接口会带的） */
// 值只吃 ASCII、到分隔符为止：凭据都是 ASCII；不然「…upsig=***》的字幕」会把后面的中文一起吞掉
const V = String.raw`[^\s&"',;<>()\[\]{}\u0080-￿]+`
const R_SESS = new RegExp(String.raw`SESSDATA\s*[=:]\s*${V}`, 'gi'), R_JCT = new RegExp(String.raw`bili_jct\s*[=:]\s*${V}`, 'gi')
const R_DEDE = new RegExp(String.raw`DedeUserID(__ckMd5)?\s*[=:]\s*${V}`, 'gi'), R_BUVID = new RegExp(String.raw`buvid\w*\s*[=:]\s*${V}`, 'gi')
const R_KV = new RegExp(String.raw`(auth_key|upsig|deadline|csrf(?:_token)?|access_(?:token|key)|refresh_token|sendkey|w_rid|token|secret|key|sign)=${V}`, 'gi')
export function redact(s) {
  return String(s ?? '')
    .replace(R_SESS, 'SESSDATA=***')
    .replace(R_JCT, 'bili_jct=***')
    .replace(R_DEDE, 'DedeUserID=***')
    .replace(R_BUVID, 'buvid=***')
    .replace(/\b(Set-)?Cookie\s*:[^\n]*/gi, 'Cookie: ***')
    .replace(R_KV, '$1=***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
}
const base = (p) => String(p ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? ''
/** 完整路径只留文件名（C:\Users\<名字>\… 会带出主人的用户名和目录结构）；网址不动 */
function unpath(s) {
  return s
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|*?]*/g, base)
    .replace(/\\\\[^\s"'<>|*?]+/g, base)
    .replace(/[^\s"'<>|]*\\[^\s"'<>|]*/g, base)
    // 只认像文件系统的开头（~/、/Users/、/home/、/c/ …）：「猫/狗/鸟」「AI/ML/DL」这种正文里的斜杠不动
    .replace(/(?<![\w:/.~-])(?:~|\/(?:Users|home|root|tmp|mnt|var|etc|opt|private|[a-z]))(?:\/[^\s/"'<>|]+)+\/?/g, base)
}
const unb64 = (s) => s.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '…')   // 一长串 base64（图片、密钥）：正常的字不会 60 个字符不带空格和标点
const scrub = (v, n) => clean(redact(unpath(unb64(clean(v, Infinity)))), n)
/** 视频标题：别人写的；抹完还带凭据字样的不用（不然整条事件都会被丢掉，退回光秃秃的 BV 号更好） */
function goodTitle(t) {
  if (typeof t !== 'string') return null
  const s = scrub(t, TITLE_MAX)
  return s && s !== '?' && !DROP_RE.test(s) ? s : null
}

/** 出门前最后一道：只留认识的字段、每个字符串 ≤80、还认得出凭据字样就整条丢（返回 null）。服务端自己拼的事件也走这里 */
export function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object' || !EVENT_KINDS.includes(ev.kind)) return null
  const out = { kind: ev.kind, turn: typeof ev.turn === 'string' ? scrub(ev.turn, MAX) || null : null }
  if (typeof ev.t === 'string' && ISO_RE.test(ev.t)) out.t = ev.t
  const cap = typeof ev.cap === 'string' ? scrub(ev.cap, MAX) : ''
  if (!cap) return null
  out.cap = cap
  for (const k of ['sub', 'text']) if (typeof ev[k] === 'string') { const s = scrub(ev[k], MAX); if (s) out[k] = s }
  if (GLYPHS.includes(ev.glyph)) out.glyph = ev.glyph
  if (ACTIVITIES.includes(ev.activity)) out.activity = ev.activity
  if (typeof ev.bv === 'string' && BV_ONLY.test(ev.bv)) out.bv = ev.bv
  if (ev.seen === true && out.bv) out.seen = true          // 这一下算「看了这条」（字幕 / 评论 / 画面都算）：回合小结的「看了 N 条」按它数
  if (typeof ev.title === 'string') { const s = scrub(ev.title, TITLE_MAX); if (s) out.title = s }
  if (typeof ev.ok === 'boolean') out.ok = ev.ok
  if (typeof ev.toolId === 'string' && /^[\w-]{1,80}$/.test(ev.toolId)) out.toolId = ev.toolId
  if (ev.private === true) out.private = true
  for (const k of ['steps', 'tokens', 'costUsd', 'durationMs']) if (typeof ev[k] === 'number' && Number.isFinite(ev[k]) && ev[k] >= 0) out[k] = ev[k]
  for (const v of Object.values(out)) if (typeof v === 'string' && DROP_RE.test(v)) return null
  return out
}

// ─────────────── 回合种类（只看宿主给的 id 前缀；提示词里有主人的私信，不看） ───────────────
// chat- 是这里自己起的「假回合」：主人 cli open 当面聊，宿主那边没有回合（没有 running.json），不能把聊天记到上一个早就做完的回合底下
// bili-whale-win- 是主人在小窗里说的一句（cli say 投的，见 host/winchat.mjs）
// 模块的回合（host/<模块>-live.mjs 的 kind：re / kind / label，插在 after 说的那一种后面；前缀互不重叠，位置只为好读）：
//   owner = 主人找她的（和私信一样对待）；private = 她说的多半在复述别人的原话（隐私上和主人的回合一样）；privateArgs = 连评论 / 动态 / 弹幕里抄的字也标 private
async function liveHook(file) {
  try { return await import(new URL(file, import.meta.url).href) } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e?.message ?? '').includes(file.slice(2))) return null; throw e }
}
const LIVE_HOOKS = [await liveHook('./qq-live.mjs'), await liveHook('./sdm-live.mjs')].filter(Boolean)
const MOD_KINDS = LIVE_HOOKS.map((m) => m.kind).filter(Boolean)
/** 模块的字幕：子命令 → (pos, opt, { R, said, MAX, go }) → 字幕（核心的子命令不让模块改） */
const MOD_CAPTIONS = Object.assign({}, ...LIVE_HOOKS.map((m) => m.captions ?? {}))
const KINDS = [[/^bili-whale-dm-/, 'dm', '你发来私信'], [/^bili-whale-win-/, 'win', '你在小窗里找她'],
  [/^bili-whale-web-/, 'web', '她在读书'],
  [/^bili-whale-listen-/, 'listen', '有人找她'], [/^bili-whale-live-/, 'live', '直播间有人喊她'],
  [/^bili-whale-preview-/, 'preview', '预览'], [/^bili-whale-\d+$/, 'night', '按作息醒来'], [/^manual-/, 'manual', '你叫醒了她'], [/^chat-\d+$/, 'chat', '你在和她当面聊']]
for (const k of MOD_KINDS) { const i = KINDS.findIndex(([, x]) => x === k.after); KINDS.splice(i < 0 ? KINDS.length : i + 1, 0, [k.re, k.kind, k.label]) }
const modKind = (kind) => MOD_KINDS.find((k) => k.kind === kind) ?? null
export function kindOf(id) {
  for (const [re, kind, kindLabel] of KINDS) if (re.test(String(id ?? ''))) return { kind, kindLabel }
  // 宿主起的、这里认不出来的回合（bili-whale-<种类>-…：模块的回合，可这一份没装那个模块 / 它的 -live.mjs）：
  //   不知道里面是谁的话 —— 隐私上按最紧的算（她说的、参数里抄的都标 private），名字也不说
  if (/^bili-whale-[a-z]+-/.test(String(id ?? ''))) return { kind: 'unknown', kindLabel: '她醒了' }
  return { kind: 'other', kindLabel: '她醒了' }
}
/** 主人找她的回合（B站 私信 / 小窗，和模块登记了 owner 的）：里面说的多半在复述主人的私话 —— 隐私上一样对待 */
export const isOwnerKind = (kind) => kind === 'dm' || kind === 'win' || modKind(kind)?.owner === true
// 模块登记了 private 的回合：她嘴上、参数里说的多半在复述别人的原话 —— 隐私上和主人的回合一样（标 private），
// 但不算进 isOwnerKind：那个还管着「你的私信到了」（排队时的气泡）、小窗里「你的私信」的个数，别人的不能算成主人的
// 读书回合（2026-10-28）：她嘴上、参数里说的多半是网页上的字 —— 也标 private（页面「遮住私话」时遮住，桌宠不念）
const isPrivKind = (kind) => isOwnerKind(kind) || modKind(kind)?.private === true || kind === 'web' || kind === 'unknown'
/** 抄进参数里的字一律标 private 的回合（模块登记了 privateArgs 的、读书回合、认不出来的） */
const privArgsKind = (kind) => modKind(kind)?.privateArgs === true || kind === 'web' || kind === 'unknown'
const isChat = (id) => typeof id === 'string' && /^chat-\d+$/.test(id)
const CHAT_GAP_MS = 30 * 60_000   // 当面聊隔了半小时以上又开口：当成新的一场

// ─────────────── 命令行 ───────────────
/** 宽松地切词（只为认出 node bili.mjs <子命令> 和参数；放不放行是 bash-gate 的事） */
function words(cmd) {
  const out = []
  let w = '', has = false, q = null
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]
    if (q) {
      if (ch === q) q = null
      else if (q === '"' && ch === '\\' && i + 1 < cmd.length) w += cmd[++i]
      else w += ch
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; has = true } else if (/\s/.test(ch)) { if (has) out.push(w); w = ''; has = false } else { w += ch; has = true }
  }
  if (has) out.push(w)
  return out
}
// 这些开关后面不跟值：`debrief --no-frames BV…` 里的 BV 不是 --no-frames 的值
const BOOL = new Set(['go', 'dry', 'no-frames', 'share', 'status', 'list', 'auto', 'json', 'uniform', 'only-owner', 'only-unread', 'owner', 'test'])
/** node bili.mjs <sub> … → { sub, pos, opt, bv }；不是这个形状 → null */
function parseBili(command) {
  if (typeof command !== 'string' || command.length > 64 * 1024) return null
  const w = words(command.trim())
  if (w[0] !== 'node' && !/(^|[\\/])node(\.exe)?$/i.test(w[0] ?? '')) return null
  if (!/(^|[\\/])bili\.mjs$/.test(w[1] ?? '')) return null
  const [sub = 'help', ...rest] = w.slice(2)
  const pos = [], opt = {}
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const k = a.slice(2), eq = k.indexOf('=')
    if (eq > 0) opt[k.slice(0, eq)] = k.slice(eq + 1)
    else if (BOOL.has(k) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) opt[k] = true
    else opt[k] = rest[++i]
  }
  return { sub, pos, opt, bv: BV_RE.exec(command)?.[0] ?? null }
}
const str = (v) => (typeof v === 'string' ? v : '')

// ─────────────── 字幕表（一个工具调用 → 一句话） ───────────────
const touchesPrivate = (inp) => ['file_path', 'path', 'notebook_path', 'pattern', 'glob', 'command'].some((k) => typeof inp[k] === 'string' && PRIVATE_DIARY_RE.test(inp[k]))
/** 视频怎么称呼：有标题用《标题》，没有就光秃秃的 BV 号（标题到了以后的事件会换上） */
const vname = (bv, t, dflt = '视频') => (t ? `《${t}》` : bv ? ` ${bv} ` : dflt)
/** 一段原话 → { text, private? }（空的 → {}）；页面在字幕下面引出来，标了 private 的「遮住私话」能遮 */
const quote = (v, n, priv) => (typeof v === 'string' && v.trim() ? { text: cut(clean(v, Infinity), n), ...(priv ? { private: true } : {}) } : {})
// diary log 的种类是她随手写的英文词：认得的换成中文，不认得的不进 cap（见 bashCaption 开头的规矩）
const DIARY_KIND = { night: '今晚醒来的事', 'night-skip': '今晚只写日记', dm: '私信的事', event: '一件事' }

/**
 * 工具调用 → { cap, sub?, glyph, activity, bv?, title?, seen?, private?, text? }。
 * ctx：titleOf(bv) 查标题；dm（这一回合是主人私信 → 「在回你的私信」）；
 *      owner（主人起的回合：私信 / 当面聊 / 还不知道是谁的 —— 她从参数里抄的字可能就是主人的原话 → text 标 private；不给就跟着 dm；
 *      模块登记了 private 的回合也给 true：抄的是别人的原话）；privAll（privArgsKind 的回合：连评论 / 动态 / 弹幕里抄的字也标 private）；
 *      studioTitleOf(id) 查作品名。
 * cap 只用这张表里的固定说法 + B站 上的视频标题：cap 会进快照、桌宠也念，而桌宠没有「遮住私话」。
 */
export function captionFor(toolName, input, ctx = {}) {
  try {
    const r = caption(String(toolName ?? ''), input && typeof input === 'object' ? input : {}, ctx ?? {})
    return { ...r, cap: clean(r.cap) }            // 「在看 BV… 」这种拼出来的空白收一收
  } catch { return { cap: '在用工具', glyph: '做', activity: 'other' } }
}
function caption(name, inp, ctx) {
  const ask = (fn, k) => { try { return k ? goodTitle(fn?.(k)) : null } catch { return null } }
  const titleOf = (bv) => ask(ctx.titleOf, bv)
  if (touchesPrivate(inp)) return /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name) ? { cap: PRIVATE_CAP.write, glyph: '写', activity: 'write' } : { cap: PRIVATE_CAP.read, glyph: '读', activity: 'read' }
  if (name === 'Bash') return bashCaption(inp, ctx, titleOf, (id) => ask(ctx.studioTitleOf, id))
  if (/^(Read|Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return fileCaption(name, str(inp.file_path || inp.notebook_path || inp.path), titleOf, ctx)
  if (name === 'Glob' || name === 'Grep') return { cap: '在翻找东西', glyph: '找', activity: 'search' }
  if (name === 'TodoWrite') return { cap: Array.isArray(inp.todos) ? `在列待办（${inp.todos.length} 项）` : '在列待办', glyph: '想', activity: 'think' }
  if (name === 'Task' || name === 'Agent') return { cap: '在叫帮手', glyph: '做', activity: 'other' }
  if (name === 'WebSearch' || name === 'WebFetch') return { cap: '在上网查东西', glyph: '找', activity: 'search' }
  const short = name.split('__').pop()
  return { cap: /^[A-Za-z0-9_-]{1,30}$/.test(short) ? `在用工具 ${short}` : '在用工具', glyph: '做', activity: 'other' }
}

/**
 * 读 / 改文件的字幕。主人起的回合（ctx.owner，规矩同 bashCaption）：文件名可能是她照主人的原话起的（「把我说的写进 xxx.md」）——
 * 那种回合不把文件名放进 cap（cap 进快照、桌宠也念，桌宠遮不住），只说「在读一个文件」，文件名放进 text、标 private（小窗里「遮住私话」能遮）
 */
function fileCaption(tool, p, titleOf, ctx = {}) {
  const owner = ctx.owner === true || (ctx.owner === undefined && ctx.dm === true)
  const b = base(p), norm = p.replace(/\\/g, '/'), bv = BV_RE.exec(b)?.[0] ?? null, t = bv ? titleOf(bv) : null
  // 这里的 V 只用在封面 / 画面 / 字幕上：都算「看了这条」
  const V = (cap, glyph, activity) => ({ cap, glyph, activity, ...(bv ? { bv, seen: true } : {}), ...(t ? { title: t } : {}) })
  const fname = cut(b, 40) || '文件'
  if (tool === 'Read') {
    if (/^whale-diary\.md$/i.test(b)) return { cap: '在翻日记', glyph: '读', activity: 'read' }
    if (/^channel.*\.md$/i.test(b)) return { cap: '在看频道设定', glyph: '读', activity: 'read' }
    if (/\/shots\/covers\//i.test(norm)) return V(`在看${vname(bv, t)}的封面`, '看', 'watch')
    if (/\/shots\/video\//i.test(norm)) return /(subs|strip)[^/]*\.(jpe?g|png)$/i.test(b) ? V('在看字幕条', '看', 'watch') : V(`在看${vname(bv, t)}的画面`, '看', 'watch')
    if (/\/shots\/subs\//i.test(norm)) return V(`在读${vname(bv, t)}的字幕`, '读', 'read')
    if (/\/shots\/comment-img\//i.test(norm)) return { cap: '在看评论里附的图', glyph: '看', activity: 'watch' }
    if (b === 'script.json') return { cap: '在看剧本', glyph: '读', activity: 'read' }
    if (/\.(jpe?g|png|gif|webp)$/i.test(b)) return owner ? { cap: '在看一张图', glyph: '看', activity: 'watch', ...quote(b, 40, true) } : { cap: `在看图 ${fname}`, glyph: '看', activity: 'watch' }
    return owner ? { cap: '在读一个文件', glyph: '读', activity: 'read', ...quote(b, 40, true) } : { cap: `在读 ${fname}`, glyph: '读', activity: 'read' }
  }
  const edit = tool !== 'Write'
  if (/^whale-diary\.md$/i.test(b)) return { cap: '在写日记', glyph: '写', activity: 'write' }
  if (/^channel.*\.md$/i.test(b)) return { cap: edit ? '在改频道设定' : '在写频道设定', glyph: '写', activity: 'write' }
  if (b === 'script.json') return { cap: '在写剧本', glyph: '写', activity: 'write' }
  if (owner) return { cap: edit ? '在改一个文件' : '在写一个文件', glyph: '写', activity: 'write', ...quote(b, 40, true) }
  return { cap: `${edit ? '在改' : '在写'} ${fname}`, glyph: '写', activity: 'write' }
}

// 规矩：她从命令参数里抄来的字（搜索词、新作品的名字、diary log 的种类、英文的命令说明）一个都不进 cap ——
//   主人私信说「帮我搜一下 <词>」，她就会把这几个字原样填进 search；cap 进快照、桌宠在桌面上念出来，又遮不住。
//   cap 一律用固定说法（在搜视频 / 开了新作品 / 在记一笔），原话放 text：主人起的回合（私信 / 当面聊）标 private，「遮住私话」能遮
function bashCaption(inp, ctx, titleOf, studioTitleOf) {
  const owner = ctx.owner === true || (ctx.owner === undefined && ctx.dm === true)
  const a = parseBili(inp.command)
  if (!a) {
    // 不是她的工具链：用模型自己写的英文说明当小字（只有 bili.mjs 能跑，这种多半会被拦下）；主人起的回合里它也可能转述主人的话 → 改放 text 标 private
    const d = str(inp.description)
    return { cap: '在跑一条命令', glyph: '做', activity: 'other', ...(d ? (owner ? quote(d, MAX, true) : { sub: d }) : {}) }
  }
  const { sub, pos, opt } = a, go = opt.go === true, dry = opt.dry === true
  const bv = a.bv, t = bv ? titleOf(bv) : null, V = vname(bv, t)
  const R = (cap, glyph, activity, more = {}) => ({ cap, glyph, activity, ...more })
  const RV = (cap, glyph, activity, more = {}) => ({ cap, glyph, activity, ...(bv ? { bv } : {}), ...(t ? { title: t } : {}), ...more })
  // 看这条视频本身（画面 / 字幕 / 评论 / 回想）：回合小结「看了 N 条」数的是这些 —— 只读字幕的 --no-frames 是她筛视频的主力，不能不算
  const SEEN = bv ? { seen: true } : {}
  // ctx.privAll（别人私信她、她在读书的回合）：抄进参数里的字一律标 private —— 评论 / 动态 / 弹幕那几条在这种回合里总会被拦下，可她抄进去的多半是别人的原话
  //   ctx.sdm 是以前的名字：外面照旧这么传的也算
  const said = (v, n, priv) => quote(v, n, priv || ctx.privAll === true || ctx.sdm === true)
  const own = (v, n) => quote(v, n, owner)
  switch (sub) {
    case 'feed': return R('在挑今天看什么', '找', 'search')
    case 'search': return R('在搜视频', '找', 'search', own(str(pos[0] ?? opt.kw), 40))
    case 'debrief': return opt['no-frames'] ? RV(`在读${V}的字幕和评论`, '读', 'read', SEEN) : RV(`在看${V}`, '看', 'watch', SEEN)
    case 'watch-video': return RV(`在抽帧看${V}`, '看', 'watch', SEEN)
    case 'subtitles': return RV(`在读${V}的字幕`, '读', 'read', SEEN)
    case 'video': return RV(`在了解${V}讲什么`, '读', 'read', SEEN)
    case 'comments': return RV(`在翻${V}的评论区`, '读', 'read', SEEN)
    case 'watched':
      if (pos[0] === 'show') return RV(`在回想${V}`, '想', 'think', SEEN)
      if (pos[0] === 'note') return RV(`在记下对${V}的理解`, '记', 'write', SEEN)
      return R('在翻看片记录', '读', 'read')
    case 'comment-digest': return R('在看今天谁找过她', '读', 'read')
    case 'comment-images': return R('在看评论里附的图', '看', 'watch')
    case 'thread': case 'check-comment': case 'check-dynamic': case 'check-mention': return R('在核对刚发的东西', '读', 'read')
    case 'watch': return R('在等评论下的新回复', '看', 'other')
    case 'comment-await': return R('在等评论区有人回她', '看', 'other')
    case 'await': return R('在直播间等人喊她', '看', 'other')
    case 'dm-await': return R('在等私信', '看', 'other')
    case 'recon': return RV('发评论前在看评论区', '读', 'read', SEEN)
    case 'likes': return R('在看谁赞了她', '读', 'read')
    case 'comment': {
      const reply = opt.root !== undefined || opt.parent !== undefined
      // --type 11 / 17 是动态（图文 / 纯文字）下面的评论，不是视频
      const onDyn = /^(11|17)$/.test(String(opt.type ?? ''))
      // 公开评论：发出去谁都看得到，带前 40 字；草稿可能不发，不带
      if (go) return RV(reply ? '在回复评论' : onDyn ? '在评论动态' : `在评论${V}`, '发', 'send', said(opt.message ?? opt.msg ?? opt.text, 40))
      return RV(reply ? '在打回复草稿' : '在打评论草稿', '写', 'write')
    }
    case 'reply-draft':
      if (pos[0] === 'add') return RV('写了条回复等你审', '写', 'send')
      if (pos[0] === 'drop') return R('撤回了一条待审回复', '写', 'other')
      return R('在看待审的回复', '读', 'read')
    // 删 / 发之类的写操作模板都要她先 --dry 一遍：只有 --go 才是真动手（不然每条都会显示成「发」两次、嘴还跟着动）
    case 'comment-del': return go ? R('在删自己的评论', '发', 'send') : R('在打删评论的草稿', '写', 'write')
    case 'fav':
      if (opt.list) return R('在翻收藏夹', '读', 'read')
      if (opt.check !== undefined) return RV(`在看收藏过${V}没有`, '找', 'search')
      return go ? RV(`收藏了${V}`, '记', 'other') : RV(`想收藏${V}`, '想', 'think')
    case 'dynamic':
      if (pos[0] === 'post') return go ? R('在发动态', '发', 'send', said(opt.text, 40)) : R('在打动态草稿', '写', 'write')
      if (pos[0] === 'rm') return go ? R('在删动态', '发', 'send') : R('在打删动态的草稿', '写', 'write')
      return R('在看自己的动态', '读', 'read')
    case 'dynamic-image': return go ? R('在发图文动态', '发', 'send', said(opt.text, 40)) : R('在打图文动态草稿', '写', 'write')
    case 'dynamic-edit': return go ? R('在改动态', '发', 'send') : R('在打改动态的草稿', '写', 'write')
    case 'danmaku':
      if (pos[0] === 'send') return go ? R('在发弹幕', '发', 'send', said(opt.msg, 40)) : R('在打弹幕草稿', '写', 'write')
      if (pos[0] === 'live') return R('在直播间看弹幕', '看', 'watch')
      if (pos[0] === 'history') return R('在回看直播间弹幕', '读', 'read')
      return R('在看直播间能不能发弹幕', '读', 'read')
    case 'dm':
      // 给主人的话：默认显示，「遮住私话」时由页面遮住 —— 所以一律标 private
      if (opt.status) return R('在看私信通道', '读', 'read')
      // 分享也一样：没 --go 只是预检（dm.mjs 不给 --dry / --go 直接退出）
      if (opt.share) return go ? RV(`在把${V}分享给你`, '发', 'send', said(opt.msg, MAX, true)) : RV(`在打分享${V}的私信草稿`, '写', 'write', said(opt.msg, MAX, true))
      if (go) return R(ctx.dm ? '在回你的私信' : '在给你发私信', '发', 'send', said(opt.msg, MAX, true))
      if (dry || opt.msg !== undefined) return R('在打给你的私信草稿', '写', 'write', said(opt.msg, MAX, true))
      return R('在看私信通道', '读', 'read')
    case 'notify':
      if (opt.test) return R('在发测试通知', '发', 'other')
      // notify 不带开关就是真发；--dry 只算报文（总结提醒里叫她先 --dry 一遍，不然每次报备都像发了两次）
      if (dry) return R('在打给你的报备草稿', '写', 'write', said(pos[0], MAX, true))
      return R('在给你报备', '发', 'send', said(pos[0], MAX, true))
    // 读书（2026-10-28）：搜索词、网页、笔记都不进 cap（cap 进快照、桌宠也念）—— 只说在干什么
    case 'web':
      if (pos[0] === 'search') return R('在搜想读的东西', '读', 'read')
      if (pos[0] === 'open') return R('在打开一页', '读', 'read')
      return R('在往下读', '读', 'read')
    case 'note': return R('在记读书笔记', '记', 'write')
    case 'read-request': return go ? R('写了一条想读的东西', '记', 'write') : R('在想读点什么', '想', 'think')
    case 'quota': return pos[0] === 'react' ? R('在看你有没有表态', '读', 'read') : R('在看今天还能说几句', '读', 'read')
    case 'memory': return /^(note|correct|forget|done)$/.test(pos[0] ?? '') ? R('在记观众小本本', '记', 'write') : R('在回想这位观众', '想', 'think')
    case 'diary': {
      if (pos[0] !== 'log') return R('在翻今天的日记', '读', 'read')
      const k = str(pos[1]), cn = Object.hasOwn(DIARY_KIND, k) ? DIARY_KIND[k] : null
      return R(cn ? `在记一笔：${cn}` : '在记一笔', '记', 'write', cn ? {} : own(k, 20))
    }
    case 'night': return R('在看今晚的作息', '读', 'read')
    case 'studio': {
      // 作品名是她 studio new --title 时自己起的（可能照搬主人的话）：和搜索词一样只进 text
      const id = str(pos[1]), st = id ? studioTitleOf(id) : null
      switch (pos[0]) {
        case 'channel': return pos[1] === 'submit' ? R('把频道设定交给你确认', '发', 'send') : R('在看自己的频道设定', '读', 'read')
        case 'new': return R('开了新作品', '做', 'make', own(str(opt.title), 40))
        case 'cast': return R('在挑角色和衣服', '做', 'make')
        case 'check': return R('在查重', '做', 'make')
        case 'render': return R('在做视频', '做', 'make', { sub: '做视频要几分钟', ...own(st ?? '', 40) })
        case 'submit': return R('把作品交给你审', '发', 'send', own(st ?? '', 40))
        case 'stats': return R('在看自己视频的数据', '读', 'read')
        case 'voices': return R('在挑音色', '做', 'make')
        default: return R('在翻自己的作品', '读', 'read')
      }
    }
    // session 只是看自己登的是哪个号；selftest / deps 是查工具链 —— 都不是「开机」
    case 'session': return R('在确认自己登的是哪个号', '读', 'read')
    case 'selftest': case 'deps': return R('在做体检', '做', 'other')
    case 'whois': return R('在查 TA 是谁', '找', 'search')
    case 'covers': return RV('在抓封面', '看', 'watch', SEEN)
    default:
      // 模块登记的子命令（host/<模块>-live.mjs 的 captions）：装了才认识
      if (Object.hasOwn(MOD_CAPTIONS, sub)) return MOD_CAPTIONS[sub](pos, opt, { R, said, MAX, go })
      return R('在查工具怎么用', '读', 'other')
  }
}

// ─────────────── 从结构化结果里抠标题 / 条数（别的输出一律不出去） ───────────────
// feed：`  N. BV…  <时长>s  弹幕…  播放…  <标题≤40>  @UP …`
const FEED_ROW = /^\s*\d+\.\s+(BV[0-9A-Za-z]{10})\s+\S+s\s+弹幕\s*\S+\s+播放\s*\S+\s{2}(.+?)\s{2}@/
function feedRows(text) {
  const out = []
  for (const l of text.split('\n')) {
    const bv = /^\s*\d+\.\s+(BV[0-9A-Za-z]{10})\s/.exec(l)?.[1]
    if (bv) out.push([bv, FEED_ROW.exec(l)?.[2] ?? null])
  }
  return out
}
// search：`[n] <标题>` 下一行 `    BV=<bvid>  UP=…`
function searchRows(text) {
  const out = []
  let title = null
  for (const l of text.split('\n')) {
    const t = /^\[\d+\] (.*)$/.exec(l)
    if (t) { title = t[1]; continue }
    const b = /^\s+BV=(BV[0-9A-Za-z]{10})\b/.exec(l)
    if (b) { out.push([b[1], title]); title = null }
  }
  return out
}
function resultText(content) {
  if (typeof content === 'string') return content.slice(0, RESULT_SCAN)
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').slice(0, RESULT_SCAN)   // 图片（base64）不碰
}
const DENY_RE = /PreToolUse:\w+ hook|\[主人的白名单\] 拒绝|doesn't want to proceed with this tool use|tool use was rejected/i
const isDenied = (block, line, text) => /^(reject|deny|denied)$/i.test(String(line?.permissionDecision?.decision ?? '')) || (block?.is_error === true && DENY_RE.test(text.slice(0, 2000)))
// 「新 token」：输入 + 输出 + 新写进缓存的；不算缓存重读 —— 每一步都把整段上下文重读一遍，算进去一回合动辄「138 万」，
// 九成是一折价的重读，跟花了多少钱对不上（主人要看的是这一回合在烧多少）
const tokensOf = (u) => ['input_tokens', 'output_tokens', 'cache_creation_input_tokens'].reduce((s, k) => s + (Number.isFinite(u?.[k]) && u[k] > 0 ? u[k] : 0), 0)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const r6 = (x) => Math.round(x * 1e6) / 1e6
const toIso = (v) => {
  if (typeof v === 'string' && ISO_RE.test(v)) return v
  const d = new Date(typeof v === 'number' ? v : NaN)
  return isNaN(d) ? undefined : d.toISOString()
}

// ─────────────── 翻译器 ───────────────
/**
 * createTranslator({ titleOf, now }) → {
 *   feed(rawLine, { turnId }) → Event[]   按文件顺序喂；turnId 是服务端从 running.json 知道的回合 id。
 *                                         它只是提示：计数（步数 / token / 进行中的工具）只在记录里的 enqueue 处清零，回合头每个 id 只出一次
 *   inflight()  → [{ toolId, cap, bv?, title?, since, activity }]   发了调用还没结果的
 *   usage()     → { steps, tokens }   这一回合：模型回了几次（按 message.id）、用了多少新 token（输入 + 输出 + 写缓存，不算缓存重读；每个 message.id 只算一次）
 *   turnStart({ id, at, sub? }) / turnEnd({ id, ok?, costUsd?, durationMs?, at? }) → Event[]   服务端从 running.json / logs 补的回合头尾；每个回合各只出一次
 *   recent(n)   → 最近出的事件（带 rx = 服务端收到的时刻，给 stateOf 算「刚刚」用；记录要晚 2–25 秒才落盘，不能拿 t 算）
 *   settle()    → 把到目前为止的事件的 rx 改成它们自己的时间（t）。服务端开机重放完旧记录调一次：
 *                 不然重放出来的「出错 / 说话 / 回合做完」都像是刚刚发生的，一开小窗她就别扭 4 秒、嘴动、低落一小时
 *   studio()    → 这一回合最近碰过的作品 id（换装跟着作品走用）
 *   reset()     → 从头再来（文件换了 / 变短了）；只留 BV → 标题这种事实
 * }
 * 主人 cli open 当面聊：宿主没有回合（提示 id 为空）时冒出来的提示词行（不是 SDK 发的）→ 起一个假回合 chat-<毫秒>（「你在和她当面聊」），
 * 聊天里的事件记在它底下，不挂到上一个早就做完的回合上；它没有回合尾（日志里没有它），宿主的下一个回合来了就换过去。
 */
export function createTranslator({ titleOf = () => null, now = () => Date.now() } = {}) {
  const titles = new Map()        // BV → 标题（结构化结果里抠的，最可信）
  const misses = new Map()        // BV → 这之前别再问 titleOf（看片记录在 debrief 开始后一秒左右才有标题）
  const studios = new Map()       // 作品 id → 标题
  let seen, started, ended, costs, log, seg
  const fresh = (turn = null) => ({ turn, msgs: new Map(), tools: new Map(), done: new Set(), orphans: new Map(), saidKeys: new Set(),
    lastKind: null, lastStop: null, startTs: undefined, lastTs: undefined, sessionId: null, turnIndex: null, studio: null })
  const reset = () => { seen = new Map(); started = new Map(); ended = new Map(); costs = new Map(); log = []; seg = fresh() }
  reset()

  const remember = (map, k, v, cap) => { map.delete(k); map.set(k, v); if (map.size > cap) map.delete(map.keys().next().value) }
  function putTitle(bv, t) { const g = BV_ONLY.test(bv ?? '') ? goodTitle(t) : null; if (g) remember(titles, bv, g, 2000) }
  function titleFor(bv) {
    if (!bv) return null
    if (titles.has(bv)) return titles.get(bv)
    const n = now()
    if ((misses.get(bv) ?? 0) > n) return null
    let t = null
    try { t = goodTitle(titleOf(bv)) } catch {}
    if (t) { remember(titles, bv, t, 2000); misses.delete(bv) } else remember(misses, bv, n + 5000, 500)
    return t
  }
  // owner：主人起的回合（私信 / 当面聊 / 还没认出是谁的）—— 她这时从参数里抄的字可能就是主人的原话；
  //   模块登记了 private 的回合也一样（抄的是别人的原话），但 dm 不算（「在回你的私信」只说主人的）
  const ctxFor = () => { const k = kindOf(seg.turn).kind; return { titleOf: titleFor, dm: isOwnerKind(k), owner: isPrivKind(k) || k === 'chat' || !seg.turn, privAll: privArgsKind(k), studioTitleOf: (id) => studios.get(id) ?? null } }
  const capOf = (tool) => (tool.priv ? captionFor(tool.name, { file_path: 'whale-diary-private.md' }) : captionFor(tool.name, tool.input, ctxFor()))

  function finish(ev) {
    const out = sanitizeEvent({ turn: seg.turn, ...ev })
    if (!out) return null
    seg.lastKind = out.kind
    log.push({ ...out, rx: now() })
    if (log.length > 200) log.splice(0, log.length - 200)
    return out
  }
  /** 回合头：每个回合 id 只出一次（服务端按 running.json 补的、记录里的 enqueue、按提示认下的，谁先到算谁） */
  function header(id, ts, sub) {
    if (!id || started.has(id)) return []
    remember(started, id, true, 200)
    return [{ kind: 'turn_start', turn: id, t: ts, cap: kindOf(id).kindLabel, ...(sub ? { sub } : {}) }]
  }
  /** 记录里的 enqueue = 新一段：计数全清。id 不知道（主人 cli open 当面聊 / 那一刻 running.json 没读到）就先空着，后面的提示再认 */
  function begin(id, ts) {
    // 当面聊的时候她还在回上一句、主人又打了一句（排进队）：还是同一场聊天，不另起一组
    const keep = !id && isChat(seg.turn) ? seg.turn : null
    seg = fresh(id ?? keep)
    seg.startTs = ts
    seg.lastTs = ts
    return keep ? [] : header(id, ts)
  }
  /** 当面聊的提示词：宿主没有回合（没有提示 id）、不是 SDK 发的、眼下这一段没有主或者它的回合已经结束（或者上一场聊天隔了半小时以上） */
  function chatPrompt(o, ts, hint) {
    if (hint || o.promptSource === 'sdk' || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return false
    // 回合进行中的非 SDK 文字行（压缩摘要之类）不算：只在这一段已经没主 / 结束了才另起，免得把正在跑的回合拦腰截断
    if (seg.turn && !ended.has(seg.turn) && !isChat(seg.turn)) return false
    if (isChat(seg.turn) && !(Date.parse(ts ?? '') - Date.parse(seg.lastTs ?? '') > CHAT_GAP_MS)) return false
    const c = o.message?.content
    if (typeof c === 'string') return Boolean(c.trim())
    // 带图片 / 粘贴的提示词会存成几块；中断提示「[Request interrupted …]」不算
    return Array.isArray(c) && c.length > 0 && c.every((b) => b?.type === 'text' || b?.type === 'image') && c.some((b) => b?.type === 'text' && str(b.text).trim() && !/^\[Request interrupted/.test(str(b.text)))
  }
  function startChat(ts) {
    const at = Date.parse(ts ?? '')
    const id = `chat-${Number.isFinite(at) ? at : Math.round(now())}`
    seg = fresh(id)
    seg.startTs = ts
    seg.lastTs = ts
    return header(id, ts)
  }
  function endEvent({ ok, costUsd, durationMs, t } = {}, withUsage = true) {
    remember(ended, seg.turn, true, 200)
    seg.tools.clear()                     // 没等到结果的不再算「进行中」
    const u = withUsage ? usage() : {}
    return { kind: 'turn_end', t, cap: ok === false ? '这回合没做完' : '这回合做完了', ...(typeof ok === 'boolean' ? { ok } : {}), steps: u.steps, tokens: u.tokens, costUsd, durationMs }
  }
  function usage() {
    let tokens = 0
    for (const n of seg.msgs.values()) tokens += n
    return { steps: seg.msgs.size, tokens }
  }

  function toolStart(b, ts) {
    const toolId = typeof b.id === 'string' ? b.id : ''
    if (!toolId || seg.tools.has(toolId) || seg.done.has(toolId)) return []
    const inp = b.input && typeof b.input === 'object' ? b.input : {}
    const name = typeof b.name === 'string' ? b.name : ''
    // 只留字幕表要用的几样：Write 的整篇内容、Edit 的前后文（可能就是私密日记）不留在内存里
    const tool = { toolId, name, since: ts ?? toIso(now()), priv: touchesPrivate(inp),
      input: { command: str(inp.command).slice(0, 64 * 1024), description: str(inp.description).slice(0, 500), file_path: str(inp.file_path || inp.notebook_path || inp.path).slice(0, 2048), ...(Array.isArray(inp.todos) ? { todos: { length: inp.todos.length } } : {}) } }
    tool.bili = name === 'Bash' && !tool.priv ? parseBili(tool.input.command) : null
    if (tool.bili?.sub === 'studio' && /^(render|check|submit|show)$/.test(tool.bili.pos[0] ?? '') && /^[0-9A-Za-z_-]{3,80}$/.test(tool.bili.pos[1] ?? '')) seg.studio = tool.bili.pos[1]
    const sp = /[\\/]studio[\\/]([0-9A-Za-z_-]{3,80})[\\/]script\.json$/.exec(tool.input.file_path)
    if (sp && !tool.priv) seg.studio = sp[1]
    seg.tools.set(toolId, tool)
    const c = capOf(tool)
    const out = [{ kind: 'tool_start', toolId, t: tool.since, ...c }]
    const early = seg.orphans.get(toolId)         // 结果比调用先到（文件里的顺序不总是时间顺序）
    if (early) { seg.orphans.delete(toolId); out.push(...toolEnd(toolId, early)) }
    return out
  }
  function toolEnd(toolId, r) {
    const tool = seg.tools.get(toolId)
    seg.tools.delete(toolId)
    seg.done.add(toolId)
    if (r.denied) return [{ kind: 'denied', toolId, t: r.ts, cap: '想跑一条不允许的命令，被拦下了', glyph: '错', ok: false }]
    if (tool.priv) return [{ kind: 'tool_end', toolId, t: r.ts, ...capOf(tool), ok: !r.isError }]   // 私密日记：还是只有那一句
    if (tool.bili) learn(tool.bili, r.text)
    const c = capOf(tool)                         // 标题这时可能刚知道（debrief 的「标题:」）→ 换上
    const exit = /^Exit code (\d{1,3})\b/.exec(r.text)?.[1]
    return [{ kind: 'tool_end', toolId, t: r.ts, cap: (!r.isError && resultCap(tool.bili, r.text)) || c.cap, glyph: r.isError ? '错' : c.glyph, activity: c.activity,
      ...(c.bv ? { bv: c.bv } : {}), ...(c.title ? { title: c.title } : {}), ok: !r.isError, ...(r.isError ? { sub: exit ? `出错了（退出码 ${exit}）` : '出错了' } : {}) }]
  }
  function learn(a, text) {
    switch (a.sub) {
      case 'feed': for (const [bv, t] of feedRows(text)) putTitle(bv, t); break
      case 'search': for (const [bv, t] of searchRows(text)) putTitle(bv, t); break
      case 'debrief': { const m = /^标题: (.+)$/m.exec(text); if (m && a.bv) putTitle(a.bv, m[1]); break }
      case 'watched': for (const m of text.matchAll(/(BV[0-9A-Za-z]{10}) 《([^》\n]+)》/g)) putTitle(m[1], m[2]); break
      case 'comments': { const m = /^评论「(.+)」\s*$/m.exec(text), bv = /^BV=(BV[0-9A-Za-z]{10})/m.exec(text)?.[1] ?? a.bv; if (m && bv) putTitle(bv, m[1]); break }
      case 'studio': {
        const id = /新作品 ([0-9A-Za-z_-]{3,80})/.exec(text)?.[1], t = goodTitle(str(a.opt.title))
        if (a.pos[0] === 'new' && id) { seg.studio = id; if (t) remember(studios, id, t, 200) }
        break
      }
    }
  }
  function resultCap(a, text) {
    if (!a) return null
    if (a.sub === 'feed') { const n = feedRows(text).length; return n ? `挑了 ${n} 条候选` : '今天没挑到候选' }
    if (a.sub === 'search') { const n = searchRows(text).length; return n ? `搜到 ${n} 条` : '没搜到' }
    if (a.sub === 'debrief') {
      const nf = a.opt['no-frames'] === true, t = titleFor(a.bv)
      const subs = /^有字幕：/m.test(text) ? '字幕✓' : /^✗[^\n]*字幕/m.test(text) ? '字幕✗' : ''
      const pic = nf ? '' : /^SHEET/m.test(text) ? '画面✓' : /抽帧失败/.test(text) ? '画面✗' : ''
      const marks = [subs, pic].filter(Boolean).join(' ')
      return `${nf ? '读完了' : '看完了'}${vname(a.bv, t)}${marks ? `（${marks}）` : ''}`
    }
    return null
  }
  function said(text, stop, mid, ts) {
    if (typeof text !== 'string' || !text.trim() || text.trim() === '(no content)') return []
    const k = `${mid}\u0000${text}`
    if (seg.saidKeys.has(k)) return []
    seg.saidKeys.add(k)
    // 主人找她的回合、不是宿主回合（cli open 当面聊）、一回合最后那句（stop_reason 不是 tool_use 就当是最后一句）→ 是对主人说的，标 private；
    // isPrivKind 的回合（别人私信她、读书）里中间的自言自语也标（她在想怎么回，转述的是别人的原话）
    const priv = isPrivKind(kindOf(seg.turn).kind) || !seg.turn || isChat(seg.turn) || stop !== 'tool_use'
    return [{ kind: 'said', t: ts, cap: '她说', text, ...(priv ? { private: true } : {}) }]
  }

  function assistant(o, ts) {
    const m = o.message && typeof o.message === 'object' ? o.message : {}
    const mid = typeof m.id === 'string' ? m.id : typeof o.uuid === 'string' ? o.uuid : null
    if (typeof m.stop_reason === 'string') seg.lastStop = m.stop_reason
    seg.lastKind = 'assistant'
    const content = Array.isArray(m.content) ? m.content : []
    if (o.isApiErrorMessage === true || m.model === '<synthetic>') {
      // Claude Code 自己补的「API Error …」不是她说的话
      return o.isApiErrorMessage === true || content.some((b) => /API Error|error/i.test(str(b?.text))) ? [{ kind: 'note', t: ts, cap: '模型接口出错了', glyph: '错' }] : []
    }
    if (mid) { const n = tokensOf(m.usage); if (!seg.msgs.has(mid) || n > seg.msgs.get(mid)) seg.msgs.set(mid, n) }   // 同一回复的每一块都带同一份 usage：只算一次
    const out = []
    for (const b of content) {
      if (b?.type === 'text') out.push(...said(b.text, m.stop_reason, mid, ts))
      else if (b?.type === 'tool_use') out.push(...toolStart(b, ts))
    }
    return out
  }
  function user(o, ts, hint) {
    if (o.isMeta === true) return []                              // 图片说明之类，不是提示词也不是结果
    const tp = o.turnPosition
    // 提示词（宿主的 / 主人当面说的）：一个字都不出；主人当面聊的那种只起一个假回合头
    const chat = chatPrompt(o, ts, hint) ? startChat(ts) : []
    if (typeof o.message?.content === 'string' || chat.length) { if (Number.isFinite(tp?.turnIndex)) seg.turnIndex = tp.turnIndex; return chat }
    const out = []
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b?.type !== 'tool_result') continue                     // 用户行里的文字块 = 主人说的话 / 中断提示：不出
      const text = resultText(b.content)
      const r = { isError: b.is_error === true, text, denied: isDenied(b, o, text), ts }
      const toolId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
      if (toolId && seg.tools.has(toolId)) out.push(...toolEnd(toolId, r))
      else if (toolId && !seg.done.has(toolId)) remember(seg.orphans, toolId, { ...r, text: text.slice(0, 64 * 1024) }, 200)
      else if (!toolId && r.denied) out.push({ kind: 'denied', t: ts, cap: '想跑一条不允许的命令，被拦下了', glyph: '错', ok: false })
    }
    return out
  }
  function costState(o) {
    const sid = typeof o.sessionId === 'string' ? o.sessionId : seg.sessionId ?? '?'
    const usd = num(o.totalCostUSD), dur = num(o.totalDuration), prev = costs.get(sid)
    if (usd !== null || dur !== null) remember(costs, sid, { usd, dur }, 50)   // 当面聊也记：同一会话下一个宿主回合的花费要减掉它
    if (!seg.turn || ended.has(seg.turn) || isChat(seg.turn)) { seg.tools.clear(); return [] }   // 当面聊没有「这回合做完了」
    // 这一行的累计 − 同一会话上一回合的累计（cost-state 和 logs 的 costUsd 一样是会话累计）；会话第一回合 = 累计本身；不知道上一回合就不报
    let costUsd
    if (usd !== null && prev?.usd != null) costUsd = r6(usd >= prev.usd ? usd - prev.usd : usd)
    else if (usd !== null && seg.turnIndex === 1) costUsd = r6(usd)
    let durationMs
    if (dur !== null && prev?.dur != null && dur >= prev.dur) durationMs = Math.round(dur - prev.dur)
    else if (seg.startTs && seg.lastTs) { const d = Date.parse(seg.lastTs) - Date.parse(seg.startTs); if (d >= 0) durationMs = d }
    return [endEvent({ ok: seg.lastStop === 'end_turn' ? true : undefined, costUsd, durationMs, t: seg.lastTs })]
  }

  function feed(rawLine, { turnId } = {}) {
    try {
      if (typeof rawLine !== 'string' || rawLine.length > MAX_LINE) return []
      const s = rawLine.trim()
      if (!s.startsWith('{')) return []
      let o
      try { o = JSON.parse(s) } catch { return [] }
      if (!o || typeof o !== 'object' || Array.isArray(o)) return []
      if (typeof o.uuid === 'string') { if (seen.has(o.uuid)) return []; remember(seen, o.uuid, true, 20000) }   // 同一行喂了两遍
      // 回合以记录里的 enqueue 为界，turnId 只是提示：已经结束的回合 id 再来，多半是服务端还没读到新的 running.json
      const hint = typeof turnId === 'string' && turnId && !ended.has(turnId) ? turnId : null
      const ts = typeof o.timestamp === 'string' && ISO_RE.test(o.timestamp) ? o.timestamp : undefined
      let evs = []
      if (hint && !(o.type === 'queue-operation' && o.operation === 'enqueue')) {
        if (!seg.turn) { seg.turn = hint; evs = header(hint, seg.startTs ?? ts) }
        // 当面聊着、宿主的回合来了（running.json 先到，enqueue 还没落盘）：换成宿主的回合，聊天的计数不带过去
        else if (isChat(seg.turn)) { seg = fresh(hint); seg.startTs = ts; seg.lastTs = ts; evs = header(hint, ts) }
      }
      switch (o.type) {
        case 'queue-operation': if (o.operation === 'enqueue') evs = begin(hint, ts); break   // 内容（整段提示词）不看
        case 'api-request':
          // 起标题、压缩之类的旁路请求不算她在想
          if (seg.lastKind !== 'thinking' && !/title|suggest|summar|compact|classif|hook|topic|memory/i.test(str(o.querySource))) evs.push({ kind: 'thinking', t: ts, cap: '在想…', glyph: '想', activity: 'think' })
          break
        case 'assistant': evs.push(...assistant(o, ts)); break
        case 'user': evs.push(...user(o, ts, hint)); break
        case 'system':
          if (o.subtype === 'api_error') {
            const a = o.retryAttempt ?? o.attempt, m = o.maxRetries ?? o.max_retries
            evs.push({ kind: 'retry', t: ts, cap: Number.isInteger(a) && Number.isInteger(m) ? `网络不太顺，重试中（${a}/${m}）` : '网络不太顺，重试中', glyph: '错' })
          } else if (o.subtype === 'compact_boundary') evs.push({ kind: 'note', t: ts, cap: '在整理前面的对话', glyph: '想' })
          break
        case 'cost-state': evs.push(...costState(o)); break
        default: break                    // attachment / api-request-blob / -shape / last-prompt / ai-title / atis-latch / mode / file-history-* / 不认识的
      }
      if (ts) seg.lastTs = ts             // 放在后面：enqueue 会换一个新的回合状态
      if (typeof o.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(o.sessionId)) seg.sessionId = o.sessionId
      return evs.map(finish).filter(Boolean)
    } catch { return [] }
  }

  return {
    feed,
    inflight() {
      const out = []
      for (const tool of seg.tools.values()) {
        const c = capOf(tool)
        const e = sanitizeEvent({ kind: 'note', turn: null, cap: c.cap, bv: c.bv, title: c.title, activity: c.activity })
        out.push(e ? { toolId: tool.toolId, cap: e.cap, ...(e.bv ? { bv: e.bv } : {}), ...(e.title ? { title: e.title } : {}), since: tool.since, activity: e.activity ?? 'other' }
          : { toolId: tool.toolId, cap: '在用工具', since: tool.since, activity: 'other' })
      }
      return out.sort((a, b) => String(a.since).localeCompare(String(b.since)))
    },
    usage,
    // running.json 出现：先补回合头（记录要晚几秒才有 enqueue）；眼下这一段还没认主就认下它，计数不清（清零只看 enqueue）
    turnStart({ id, at, sub } = {}) {
      try {
        if (typeof id !== 'string' || !id || ended.has(id)) return []
        if (!seg.turn) seg.turn = id
        return header(id, toIso(at) ?? toIso(now()), typeof sub === 'string' ? sub : undefined).map(finish).filter(Boolean)
      } catch { return [] }
    },
    turnEnd({ id, ok, costUsd, durationMs, at } = {}) {
      try {
        if (typeof id !== 'string' || !id || ended.has(id)) return []
        const info = { ok: typeof ok === 'boolean' ? ok : undefined, costUsd: num(costUsd) ?? undefined, durationMs: num(durationMs) ?? undefined }
        if (seg.turn === id) { const ev = finish(endEvent({ ...info, t: toIso(at) ?? seg.lastTs })); return ev ? [ev] : [] }
        // 不是眼下这一段（早翻过去了 / 根本没见过它的记录）：步数和 token 不知道，就不报
        const keep = seg
        seg = fresh(id)
        const ev = finish(endEvent({ ...info, t: toIso(at) }, false))
        seg = keep
        return ev ? [ev] : []
      } catch { return [] }
    },
    recent(n = 50) { return log.slice(-Math.max(0, n)).map((e) => ({ ...e })) },
    settle() { for (const e of log) { const t = Date.parse(e.t ?? ''); e.rx = Number.isFinite(t) ? t : 0 } },
    studio() { return seg.studio },
    reset,
  }
}

// ─────────────── 状态 → 表情（服务端算好，页面和桌宠只管画） ───────────────
const TALK_MS_PER_CHAR = 120, TALK_MAX_MS = 6000, OOPS_MS = 4000, START_MS = 1500, DONE_MS = 3000, SAD_MS = 3600_000
const NIGHT_MS = 12 * 3600_000   // 「今晚的」：计划所在那段窗口已经开了，或者 12 小时内就开（同一晚分两段的窗口）；再远就是明晚的事
const when = (x) => (typeof x === 'number' ? x : Date.parse(x ?? ''))
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 某个时刻怎么说（按本地日历，不按 24 小时算）：「02:10」（今晚后半夜 / 今天）、「今晚 20:30」（后半夜看是「明晚 20:30」）、「明早 07:30」、「明天 14:00」、「明晚 20:00」、
 * 「明天凌晨 03:36」、「后天 20:00」、「11月3日 20:00」。光写 HH:MM 的话「03:30 醒 · 还有 26:09:59」读着像一小时后。
 * 用正午相减再四舍五入：夏令时那天 23 / 25 小时也算一天
 */
export function whenText(atMs, now = Date.now()) {
  const a = new Date(when(atMs)), n = new Date(when(now))
  if (isNaN(a) || isNaN(n)) return ''
  const t = `${pad2(a.getHours())}:${pad2(a.getMinutes())}`, h = a.getHours()
  const noon = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  const d = Math.round((noon(a) - noon(n)) / 86_400_000)
  // 后半夜（06:00 前）还算昨晚那一夜：02:20 刚醒过、气泡说「今晚的事做完了」，同一屏再说「今晚 21:00 醒」就自相矛盾 —— 今天傍晚那次是「明晚」
  if (d <= 0) return h >= 18 && n.getHours() < 18 ? `${n.getHours() < 6 ? '明晚' : '今晚'} ${t}` : t
  if (d === 1) {
    if (h < 6) return a - n < NIGHT_MS ? t : `明天凌晨 ${t}`        // 今晚过了零点那一段：照常只说钟点
    return h < 12 ? `明早 ${t}` : h >= 18 ? `明晚 ${t}` : `明天 ${t}`
  }
  if (d === 2) return `后天 ${t}`
  return `${a.getMonth() + 1}月${a.getDate()}日 ${t}`
}
const rxOf = (e) => (Number.isFinite(e?.rx) ? e.rx : when(e?.t))
const talkMs = (e) => Math.min(TALK_MAX_MS, TALK_MS_PER_CHAR * [...String(e?.text ?? e?.cap ?? '')].length)
const ACT_STATE = { watch: ['watching', '浅笑'], read: ['reading', '浅笑'], search: ['searching', '浅笑'], write: ['writing', '浅笑'], send: ['replying', '浅笑'],
  make: ['making', '浅笑'], think: ['thinking', '想事情'], other: ['working', 'neutral'] }

/** 想要的表情没有这张图：退到 neutral，再退到第一张 */
export function pickExpr(want, available) {
  const list = Array.isArray(available) ? available : []
  return list.includes(want) ? want : list.includes('neutral') ? 'neutral' : list[0] ?? null
}

/**
 * 她现在什么状态 → { state, expr, talking, caption }。
 *   host：{ state: 'online'|'offline'|'paused' }；turn：正在跑的回合 { id, at } 或 null；inflight：translator.inflight()；
 *   recent：translator.recent()（带 rx）；plan：作息计划 { atMs, action: wake|skip|done, startsAt?（这次计划所在那段窗口的开始毫秒）, woke?（done 时：这一晚醒过没有） } 或 null；
 *   inWindow：现在在不在任何一段醒的窗口里（服务端用 night-plan 的 inWindow(cfg.night, now) 算；也认 plan.windowOpen）。
 *     不给（undefined）= 不知道：照旧的样子（有计划就「在睡觉」）；
 *   queued：排着没跑的回合（数字 / id 数组 / { dm, total }）；chatting：主人正 cli open 当面聊；
 *   lastTurn：{ id, ok, endedAt?（结束时刻；不给就用 at —— 结果日志的 at 就是结束时刻） }；
 *   since：小窗服务什么时候开始看的（毫秒 / ISO）：那之前就结束的回合不再闪「这回合做完了」；
 *   exprs：可选，这套衣服有的表情（给了就顺便 pickExpr）
 * 回合之间的几种：
 *   day        不在任何窗口里（比如 18:00–06:00 那一档的白天）：neutral，「白天不醒，私信随时能叫醒她」，页面不画 zz、不呼吸
 *   asleep     在窗口里、今晚还有一次没醒：困 + zz，「在睡觉 · 02:10 醒」（只写日记的那种带「（只写日记）」）
 *   night_done 在窗口里、今晚的事已经做完（计划是 done，或者下一次在明晚）：困，不画 zz，「在睡觉 · 今晚的事做完了」
 */
export function stateOf({ host, turn, inflight = [], recent = [], plan, queued, chatting, lastTurn, inWindow, since, now = Date.now(), exprs } = {}) {
  const R = (state, expr, caption, talking = false) => ({ state, expr: exprs ? pickExpr(expr, exprs) : expr, talking, caption })
  const evs = (Array.isArray(recent) ? recent : []).filter((e) => e && typeof e === 'object')
  const age = (e) => now - rxOf(e)
  const latest = (list, f) => { for (let i = list.length - 1; i >= 0; i -= 1) if (f(list[i])) return list[i]; return null }
  // 嘴动：最近一句「她说」或发出去的话，按字数给时间（120 毫秒一个字，最多 6 秒）
  const talkingEv = (list) => { const e = latest(list, (x) => x.kind === 'said' || (x.kind === 'tool_start' && x.activity === 'send')); return e && age(e) >= 0 && age(e) < talkMs(e) ? e : null }

  if (turn && typeof turn === 'object') {
    const mine = evs.filter((e) => e.turn === turn.id)
    const oops = latest(mine, (e) => e.kind === 'retry' || e.kind === 'denied' || (e.kind === 'tool_end' && e.ok === false) || (e.kind === 'note' && e.glyph === '错'))
    const last = latest(mine, (e) => e.kind !== 'turn_start')
    // 出错后模型马上又被叫起来（下一条就是「在想」）：别扭照样挂满 4 秒，不被它盖掉
    if (oops && age(oops) >= 0 && age(oops) < OOPS_MS) return R(oops.kind === 'retry' ? 'retry' : oops.kind === 'denied' ? 'denied' : 'error', '别扭', oops.cap)
    const talk = talkingEv(mine)
    if (talk) return R('replying', '浅笑', talk.kind === 'said' ? '她在说话' : talk.cap, true)
    if (last?.kind === 'turn_end') return R('done', '浅笑', last.cap)
    const live = Array.isArray(inflight) ? inflight.filter((x) => x && typeof x === 'object') : []
    if (live.length) {
      const top = live[live.length - 1], [state, expr] = ACT_STATE[top.activity] ?? ACT_STATE.other
      return R(state, expr, live.length > 1 ? `${top.cap}（同时 ${live.length} 件）` : top.cap)
    }
    if (!last) {
      const st = rxOf(latest(mine, (e) => e.kind === 'turn_start')) || when(turn.at)
      return R('starting', Number.isFinite(st) && now - st < START_MS ? '小吃惊' : 'neutral', '她醒了')
    }
    return R('thinking', '想事情', '在想…')
  }

  const talk = talkingEv(evs)
  if (chatting) return R('chatting', '浅笑', '你正在和她当面聊', Boolean(talk))
  if (host?.state === 'paused') return R('paused', '浅笑', '暂停中')
  if (!host || host.state === 'offline') return R('offline', '困', '宿主没在跑')
  // 上一回合什么时候结束的：信结果日志的时刻（claude 退出以后才写，就是结束那一刻），不信「服务端什么时候读到的」——
  // 小窗一开会把旧回合重放一遍，读到的时刻全是开机那一刻：20 小时前没做完的回合会让她低落一小时，早做完的会闪一下「这回合做完了」
  const endEv = lastTurn?.id ? latest(evs, (e) => e.kind === 'turn_end' && e.turn === lastTurn.id) : null
  const logged = when(lastTurn?.endedAt ?? lastTurn?.at)
  const endAt = Number.isFinite(logged) ? logged : rxOf(endEv) || 0
  const from = when(since)
  const seenEnd = !Number.isFinite(from) || endAt >= from          // 小窗开着的时候结束的
  if (lastTurn?.ok === true && seenEnd && now - endAt < DONE_MS) return R('done', '浅笑', '这回合做完了')
  const q = queued
  const ids = Array.isArray(q) ? q.map((x) => (typeof x === 'string' ? x : x?.id)) : []
  const dmQ = ids.some((id) => { const k = kindOf(id).kind; return isOwnerKind(k) && k !== 'win' }) || (q && typeof q === 'object' && !Array.isArray(q) && Number(q.dm) > 0)   // 模块登记的主人找她的回合也算
  const winQ = ids.some((id) => kindOf(id).kind === 'win') || (q && typeof q === 'object' && !Array.isArray(q) && Number(q.win) > 0)   // 你在小窗里说的
  const anyQ = dmQ || winQ || ids.length > 0 || (typeof q === 'number' && q > 0) || (q && typeof q === 'object' && Number(q.total) > 0)
  if (dmQ) return R('dm_queued', '小吃惊', '你的私信到了，马上醒')
  if (winQ) return R('dm_queued', '小吃惊', '收到你的话了，马上回')
  // 低落：没做完的那回合结束不到一小时、而且之后没有做成的回合（lastTurn 是日志里最新的；再看一眼记录里有没有更晚的成功收尾）
  // （按事件自己的时间比：开机重放的旧回合尾巴 rx 都是开机那一刻，会被当成「更晚」）
  const tOf = (e) => (Number.isFinite(when(e.t)) ? when(e.t) : rxOf(e))
  const laterOk = Boolean(lastTurn?.id) && evs.some((e) => e.kind === 'turn_end' && e.ok === true && e.turn !== lastTurn.id && tOf(e) > endAt)
  if (lastTurn?.ok === false && !laterOk && now - endAt < SAD_MS) return R('failed', '低落', '上一回合没做完')
  if (anyQ) return R('queued', 'neutral', '有人找她，马上醒')
  return restState(plan, typeof inWindow === 'boolean' ? inWindow : typeof plan?.windowOpen === 'boolean' ? plan.windowOpen : null, now, R)
}

/** 回合之间、没人排队的时候：白天 / 睡着等下一次 / 今晚做完了 */
function restState(plan, open, now, R) {
  const pend = Boolean(plan && typeof plan === 'object' && (plan.action === 'wake' || plan.action === 'skip'))
  const nap = () => {
    const at = when(plan.atMs)
    const t = !Number.isFinite(at) ? '' : at > now ? ` · ${whenText(at, now)} 醒` : ' · 该醒了'
    return R('asleep', '困', `在睡觉${t}${plan.action === 'skip' ? '（只写日记）' : ''}`)
  }
  if (open === false) return R('day', 'neutral', '白天不醒，私信随时能叫醒她')
  if (open === true) {
    // 18:00–06:00 那一档凌晨 02:10 醒过以后，调度马上排好明晚那次：窗口还开着，但今晚已经没事了
    const s = when(plan?.startsAt), a = when(plan?.atMs)
    const tonight = pend && (Number.isFinite(s) ? s - now < NIGHT_MS : !Number.isFinite(a) || a - now < NIGHT_MS)
    if (tonight) return nap()
    // 计划是 done、可这一晚她一次都没醒（窗口设成 0 次 / 间隔排不下，plan.woke === false）：不能说「做完了」，作息那行会说「今晚不醒了」
    const woke = !(plan?.action === 'done' && plan.woke === false)
    return R('night_done', '困', plan && typeof plan === 'object' && woke ? '在睡觉 · 今晚的事做完了' : '在睡觉')
  }
  // 不知道在不在窗口里（调用方没给）：照旧
  if (pend) return nap()
  if (plan?.action === 'done') return R('day', 'neutral', '今晚的事做完了')
  return R('day', 'neutral', '白天不醒，私信随时能叫醒她')
}
