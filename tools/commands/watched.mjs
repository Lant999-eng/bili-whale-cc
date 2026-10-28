// watched.mjs —— 看片记录（tools/lib/watchlog.mjs）：你看过哪条视频、每样素材取没取到、你看懂了什么、你对它做过什么
//
// 用法：
//   node bili.mjs watched show <BV>                这条视频：取到了哪些素材、手上有的范围、你记过的理解、你对它做过什么（只认账本）
//   node bili.mjs watched note <BV> --text "…"     记一句你看懂了什么（≤ 600 字）。工具把手上有的范围一起记上；什么都没有不让记
//   node bili.mjs watched list [--days 1]           最近看过的（最近一次真的取到东西在这几天里的）
//   <BV> 也可以写 av 号 / 视频链接 / b23.tv 短链（换成 BV 号再查，记录都按 BV 号存）
//
// 素材是你在自己的会话里用 debrief / subtitles / watch-video / video / comments 取的时候自动记的，你不用手动记；
// 范围（字幕 + 画面 / 只有字幕 / 只有画面 / 只有标题简介评论 / 什么都没有）由工具按记下的素材算，不由你说。
import { readWatch, scopeOf, addNote, actionsFor, recentWatches, localTime, MATERIALS, BV_RE, materialName, onHand, noneWhy } from '../lib/watchlog.mjs'
import { resolveVideoRef } from '../lib/video-id.mjs'

const [sub, ...rest] = process.argv.slice(2)
const get = (k) => { const i = rest.indexOf('--' + k); return i >= 0 && rest[i + 1] != null && !rest[i + 1].startsWith('--') ? rest[i + 1] : null }
let BV = rest.find((a) => BV_RE.test(a)) ?? null
// 没写 BV 号：第一个位置参数按 av 号 / 视频链接 / b23.tv 短链换成 BV 号（lib/video-id.mjs）；认不出来照旧报错
if (!BV && (sub === 'show' || sub === 'note')) {
  const positional = []
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { if (rest[i + 1] != null && !rest[i + 1].startsWith('--')) i += 1 }
    else positional.push(rest[i])
  }
  if (positional[0]) {
    const ref = await resolveVideoRef(positional[0])
    if (!ref.ok) { console.error(ref.error); process.exit(ref.code) }
    if (ref.note) console.error(ref.note)
    BV = ref.bvid
  }
}
const UNIT = { subtitles: ' 行', frames: ' 帧', danmaku: ' 条', comments: ' 条' }
const usage = () => { console.error('用法：node bili.mjs watched show <BV> | note <BV> --text "…" | list [--days 1]'); process.exit(2) }

function materialLine(k, m, rec) {
  if (!m) return '没取'
  const part = m.part ? `（P${m.part}）` : ''
  if (m.status === 'ok' && !onHand(m)) return '以前取到过，文件不见了 / 被别的视频覆盖了（现在手上没有）'
  if (m.status === 'ok') return `取到了${m.count != null ? `（${m.count}${UNIT[k] ?? ''}）` : ''}${part}${m.lastTry ? `；最近一次（${localTime(m.lastTry.at)}）${m.lastTry.status === 'ok' ? '又取到了' : `没取到（${m.lastTry.why ?? m.lastTry.status}）`}` : ''}`
  if (m.status === 'none') return noneWhy(rec, m)
  if (m.status === 'skipped') return `这次没取${m.why ? `（${m.why}）` : ''}`
  return `没取到（${m.why ?? '?'}）`
}

if (sub === 'show') {
  if (!BV) usage()
  const r = readWatch(BV)
  if (!r) { console.log(`${BV}：还没有记录（还没用 debrief / subtitles / watch-video / video / comments 取过它的素材）`); process.exit(0) }
  if (r.corrupt) { console.log(`${BV}：记录文件读不出来 —— 请主人看一下`); process.exit(3) }
  const s = scopeOf(r)
  console.log(`${BV} 《${r.title ?? '?'}》${r.owner ? ` · UP ${r.owner}` : ''}${r.duration ? ` · ${Math.round(r.duration)} 秒` : ''}${r.parts > 1 ? ` · 共 ${r.parts} P` : ''}`)
  console.log(`第一次取素材 ${localTime(r.firstAt)}，最近一次 ${localTime(r.lastAt)}`)
  console.log(`手上有的范围：${s.label}`)
  console.log('素材：')
  for (const k of Object.keys(MATERIALS)) {
    const m = r.materials?.[k]
    if (k === 'audio' && !m) continue   // 听写是可选的：没听过就不列
    console.log(`  · ${materialName(k, m)}：${materialLine(k, m, r)}${onHand(m) && m.file ? ` → ${m.file}` : ''}`)
  }
  const notes = r.notes ?? []
  console.log(notes.length ? '你记过的理解：' : '你还没记过看懂了什么（看完：watched note <BV> --text "…"）')
  for (const n of notes) console.log(`  · ${localTime(n.at)}（当时的范围：${n.label}）「${n.text}」`)
  const acts = actionsFor(BV, { aid: r.aid ?? null })
  if (acts.corrupt.length) console.log(`${acts.corrupt.join('、')}读不出来 —— 不知道你对它做过什么（请主人看一下）`)
  else console.log(acts.items.length ? '你对它做过的事（账本里记的）：' : '你没对它做过什么（账本里没有评论 / 分享 / 收藏）')
  for (const a of acts.items) console.log(`  · ${localTime(a.at)} ${a.what}（${a.status}）${a.note ? `「${a.note}」` : ''}`)
  process.exit(0)
}

if (sub === 'note') {
  const text = get('text')
  if (!BV || !text) usage()
  const r = addNote(BV, text)
  if (!r.ok) { console.error(`✗ 没记：${r.error}`); process.exit(3) }
  console.log(`✓ 记下了（手上有的范围：${r.scope.label}）`)
  if (r.scope.key !== 'text+image' || r.scope.stale.length || /多 P/.test(r.scope.label)) {
    console.log('  这条理解不是看全了得出来的：跟人说的时候也照实说（比如「只看了画面」「只看了字幕」「只看了 P1」「有的是以前取到的」），别说成看完了。')
  }
  process.exit(0)
}

if (sub === 'list') {
  const days = Math.min(30, Math.max(1, Number(get('days') ?? 1) || 1))
  const list = recentWatches(Date.now() - days * 86400_000)
  if (!list.length) { console.log(`最近 ${days} 天没有看片记录`); process.exit(0) }
  console.log(`最近 ${days} 天看过 ${list.length} 条：`)
  for (const r of list) {
    if (r.corrupt) { console.log(`  · ${r.bvid}：记录文件读不出来`); continue }
    console.log(`  · ${localTime(r.lastOkAt)} ${r.bvid} 《${r.title ?? '?'}》 范围：${scopeOf(r).label}${r.notes?.length ? ` · 记了 ${r.notes.length} 条理解` : ' · 还没记理解'}`)
  }
  process.exit(0)
}

usage()
