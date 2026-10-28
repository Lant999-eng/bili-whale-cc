import { apiGet } from '../lib/bili-api.mjs'
// 收藏（2026-10-20 加，主人定：收藏 ≠ 低配的分享，是"我想留着"）
//
// 用法:
//   node bili.mjs fav <BV> --reason "…" [--dry|--go]   收进她的默认收藏夹
//   node bili.mjs fav --list [--json]                  看她收过什么（feed 也读这个）
//   node bili.mjs fav --check <BV>                     只判断"能不能收"，不写
//
// 五条判据（代码强制，不只是提示）：
//   ① 必须有理由（≥6 字）—— 说不清为什么留 = 不收 ✗
//   ② 每天最多 3 条
//   ③ 同一视频 30 天只收一次
//   ④ 同类（按理由首词）已有 ≥2 条 → 除非 --better 否则拒
//   ⑤ 先 --dry 再 --go（和其它写操作一致）
import fs from 'node:fs'
import path from 'node:path'
import { dshPath, configPath } from '../lib/paths.mjs'
import { updateJsonLocked } from '../lib/filelock.mjs'
import { resolveVideoRef } from '../lib/video-id.mjs'


const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const FAV_LOG = path.join(HOME, '.bili-ai', 'favorites.json')
// 2026-10-21 修（外部审计 #10）：新用户跑 `fav --list` 会因为缺文件直接一脸 ENOENT ✗
//   改成友好提示：--list 不需要凭据（只读本地账本），其它子命令才要 ✓
let cred = { sessdata: '', bili_jct: '', buvid3: '' }
let cfg = {}
try {
  cred = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8'))
} catch {}
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch {}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 ?? ''}`
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie }

const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else positional.push(argv[i])
}
const DRY = !!opt.dry
const GO = !!opt.go
const DAY = 86400000
const today = () => new Date().toLocaleDateString('sv-SE')

const load = () => { try { return JSON.parse(fs.readFileSync(FAV_LOG, 'utf8')) } catch { return { items: [] } } }
const save = (d) => { fs.mkdirSync(path.dirname(FAV_LOG), { recursive: true }); fs.writeFileSync(FAV_LOG, JSON.stringify(d, null, 2)) }
const selfMid = String(cfg.self?.mid ?? '')

// 2026-10-20：收藏分四类（对应"我收藏它是为了什么"那四个答案）
//   用固定类别而不是"理由前两个字"—— 后者太脆（"想看"和"想留"会被当成两类 ✗ 实测踩过）
const KINDS = ['想学', '想再看', '和我有关', '以后要提', '其他']
function inferKind(reason) {
  const r = String(reason)
  if (/学|教程|怎么|原理|工具|插件|做法/.test(r)) return '想学'
  if (/再看|好笑|治愈|震撼|好听|想看第二遍|重看/.test(r)) return '想再看'
  if (/鱼|鲸|拟人|我自己|人格|AI 人|桌宠/.test(r)) return '和我有关'
  if (/提|引用|日记|分享里|以后说/.test(r)) return '以后要提'
  return '其他'
}

// ── --list ───────────────────────────────────────────────
if (opt.list) {
  const d = load()
  const items = (d.items ?? []).slice().reverse()
  if (opt.json) {
    console.log(JSON.stringify({ total: items.length, items }, null, 2))
    process.exit(0)
  }
  if (!items.length) { console.log('（她还没收藏过东西）'); process.exit(0) }
  console.log(`她收藏了 ${items.length} 条：\n`)
  for (const x of items) {
    const days = Math.floor((Date.now() - new Date(x.at).getTime()) / DAY)
    console.log(`  ${x.bv}  ${String(x.title ?? '').slice(0, 42)}`)
    console.log(`     理由：${x.reason}    （${days} 天前 · 类别 ${x.kind}）`)
  }
  process.exit(0)
}

// ── 取她的默认收藏夹 id ────────────────────────────────────
async function defaultFavId() {
  const j = await apiGet(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${selfMid}`, H)
  if (j.code !== 0) throw new Error(`取收藏夹失败：${j.message ?? j.code}`)
  const list = j.data?.list ?? []
  const pick = list.find((f) => /默认/.test(f.title)) ?? list[0]
  if (!pick) throw new Error('这个号还没有任何收藏夹（B站默认会建一个"默认收藏夹"，没有就得先在网页上收藏一次）')
  return { id: pick.id, title: pick.title }
}

// ── 取 aid + 标题 ────────────────────────────────────────
async function videoInfo(bv) {
  const j = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, H)
  if (j.code !== 0) throw new Error(`取视频信息失败：code=${j.code} ${j.message ?? ''}`)
  return { aid: j.data.aid, title: String(j.data.title ?? ''), up: String(j.data.owner?.name ?? '') }
}

// ── 判据检查（返回值 = 拒绝理由，null 表示可以收）────────────
function checkRules({ bv, reason, better, kind }, items = load().items ?? []) {
  if (!reason || String(reason).trim().length < 6) return '理由太短（≥6 字）—— 说不清为什么留，就不收 ✗'
  const todayCount = items.filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today()).length
  if (todayCount >= 3) return `今天已经收了 ${todayCount} 条（上限 3）—— 剩下的明天再说 ✓`
  const same = items.filter((x) => x.bv === bv)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (same) {
    const days = Math.floor((Date.now() - new Date(same.at).getTime()) / DAY)
    if (days < 30) return `这个 ${days} 天前收过了（30 天内不重复）✓`
  }
  const k = kind || inferKind(reason)
  const sameKind = items.filter((x) => x.kind === k)
  if (sameKind.length >= 2 && !better) return `「${k}」这类已经收了 ${sameKind.length} 条 —— 除非明显更好（--better），不然别让收藏夹变仓库 ✗`
  return null
}

// ── --check ──────────────────────────────────────────────
if (opt.check) {
  let bv = String(opt.check)
  // av 号 / 视频链接 / b23.tv 短链：换成 BV 号再判（账本按 BV 号记）；认不出来的照旧原样判
  if (typeof opt.check === 'string') { const ref = await resolveVideoRef(opt.check); if (ref.ok) { bv = ref.bvid; if (ref.note) console.error(ref.note) } }
  const reason = String(opt.reason ?? '')
  const bad = checkRules({ bv, reason, better: !!opt.better, kind: opt.kind })
  console.log(bad ? `✗ 不能收：${bad}` : '✓ 可以收（满足五条判据）')
  process.exit(bad ? 1 : 0)
}

// ── 主流程：加收藏 ────────────────────────────────────────
// <BV> 也可以是 av 号 / 视频链接 / b23.tv 短链（lib/video-id.mjs 换成 BV 号，换出来的一定是合法 BV 号）
const favUsage = '用法: node bili.mjs fav <BV | av号 | 视频链接 | b23.tv 短链> --reason "…" [--dry|--go] | --list [--json] | --check <BV>'
if (!positional[0]) { console.error(favUsage); process.exit(2) }
const favRef = await resolveVideoRef(positional[0])
if (!favRef.ok) { console.error(`${favRef.error}\n${favUsage}`); process.exit(favRef.code) }
if (favRef.note) console.error(favRef.note)
const bv = favRef.bvid
const reason = String(opt.reason ?? '').trim()
const kind = String(opt.kind ?? '') || inferKind(reason)
const bad = checkRules({ bv, reason, better: !!opt.better, kind })
if (bad) { console.error(`✗ 不能收：${bad}`); process.exit(3) }

// 写操作才需要凭据（--list / --check 不需要）
if (!cred.sessdata || !cred.bili_jct) {
  console.error('✗ 还没配置 B站 凭据，没法收藏')
  console.error('  去设置页粘贴 SESSDATA + bili_jct 并保存（只读的 fav --list 不需要凭据 ✓）')
  process.exit(2)
}
let info, fav
try { info = await videoInfo(bv); fav = await defaultFavId() }
catch (error) { console.error(error.message); process.exit(3) }
console.log(`[fav] ${bv}  「${info.title.slice(0, 44)}」  @${info.up}`)
console.log(`  理由：${reason}`)
console.log(`  类别：${String(opt.kind ?? '') || inferKind(reason)}（可选 --kind 想学|想再看|和我有关|以后要提 覆盖）`)
console.log(`  收藏夹：「${fav.title}」（media_id=${fav.id}）· 今天第 ${(load().items ?? []).filter((x) => new Date(x.at).toLocaleDateString('sv-SE') === today()).length + 1}/3 条`)

if (!GO && !DRY) { console.error('✗ 必须给 --dry 或 --go'); process.exit(2) }
if (DRY) { console.log('  [dry] 未写入 ✓ 确认后把 --dry 换成 --go'); process.exit(0) }

const body = new URLSearchParams({
  rid: String(info.aid),
  type: '2',
  add_media_ids: String(fav.id),
  del_media_ids: '',
  csrf: String(cred.bili_jct ?? ''),
})
{ const { writeBlocked } = await import('../lib/bili-api.mjs'); if (writeBlocked()) { console.error('✗ ' + writeBlocked()); process.exit(2) } }
// 「再判一次 + 先记一条预留」在账本锁里一步做完（以前判完、发三个请求、最后才记账：同时收几条，每天 3 条 / 30 天不重复都拦不住）
const rid = Math.random().toString(36).slice(2)
try {
  updateJsonLocked(FAV_LOG, (d) => {
    d.items = d.items ?? []
    const again = checkRules({ bv, reason, better: !!opt.better, kind }, d.items)
    if (again) throw new Error(again)
    d.items.push({ bv, at: new Date().toISOString(), reason, kind, pending: true, rid })
  }, { items: [] })
} catch (e) { console.error(`✗ 不能收：${e.message}`); process.exit(3) }
const r = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
})
const j = await (await import('../lib/bili-api.mjs')).readWriteResult(r, 'fav/deal')   // 先看风控（熔断）再解析
if (j.code !== 0) {
  // 2026-10-21：把常见返回码翻译成人话 —— 裸的 -111 用户完全看不懂 ✗
  const HINT = {
    '-101': '账号未登录：登录失效了 —— 主人跑 node host/cli.mjs cookie --qr 重新扫码',
    '-111': 'CSRF 校验失败：bili_jct 和当前 SESSDATA 不是同一账号，或已过期 → 两个都重新复制一次',
    '-352': '风控拦截：等几分钟再来',
    10031: '操作太快：退避一会儿',
    12015: '需要验证码：停下，去浏览器手动过一次',
  }
  console.error(`  ✗ 收藏失败：code=${j.code} ${HINT[String(j.code)] ?? (j.message ?? '未知错误')}`)
  try { updateJsonLocked(FAV_LOG, (d) => { d.items = (d.items ?? []).filter((x) => x.rid !== rid) }, { items: [] }) } catch {}   // 明确失败：撤掉预留
  process.exit(4)
}

// 记本地账（feed 会读）：把预留落成正式记录
const d = updateJsonLocked(FAV_LOG, (d) => {
  d.items = (d.items ?? []).filter((x) => x.rid !== rid)
  d.items.push({ bv, aid: info.aid, title: info.title, up: info.up, at: new Date().toISOString(), reason, kind, favId: fav.id })
}, { items: [] })
console.log(`  ✓ 已收藏（HTTP ${r.status}）· 本地账 +1（共 ${d.items.length} 条）`)
