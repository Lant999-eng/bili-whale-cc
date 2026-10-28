// 待审回复（2026-10-18 主人选 B 档：**发前审核**）——
//
// 她的回复**不再直接发** ✗，而是：
//   ① 她把草稿写进 `~/.bili-ai/pending-replies.json`（本脚本 add ✓）
//   ② 设置页「待审核」里主人看得到 → 点「发」/「删」
//   ③ 点「发」时插件才真的跑 `comment --go`（带 --auto ✓ 会报备 ✓）
//
// 为什么这么设计：回复是"先去碰别人" ✓ 比分享那句 @ 主人更需要一道人际上的缓冲 ✓
// 而且主人能顺手否掉"太冲/太软/答偏了"的那种 ✓ —— 否掉的也会进她的「偏好校准」✓（学会分寸）
//
// 用法:
//   node reply-draft.mjs add --oid 123 --bvid BVxxx --root 456 --parent 789 \
//        --who 对方昵称示例 --message "…" [--src "他说的话"]
//   node reply-draft.mjs list [--json]
//   node reply-draft.mjs drop <id>
//   node reply-draft.mjs take <id>        （插件审批时用：取出参数并从队列删掉）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { isAgent } from '../lib/paths.mjs'
import { updateJsonLocked } from '../lib/filelock.mjs'
import { walkThread, THREAD_PAGES } from '../lib/reply-thread.mjs'
import { resolveVideoRef } from '../lib/video-id.mjs'
import { publicAdvice } from '../lib/outbound.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const FILE = path.join(HOME, '.bili-ai', 'pending-replies.json')

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  } else if (!opt._a) opt._a = argv[i]
}

const load = () => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { items: Array.isArray(j.items) ? j.items : [] } }
  catch { return { items: [] } }
}
// 改队列一律在锁里读改写、原子写回（以前直接覆盖：她 add 的同时主人 take / drop，已经发掉或否掉的草稿会被写回来）
const update = (fn) => updateJsonLocked(FILE, (j) => { j.items = Array.isArray(j.items) ? j.items : []; return fn(j) }, { items: [] })

/**
 * 去 B站 查「要回的那条评论」真正是谁写的、写了什么 —— 主人审的时候看这个，不只看她自己写的 who / src
 * 返回 { real: { mid, name, text } 或 null, why }：查不到时 why 说清楚为什么（推给主人的那条里照实写上）
 * 2026-10-23 修（Astra 评审，和 comment.mjs 同一类）：以前只往后翻前 4 页（80 条）—— 长楼里要回的那条多半在后面，
 *   查不到就成了「没核实」。现在先看 data.root 和第 1 页，再从最后一页往前翻（最多 10 页、有总时限、走 apiGet）
 */
async function fetchParent(oid, root, parent, type = '1') {
  const idOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '')
  let hit = null
  try {
    const w = await walkThread({ type, oid, root, headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }, budgetMs: 30_000,
      visit: (data, pn) => {
        // 要回的是顶层评论（root == parent）时它不在 replies 里，就是同一个响应里的 data.root
        hit = [...(data.replies ?? []), ...(pn === 1 && data.root ? [data.root] : [])].find((x) => idOf(x) === String(parent)) ?? null
        return Boolean(hit)
      } })
    if (!hit) return { real: null, why: w.why ?? (w.long ? `楼太长（${w.count} 条回复），翻了 ${THREAD_PAGES} 页没找到要回的那条` : '这栋楼里没找到要回的那条（可能被删了 / 被折叠了 / 坐标不对）') }
  } catch (e) { return { real: null, why: String(e?.message ?? e).slice(0, 80) } }
  return { real: { mid: String(hit.mid_str ?? hit.mid ?? hit.member?.mid ?? ''), name: String(hit.member?.uname ?? ''), text: String(hit.content?.message ?? '').slice(0, 300) } }
}

if (cmd === 'add') {
  const { oid, root, parent, who, message, src } = opt
  // --bvid 也认 av 号 / 视频链接 / b23.tv 短链（lib/video-id.mjs 换成 BV 号）；认不出来的原样留着，下面照旧报「不是 BV 号」
  const bvidRef = typeof opt.bvid === 'string' ? await resolveVideoRef(opt.bvid) : null
  const bvid = bvidRef?.ok ? bvidRef.bvid : opt.bvid
  if (bvidRef?.note) console.error(bvidRef.note)
  if (!oid || !message) { console.error('需要 --oid 和 --message'); process.exit(2) }
  if (!root || !parent) { console.error('回复要有 --root 和 --parent（坐标从 comment-digest 拿）'); process.exit(2) }
  // 坐标只收数字 / 真正的 BV 号：这些字段会被拼进主人那边批准时的命令，不能夹带别的东西
  const type = String(opt.type ?? '1')
  if (!['1', '11', '12', '17'].includes(type)) { console.error('--type 只能是 1（视频）/ 11、17（动态）/ 12（专栏）'); process.exit(2) }
  if (![oid, root, parent].every((x) => /^\d{1,20}$/.test(String(x)))) { console.error('--oid / --root / --parent 都必须是数字'); process.exit(2) }
  if (bvid && !/^BV[0-9A-Za-z]{10}$/.test(String(bvid))) { console.error(bvidRef?.error ? `--bvid ${bvidRef.error}` : '--bvid 不是 BV 号'); process.exit(2) }
  if (type === '1' && !bvid) { console.error('视频下面的回复要带 --bvid'); process.exit(2) }
  const text = String(message).trim()
  if (text.length > 500) { console.error('草稿太长（>500），砍短'); process.exit(2) }
  // 2026-10-26 公开发言的出门检查（tools/lib/outbound.mjs）：草稿还要主人审，这里不拦 —— 过不了的照样进队列，但告诉她、也写进给主人的通知
  //   （主人批准时 comment 那边的检查还会拦下它：以前要等批准了才知道，然后一次次回到队列里）
  const publicCheck = publicAdvice(text, { channel: 'reply' })
  // B站 上那条评论真正的作者和原文（主人审的时候以这个为准；查不到就标明「没核实」）
  // 顶层评论：收件箱给的 root 是 0，reply/reply?root=0 什么都查不到 —— 和 comment.mjs 一样拿 parent 当楼主去查（存的坐标不变）
  const { real, why: realWhy } = await fetchParent(String(oid), String(root) === '0' ? String(parent) : String(root), String(parent), type)
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    oid: String(oid), type, bvid: bvid ? String(bvid) : '', root: String(root), parent: String(parent),
    who: who ? String(who) : '', src: src ? String(src).slice(0, 300) : '',
    real,   // { mid, name, text } 或 null
    message: text,
    ...(publicCheck ? { publicCheck } : {}),
  }
  let dup = false
  update((db) => {
    // 同一个 parent 不重复排队 ✓
    if (db.items.some((x) => String(x.parent) === String(parent))) { dup = true; return db }
    db.items.push(item)
  })
  if (dup) { console.log('（这个 parent 已经在队列里了，没重复加 ✓）'); process.exit(0) }
  console.log(`✓ 已进待审队列：${item.id} → ${item.who || '（对方）'} · ${text.length} 字`)
  if (!real) console.log(`（B站 上没核实到要回的那条：${realWhy}；主人那边会看到「没核实到」）`)
  if (publicCheck) console.log(`⚠️ ${publicCheck} —— 主人批准了也发不出去：最好 drop ${item.id} 改好再 add`)

  // 2026-10-18 主人定：**需要审核的回复直接推送给主人** ✓（不做设置页 UI ✗）
  // best-effort：推送失败不影响入队 ✓
  try {
    const summary = [
      `【等你审核 1 条回复】→ ${real ? `${real.name}（mid ${real.mid}，B站 上查到的）` : `${item.who || '对方'}（她写的，没核实到：${realWhy}）`}`,
      real ? `TA 在 B站 上说：${real.text}` : (item.src ? `她转述 TA 说：${item.src}` : ''),
      `你要回：${text}`,
      publicCheck ? `⚠️ 出门检查：${publicCheck}（批准了也会被拦下，可以直接否掉让她改）` : '',
      `发：node host/cli.mjs pending approve ${item.id}    不发：node host/cli.mjs pending reject ${item.id} 理由（或者在 Claude Code 里 /whale-pending）`,
    ].filter(Boolean).join('\n')
    const notifier = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs')
    // 同步等推送发完再退出：以前起了推送就立刻退出，Windows 上子进程会跟着被结束，主人收不到。
    // notify 自己 30 秒内一定结束（主方式卡住也给备用方式留了时间），这里多等一会儿；以前这里只等 30 秒、notify 却可能要更久，备用方式永远轮不到
    const pushed = spawnSync(NODE_EXE, [notifier, summary, '--title', '待审回复'], {
      windowsHide: true, timeout: 45_000, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, WHALE_NOTIFY_BUDGET_MS: '30000' },
    })
    if (pushed.error || pushed.status !== 0) console.log('  ⚠️ 推送没发成：主人可能不知道有一条回复在等他审 —— 草稿还在待审队列里；下次和主人说话时提一句')
  } catch {}
  process.exit(0)
}

if (cmd === 'list') {
  const db = load()
  if (argv.includes('--json')) { console.log(JSON.stringify(db, null, 2)); process.exit(0) }
  if (!db.items.length) { console.log('（队列是空的 ✓ 没有等审的回复）'); process.exit(0) }
  console.log(`待审 ${db.items.length} 条：`)
  for (const x of db.items) {
    // 2026-10-18 修：原来直接切 ISO 串 = 显示的是 UTC ✗（本地 08:15 显示成 00:15 ✗）
    const t = new Date(x.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    console.log(`  ${x.id}  ${t}  → ${x.who || '?'}  「${x.message.slice(0, 40)}${x.message.length > 40 ? '…' : ''}」`)
  }
  process.exit(0)
}

if (cmd === 'show') {
  // 只读：看一条的完整内容（不删！）—— 2026-10-18 加，防止"take 出来才发现内容没截全" ✗
  const id = opt._a
  if (!id) { console.error('用法: node reply-draft.mjs show <id>'); process.exit(2) }
  const db = load()
  const hit = db.items.find((x) => x.id === id)
  if (!hit) { console.error(`没有这个 id：${id}`); process.exit(2) }
  if (argv.includes('--json')) { console.log(JSON.stringify(hit, null, 2)); process.exit(0) }
  console.log(`id      : ${hit.id}`)
  console.log(`对方    : ${hit.who || '?'}`)
  console.log(`对方说  : ${hit.src || '（未记录）'}`)
  console.log(`坐标    : oid=${hit.oid} bvid=${hit.bvid} root=${hit.root} parent=${hit.parent}`)
  console.log(`你要回  : ${hit.message}`)
  process.exit(0)
}

if (cmd === 'take' && isAgent()) { console.error('take 只给主人审批用（取出就从队列删掉）—— 她不能自己取走草稿'); process.exit(2) }
if (cmd === 'drop' || cmd === 'take') {
  const id = opt._a
  if (!id) { console.error('用法: node reply-draft.mjs drop <id>'); process.exit(2) }
  let hit = null
  update((db) => {
    hit = db.items.find((x) => x.id === id) ?? null
    db.items = db.items.filter((x) => x.id !== id)
  })
  if (!hit) { console.error(`没有这个 id：${id}`); process.exit(2) }
  if (cmd === 'take') console.log(JSON.stringify(hit))
  else console.log(`✓ 已删掉 ${id}`)
  process.exit(0)
}

console.log('用法: node reply-draft.mjs add … | list [--json] | drop <id> | take <id>')
