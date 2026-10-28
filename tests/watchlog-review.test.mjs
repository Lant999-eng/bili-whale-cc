// 看片记录 —— 第二轮对抗审查之后补的测试（tests/watchlog.test.mjs 是主体）：
//   主人自己跑 / 记录写不进去时「这次取到的」照样说对；多 P 只取 P1（画面按 P1 的时长取帧）；
//   debrief / video / comments / subtitles 的「没有」和「没拿到」逐条钉住；真的下一段小视频抽帧（下载失败 / 下到一半断 / 不是视频 / 等间隔另起名字）；
//   记录读写对 BOM 一致；只差大小写的两条视频不共用素材；面板和 list 的日期规则
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
// 时区钉在「这会儿正好是中午 12 点左右」的固定偏移（同 dashboard.test.mjs）：「10 分钟前取到的」在午夜后 10 分钟内会变成昨天
{ const off = 12 - new Date().getUTCHours(); process.env.TZ = 'Etc/GMT' + (off >= 0 ? '-' : '+') + Math.abs(off) }
const BV = 'BV1xx411c7mD'
const SUB = { player: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://subtitle.example/a.json' }] }, subBody: [{ from: 0, to: 2, content: '你好' }, { from: 2, to: 4, content: '再见' }] }
const VENV_FF = (() => { try { const d = path.join(root, '.studio-venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'); const x = fs.readdirSync(d).find((n) => n.startsWith('ffmpeg')); return x ? path.join(d, x) : null } catch { return null } })()
let FF = null
try { FF = (await import(pathToFileURL(path.join(root, 'tools/lib/ffmpeg.mjs')).href)).requireFfmpeg() } catch { FF = VENV_FF }
const lib = pathToFileURL(path.join(root, 'tools/lib/watchlog.mjs')).href

function sandbox(t, spec = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-watch2-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'SECRET_SESSDATA_VALUE_123456', bili_jct: 'c'.repeat(32), buvid3: '' }))
  const specFile = path.join(home, 'video.json')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: path.join(home, 'data'), BILI_WHALE_CONFIG: path.join(home, 'data', 'c.json'), BILI_NO_CACHE: '1', BILI_WHALE_AGENT: '1',
    TEST_VIDEO_FILE: specFile, TEST_REQUESTS: path.join(home, 'req.jsonl'), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/video-fetch.mjs')).href }
  if (FF) env.FFMPEG = FF
  const set = (s) => fs.writeFileSync(specFile, JSON.stringify(s))
  set(spec)
  const bili = (args, extra = {}) => {
    try { fs.rmSync(env.TEST_REQUESTS, { force: true }) } catch {}
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'bili.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000 })
    const log = fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    return { code: r.status, out: r.stdout + r.stderr, reqs: log.map((x) => x.url), untimed: log.filter((x) => !x.timed).map((x) => x.url) }   // untimed：没给时限的请求（真网络上可能一直卡着）
  }
  const script = (code, extra = {}) => {
    const file = path.join(home, 't.mjs')
    fs.writeFileSync(file, code.replaceAll('@LIB@', lib).replaceAll('@ROOT@', root.replace(/\\/g, '/')))
    const r = spawnSync(process.execPath, [file], { env: { ...env, NODE_OPTIONS: '', ...extra }, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return r.stdout
  }
  const record = (bv = BV) => JSON.parse(script(`import { readWatch } from '@LIB@'; console.log(JSON.stringify(readWatch('${bv}')))`))
  const wipe = () => fs.rmSync(path.join(home, '.bili-ai', 'watch'), { recursive: true, force: true })
  return { home, env, set, bili, script, record, wipe }
}

test('the owner running debrief: the per-run summary is still right, and nothing is recorded as hers', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a', 'b'], replies: [{}] })
  const r = s.bili(['debrief', BV, '--no-frames'], { BILI_WHALE_AGENT: '' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /这次取到的：标题 \/ 简介、封面、字幕、弹幕、评论/); assert.match(r.out, /不是她的会话：不记看片记录/)
  assert.doesNotMatch(r.out, /什么都没取到/); assert.ok(!fs.existsSync(path.join(s.home, '.bili-ai', 'watch')))
})

test('a record file with a BOM can be read AND updated (read and write agree); debrief keeps recording into it', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}] })
  s.script(`
    import fs from 'node:fs'
    import { recordMaterial, watchFilePath } from '@LIB@'
    recordMaterial('${BV}', 'meta', { status: 'failed', why: 'view code=-404' })
    const f = watchFilePath('${BV}'); fs.writeFileSync(f, String.fromCharCode(0xfeff) + fs.readFileSync(f, 'utf8'))
  `)
  let rec = s.record()
  assert.equal(rec.corrupt, undefined); assert.equal(rec.materials.meta.status, 'failed')
  const r = s.bili(['debrief', BV, '--no-frames'])
  assert.match(r.out, /你手上有的范围：只有字幕/); assert.doesNotMatch(r.out, /没写上/)
  rec = s.record(); assert.equal(rec.materials.subtitles.status, 'ok'); assert.equal(rec.materials.meta.status, 'ok')
  assert.equal(s.bili(['watched', 'note', BV, '--text', '一句']).code, 0)
})

test('debrief: subtitles / comments / danmaku "none" vs "failed" are each pinned; aid, cover file and P1-only danmaku are recorded', (t) => {
  const s = sandbox(t)
  const run = (spec) => { s.wipe(); s.set({ view: { bvid: BV, aid: 170001 }, danmaku: ['a'], replies: [{}], ...spec }); const r = s.bili(['debrief', BV, '--no-frames']); return { r, rec: s.record() } }
  let { r, rec } = run({ ...SUB, subBody: 404 })
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /内容没下下来/)
  ;({ rec } = run({ player: { subtitles: [] }, webview: { subtitles: SUB.player.subtitles }, subBody: SUB.subBody }))
  assert.equal(rec.materials.subtitles.status, 'ok')
  ;({ rec } = run({ player: { subtitles: [], aiStatus: 1 }, webview: { subtitles: [] } }))
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /有 AI 字幕/)
  ;({ rec } = run({ player: { subtitles: [], needLogin: true }, webview: { subtitles: [] } }))
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /要登录/)
  ;({ rec } = run({ player: { code: -412 }, webview: { subtitles: [] } }))
  assert.equal(rec.materials.subtitles.status, 'none')
  // 热评：总数 0 才是没有；有评论却给了空页是没取到
  ;({ r, rec } = run({ ...SUB, replies: [], replyCount: 0 }))
  assert.equal(rec.materials.comments.status, 'none'); assert.match(r.out, /这次没拿到的：.*评论（这条视频没有评论）/)
  ;({ rec } = run({ ...SUB, replies: [], replyCount: 5 }))
  assert.equal(rec.materials.comments.status, 'failed'); assert.match(rec.materials.comments.why, /热评接口回了空页（标称 5 条）/)
  // 压缩的弹幕解得开；记 P1；aid、封面文件都记下
  ;({ rec } = run({ ...SUB, danmaku: 'deflate:哈,呵', view: { bvid: BV, aid: 170001, parts: 3 } }))
  assert.equal(rec.materials.danmaku.status, 'ok'); assert.equal(rec.materials.danmaku.count, 2); assert.equal(rec.materials.danmaku.part, 1)
  assert.equal(rec.aid, '170001'); assert.equal(rec.parts, 3); assert.ok(fs.existsSync(rec.materials.cover.file)); assert.ok(rec.materials.cover.sha1)
  assert.match(s.bili(['watched', 'show', BV]).out, /共 3 P：字幕 \/ 画面 \/ 弹幕只取了 P1/)
  // 只有弹幕（多 P）：也要说只取了 P1
  ;({ rec } = run({ player: { subtitles: [] }, webview: { subtitles: [] }, danmaku: ['x'], view: { bvid: BV, parts: 2 } }))
  assert.match(s.bili(['watched', 'show', BV]).out, /共 2 P：字幕 \/ 画面 \/ 弹幕只取了 P1/)
})

test('video: subtitle verdicts and fallback pinned; the whole (45-line) transcript is saved in the subtitles format; the dashboard shows its real title', (t) => {
  const s = sandbox(t)
  const run = (spec) => { s.wipe(); s.set({ view: { bvid: BV, title: '真标题' }, danmaku: ['a'], ...spec }); s.bili(['video', BV]); return s.record() }
  assert.equal(run({ loggedIn: false, player: { subtitles: [] }, webview: { subtitles: [] } }).materials.subtitles.status, 'failed')
  assert.equal(run({ player: { subtitles: [], aiStatus: 1 }, webview: { subtitles: [] } }).materials.subtitles.status, 'failed')
  assert.equal(run({ player: { subtitles: [] }, webview: { subtitles: SUB.player.subtitles }, subBody: SUB.subBody }).materials.subtitles.status, 'ok')
  assert.equal(run({ ...SUB, subBody: 404 }).materials.subtitles.status, 'failed')
  const long = Array.from({ length: 45 }, (_, i) => ({ from: i * 2, to: i * 2 + 2, content: '第' + i + '句' }))
  const rec = run({ ...SUB, subBody: long })
  assert.equal(rec.materials.subtitles.count, 45)
  const lines = fs.readFileSync(rec.materials.subtitles.file, 'utf8').split('\n')
  assert.equal(lines[0], '真标题'); assert.equal(lines.filter((l) => /^\[\d\d:\d\d\] /.test(l)).length, 45)
  assert.equal(rec.materials.danmaku.part, 1)
  s.script(`
    import assert from 'node:assert/strict'
    const { collect } = await import('file:///@ROOT@host/dashboard.mjs')
    const v = collect().views.items.find((x) => x.bv === '${BV}')
    assert.equal(v.title, '真标题')
  `)
})

test('comments: API failure → failed; empty first page with comments → failed; no total → skipped; a video that cannot be opened → 加载失败', (t) => {
  const s = sandbox(t)
  const run = (spec, args = []) => { s.wipe(); s.set({ view: { bvid: BV }, ...spec }); s.bili(['comments', BV, ...args]); return s.record() }
  assert.equal(run({ replies: { code: -412 } }).materials.comments.status, 'failed')
  let rec = run({ replies: [], replyCount: 25 })
  assert.equal(rec.materials.comments.status, 'failed'); assert.match(rec.materials.comments.why, /第一页是空的（标称 25 条）/)
  rec = run({ replies: [], replyCount: 'none' })
  assert.equal(rec.materials.comments.status, 'skipped'); assert.match(rec.materials.comments.why, /没给评论总数/)
  run({ replies: [] })
  assert.match(s.bili(['watched', 'show', BV]).out, /评论：这条视频没有评论/)
  rec = run({ view: { code: -404 } })
  assert.equal(rec.materials.meta.status, 'failed')
  assert.match(s.bili(['watched', 'show', BV]).out, /什么都没取到（加载失败）/)
})

test('subtitles: player down but fallback answered empty → none; a non-JSON subtitle body → failed; her session cannot redirect --out', (t) => {
  const s = sandbox(t)
  s.set({ view: { bvid: BV }, player: { code: -412 }, webview: { subtitles: [] } })
  s.bili(['subtitles', BV])
  assert.equal(s.record().materials.subtitles.status, 'none')
  s.wipe(); s.set({ view: { bvid: BV }, ...SUB, subBody: 'junk' })
  s.bili(['subtitles', BV])
  let rec = s.record(); assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /不是 JSON/)
  s.wipe(); s.set({ view: { bvid: BV }, ...SUB })
  const outside = path.join(s.home, 'elsewhere')
  s.bili(['subtitles', BV, '--out', outside])
  rec = s.record()
  assert.ok(!fs.existsSync(outside)); assert.ok(rec.materials.subtitles.file.startsWith(path.join(s.env.DSH_HOME, 'shots', 'subs')))
})

test('watched show: an unreadable ledger says "don\'t know", never "did nothing"; notes on a stale or multi-part full scope still get the caution; --days is capped at 30', (t) => {
  const s = sandbox(t, { view: { bvid: BV, parts: 3 }, ...SUB })
  s.bili(['subtitles', BV])
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'quota.json'), '{ broken')
  let r = s.bili(['watched', 'show', BV])
  assert.match(r.out, /额度账本读不出来/); assert.doesNotMatch(r.out, /你没对它做过什么/)
  s.script(`
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, WATCH_DIR } from '@LIB@'
    const sheet = path.join(path.dirname(WATCH_DIR), 's.jpg'); fs.writeFileSync(sheet, 'x')
    recordMaterial('${BV}', 'frames', { status: 'ok', count: 9, file: sheet })
  `)
  r = s.bili(['watched', 'note', BV, '--text', '看完了'])
  assert.match(r.out, /字幕 \+ 画面/); assert.match(r.out, /别说成看完了/)   // 多 P：只看了 P1
  s.wipe(); s.set({ view: { bvid: BV }, ...SUB }); s.bili(['subtitles', BV])
  s.script(`
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, WATCH_DIR } from '@LIB@'
    const sheet = path.join(path.dirname(WATCH_DIR), 's.jpg'); fs.writeFileSync(sheet, 'x')
    recordMaterial('${BV}', 'frames', { status: 'ok', count: 9, file: sheet })
    recordMaterial('${BV}', 'subtitles', { status: 'failed', why: 'x' })
  `)
  r = s.bili(['watched', 'note', BV, '--text', '看完了'])
  assert.match(r.out, /以前取到的/); assert.match(r.out, /别说成看完了/)
  assert.match(s.bili(['watched', 'list', '--days', '100']).out, /最近 30 天/)
})

test('watchlog library: ok survives none / failed and a fresh ok clears the old failure; invisible characters; guards against wrong files; case-collided material files; edge labels; thisRun; lastOkAt; local time', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, readWatch, scopeOf, addNote, previouslyLines, thisRun, actionsFor, recentWatches, watchFilePath, WATCH_DIR } from '@LIB@'
    const BV = '${BV}', c = (n) => String.fromCharCode(n)
    recordMaterial(BV, 'subtitles', { status: 'ok', count: 3 })
    const first = readWatch(BV)
    recordMaterial(BV, 'subtitles', { status: 'none', why: '没有' })
    let r = readWatch(BV)
    assert.equal(r.materials.subtitles.status, 'ok'); assert.equal(r.materials.subtitles.lastTry.status, 'none'); assert.deepEqual(scopeOf(r).stale, ['字幕'])
    assert.ok(r.lastAt >= first.lastAt); assert.equal(r.firstAt, first.firstAt)
    recordMaterial(BV, 'subtitles', { status: 'ok', count: 5 })
    r = readWatch(BV); assert.equal(r.materials.subtitles.lastTry, undefined); assert.deepEqual(scopeOf(r).stale, [])
    // 看不见的字符：每一段都换掉（笔记、标题、原因）
    const bad = [0, 9, 10, 13, 0x1f, 0x7f, 0x85, 0x9f, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    const junk = bad.map((x) => 'a' + c(x)).join('') + 'z'
    assert.equal(addNote(BV, junk).ok, true)
    recordMaterial(BV, 'meta', { status: 'failed', why: junk + 'x'.repeat(300), title: junk })
    r = readWatch(BV)
    for (const x of bad) { assert.ok(!r.notes.at(-1).text.includes(c(x)), 'note ' + x); assert.ok(!r.materials.meta.why.includes(c(x)), 'why ' + x) }
    assert.ok(r.materials.meta.why.length <= 161)
    assert.match(previouslyLines(BV)[0], /手上有的范围：只有字幕/)
    // 目录外的文件：没守卫时会去读的那个位置放一个，照样读不到
    const mask = BigInt('0b1' + Array.from('../x').map((ch) => (ch >= 'A' && ch <= 'Z' ? '1' : '0')).join('')).toString(36)
    fs.writeFileSync(path.join(WATCH_DIR, '..', 'x-' + mask + '.json'), JSON.stringify({ bvid: '../x', materials: { frames: { status: 'ok' } } }))
    assert.equal(readWatch('../x'), null)
    // 记录文件里写的是另一条视频：当成读不出来，不往里写、不让记
    const B2 = 'BV1GJ411x7h7'
    fs.writeFileSync(watchFilePath(B2), JSON.stringify({ bvid: 'BV1Q541167Qg', materials: { frames: { status: 'ok' } } }))
    assert.equal(readWatch(B2).corrupt, true); assert.equal(recordMaterial(B2, 'meta', { status: 'ok' }), false); assert.equal(addNote(B2, 'x').ok, false)
    // 只差大小写的两条视频写到了同一个封面文件（Windows）：指纹对不上就不算
    const B3 = 'BV1Q541167Qg', cover = path.join(path.dirname(WATCH_DIR), 'c.jpg')
    fs.writeFileSync(cover, 'cover of B3'); recordMaterial(B3, 'cover', { status: 'ok', file: cover })
    assert.equal(scopeOf(readWatch(B3)).key, 'thin'); assert.match(scopeOf(readWatch(B3)).label, /只有封面/)
    fs.writeFileSync(cover, 'cover of another video')
    let sc = scopeOf(readWatch(B3)); assert.equal(sc.key, 'none'); assert.ok(sc.missing.some((m) => m.includes('被别的视频覆盖了'))); assert.ok(!sc.saw.includes('封面'))
    // 画面文件不见了：saw / stale 里都不算
    const B4 = 'BV1AA411c7mD', sheet = path.join(path.dirname(WATCH_DIR), 'f.jpg')
    fs.writeFileSync(sheet, 'f'); recordMaterial(B4, 'frames', { status: 'ok', file: sheet }); recordMaterial(B4, 'frames', { status: 'failed', why: 'x' })
    assert.deepEqual(scopeOf(readWatch(B4)).stale, ['画面（抽帧）']); fs.rmSync(sheet)
    sc = scopeOf(readWatch(B4)); assert.ok(!sc.saw.includes('画面（抽帧）')); assert.ok(!sc.stale.includes('画面（抽帧）'))
    // 只「这次没取」过：什么都没取到（不是「加载失败」）；2 P 的说法
    const B5 = 'BV1BB411c7mD'
    recordMaterial(B5, 'frames', { status: 'skipped', why: '--no-frames' })
    sc = scopeOf(readWatch(B5)); assert.equal(sc.label, '什么都没取到'); assert.ok(sc.missing.includes('画面（抽帧）（这次没取：--no-frames）'))
    recordMaterial(B5, 'subtitles', { status: 'ok' }); recordMaterial(B5, 'meta', { status: 'ok', parts: 2 })
    assert.match(scopeOf(readWatch(B5)).label, /共 2 P/); assert.match(scopeOf(readWatch(B5)).label, /^只有字幕/)
    // thisRun：只算这次之后的
    const rec = { materials: { subtitles: { status: 'ok', at: '2026-10-23T01:00:00.000Z' }, danmaku: { status: 'ok', at: '2026-10-23T03:00:00.000Z' }, comments: { status: 'ok', at: '2026-10-23T01:00:00.000Z', lastTry: { status: 'failed', why: 'x', at: '2026-10-23T03:00:00.000Z' } } } }
    assert.deepEqual(thisRun(rec, '2026-10-23T02:00:00.000Z'), { got: ['弹幕'], notGot: ['评论（没取到：x）'] })
    // 账本里只差大小写的 BV：不是这一条
    fs.writeFileSync(path.join(path.dirname(WATCH_DIR), 'quota.json'), JSON.stringify({ log: [{ at: 'x', type: 'comment', target: 'BV:BV1xx411c7md', note: 'n' }] }))
    assert.equal(actionsFor(BV).items.length, 0)
    // 最近取到的那一样决定「最近看过」：三天前的封面 + 刚才的字幕 → 算最近
    const B6 = 'BV1CC411c7mD', old = new Date(Date.now() - 3 * 86400000).toISOString()
    fs.writeFileSync(watchFilePath(B6), JSON.stringify({ bvid: B6, firstAt: old, lastAt: new Date().toISOString(), materials: { cover: { status: 'ok', at: old }, subtitles: { status: 'ok', at: new Date().toISOString() } } }))
    assert.ok(recentWatches(Date.now() - 86400000).some((x) => x.bvid === B6))
    // 看片记录目录里不像记录的文件不认
    fs.writeFileSync(path.join(WATCH_DIR, BV + '-zz.json'), JSON.stringify({ bvid: BV, materials: { meta: { status: 'ok', at: new Date().toISOString() } } }))
    assert.equal(recentWatches(0).filter((x) => x.bvid === BV).length, 1)
  `)
  // 本地时间：按机器的时区显示
  const out = s.script(`import { localTime } from '@LIB@'; console.log(localTime('2026-10-23T00:00:00Z'))`, { TZ: 'Asia/Shanghai' })
  assert.equal(out.trim(), '2026-10-23 08:00')
})

test('dashboard and list: an old corrupt record is not "watched today"; a video only obtained yesterday is not today; the row time is the last real result', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { watchFilePath, WATCH_DIR } from '@LIB@'
    fs.mkdirSync(WATCH_DIR, { recursive: true })
    const corrupt = watchFilePath('BV1GJ411x7h7'); fs.writeFileSync(corrupt, '{ broken')
    const two = new Date(Date.now() - 2 * 86400000); fs.utimesSync(corrupt, two, two)
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const y = new Date(midnight.getTime() - 60000).toISOString()   // 昨天 23:59（24 小时以内，但不是今天）
    fs.writeFileSync(watchFilePath('BV1Q541167Qg'), JSON.stringify({ bvid: 'BV1Q541167Qg', title: '昨天', firstAt: y, lastAt: y, materials: { meta: { status: 'ok', at: y } } }))
    const okAt = new Date(Date.now() - 600000).toISOString(), failAt = new Date().toISOString()
    fs.writeFileSync(watchFilePath('${BV}'), JSON.stringify({ bvid: '${BV}', title: '今天', firstAt: okAt, lastAt: failAt, materials: { meta: { status: 'ok', at: okAt, lastTry: { status: 'failed', at: failAt } } } }))
    const { collect } = await import('file:///@ROOT@host/dashboard.mjs')
    const items = collect().views.items
    assert.ok(!items.some((x) => x.bv === 'BV1GJ411x7h7')); assert.ok(!items.some((x) => x.bv === 'BV1Q541167Qg'))
    assert.equal(items.find((x) => x.bv === '${BV}').at, okAt)
  `)
  const r = s.bili(['watched', 'list'])
  assert.doesNotMatch(r.out, /记录文件读不出来/)
})

test('watch-video on a real (tiny) video: multi-part takes frames inside P1; --uniform sheets are named apart and not reused by default; download 404 / cut off / not a video are recorded with the reason', { skip: !FF && '没有 ffmpeg', timeout: 300_000 }, (t) => {
  const s = sandbox(t)
  const mp4 = path.join(s.home, 'tiny.mp4')
  const g = spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10', '-pix_fmt', 'yuv420p', mp4], { encoding: 'utf8' })
  assert.equal(g.status, 0, g.stderr)
  const spec = (extra = {}) => ({ view: { bvid: BV, title: '三段', duration: 30, parts: 3, pageDuration: 3 }, playurl: { code: 0, durl: [{ url: 'https://upos.example/v.mp4' }] }, mediaFile: mp4, ...extra })
  s.set(spec())
  let r = s.bili(['watch-video', BV, '--uniform'])
  assert.equal(r.code, 0, r.out)
  const times = (r.out.match(/时间点\s*:\s*(.*)/)?.[1] ?? '').match(/\d\d:\d\d/g) ?? []
  assert.equal(times.length, 9); assert.ok(times.every((x) => x <= '00:03'), times.join(' '))
  const sheet = (r.out.match(/SHEET: (.*)/)?.[1] ?? '').trim()
  assert.ok(sheet.endsWith('-3x3-u.jpg'), sheet); assert.ok(fs.existsSync(sheet))
  let rec = s.record()
  assert.equal(rec.materials.frames.status, 'ok'); assert.equal(rec.materials.frames.count, 9); assert.equal(rec.materials.frames.part, 1); assert.equal(rec.parts, 3)
  // 默认模式不拿等间隔的那张顶
  r = s.bili(['watch-video', BV])
  assert.ok(r.reqs.some((u) => u.includes('playurl'))); assert.equal(r.code, 0, r.out)
  // 下载失败 / 下到一半断 / 下下来的不是视频：各自的原因记下来，半截文件不留
  for (const [media, code, why] of [['404', 5, /HTTP 404/], ['cut', 5, /下载到一半断了/], ['junk', 6, /ffmpeg 抽帧失败/]]) {
    s.wipe(); s.set(spec({ media }))
    const before = new Set(fs.readdirSync(path.join(s.env.DSH_HOME, 'shots', 'video')))
    r = s.bili(['watch-video', BV, '--fresh'])
    assert.equal(r.code, code, media + ': ' + r.out)
    rec = s.record(); assert.equal(rec.materials.frames.status, 'failed', media); assert.match(rec.materials.frames.why, why, media)
    if (media === 'cut') assert.ok(![...fs.readdirSync(path.join(s.env.DSH_HOME, 'shots', 'video'))].some((f) => !before.has(f) && f.endsWith('.mp4')), '半截文件没删')
  }
})

test('debrief with frames: a failed frame fetch is recorded with watch-video\'s own reason and said in the summary; a cached sheet counts as frames got this time; a half-written newest sheet is skipped', { skip: !FF && '没有 ffmpeg' }, (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}], playurl: { code: -404 } })
  let r = s.bili(['debrief', BV])
  let rec = s.record()
  assert.equal(rec.materials.frames.status, 'failed'); assert.match(rec.materials.frames.why, /没拿到播放地址/)
  assert.match(r.out, /这次没拿到的：.*画面（抽帧）（没取到：没拿到播放地址/)
  const dir = path.join(s.env.DSH_HOME, 'shots', 'video')
  fs.mkdirSync(dir, { recursive: true })
  const good = path.join(dir, `${BV}-2026-10-23T08-00-00-000Z-3x3.jpg`), half = path.join(dir, `${BV}-2026-10-23T09-00-00-000Z-3x3.jpg`)
  fs.writeFileSync(good, Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])); fs.writeFileSync(half, Buffer.from([0xff, 0xd8, 1, 2, 3, 4]))
  const t1 = new Date(Date.now() - 120_000), t2 = new Date(Date.now() - 60_000)
  fs.utimesSync(good, t1, t1); fs.utimesSync(half, t2, t2)
  r = s.bili(['debrief', BV])
  assert.ok(r.out.includes(`SHEET: ${good}`), r.out)
  assert.match(r.out, /这次取到的：.*画面（抽帧）/); assert.match(r.out, /你手上有的范围：字幕 \+ 画面/)
  rec = s.record(); assert.equal(rec.materials.frames.status, 'ok'); assert.equal(rec.materials.frames.file, good)
})

// ─────────────── 第三轮之后补的 ───────────────
test('watched show: each material line agrees with the scope (title only, overwritten or vanished files, P1-only "none"); notes show the scope they were written under', (t) => {
  const s = sandbox(t, { view: { bvid: BV, title: '甲' }, replies: [{}] })
  s.bili(['comments', BV])
  let r = s.bili(['watched', 'show', BV])
  assert.match(r.out, /· 标题：取到了/); assert.doesNotMatch(r.out, /标题 \/ 简介/)
  s.set({ view: { bvid: BV, title: '甲' }, ...SUB })
  s.bili(['subtitles', BV])
  const file = s.record().materials.subtitles.file
  fs.writeFileSync(file, '乙\nUP主  BV1xx411c7md  90s\n\n[00:00] 另一条视频的台词')   // Windows 上只差大小写的另一条视频写到了同一个文件
  r = s.bili(['watched', 'show', BV])
  assert.match(r.out, /字幕：以前取到过，文件不见了 \/ 被别的视频覆盖了/); assert.ok(!r.out.includes(file))
  fs.rmSync(file)
  r = s.bili(['watched', 'show', BV]); assert.match(r.out, /字幕：以前取到过，文件不见了/)
  s.wipe(); s.set({ view: { bvid: BV, parts: 3 }, player: { subtitles: [] }, webview: { subtitles: [] } })
  s.bili(['subtitles', BV])
  r = s.bili(['watched', 'show', BV])
  assert.match(r.out, /字幕：P1 没有字幕轨道/); assert.match(r.out, /共 3 P：字幕 \/ 画面 \/ 弹幕只取了 P1/)
  s.wipe(); s.set({ view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}] })
  s.bili(['debrief', BV, '--no-frames'])
  s.bili(['watched', 'note', BV, '--text', '一只猫在学喝水'])
  assert.match(s.bili(['watched', 'show', BV]).out, /（当时的范围：只有字幕（画面没看））「一只猫在学喝水」/)
})

test('multi-part videos: subtitles and video say their output is P1 only; debrief does not compute a sampling ratio against the whole video\'s count', (t) => {
  const s = sandbox(t, { view: { bvid: BV, parts: 3, duration: 900, pageDuration: 300 }, ...SUB, danmaku: ['a'], replies: [{}] })
  assert.match(s.bili(['subtitles', BV]).out, /多 P 视频，共 3 P：下面的字幕只是 P1（300s）/)
  assert.match(s.bili(['video', BV]).out, /多 P 视频，共 3 P：下面的字幕、弹幕只是 P1/)
  const r = s.bili(['debrief', BV, '--no-frames'])
  assert.match(r.out, /接口标称 3 条是全片（3 P）的，这里只是 P1，不算采样比/); assert.doesNotMatch(r.out, /采样比约/)
  const rec = s.record()
  for (const k of ['subtitles', 'danmaku', 'frames']) assert.equal(rec.materials[k].part ?? rec.materials[k].lastTry?.part, 1, k)
})

test('meta: only debrief and video count as "标题 / 简介" (they show the description) and that survives later title-only tools; subtitles / watch-video say "标题"', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, player: { subtitles: [] }, webview: { subtitles: [] }, danmaku: ['a'], replies: [{}] })
  s.bili(['subtitles', BV])
  let rec = s.record(); assert.equal(rec.materials.meta.desc, undefined)
  assert.match(s.bili(['watched', 'show', BV]).out, /手上有的范围：只有标题（/)
  s.bili(['debrief', BV, '--no-frames'])
  assert.equal(s.record().materials.meta.desc, true)
  s.bili(['comments', BV])
  assert.equal(s.record().materials.meta.desc, true)
  s.wipe(); s.bili(['video', BV])
  assert.equal(s.record().materials.meta.desc, true)
})

test('video: needLogin → failed; player down + fallback empty → none; a failed transcript save is not "got"; a video that cannot be opened (video / watch-video) → 加载失败; part 1 recorded', (t) => {
  const s = sandbox(t)
  const run = (spec, cmd = 'video') => { s.wipe(); s.set({ view: { bvid: BV }, danmaku: ['a'], ...spec }); s.bili([cmd, BV]); return s.record() }
  let rec = run({ player: { subtitles: [], needLogin: true }, webview: { subtitles: [] } })
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /要登录/)
  rec = run({ player: { code: -412 }, webview: { subtitles: [] } })
  assert.equal(rec.materials.subtitles.status, 'none')
  rec = run({ ...SUB }); assert.equal(rec.materials.subtitles.part, 1)
  const asDir = path.join(s.env.DSH_HOME, 'shots', 'subs', `${BV}-video.txt`)
  s.wipe(); fs.rmSync(asDir, { force: true }); fs.mkdirSync(asDir, { recursive: true })   // 存全文的地方是个目录：存不进去
  s.set({ view: { bvid: BV }, ...SUB, danmaku: ['a'] }); s.bili(['video', BV])
  rec = s.record(); assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /没存下来/)
  for (const cmd of ['video', 'watch-video']) {
    rec = run({ view: { code: -404 } }, cmd)
    assert.equal(rec.materials.meta.status, 'failed', cmd)
    assert.match(s.bili(['watched', 'show', BV]).out, /什么都没取到（加载失败）/, cmd)
  }
  s.wipe(); s.set({ view: { bvid: BV }, ...SUB }); s.bili(['subtitles', BV])
  assert.equal(s.record().materials.subtitles.part, 1)
})

test('debrief: comments with no total → failed; the transcript file and its fingerprint are recorded', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [], replyCount: 'none' })
  s.bili(['debrief', BV, '--no-frames'])
  const rec = s.record()
  assert.equal(rec.materials.comments.status, 'failed')
  assert.ok(rec.materials.subtitles.file.endsWith('-debrief.txt')); assert.match(rec.materials.subtitles.sha1, /^[0-9a-f]{40}$/)
})

test('debrief: when watch-video dies before it can record, debrief records the frame failure itself; with an earlier ok, the latest reason is kept and said', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}], playurl: { code: -404 } })
  const noFf = { FFMPEG: path.join(s.home, 'no-ffmpeg.exe'), LOCALAPPDATA: s.home, PATH: path.dirname(process.execPath) }
  // 这样还是找得到 ffmpeg（放在 tools/bin 或跑测试的 node 旁边 —— 前者正是找不到时提示放的地方）：这一项测不了「没有 ffmpeg」，跳过
  const still = spawnSync(process.execPath, ['--input-type=module', '-e', `import { ffmpegPath } from ${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'lib', 'ffmpeg.mjs')).href)}; console.log(ffmpegPath() ?? '')`],
    { env: { ...s.env, ...noFf }, encoding: 'utf8' }).stdout.trim()
  if (still) { t.skip(`这台机器上去掉 FFMPEG / PATH 之后还找得到 ffmpeg：${still}`); return }
  let r = s.bili(['debrief', BV], noFf)
  let rec = s.record()
  assert.equal(rec.materials.frames.status, 'failed'); assert.equal(rec.materials.frames.why, '抽帧失败')
  assert.match(r.out, /这次没拿到的：.*画面（抽帧）（没取到：抽帧失败）/)
  if (!FF) return
  s.script(`
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, WATCH_DIR } from '@LIB@'
    const f = path.join(path.dirname(WATCH_DIR), 'old.jpg'); fs.writeFileSync(f, 'x')
    recordMaterial('${BV}', 'frames', { status: 'ok', count: 9, file: f })
  `)
  r = s.bili(['debrief', BV])
  rec = s.record()
  assert.equal(rec.materials.frames.status, 'ok'); assert.match(rec.materials.frames.lastTry.why, /没拿到播放地址/)
  assert.match(r.out, /画面（抽帧）（没取到：没拿到播放地址/)
})

test('debrief says "没写上" (and no scope) when the record cannot be written', { skip: process.platform !== 'win32' && '只读文件的行为按 Windows 测' }, (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}] })
  s.bili(['subtitles', BV])
  const f = JSON.parse(s.script(`import { watchFilePath } from '@LIB@'; console.log(JSON.stringify(watchFilePath('${BV}')))`))
  fs.chmodSync(f, 0o444)
  t.after(() => { try { fs.chmodSync(f, 0o666) } catch {} })
  const r = s.bili(['debrief', BV, '--no-frames'])
  assert.match(r.out, /没写上/); assert.doesNotMatch(r.out, /你手上有的范围/); assert.doesNotMatch(r.out, /watched note/)
})

test('watchlog details: lastAt really moves; a file without a fingerprint counts only while it exists; a failed latest retry on nothing is 加载失败; owner names are cleaned; the note limit is inclusive; list rows', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, readWatch, scopeOf, addNote, watchFilePath, WATCH_DIR, NOTE_MAX } from '@LIB@'
    const BV = '${BV}', c = (n) => String.fromCharCode(n)
    fs.mkdirSync(WATCH_DIR, { recursive: true })
    const f = path.join(path.dirname(WATCH_DIR), 'nosha.jpg'); fs.writeFileSync(f, 'x')
    const old = '2026-01-01T00:00:00.000Z'
    fs.writeFileSync(watchFilePath(BV), JSON.stringify({ bvid: BV, firstAt: old, lastAt: old, materials: { frames: { status: 'ok', at: old, file: f } } }))
    assert.equal(scopeOf(readWatch(BV)).key, 'image')
    recordMaterial(BV, 'meta', { status: 'ok', owner: 'U' + c(0x202e) + c(10) + 'P'.repeat(100) })
    const r = readWatch(BV)
    assert.ok(r.lastAt > old); assert.equal(r.lastAt, r.materials.meta.at)
    assert.ok(!r.owner.includes(c(0x202e)) && !r.owner.includes(c(10))); assert.ok(r.owner.length <= 61)
    fs.rmSync(f)
    assert.equal(scopeOf(readWatch(BV)).saw.includes('画面（抽帧）'), false)
    // 取到过、文件没了、最近一次又失败：什么都没有，而且是「加载失败」
    const B2 = 'BV1GJ411x7h7', g = path.join(path.dirname(WATCH_DIR), 'g.jpg'); fs.writeFileSync(g, 'g')
    recordMaterial(B2, 'frames', { status: 'ok', file: g }); recordMaterial(B2, 'frames', { status: 'failed', why: 'x' }); fs.rmSync(g)
    assert.equal(scopeOf(readWatch(B2)).label, '什么都没取到（加载失败）')
    // 笔记上限：正好 NOTE_MAX 个字可以
    recordMaterial(B2, 'subtitles', { status: 'ok' })
    assert.equal(addNote(B2, 'x'.repeat(NOTE_MAX)).ok, true)
    // list：时间按最后一次真的取到东西算；有没有记理解
    const okAt = new Date(Date.now() - 600000).toISOString()
    fs.writeFileSync(watchFilePath('BV1Q541167Qg'), JSON.stringify({ bvid: 'BV1Q541167Qg', title: '没记', firstAt: okAt, lastAt: new Date().toISOString(), materials: { meta: { status: 'ok', at: okAt, lastTry: { status: 'failed', at: new Date().toISOString() } } } }))
  `)
  const r = s.bili(['watched', 'list'])
  const okLine = r.out.split('\n').find((l) => l.includes('《没记》'))
  assert.ok(okLine && okLine.includes('还没记理解'), r.out)
  assert.ok(r.out.split('\n').some((l) => l.includes('BV1GJ411x7h7') && l.includes('记了 1 条理解')), r.out)
  const lt = s.script(`import { localTime } from '@LIB@'; import fs from 'node:fs'; import { watchFilePath } from '@LIB@'; console.log(localTime(JSON.parse(fs.readFileSync(watchFilePath('BV1Q541167Qg'), 'utf8')).materials.meta.at))`).trim()
  assert.ok(okLine.includes(lt), okLine + ' / ' + lt)
})

test('comments: a total of 1 with an empty first page is "failed"; the dashboard takes the title from the watch record', (t) => {
  const s = sandbox(t, { view: { bvid: BV, title: '记录里的标题' }, replies: [], replyCount: 1 })
  s.bili(['comments', BV])
  assert.equal(s.record().materials.comments.status, 'failed')
  s.set({ view: { bvid: BV, title: '记录里的标题' }, replies: [{}] }); s.bili(['comments', BV])
  s.script(`
    import assert from 'node:assert/strict'
    const { collect } = await import('file:///@ROOT@host/dashboard.mjs')
    assert.equal(collect().views.items.find((x) => x.bv === '${BV}').title, '记录里的标题')
  `)
})

test('watch-video on a real video: the frame count is what was really extracted; a cached sheet is P1; --substrip covers the whole P1 and says how far it reaches', { skip: !FF && '没有 ffmpeg', timeout: 300_000 }, (t) => {
  const s = sandbox(t)
  const long = path.join(s.home, 'long.mp4')
  const g = spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=150:size=96x72:rate=1', '-pix_fmt', 'yuv420p', long], { encoding: 'utf8' })
  assert.equal(g.status, 0, g.stderr)
  // 真视频 150 秒、接口说 P1 有 600 秒：抽帧时间有一半落在结尾以后 —— 记实际抽到的帧数，或者干脆记失败，绝不记 9
  s.set({ view: { bvid: BV, duration: 1200, parts: 2, pageDuration: 600 }, playurl: { code: 0, durl: [{ url: 'https://upos.example/v.mp4' }] }, mediaFile: long })
  let r = s.bili(['watch-video', BV, '--uniform'])
  let f = s.record().materials.frames
  if (f.status === 'ok') assert.ok(f.count < 9, String(f.count)); else assert.match(f.why, /抽帧失败/)
  // P1 时长对了：9 帧都抽到；缓存再用时照样标 P1
  s.wipe(); s.set({ view: { bvid: BV, duration: 300, parts: 2, pageDuration: 150 }, playurl: { code: 0, durl: [{ url: 'https://upos.example/v.mp4' }] }, mediaFile: long, ...SUB, danmaku: ['a'], replies: [{}] })
  r = s.bili(['debrief', BV, '--substrip'])
  assert.equal(r.code, 0, r.out)
  f = s.record().materials.frames; assert.equal(f.status, 'ok'); assert.equal(f.count, 9); assert.equal(f.part, 1)
  assert.match(r.out, /STRIP: /); assert.match(r.out, /每 8 秒一帧 × 19 行 · 裁下画面下方 32% 的字幕带 · 覆盖 00:00–02:30（只是 P1）/)
  assert.doesNotMatch(r.out, /整片台词/)
  r = s.bili(['watch-video', BV])
  assert.match(r.out, /没有重新下载/); assert.equal(s.record().materials.frames.part, 1)
})

// ─────────────── Astra 审查之后补的 ───────────────
test('subtitle download drops (network / mid-body / timeout) after an earlier ok: subtitles records this run as failed and exits 4 cleanly; debrief records it and still fetches danmaku and comments; video too; every request has a deadline', (t) => {
  const base = { view: { bvid: BV }, ...SUB, danmaku: ['a', 'b'], replies: [{}] }
  const s = sandbox(t, base)
  let r = s.bili(['subtitles', BV])
  assert.equal(r.code, 0, r.out); assert.deepEqual(r.untimed, [])
  for (const [mode, why] of [['netfail', /网络出错/], ['cut', /下到一半断了/], ['timeout', /超时/]]) {
    s.set({ ...base, subBody: mode })
    r = s.bili(['subtitles', BV])
    assert.equal(r.code, 4, mode + ': ' + r.out); assert.match(r.out, why, mode); assert.doesNotMatch(r.out, /TypeError|at file:/, mode)
    let sub = s.record().materials.subtitles
    assert.equal(sub.status, 'ok', mode); assert.equal(sub.lastTry.status, 'failed', mode); assert.equal(sub.lastTry.via, 'subtitles', mode); assert.match(sub.lastTry.why, why, mode)
    r = s.bili(['debrief', BV, '--no-frames'])
    assert.equal(r.code, 0, mode + ': ' + r.out); assert.deepEqual(r.untimed, [], mode)
    assert.match(r.out, /这次取到的：标题 \/ 简介、封面、弹幕、评论/, mode)
    assert.match(r.out, /这次没拿到的：字幕（没取到：有字幕轨道，内容没下下来（/, mode)
    assert.match(r.out, /其中字幕是以前取到的，最近一次没取到/, mode)
    sub = s.record().materials.subtitles
    assert.equal(sub.status, 'ok', mode); assert.equal(sub.lastTry.via, 'debrief', mode); assert.match(sub.lastTry.why, why, mode)
    r = s.bili(['video', BV])
    assert.equal(r.code, 0, mode + ': ' + r.out); assert.deepEqual(r.untimed, [], mode); assert.match(r.out, /弹幕 2 条/, mode)
    sub = s.record().materials.subtitles
    assert.equal(sub.lastTry.status, 'failed', mode); assert.equal(sub.lastTry.via, 'video', mode)
  }
  // 第一次就断网（没有以前的）：记成这次没取到，不是「没有字幕」
  s.wipe(); s.set({ ...base, subBody: 'netfail' })
  r = s.bili(['debrief', BV, '--no-frames'])
  assert.equal(r.code, 0, r.out)
  const rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.equal(rec.materials.danmaku.status, 'ok'); assert.equal(rec.materials.comments.status, 'ok')
})

test('debrief danmaku: a dropped network or a timeout is recorded as such (not "被风控"), and the rest still runs', (t) => {
  const s = sandbox(t)
  for (const [mode, why] of [['netfail', /网络出错/], ['timeout', /超时/]]) {
    s.wipe(); s.set({ view: { bvid: BV }, ...SUB, danmaku: mode, replies: [{}] })
    const r = s.bili(['debrief', BV, '--no-frames'])
    assert.equal(r.code, 0, mode + ': ' + r.out); assert.deepEqual(r.untimed, [], mode)
    const dm = s.record().materials.danmaku
    assert.equal(dm.status, 'failed', mode); assert.match(dm.why, why, mode); assert.doesNotMatch(dm.why, /风控/, mode)
    assert.match(r.out, /这次取到的：标题 \/ 简介、封面、字幕、评论/, mode)
  }
})

test('a subtitle file that cannot be saved: subtitles records failed and exits 6 cleanly; debrief records failed and goes on', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}] })
  const dir = path.join(s.env.DSH_HOME, 'shots', 'subs')
  fs.mkdirSync(path.join(dir, `${BV}-ai-zh.json`), { recursive: true }); fs.mkdirSync(path.join(dir, `${BV}-debrief.txt`), { recursive: true })   // 要写的地方是个目录：存不进去
  let r = s.bili(['subtitles', BV])
  assert.equal(r.code, 6, r.out); assert.match(r.out, /没存下来/); assert.doesNotMatch(r.out, /at file:/)
  let sub = s.record().materials.subtitles
  assert.equal(sub.status, 'failed'); assert.match(sub.why, /没存下来/)
  r = s.bili(['debrief', BV, '--no-frames'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /这次没拿到的：字幕（没取到：字幕下下来了，但没存下来）/); assert.match(r.out, /这次取到的：标题 \/ 简介、封面、弹幕、评论/)
  sub = s.record().materials.subtitles
  assert.equal(sub.status, 'failed'); assert.equal(sub.via, 'debrief'); assert.match(sub.why, /没存下来/)
})

test('a dropped cover download says what went wrong in plain words (not the raw English error); the video command says why danmaku did not come either', (t) => {
  const s = sandbox(t)
  for (const [mode, why] of [['netfail', '网络出错'], ['cut', '下到一半断了'], ['timeout', '下载超时'], [404, 'HTTP 404']]) {
    s.wipe(); s.set({ view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}], cover: mode })
    const r = s.bili(['debrief', BV, '--no-frames'])
    assert.equal(r.code, 0, mode + ': ' + r.out)
    assert.equal(s.record().materials.cover.why, why, String(mode)); assert.match(r.out, new RegExp('封面下载失败：' + why))
    assert.doesNotMatch(r.out, /fetch failed|terminated|aborted/, String(mode))
  }
  for (const [mode, why] of [['netfail', '网络出错'], ['timeout', '下载超时']]) {
    s.wipe(); s.set({ view: { bvid: BV }, ...SUB, danmaku: mode })
    const r = s.bili(['video', BV])
    assert.equal(r.code, 0, mode + ': ' + r.out); assert.match(r.out, new RegExp('没取到弹幕（' + why + '）'))
    const dm = s.record().materials.danmaku
    assert.equal(dm.status, 'failed'); assert.equal(dm.why, `没取到弹幕（${why}）`); assert.doesNotMatch(dm.why, /被拦/)
  }
})
