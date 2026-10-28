// 长楼 / 大 id（2026-10-23，Astra 评审「只翻前 4 页」的同类问题）：
//   reply-draft 找要回的那条、msgfeed 找他的新回复，都要先看第 1 页、再从最后一页往前翻（有页数上限、有总时限）；
//   收件箱里超过 2^53 的 id 不能失真（comment-images 拿精确的 mid_str 比人）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const href = (p) => pathToFileURL(path.join(root, p)).href

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-thread-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data')
  fs.mkdirSync(path.join(dsh, 'whale-work'), { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'Whale' }, notify: { type: 'none' } }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'x' }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json') }
  return { home, env, agent: { ...env, BILI_WHALE_AGENT: '1', BILI_WHALE_AI_HOME: path.join(dsh, 'whale-work') }, log: path.join(home, 'pages.log'), cookies: path.join(home, 'cookies.log') }
}
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
const back = (from, n) => Array.from({ length: n }, (_, i) => String(from - i))   // 从 from 往前 n 页

// ─────────────── reply-draft：主人审草稿时看的「B站 上查到的」作者 ───────────────
const draft = (s, extra, parent = '777') => spawnSync(process.execPath,
  [path.join(root, 'tools/commands/reply-draft.mjs'), 'add', '--oid', '1', '--bvid', 'BV1234567890', '--root', '9', '--parent', parent, '--who', '她写的名字', '--message', '谢谢你'],
  { env: { ...s.agent, PARENT_MID: '5555', THREAD_LOG: s.log, NODE_OPTIONS: '--import=' + href('tests/helpers/reply-fetch.mjs'), ...extra }, encoding: 'utf8', timeout: 60000 })
const drafts = (s) => JSON.parse(fs.readFileSync(path.join(s.home, '.bili-ai/pending-replies.json'), 'utf8')).items

test('reply-draft: the parent deep in a long thread is found from the last page backward (not only the first 4 pages)', (t) => {
  const s = sandbox(t)
  const r = draft(s, { THREAD_COUNT: '500', THREAD_TARGET: '490' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(drafts(s)[0].real, { mid: '5555', name: '路人乙', text: '我是楼里第 490 条' })
  assert.deepEqual(lines(s.log), ['1', '25'], '先第 1 页，再直接跳到最后一页')
  assert.doesNotMatch(r.stdout, /没核实到/)
})

test('reply-draft: a parent that is not found is bounded to 10 pages and the reason is said (owner still sees it unverified)', (t) => {
  const s = sandbox(t)
  let r = draft(s, { THREAD_COUNT: '500' }, '777')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(drafts(s)[0].real, null)
  assert.deepEqual(lines(s.log), ['1', ...back(25, 9)], '最多 10 页')
  assert.match(r.stdout, /没核实到要回的那条：楼太长（500 条回复），翻了 10 页没找到要回的那条/)
  fs.rmSync(s.log)
  r = draft(s, { THREAD_COUNT: '30' }, '778')
  assert.equal(drafts(s)[1].real, null); assert.deepEqual(lines(s.log), ['1', '2'])
  assert.match(r.stdout, /这栋楼里没找到要回的那条/)
  r = draft(s, { THREAD_COUNT: '500', THREAD_FAIL_PN: '25' }, '779')
  assert.equal(drafts(s)[2].real, null)
  assert.match(r.stdout, /查楼层时接口出错（第 25 页）：网络出错/)
})

test('reply-draft: replying to the top-level comment itself is still verified from data.root', (t) => {
  const s = sandbox(t)
  const r = draft(s, {}, '9')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(drafts(s)[0].real, { mid: '5555', name: '路人甲', text: '你好呀' })
})

test('reply-draft: coordinates copied from the inbox for a top-level comment (root 0) are still verified, and stored as given', (t) => {
  const s = sandbox(t)
  const r = spawnSync(process.execPath,
    [path.join(root, 'tools/commands/reply-draft.mjs'), 'add', '--oid', '1', '--bvid', 'BV1234567890', '--root', '0', '--parent', '9', '--message', '谢谢你'],
    { env: { ...s.agent, PARENT_MID: '5555', NODE_OPTIONS: '--import=' + href('tests/helpers/reply-fetch.mjs') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const d = drafts(s)[0]
  assert.deepEqual(d.real, { mid: '5555', name: '路人甲', text: '你好呀' }); assert.equal(d.root, '0')
})

// ─────────────── msgfeed.resolveLatestReply：收件箱没给正文时回读楼层 ───────────────
function resolve(s, extra, args) {
  const code = `import { resolveLatestReply } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
console.log(JSON.stringify(await resolveLatestReply(${JSON.stringify({ business: 1, oid: '1', root: '9', headers: { cookie: 'SESSDATA=her-test-cookie' }, ...args })})))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...s.env, THREAD_LOG: s.log, THREAD_COOKIE_LOG: s.cookies, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs'), ...extra }, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

test('msgfeed: his reply in a thread of more than 120 sub-replies is found from the last page backward, with her headers', (t) => {
  const s = sandbox(t)
  const long = { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '3,290' }
  // 要的是第 290 条（在最后一页）：找到就停
  assert.deepEqual(resolve(s, long, { mid: '5555', parentRpid: '5290' }), { rpid: '5290', text: '他在楼里第 290 条', ctime: 1_700_000_290, exact: true })
  assert.deepEqual(lines(s.log), ['1', '15'])
  assert.ok(lines(s.cookies).length === 2 && lines(s.cookies).every((c) => c === 'SESSDATA=her-test-cookie'), '带着调用方给的请求头（她的 cookie）')
  // 要的那条楼里没有：退回他最新的一条（exact:false），最多翻 10 页
  fs.rmSync(s.log)
  assert.deepEqual(resolve(s, long, { mid: '5555', parentRpid: '999' }), { rpid: '5290', text: '他在楼里第 290 条', ctime: 1_700_000_290, exact: false })
  assert.deepEqual(lines(s.log), ['1', ...back(15, 9)])
  // 要的在第 1 页：不再往后翻
  fs.rmSync(s.log)
  assert.deepEqual(resolve(s, long, { mid: '5555', parentRpid: '5003' }), { rpid: '5003', text: '他在楼里第 3 条', ctime: 1_700_000_003, exact: true })
  assert.deepEqual(lines(s.log), ['1'])
  // 楼里没有他：null
  assert.equal(resolve(s, { ...long, THREAD_HIS_AT: '' }, { mid: '5555', parentRpid: '5290' }), null)
  // 接口没给总条数、第 1 页是满的：按最多页数往前翻（第 15 页就是最后一页）
  fs.rmSync(s.log)
  assert.equal(resolve(s, { ...long, THREAD_N: '200', THREAD_HIS_AT: '195', THREAD_NO_COUNT: '1' }, { mid: '5555', parentRpid: '5195' }).rpid, '5195')
  assert.deepEqual(lines(s.log), ['1', '10'])
})

test('msgfeed: a reply that only hangs under the wanted comment (e.g. he answered himself) is never taken as that comment (Astra review 7)', (t) => {
  const s = sandbox(t)
  // 收件箱这条是 5150（第 8 页）；他后来又回了自己这条 → 第 15 页的 5290，parent=5150。以前翻到第 15 页就停、把 5290 标成 exact
  const r = resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '150,290', THREAD_HIS_PARENT: ',5150' }, { mid: '5555', parentRpid: '5150' })
  assert.deepEqual(r, { rpid: '5150', text: '他在楼里第 150 条', ctime: 1_700_000_150, exact: true })
  assert.deepEqual(lines(s.log), ['1', ...back(15, 8)], '一直翻到第 8 页真找到它才停')
  // 要的那条根本不在楼里，只有一条 parent 等于它的：不算这条（exact:false）
  assert.deepEqual(resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '290', THREAD_HIS_PARENT: '7777' }, { mid: '5555', parentRpid: '7777' }),
    { rpid: '5290', text: '他在楼里第 290 条', ctime: 1_700_000_290, exact: false })
  // 回读的入口：comment-digest 显示的正文要标明「不一定是这条」（坐标还是收件箱那条）
  const feed = path.join(s.home, 'feed.txt'), rt = now() - 60
  fs.writeFileSync(feed, `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":1700000000,"items":[{"id":1,"user":{"mid":5555,"nickname":"小号"},"reply_time":${rt},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":7777,"source_content":"","title":""}}]}}`)
  const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'],
    { env: { ...s.agent, FEED_REPLY: feed, THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '290', THREAD_HIS_PARENT: '7777', NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(d.status, 0, d.stderr)
  const it = JSON.parse(d.stdout.trim().split('\n').pop()).items[0]
  assert.equal(it.rpid, '7777'); assert.match(it.text, /^（楼里没找到这一条.*他在楼里第 290 条/)
  assert.equal(it.time, new Date(rt * 1000).toISOString(), '不是这一条：时间也用收件箱的，不用回读到的那一句的')
})

test('msgfeed: mid / rpid beyond 2^53 are compared and returned exactly (mid_str / rpid_str)', (t) => {
  const s = sandbox(t)
  const big = '12345678901234567'   // 当成 JSON 数字读会变成 12345678901234568
  assert.deepEqual(resolve(s, { THREAD_N: '10', THREAD_HIS_MID: big, THREAD_HIS_AT: '5' }, { mid: big, parentRpid: '5005' }),
    { rpid: '5005', text: '他在楼里第 5 条', ctime: 1_700_000_005, exact: true })
  const huge = { THREAD_N: '10', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '5', THREAD_RPID_BASE: '9007199254741000' }
  assert.deepEqual(resolve(s, huge, { mid: '5555', parentRpid: '9007199254741005' }), { rpid: '9007199254741005', text: '他在楼里第 5 条', ctime: 1_700_000_005, exact: true })
  // 隔壁那条（数字形式会和他那条变成同一个近似值）：不能认成他那条
  for (const near of ['9007199254741004', '9007199254741006']) assert.equal(resolve(s, huge, { mid: '5555', parentRpid: near }).exact, false, near)
})

test('msgfeed: the inbox id is his own comment — that exact one is returned even when he said more in the thread; a top-level comment (root 0) is read from data.root', (t) => {
  const s = sandbox(t)
  const long = { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '3,150,290' }
  // 收件箱给的是他第 3 条的 rpid：就要那一条（以前拿去对 parent 对不上，退回他最新的第 290 条）；在第 1 页就找到了，不再翻
  assert.deepEqual(resolve(s, long, { mid: '5555', parentRpid: '5003' }), { rpid: '5003', text: '他在楼里第 3 条', ctime: 1_700_000_003, exact: true })
  assert.deepEqual(lines(s.log), ['1'])
  fs.rmSync(s.log)
  assert.deepEqual(resolve(s, long, { mid: '5555', parentRpid: '5150' }), { rpid: '5150', text: '他在楼里第 150 条', ctime: 1_700_000_150, exact: true })
  assert.deepEqual(lines(s.log), ['1', ...back(15, 8)], '往前翻到第 8 页找到就停')
  // 别人的 rpid 对上了也不算（不是他的）
  assert.equal(resolve(s, long, { mid: '5555', parentRpid: '5004' }).exact, false)
  // 顶层评论：root 是 0 → 拿他那条当楼主查，正文在 data.root
  fs.rmSync(s.log)
  assert.deepEqual(resolve(s, { THREAD_N: '3', THREAD_ROOT_MID: '5555' }, { root: '0', mid: '5555', parentRpid: '9' }), { rpid: '9', text: '楼主的话', ctime: 1_700_000_000, exact: true })
  assert.deepEqual(lines(s.log), ['1'])
  assert.equal(resolve(s, { THREAD_N: '3' }, { root: '0', mid: '5555', parentRpid: '' }), null, '顶层评论又没给是哪条：不瞎找')
  // 顶层那条 rpid 对上了、作者却不是他：不算（不把别人的话当成他的）
  assert.deepEqual(resolve(s, { THREAD_N: '30', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '25' }, { root: '0', mid: '5555', parentRpid: '9' }), { rpid: '5025', text: '他在楼里第 25 条', ctime: 1_700_000_025, exact: false })
  assert.equal(resolve(s, { THREAD_N: '3' }, { root: '0', mid: '5555', parentRpid: '9' }), null, '顶层那条不是他的、楼里也没有他：null')
})

test('msgfeed: when his replies sit on two backward pages and none is the one asked for, the newest of them is returned', (t) => {
  const s = sandbox(t)
  assert.deepEqual(resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '150,290' }, { mid: '5555', parentRpid: '999' }),
    { rpid: '5290', text: '他在楼里第 290 条', ctime: 1_700_000_290, exact: false })
  assert.deepEqual(lines(s.log), ['1', ...back(15, 9)])
})

test('msgfeed: a page error still gives null; the time budget stops the scan and keeps what was already seen', (t) => {
  const s = sandbox(t)
  assert.equal(resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '3', THREAD_FAIL_PN: '15' }, { mid: '5555', parentRpid: '999' }), null,
    '第 1 页已经看到他的一句，后面一页出错照样不给（不知道后面有没有要的那条 / 更新的）')
  fs.rmSync(s.log)
  // 一页比剩下的时间还慢：这一页的请求也受总时限管，不会多等 15 秒
  const t0 = Date.now()
  assert.equal(resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '5', THREAD_DELAY_MS: '4000' }, { mid: '5555', parentRpid: '5005', budgetMs: 1500 }), null)
  assert.ok(Date.now() - t0 < 3500, '用时 ' + (Date.now() - t0))
  fs.rmSync(s.log)
  // 每页 0.8 秒、总时限 1.5 秒：第 1 页里那条照样拿到，不会把 300 条的楼一页页翻下去
  const r = resolve(s, { THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '5', THREAD_DELAY_MS: '800' }, { mid: '5555', parentRpid: '999', budgetMs: 1500 })
  assert.deepEqual(r, { rpid: '5005', text: '他在楼里第 5 条', ctime: 1_700_000_005, exact: false })
  const asked = lines(s.log); assert.ok(asked.length <= 2 && asked[0] === '1', asked.join(','))
})

// ─────────────── msgfeed：收件箱里的 id ───────────────
const now = () => Math.floor(Date.now() / 1000)
// 和真接口一样：id 都是裸的 JSON 数字
const bigFeed = (t) => `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":1700000000,"items":[`
  + `{"id":12345678901234567,"user":{"mid":12345678901234567,"nickname":"大号"},"reply_time":${t},"item":{"business_id":1,"subject_id":9007199254740993,"root_id":9007199254740995,"source_id":9007199254740997,"target_id":9007199254740999,"source_content":"说 123456789012345678 这串数字","uri":"https://www.bilibili.com/video/BV1234567890"}},`
  + `{"id":7,"user":{"mid":5555,"nickname":"小号"},"reply_time":${t + 1},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":42,"source_content":"","title":""}}]}}`

test('msgfeed: inbox ids beyond 2^53 keep their exact digits; ids in the safe range are unchanged', (t) => {
  const s = sandbox(t)
  const feed = path.join(s.home, 'feed.txt'); fs.writeFileSync(feed, bigFeed(1_700_000_100))
  const code = `import { pullFeed } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
console.log(JSON.stringify(await pullFeed('reply', { headers: {}, pages: 1 })))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, FEED_REPLY: feed, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(j.lastView, 1_700_000_000)
  const pick = (x) => ({ id: x.id, mid: x.mid, oid: x.oid, root: x.root, parent: x.parent, t: x.t, business: x.business, source: x.source })
  assert.deepEqual(j.items.map(pick), [
    { id: '12345678901234567', mid: '12345678901234567', oid: '9007199254740993', root: '9007199254740995', parent: '9007199254740997', t: 1_700_000_100, business: 1, source: '说 123456789012345678 这串数字' },
    { id: '7', mid: '5555', oid: '1', root: '9', parent: '42', t: 1_700_000_101, business: 1, source: '' },
  ])
})

test('msgfeed: without JSON.parse source access the fallback quotes the same big integers and nothing inside strings', (t) => {
  const s = sandbox(t)
  const code = `import fs from 'node:fs'
import { parseJsonIds } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
const text = fs.readFileSync(process.argv[1], 'utf8'), safe = fs.readFileSync(process.argv[2], 'utf8')
console.log(JSON.stringify({ a: parseJsonIds(text, { source: true }), b: parseJsonIds(text, { source: false }), c: parseJsonIds(safe, { source: false }), d: parseJsonIds(safe, { source: true }), e: JSON.parse(safe) }))`
  const BS = String.fromCharCode(92)
  const text = path.join(s.home, 'big.json'), safe = path.join(s.home, 'safe.json')
  fs.writeFileSync(text, `{"mid":12345678901234567,"neg":-12345678901234567,"ok":9007199254740991,"f":1.5e300,"g":0.1,"arr":[9007199254740993,3],"note":"id 12345678901234567 ${BS}"q${BS}" 9007199254740993","n":null,"b":true}`)
  fs.writeFileSync(safe, '{"mid":5555,"rpid":266000000000,"t":1700000000,"x":[1,-2,3.5],"s":"12"}')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, text, safe], { env: s.env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.deepEqual(j.a, j.b, '两条路一样')
  assert.equal(j.a.mid, '12345678901234567'); assert.equal(j.a.neg, '-12345678901234567'); assert.deepEqual(j.a.arr, ['9007199254740993', 3])
  assert.equal(j.a.ok, 9007199254740991, '安全范围内的还是数字'); assert.equal(j.a.f, 1.5e300); assert.equal(j.a.g, 0.1)
  assert.equal(j.a.note, `id 12345678901234567 "q" 9007199254740993`, '字符串里的数字不动')
  assert.deepEqual(j.c, j.e); assert.deepEqual(j.d, j.e)
})

// ─────────────── 调用方：comment-digest / comment-await ───────────────
test('comment-digest and comment-await: a big replier mid from the inbox stays exact; an empty inbox text is read back from the end of a long thread', (t) => {
  const s = sandbox(t)
  const feed = path.join(s.home, 'feed.txt'); fs.writeFileSync(feed, bigFeed(now() - 60))
  const env = { ...s.agent, FEED_REPLY: feed, THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '290', THREAD_COOKIE_LOG: s.cookies, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }
  const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(d.status, 0, d.stderr)
  const j = JSON.parse(d.stdout.trim().split('\n').pop())
  const [a, b] = j.items
  assert.equal(a.mid, '12345678901234567'); assert.equal(a.rpid, '9007199254740997'); assert.equal(a.oid, '9007199254740993')
  // 收件箱这一条（source_id 42）楼里找不到：正文是他最新的一句、标明不一定是这条；回他的坐标还是 42（不拿别的那句的 rpid）
  assert.match(b.text, /楼里没找到这一条.*他在楼里第 290 条/); assert.equal(b.rpid, '42')
  assert.ok(lines(s.cookies).length && lines(s.cookies).every((c) => c.startsWith('SESSDATA=test-cookie-not-a-real-account')), '回读楼层带着她的 cookie')
  const w = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-await.mjs'), '--since', '0', '--minutes', '1', '--quiet'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /大号（mid 12345678901234567）/)
  assert.match(w.stdout, /root=9007199254740995 parent=9007199254740997/)
  assert.match(w.stdout, /说：（楼里没找到这一条.*他在楼里第 290 条/); assert.match(w.stdout, /root=9 parent=42/)
})

test('comment-digest and comment-await: two comments from the same person in one thread each get their own text and are each replied to by their own id', (t) => {
  const s = sandbox(t)
  const at = now() - 60
  const item = (id, src, t2) => `{"id":${id},"user":{"mid":5555,"nickname":"小号"},"reply_time":${t2},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":${src},"source_content":"","title":""}}`
  const feed = path.join(s.home, 'feed.txt')
  fs.writeFileSync(feed, `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":1700000000,"items":[${item(1, 5003, at)},${item(2, 5290, at + 1)}]}}`)
  const env = { ...s.agent, FEED_REPLY: feed, THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '3,290', NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }
  const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(d.status, 0, d.stderr)
  const got = JSON.parse(d.stdout.trim().split('\n').pop()).items.map((x) => [x.rpid, x.text]).sort()
  assert.deepEqual(got, [['5003', '他在楼里第 3 条'], ['5290', '他在楼里第 290 条']], '同一个人同一栋楼的两句不串')
  const w = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-await.mjs'), '--since', '0', '--minutes', '1', '--quiet'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /说：他在楼里第 3 条[\s\S]*root=9 parent=5003/); assert.match(w.stdout, /说：他在楼里第 290 条[\s\S]*root=9 parent=5290/)
  assert.doesNotMatch(w.stdout, /楼里没找到这一条/)
})

// ─────────────── msgfeed：收件箱翻页（Astra 第七次审查）───────────────
const feedPage = (cursor, items) => `{"code":0,"data":{"cursor":${cursor},"last_view_at":1700000000,"items":[${items.join(',')}]}}`
const feedItem = (id, t2, text) => `{"id":${id},"user":{"mid":${6000 + id},"nickname":"人${id}"},"reply_time":${t2},"at_time":${t2},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":${id},"source_content":"${text}"}}`

test('msgfeed paging: page 2 is asked for with the cursor\'s id + time (not "[object Object]"), brings new items, and the end mark stops it', (t) => {
  const s = sandbox(t)
  const T = now() - 600, feedLog = path.join(s.home, 'feed.log')
  const p1 = path.join(s.home, 'p1.txt'), p2 = path.join(s.home, 'p2.txt')
  // 第 1 页：两条 + 没到底的 cursor（id 是超过 2^53 的裸数字）；第 2 页：另外两条 + 到底了
  fs.writeFileSync(p1, feedPage(`{"is_end":false,"id":12345678901234567,"time":${T}}`, [feedItem(11, T + 2, '第一页A'), feedItem(12, T + 1, '第一页B')]))
  fs.writeFileSync(p2, feedPage(`{"is_end":true,"id":21,"time":${T - 2}}`, [feedItem(21, T - 1, '第二页C'), feedItem(22, T - 2, '第二页D')]))
  const pull = (kind, pages, extra) => {
    const code = `import { pullFeed } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
console.log(JSON.stringify(await pullFeed(${JSON.stringify(kind)}, { headers: {}, pages: ${pages} })))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, FEED_LOG: feedLog, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs'), ...extra }, encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop()).items.map((x) => x.source)
  }
  assert.deepEqual(pull('reply', 3, { FEED_REPLY: p1, FEED_REPLY_2: p2 }), ['第一页A', '第一页B', '第二页C', '第二页D'])
  let urls = lines(feedLog)
  assert.equal(urls.length, 2, '第 2 页说到底了：第 3 页不再要')
  assert.doesNotMatch(urls[1], /object|cursor=/)
  assert.equal(new URL(urls[1]).searchParams.get('id'), '12345678901234567', 'cursor 的 id 原样（不失真）')
  assert.equal(new URL(urls[1]).searchParams.get('reply_time'), String(T))
  // @我的：时间参数叫 at_time
  fs.rmSync(feedLog)
  assert.deepEqual(pull('at', 2, { FEED_AT: p1, FEED_AT_2: p2 }), ['第一页A', '第一页B', '第二页C', '第二页D'])
  urls = lines(feedLog)
  assert.equal(new URL(urls[1]).searchParams.get('at_time'), String(T)); assert.equal(new URL(urls[1]).searchParams.get('reply_time'), null)
  // 第 1 页就到底了：只要一页
  fs.rmSync(feedLog)
  const end = path.join(s.home, 'end.txt'); fs.writeFileSync(end, feedPage(`{"is_end":true,"id":11,"time":${T}}`, [feedItem(11, T, '只有一页')]))
  assert.deepEqual(pull('reply', 3, { FEED_REPLY: end, FEED_REPLY_2: p2 }), ['只有一页']); assert.equal(lines(feedLog).length, 1)
  // comment-digest 默认要两页：第 2 页的也在里面
  fs.rmSync(feedLog)
  const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'],
    { env: { ...s.agent, FEED_REPLY: p1, FEED_REPLY_2: p2, FEED_LOG: feedLog, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(d.status, 0, d.stderr)
  assert.deepEqual(JSON.parse(d.stdout.trim().split('\n').pop()).items.map((x) => x.text).sort(), ['第一页A', '第一页B', '第二页C', '第二页D'].sort())
})

test('inbox title is not taken as their words: with an empty body the thread is read back; the title is only shown, marked unreliable, when nothing better is found', (t) => {
  const s = sandbox(t)
  const T = now() - 60
  const item = (src, title) => `{"id":${src},"user":{"mid":5555,"nickname":"小号"},"reply_time":${T},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":${src},"source_content":"","title":"${title}"}}`
  const feed = path.join(s.home, 'feed.txt')
  fs.writeFileSync(feed, `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":1700000000,"items":[${item(5150, '她自己的那条评论')},${item(7777, '另一个旧标题')}]}}`)
  const env = { ...s.agent, FEED_REPLY: feed, THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '150', NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }
  const digest = (args) => {
    const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json', ...args], { env, encoding: 'utf8', timeout: 60000 })
    assert.equal(d.status, 0, d.stderr)
    return Object.fromEntries(JSON.parse(d.stdout.trim().split('\n').pop()).items.map((x) => [x.rpid, x.text]))
  }
  let got = digest([])
  assert.equal(got['5150'], '他在楼里第 150 条', '回读到了就用楼里的那一句，不用标题')
  assert.match(got['7777'], /^（楼里没找到这一条.*他在楼里第 150 条/, '楼里没有这一条：标明不一定是这条（也不拿标题顶替）')
  got = digest(['--raw'])
  assert.match(got['5150'], /^（收件箱没给正文，下面是收件箱里不可靠的标题字段，不一定是 TA 说的）她自己的那条评论$/)
  // comment-await：同样
  const w = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-await.mjs'), '--since', '0', '--minutes', '1', '--quiet'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(w.status, 0, w.stdout + w.stderr)
  assert.match(w.stdout, /说：他在楼里第 150 条/); assert.doesNotMatch(w.stdout, /说：她自己的那条评论/)
  // 楼里一条他的都没有：回读不到，才拿标题，并标明
  const w2 = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-await.mjs'), '--since', '0', '--minutes', '1', '--quiet'], { env: { ...env, THREAD_HIS_AT: '' }, encoding: 'utf8', timeout: 60000 })
  assert.match(w2.stdout, /说：（收件箱没给正文，下面是收件箱里不可靠的标题字段，不一定是 TA 说的）她自己的那条评论/)
})

test('msgfeed paging: a later page that fails or does not move on keeps what earlier pages brought and says so; comment-digest does not call it "nobody wrote"', (t) => {
  const s = sandbox(t)
  const T = now() - 600, feedLog = path.join(s.home, 'feed.log')
  const p1 = path.join(s.home, 'p1.txt'), banned = path.join(s.home, 'banned.txt'), same = path.join(s.home, 'same.txt'), stuck = path.join(s.home, 'stuck.txt')
  fs.writeFileSync(p1, feedPage(`{"is_end":false,"id":12,"time":${T}}`, [feedItem(11, T + 2, '第一页A'), feedItem(12, T + 1, '第一页B')]))
  fs.writeFileSync(banned, '{"code":-412,"message":"request was banned"}')
  fs.writeFileSync(same, fs.readFileSync(p1, 'utf8'))                                                                     // 翻页参数被无视：一直给回第 1 页
  fs.writeFileSync(stuck, feedPage(`{"is_end":false,"id":12,"time":${T}}`, [feedItem(21, T - 1, '第二页C')]))          // 有新的，但给回的位置没动
  const pull = (extra, pages = 3) => {
    const code = `import { pullFeed } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
console.log(JSON.stringify(await pullFeed('reply', { headers: {}, pages: ${pages} })))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, FEED_LOG: feedLog, FEED_REPLY: p1, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs'), ...extra }, encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  let r = pull({ FEED_REPLY_2: banned })
  assert.deepEqual(r.items.map((x) => x.source), ['第一页A', '第一页B']); assert.match(r.partial, /第 2 页没取到（reply code=-412.*只有前 1 页/)
  r = pull({ FEED_2_NETFAIL: '1' })
  assert.deepEqual(r.items.map((x) => x.source), ['第一页A', '第一页B']); assert.match(r.partial, /第 2 页没取到（fetch failed）/)
  fs.rmSync(feedLog, { force: true })
  r = pull({ FEED_REPLY_2: same }, 8)
  assert.deepEqual(r.items.map((x) => x.source), ['第一页A', '第一页B']); assert.match(r.partial, /第 2 页和前面的一样（翻页没往前走）/)
  assert.equal(lines(feedLog).length, 2, '不再一页页白要下去')
  fs.rmSync(feedLog, { force: true })
  r = pull({ FEED_REPLY_2: stuck }, 8)
  assert.deepEqual(r.items.map((x) => x.source), ['第一页A', '第一页B', '第二页C']); assert.match(r.partial, /翻页位置和上一页一样/); assert.equal(lines(feedLog).length, 2)
  assert.equal(pull({ FEED_REPLY_2: banned }, 1).partial, undefined, '只要一页：不算没取全')
  // 第 1 页就不行：还是整个读不到（和以前一样）
  const code = `import { pullFeed } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
await pullFeed('reply', { headers: {}, pages: 2 }).then(() => console.log('no-throw'), (e) => console.log('threw ' + e.message))`
  const e1 = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, FEED_REPLY: banned, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }, encoding: 'utf8', timeout: 60000 })
  assert.match(e1.stdout, /threw reply code=-412/)
  // comment-digest（默认两页）：第 1 页的照样列出来，并说只取到一部分
  const env = { ...s.agent, FEED_REPLY: p1, FEED_REPLY_2: banned, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }
  const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(d.status, 0, d.stderr)
  const j = JSON.parse(d.stdout.trim().split('\n').pop())
  assert.deepEqual(j.items.map((x) => x.text).sort(), ['第一页A', '第一页B']); assert.match(j.warnings.join(' '), /回复收件箱只取到一部分/)
  const h = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs')], { env, encoding: 'utf8', timeout: 60000 })
  assert.match(h.stdout, /⚠️ 回复收件箱只取到一部分/); assert.match(h.stdout, /第一页A/)
  // 第 1 页已经翻过了 24 小时的开头（最早一条比它早）：第 2 页出错也不缺什么 —— 不报假警，照样说「安静得很」
  const old = path.join(s.home, 'old.txt'); fs.writeFileSync(old, feedPage(`{"is_end":false,"id":1,"time":${T - 99999}}`, [feedItem(1, T - 99999, '很久以前的')]))
  const h2 = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs')], { env: { ...env, FEED_REPLY: old }, encoding: 'utf8', timeout: 60000 })
  assert.match(h2.stdout, /安静得很，没人找/); assert.doesNotMatch(h2.stdout + h2.stderr, /没读全|只取到一部分/)
  const covered = path.join(s.home, 'covered.txt')
  fs.writeFileSync(covered, feedPage(`{"is_end":false,"id":2,"time":${T - 99999}}`, [feedItem(1, T, '最近的'), feedItem(2, T - 99999, '很久以前的')]))
  const j2 = JSON.parse(spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json'], { env: { ...env, FEED_REPLY: covered }, encoding: 'utf8', timeout: 60000 }).stdout.trim().split('\n').pop())
  assert.deepEqual(j2.items.map((x) => x.text), ['最近的']); assert.deepEqual(j2.warnings, [], '翻全了：第 2 页本来就不用要')
  // 一条都没取到、可是范围没翻全（第 1 页全在范围里，第 2 页出错）：不说「安静得很」—— 时间都在范围里就会列出来，所以这里用 --only-unread 让它们都不列
  const unread = path.join(s.home, 'unread.txt')
  fs.writeFileSync(unread, `{"code":0,"data":{"cursor":{"is_end":false,"id":3,"time":${T}},"last_view_at":${T + 10},"items":[${feedItem(3, T, '看过了的')}]}}`)
  const h3 = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--only-unread'], { env: { ...env, FEED_REPLY: unread }, encoding: 'utf8', timeout: 60000 })
  assert.match(h3.stdout, /收件箱没读全（见上面），这不代表没人找/); assert.doesNotMatch(h3.stdout, /安静得很/)
})

test('msgfeed paging: the page cap is reported when the time window is still open; an incomplete cursor is reported; a repeated cursor on the last page asked for is not; the @ inbox warns too', (t) => {
  const s = sandbox(t)
  const T = now() - 600
  const p1 = path.join(s.home, 'p1.txt'), p2open = path.join(s.home, 'p2open.txt'), banned = path.join(s.home, 'banned.txt'), noid = path.join(s.home, 'noid.txt'), stuck = path.join(s.home, 'stuck.txt')
  fs.writeFileSync(p1, feedPage(`{"is_end":false,"id":12,"time":${T}}`, [feedItem(11, T + 2, '第一页A'), feedItem(12, T + 1, '第一页B')]))
  fs.writeFileSync(p2open, feedPage(`{"is_end":false,"id":22,"time":${T - 2}}`, [feedItem(21, T - 1, '第二页C'), feedItem(22, T - 2, '第二页D')]))   // 还在 24 小时里、也没到底
  fs.writeFileSync(banned, '{"code":-412,"message":"request was banned"}')
  fs.writeFileSync(noid, feedPage('{"is_end":false}', [feedItem(11, T + 2, '第一页A')]))
  fs.writeFileSync(stuck, feedPage(`{"is_end":false,"id":12,"time":${T}}`, [feedItem(21, T - 1, '第二页C')]))
  const NODE_OPTIONS = '--import=' + href('tests/helpers/thread-fetch.mjs')
  const digest = (extra, args = ['--json']) => spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), ...args], { env: { ...s.agent, NODE_OPTIONS, ...extra }, encoding: 'utf8', timeout: 60000 })
  let j = JSON.parse(digest({ FEED_REPLY: p1, FEED_REPLY_2: p2open }).stdout.trim().split('\n').pop())
  assert.equal(j.count, 4); assert.match(j.warnings.join(' '), /回复收件箱只取到一部分：翻了 2 页还没翻到要的时间范围的开头/)
  const pull = (extra, pages) => {
    const code = `import { pullFeed } from ${JSON.stringify(href('tools/lib/msgfeed.mjs'))}
console.log(JSON.stringify(await pullFeed('reply', { headers: {}, pages: ${pages} })))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...s.env, NODE_OPTIONS, ...extra }, encoding: 'utf8', timeout: 60000 })
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  assert.match(pull({ FEED_REPLY: noid, FEED_REPLY_2: p2open }, 2).partial, /翻页位置不完整/)
  assert.equal(pull({ FEED_REPLY: p1, FEED_REPLY_2: stuck }, 2).partial, undefined, '最后一页给回的位置一样：不再要下一页，不算卡住')
  assert.equal(pull({ FEED_REPLY: p1, FEED_REPLY_2: p2open }, 2).partial, undefined, '不给时间范围：页数用完不说')
  // @我的：第 2 页出错 → 也说（人看的、JSON、一条都没列出来时的 JSON）
  const atOnly = { FEED_AT: p1, FEED_AT_2: banned }
  j = JSON.parse(digest(atOnly).stdout.trim().split('\n').pop())
  assert.match(j.warnings.join(' '), /@收件箱只取到一部分：第 2 页没取到/)
  assert.match(digest(atOnly, []).stdout, /⚠️ @收件箱只取到一部分/)
  const unread = path.join(s.home, 'unread.txt')
  fs.writeFileSync(unread, `{"code":0,"data":{"cursor":{"is_end":false,"id":3,"time":${T}},"last_view_at":${T + 10},"items":[${feedItem(3, T, '看过了的')}]}}`)
  j = JSON.parse(digest({ FEED_AT: unread, FEED_AT_2: banned }, ['--json', '--only-unread']).stdout.trim().split('\n').pop())
  assert.equal(j.count, 0); assert.match(j.warnings.join(' '), /@收件箱只取到一部分/)
})

test('@ items with an empty body are read back like replies; the unreliable title is shown (marked) only when there is nothing better', (t) => {
  const s = sandbox(t)
  const T = now() - 60
  const atItem = `{"id":5150,"user":{"mid":5555,"nickname":"小号"},"at_time":${T},"item":{"business_id":1,"subject_id":1,"root_id":9,"source_id":5150,"source_content":"","title":"【年度总结】这是视频标题"}}`
  const feed = path.join(s.home, 'at.txt'); fs.writeFileSync(feed, `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":1700000000,"items":[${atItem}]}}`)
  const env = { ...s.agent, FEED_AT: feed, THREAD_N: '300', THREAD_HIS_MID: '5555', THREAD_HIS_AT: '150', NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs') }
  const digestText = (extra, args = []) => JSON.parse(spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json', ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 }).stdout.trim().split('\n').pop()).items[0].text
  assert.equal(digestText({}), '他在楼里第 150 条', '@ 也回读，不拿标题当 TA 说的话')
  const marked = /^（收件箱没给正文，下面是收件箱里不可靠的标题字段，不一定是 TA 说的）【年度总结】/
  assert.match(digestText({}, ['--max-resolve', '0']), marked, '超过回读上限：只给标明了的标题')
  assert.match(digestText({ THREAD_HIS_AT: '' }), marked, '回读不到：只给标明了的标题')
  const w = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-await.mjs'), '--since', '0', '--minutes', '1', '--quiet'], { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(w.status, 0, w.stdout + w.stderr); assert.match(w.stdout, /说：他在楼里第 150 条/)
})

test('comment-digest --only-unread: each inbox is filtered by its own last-read time, and an inbox without one is not filtered by the other\'s (Astra review)', (t) => {
  const s = sandbox(t)
  const T = now() - 3600
  const box = (lastView, items) => `{"code":0,"data":{"cursor":{"is_end":true},"last_view_at":${lastView},"items":[${items.join(',')}]}}`
  const write = (name, text) => { const f = path.join(s.home, name); fs.writeFileSync(f, text); return f }
  const run = (env) => {
    const d = spawnSync(process.execPath, [path.join(root, 'tools/commands/comment-digest.mjs'), '--json', '--only-unread', '--raw'],
      { env: { ...s.agent, NODE_OPTIONS: '--import=' + href('tests/helpers/thread-fetch.mjs'), ...env }, encoding: 'utf8', timeout: 60000 })
    assert.equal(d.status, 0, d.stderr)
    return JSON.parse(d.stdout.trim().split('\n').pop()).items.map((x) => `${x.kind}:${x.text}`).sort()
  }
  // 回复箱 10:00 读过、10:15 来了一条；@箱 10:30 读过、没有新的 —— 那条回复还是未读
  assert.deepEqual(run({ FEED_REPLY: write('r1.txt', box(T, [feedItem(1, T + 900, '十点一刻的回复'), feedItem(2, T - 60, '读过的回复')])), FEED_AT: write('a1.txt', box(T + 1800, [])) }),
    ['reply:十点一刻的回复'])
  // @箱有它自己更早的已读时间：它的未读照样留着，回复箱较新的已读时间不影响它
  assert.deepEqual(run({ FEED_REPLY: write('r2.txt', box(T + 1800, [feedItem(3, T + 900, '读过的回复')])), FEED_AT: write('a2.txt', box(T, [feedItem(4, T + 900, '没读的@'), feedItem(5, T - 60, '读过的@')])) }),
    ['at:没读的@'])
  // @箱没有已读时间（0）：不借回复箱的时间，它的都算未读
  assert.deepEqual(run({ FEED_REPLY: write('r3.txt', box(T + 1800, [feedItem(6, T + 900, '读过的回复')])), FEED_AT: write('a3.txt', box(0, [feedItem(7, T + 900, '@甲'), feedItem(8, T - 60, '@乙')])) }),
    ['at:@乙', 'at:@甲'])
})
