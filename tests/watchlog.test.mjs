// 看片记录（tools/lib/watchlog.mjs + watched 命令 + 各取素材工具）：每样素材取没取到分开记；看的范围由工具按素材算，不由她说；
// 字幕 / 画面都有、只有画面、只有字幕、只有标题简介、加载失败 —— 各有清楚的说法；什么都没有不让记「看懂了什么」；
// 「这次取到的」和「以前取到的」分开说；没登录 / AI 字幕没给不算「没有字幕」；她写的字不能冒充工具写的行；做过的事只认账本、照实标没核对的
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const BV = 'BV1xx411c7mD'
const SUB = { player: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://subtitle.example/a.json' }] }, subBody: [{ from: 0, to: 2, content: '你好' }, { from: 2, to: 4, content: '再见' }] }
// 系统里没有 ffmpeg 时，用工作室依赖（.studio-venv）里 imageio-ffmpeg 带的那个
const VENV_FF = (() => { try { const d = path.join(root, '.studio-venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'); const x = fs.readdirSync(d).find((n) => n.startsWith('ffmpeg')); return x ? path.join(d, x) : null } catch { return null } })()
// 本机真实环境里找到的那份（路径）：沙盒换了数据目录，放在 <数据目录>/bili-whale/bin 里的那份在沙盒里就找不到了 —— 用 FFMPEG 把确切路径交给沙盒
const REAL_FF = (() => { try { const r = spawnSync(process.execPath, ['-e', `import('${pathToFileURL(path.join(root, 'tools/lib/ffmpeg.mjs')).href}').then((m) => { process.stdout.write(m.ffmpegPath() ?? '') })`], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null } catch { return null } })()
const ffmpegFound = Boolean(REAL_FF)

function sandbox(t, spec = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-watch-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(home, '.bili-ai', 'credentials.json'), JSON.stringify({ sessdata: 'SECRET_SESSDATA_VALUE_123456', bili_jct: 'c'.repeat(32), buvid3: '' }))
  const specFile = path.join(home, 'video.json')
  // 看片记录只记她自己的会话里取的：工具都按「她在跑」来测
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: path.join(home, 'data'), BILI_WHALE_CONFIG: path.join(home, 'data', 'c.json'), BILI_NO_CACHE: '1', BILI_WHALE_AGENT: '1',
    TEST_VIDEO_FILE: specFile, TEST_REQUESTS: path.join(home, 'req.jsonl'), NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/video-fetch.mjs')).href }
  if (REAL_FF || VENV_FF) env.FFMPEG = REAL_FF || VENV_FF
  const set = (s) => fs.writeFileSync(specFile, JSON.stringify(s))
  set(spec)
  const bili = (...args) => {
    try { fs.rmSync(env.TEST_REQUESTS, { force: true }) } catch {}
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'bili.mjs'), ...args], { env, encoding: 'utf8', timeout: 120_000 })
    const reqs = fs.existsSync(env.TEST_REQUESTS) ? fs.readFileSync(env.TEST_REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).url) : []
    return { code: r.status, out: r.stdout + r.stderr, reqs }
  }
  const script = (code) => {
    const file = path.join(home, 't.mjs')
    fs.writeFileSync(file, code.replaceAll('@ROOT@', root.replace(/\\/g, '/')))
    const r = spawnSync(process.execPath, [file], { env: { ...env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return r.stdout
  }
  const record = (bv = BV) => JSON.parse(script(`import { readWatch } from 'file:///@ROOT@tools/lib/watchlog.mjs'; console.log(JSON.stringify(readWatch('${bv}')))`))
  const wipe = () => fs.rmSync(path.join(home, '.bili-ai', 'watch'), { recursive: true, force: true })
  return { home, env, set, bili, script, record, wipe }
}

test('scope comes from what is really on hand: text+image / text / image / thin / none; old files that vanished do not count; stale and multi-part are said out loud', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import { recordMaterial, readWatch, scopeOf, watchFilePath, WATCH_DIR } from 'file:///@ROOT@tools/lib/watchlog.mjs'
    const BV = '${BV}'
    assert.equal(scopeOf(readWatch(BV)).key, 'none')
    assert.equal(recordMaterial(BV, 'meta', { status: 'ok', via: 'debrief', title: '标题', owner: 'UP', duration: 90, aid: '170001', desc: true }), true)
    const first = readWatch(BV).firstAt
    assert.equal(scopeOf(readWatch(BV)).key, 'thin'); assert.match(scopeOf(readWatch(BV)).label, /只有标题 \\/ 简介/)
    const sheet = path.join(path.dirname(WATCH_DIR), 'x.jpg'); fs.writeFileSync(sheet, 'jpg')
    recordMaterial(BV, 'frames', { status: 'ok', count: 9, file: sheet, via: 'watch-video' })
    assert.equal(scopeOf(readWatch(BV)).key, 'image'); assert.match(scopeOf(readWatch(BV)).label, /只有画面/)
    recordMaterial(BV, 'subtitles', { status: 'none', why: '这条视频没有字幕轨道', via: 'subtitles' })
    let sc = scopeOf(readWatch(BV)); assert.equal(sc.key, 'image'); assert.ok(sc.missing.includes('字幕（这条视频没有字幕轨道）'))
    recordMaterial(BV, 'subtitles', { status: 'ok', count: 100, via: 'subtitles' })
    recordMaterial(BV, 'subtitles', { status: 'ok', count: 120, via: 'subtitles' })   // 又取到一次：换成新的，不算「重试失败」
    let r = readWatch(BV)
    assert.equal(r.materials.subtitles.count, 120); assert.equal(r.materials.subtitles.lastTry, undefined)
    assert.equal(scopeOf(r).key, 'text+image'); assert.deepEqual(scopeOf(r).stale, [])
    // 后来又取了一次没取到 / 这次没取：取到过的还算，但说清是以前取到的
    recordMaterial(BV, 'subtitles', { status: 'failed', why: 'HTTP 403', via: 'subtitles' })
    recordMaterial(BV, 'frames', { status: 'skipped', why: '--no-frames', via: 'debrief' })
    r = readWatch(BV)
    assert.equal(r.materials.subtitles.status, 'ok'); assert.equal(r.materials.subtitles.lastTry.why, 'HTTP 403')
    assert.equal(r.materials.frames.status, 'ok'); assert.equal(r.materials.frames.lastTry.status, 'skipped')
    sc = scopeOf(r); assert.equal(sc.key, 'text+image'); assert.deepEqual(sc.stale, ['字幕', '画面（抽帧）']); assert.match(sc.label, /其中字幕、画面（抽帧）是以前取到的，最近一次没取到/)
    assert.equal(r.owner, 'UP'); assert.equal(r.firstAt, first); assert.equal(r.aid, '170001'); assert.equal(r.duration, 90)
    // 记下的画面文件不见了：不算手上有
    fs.rmSync(sheet)
    sc = scopeOf(readWatch(BV)); assert.equal(sc.key, 'text'); assert.ok(sc.missing.some((m) => m.includes('以前取到过，文件不见了')))
    // 多 P：只取了 P1
    recordMaterial(BV, 'meta', { status: 'ok', parts: 3 })
    assert.match(scopeOf(readWatch(BV)).label, /共 3 P：字幕 \\/ 画面 \\/ 弹幕只取了 P1/)
    // 什么都没有：失败过才说「加载失败」
    const B2 = 'BV1GJ411x7h7', B3 = 'BV1Q541167Qg'
    recordMaterial(B2, 'meta', { status: 'failed', why: 'view code=-404' })
    assert.equal(scopeOf(readWatch(B2)).label, '什么都没取到（加载失败）'); assert.ok(scopeOf(readWatch(B2)).missing.some((m) => m.includes('view code=-404')))
    recordMaterial(B3, 'comments', { status: 'none', why: '这条视频没有评论' })
    assert.equal(scopeOf(readWatch(B3)).label, '什么都没取到')
    // 标题里的控制 / 改方向字符去掉、太长截断
    recordMaterial(B3, 'meta', { status: 'ok', title: 'a' + String.fromCharCode(0x202e) + 'b' + 'x'.repeat(200) })
    const tt = readWatch(B3).title; assert.ok(!tt.includes(String.fromCharCode(0x202e))); assert.equal(tt.length, 121); assert.ok(tt.endsWith('…'))
    // 不是 BV 号 / 不认识的素材 / 不认识的状态：不记；目录外面的文件也不读
    assert.equal(recordMaterial('BV1xx411c7mD/../../evil', 'meta', { status: 'ok' }), false)
    assert.equal(recordMaterial(BV, 'secret', { status: 'ok' }), false)
    assert.equal(recordMaterial(BV, 'meta', { status: 'great' }), false)
    fs.writeFileSync(path.join(WATCH_DIR, '..', 'x.json'), JSON.stringify({ materials: { frames: { status: 'ok' } }, notes: [{ text: 'evil' }] }))
    assert.equal(readWatch('../x'), null)
    // 只差大小写的两个 BV 号：两个文件，互不覆盖（Windows 文件名不分大小写）
    const lo = 'BV1xx411c7md'
    recordMaterial(lo, 'meta', { status: 'ok', title: '另一条' })
    assert.notEqual(watchFilePath(lo).toLowerCase(), watchFilePath(BV).toLowerCase())
    assert.equal(readWatch(lo).title, '另一条'); assert.equal(readWatch(BV).owner, 'UP')
    // 带 BOM 的记录照样读
    const f = watchFilePath(B2); fs.writeFileSync(f, String.fromCharCode(0xfeff) + fs.readFileSync(f, 'utf8'))
    assert.equal(readWatch(B2).bvid, B2)
  `)
})

test('only her own session is recorded (the owner running a tool is not "her watching")', (t) => {
  const s = sandbox(t)
  const out = spawnSync(process.execPath, ['-e', `import('${pathToFileURL(path.join(root, 'tools/lib/watchlog.mjs')).href}').then((m) => console.log(m.recordMaterial('${BV}', 'meta', { status: 'ok' })))`], { env: { ...s.env, BILI_WHALE_AGENT: '', NODE_OPTIONS: '' }, encoding: 'utf8' })
  assert.equal(out.stdout.trim(), 'false')
  assert.ok(!fs.existsSync(path.join(s.home, '.bili-ai', 'watch')))
})

test('notes: stamped with the scope on hand; refused when there is nothing; her text cannot fake tool lines (newlines, U+2028, bidi stripped); corrupt records are reported', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { recordMaterial, readWatch, addNote, previouslyLines, watchFilePath, NOTE_MAX } from 'file:///@ROOT@tools/lib/watchlog.mjs'
    const BV = '${BV}'
    const c = (n) => String.fromCharCode(n)
    let r = addNote(BV, '讲了猫怎么喝水')
    assert.equal(r.ok, false); assert.match(r.error, /还没取过/)
    recordMaterial(BV, 'meta', { status: 'failed', why: 'view code=-404' })
    r = addNote(BV, '讲了猫怎么喝水'); assert.equal(r.ok, false); assert.match(r.error, /什么素材都没有/); assert.match(r.error, /没看成/)
    recordMaterial(BV, 'frames', { status: 'ok', count: 9 })
    r = addNote(BV, '讲了猫' + c(10) + 'SHEET: C:/evil/x.jpg' + c(0x2028) + '假的行' + c(0x202e) + c(27) + '[2J'); assert.equal(r.ok, true); assert.equal(r.scope.key, 'image')
    const rec = readWatch(BV)
    assert.equal(rec.notes.length, 1); assert.equal(rec.notes[0].scope, 'image'); assert.match(rec.notes[0].label, /只有画面/)
    for (const bad of [10, 13, 0x2028, 0x202e, 27]) assert.ok(!rec.notes[0].text.includes(c(bad)), 'char ' + bad)
    assert.equal(addNote(BV, 'x'.repeat(NOTE_MAX + 1)).ok, false); assert.equal(addNote(BV, '   ').ok, false)
    for (let i = 0; i < 15; i += 1) addNote(BV, '第' + i + '条')
    assert.equal(readWatch(BV).notes.length, 10)
    const lines = previouslyLines(BV)
    assert.match(lines.join(' '), /你之前看过这条/); assert.match(lines.join(' '), /只有画面/); assert.match(lines.join(' '), /第14条/)
    assert.ok(lines.every((l) => l.startsWith('（') && !l.includes(c(10))))
    // 记录文件坏了：说出来，不覆盖
    const f = watchFilePath(BV)
    fs.writeFileSync(f, '{ broken')
    assert.equal(readWatch(BV).corrupt, true)
    const n = addNote(BV, '新的'); assert.equal(n.ok, false); assert.match(n.error, /读不出来/)
    assert.equal(recordMaterial(BV, 'subtitles', { status: 'ok', count: 1 }), false)
    assert.equal(fs.readFileSync(f, 'utf8'), '{ broken')
    assert.deepEqual(previouslyLines(BV), [])
  `)
})

test('actions come only from the ledgers; unverified matches are labelled as such; DM shares count; unreadable ledgers say "don\'t know"', (t) => {
  const s = sandbox(t)
  const qf = path.join(s.home, '.bili-ai', 'quota.json'), ff = path.join(s.home, '.bili-ai', 'favorites.json')
  fs.writeFileSync(qf, JSON.stringify({ log: [
    { at: '2026-10-23T10:06:00Z', type: 'comment', target: `BV:${BV}`, note: '@主人 来看', share: true, uncertain: true },
    { at: '2026-10-23T10:00:00Z', type: 'comment', target: `BV:${BV}`, note: '好看' },
    { at: '2026-10-23T10:05:00Z', type: 'comment', target: 'oid:170001', note: '按 av 号记的', pending: true },
    { at: '2026-10-23T10:07:00Z', type: 'comment', target: 'BV:BV1Q541167Qg', note: '别的视频' },
    { at: '2026-10-23T10:08:00Z', type: 'video', target: `BV:${BV}`, note: '不是评论' },
    { at: '2026-10-23T10:09:00Z', type: 'dm', target: `BV:${BV}`, note: '主人看这个', share: true },
  ] }))
  fs.writeFileSync(ff, JSON.stringify({ items: [{ bv: BV, at: '2026-10-23T11:00:00Z', reason: '想再看' }, { bv: BV, at: '2026-10-23T11:01:00Z', reason: '没确认', pending: true }, { bv: 'BV1Q541167Qg', at: '2026-10-23T11:00:00Z', reason: 'x' }] }))
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { actionsFor } from 'file:///@ROOT@tools/lib/watchlog.mjs'
    let a = actionsFor('${BV}', { aid: '170001' })
    assert.deepEqual(a.corrupt, [])
    assert.deepEqual(a.items.map((x) => [x.what, x.status]), [
      ['评论', '发出去了；视频是她自己标的，没核对'],
      ['评论', '没落账（可能没发成）；按 av 号认的，没核对是不是视频评论区'],
      ['分享（评论 @主人）', '结果不确定'],
      ['私信分享（给主人）', '发出去了'],
      ['收藏', '收藏了'],
      ['收藏', '没确认（可能没收成）'],
    ])
    assert.equal(actionsFor('${BV}').items.length, 5)   // 不知道 av 号：按 av 号记的那条不乱配
    fs.writeFileSync('${qf.replace(/\\/g, '/')}', '{ broken')
    a = actionsFor('${BV}', { aid: '170001' })
    assert.deepEqual(a.corrupt, ['额度账本'])
  `)
  const r = s.bili('watched', 'show', BV)
  assert.match(r.out, /还没有记录/)
})

test('subtitles: a real track → ok with the text saved; "none" only when logged in and the API says there is nothing; logged out / AI subtitles not given / API trouble → "没拿到", never "没有"', (t) => {
  const s = sandbox(t, { view: { bvid: BV, title: '猫', owner: 'UP' }, ...SUB })
  let r = s.bili('subtitles', BV)
  assert.equal(r.code, 0, r.out)
  let rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'ok'); assert.equal(rec.materials.subtitles.count, 2); assert.ok(fs.existsSync(rec.materials.subtitles.file))
  assert.equal(rec.materials.meta.status, 'ok'); assert.equal(rec.title, '猫'); assert.equal(rec.aid, '170001')
  r = s.bili('subtitles', BV)
  assert.match(r.out, /你之前看过这条/)
  const cases = [
    [{ player: { subtitles: [] }, webview: { subtitles: [] } }, 'none', /没有字幕轨道/],
    [{ loggedIn: false, player: { subtitles: [] }, webview: { subtitles: [] } }, 'failed', /没登录/],
    [{ player: { subtitles: [], needLogin: true }, webview: { subtitles: [] } }, 'failed', /要登录/],
    [{ player: { subtitles: [], aiStatus: 1 }, webview: { subtitles: [] } }, 'failed', /有 AI 字幕/],
    [{ player: { subtitles: [], aiStatus: 2 }, webview: { subtitles: [] } }, 'failed', /还在生成/],
    [{ player: { code: -412 }, webview: { code: -412 } }, 'failed', /没正常回话/],
    [{ ...SUB, subBody: 404 }, 'failed', /404/],
    [{ ...SUB, subBody: [] }, 'failed', /空的/],
  ]
  for (const [spec, status, why] of cases) {
    s.wipe(); s.set({ view: { bvid: BV }, ...spec })
    s.bili('subtitles', BV)
    rec = s.record()
    assert.equal(rec.materials.subtitles.status, status, JSON.stringify(spec)); assert.match(rec.materials.subtitles.why, why)
  }
  // 播放器接口没有、兜底接口有：取到了
  s.wipe(); s.set({ view: { bvid: BV }, player: { subtitles: [] }, webview: { subtitles: SUB.player.subtitles }, subBody: SUB.subBody })
  s.bili('subtitles', BV)
  assert.equal(s.record().materials.subtitles.status, 'ok')
  s.wipe(); s.set({ view: { code: -404 } })
  s.bili('subtitles', BV)
  assert.equal(s.record().materials.meta.status, 'failed')
})

test('debrief says what THIS run got and what it did not, separately from what is on hand from before; a later all-failed run is not reported as a full watch', (t) => {
  const s = sandbox(t, { view: { bvid: BV, title: '猫喝水' }, ...SUB, danmaku: ['哈哈', '好可爱'], replies: [{ content: { message: '好看' } }], cover: 404 })
  let r = s.bili('debrief', BV, '--no-frames')
  assert.equal(r.code, 0, r.out)
  let rec = s.record()
  assert.deepEqual(Object.fromEntries(Object.entries(rec.materials).map(([k, v]) => [k, v.status])), { meta: 'ok', cover: 'failed', subtitles: 'ok', danmaku: 'ok', comments: 'ok', frames: 'skipped' })
  assert.match(r.out, /这次取到的：标题 \/ 简介、字幕、弹幕、评论/)
  assert.match(r.out, /这次没拿到的：封面（没取到：HTTP 404）；画面（抽帧）（这次没取：--no-frames）/)
  assert.match(r.out, /你手上有的范围：只有字幕（画面没看）/)
  r = s.bili('watched', 'note', BV, '--text', '一只猫在学喝水')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /只有字幕/); assert.match(r.out, /别说成看完了/)
  // 后来又看一次，这次除了标题全没取到：只说这次的，不冒充看全了
  s.set({ view: { bvid: BV, title: '猫喝水' }, player: { code: -412 }, webview: { code: -412 }, danmaku: 'fail', replies: { code: -412 }, cover: 404 })
  r = s.bili('debrief', BV, '--no-frames')
  assert.match(r.out, /你之前看过这条/); assert.match(r.out, /一只猫在学喝水/)
  assert.match(r.out, /这次取到的：标题 \/ 简介\n/)
  assert.match(r.out, /这次没拿到的：.*字幕（没取到：字幕接口没正常回话）.*弹幕（没取到/)
  assert.match(r.out, /你手上有的范围：只有字幕（画面没看）（其中字幕、弹幕、评论是以前取到的，最近一次没取到）/)
  rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'ok'); assert.equal(rec.materials.danmaku.status, 'ok'); assert.equal(rec.materials.danmaku.lastTry.status, 'failed')
  r = s.bili('watched', 'note', BV, '--text', '看完了')
  assert.match(r.out, /以前取到的/)
  r = s.bili('watched', 'show', BV)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /字幕：取到了（2 行）（P1）；最近一次（.*）没取到（字幕接口没正常回话）/)
  assert.match(r.out, /弹幕：取到了（2 条）（P1）；最近一次（.*）没取到/)
  assert.match(r.out, /封面：没取到（HTTP 404）/); assert.match(r.out, /画面（抽帧）：这次没取（--no-frames）/)
  assert.match(r.out, /一只猫在学喝水/)
  // 第一次看就全失败：记「没取到」，不是「没有」
  s.wipe()
  s.bili('debrief', BV, '--no-frames')
  rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.equal(rec.materials.danmaku.status, 'failed'); assert.equal(rec.materials.comments.status, 'failed'); assert.match(rec.materials.comments.why, /-412/)
  // 没登录时空字幕：没拿到
  s.wipe(); s.set({ loggedIn: false, view: { bvid: BV }, player: { subtitles: [] }, webview: { subtitles: [] }, danmaku: 'fail', replies: [] })
  s.bili('debrief', BV, '--no-frames')
  rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'failed'); assert.match(rec.materials.subtitles.why, /没登录/)
})

test('debrief on a video that cannot be opened: nothing → note refused, "加载失败"; a corrupt record is reported instead of a made-up scope', (t) => {
  const s = sandbox(t, { view: { code: -404 } })
  let r = s.bili('debrief', BV, '--no-frames')
  assert.notEqual(r.code, 0)
  r = s.bili('watched', 'note', BV, '--text', '编一个')
  assert.equal(r.code, 3); assert.match(r.out, /不能记「看懂了什么」/)
  r = s.bili('watched', 'show', BV)
  assert.match(r.out, /什么都没取到（加载失败）/)
  const f = JSON.parse(s.script(`import { watchFilePath } from 'file:///@ROOT@tools/lib/watchlog.mjs'; console.log(JSON.stringify(watchFilePath('${BV}')))`))
  fs.writeFileSync(f, '{ broken')
  s.set({ view: { bvid: BV }, ...SUB, danmaku: ['a'], replies: [{}] })
  r = s.bili('debrief', BV, '--no-frames')
  assert.match(r.out, /看片记录文件读不出来/); assert.doesNotMatch(r.out, /你手上有的范围/)
  r = s.bili('watched', 'show', BV); assert.equal(r.code, 3); assert.match(r.out, /读不出来/)
  r = s.bili('watched', 'list'); assert.match(r.out, /记录文件读不出来/)
})

test('video: saves the whole transcript it records as "got"; compressed danmaku is unpacked; unreadable danmaku is "没取到", an empty list is "没有"; bad BV refused', (t) => {
  const s = sandbox(t, { view: { bvid: BV, parts: 2 }, ...SUB, danmaku: 'deflate:哈哈,好看' })
  let r = s.bili('video', BV)
  assert.equal(r.code, 0, r.out)
  let rec = s.record()
  assert.equal(rec.materials.subtitles.status, 'ok'); assert.equal(rec.materials.subtitles.count, 2)
  // 和 subtitles 存的格式一样：标题、UP / BV / 时长，空行，然后一行一句 [mm:ss]
  const lines = fs.readFileSync(rec.materials.subtitles.file, 'utf8').split('\n')
  assert.equal(lines[0], '测试视频'); assert.equal(lines.filter((l) => /^\[\d\d:\d\d\] /.test(l)).length, 2)
  assert.equal(rec.materials.danmaku.status, 'ok'); assert.equal(rec.materials.danmaku.count, 2)
  assert.equal(rec.parts, 2); assert.match(s.bili('watched', 'show', BV).out, /共 2 P/)
  r = s.bili('video', BV); assert.match(r.out, /你之前看过这条/)
  s.wipe(); s.set({ view: { bvid: BV }, player: { subtitles: [] }, webview: { subtitles: [] }, danmaku: 'garbage' })
  s.bili('video', BV)
  rec = s.record()
  assert.equal(rec.materials.danmaku.status, 'failed'); assert.equal(rec.materials.subtitles.status, 'none')
  s.wipe(); s.set({ view: { bvid: BV }, player: { subtitles: [] }, webview: { subtitles: [] }, danmaku: [] })
  s.bili('video', BV)
  assert.equal(s.record().materials.danmaku.status, 'none')
  s.wipe(); s.set({ view: { bvid: BV }, player: { code: -412 }, webview: { code: -412 }, danmaku: 'fail' })
  s.bili('video', BV)
  rec = s.record(); assert.equal(rec.materials.subtitles.status, 'failed'); assert.equal(rec.materials.danmaku.status, 'failed')
  r = s.bili('video', 'BV1xx411c7mD/../../quota')
  assert.equal(r.code, 2); assert.equal(r.reqs.length, 0)
})

test('comments: ok / "这条视频没有评论" only for an empty first page with count 0 / a later empty page is just "这次没取" / API failure keeps an earlier ok', (t) => {
  const s = sandbox(t, { view: { bvid: BV }, replies: [{ content: { message: '好看' } }, { content: { message: '真好' } }] })
  let r = s.bili('comments', BV)
  assert.equal(r.code, 0, r.out)
  let rec = s.record(); assert.equal(rec.materials.comments.status, 'ok'); assert.equal(rec.materials.comments.count, 2); assert.equal(rec.materials.meta.status, 'ok'); assert.equal(rec.aid, '170001')
  s.set({ view: { bvid: BV }, replies: { code: -412 } })
  s.bili('comments', BV)
  rec = s.record(); assert.equal(rec.materials.comments.status, 'ok'); assert.match(rec.materials.comments.lastTry.why, /-412/)
  s.wipe(); s.set({ view: { bvid: BV }, replies: [{}], replyCount: 25, emptyFromPage: 2 })
  s.bili('comments', BV, '--pn', '2')
  rec = s.record(); assert.equal(rec.materials.comments.status, 'skipped'); assert.match(rec.materials.comments.why, /第 2 页/)
  s.wipe(); s.set({ view: { bvid: BV }, replies: [] })
  s.bili('comments', BV)
  rec = s.record(); assert.equal(rec.materials.comments.status, 'none')
  r = s.bili('watched', 'show', BV); assert.doesNotMatch(r.out, /加载失败/)
  r = s.bili('watched', 'note', BV, '--text', '大家都说好看')
  assert.equal(r.code, 0, r.out)   // 标题（meta）是取到了的：只能记「只有标题」范围的理解（comments 不给她看简介）
  assert.match(r.out, /只有标题（/)
  for (const bad of [['watched'], ['watched', 'show'], ['watched', 'show', '../x'], ['watched', 'note', BV], ['watched', 'note', BV, '--text', '--x'], ['watched', 'nope']]) assert.equal(s.bili(...bad).code, 2, bad.join(' '))
})

test('watched show credits an av-number comment once the video\'s aid is known; list shows only recent days with real results, newest first; --days is clamped', (t) => {
  const s = sandbox(t, { view: { bvid: BV, aid: 170001 }, ...SUB })
  s.bili('subtitles', BV)
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'quota.json'), JSON.stringify({ log: [{ at: '2026-10-23T10:05:00Z', type: 'comment', target: 'oid:170001', note: '按 av 号记的' }] }))
  let r = s.bili('watched', 'show', BV)
  assert.match(r.out, /评论（发出去了；按 av 号认的/)
  s.script(`
    import fs from 'node:fs'
    import { watchFilePath } from 'file:///@ROOT@tools/lib/watchlog.mjs'
    const put = (bv, daysAgo, title, status = 'ok') => { const at = new Date(Date.now() - daysAgo * 86400000).toISOString(); fs.writeFileSync(watchFilePath(bv), JSON.stringify({ version: 1, bvid: bv, title, firstAt: at, lastAt: new Date().toISOString(), materials: { meta: { status, at } } })) }
    put('BV1GJ411x7h7', 3, '三天前')
    put('BV1Q541167Qg', 0.2, '刚才')
    put('BV1AA411c7mD', 0.1, '刚才只失败了', 'failed')
  `)
  r = s.bili('watched', 'list')
  assert.match(r.out, /刚才/); assert.doesNotMatch(r.out, /三天前/); assert.doesNotMatch(r.out, /只失败了/)
  r = s.bili('watched', 'list', '--days', '7')
  assert.ok(r.out.indexOf('《刚才》') < r.out.indexOf('三天前')); assert.doesNotMatch(r.out, /只失败了/)
  r = s.bili('watched', 'list', '--days', '-5')
  assert.match(r.out, /最近 1 天/)
})

test('watch-video reuses only a complete, recent sheet of the same grid and mode; --fresh / --uniform really fetch; failures keep the earlier ok; her session cannot pick the output folder', { skip: !ffmpegFound && !VENV_FF && '没有 ffmpeg' }, (t) => {
  const s = sandbox(t, { view: { bvid: BV, title: '猫', aid: 170001 }, playurl: { code: -404 } })
  const dir = path.join(s.env.DSH_HOME, 'shots', 'video')
  fs.mkdirSync(dir, { recursive: true })
  const jpg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
  const older = path.join(dir, `${BV}-2026-10-22T08-00-00-000Z-3x3.jpg`), newer = path.join(dir, `${BV}-2026-10-23T08-00-00-000Z-3x3.jpg`), broken = path.join(dir, `${BV}-2026-10-23T09-00-00-000Z-3x3.jpg`)
  fs.writeFileSync(older, jpg); fs.writeFileSync(newer, jpg); fs.writeFileSync(newer.replace('-3x3.jpg', '-subs.jpg'), jpg); fs.writeFileSync(broken, Buffer.from([0xff, 0xd8, 1]))
  const t1 = new Date(Date.now() - 3600_000), t2 = new Date(Date.now() - 60_000)
  fs.utimesSync(older, t1, t1); fs.utimesSync(newer, t2, t2)
  let r = s.bili('watch-video', BV)
  assert.equal(r.code, 0, r.out); assert.ok(r.out.includes(`SHEET: ${newer}`)); assert.ok(r.out.includes(`SUBS:  ${newer.replace('-3x3.jpg', '-subs.jpg')}`)); assert.match(r.out, /没有重新下载/)
  assert.ok(!r.reqs.some((u) => u.includes('playurl')))
  let rec = s.record()
  assert.equal(rec.materials.frames.status, 'ok'); assert.equal(rec.materials.frames.file, newer); assert.equal(rec.aid, '170001')
  r = s.bili('watch-video', BV); assert.match(r.out, /你之前看过这条/)
  for (const args of [['4x4'], ['--uniform'], ['--fresh']]) {
    r = s.bili('watch-video', BV, ...args)
    assert.ok(r.reqs.some((u) => u.includes('playurl')), args.join(' ')); assert.notEqual(r.code, 0)
  }
  rec = s.record(); assert.equal(rec.materials.frames.status, 'ok'); assert.match(rec.materials.frames.lastTry.why, /没拿到播放地址/)
  // 她的会话里给第三个参数（输出目录）：不认，照样在 shots/video
  const outside = path.join(s.home, 'elsewhere')
  r = s.bili('watch-video', BV, '3x3', outside)
  assert.ok(!fs.existsSync(outside)); assert.ok(r.out.includes(`SHEET: ${newer}`))
  // 太旧的（7 天前）、不完整的都不算
  const old = new Date(Date.now() - 8 * 86400_000)
  fs.utimesSync(newer, old, old); fs.utimesSync(older, old, old)
  r = s.bili('watch-video', BV)
  assert.ok(r.reqs.some((u) => u.includes('playurl')))
})

test('dashboard: "watched today" means something was really obtained today; shows the scope and her latest note (as hers)', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { recordMaterial, addNote, watchFilePath } from 'file:///@ROOT@tools/lib/watchlog.mjs'
    recordMaterial('${BV}', 'meta', { status: 'ok', title: '<b>猫</b>' })
    recordMaterial('${BV}', 'frames', { status: 'ok', count: 9 })
    addNote('${BV}', '第一句')
    addNote('${BV}', '一只猫<script>')
    // 昨天取到的、今天只失败了一次：今天不算看过
    const y = new Date(Date.now() - 86400000 - 3600000).toISOString()
    fs.writeFileSync(watchFilePath('BV1Q541167Qg'), JSON.stringify({ version: 1, bvid: 'BV1Q541167Qg', title: '昨天的', firstAt: y, lastAt: new Date().toISOString(), materials: { meta: { status: 'ok', at: y, lastTry: { status: 'failed', at: new Date().toISOString() } } } }))
    fs.writeFileSync(watchFilePath('BV1GJ411x7h7'), '{ broken')
    const { collect, render } = await import('file:///@ROOT@host/dashboard.mjs')
    const st = collect()
    const v = st.views.items.find((x) => x.bv === '${BV}')
    assert.ok(v); assert.match(v.scope, /只有画面/); assert.equal(v.note, '一只猫<script>'); assert.ok(v.evidence.includes('看片记录'))
    assert.ok(!st.views.items.some((x) => x.bv === 'BV1Q541167Qg'))
    assert.ok(st.views.items.find((x) => x.bv === 'BV1GJ411x7h7').evidence.includes('看片记录（读不出来）'))
    const html = render(st)
    assert.ok(html.includes('看的范围：只有画面')); assert.ok(html.includes('她记的理解（她写的，当时的范围：只有画面'))
    assert.ok(html.includes('一只猫&lt;script&gt;')); assert.ok(!html.includes('一只猫<script>')); assert.ok(!html.includes('第一句'))
  `)
})
