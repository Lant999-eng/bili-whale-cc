// Post ONE bilibili comment on the user's behalf. Explicitly single-shot.
//
//   node bili-comment.mjs --oid <aid> --bvid <BV...> --message "@昵称 正文" --dry
//   node bili-comment.mjs --oid <aid> --bvid <BV...> --message "@昵称 正文" --go
//
// Credentials live in a file outside the workspace and are never printed:
//   %USERPROFILE%\.bili-ai\credentials.json  -> { sessdata, bili_jct, buvid3 }
//
// --dry  : identifies the account behind the cookie (nav), builds and prints the
//          exact request, prints nothing postable. No write to bilibili.
// --go   : the same, then POSTs exactly once and prints the API result.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from '../lib/capture.mjs'
import { fileURLToPath } from 'node:url'
import { config, shareEnabled } from '../lib/config.mjs'
import { validateShare } from '../lib/share-policy.mjs'
import { isAgent } from '../lib/paths.mjs'
import { updateJsonLocked } from '../lib/filelock.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { gate as gateQuota, reserve as reserveQuota, commit as commitQuota, release as releaseQuota, readWriteResult, writeOutcome } from '../lib/quota-gate.mjs'
import { recordExchange, threadKey } from '../lib/memory.mjs'
import { apiGet } from '../lib/bili-api.mjs'
import { resolveVideoRef, bv2av } from '../lib/video-id.mjs'
import { publicGate } from '../lib/outbound.mjs'

// ── 限额闸（B 档「限额自主」的代码强制部分，2026-10-14 主人选 B 档）────────────────
// 语义：闸门**只管自主发言**（带 --auto，即"她自己决定说的"）；主人当场授权的发言不拦 ✓
// 这一层存在的理由：主人明确要求"限频写进代码，不是写进你的自觉里"。
// --share（2026-10-17 加）：分享型 —— "把看到的好东西 @ 主人"。它**不看白名单**，
//   但受**每日合计 ≤3**、**同一视频 7 天内一次**两条硬限制（由 quota.mjs 强制）。
// bili-whale-cc：她的会话里一律按自主发言（不带 --auto 也算），不能靠省掉这个参数绕过额度
const AUTO = process.argv.includes('--auto') || isAgent()
const SHARE = process.argv.includes('--share')
// --once-per-person（2026-10-17 加）：同一个人 30 天内最多只回一条（只对"回复某人"生效）。
// 2026-10-18 接线：不传旗标时按配置决定（config.listen.oncePerPerson ✓ 设置页那个开关）
//   —— 只在"回复某人"（带 --parent）时生效；分享/顶层评论不受影响 ✓
const ONCE = process.argv.includes('--once-per-person')
  || ((process.argv.includes('--parent') || process.argv.includes('--root')) && config().listen?.oncePerPerson === true)
const ONCE_DAYS = 30
const ONCE_MS = ONCE_DAYS * 86_400_000
const REPLIED = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.bili-ai', 'replied.json')
// 判重账本读坏了 / 结构不对 → 抛错，调用方在发送前停下（以前当成空账本：判重悄悄失效，照发）
function checkReplied(led) {
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (!obj(led) || !obj(led.byUid)) throw new Error('replied.json 结构不对（缺 byUid）')
  for (const [mid, list] of Object.entries(led.byUid)) {
    if (!Array.isArray(list) || !list.every((x) => obj(x) && typeof x.at === 'string' && Number.isFinite(Date.parse(x.at)))) {
      throw new Error(`replied.json 里 ${mid} 的记录结构不对`)
    }
  }
  return led
}
function loadReplied() {
  let raw
  try { raw = fs.readFileSync(REPLIED, 'utf8') } catch (e) {
    if (e?.code === 'ENOENT') return { byUid: {} }
    throw new Error(`replied.json 读不了（${e?.code ?? e}）`)
  }
  let led
  try { led = JSON.parse(raw) } catch { throw new Error('replied.json 坏了（不是完整的 JSON）') }
  return checkReplied(led)
}
const repliedRecently = (led, mid) => (led.byUid[mid] ?? []).filter((x) => Date.now() - Date.parse(x.at) < ONCE_MS)
const pruneReplied = (led) => {
  for (const k of Object.keys(led.byUid)) {
    led.byUid[k] = led.byUid[k].filter((x) => Date.now() - Date.parse(x.at) < ONCE_MS)
    if (!led.byUid[k].length) delete led.byUid[k]
  }
}
// 主人批准草稿时：被「同一个人只回一条」拦下的，在只有主人知道的结果文件里说清楚 ——
// 那边就不把草稿放回队列（放回去也只会被同一条规则再拦一次）
function onceRefused(why, extra = {}) {
  if (!process.env.BILI_RESULT_FILE || isAgent()) return
  try { fs.writeFileSync(process.env.BILI_RESULT_FILE, JSON.stringify({ code: null, once: why, ...extra })) } catch {}
}
// 「判重 + 预留」在账本锁里一步做完（发送前）：两个进程同时回同一个人，只有一个能拿到预留
function reserveOnce(who, target) {
  const id = crypto.randomUUID()
  let taken = null
  updateJsonLocked(REPLIED, (led) => {
    checkReplied(led)
    const hist = repliedRecently(led, who.mid)
    if (hist.length) { taken = hist[0]; return led }
    pruneReplied(led)
    ;(led.byUid[who.mid] ??= []).push({ at: new Date().toISOString(), target, name: who.name, pending: true, id })
    return led
  }, { byUid: {} })
  return taken ? { taken } : { id }
}
// 预留落账（发成功）/ 撤销（B站 明确没收）/ 标「结果不确定」（留着，照样挡住这个人）
function settleOnce(id, how, rpid) {
  updateJsonLocked(REPLIED, (led) => {
    checkReplied(led)
    for (const k of Object.keys(led.byUid)) {
      const i = led.byUid[k].findIndex((x) => x.id === id)
      if (i < 0) continue
      if (how === 'release') led.byUid[k].splice(i, 1)
      else if (how === 'commit') { delete led.byUid[k][i].pending; led.byUid[k][i].rpid = rpid }
      else led.byUid[k][i].uncertain = true
      if (!led.byUid[k].length) delete led.byUid[k]
    }
    return led
  }, { byUid: {} })
}
// 查出"被回复的那个人"是谁（reply/reply 里 rpid === parent 的那条的作者）
// 返回 { who } 或 { why }：查不到时说清楚为什么（楼里没有 / 楼太长 / 超时 / 接口出错），调用方照实告诉她，不悄悄跳过
// 2026-10-23 修（Astra 评审）：以前只翻前 4 页（80 条）—— 长楼里新回复在后面，查不到就当没这个人：
//   记忆那一步悄悄不记；开着「同一个人只回一条」时，这条回复干脆被拦下。
//   现在照 comment-images 的找法：先看 data.root 和第 1 页，再按总条数从最后一页往前翻（新回复多半在后面），最多 10 页、有总时限
const PARENT_PAGES = 10
const parentCache = new Map()
async function parentAuthor(aid, rootRpid, parentRpid, replyType, budgetMs = 40_000) {   // budgetMs：总时限（发完之后记忆那一步给得短，别把已经发出去的命令拖住）
  const ck = [aid, rootRpid, parentRpid, replyType].join(':')
  if (parentCache.has(ck)) return { who: parentCache.get(ck) }
  const r = await parentAuthorFetch(aid, rootRpid, parentRpid, replyType, budgetMs)
  if (r.who) parentCache.set(ck, r.who)
  return r
}
async function parentAuthorFetch(aid, rootRpid, parentRpid, replyType, budgetMs) {
  const start = Date.now(), deadline = start + budgetMs
  let asked = 0   // 真的请求过的最后一页（超时的时候照实说查到哪了）
  const idOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '')
  // mid / rpid 优先用字符串形式（mid_str / rpid_str）：新号的 mid 已经 16 位，再长一点 JSON 数字就不精确了（2026-10-23 用真接口看过，两种都有）
  const found = (x) => ({ who: { mid: String(x.mid_str ?? x.mid ?? x.member?.mid ?? ''), name: x.member?.uname ?? '', text: String(x.content?.message ?? '') } })
  // 说实际花了多久、查到第几页（单页 15 秒没回也算超时，不一定用满总时限）
  const late = () => ({ why: `查被回复者超时（${Math.round((Date.now() - start) / 1000)} 秒还没找到${asked ? `，查到第 ${asked} 页` : ''}）` })
  // 走 apiGet：节流、风控熔断照常（翻的页比以前多，不能贴脸连打）
  const page = async (pn) => {
    if (Date.now() >= deadline) return late()
    asked = pn
    const j = await apiGet(`https://api.bilibili.com/x/v2/reply/reply?type=${replyType}&oid=${aid}&root=${rootRpid}&pn=${pn}&ps=20`,
      { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }, { noCache: true, timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())) })
    if (j?.code === 0) return { data: j.data ?? {} }
    const msg = String(j?.message ?? '')
    if (Date.now() >= deadline || /超时/.test(msg)) return late()
    // apiGet 断网时的说法带着「WBI 签名」—— 这个接口不签名，跟她说「网络出错」就好
    return { why: `查被回复者时接口出错（第 ${pn} 页）：${j?.code === -1 && /网络异常/.test(msg) ? '网络出错' : `code=${j?.code ?? '?'} ${msg.slice(0, 80)}`}` }
  }
  const first = await page(1)
  if (!first.data) return first
  // 2026-10-22 修（她自己诊断的，很准）：我们要回的可能是一个【顶层评论】—— 那时 root == parent，
  //   它根本不在楼中楼列表 replies 里；但同一个响应里就带着 data.root（就是那条顶层评论本身）✓ 直接用它 ✓
  //   （只在 rpid 正好对上时用：要找的是楼中楼时，data.root 是楼主那条，不能拿来顶替）
  if (idOf(first.data.root) === String(parentRpid)) return found(first.data.root)
  const list = first.data.replies ?? []
  const hit1 = list.find((x) => idOf(x) === String(parentRpid))
  if (hit1) return found(hit1)
  // 从最后一页往前翻（接口没给总条数、第 1 页又是满的 → 按最多页数往前翻）
  const size = Number(first.data.page?.size) > 0 ? Number(first.data.page.size) : 20
  const count = Number(first.data.page?.count ?? 0)
  const last = count > 0 ? Math.min(Math.ceil(count / size), 1000) : (list.length >= size ? PARENT_PAGES : 1)
  for (let pn = last, n = 1; pn > 1 && n < PARENT_PAGES; pn -= 1, n += 1) {
    const p = await page(pn)
    if (!p.data) return p
    const hit = (p.data.replies ?? []).find((x) => idOf(x) === String(parentRpid))
    if (hit) return found(hit)
  }
  return { why: last > PARENT_PAGES ? `楼太长（${count} 条回复），翻了 ${PARENT_PAGES} 页没找到被回复的那条` : '这栋楼里没找到被回复的那条（可能被删了 / 被折叠了 / 坐标不对）' }
}

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i] ?? true)
}
// 2026-10-26 公开发言的出门检查（主人定，tools/lib/outbound.mjs）：正文在联网（认短链、登录态）、占额度、判重、记账、写文件之前先查 ——
//   站外链接、联系方式、长号码、主人的 UID / QQ、她的 QQ、电脑路径、cookie 的名字。--dry、--check 也查；主人批准的草稿也查（谁跑都一样）。
//   分享评论后面自动补的只是「@主人的昵称」（检查本来就放行它），所以查她写的原文就够了
if (typeof args.get('message') === 'string') {
  const kind = SHARE ? 'share' : (args.has('parent') || args.has('root')) ? 'reply' : 'comment'
  const bad = publicGate(args.get('message'), { channel: kind })
  if (bad) { console.error(bad.msg); process.exit(bad.code) }
}
const oid = args.get('oid')
// --bvid 也认 av 号 / 视频链接 / b23.tv 短链（lib/video-id.mjs 换成 BV 号）；认不出来的原样留着，下面照旧报「不是 BV 号」
const bvidArg = args.get('bvid')
const bvidRef = typeof bvidArg === 'string' ? await resolveVideoRef(bvidArg) : null
const bvid = bvidRef?.ok ? bvidRef.bvid : bvidArg
if (bvidRef?.note) console.error(bvidRef.note)
let message = args.get('message')
let root = args.get('root')     // 线程根评论 rpid（二级回复用）
let parent = args.get('parent') // 要回复的那条评论 rpid

// 2026-10-22 修（她连着三次撞上）：
//   B站 收件箱里【顶层评论】的 root_id 是 0 ✗
//   而 x/v2/reply/reply?root=0 什么都查不到 → parentAuthor 查不到被回复者
//   → once-per-person 的 fail-closed 把回复挡死 ✗（她报「没查到被回复者的 uid」）
//   root=0 的真实含义就是「parent 自己就是顶层评论」✓ 所以这里兜一下 ✓
if (parent && (!root || String(root) === '0')) root = String(parent)
// 反过来：只给了 --root、没给 --parent = 回那条根评论本身（以前这样传会绕开「同一个人只回一条」：判重只在有 --parent 时才做）
if (root && String(root) !== '0' && !parent) parent = String(root)

// type=1 视频（默认）；type=11 动态/图文。⚠️ 动态的 oid 必须用
// polymer/web-dynamic/v1/detail 给的 basic.comment_id_str，**不是** dyn_id 本身
// （拿 dyn_id 当 oid 一律 -404，2026-10-13 实测踩过）。
const type = String(args.get('type') ?? '1')
// 动态评论的 referer 要指到 opus 页；给了它就可以不给 --bvid。
const refererArg = args.get('referer') ? String(args.get('referer')) : ''
const dry = args.get('dry') === true || args.has('dry')
const go = args.get('go') === true || args.has('go')

// 2026-10-22：--check 只读预检 —— 回答「这条回复到底能不能发」✗ 不发文、不占额度
//   动机：她撞过几次 fail-closed 之后就开始凭记忆说「又被拒了」✗
//        给她一条零副作用的检查命令 ✓ 让她自己看到「现在是通的」✓
const CHECK = args.get('check') === true || args.has('check')
if (CHECK) {
  if (!oid) { console.error('--check 需要 --oid'); process.exit(2) }
  const look = (root && parent) ? await parentAuthor(oid, root, parent, type) : null
  const who = look?.who ?? null
  const ownerMid = String(config().owner?.mid ?? '')
  const lines = [
    `oid=${oid}  root=${root ?? '(未给)'}  parent=${parent ?? '(未给)'}  type=${type}`,
  ]
  if (!root || !parent) {
    lines.push('\n这是【顶层评论】（不带 --root/--parent）→ 判重不生效，可以直接发 ✓')
    console.log(lines.join('\n')); process.exit(0)
  }
  if (!who?.mid) {
    lines.push('\n✗ 查不到被回复者的 uid → 发的时候会被 fail-closed 挡下来 ✗')
    if (look?.why) lines.push(`  这次：${look.why}`)
    lines.push('  查不到的原因通常是：--root 传了 0 / --parent 不是楼中楼也不是顶层评论 / 该评论已删')
    lines.push('  修：root 传 0 或空时本命令会自动把它兜成 parent ✓ 再试一次')
    console.log(lines.join('\n')); process.exit(2)
  }
  lines.push(`\n被回复者：${who.name || '(无名)'}（mid ${who.mid}）`)
  if (ownerMid && String(who.mid) === ownerMid) {
    lines.push('✓ 是主人 → 「同一个人只回一条」不适用 ✓ 能发 ✓')
    console.log(lines.join('\n')); process.exit(0)
  }
  let led
  try { led = loadReplied() } catch (e) {
    lines.push(`✗ 判重账本有问题（${e.message}）→ 带 --once-per-person 会被拒 ✗ 请主人看一下 ~/.bili-ai/replied.json`)
    console.log(lines.join('\n')); process.exit(2)
  }
  const hist = repliedRecently(led, who.mid)
  if (hist.length) {
    lines.push(`✗ ${ONCE_DAYS} 天内已经回过 TA（${hist[0].at} · ${hist[0].target}）→ 带 --once-per-person 会被拒 ✗`)
    lines.push('  （是主人就不受这条限制 ✓；否则换个人或等过了 30 天）')
    console.log(lines.join('\n')); process.exit(2)
  }
  lines.push('✓ 30 天内没回过 TA → 能发 ✓')
  console.log(lines.join('\n')); process.exit(0)
}

// 坐标只收数字 / 真正的 BV 号（它们会被打印、拼进请求和记账；不能夹带「code=0」之类的文字冒充结果）
if ((oid && !/^\d{1,20}$/.test(String(oid))) || (root && !/^\d{1,20}$/.test(String(root))) || (parent && !/^\d{1,20}$/.test(String(parent)))) {
  console.error('--oid / --root / --parent 必须是数字'); process.exit(2)
}
if (bvid && !/^BV[0-9A-Za-z]{10}$/.test(String(bvid))) { console.error(bvidRef?.error ? `--bvid ${bvidRef.error}` : '--bvid 不是 BV 号'); process.exit(2) }
if (!oid || (!bvid && !refererArg) || !message) {
  console.error('usage: --oid <aid|comment_id_str> [--bvid <BV...> | --referer <url>] --message "<text>" [--type 1|11] [--root <rpid> --parent <rpid>] [--dry | --go] [--check]')
  process.exit(2)
}
if (dry && go) { console.error('pick either --dry or --go, not both'); process.exit(2) }
if (!dry && !go) { console.error('refusing to run without an explicit --dry or --go'); process.exit(2) }

// 她的会话里：正文 @ 主人的评论就是分享 —— 必须带 --share，走分享的规矩（每天上限、沉默衰减、同一视频 7 天一次）。
// （回复别人不用先审：2026-10-22 主人定，她可以直接回任何人；照常记账、照常报备主人）
if (isAgent()) {
  const ow = config().owner ?? {}
  if (!SHARE && ow.name && String(message ?? '').includes('@' + ow.name)) {
    console.error('✗ @ 主人的评论就是分享：要带 --share --auto（走分享的规矩：每天上限、主人沉默时少说、同一个视频 7 天一次）')
    process.exit(2)
  }
}

// --share（分享型）：正文里必须 @ 主人 —— 没写 @ 就自动补上。
// 昵称取配置的 owner.name（space/wbi/acc/info 可能被风控，不实时查）；
// 昵称改过的话，发完用 `thread` 看 `@到:` 就能发现（没解析出来就说明名字旧了）。
// --share（分享型）—— 2026-10-17 严格化（Kimi 评审指出两个洞）：
//   ① 必须与 --auto 同传：不然它就是"第三条自我声明车道"，绕开了自主发言那套判据
//   ② 正文**必须以 @<配置里的主人昵称> 开头**：以前"含个 @"就算数 → 一条 "@任何人 快来买" 也能过闸 ✗
if (SHARE) {
  // 2026-10-18 接线：设置页「分享评论」的总开关（关掉 = 只看不说 ✓）
  if (!shareEnabled(config())) {   // 2026-10-25：整段写坏了 / 开关写成「关」也算关
    console.error('分享已在设置里关闭（share.enabled = false）→ 这次不发（筛/深读/日记照常 ✓）')
    process.exit(3)
  }
  if (!AUTO) { console.error('--share 必须与 --auto 同传（分享型也是"她自己决定说的"）'); process.exit(2) }
  const ow = config().owner ?? {}
  if (!ow.name) { console.error('--share 需要先配置 owner.name（要 @ 谁）'); process.exit(2) }
  try { validateShare(config(), { reason: args.get('reason'), score: args.get('score'), rank: args.get('rank') ?? 1 }) }
  catch (e) { console.error(e.message); process.exit(2) }

  const want = `@${ow.name}`
  const body = String(message ?? '').trimStart()
  if (!body.startsWith(want)) {
    if (body.includes('@')) { console.error(`--share 的正文必须以 "${want}" 开头（里面那个 @ 不是主人）→ 拒绝发送`); process.exit(2) }
    message = `${want} ${message}`
    console.log(`[分享型] 正文没 @，已自动补：${want}`)
  }
}

// "同一个人只回一条"（可选 · 2026-10-17 加）：只在二级回复（--root + --parent）时生效。
// 用在"只回直接回她的人"那条流程里 → 同一个人 30 天内不会被回第二次（防拉锯、防被当聊天机器人）。
// 放在入口处（--dry 也会跑），这样"能不能回"在发之前就能知道。
let onceWho = null   // 要判重的那个人（不是主人、查到了 uid）；发送前在这个人身上做预留
if (ONCE) {
  if (!parent || !root) {
    console.log('  [once] 没有 --root/--parent —— 这个开关只对"回复某人"生效，已忽略')
  } else {
    const { who = null, why = null } = await parentAuthor(oid, root, parent, type)
    // 2026-10-22 临时诊断：把她实际传的参数 + 解析结果记下来（定位「同一命令我过她不过」）
    try {
      const fs2 = await import('node:fs')
      const os2 = await import('node:os')
      const p2 = await import('node:path')
      const line = [
        new Date().toISOString(),
        'oid=' + oid,
        'root=' + root,
        'parent=' + parent,
        'type=' + type,
        '→ who=' + JSON.stringify(who) + (why ? ' why=' + why : ''),
        'script=' + import.meta.url.split('/').slice(-2).join('/'),
      ].join(' ') + '\n'
      fs2.appendFileSync(p2.join(os2.homedir(), '.bili-ai', 'once-debug.log'), line)
    } catch {}
    // 2026-10-22 补回（这条在 v0.4.x 某次重写时丢了 ✗）：
    //   这个开关是给【陌生人】防拉锯的 ✗ 对主人生效会把主人锁 30 天 ✗
    const ownerMid = String(config().owner?.mid ?? '')
    if (who?.mid && ownerMid && String(who.mid) === ownerMid) {
      console.log(`  [once] 被回复的是主人（${who.name || who.mid}）→ 不适用「一个人只回一条」✓ 直接回`)
    } else if (!who?.mid) {
      // fail-closed（2026-10-17，Kimi 评审指出）：判重系统状态未知时，默认动作是**这次不回**
      console.error('  [once] 没查到被回复者的 uid → 判重状态未知，**这次不回**（fail-closed）')
      console.error(`  原因：${why ?? '查到了那条评论，但没有作者 uid'}`)
      console.error('  （确认要回就别传 --once-per-person，或者先手工确认这个人没被回过）')
      process.exit(2)
    } else {
      // 这里只是提前告诉她；真正的「判重 + 预留」在发送前、账本锁里一步做完（见下面 reserveOnce）
      let led
      try { led = loadReplied() } catch (e) {
        console.error(`  [once] 判重账本有问题（${e.message}）→ 判重状态未知，**这次不回**（fail-closed）`)
        console.error('  （请主人看一下 ~/.bili-ai/replied.json）')
        onceRefused('ledger')
        process.exit(2)
      }
      const hist = repliedRecently(led, who.mid)
      if (hist.length) {
        console.error(`  [once] ${ONCE_DAYS} 天内已经回过 ${who.name || who.mid}（${hist[0].at} · ${hist[0].target}）→ 这次不回`)
        console.error('  （不想要这个开关，就别传 --once-per-person）')
        onceRefused('taken', { mid: who.mid, at: hist[0].at, uncertain: Boolean(hist[0].pending || hist[0].uncertain) })
        process.exit(2)
      }
      onceWho = who
      console.log(`  [once] ${who.name || who.mid} 在 ${ONCE_DAYS} 天内没被回过 ✓ 可以回`)
    }
  }
}

const credPath = path.join((process.env.USERPROFILE || process.env.HOME || '/'), '.bili-ai', 'credentials.json')
if (!fs.existsSync(credPath)) {
  console.error(`credentials file missing: ${credPath}`)
  console.error('create it with {"sessdata":"...","bili_jct":"...","buvid3":"..."}')
  process.exit(3)
}
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
// 2026-10-21 修：buvid3 不该是必填 ✗ —— 没有它的用户会被这里直接 exit 3，评论永远发不出去
//   （B站 大部分写接口不需要 buvid3；缺了只影响个别接口）
const missing = ['sessdata', 'bili_jct'].filter((k) => !cred[k] || String(cred[k]).trim() === '')
if (missing.length) {
  console.error(`credentials file is missing values for: ${missing.join(', ')}`)
  process.exit(3)
}
if (!cred.buvid3 || String(cred.buvid3).trim() === '') {
  console.error('⚠️ 没有 buvid3（不影响评论；个别接口可能被风控）—— 想补就在 F12 → Cookies 里复制 buvid3')
}
const cookieHeader = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const referer = refererArg !== '' ? refererArg : `https://www.bilibili.com/video/${bvid}/`

// ---- WBI signing (harmless if the endpoint does not ask for it) -------------
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
async function wbiSign(params) {
  const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (!img || !sub) return null
  const raw = keyOf(img) + keyOf(sub)
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const query = Object.keys({ ...params, wts })
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(query + mixin).digest('hex')
  return { w_rid, wts, mixin }
}

// ---- who is behind this cookie? --------------------------------------------
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
  headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
})).json()
console.log('=== 登录态校验（只读） ===')
if (nav.code !== 0) {
  console.log(`  nav code=${nav.code} message=${nav.message}`)
  console.log('  → cookie 无效或已过期，先别发 —— 告诉主人：node host/cli.mjs cookie --qr 重新扫码')
  process.exit(4)
}
console.log(`  账号: ${nav.data.uname}   (mid ${nav.data.mid})`)
console.log(`  手机绑定: ${nav.data.mobile_verified ? '是' : '否'}   硬币 ${nav.data.money}`)
console.log('  ⚠️ 请确认这就是你的小号；若是主号，停手、换 cookie')

const params = { type, oid: String(oid), message, plat: '1', csrf: String(cred.bili_jct) }
if (root) params.root = String(root)
if (parent) params.parent = String(parent)
const signed = await wbiSign(params)
const body = new URLSearchParams(params).toString()
const url = signed
  ? `https://api.bilibili.com/x/v2/reply/add?w_rid=${signed.w_rid}&wts=${signed.wts}`
  : 'https://api.bilibili.com/x/v2/reply/add'

console.log('\n=== 将要发出的请求 ===')
console.log(`  POST  ${url}`)
console.log('  content-type: application/x-www-form-urlencoded')
console.log('  headers: UA(Chrome 131) + referer=' + referer)
console.log('  cookie : SESSDATA=***; bili_jct=***; buvid3=***   (已脱敏)')
console.log('  body   : ' + body.replace(encodeURIComponent(String(cred.bili_jct)), '***csrf***'))
console.log(`  正文长度 ${message.length} 字符（上限 1000）；oid=${oid}；emoji/表情需转义符，本脚本只发纯文本`)

// 闸门：自主发言（--auto）或分享型（--share）才拦；主人授权的发言只显示额度。
// dry 只判断；--go 时「判断 + 预留」在账本锁里一步做完（同时发好几条也突破不了上限），发成功落账、明确失败撤掉预留，
// 结果不确定（网络异常）预留留着照样占额度。都在这个进程里做，不再起 quota.mjs 子进程（她在命令行上碰不到记账）
const quotaTarget = bvid ? `BV:${bvid}` : `oid:${oid}`
// 分享的「同一视频 7 天一次」按 BV 记账：真正发之前核对 --bvid 就是 --oid 那个视频（以前 --bvid 只是她写的标签，换个标签就绕开了）
if (go && SHARE) {
  if (String(type) !== '1' || !bvid) {
    console.error(`✗ --share 只用于视频评论，而且要带 --bvid（现在 type=${type}，--bvid ${bvid ?? '没给'}）`)
    process.exit(2)
  }
  // BV 号和 aid 是固定的一一换算（video-id.mjs 的 bv2av，来回核对过；面板那边也是这样本地核对）：不联网。
  // 以前这里联网查旧的 /x/web-interface/view（裸请求、不带登录）：B站 回 412 风控页，解析不了 → 被报成「对不上」，
  // 2026-10-25 她 @ 主人的分享就这样连失败两次（BV 号其实没错）
  const aid = bv2av(bvid)
  if (aid == null || String(aid) !== String(oid)) {
    console.error(`✗ --bvid ${bvid} 是 aid ${aid ?? '?'} 那个视频，和 --oid ${oid} 对不上 —— 分享的 BV 号必须就是你评论的那个视频（--oid 要用这个视频的 aid）`)
    process.exit(2)
  }
}
console.log('')
const rid = dry ? null : reserveQuota({ type: 'comment', target: quotaTarget, auto: AUTO, share: SHARE, note: message.replace(/\s+/g, ' ') })
if (dry ? !gateQuota({ type: 'comment', target: quotaTarget, auto: AUTO, share: SHARE }) : !rid) {
  console.error('  → 拒绝发送。这是硬约束第 4 条的代码实现，不要绕过（要发请主人当场授权，或改白名单/额度）。')
  process.exit(2)
}

if (dry) {
  console.log('\n[dry] 预检通过，未发送。把 --dry 换成 --go 时仍会重新检查额度。')
  process.exit(0)
}

// 判重（--once-per-person）：在账本锁里「再查一遍 + 预留」，拿到预留才发。
// 同时发两条给同一个人只有一条拿得到；账本读坏了 / 结构不对 → 不发
let onceId = null
if (onceWho) {
  let r
  try { r = reserveOnce(onceWho, quotaTarget) } catch (e) {
    releaseQuota(rid)
    console.error(`  [once] 判重账本有问题（${String(e.message).slice(0, 120)}）→ 判重状态未知，**这次不回**（fail-closed）`)
    onceRefused('ledger')
    process.exit(2)
  }
  if (r.taken) {
    releaseQuota(rid)
    console.error(`  [once] ${ONCE_DAYS} 天内已经回过 ${onceWho.name || onceWho.mid}（${r.taken.at} · ${r.taken.target}${r.taken.pending ? ' · 另一条正在发' : ''}）→ 这次不回`)
    onceRefused('taken', { mid: onceWho.mid, at: r.taken.at, uncertain: Boolean(r.taken.pending || r.taken.uncertain) })
    process.exit(2)
  }
  onceId = r.id
}
const settle = (how, rpid) => {
  if (!onceId) return
  try { settleOnce(onceId, how, rpid) } catch (e) {
    console.log(`  [once] 判重记录没更新（${String(e.message).slice(0, 80)}）—— 预留还在，这个人 30 天内照样不会被回第二次`)
  }
}

console.log('\n[go] 发送中…')
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'user-agent': UA,
    referer,
    origin: 'https://www.bilibili.com',
    'content-type': 'application/x-www-form-urlencoded',
    cookie: cookieHeader,
  },
  body,
})
const out = await readWriteResult(res, 'reply/add')   // 先看风控（熔断）再解析：风控拦截常是一张 HTML 页面
const outcome = writeOutcome(out)                     // sent / rejected（明确没收）/ uncertain（可能其实发出去了）
// 主人那边批准草稿时，从一个只有主人知道的文件拿结果（不从输出里找「code=」—— 输出里也有她写的字段）
if (process.env.BILI_RESULT_FILE && !isAgent()) {
  try { fs.writeFileSync(process.env.BILI_RESULT_FILE, JSON.stringify({ code: out.code ?? null, rpid: String(out.data?.rpid_str ?? out.data?.rpid ?? ''), status: res.status, outcome })) } catch {}
}
console.log(`  HTTP ${res.status}`)
console.log(`  code=${out.code} message=${out.message ?? ''}`)
if (out.code === 0) {
  const rpid = out.data?.rpid_str ?? out.data?.rpid
  console.log(`  ✅ 已发布，评论 rpid=${rpid}`)
  // once-per-person：发送前拿到的预留落账（主人不判重，入口处就没给他预留 → 回他不会被锁 30 天）
  if (onceId) {
    settle('commit', String(rpid ?? ''))
    console.log(`  [once] 已记账：${onceWho.name || onceWho.mid}（30 天内不再回 TA）`)
  }
  // 记账（发出去才算数）：把预留落账
  commitQuota(rid, { type: 'comment', target: quotaTarget, note: message.replace(/\s+/g, ' '), share: SHARE })
  // 自主 / 分享型 → **自动报备**（把 AGENTS 里的"约定"落到代码里；后端由 config.notify 决定）
  if (AUTO || SHARE) {
    try {
      // 报备给主人看的是真正发到的位置（oid / type / root / parent，不只是她写的 --bvid 标签）和整段正文（以前只给前 80 字）
      const where = `oid=${oid} type=${type}${root ? ` root=${root}` : ''}${parent ? ` parent=${parent}` : ''}${bvid ? `（她标的视频：${bvid}${SHARE ? '，已核对' : '，未核对'}）` : ''}`
      const body = message.length > 600 ? `${message.slice(0, 600)}…（共 ${message.length} 字）` : message
      const msg = `[${SHARE ? '分享型·@主人' : '自主发言'}] 评论已发出 rpid=${rpid}\n位置：${where}\n内容：${body}`
      execFileSync(NODE_EXE,
        [path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs'), msg, '--title', SHARE ? '分享评论报备' : '自主发言报备'],
        { stdio: 'inherit', windowsHide: true, timeout: 60_000 })   // notify 自己 45 秒内一定结束；以前没设，卡住要等满 2 分钟
    } catch (e) {
      console.log(`  [通知] 发出去了但报备失败：${String(e.message).slice(0, 120)}——请手动告诉使用者`)
    }
  }
  // 观众记忆：她回了某人的评论 → 记下 TA 说了什么、她回了什么、在哪条线程（按 UID 认人；放在落账、报备之后，记不上不影响已发出的评论）
  // 查被回复者最多等 10 秒（长楼要多翻几页，也不能把已经发出去的命令拖住）；记不上要说出来、说清楚为什么（以前查不到就悄悄跳过）
  if (parent && root) {
    let why = null
    try {
      const look = await parentAuthor(oid, root, parent, type, 10_000)
      const who = look.who
      const selfMid = String(config().self?.mid ?? '')
      if (!who) why = look.why
      else if (!who.mid) why = '查到了被回复的那条，但没有作者 UID'
      else if (who.mid !== selfMid) {
        const dyn = (referer.match(/(?:opus|t\.bilibili\.com)\/(\d+)/) ?? [])[1] ?? null
        const m = recordExchange({ uid: who.mid, name: who.name, theirText: who.text, theirMsgId: parent, herText: message, herMsgId: rpid,
          thread: threadKey(type, oid, root), target: { type: Number(type), oid: String(oid), bvid: bvid || null, dyn } })
        if (m.result === 'ok') console.log(`  [记忆] 记下了和 ${who.name || who.mid}（UID ${who.mid}）的这次交流`)
      }
    } catch (e) { why = String(e?.message ?? e).slice(0, 80) }
    if (why) console.log(`  [记忆] 没记上 —— 本次交流未记入记忆（不影响已发出的评论）：${why}`)
  }
  console.log(bvid
    ? `  https://www.bilibili.com/video/${bvid}/#reply${rpid}`
    : `  ${referer.replace(/\/$/, '')}#reply${rpid}`)
  process.exit(0) // P0-6：成功
} else {
  const hints = {
    '-101': '账号未登录：cookie 失效',
    '-102': '账号被封停',
    '-111': 'csrf 校验失败：bili_jct 不对或与 SESSDATA 不是同一个号',
    '-509': '请求过于频繁',
    12015: '需要评论验证码（说明被风控盯上了，停手）',
    12016: '内容含敏感信息',
    12035: '被 UP 主列入评论黑名单',
    12051: '重复评论被判刷屏',
    12002: '评论区已关闭',
  }
  // B站 明确回了失败 / 风控拦下：撤掉预留；回包读不出来、服务端超时 / 内部错误（-500/-503/-504、5xx）= 不知道发没发出去，
  // 额度预留和判重预留都留着（判重那条标「不确定」）
  // 明确没收 → 撤掉预留；不知道发没发出去 → 预留标成「不确定」（照样占额度；本地面板会提醒主人去看一眼）
  if (outcome === 'rejected') { releaseQuota(rid); settle('release') } else { releaseQuota(rid, { uncertain: true }); settle('uncertain') }
  if (outcome === 'uncertain') console.log('  ⚠️ 不知道发没发出去（B站 可能其实收到了）—— 先去那条评论下面看一眼，别马上重发')
  if (hints[String(out.code)]) console.log(`  提示：${hints[String(out.code)]}`)
}

// P0-6（Kimi 评审 #6）：走到这里 = 没发成功。给非 0 退出码，
// 否则 agent 会把「被风控拒了」当成「发成功了」，绕过了「撞风控立刻停手」的红线 ✗
process.exit(6)
