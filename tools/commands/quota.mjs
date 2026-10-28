import { apiGet } from '../lib/bili-api.mjs'
// 对外发言的「限额闸」—— B 档"限额自主"的代码强制部分（2026-10-14 主人选 B 档）。
//
// 为什么不靠自觉：主人明确要求"限频写进代码，不是写进你的自觉里"。
// 数据文件: ~/.bili-ai/quota.json
//   { daily: 2, scope: ["uid:<你的mid>", "room:<房间号>", "BV1xx411c7mD"], log: [{ at, type, target, note }] }
//
// 用法:
//   node quota.mjs status                        今天用了多少 / 上限 / 剩余 / 白名单 / 最近记录
//   node quota.mjs check --type comment [--target "BVxxx"]    超限或不在白名单 → **退出码 2**（调用方据此拒绝发言）
//   node quota.mjs record --type comment --target "BVxxx" [--note "…"]   记账
//   node quota.mjs set --daily 3                 改额度
//   node quota.mjs allow "room:<房间号>"         往白名单加一项（也支持 --remove 删除）
//
// 约定：check 只挡"发言类"动作（comment / dynamic / danmaku）；读操作永远不受限。
import fs from 'node:fs'
import path from 'node:path'
import { newReplies } from '../lib/feedback.mjs'
import { config, shareDailyOf, capText, shareEnabled } from '../lib/config.mjs'
import { shareThreshold, topOnly } from '../lib/share-policy.mjs'
import { isAgent } from '../lib/paths.mjs'
import { NODE_EXE } from '../lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { QUOTA_FILE as FILE, loadLedger, decide, recordSpeech, silence as silenceOf, loadFeedback, saveFeedback, today, dayOf } from '../lib/ledger.mjs'

// 账本的读写、额度判断、沉默衰减都在 tools/lib/ledger.mjs（发言工具在自己的进程里直接调它：判断 + 预留一步在锁里做完）。
// fail-closed：账本文件存在但坏了 = 状态未知 → 拒绝发言、也不覆盖写。
// ── 沉默衰减（2026-10-18 加，主人定）────────────────────────────────
// 反馈的定义：**任何表态都算**（回她的评论 / 点赞 / 在微信里说一句 / 让她做点事…）
// 都没有 = 沉默。沉默 ≥ silentAfterDays(3) 天开始降，到 silentStopDays(7) 降到 0
// 扣到 0 就停止分享；**但两本日记照常写**（那是她的日子，不是发言）。
const { q, corrupt } = loadLedger()
const silence = () => silenceOf(q)
// 2026-10-20：按 BV 取视频标题（带本地缓存）—— 模块级，供 react 记录时用
const TITLE_CACHE = path.join((process.env.USERPROFILE || process.env.HOME || '.'), '.bili-ai', 'liked-videos.json')
const loadTitleCache = () => { try { return JSON.parse(fs.readFileSync(TITLE_CACHE, 'utf8')) } catch { return {} } }
const saveTitleCache = (m) => { try { fs.writeFileSync(TITLE_CACHE, JSON.stringify(m, null, 2)) } catch {} }
async function titleOf(bv, cache) {
  if (!bv) return ''
  if (cache[bv]) return cache[bv]
  try {
    const j = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bv, { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' })
    const t = String(j?.data?.title ?? '')
    if (t) cache[bv] = t
    return t
  } catch { return '' }
}

const usedToday = (q) => q.log.filter((x) => dayOf(x.at) === today()).length

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  // ⚠️ 2026-10-18 修：裸旗标放在**最后**时 argv[i+1] 是 undefined →
  //   旧写法把 opt 设成 undefined（不是 true），`--share` 就被静默吞掉：
  //   comment.mjs 内部把 --share 放在参数末尾 → 限额闸当成"主人授权"、7 天内重复检查也不跑 ✗
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
  else if (!opt._a) opt._a = argv[i]
}
// bili-whale-cc：她的会话里（BILI_WHALE_AGENT=1）一切发言都是「她自己决定的」—— 不带 --auto 也按自主算（ledger.normalize 里做）。
// 改账本 / 改反馈记录的命令在她的会话里一律不给：
//   · record —— 记账由发言工具自己在进程里做（预留 → 落账）；她手动记账没有正当用途
//   · react（不带 --auto）—— 「主人表态了」只能由主人那边记（cli react、当面聊、审片 / 审草稿都会自动记），
//     以前她跑一句 quota react 就能把「沉默 10 天、分享额度 0」改回「沉默 0 天」（Astra 审查）
//   react --auto 照常给她：它去 B站 查主人真实的回复 / 点赞，不是她说了算
if (isAgent() && (cmd === 'record' || (cmd === 'react' && !opt.auto))) {
  console.error(cmd === 'record'
    ? '✗ 记账由发言工具自己做（发出去才记），不用也不能手动记'
    : '✗ 主人的表态只能由主人那边记：他回你 / 赞你会被 `quota react --auto` 查到；跨端说的话，请他跑 node host/cli.mjs react，或者当面聊一次（也会自动记）')
  process.exit(2)
}

if (cmd === 'status') {
  // 回陌生人私信（type 'sdm'）不是对外发言，也不在这里列（陌生人的事不进她的主会话；主人看面板）
  const pub = { ...q, log: q.log.filter((x) => x.type !== 'sdm') }
  const used = usedToday(pub)
  const usedAuto = pub.log.filter((x) => dayOf(x.at) === today() && x.auto && !x.share).length
  const usedShare = pub.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`今日对外发言: 共 ${used} 条（**分享型** ${usedShare}/${capText(shareDailyOf(q.shareDaily))} · 自主发言不设条数上限 ✓ · 主人授权 ${used - usedAuto - usedShare} 条）   日期 ${today()}`)
  console.log(`缰绳：分享 ${Number.isFinite(shareDailyOf(q.shareDaily)) ? `≤${shareDailyOf(q.shareDaily)}/天` : "每天不限条数（沉默照样降）"} · ${!shareEnabled(config()) ? "分享已关闭" : Number.isFinite(shareThreshold(config())) ? `评分卡 ≥${shareThreshold(config())}/20` : "门槛读不出来（分享会被拦）"}${topOnly(config()) ? " · 只发第一名" : " · 够分就能发"} · 同一视频 7 天一次 · 署名复核 · 事后报备`)
  console.log(`已删除（2026-10-18 主人定）：白名单 ✗ · 「自主 N 条」独立额度 ✗`)
  const recent = pub.log.slice(-5)
  console.log(recent.length ? '最近记录:' : '最近记录: (无)')
  for (const r of recent) console.log(`  ${r.at}  ${r.type}  ${r.target ?? '-'}  ${r.note ?? ''}`)
  process.exit(0)
}

if (cmd === 'check') {
  // 只判断、不改账本（真正发的时候，发言工具会在账本锁里「判断 + 预留」一步做完）
  // 规则见 tools/lib/ledger.mjs decide：分享型 ≤ shareDaily（受沉默衰减）+ 同一视频 7 天一次；自主动态 ≤ studio.dynamicDaily；
  // 自主评论 / 弹幕在 quota.autoDaily > 0 时各 ≤ autoDaily；账本坏了 = 一律拒绝
  const d = decide(q, corrupt, { type: typeof opt.type === 'string' ? opt.type : 'unknown', target: typeof opt.target === 'string' ? opt.target : '', auto: !!opt.auto, share: !!opt.share })
  for (const l of d.lines) console.log(l)
  process.exit(d.ok ? 0 : 2)
}

if (cmd === 'record') {
  const type = typeof opt.type === 'string' ? opt.type : 'unknown'
  const r = recordSpeech({ type, target: typeof opt.target === 'string' ? opt.target : null, note: opt.note ?? null, auto: !!opt.auto, share: !!opt.share })
  if (!r.ok) { for (const l of r.lines ?? []) console.log(l); process.exit(2) }
  const { q: q2 } = loadLedger()
  const usedShare = q2.log.filter((x) => dayOf(x.at) === today() && x.share).length
  console.log(`已记账：${type}${opt.share ? '（分享型·@主人）' : opt.auto ? '（自主）' : '（主人授权）'}${opt.target ? ' → ' + opt.target : ''}   今日分享 ${usedShare}/${capText(shareDailyOf(q2.shareDaily))}`)
  process.exit(0)
}

// 自动识别反馈（2026-10-18 加，主人要求；2026-10-18 夜补 likes）：
//   能自动的两半边：
//     ① 主人回了她的评论 → 收件箱「回复我的」（comment-digest）
//     ② 主人**赞**了她 → 「收到的赞」`likes --owner`（B站确实给 who ✓，此前以为看不到 ✗）
//   自动不了：跨端表态（微信/桌面…各端互不可见 ✗）→ 那半边靠收到的人当场 `quota react --note`
//   所以是 best-effort：查到就记，查不到就明说"没检测到"（可能是跨端表态）
// 2026-10-20：她"主动问一次"之后记一笔 —— 避免 3-6 天档反复追问（只问一次 ✓）
if (cmd === 'ask') {
  const fb = loadFeedback()
  fb.askedAt = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.askedAt, note: opt.note ? String(opt.note).slice(0, 80) : '主动问了一次' }].slice(-200)
  saveFeedback(fb)
  console.log('✓ 已记下「问过一次」（这轮沉默里不再问 ✓）')
  process.exit(0)
}

if (cmd === 'react' && opt.auto) {
  try {
    const { execFileSync } = await import('../lib/capture.mjs')
    const here = (f) => decodeURIComponent(new URL(f, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const hours = String(opt.hours ?? 72)
    const found = []
    // ① 回复
    try {
      // 2026-10-22 修（Issue #14）：以前拿人类可读文本做子串匹配 ✗
      //   统计行/标签行里出现主人名也会命中 → 误记反馈 → 沉默衰减被清零 ✗
      //   现在读 --json 的结构化结果，按 mid 精确比对 ✓
      const out = execFileSync(NODE_EXE, [here('./comment-digest.mjs'), '--hours', hours, '--pages', '1', '--json'], { encoding: 'utf8' })
      const ownerName = String(config().owner?.name ?? '')
      const ownerMid = String(config().owner?.mid ?? '')
      // 从结构化结果里取「主人回了几条」✓
      let digest = null
      try { digest = JSON.parse(String(out).trim().split(/\r?\n/).pop() ?? '') } catch {}
      const ownerReplyCount = Number(digest?.ownerReplies ?? 0)
      if (ownerReplyCount > 0) {
        // 只把"和主人有关"的行拿去算哈希（内容变了才继续算新表态 ✓）
        const lines = (digest?.ownerReplyItems ?? []).map((r) => `${r.time} [${r.kind}] ${r.who}：「${r.text}」`)
        const { createHash } = await import('node:crypto')
        found.push({ kind: 'reply', label: '回复', items: digest.ownerReplyItems, hash: createHash('sha1').update(lines.join('\n')).digest('hex') })
      }
    } catch { /* 收件箱失败不影响点赞这一路 */ }
    // ② 点赞（--json 里 ownerLiked 是确定数字，比抠文本稳）
    try {
      const js = execFileSync(NODE_EXE, [here('./likes.mjs'), '--owner', '--json', '--hours', hours], { encoding: 'utf8' })
      const o = JSON.parse(js)
      const ownerMid2 = String(config().owner?.mid ?? '')
      if (Number(o.ownerLiked ?? 0) > 0) {
        // 取"主人点过的那几条"里最新的 like_time —— 只有比上次记的更新才算新表态 ✓
        let maxTime = 0
        const liked = []
        for (const it of (o.items ?? [])) {
          const mine = (it.users ?? []).some((u) => String(u.mid) === ownerMid2)
          if (!mine) continue
          const t = Number(it.like_time ?? 0)
          maxTime = Math.max(maxTime, t)
          // 2026-10-20 加：item.uri 里有视频地址、item.title 是评论原文 → 存下来 ✓
          const uri = String(it.item?.uri ?? '')
          const bv = (uri.match(/BV[0-9A-Za-z]{10}/) ?? [])[0] ?? ''
          liked.push({ bv, comment: String(it.item?.title ?? '').slice(0, 140), likeTime: t })
        }
        found.push({ kind: 'like', label: `点赞×${o.ownerLiked}`, count: Number(o.ownerLiked), maxTime, liked })
      }
    } catch { /* 同上 */ }
    // ⚠️ 2026-10-20 修（社区+实测）：以前只要 48h 内有赞就记 → 同一个赞每轮都记 ✗
    //   → 沉默永远清零 → 衰减实际要 5 天才开始（设计是 3 天）✗
    //   现在：点赞按 like_time 去重（只有更新的赞才算"新表态"）✓
    //        回复按"主人相关行的哈希"去重（内容没变就不算新）✓
    if (found.length) {
      const fb = loadFeedback()
      const nowIso = new Date().toISOString()
      let changed = false
      let newest = Number.isFinite(Date.parse(fb.last)) ? Date.parse(fb.last) : 0
      fb.events = [...(fb.events ?? [])]
      for (const f of found) {
        if (f.kind === 'like') {
          const prev = Number(fb.lastLikeTime ?? 0)
          if (f.maxTime > prev) {
            fb.lastLikeTime = f.maxTime
            newest = Math.max(newest, Math.min(Date.now(), f.maxTime * 1000))
            // 只有"这次新出现的"才记（比上次 maxTime 新的那些）✓
            const fresh = (f.liked ?? []).filter((x) => x.likeTime > prev)
            if (fresh.length) {
              // 补视频标题（她写「偏好校准」和 feed 加权都要用 ✓）
              const cache = loadTitleCache()
              for (const x of fresh) x.videoTitle = await titleOf(x.bv, cache)
              saveTitleCache(cache)
              for (const x of fresh) {
                fb.events.push({
                  at: nowIso,
                  kind: 'like',
                  bv: x.bv,
                  videoTitle: x.videoTitle ?? '',
                  comment: x.comment,
                  note: x.bv
                    ? `主人赞了你在 ${x.bv} 的那条评论：${x.comment.slice(0, 60)}`
                    : `主人赞了你的评论：${x.comment.slice(0, 60)}`,
                })
              }
            } else {
              fb.events.push({ at: nowIso, note: `auto: 检测到主人（点赞×${f.count}）` })
            }
            changed = true
          }
        } else if (f.kind === 'reply') {
          const reply = newReplies(f.items, fb)
          const migrated = !fb.lastReplyTime && fb.lastReplyHash === f.hash
          fb.lastReplyHash = f.hash
          fb.lastReplyTime = reply.time
          fb.replyIds = reply.ids
          if (reply.fresh.length && !migrated) {
            newest = Math.max(newest, reply.time)
            fb.events.push({ at: new Date(reply.time).toISOString(), note: 'auto: 检测到主人（回复）' })
            changed = true
          }
        }
      }
      fb.events = fb.events.slice(-200)
      if (changed) {
        fb.last = new Date(newest).toISOString()
        saveFeedback(fb)
        const names = found.filter((f) => (f.kind === 'like' ? f.maxTime > Number(fb.lastLikeTime ?? 0) - 1 : true)).map((f) => f.label)
        console.log(`✓ 自动识别到主人的【新】表态（${names.join(' / ') || found.map((f) => f.label).join(' / ')}）→ 已记一次反馈（沉默清零）`)
      } else {
        saveFeedback(fb) // Persist migrated IDs even without a new reaction.
        console.log('（近 ' + hours + ' 小时有主人的表态，但都是【已经记过的】→ 不重复记 ✓ 沉默继续累计）')
      }
    } else {
      console.log(`（近 ${hours} 小时：没有主人的回复，也没有主人的点赞）—— 沉默继续累计`)
      console.log('  ⚠️ 跨端表态（微信/桌面…）这边看不见 → 需要收到的那一端当场 `quota react --note "…"`')
    }
  } catch (e) {
    console.log('自动识别失败：' + String(e.message).slice(0, 160))
  }
  process.exit(0)
}

if (cmd === 'react') {
  const fb = loadFeedback()
  fb.last = new Date().toISOString()
  fb.events = [...(fb.events ?? []), { at: fb.last, note: opt.note ?? '' }].slice(-200)
  saveFeedback(fb)
  const sil = silence()
  console.log(`已记一次反馈（现在沉默 0 天）· 分享上限回到 ${capText(sil.cap)}`)
  process.exit(0)
}

if (cmd === 'silence') {
  const sil = silence()
  if (opt.json) { console.log(JSON.stringify({ days: sil.days, last: sil.last, cap: Number.isFinite(sil.cap) ? sil.cap : null, unlimited: sil.cap === Infinity, base: Number.isFinite(sil.base) ? sil.base : null, band: sil.band, asked: sil.asked })); process.exit(0) }   // 不限 = unlimited:true（JSON 里 Infinity 会变成 null，分不清不限和算不出来）
  console.log(sil.unreadable ? '沉默天数: 读不出来（最后一次表态的记录坏了）→ 按已经停了算；修：node host/cli.mjs react' : `沉默天数: ${sil.days} 天（最后一次表态 ${sil.last ?? '从未'}）`)
  console.log(`档位: ${sil.band === 'normal' ? '正常' : sil.band === 'quiet' ? '安静（有点想他）' : '心慌（不敢打扰）'}${sil.asked ? ' · 已问过一次' : ''}`)
  console.log(`衰减: 分享上限 ${capText(sil.base)} → ${capText(sil.cap)}${sil.cap === 0 ? '（已停止分享，但日记照常写）' : ''}`)
  process.exit(0)
}

// 2026-10-18 删除：set / allow 是**死代码** ✗（save() 只持久化 {log}，改了 daily/scope 也存不下来；
// 而且"白名单"和"自主 N 条"都已按主人要求删除 ✗）—— 留着只会误导，删掉 ✓

console.log('用法:')
console.log('  node quota.mjs status')
console.log('  node quota.mjs check --type comment [--target "BVxxx"]')
console.log('  node quota.mjs record --type comment --target "BVxxx" [--note "…"]')
// （set / allow 已删除 ✓）
