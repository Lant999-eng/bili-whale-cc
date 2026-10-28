// 观众记忆（按 UID / 评论线程）：她回复前先取，聊到值得记的再记 —— 存在主人那边（~/.bili-ai/memory），她只能经这个命令读写。
//   node bili.mjs memory recall --uid <mid> [--thread <类型:oid:root>] [--q "TA 这条说了什么"] [--scope public|owner-dm] [--max 1200] [--json]
//   node bili.mjs memory note --uid <mid> --kind preference|guess|todo --text "一句话" [--evidence <TA 那条消息的 rpid / 私信编号>] [--thread …]
//   node bili.mjs memory forget --uid <mid> --id <条目> [--reason "…"]
//   node bili.mjs memory correct --uid <mid> --id <条目> --text "改正后的一句话"
//   node bili.mjs memory done --uid <mid> --id <待办>
//   node bili.mjs memory show --uid <mid> [--json]
// 偏好（preference）必须指向 TA 自己说过的那条消息；拿不准就记 guess（会标成「推测」）。不记联系方式、证件号、住址。
// 公开回复默认只取公开的记忆；主人私信里的内容只在主人本人、私信里（--scope owner-dm）才取得到。
// 私信模块的回合（BILI_WHALE_TURN 的前缀是 SDM_TURN_PREFIX，宿主设的、她改不了；2026-10-26，审查 #1 #6）—— 认不准就不让用（fail-closed）：
//   · 认人（核对宿主写的回合绑定）交给模块的 tools/lib/sdm-memory-turn.mjs（2026-10-28）；那个文件不在（模块没装）、加载出错、对不上 → 每个子命令都拒绝，什么都不读不写
//   · 对得上：--uid 只能是绑定里那个人；recall 只取 peer-dm、不给线程；note / correct 一律私密、标 origin sdm；forget / correct / done 只能动这种回合里记的；
//     show、--scope owner-dm 拒绝 —— 这些都写死在这里，不交给模块（细节见那个文件开头）
// 主人在宿主这边跑（不是她的会话）：show 连私密的一起给（这种回合里记的他也看得到）
import fs from 'node:fs'
import { config } from '../lib/config.mjs'
import { isAgent } from '../lib/paths.mjs'
import { recall, addNote, forget, correct, closeTodo, loadUser, NOTE_KINDS } from '../lib/memory.mjs'
import { SDM_TURN_PREFIX } from '../lib/turn-ids.mjs'

const argv = process.argv.slice(2)
const sub = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const OWNER = String(config().owner?.mid ?? '')
const by = isAgent() ? 'her' : 'owner'
const fail = (m) => { console.error('✗ ' + m); process.exit(2) }

// 模块那一半（认人、说给她听的话）：文件不在 = 模块没装 → null
const HOOK = new URL('../lib/sdm-memory-turn.mjs', import.meta.url)
const sdmHook = async () => (fs.existsSync(HOOK) ? import(HOOK.href) : null)

// 私信模块的回合：只看回合编号的前缀（核心的 turn-ids.mjs）—— 前缀对上了，后面任何一步不成（模块没装也算）都按「不让用」
const SDM_TURN = String(process.env.BILI_WHALE_TURN ?? '').startsWith(SDM_TURN_PREFIX)
let peer = null, sdmOwner = '', H = null
if (SDM_TURN) {
  let why = null
  try {
    H = await sdmHook()
    if (!H) why = '这一份没装这种回合的模块'
    else ({ why, peer, owner: sdmOwner } = await H.bindTurn())
  } catch (e) { why = String(e?.message ?? e).slice(0, 120) }
  if (why || !peer) fail(H?.TEXT?.denied?.(why ?? '没有绑定') ?? `这一回合记忆不能用（${why ?? '没有绑定'}）`)
}

const uid = String(opt.uid ?? '')
if (!/^\d{1,20}$/.test(uid)) fail('要给 --uid <对方的 mid>（只按 UID 认人，不按昵称）')
if (SDM_TURN) {
  if (uid !== peer) fail(H.TEXT.onlyPeer(peer))
  if (sub === 'show') fail(H.TEXT.noShow(peer))
  if (String(opt.scope ?? '') === 'owner-dm') fail(H.TEXT.noOwnerDm)
}
const origin = SDM_TURN ? 'sdm' : ''

try {
  if (sub === 'recall') {
    const scope = SDM_TURN ? 'peer-dm' : String(opt.scope ?? 'public')
    // peer-dm 只给私信模块的回合（宿主自动给）：别的时候一律拒绝，模块没装也一样
    if (!SDM_TURN && scope === 'peer-dm') fail((await sdmHook())?.TEXT.peerDmOutside ?? '--scope 只能是 public / owner-dm')
    const r = recall({ uid, thread: SDM_TURN || !opt.thread ? null : String(opt.thread), q: String(opt.q ?? ''), scope, owner: SDM_TURN ? sdmOwner : OWNER, peer: peer ?? '', maxChars: Math.min(3000, Number(opt.max ?? 1200) || 1200) })
    if (opt.json) console.log(JSON.stringify(r))
    else console.log(r.lines.length ? r.text + (r.truncated ? '\n（还有，太长没放）' : '') : '（没有关于 TA 的记忆）')
  } else if (sub === 'note') {
    const kind = String(opt.kind ?? '')
    if (!NOTE_KINDS.includes(kind)) fail(`--kind 只能是 ${NOTE_KINDS.join(' / ')}`)
    const r = addNote({ uid, kind, text: String(opt.text ?? ''), evidence: opt.evidence ? String(opt.evidence) : null, thread: SDM_TURN || !opt.thread ? null : String(opt.thread), by, owner: OWNER, origin })
    console.log(r.result === 'dup' ? '（已经记过同样的）' : r.result === 'public' ? `✓ 原来记过同样的一条（私密），这次出自公开评论，改成公开的了（${r.id}）` : `✓ 记下了（${r.id}）${SDM_TURN ? '（私密：只在和 TA 的私信里取得到）' : ''}`)
  } else if (sub === 'forget') {
    forget({ uid, id: String(opt.id ?? ''), reason: String(opt.reason ?? ''), by, origin })
    console.log('✓ 删掉了（只留指纹：同样的内容以后不会再被记回来）')
  } else if (sub === 'correct') {
    const r = correct({ uid, id: String(opt.id ?? ''), text: String(opt.text ?? ''), by, owner: OWNER, origin })
    console.log(`✓ 改好了（新的是 ${r.id}；旧的作废）`)
  } else if (sub === 'done') {
    closeTodo({ uid, id: String(opt.id ?? ''), origin })
    console.log('✓ 这件事标成做完了')
  } else if (sub === 'show') {
    const doc = loadUser(uid)
    // 私密条目（主人私信、私信模块的回合里记的）：她看主人本人时显示；主人在宿主这边看谁都显示
    const privOk = uid === OWNER || !isAgent()
    const live = doc.entries.filter((e) => e.status !== 'deleted' && e.status !== 'superseded' && (privOk || e.visibility === 'public'))
    if (opt.json) console.log(JSON.stringify({ uid, names: doc.names, entries: live, deleted: doc.tombstones.length }))
    else {
      // origin sdm 的那几条打个标签（模块给的字；模块没装就不打）
      const sdmTag = live.some((e) => e.origin === 'sdm') ? ((await sdmHook())?.TEXT.originTag ?? '') : ''
      console.log(`UID ${uid}${doc.names?.length ? `（叫过：${doc.names.map((x) => x.name).join('、')}）` : ''} · ${live.length} 条 · 删掉 / 纠正过 ${doc.tombstones.length} 条`)
      for (const e of live) console.log(`  ${e.id}  [${e.kind}${e.status !== 'active' ? '·' + e.status : ''}${e.origin === 'sdm' ? sdmTag : ''}] ${String(e.at).slice(0, 10)}  ${e.text}${e.her ? ` / 你回：${e.her}` : ''}`)
    }
  } else fail('用法：memory recall | note | forget | correct | done | show（见文件开头）')
} catch (e) {
  fail(String(e?.message ?? e))
}
