import { apiGet } from '../lib/bili-api.mjs'
// Reconstruct what a video is about without watching it.
//   metadata + cover + subtitles (if any) + tags + the repo it links to
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { recordMaterial, previouslyLines, subtitleVerdict } from '../lib/watchlog.mjs'
import { dshPath } from '../lib/paths.mjs'
import { resolveVideoRef } from '../lib/video-id.mjs'

// av 号 / 视频链接 / b23.tv 短链先换成 BV 号（lib/video-id.mjs，换出来的一定是合法 BV 号）；别的照旧拒绝
if (!process.argv[2]) { console.error('用法：node bili.mjs video <BV 号 | av 号 | 视频链接 | b23.tv 短链>'); process.exit(2) }
const ref = await resolveVideoRef(process.argv[2])
if (!ref.ok) { console.error(`${ref.error}\n用法：node bili.mjs video <BV 号 | av 号 | 视频链接 | b23.tv 短链>`); process.exit(ref.code) }
if (ref.note) console.error(ref.note)
const BVID = ref.bvid
const rec = (kind, info) => recordMaterial(BVID, kind, { via: 'video', ...(kind === 'subtitles' || kind === 'danmaku' ? { part: 1 } : {}), ...info })   // 看片记录（不是 BV 号就什么都不记）；字幕 / 弹幕只取 P1，结果都标上
for (const l of previouslyLines(BVID)) console.log(l)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// [2026-10-14] 字幕必须带登录 cookie 且走 WBI 签名，否则拿到的 subtitle_url 缺 auth_key → CDN 403
const cred = JSON.parse(fs.readFileSync(path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json'), 'utf8'))
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const navForWbi = await apiGet('https://api.bilibili.com/x/web-interface/nav', { 'user-agent': UA, cookie })
const wbiRaw = keyOf(navForWbi.data?.wbi_img?.img_url ?? '') + keyOf(navForWbi.data?.wbi_img?.sub_url ?? '')
const wbiMixin = MIXIN_TAB.map((i) => wbiRaw[i]).join('').slice(0, 32)
function wbiQuery(params) {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(k === 'wts' ? wts : params[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + wbiMixin).digest('hex')}`
}
const get = (url, extra = {}) => apiGet(url, { 'user-agent': UA, referer: `https://www.bilibili.com/video/${BVID}/`, cookie, ...extra })

const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`)
if (!view || view.code !== 0) { console.error('view failed', view?.code, view?.message); rec('meta', { status: 'failed', why: `view code=${view?.code}` }); process.exit(3) }
const d = view.data
rec('meta', { status: 'ok', title: d.title, owner: d.owner?.name, duration: d.duration, aid: d.aid, parts: d.pages?.length, desc: true })
const cid = d.pages?.[0]?.cid
console.log('=== 元信息 ===')
console.log(`  ${d.title}`)
console.log(`  UP ${d.owner.name} | ${d.tname} | ${d.duration}s | 发布 ${new Date(d.pubdate * 1000).toLocaleString('zh-CN')}`)
console.log(`  aid=${d.aid} cid=${cid}`)
if (d.pages?.length > 1) console.log(`  （多 P 视频，共 ${d.pages.length} P：下面的字幕、弹幕只是 P1）`)
console.log(`  简介原文:\n${(d.desc ?? '').split('\n').map((l) => '    ' + l).join('\n')}`)
console.log(`  封面: ${d.pic}`)

const tag = await get(`https://api.bilibili.com/x/tag/archive/tags?bvid=${BVID}`)
if (tag?.code === 0) console.log('  标签: ' + tag.data.map((t) => t.tag_name).join(' / '))

console.log('\n=== 字幕（有的话就等于读到了台词） ===')
const player = await get(`https://api.bilibili.com/x/player/wbi/v2?${wbiQuery({ bvid: BVID, cid })}`, { cookie })
let subs = player?.data?.subtitle?.subtitles ?? []
let subsAnswered = player?.code === 0
if (!subs.length) {
  // 再问一次播放器实际用的那个接口（和 subtitles 命令一样）：只问一个就说「没有字幕」会冤枉人
  const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
  const p2 = await get(`https://api.bilibili.com/x/v2/subtitle/web/view?oid=${d.aid}&pid=${d.aid}&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`)
  subsAnswered ||= p2?.code === 0
  if ((p2?.data?.subtitle?.subtitles ?? []).length) subs = p2.data.subtitle.subtitles
}
console.log(`  player code=${player?.code} 字幕条数=${subs.length}`)
for (const s of subs) console.log(`    ${s.lan_doc} (${s.lan}) auth_key=${String(s.subtitle_url).includes('auth_key') ? '有' : '无(会403)'} -> ${s.subtitle_url}`)
if (subs.length) {
  const pick = subs.find((s) => s.lan === 'ai-zh') ?? subs.find((s) => s.lan === 'zh-CN') ?? subs[0]
  const first = await get(String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url, { cookie: '' })
  const body = first?.body ?? []
  console.log(`  字幕行数=${body.length}（轨道 ${pick.lan}），前 40 行：`)
  for (const line of body.slice(0, 40)) console.log(`    [${line.from.toFixed(1)}s] ${line.content}`)
  if (body.length > 40) console.log(`    …（还有 ${body.length - 40} 行；要全文用 bili.mjs subtitles ${BVID}）`)
  if (body.length) {
    // 全文存一份（这里只打了前 40 行）：记成「取到了」就得真的有全文可看
    const subFile = dshPath('shots', 'subs', `${BVID}-video.txt`)
    try {
      fs.mkdirSync(path.dirname(subFile), { recursive: true })
      // 和 subtitles 存的一样：第一行标题、第二行 UP / BV / 时长，然后是 [mm:ss] 一行一句（面板认标题、原创查重认时间戳）
      const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`
      fs.writeFileSync(subFile, `${d.title}\n${d.owner?.name ?? ''}  ${BVID}  ${d.duration}s\n\n` + body.map((l) => `[${mmss(Number(l.from) || 0)}] ${l.content}`).join('\n'))
      console.log(`  全文：${subFile}`)
      rec('subtitles', { status: 'ok', count: body.length, file: subFile, part: 1 })
    } catch { rec('subtitles', { status: 'failed', why: '字幕全文没存下来（只看到了前 40 行）' }) }
  } else rec('subtitles', { status: 'failed', why: '有字幕轨道，内容没下下来' })
} else {
  const v = subtitleVerdict({ answered: subsAnswered, loggedIn: navForWbi?.data?.isLogin === true, aiStatus: player?.data?.subtitle?.ai_status, needLogin: player?.data?.need_login_subtitle })
  console.log(v.status === 'none' ? '  (无官方字幕轨道——这种视频只把字幕烧进画面，要走 bili.mjs watch-video 看 SUBS 图)' : `  (没拿到字幕：${v.why} —— 不是「没有字幕」)`)
  rec('subtitles', v)
}

console.log('\n=== 弹幕（26 秒的视频，量少但能看出关键词） ===')
let dmMiss = ''   // 断网 / 超时照实说，别说成被拦（和 debrief 一样）
const dm = await (async () => {
  try {
    const r = await fetch(`https://comment.bilibili.com/${cid}.xml`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })   // 限时：连上了不回话时别一直卡着（字幕走 apiGet，自己限 30 秒）
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    let x = buf.toString('utf8')
    // 和 debrief 一样：这个接口常回不带 content-encoding 的压缩流 —— 解不开的不能当成「没有弹幕」
    if (!x.includes('<i>') && !x.includes('<i ') && !x.includes('<d ')) {
      for (const fn of ['inflateRawSync', 'inflateSync', 'gunzipSync', 'brotliDecompressSync']) {
        try { const o = zlib[fn](buf).toString('utf8'); if (o.includes('<i>') || o.includes('<i ') || o.includes('<d ')) { x = o; break } } catch {}
      }
    }
    if (!x.includes('<i>') && !x.includes('<i ') && !x.includes('<d ')) return null
    return [...x.matchAll(/<d p="[^"]*">([^<]*)<\/d>/g)].map((m) => m[1])
  } catch (e) { dmMiss = e?.name === 'TimeoutError' ? '下载超时' : '网络出错'; return null }
})()
console.log(dm ? `  弹幕 ${dm.length} 条: ${dm.slice(0, 20).join(' | ')}` : `  没取到弹幕${dmMiss ? `（${dmMiss}）` : ''}`)
rec('danmaku', dm?.length ? { status: 'ok', count: dm.length, part: 1 } : dm ? { status: 'none', why: '这条视频没有弹幕' } : { status: 'failed', why: `没取到弹幕（${dmMiss || '被拦 / 解不开'}）` })

// 2026-10-21 修（外部审计 #3）：这里原来写死 const repo = 'T-Auto/dsh-ops'，
// 无论看什么视频都会去拉那个不相干仓库的 README —— 作者自用侦查脚本的残留 ✗
// 改成：只有显式给 --repo <owner/name> 才查，否则跳过 ✓
const wantRepo = (process.argv.find((a) => a.startsWith('--repo=')) ?? '').split('=')[1]
  || (process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : '')
// 2026-10-28（读书，主人定「甲」）：她的会话里（宿主设了回合编号，或者是 Claude Code 跑的 Bash）不查 ——
//   README 是陌生人写的字，不能进知道主人私事的那一轮；想了解一个项目，写读书请求（read-request）。主人自己在终端里跑照旧能查。
//   钩子（host/bash-gate.mjs）已经先挡了一道，这里再挡一道
const herSession = Boolean(process.env.BILI_WHALE_TURN || process.env.CLAUDECODE)
if (!wantRepo) {
  console.log('\n=== 仓库信息（跳过）===')
  if (!herSession) console.log('  要给就加 --repo <owner/name>；不给就不猜 ✓')
} else if (herSession) {
  console.log('\n=== 仓库信息（跳过）===')
  console.log('  这里不读 GitHub 的 README（陌生人写的字不进这一轮）。想了解这个项目：醒来那一轮用 read-request --topic "…"')
} else {
  const repo = wantRepo
  const meta = await (await fetch(`https://api.github.com/repos/${repo}`, { headers: { 'user-agent': 'dsh-recon' } })).json()
  if (!meta.full_name) {
    console.log(`  取不到 ${repo}（code=${meta.message ?? '?'}）`)
  } else {
    console.log(`  ${meta.full_name}  ★${meta.stargazers_count}  ${meta.pushed_at?.slice(0, 10)}  license=${meta.license?.spdx_id ?? '-'}`)
    console.log(`  ${meta.description ?? ''}`)
    try {
      const readme = await (await fetch(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/README.md`, { headers: { 'user-agent': 'dsh-recon' } })).text()
      const lines = readme.split('\n').filter((l) => l.trim() !== '')
      console.log('  README 前 25 行非空内容:')
      for (const l of lines.slice(0, 25)) console.log('    ' + l.slice(0, 130))
    } catch (e) {
      console.log('  README 取不到：' + String(e.message).slice(0, 60))
    }
  }
}
