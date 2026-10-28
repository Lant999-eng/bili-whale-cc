// 换装（2026-10-24）：立绘放 sprites/<换装>/<表情>.png，profile.json 的 outfit 是默认，她在剧本里 "outfit": {"<角色 id>": "<换装>"} 按视频换。
// 这里不跑真 Python（studio.py 那半边在 tests/helpers/studio_units.py 和 studio.test.mjs「outfit render」，设 STUDIO_TEST_PYTHON 才跑）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))

const CHANNEL = '# 频道设定\n## 和已有的 AI UP 主有什么不同\n我只讲自己每天真实遇到的事，不做比赛和测评。\n'
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')   // 列表只看文件名，不解码图片

/** 和 hardening.test.mjs 一样的沙盒；fakePy = 把 node 链成 venv 的 python.exe，studio.py 由 helpers/fake-studio-py.mjs 冒充 */
function sandbox(t, { fakePy = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-outfit-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data')
  fs.mkdirSync(path.join(dsh, 'whale-work'), { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'Whale' }, notify: { type: 'none' }, studio: { host: 'star' } }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32) }))
  const venv = path.join(home, 'venv')
  const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  fs.mkdirSync(path.dirname(py), { recursive: true })
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_STUDIO_VENV: venv, BILI_WHALE_ORIGINALITY_OFFLINE: '1' }
  delete env.BILI_WHALE_AGENT
  if (fakePy) {
    try { fs.linkSync(process.execPath, py) } catch { fs.copyFileSync(process.execPath, py) }
    if (process.platform !== 'win32') fs.chmodSync(py, 0o755)
    env.NODE_OPTIONS = '--import=' + pathToFileURL(path.join(root, 'tests/helpers/fake-studio-py.mjs')).href
  } else fs.writeFileSync(py, '')
  fs.writeFileSync(path.join(dsh, 'whale-work', 'channel.md'), CHANNEL)
  fs.writeFileSync(path.join(home, '.bili-ai/channel-approved.json'), JSON.stringify({ sha: crypto.createHash('sha256').update(CHANNEL).digest('hex'), at: 't' }))
  const agent = { ...env, BILI_WHALE_AGENT: '1', BILI_WHALE_AI_HOME: path.join(dsh, 'whale-work') }
  return { env, agent, dsh, home, work: path.join(dsh, 'whale-work'), cast: path.join(dsh, 'cast') }
}
const run = (file, args, env) => spawnSync(process.execPath, [path.join(root, file), ...args], { env, encoding: 'utf8', timeout: 30000 })
const studio = (s, args, env = s.agent) => run('tools/bili.mjs', ['studio', ...args], env)
const cli = (s, args) => run('host/cli.mjs', args, s.env)
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const png = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, PNG) }

/** 测试角色：白裙（默认）/ 黑裙 两套，加上几样不该算换装的目录；妹妹：老的平铺立绘 */
function dressUp(s, prof = { name: '测试角色', outfit: '白裙' }) {
  const sp = path.join(s.cast, 'star', 'sprites')
  for (const e of ['neutral', '浅笑', '困']) png(path.join(sp, '白裙', `${e}.png`))
  png(path.join(sp, '白裙', '说话', 'neutral.png'))      // 说话版不是表情
  for (const e of ['neutral', '浅笑']) png(path.join(sp, '黑裙', `${e}.png`))
  png(path.join(sp, '说话', 'neutral.png'))               // 「说话」不是一套换装
  fs.mkdirSync(path.join(sp, '空的'), { recursive: true })  // 没有 png 的不算
  png(path.join(sp, 'a.b', 'neutral.png'))                // 名字不合法的不算
  const outside = path.join(s.home, 'outside'); png(path.join(outside, 'neutral.png'))
  let linked = true
  try { fs.symlinkSync(outside, path.join(sp, '外面'), 'junction') } catch { linked = false }   // 链接 / 联接出去的目录不算
  fs.writeFileSync(path.join(s.cast, 'star', 'profile.json'), JSON.stringify(prof))
  for (const e of ['neutral', 'happy']) png(path.join(s.cast, 'meimei', 'sprites', `${e}.png`))
  fs.writeFileSync(path.join(s.cast, 'meimei', 'profile.json'), JSON.stringify({ name: '妹妹' }))
  return { sp, linked }
}

test('outfits: studio cast lists each outfit with its expressions; talking variants, 说话, empty, linked and badly named folders are not outfits; the flat layout still works', (t) => {
  const s = sandbox(t)
  const { linked } = dressUp(s)
  const r = studio(s, ['cast'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /star（主角） · 测试角色/)
  assert.match(r.stdout, /换装：白裙（默认） \/ 黑裙 —— 剧本里写 "outfit": \{"star": "黑裙"\}/)
  assert.match(r.stdout, /白裙：neutral \/ 困 \/ 浅笑/)
  assert.match(r.stdout, /黑裙：neutral \/ 浅笑/)
  for (const x of ['空的', 'a.b', '外面']) assert.doesNotMatch(r.stdout, new RegExp(x.replace('.', '\\.')), x)
  assert.doesNotMatch(r.stdout, /说话[：（]/)
  assert.match(r.stdout, /meimei · 妹妹[\s\S]*表情：happy \/ neutral/)
  assert.ok(linked || process.platform !== 'win32', 'Windows 上建联接不需要管理员权限')
  const l = cli(s, ['cast', 'list'])
  assert.match(l.stdout, /star · 测试角色 .*表情 neutral\/困\/浅笑 · 换装 白裙（默认） \/ 黑裙/)
  assert.match(l.stdout, /meimei · 妹妹 .*表情 happy\/neutral(?! · 换装)/)
})

test('cast outfit: shows the outfits, sets the default atomically, refuses unknown names / 说话 / a broken profile; a BOM in profile.json is fine', (t) => {
  const s = sandbox(t)
  dressUp(s, { name: '测试角色', outfit: '白裙', voice: 'v1', tts: 'voxcpm' })
  const prof = path.join(s.cast, 'star', 'profile.json')
  let r = cli(s, ['cast', 'outfit', 'star'])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /★ 白裙：neutral \/ 困 \/ 浅笑（说话版 1 张）/); assert.match(r.stdout, /  黑裙：neutral \/ 浅笑/)
  r = cli(s, ['cast', 'outfit', 'star', '黑裙'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /默认换装改成「黑裙」/)
  assert.deepEqual(readJ(prof), { name: '测试角色', outfit: '黑裙', voice: 'v1', tts: 'voxcpm' })
  assert.deepEqual(fs.readdirSync(path.dirname(prof)).filter((f) => f.endsWith('.tmp')), [])
  assert.match(studio(s, ['cast']).stdout, /换装：白裙 \/ 黑裙（默认）/)
  for (const bad of ['外面', '说话', '空的', '格子裙', '../outside']) {
    r = cli(s, ['cast', 'outfit', 'star', bad])
    assert.equal(r.status, 2, bad); assert.match(r.stdout + r.stderr, /没有「/, bad)
    assert.equal(readJ(prof).outfit, '黑裙', bad)
  }
  fs.writeFileSync(prof, String.fromCharCode(0xfeff) + JSON.stringify({ name: '测试角色', outfit: '黑裙' }))   // 记事本存的
  assert.match(studio(s, ['cast']).stdout, /star（主角） · 测试角色/)
  r = cli(s, ['cast', 'outfit', 'star', '白裙']); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readJ(prof).outfit, '白裙')
  fs.writeFileSync(prof, '{"name": "测试角色", oops')
  r = cli(s, ['cast', 'outfit', 'star', '黑裙'])
  assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /读不出来/); assert.equal(fs.readFileSync(prof, 'utf8'), '{"name": "测试角色", oops')
  assert.match(cli(s, ['cast', 'outfit', 'meimei']).stdout, /还没有换装/)
})

test('render: her script picks an outfit; an unknown outfit / character / shape refuses before python; the choice reaches the receipt, the review queue and the owner\'s videos list', (t) => {
  const s = sandbox(t, { fakePy: true })
  dressUp(s)
  const r0 = studio(s, ['new', '--title', '换装测试'])
  assert.equal(r0.status, 0, r0.stderr)
  const id = r0.stdout.match(/新作品 (\S+)/)[1]
  const f = path.join(s.work, 'studio', id, 'script.json')
  const base = { ...readJ(f), tid: 201, scenes: [{ bg_prompt: 'x', lines: [{ text: '今天醒来的时候，窗外在下雨。', expr: '浅笑' }] }] }
  const rec = path.join(s.home, 'render-cfg.json')
  const render = (outfit) => {
    const sc = { ...base }; if (outfit === undefined) delete sc.outfit; else sc.outfit = outfit
    fs.writeFileSync(f, JSON.stringify(sc)); fs.rmSync(rec, { force: true })
    return run('tools/bili.mjs', ['studio', 'render', id], { ...s.agent, FAKE_RECORD_CONFIG: rec })
  }
  for (const [outfit, why] of [[{ star: '外面' }, /角色 star 没有「外面」这套换装（有：白裙、黑裙/], [{ star: '说话' }, /没有「说话」/], [{ nobody: '黑裙' }, /outfit 里的角色「nobody」不在角色表里/],
    ['黑裙', /outfit 必须是对象/], [['黑裙'], /outfit 必须是对象/], [{ star: 3 }, /outfit\.star 必须是换装名/]]) {
    const r = render(outfit)
    assert.notEqual(r.status, 0, JSON.stringify(outfit)); assert.match(r.stdout + r.stderr, why, JSON.stringify(outfit))
    assert.ok(!fs.existsSync(rec), '写错了就不起 studio.py')
  }
  // 主人那边的默认换装没了：剧本里没指定这个角色就拦下（说清楚是主人的事），指定了就照常
  const prof = path.join(s.cast, 'star', 'profile.json')
  fs.writeFileSync(prof, JSON.stringify({ name: '测试角色', outfit: '格子裙' }))
  let r = render(undefined)
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /默认换装「格子裙」不在 sprites\/ 里.*这要主人来弄/); assert.ok(!fs.existsSync(rec))
  r = render({ star: '黑裙' }); assert.equal(r.status, 0, r.stdout + r.stderr)
  fs.writeFileSync(prof, JSON.stringify({ name: '测试角色', outfit: '白裙' }))
  r = render({ star: '黑裙' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /换装 star 穿黑裙/)
  assert.deepEqual(readJ(path.join(s.home, '.bili-ai', 'renders', `${id}.json`)).outfits, { star: '黑裙' })
  r = studio(s, ['submit', id, '--reason', '这是一条很有意思的视频'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const pend = readJ(path.join(s.home, '.bili-ai', 'pending-videos.json'))
  const item = (Array.isArray(pend) ? pend : pend.items).find((x) => x.id === id)
  assert.deepEqual(item.outfits, { star: '黑裙' })
  assert.match(cli(s, ['videos']).stdout, /换装：star 穿黑裙/)
})

test('studio new: the template offers the outfit field and only uses expression names the main character really has', (t) => {
  const s = sandbox(t)
  dressUp(s)
  for (const format of ['diary', 'dialogue', 'explainer']) {
    const r = studio(s, ['new', '--format', format, '--title', '模板测试' + format])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /star（测试角色；表情 neutral\/困\/浅笑；换装 白裙（默认） \/ 黑裙）/)
    const sc = readJ(path.join(s.work, 'studio', r.stdout.match(/新作品 (\S+)/)[1], 'script.json'))
    // 只给提示、不预先填 outfit：不写就穿主人定的默认（主人以后改默认，草稿也跟着变）
    assert.equal(sc.outfit, undefined); assert.match(sc._outfit_hint, /star 有 白裙（默认） \/ 黑裙。要换就加 "outfit": \{"star": "黑裙"\}/)
    const exprs = sc.scenes.flatMap((x) => x.lines.filter((l) => (l.who ?? 'star') === 'star').map((l) => l.expr)).filter(Boolean)
    assert.ok(exprs.length && exprs.every((e) => ['neutral', '困', '浅笑'].includes(e)), JSON.stringify(exprs))
  }
})

test('render pre-check (review fixes): an object as the outfit name fails cleanly; a broken default only blocks videos that character is in', (t) => {
  const s = sandbox(t, { fakePy: true })
  dressUp(s)
  png(path.join(s.cast, 'meimei', 'sprites', '白裙', 'neutral.png'))
  fs.writeFileSync(path.join(s.cast, 'meimei', 'profile.json'), JSON.stringify({ name: '妹妹', outfit: '格子裙' }))   // 主人给妹妹定的默认换装不存在
  const r0 = studio(s, ['new', '--title', '换装检查'])
  const id = r0.stdout.match(/新作品 (\S+)/)[1]
  const f = path.join(s.work, 'studio', id, 'script.json')
  const render = (extra, lines = [{ text: '今天醒来的时候，窗外在下雨。' }]) => {
    fs.writeFileSync(f, JSON.stringify({ ...readJ(f), outfit: undefined, ...extra, tid: 201, scenes: [{ bg_prompt: 'x', lines }] }))
    return run('tools/bili.mjs', ['studio', 'render', id], s.agent)
  }
  for (const bad of [{ toString: 1 }, { valueOf: 1, toString: 'a' }, ['黑裙'], 3]) {
    const r = render({ outfit: { star: bad } })
    assert.equal(r.status, 2, JSON.stringify(bad) + r.stderr); assert.match(r.stderr, /outfit\.star 必须是换装名/); assert.doesNotMatch(r.stderr, /TypeError/)
  }
  let r = render({})
  assert.equal(r.status, 0, '妹妹不出场：她的默认换装坏了也不拦 ' + r.stdout + r.stderr)
  r = render({}, [{ text: '今天醒来的时候，窗外在下雨。' }, { who: 'meimei', text: '姐姐早。' }])
  assert.notEqual(r.status, 0); assert.match(r.stderr, /妹妹：默认换装「格子裙」不在 sprites\/ 里.*这要主人来弄/)
  r = render({ outfit: { meimei: '白裙' } }, [{ who: 'meimei', text: '姐姐早。' }])
  assert.equal(r.status, 0, '剧本指定了就不看默认 ' + r.stdout + r.stderr)
})

test('owner side (review fixes): leftover flat PNGs are flagged, folders without usable PNGs are not outfits, --clear goes back, cast add / cast voice keep a BOM profile and refuse a broken one', (t) => {
  const s = sandbox(t)
  const { sp } = dressUp(s, { name: '测试角色', outfit: '白裙', tts: 'voxcpm', voxcpm: { ref: 'voice.wav', ref_text: '嗯。' }, desc: '短发' })
  png(path.join(sp, 'neutral.png'))                 // 搬家剩下的平铺立绘
  png(path.join(sp, '备用', '立绘 (1).png'))         // 只有名字不合法的图：不算一套换装
  png(path.join(sp, '黑裙', 'Neutral.png'))          // 大小写不同（Windows 上就是 neutral.png）
  let r = cli(s, ['cast', 'list'])
  assert.match(r.stdout + r.stderr, /star：sprites\/ 下平铺的 neutral 用不上了/); assert.doesNotMatch(r.stdout, /备用/)
  assert.match(studio(s, ['cast']).stdout, /换装：白裙（默认） \/ 黑裙/)
  const prof = path.join(s.cast, 'star', 'profile.json')
  const before = { name: '测试角色', outfit: '白裙', tts: 'voxcpm', voxcpm: { ref: 'voice.wav', ref_text: '嗯。' }, desc: '短发' }
  fs.writeFileSync(prof, String.fromCharCode(0xfeff) + JSON.stringify(before))   // 记事本存的
  r = cli(s, ['cast', 'add', 'star', '--color', '#112233'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(readJ(prof), { ...before, color: '#112233' })
  fs.writeFileSync(prof, String.fromCharCode(0xfeff) + JSON.stringify(before))
  r = cli(s, ['cast', 'voice', 'star', '--provider', 'edge', '--use', 'zh-CN-XiaoyiNeural'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const after = readJ(prof); assert.equal(after.tts, 'edge'); assert.equal(after.outfit, '白裙'); assert.equal(after.desc, '短发')
  for (const args of [['cast', 'add', 'star', '--color', '#000000'], ['cast', 'voice', 'star', '--provider', 'edge', '--use', 'zh-CN-XiaoyiNeural'], ['cast', 'outfit', 'star', '--clear']]) {
    fs.writeFileSync(prof, '{"name": "测试角色", oops')
    r = cli(s, args)
    assert.equal(r.status, 2, args.join(' ')); assert.match(r.stdout + r.stderr, /读不出来/); assert.equal(fs.readFileSync(prof, 'utf8'), '{"name": "测试角色", oops', args.join(' '))
  }
  fs.writeFileSync(prof, JSON.stringify({ name: '测试角色', outfit: '白裙' }))
  r = cli(s, ['cast', 'outfit', 'star', '--clear'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(readJ(prof), { name: '测试角色' })
  assert.match(cli(s, ['cast', 'outfit', 'star']).stdout, /★ 白裙/)   // 不指定默认：排第一的那套
})
