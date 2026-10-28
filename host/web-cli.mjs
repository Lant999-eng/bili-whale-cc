// 读书（2026-10-28，A 版）主人用的命令：node host/cli.mjs web …（只读写本机 ~/.bili-ai/web/ 下的文件，不联网）
//   web [status]                 开关、额度、正排着 / 正在读的、等你批的、最近的笔记有几条
//   web list [--n 20]            最近的读书请求（题目、起点全文、状态）
//   web approve <请求编号>        批准（只有等批准的能批；批之前把题目和起点全文再给你看一遍）
//   web reject <请求编号> [--reason "…"]
//   web add --topic "…" [--start https://…]   你替她加一条（直接是批准了的；题目、起点和她写的过同一关）
//   web stop <请求编号>          停下这一轮：请求标成 dropped、绑定清掉 —— 她这一轮剩下的 web / note 全部被拒，回合到时限自己结束
//   web log [--n 30]             最近打开 / 搜索过的网址（宿主记的，不是她写的）
//   web notes [--n 10]           最近的笔记全文（含收起的，标出来）
//   web ok <笔记编号> | web ok all   看过了、放行（web.reviewNotes 开着时，只有放行的笔记才附给醒来那一轮）
//   web hide <笔记编号> [--reason "…"] · web unhide <笔记编号>   收起 / 放回（收起的不再附给她）
// 显示的每一样别人写的字（题目、笔记、网页标题、网址）都过 shown（去掉控制字符和双向文字）
import { readConfigStrict, webOpts } from '../tools/lib/config.mjs'
import * as W from '../tools/lib/webstate.mjs'

const USAGE = '用法：web [status] | web list [--n 20] | web approve <请求编号> | web reject <请求编号> [--reason "…"] | web add --topic "…" [--start https://…] | web stop <请求编号> | web log [--n 30] | web notes [--n 10] | web ok <笔记编号|all> | web hide <笔记编号> [--reason "…"] | web unhide <笔记编号>'
const STATUS = { pending: '等你批', approved: '批了、等排队', queued: '排着', started: '正在读', done: '读完了', rejected: '没批', dropped: '停下 / 没读成', expired: '放太久作废了' }
const at = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '?' }

/** --name value 形式的参数；位置参数留在 pos 里 */
function parse(rest) {
  const opt = {}, pos = []
  for (let i = 1; i < rest.length; i += 1) {
    const a = String(rest[i])
    if (a.startsWith('--')) {
      const v = rest[i + 1]
      if (v === undefined || String(v).startsWith('--')) opt[a.slice(2)] = true
      else { opt[a.slice(2)] = String(v); i += 1 }
    } else pos.push(a)
  }
  return { opt, pos }
}
const nOf = (v, dflt, max) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : dflt }

function requestLines(r, shown) {
  const used = r.used ? ` · 用了：打开 ${Number(r.used.pages) || 0} 页、搜索 ${Number(r.used.searches) || 0} 次、笔记 ${Number(r.used.notes) || 0} 条` : ''
  return [
    `  ${shown(r.id)} · ${STATUS[r.status] ?? shown(String(r.status))} · ${r.by === 'owner' ? '你加的' : '她写的'} · ${at(r.at)}${used}${r.reason ? ` · ${shown(String(r.reason))}` : ''}`,
    `    题目：「${shown(String(r.topic ?? ''))}」`,
    ...(Array.isArray(r.start) && r.start.length ? r.start.map((u) => `    起点：${shown(String(u))}`) : ['    起点：（没有，她自己搜）']),
  ]
}

export const commands = {
  async web({ rest, ok, bad, warn, shown }) {
    const sub = rest[0] ?? 'status'
    const { opt, pos } = parse(rest)
    const cfg = readConfigStrict()
    const fail = (e) => { bad(shown(String(e?.message ?? e))); process.exitCode = Number(e?.exitCode) || 1 }
    try {
      if (sub === 'status') {
        if (rest.length > 1) { console.log(USAGE); process.exitCode = 2; return }
        if (!cfg) { bad('配置文件读不出来（是不是改到一半？）'); process.exitCode = 1; return }
        const o = webOpts(cfg)
        const list = W.listRequests()
        console.log(`读书：${o.enabled ? '开着' : '关着（config set web.enabled true 打开）'} · ${o.approve ? '她的请求要你批' : '她的请求不用批（web.approve false）'}`)
        console.log(`  每天 ${o.roundsPerDay} 轮 · 每轮${o.pagesPerRound ? `最多打开 ${o.pagesPerRound} 页` : `打开页数不限（最多 ${o.turnTimeoutMin} 分钟）`}、搜索 ${o.searchesPerRound} 次、记 ${o.notesPerRound} 条笔记 · 今天开始了 ${W.roundsToday(Date.now(), list)} 轮`)
        console.log(`  起点只能是：${shown(o.allow.join('、') || '（一个都没有）')}${o.block.length ? ` · 另外不许去：${shown(o.block.join('、'))}` : ''}`)
        const open = W.openRequests(list)
        if (open.length) { console.log('  没了结的请求：'); for (const r of open) console.log(requestLines(r, shown).join('\n')) }
        else console.log('  现在没有没了结的请求')
        const { notes, hidden, delivered } = W.readNotes()
        const waiting = notes.filter((x) => !hidden.has(x.id) && !delivered.has(x.id)).length
        const review = o.reviewNotes ? W.notesAwaitingReview().length : 0
        console.log(`  笔记 ${notes.length} 条（${waiting} 条还没附给她${review ? `，其中 ${review} 条等你看` : ''}${hidden.size ? `，收起了 ${hidden.size} 条` : ''}）—— 看全文：node host/cli.mjs web notes`)
        console.log(`  笔记${o.reviewNotes ? '要你放行（web ok）才附给她' : '不用你放行，直接附给她（web.reviewNotes false）'}`)
        return
      }
      if (sub === 'list') {
        const list = W.listRequests().slice(-nOf(opt.n, 20, 300)).reverse()
        if (!list.length) { console.log('还没有读书请求'); return }
        for (const r of list) console.log(requestLines(r, shown).join('\n'))
        return
      }
      if (sub === 'approve' || sub === 'reject') {
        const id = pos[0]
        if (!id || !W.REQ_ID_RE.test(id)) { bad(`用法：web ${sub} <请求编号>（R- 开头，web list 里看）`); process.exitCode = 2; return }
        const r = W.getRequest(id)
        if (!r) { bad(`没有这条读书请求：${shown(id)}`); process.exitCode = 1; return }
        if (sub === 'approve') {
          if (!cfg) { bad('配置文件读不出来，先不批'); process.exitCode = 1; return }
          // 批的时候按现在的配置再查一遍题目和起点（你后来改过 web.allow、主人名字也可能变了）
          const t = W.checkTopic(r.topic, { cfg })
          if (!t.ok) { bad(`这条的题目现在过不了：${shown(t.why)} —— 没批`); process.exitCode = 2; return }
          for (const u of r.start ?? []) { const c = W.checkStart(u, { cfg }); if (!c.ok) { bad(`这条的起点现在过不了：${shown(c.why)} —— 没批`); process.exitCode = 2; return } }
        }
        console.log(requestLines(r, shown).join('\n'))
        const d = W.decide(id, sub === 'approve' ? 'approved' : 'rejected', typeof opt.reason === 'string' ? opt.reason : '')
        ok(sub === 'approve' ? `批了：${shown(d.id)}${cfg && webOpts(cfg).enabled ? '（宿主一分钟内排上）' : '（读书现在关着，打开以后才会读）'}` : `没批：${shown(d.id)}`)
        return
      }
      if (sub === 'add') {
        if (!cfg) { bad('配置文件读不出来，先不加'); process.exitCode = 1; return }
        if (typeof opt.topic !== 'string') { bad('要给 --topic "…"'); process.exitCode = 2; return }
        const t = W.checkTopic(opt.topic, { cfg })
        if (!t.ok) { bad(shown(t.why)); process.exitCode = 2; return }
        const start = []
        if (opt.start !== undefined) {
          const c = W.checkStart(typeof opt.start === 'string' ? opt.start : '', { cfg })
          if (!c.ok) { bad(shown(c.why)); process.exitCode = 2; return }
          start.push(c.url)
        }
        const r = W.addRequest({ topic: t.topic, start, by: 'owner', cfg })
        console.log(requestLines(r, shown).join('\n'))
        ok(`加好了（直接是批准了的）${webOpts(cfg).enabled ? '' : ' —— 读书现在关着，打开以后才会读'}`)
        return
      }
      if (sub === 'stop') {
        const id = pos[0]
        if (!id || !W.REQ_ID_RE.test(id)) { bad('用法：web stop <请求编号>'); process.exitCode = 2; return }
        const r = W.markRequest(id, 'dropped', { from: ['pending', 'approved', 'queued', 'started'], extra: { reason: '主人停下' } })
        if (!r) { const cur = W.getRequest(id); bad(cur ? `这条请求已经是「${STATUS[cur.status] ?? shown(String(cur.status))}」，不用停` : `没有这条读书请求：${shown(id)}`); process.exitCode = 1; return }
        W.endBinding(W.turnIdOf(id), { force: true })
        ok(`停下了：${shown(id)} —— 她这一轮剩下的 web / note 都会被拒，回合到时限自己结束（不联网了）`)
        return
      }
      if (sub === 'log') {
        const v = W.readVisits({ n: nOf(opt.n, 30, 500) }).reverse()
        if (!v.length) { console.log('还没有打开过网页'); return }
        for (const x of v) console.log(`  ${at(x.at)} · ${x.kind === 'search' ? '搜索' : '打开'} · ${x.ok ? '✓' : `✗ ${shown(String(x.why ?? ''))}`} · ${shown(String(x.host ?? ''))}${x.hostUnicode ? `（${shown(String(x.hostUnicode))}）` : ''} · ${shown(String(x.url ?? '').slice(0, 200))}${x.title ? ` · 「${shown(String(x.title))}」` : ''}`)
        return
      }
      if (sub === 'notes') {
        const { notes, hidden, delivered, okd } = W.readNotes()
        const review = !cfg || webOpts(cfg).reviewNotes
        const list = notes.slice(-nOf(opt.n, 10, 200)).reverse()
        if (!list.length) { console.log('还没有笔记'); return }
        for (const x of list) {
          console.log(`  ${shown(x.id)} · ${at(x.at)} · ${hidden.has(x.id) ? '收起了' : delivered.has(x.id) ? '附给她过了' : review && !okd.has(x.id) ? '等你看（web ok 放行）' : '还没附给她'} · 想读：「${shown(x.topic)}」 · 读了：${shown(x.sources.join('、') || '—')}`)
          if (x.title) console.log(`    《${shown(x.title)}》`)
          console.log(`    ${shown(x.text)}`)
        }
        // 这几条主人看到全文了：web ok all 只放行这些
        W.markSeen(list.filter((x) => !hidden.has(x.id) && !delivered.has(x.id) && !okd.has(x.id)).map((x) => x.id))
        return
      }
      if (sub === 'ok') {
        const id = pos[0]
        if (!id || (id !== 'all' && !W.NOTE_ID_RE.test(id))) { bad('用法：web ok <笔记编号>（N- 开头，web notes 里看）或 web ok all'); process.exitCode = 2; return }
        const n = W.approveNotes([id])
        ok(n ? `放行了 ${n} 条：下次醒来时附给她` : id === 'all' ? '没有要放行的（web ok all 只放行你在 web notes 里看过的；先 web notes 看一眼）' : '没有要放行的（已经放行过了）')
        return
      }
      if (sub === 'hide' || sub === 'unhide') {
        const id = pos[0]
        if (!id || !W.NOTE_ID_RE.test(id)) { bad(`用法：web ${sub} <笔记编号>（N- 开头，web notes 里看）`); process.exitCode = 2; return }
        W.hideNote(id, { reason: typeof opt.reason === 'string' ? opt.reason : '', unhide: sub === 'unhide' })
        ok(sub === 'hide' ? `收起了 ${shown(id)}：不再附给她` : `放回了 ${shown(id)}（已经附过的不会再附一次）`)
        return
      }
      console.log(USAGE); process.exitCode = 2
    } catch (e) { fail(e) }
  },
}

/** cli doctor 里读书那一段：关着什么都不说；开着说一句现在什么样（只读本机文件） */
export async function doctor(cfg, { ok, warn, shown }) {
  const o = webOpts(cfg)
  if (!o.enabled) return
  const open = W.openRequests()
  const pending = open.filter((r) => r.status === 'pending').length
  ok(`读书：开着 · 每天 ${o.roundsPerDay} 轮${pending ? ` · ${pending} 条等你批（node host/cli.mjs web list）` : ''}${open.some((r) => r.status === 'started') ? ' · 正在读' : ''}`)
  if (!o.allow.length) warn('读书开着、批准的网站（web.allow）却一个都没有：她的请求只能不带起点、靠搜索')
  void shown
}
