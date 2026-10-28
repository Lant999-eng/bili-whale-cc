// comment-images.mjs —— 看 TA 那条评论里附的图（只看这一条的：不看楼主那条的、不看视频 / 动态作者的）
//
// 用法：node bili.mjs comment-images --oid <oid> --rpid <TA 那条评论的 rpid> [--root <楼主那条的 rpid>] [--type 1] [--mid <TA 的 mid>] [--max 4] [--json]
//   【坐标】里的 parent 就是 TA 那条评论的 rpid，root、type 照抄；给了 --mid 还会核对这条是不是 TA 发的。
//
// 怎么保证拿的是「这一条」的图（2026-10-23 实测踩过）：
//   /x/v2/reply/reply?root=<rpid> 回的 data.root 是【整栋楼的楼主那条】—— 传进去的是楼中楼的 rpid 时，拿到的是楼主的评论和楼主的图 ✗
//   所以：data.root 的 rpid 正好等于要找的才用它；不是，就在这栋楼的回复里一页页找 rpid 对得上的那条（先看第一页，再从最后一页往前）；
//   找不到就明说找不到（被删 / 被折叠 / 楼太长），绝不拿楼主的图顶替。
// 图：content.pictures[].img_src（实测是 http:// 的 B站 图床地址，改成 https）；只认 B站 图床域名。
//   先下 @1280w_1e.jpg 的缩小版（实测 550KB 的 png → 49KB 的 jpg：看得清，也省），不行再下原图（≤ 8MB）。
//   存到 <数据目录>/shots/comment-img/，同一条评论的同一张图下过就直接用（缓存）。
// 输出逐张说清楚：下好了（路径）/ 用的缓存 / 没下成（为什么）/ 没下（超过 --max）。没打开看过的图，就是没看到 —— 别猜它画了什么。
// 退出码：0 = 找到了这条评论（有没有图、图下没下成都算）；2 = 参数不对；3 = 找不到这条评论 / 接口出错（不知道有没有图）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { apiGet } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { makeHeaders } from '../lib/msgfeed.mjs'
import { dshPath } from '../lib/paths.mjs'

const argv = process.argv.slice(2)
const get = (k) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null }
const NUM = /^\d{1,20}$/
const OID = get('oid'), RPID = get('rpid'), MID = get('mid')
const ROOT = get('root') && get('root') !== '0' ? get('root') : null
const TYPE = get('type') ?? '1'
const MAX = Math.min(9, Math.max(1, Number(get('max') ?? 4) || 4))
const JSON_OUT = argv.includes('--json')
const PAGES = 10                 // 一栋楼最多翻几页找（每页 20 条）
const SMALL_CAP = 4 << 20, FULL_CAP = 8 << 20
const IMG_DIR = dshPath('shots', 'comment-img')
// 整条命令最多等这么久（她的 Bash 调用 2 分钟就超时 —— 图床再慢，也要先把已经知道的告诉她）
const DEADLINE_S = Number(process.env.COMMENT_IMAGES_DEADLINE_S) > 0 ? Number(process.env.COMMENT_IMAGES_DEADLINE_S) : 90   // 环境变量只给测试用
const deadline = Date.now() + DEADLINE_S * 1000
const left = () => deadline - Date.now()

if (!NUM.test(String(OID)) || !NUM.test(String(RPID)) || (ROOT && !NUM.test(ROOT)) || !/^\d{1,3}$/.test(TYPE) || (MID && !NUM.test(MID))) {
  console.error('用法：node bili.mjs comment-images --oid <oid> --rpid <TA 那条评论的 rpid> [--root <root>] [--type 1] [--mid <TA 的 mid>] [--max 4] [--json]\n（都是数字；照抄【坐标】：rpid = parent）')
  process.exit(2)
}

const clean = (s, n = 200) => { const t = String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t }
const idOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '')
const out = { ok: false, rpid: RPID, found: false, where: null, mid: null, text: null, total: 0, images: [], note: null }
/** 没找到 / 出错时收尾（找到了的情况边下边说，见最后） */
function end(code) {
  if (JSON_OUT) console.log(JSON.stringify(out))
  else if (!out.found) { console.log(`✗ 没找到这条评论（rpid ${RPID}）：${out.note}`); console.log('  不知道它有没有附图 —— 回复里别提图，也别猜。') }
  else console.log(`✗ ${out.note}`)
  process.exit(code)
}

let H
try { H = makeHeaders(loadCred()) } catch (e) { out.note = '读不到凭据：' + clean(e.message, 120); end(3) }

// ─────────────── 找到「这一条」 ───────────────
async function page(pn) {
  return apiGet(`https://api.bilibili.com/x/v2/reply/reply?type=${TYPE}&oid=${OID}&root=${ROOT ?? RPID}&ps=20&pn=${pn}`, H, { noCache: true, timeoutMs: Math.min(30_000, Math.max(1000, left())) })
}
async function findComment() {
  const first = await page(1)
  if (first?.code !== 0) return { error: `评论接口返回 code=${first?.code ?? '?'}${first?.message ? ' ' + clean(first.message, 80) : ''}` }
  if (idOf(first.data?.root) === RPID) return { comment: first.data.root, where: '顶层评论' }
  const hit1 = (first.data?.replies ?? []).find((x) => idOf(x) === RPID)
  if (hit1) return { comment: hit1, where: '楼中楼' }
  // 新回复多半在楼的最后面：从最后一页往前翻
  const count = Number(first.data?.page?.count ?? 0)
  const last = Math.min(Math.max(1, Math.ceil(count / 20)), 1000)
  for (let pn = last, n = 1; pn > 1 && n < PAGES; pn -= 1, n += 1) {
    if (left() <= 0) return { error: `评论接口太慢，${DEADLINE_S} 秒内没翻完（翻到第 ${pn} 页）` }
    const j = await page(pn)
    if (j?.code !== 0) return { error: `评论接口返回 code=${j?.code ?? '?'}（翻到第 ${pn} 页时）` }
    const hit = (j.data?.replies ?? []).find((x) => idOf(x) === RPID)
    if (hit) return { comment: hit, where: '楼中楼' }
  }
  return { missing: last > PAGES ? `楼太长（${count} 条回复），翻了 ${PAGES} 页没找到` : '这栋楼里没有这条（可能被删了 / 被折叠了 / 坐标不对）' }
}

// ─────────────── 下图 ───────────────
const IMG_HOST = /^https?:\/\/([\w-]+\.)*(hdslb\.com|biliimg\.com)\/[^\s?#]+$/
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  return null
}
async function fetchImage(url, cap) {
  const r = await fetch(url, { headers: { 'user-agent': H['user-agent'], referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(Math.max(1000, Math.min(20_000, left()))) })
  if (!r.ok) return { why: `HTTP ${r.status}` }
  if (Number(r.headers.get('content-length') ?? 0) > cap) return { why: `太大（${Math.round(Number(r.headers.get('content-length')) / 1024)}KB）` }
  const b = Buffer.from(await r.arrayBuffer())
  if (b.length > cap) return { why: `太大（${Math.round(b.length / 1024)}KB）` }
  const kind = sniff(b)
  return kind ? { b, kind } : { why: '下下来的不是图片' }
}
async function saveImage(src, i) {
  const https = src.replace(/^http:\/\//, 'https://')
  const base = `${RPID}-${i + 1}-${crypto.createHash('sha1').update(https).digest('hex').slice(0, 10)}`
  const cached = fs.existsSync(IMG_DIR) ? fs.readdirSync(IMG_DIR).find((f) => f.startsWith(base + '.') && !f.endsWith('.tmp')) : null
  if (cached) return { status: 'cached', file: path.join(IMG_DIR, cached) }
  let why = ''
  for (const [url, cap, small] of [[https + '@1280w_1e.jpg', SMALL_CAP, true], [https, FULL_CAP, false]]) {
    try {
      const r = await fetchImage(url, cap)
      if (!r.b) { why = r.why; continue }
      fs.mkdirSync(IMG_DIR, { recursive: true })
      const file = path.join(IMG_DIR, `${base}.${r.kind}`), tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, r.b)
      fs.renameSync(tmp, file)
      return { status: 'downloaded', file, kb: Math.max(1, Math.round(r.b.length / 1024)), small }
    } catch (e) { why = e?.name === 'TimeoutError' ? '超时' : clean(e?.message ?? e, 80) }
  }
  return { status: 'failed', why }
}

// ─────────────── 输出（边下边说：图床慢的时候也先让你看到前面几张的结果）───────────────
const say = (t) => { if (!JSON_OUT) console.log(t) }
function picLine(x) {
  const size = x.width && x.height ? `（原图 ${x.width}×${x.height}）` : ''
  if (x.status === 'downloaded') return `  第 ${x.n} 张${size}：下好了${x.small ? '（缩小版）' : ''} → ${x.file}`
  if (x.status === 'cached') return `  第 ${x.n} 张${size}：之前下过，用缓存 → ${x.file}`
  if (x.status === 'skipped') return `  第 ${x.n} 张${size}：没下（只下前 ${MAX} 张；--max 9 看全）`
  if (x.status === 'late') return `  第 ${x.n} 张${size}：没来得及下（图床太慢，总共只等 ${DEADLINE_S} 秒）—— 这张你没看到`
  return `  第 ${x.n} 张${size}：没下成（${x.why}）—— 这张你没看到`
}

const f = await findComment()
if (!f.comment) { out.note = f.error ?? f.missing; end(3) }
const c = f.comment
out.found = true
out.where = f.where
// mid 和 rpid 一样优先用字符串 mid_str（和 comment / reply-draft 一致）：数字 mid 超过 2^53 时 JSON.parse 会失真，对的人也会被当成「不是 TA」
const mid = c.mid_str ?? c.mid ?? c.member?.mid
out.mid = mid != null ? String(mid) : null
out.text = clean(c.content?.message ?? '', 120)
if (MID && out.mid !== MID) { out.note = `rpid ${RPID} 这条不是 mid ${MID} 发的（是 mid ${out.mid}）—— 坐标对不上，不看图`; end(3) }
const pics = (Array.isArray(c.content?.pictures) ? c.content.pictures : []).filter((p) => p && typeof p.img_src === 'string')
out.total = pics.length
say(`TA 这条评论（${out.where} · rpid ${RPID}${out.mid ? ` · mid ${out.mid}` : ''}）：「${out.text}」`)
say(pics.length ? `附了 ${pics.length} 张图：` : '这条评论没有附图（只有文字）。')
for (const [i, p] of pics.entries()) {
  const meta = { n: i + 1, width: Number(p.img_width) || null, height: Number(p.img_height) || null }
  let x
  if (i >= MAX) x = { ...meta, status: 'skipped' }
  else if (left() <= 0) x = { ...meta, status: 'late' }
  else if (!IMG_HOST.test(p.img_src)) x = { ...meta, status: 'failed', why: '不是 B站 图床的地址，没下' }
  else x = { ...meta, ...(await saveImage(p.img_src, i)) }
  out.images.push(x)
  say(picLine(x))
}
if (pics.length) say('看图：用 Read 打开上面的路径。只有打开看过的才算看到了；没看到的别描述、别猜。')
out.ok = true
if (JSON_OUT) console.log(JSON.stringify(out))
process.exit(0)
