// 「在小窗里跟她说话」的共用部分：cli say 把主人的话投成她的一个回合、记一份原话；小窗服务读这份原话 + 结果日志里她的回复，拼成聊天记录。
//   · 回合 id：bili-whale-win-<13 位毫秒>-<4 位十六进制>。宿主当普通回合跑（不重跑、不推送），priority 插队：和 QQ 一样排在普通回合前面
//   · 原话：<数据目录>/whale-cc/window-chat.jsonl（cli 写、小窗服务只读）：{ id, at, text }。
//     她的提示里也有原话，可提示要等回合跑起来才进会话记录、结果日志只留提示的前 200 字 —— 排着的那几句、早一点的聊天都靠这一份显示
//   · 她的回复：那一回合结果日志里的 result（她最后那段话，宿主截到 2000 字）。主人选的：只回在小窗里，不走私信 / QQ / 推送
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOST_DIR } from './core.mjs'
import { renameRetry, withFileLock } from '../tools/lib/filelock.mjs'
import { moduleInstalled } from './modules.mjs'

export const WIN_PREFIX = 'bili-whale-win-'
export const WIN_ID_RE = /^bili-whale-win-\d{13}-[0-9a-f]{4}$/
export const CHAT_FILE = path.join(HOST_DIR, 'window-chat.jsonl')
export const SAY_MAX = 2000             // 一句最多几个字（按字符数，emoji 算一个）
export const MAX_QUEUED = 5             // 排着还没回的最多几句：再多就先等她回
export const REPLY_MAX = 2000           // 宿主的结果日志本来就只留 2000 字
export const LOST_MS = 120_000          // 不在队列里、没在跑、也没有结果：两分钟以后才算「她没收到 / 半路断了」（刚投进去那一下可能还没读到队列）
const KEEP = 300, TRIM_AT = 512 * 1024
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$/
const HOST_NOTE_RE = /^\[(?=[^[\]{}"]*\p{Script=Han})([^[\]{}"]{1,80})\]$/u   // 宿主往出错信息后面补的一行说明，比如 [超时，已终止]（要带汉字：[1,2] 这种是 JSON）

export const isWinId = (id) => typeof id === 'string' && id.startsWith(WIN_PREFIX)
export const newWinId = (now = Date.now()) => `${WIN_PREFIX}${String(Math.floor(now)).padStart(13, '0')}-${crypto.randomBytes(2).toString('hex')}`

/** 主人打的字：去掉 BOM、换行统一成 \n、去掉换行和 tab 以外的控制字符、头尾空白；空的 / 太长 → { error } */
export function normalizeSay(raw) {
  const s = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
  if (!s) return { error: '没有要说的话' }
  const n = [...s].length
  if (n > SAY_MAX) return { error: `太长了（${n} 字；一句最多 ${SAY_MAX} 字）` }
  return { text: s }
}

/** 投给她的提示。persona：人设那一行（cli 的 personaLine，和醒来 / 私信回合一样带上） */
export function winTurnText(text, persona = '') {
  return [
    persona,
    '【主人·小窗】主人在他电脑上的「她的小窗」里对你说了一句（下面两行横线之间是他的原话）：',
    '————————',
    text,
    '————————',
    '按 CLAUDE.md「小窗」做：',
    '1) 这是主人本人 ✓ 照他说的做；做事照常守 CLAUDE.md 的规矩（视频照样交审、对外说的话照常小心）',
    '2) 先把事做完，再把这次主人的话写进私人日记的「偏好校准」（主人的话算反馈 ✓）',
    `3) **最后**才回他：回他的那段话必须是这一回合你说的**最后那段话**，说完就结束，之后别再调用任何工具 —— 小窗只显示最后那段话（只在他这台电脑上）✓；**别用** dm / notify${moduleInstalled('qq') ? ' / qq' : ''} 回他（他选了只在小窗里看）`,
    '4) 回得像聊天；做了什么、没做成什么照实说；有拿不准的就在那段话里问他，他会在小窗里接着说',
  ].filter((x) => x !== '').join('\n')
}

/**
 * 记一句原话（在锁里追加）。cancel：这一句其实没交给她（cli say 先记原话、再投；投不成就补一行 cancel，读的时候这句整个不算）。
 * 文件超过 512 KB 就只留最后 300 句、而且不超过 256 KB（一句最多 2000 个 emoji ≈ 8 KB：光按句数留，300 句也能有 2 MB 多）
 */
export function appendChat({ id, at, text, cancel = false }, file = CHAT_FILE) {
  if (!WIN_ID_RE.test(String(id ?? ''))) throw new Error('回合 id 不对')
  const when = at ?? new Date().toISOString()
  const line = JSON.stringify(cancel ? { id, at: when, cancel: true } : { id, at: when, text: String(text ?? '') }) + '\n'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  withFileLock(file + '.lock', () => {
    fs.appendFileSync(file, line, 'utf8')
    // 修剪只是顺手：这一行已经记上了，修剪不成（文件被占着之类）也不算没记上 —— 不然 cli say 会以为没记上、不投，小窗里却多了一句「没等到」
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      if (fs.statSync(file).size <= TRIM_AT) return
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-KEEP)
      let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
      while (lines.length > 1 && bytes > TRIM_AT / 2) bytes -= Buffer.byteLength(lines.shift()) + 1
      fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
      renameRetry(tmp, file)
    } catch { try { fs.rmSync(tmp, { force: true }) } catch {} }
  }, { waitMs: 10_000, busy: '小窗的聊天记录正被另一个进程写着' })
}

/** 文件太大（别的进程写的 / 还没来得及修剪）：只读最后 maxBytes，扔掉开头那半行 */
function readTail(file, size, maxBytes) {
  if (size <= maxBytes) return fs.readFileSync(file, 'utf8')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const n = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes)
    const s = buf.subarray(0, n).toString('utf8')
    return s.slice(s.indexOf('\n') + 1)
  } finally { fs.closeSync(fd) }
}

/** 读原话：坏行、id / 时间不对的、太长的跳过；同一个 id 只留第一次；补了 cancel 的整句不算；按时间排 */
export function readChat(file = CHAT_FILE) {
  let raw = ''
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return []
    raw = readTail(file, st.size, 4 * TRIM_AT)
  } catch { return [] }
  const seen = new Set(), cancelled = new Set(), out = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    let o
    try { o = JSON.parse(l.replace(/^\uFEFF/, '')) } catch { continue }
    if (!o || typeof o !== 'object' || !WIN_ID_RE.test(String(o.id ?? ''))) continue
    if (o.cancel === true) { cancelled.add(o.id); continue }
    if (seen.has(o.id)) continue
    if (typeof o.at !== 'string' || !ISO_RE.test(o.at) || typeof o.text !== 'string' || !o.text || o.text.length > SAY_MAX * 2) continue
    seen.add(o.id)
    out.push({ id: o.id, at: o.at, text: o.text })
  }
  return out.filter((x) => !cancelled.has(x.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * 出错信息的一行里像人话的那截（不像就 null）：JSON / 引号开头的、整行是 JSON 一截的（"key": …、"a","b"）不要；
 * 「API Error: 529 {"type":"error",…"message":"Overloaded"}」这种（claude 最常见的出错）取 { 前面那截，再带上 JSON 里的 message
 */
function humanLine(x) {
  if (!x || /^[{["\]}:,]/.test(x)) return null
  const cut = x.search(/[{[]/)
  const head = (cut < 0 ? x : x.slice(0, cut)).trim()
  if (!head || /"[\w$]+"\s*:|","/.test(head)) return null
  const msg = cut < 0 ? null : /"message"\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(x.slice(cut))?.[1]
  return msg ? `${head} ${msg}` : head
}

/**
 * 原话 + 宿主的状态 → 聊天记录（最近 limit 句，最早的在前）：
 *   { id, at, text, state: 'queued' | 'running' | 'done' | 'failed' | 'lost', ahead?（queued：前面还有几个回合）, reply?, error?, replyAt?, ms? }
 * queue：队列里的回合 id（按顺序，可以带着正在跑的那个）；active：正在跑的回合 id；logs：结果日志的行（{ id, ok, result, at, ms }）。
 * 结果日志里有 = 跑完了。ok 是 false 就是没做完：那时的 result 是出错的原因（还可能夹着 claude 的原始输出）—— 不当她的回复，只取一行像话的当 error；
 * 在跑 / 在排 = 照说；都不是、两分钟以上 = lost（宿主没接住、半路断了，或者宿主重启时把它当孤儿收了尾、没留下结果）
 */
export function chatView({ entries = [], queue = [], active = null, logs = [], now = Date.now(), limit = 40, days = 3 } = {}) {
  const ended = new Map()
  for (const l of Array.isArray(logs) ? logs : []) if (isWinId(l?.id)) ended.set(l.id, l)
  const q = (Array.isArray(queue) ? queue : []).filter((x) => typeof x === 'string' && x !== active)
  const since = now - days * 86_400_000
  const out = []
  for (const e of (Array.isArray(entries) ? entries : []).filter((x) => Date.parse(x?.at) >= since).slice(-limit)) {
    const item = { id: e.id, at: e.at, text: e.text }
    const l = ended.get(e.id)
    if (l) {
      const failed = l.ok === false
      Object.assign(item, { state: failed ? 'failed' : 'done', replyAt: typeof l.at === 'string' ? l.at : undefined, ms: typeof l.ms === 'number' && Number.isFinite(l.ms) ? l.ms : undefined })
      const r = typeof l.result === 'string' ? l.result : ''
      if (!failed && r.trim()) item.reply = r.slice(0, REPLY_MAX)
      if (failed) {
        // 宿主自己写的说明（「[超时，已终止]」这种，一整行方括号）优先；没有就取第一行像人话的（不是 JSON / 引号开头、也不像 JSON 的一截）
        const lines = r.split(/\r?\n/).map((x) => x.trim())
        const note = lines.map((x) => HOST_NOTE_RE.exec(x)?.[1]?.trim()).find(Boolean)
        const why = note ?? lines.map(humanLine).find(Boolean)
        if (why) item.error = why.slice(0, 160)
      }
    } else if (e.id === active) item.state = 'running'
    else if (q.includes(e.id)) Object.assign(item, { state: 'queued', ahead: q.indexOf(e.id) + (active ? 1 : 0) })
    else item.state = now - Date.parse(e.at) < LOST_MS ? 'queued' : 'lost'
    out.push(item)
  }
  return out
}

/** 读完标准输入（管道里给的话）：最多 limit 字节，多了就报错（不截半截话交给她） */
export function readAllStdin(limit = 64 * 1024, stdin = process.stdin) {
  return new Promise((resolve, reject) => {
    const parts = []
    let n = 0
    stdin.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error(`输入太长（超过 ${limit} 字节）`)); stdin.destroy?.(); return } parts.push(d) })
    stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    stdin.on('error', reject)
  })
}
