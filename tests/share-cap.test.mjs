// @ 主人不设条数上限、够分就能发（2026-10-25 主人定）：
// - quota.shareDaily = 0 是不限（以前 0 = 一条也不发、最多 20）；写坏了按默认 3
// - 沉默衰减保留：不限的时候从默认的 3 条往下降，7 天停
// - share.topOnly = false：一轮里每条够分的都能发（--rank 可以不写）；默认还是只发第一名，写坏了也按只发第一名
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { moduleInstalled } from '../host/modules.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const href = (p) => pathToFileURL(path.join(root, p)).href
const C = await import(href('tools/lib/config.mjs'))
const S = await import(href('tools/lib/share-policy.mjs'))
const P = await import(href('tools/lib/prefs.mjs'))

function sandbox(t, cfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-sharecap-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'portable/profile')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfgFile = path.join(dsh, 'bili-whale.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, listen: { comment: false, dm: false, live: false }, ...cfg }))
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile, BILI_WHALE_AGENT: '1' }
  const write = (name, data) => fs.writeFileSync(path.join(home, '.bili-ai', name), JSON.stringify(data))
  const quota = (args) => spawnSync(process.execPath, [path.join(root, 'tools/commands/quota.mjs'), ...args], { env, encoding: 'utf8', timeout: 20000 })
  const script = (code) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code.replaceAll('@CORE@', href('host/core.mjs'))], { env: { ...env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout
  }
  return { home, cfgFile, env, write, quota, script }
}
const shares = (n, daysAgo = 0) => Array.from({ length: n }, (_, i) => ({ at: new Date(Date.now() - daysAgo * 864e5).toISOString(), type: 'comment', share: true, auto: true, target: 'BVold' + i }))
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString()
// 公开版没装 QQ 模块：配置里的 qq 是核心不认识的一段 —— 改别的照样能存、不提它、原样留着；config set qq.… 一律「不认识的设置」
const QQ = moduleInstalled('qq')

test('shareDailyOf: 0 (or negative) is unlimited, numbers are caps, anything else is the default 3', () => {
  for (const v of [0, '0', -1, '-3', 0.4]) assert.equal(C.shareDailyOf(v), Infinity, String(v))
  assert.equal(C.shareDailyOf(5), 5); assert.equal(C.shareDailyOf('7'), 7); assert.equal(C.shareDailyOf(2.9), 2); assert.equal(C.shareDailyOf(50), 50)
  for (const v of [undefined, null, '', ' ', '3条', true, [], {}, NaN]) assert.equal(C.shareDailyOf(v), 3, String(v))
  assert.equal(C.capText(Infinity), '不限'); assert.equal(C.capText(3), '3')
})

test('unlimited daily shares: 25 already today and the 26th still passes; the same video within 7 days is still refused', (t) => {
  const s = sandbox(t, { quota: { shareDaily: 0 } })
  s.write('feedback.json', { last: ago(0), events: [] })
  s.write('quota.json', { log: shares(25) })
  let r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /分享额度内（25\/不限）/)
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVold3'])
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /7 天内已经分享过了/)
  r = s.quota(['status'])
  assert.match(r.stdout, /分享型\*\* 25\/不限/); assert.match(r.stdout, /每天不限条数/)
})

test('silence decay is kept when unlimited: 4 quiet days → at most 2 a day, 7+ days → none, a fresh reaction → unlimited again', (t) => {
  const s = sandbox(t, { quota: { shareDaily: 0 } })
  s.write('quota.json', { log: shares(2) })
  s.write('feedback.json', { last: ago(4), events: [] })
  let r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /分享上限 不限 → 2/); assert.match(r.stdout + r.stderr, /有效上限 2/)
  s.write('quota.json', { log: shares(1) })
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  r = s.quota(['silence'])
  assert.match(r.stdout, /分享上限 不限 → 2/); assert.doesNotMatch(r.stdout, /NaN|Infinity/)
  s.write('feedback.json', { last: ago(8), events: [] })
  s.write('quota.json', { log: [] })
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /已停止分享/)
  s.write('feedback.json', { last: ago(0), events: [] })
  s.write('quota.json', { log: shares(9) })
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /沉默衰减/)
  // 有上限的老规矩不变：3 条，第 4 条拦下
  const s3 = sandbox(t, { quota: { shareDaily: 3 } })
  s3.write('feedback.json', { last: ago(0), events: [] }); s3.write('quota.json', { log: shares(3) })
  r = s3.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /有效上限 3/)
})

test('topOnly: default and broken values keep "rank 1 only"; false lets every video that reaches the threshold be shared', () => {
  const ok = { reason: '这是一条值得分享的视频理由', score: 12 }
  for (const cfg of [{}, { share: { topOnly: true } }, { share: { topOnly: 'false' } }, { share: { topOnly: 0 } }]) {
    assert.equal(S.topOnly(cfg), true, JSON.stringify(cfg))
    assert.throws(() => S.validateShare({ ...cfg, share: { ...cfg.share, minScore: 10 } }, { ...ok, rank: 2 }), /只允许 --rank 1/)
  }
  const free = { share: { enabled: true, minScore: 10, topOnly: false } }
  assert.equal(S.topOnly(free), false)
  assert.equal(S.validateShare(free, { ...ok, rank: 2 }).rank, 2)
  assert.equal(S.validateShare(free, { ...ok, rank: '3' }).rank, 3)
  assert.equal(S.validateShare(free, { ...ok, rank: undefined }).rank, 1)
  assert.equal(S.validateShare(free, { reason: ok.reason, score: 12 }).rank, 1)
  for (const bad of [0, -1, 1.5, 'x', true]) assert.throws(() => S.validateShare(free, { ...ok, rank: bad }), /要是名次/, String(bad))
  assert.throws(() => S.validateShare(free, { ...ok, score: 9, rank: 2 }), /未达到阈值 10/, 'the threshold still applies')
  assert.throws(() => S.validateShare({ share: { enabled: false, topOnly: false } }, { ...ok, rank: 2 }), /分享已关闭/)
  assert.match(S.scoreCardLines(free).join('\n'), /≥ 10 就可以发.*每条够分的都可以 @ 主人/)
  assert.match(S.scoreCardLines({ share: { minScore: 10 } }).join('\n'), /≥ 10 才发，只发这一轮的第一名/)
})

test('config set: shareDaily 0 / 不限 / any whole number; topOnly only true or false; status says 不限', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig, status } from '@CORE@'
    let r = setConfigPath('quota.shareDaily', '0')
    assert.equal(r.ok, true, r.error); assert.equal(readConfig().quota.shareDaily, 0); assert.match(r.warn, /不设条数上限/)
    assert.equal(status().sharesMax, null)
    assert.equal(setConfigPath('quota.shareDaily', '50').ok, true); assert.equal(readConfig().quota.shareDaily, 50, 'no more silent cap at 20')
    assert.equal(status().sharesMax, 50)
    assert.equal(setConfigPath('quota.shareDaily', '不限').ok, true); assert.equal(readConfig().quota.shareDaily, 0)
    assert.equal(setConfigPath('quota.shareDaily', '2.7').ok, true); assert.equal(readConfig().quota.shareDaily, 2)
    for (const bad of ['abc', 'true', '[]']) { r = setConfigPath('quota.shareDaily', bad); assert.equal(r.ok, false, bad); assert.match(r.error, /0 或正整数/) }
    assert.equal(readConfig().quota.shareDaily, 2)
    r = setConfigPath('night.skipChance', '0.2'); assert.equal(r.warn ?? null, null, 'no share-cap nagging on unrelated changes')
    assert.equal(setConfigPath('share.topOnly', 'false').ok, true); assert.equal(readConfig().share.topOnly, false)
    for (const bad of ['no', '0', '"false"']) { r = setConfigPath('share.topOnly', bad); assert.equal(r.ok, false, bad); assert.match(r.error, /true（只发第一名）或 false/) }
    assert.equal(readConfig().share.topOnly, false)
  `)
  // 手改坏了的：不挡别的设置，按默认 3 存、提醒；topOnly 写坏了只提醒（按只发第一名算）
  const cur = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...cur, quota: { ...cur.quota, shareDaily: '3条' }, share: { ...cur.share, topOnly: 'nope' } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.3')
    assert.equal(r.ok, true, r.error)
    assert.match(r.warn, /quota.shareDaily 不是数字（3条）/); assert.match(r.warn, /share.topOnly 不是 true \\/ false/)
    assert.equal(readConfig().quota.shareDaily, 3)
  `)
})

// ───────── 第二轮审查（2026-10-25）─────────

test('round 2: broken silentAfterDays / silentStopDays fall back to 3 / 7 instead of turning every daily cap off; config set refuses them', (t) => {
  for (const bad of [{ silentAfterDays: '3天' }, { silentAfterDays: {} }, { silentStopDays: 'abc' }]) {
    const s = sandbox(t, { quota: { shareDaily: 3 }, share: { enabled: true, minScore: 10, ...bad } })
    s.write('feedback.json', { last: ago(0), events: [] })
    s.write('quota.json', { log: shares(10) })
    let r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
    assert.equal(r.status, 2, JSON.stringify(bad) + ' ' + r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /有效上限 3/)
    // 沉默 8 天：照样停（以前 NaN 一路算下去，照发）
    s.write('feedback.json', { last: ago(8), events: [] }); s.write('quota.json', { log: [] })
    r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
    assert.equal(r.status, 2, JSON.stringify(bad) + ' ' + r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /已停止分享/)
  }
  // 最后一次表态的时间读不出来：按「已经停了」算，不当成不限
  const g = sandbox(t, { quota: { shareDaily: 0 } })
  g.write('feedback.json', { last: 'garbage', events: [] }); g.write('quota.json', { log: [] })
  const r = g.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.doesNotMatch(r.stdout + r.stderr, /分享额度内/)
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    for (const [k, v] of [['share.silentAfterDays', '3天'], ['share.silentStopDays', 'abc'], ['share.silentAfterDays', '-1']]) {
      const r = setConfigPath(k, v); assert.equal(r.ok, false, k + '=' + v); assert.match(r.error, /0 或正整数（天）/)
    }
    assert.equal(setConfigPath('share.silentAfterDays', '5').ok, true); assert.equal(readConfig().share.silentAfterDays, 5)
  `)
})

test('round 2: the wake prompt tells her the owner\'s actual share rules (no hardcoded 第一名 / ≤3 / --rank 1), and when sharing is off', (t) => {
  const render = (cfg) => {
    const s = sandbox(t, cfg)
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { wakePrompt } from ${JSON.stringify(href('lib/scheduler.js'))}; console.log(wakePrompt({ atText: 'x' }, '', 5))`], { env: { ...s.env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const free = render({ quota: { shareDaily: 0 }, share: { enabled: true, via: 'comment', minScore: 10, topOnly: false } })
  assert.match(free, /每条够分的都可以分享（--rank 可以不写）/)
  assert.match(free, /≥ 10 分才发/)
  assert.match(free, /每天不限条数/)
  assert.doesNotMatch(free, /只对第一名|≤3\/天|--rank 1/)
  const old = render({ quota: { shareDaily: 3 }, share: { enabled: true, via: 'comment', minScore: 13 } })
  assert.match(old, /只对第一名考虑分享（--rank 1）/); assert.match(old, /≤3\/天/); assert.match(old, /--rank 1/); assert.match(old, /≥ 13 分才发/)
  for (const share of [{ enabled: 'off', via: 'comment' }, { enabled: false, via: 'dm' }]) assert.match(render({ share }), /分享已关闭/, JSON.stringify(share))
  assert.match(render({ share: false }), /分享已关闭/)
  // 沉默停分享的天数照配置（以前写死 7 天）
  const s = sandbox(t, { share: { enabled: true, silentAfterDays: 1, silentStopDays: 2 } })
  s.write('feedback.json', { last: ago(3), events: [] })
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { wakePrompt } from ${JSON.stringify(href('lib/scheduler.js'))}; console.log(wakePrompt({ atText: 'x' }, '', 5))`], { env: { ...s.env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /3 天没有主人的表态 → \*\*今天不分享\*\*/)
})

test('round 2: owner-facing texts never print Infinity; silence --json tells unlimited apart from broken', (t) => {
  const s = sandbox(t, { quota: { shareDaily: 0 } })
  s.write('feedback.json', { last: ago(0), events: [] }); s.write('quota.json', { log: [] })
  const env = { ...s.env, BILI_WHALE_AGENT: '' }
  let r = spawnSync(process.execPath, [path.join(root, 'tools/commands/quota.mjs'), 'react', '--note', 'test'], { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /分享上限回到 不限/); assert.doesNotMatch(r.stdout, /Infinity|NaN/)
  r = spawnSync(process.execPath, [path.join(root, 'tools/commands/quota.mjs'), 'silence', '--json'], { env, encoding: 'utf8', timeout: 20000 })
  const j = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.equal(j.unlimited, true); assert.equal(j.cap, null)
  assert.equal(C.capText(NaN), '?')
})

test('round 2: config edge cases never turn sharing on by accident', (t) => {
  const s = sandbox(t)
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { setConfigPath, readConfig, CFG_FILE } from '@CORE@'
    // 只查表里自己的键：constructor / __proto__ 这种不是开关
    assert.equal(setConfigPath('share.enabled', 'false').ok, true)
    for (const v of ['constructor', '__proto__', 'toString']) {
      const r = setConfigPath('share.enabled', v); assert.equal(r.ok, false, v); assert.match(r.error, /true（开）或 false（关）/)
      assert.equal(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).share.enabled, false, v)
    }
  `)
  // share 整段写坏了，整段设一组（config set share '{...}'）：从「默认值 + 关着」开始；刚打开时提醒不说「先关着」
  const base = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, share: false }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    let r = setConfigPath('share', '{"minScore":10}')
    assert.equal(r.ok, true, r.error); assert.equal(readConfig().share.enabled, false); assert.match(r.warn, /分享先关着/)
    r = setConfigPath('share.enabled', 'true')
    assert.equal(r.ok, true, r.error); assert.equal(readConfig().share.enabled, true)
    assert.doesNotMatch(r.warn ?? '', /分享先关着/)
  `)
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, share: false }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('share.enabled', 'true')
    assert.equal(r.ok, true, r.error); assert.equal(readConfig().share.enabled, true)
    assert.doesNotMatch(r.warn ?? '', /分享先关着/, 'the owner just turned it on')
  `)
  // 别的段写坏了（studio / night / krita / notify / qq）：不挡、不崩 config set share.enabled false
  for (const broken of [{ studio: false }, { night: null }, { krita: null }, { notify: 'none' }, { qq: 'x' }, { studio: { voxcpm: 'x' } }]) {
    fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, share: { enabled: true }, ...broken }))
    s.script(`
      import assert from 'node:assert/strict'
      import { setConfigPath, readConfig } from '@CORE@'
      const r = setConfigPath('share.enabled', 'false')
      assert.equal(r.ok, true, ${JSON.stringify(JSON.stringify(broken))} + ' ' + r.error)
      assert.equal(readConfig().share.enabled, false)
    `)
  }
  // 文件里没有这一段时，第一次设的坏值也要报错（以前改到了内置默认值上，比较不出变化，坏值照存）
  fs.writeFileSync(s.cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig, DEFAULTS } from '@CORE@'
    for (const [k, v] of [['share.minScore', 'abc'], ['share.topOnly', 'nope'], ['preferences.like', '{"a":1}']]) {
      const r = setConfigPath(k, v); assert.equal(r.ok, false, k + '=' + v)
    }
    assert.equal(DEFAULTS.share.minScore, 13); assert.equal(DEFAULTS.share.topOnly, undefined)
  `)
  // 状态行：分享关着时说「已关」
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, quota: { shareDaily: 0 }, share: { enabled: false } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { status } from '@CORE@'
    const st = status(); assert.equal(st.sharesOn, false); assert.equal(st.sharesMax, null)
  `)
})

// ───────── 第三轮审查（2026-10-25）─────────

test('round 3: a bad value in another section (night windows, qq, notify, voxcpm path) never blocks config set share.enabled false; touching that section still refuses', (t) => {
  const s = sandbox(t)
  const base = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  const cases = [
    { night: { windows: [] } }, { night: { windows: [null] } }, { night: { windows: '20:00-24:00' } }, { night: { windows: [{ start: '8pm', end: '23:00' }] } },
    { qq: { api: 'http://172.20.1.2:3000' } }, { qq: { ownerQq: 'abc' } }, { qq: { selfQq: '123456', ownerQq: '123456' } },
    { notify: { type: 'none', fallback: 'wechat' } }, { notify: { type: 'webhook', url: 'ftp://x' } },
    { studio: { voxcpm: { python: 'rel/python.exe', model: '' } } },
  ]
  for (const broken of cases) {
    fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, share: { enabled: true }, ...broken }))
    const known = QQ || !broken.qq
    s.script(`
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { setConfigPath, readConfig, CFG_FILE } from '@CORE@'
      const before = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
      const r = setConfigPath('share.enabled', 'false')
      assert.equal(r.ok, true, ${JSON.stringify(JSON.stringify(broken))} + ' ' + r.error)
      assert.equal(readConfig().share.enabled, false)
      if (${known}) assert.match(r.warn, /这次没改它，原样留着/)
      else { assert.equal(r.warn, null); assert.deepEqual(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).qq, ${JSON.stringify(broken.qq ?? null)}) }
    `)
  }
  // 这次改的就是那一段：照样报错
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, share: { enabled: true } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath } from '@CORE@'
    assert.equal(setConfigPath('night.windows', '[]').ok, false)
    assert.equal(setConfigPath('qq.api', 'http://172.20.1.2:3000').ok, false)
    assert.equal(setConfigPath('notify.fallback', 'wechat').ok, false)
    assert.equal(setConfigPath('qq.ownerQq', 'abc').ok, false)
  `)
  // aliases 是一组名字：不能按下标改（以前改成 {"2":…}，弹幕监听一启动就崩）
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, aliases: ['旧名1', '旧名2'] }))
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { setConfigPath, CFG_FILE } from '@CORE@'
    const r = setConfigPath('aliases.2', '旧名3')
    assert.equal(r.ok, false); assert.match(r.error, /一组值，不能按下标改/)
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).aliases, ['旧名1', '旧名2'])
  `)
})

test('round 3: an empty / zero / unreadable last-reaction time stops sharing (fail closed), and the wake prompt says the same thing as the gate', (t) => {
  for (const last of ['', 0, false, 'garbage']) {
    const s = sandbox(t, { quota: { shareDaily: 0 } })
    s.write('feedback.json', { last, events: [] }); s.write('quota.json', { log: shares(1, 4) })
    const r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
    assert.equal(r.status, 2, JSON.stringify(last) + ' ' + r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /已停止分享/)
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import { wakePrompt } from ${JSON.stringify(href('lib/scheduler.js'))}; console.log(wakePrompt({ atText: 'x' }, '', 5))`], { env: { ...s.env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
    assert.equal(p.status, 0, p.stderr)
    assert.match(p.stdout, /今天不分享/, JSON.stringify(last))
    assert.doesNotMatch(p.stdout, /4 天没有回应/, 'the prompt must not fall back to the first share while the gate says stop')
  }
  // 从来没表态过（没有 last）：从第一次分享算，4 天 → 降到 2，不停
  const s = sandbox(t, { quota: { shareDaily: 0 } })
  s.write('feedback.json', { events: [] }); s.write('quota.json', { log: shares(1, 4) })
  const r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew'])
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /不限 → 2/)
  assert.equal(C.silentDaysOf(undefined, null, 7), 0)
  assert.equal(C.silentDaysOf('', null, 7), 7)
  assert.equal(C.silentDaysOf(null, ago(2), 7), 2)
})

test('round 3: feed buckets — a title takes its first like while that like has room; titles with no hit only fill leftovers; odd --per; header counts case-duplicates once', (t) => {
  const KW = ['Mistral', 'Qwen', 'LLM', 'Ollama', '小丑鱼', '机器人', 'Aseprite', '坦克世界', '只狼', 'Inkscape', '地图画', '手影', '夏目友人帐', '尤克里里', '滤镜']
  const LIKE13 = ['AI 作曲', 'Krita Godot', 'AI配音', 'AI滤镜', '星露谷', '饥荒', '蔚蓝档案', 'ACG', '烘焙', '柴犬', '仓鼠', '天文 科普', '徒步旅行']
  const run = (like, popular, args) => {
    const sb = sandbox(t, { preferences: { like, keywords: KW } })
    sb.write('credentials.json', { sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test' })   // 假的：feed 读它拼请求头，请求被假 B 站接住
    const env = { ...sb.env, TEST_REQUESTS: path.join(sb.home, 'requests.jsonl') }
    env.NODE_OPTIONS = '--import=' + href('tests/helpers/feed-fetch.mjs')
    env.TEST_FEED_NO_SEARCH = '1'
    env.TEST_FEED_POPULAR = JSON.stringify(popular)
    const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    return { out: r.stdout, picks: r.stdout.split('\n').filter((l) => /^\s+\d+\. BV/.test(l)) }
  }
  // 第三轮审查的例子：以前「AI 写代码 Krita Code 实测」第一轮就跑去占了 Krita Godot，Godot 那条被挤掉
  let { picks } = run(LIKE13, [{ t: 'OpenAI 发布会', dm: 6000 }, { t: 'AI 写代码 Krita Code 实测', dm: 150 }, { t: 'Krita Code 教程', dm: 500 }, { t: 'Godot 新功能 上手', dm: 400 }], ['--n', '6'])
  assert.equal(picks.length, 4, picks.join('\n'))
  // 完全没命中、弹幕又少的：不抢第一轮
  ;({ picks } = run(LIKE13, ['饥荒 一', '饥荒 二', '仓鼠 一', '仓鼠 二', '烘焙 一', '烘焙 二', '柴犬 一', '柴犬 二', { t: '某地 新闻 通报', dm: 1 }], ['--n', '6']))
  assert.equal(picks.length, 6); assert.ok(!picks.some((l) => l.includes('某地 新闻 通报')), picks.join('\n'))
  // --per 写坏了用默认值（以前列表只剩一条）
  ;({ picks } = run(LIKE13, ['饥荒 一', '饥荒 二', '仓鼠 一', '仓鼠 二', '烘焙 一', '烘焙 二', '柴犬 一'], ['--n', '6', '--per', 'abc']))
  assert.equal(picks.length, 6, picks.join('\n'))
  // 只差大小写的爱看算一个：7 个里有 ACG / acg，实际 6 个，每晚全搜，不说「轮流」
  const { out } = run(['ACG', 'acg', '饥荒', '仓鼠', '烘焙', '柴犬', '徒步旅行'], [], ['--n', '6'])
  assert.match(out, /今晚搜: ACG · 饥荒 · 仓鼠 · 烘焙 · 柴犬 · 徒步旅行\r?\n/)
  assert.doesNotMatch(out, /轮流/)
  // 关键词里本来就有某个爱看：算那个爱看的一种写法（标题照样算进那个爱看）
  assert.deepEqual(P.prefMatcher(['仓鼠', '饥荒'], ['仓鼠表情包', '饥荒手书'])('仓鼠表情包 合集'), ['仓鼠'])
  assert.deepEqual(P.prefMatcher(['仓鼠', '饥荒'], ['仓鼠表情包', '饥荒手书'])('饥荒手书 第三弹'), ['饥荒'])
  assert.deepEqual(P.prefMatcher(LIKE13, KW)('一个浏览器滤镜'), ['滤镜'], 'a long example list is unaffected')
})

// ───────── 第四轮审查（2026-10-25）─────────

test('round 4: refuse-or-warn is per leaf — two bad values in one section no longer block each other, and a safe toggle in that section still saves', (t) => {
  const s = sandbox(t)
  const base = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  const check = (broken, key, value) => {
    fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, ...broken }))
    s.script(`
      import assert from 'node:assert/strict'
      import { setConfigPath } from '@CORE@'
      const r = setConfigPath(${JSON.stringify(key)}, ${JSON.stringify(value)})
      assert.equal(r.ok, true, ${JSON.stringify(key)} + ' ' + r.error)
    `)
  }
  const qq = { qq: { api: 'http://172.20.1.2:3000', ownerQq: 'abc' } }
  if (QQ) {
    check(qq, 'qq.api', 'http://127.0.0.1:3000')
    check(qq, 'qq.ownerQq', '123456789')
  } else {
    fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, ...qq }))
    s.script(`
      import assert from 'node:assert/strict'
      import { setConfigPath } from '@CORE@'
      for (const [k, v] of [['qq.api', 'http://127.0.0.1:3000'], ['qq.ownerQq', '123456789']]) { const r = setConfigPath(k, v); assert.equal(r.ok, false, k); assert.match(r.error, /^不认识的设置：qq（/, k) }
    `)
  }
  const vox = { studio: { voxcpm: { python: 'rel/python.exe', model: 'rel/model' } } }
  check(vox, 'studio.voxcpm.python', '')
  check(vox, 'studio.maxPerWeek', '1')
  const nt = { notify: { type: 'webhok', url: 'ftp://x' } }
  check(nt, 'notify.type', 'none')
  check(nt, 'notify.url', '')
  // 改的正是坏掉的那一项：照样报错
  fs.writeFileSync(s.cfgFile, JSON.stringify(base))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath } from '@CORE@'
    assert.equal(setConfigPath('qq.api', 'http://172.20.1.2:3000').ok, false)
    assert.equal(setConfigPath('notify.url', 'ftp://x').ok, false)
  `)
})

test('round 4: dotted keys never index into a list (aliases, studio.avoidCreators, notify.args); lists can be set with 顿号; a section corrupted into a list is rebuilt, not refused in a loop', (t) => {
  const s = sandbox(t)
  const base = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, aliases: ['旧名1'], studio: { avoidCreators: ['111111', '222222', '333333'] }, notify: { type: 'command', cmd: 'x', args: ['a', 'b'] } }))
  s.script(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { setConfigPath, CFG_FILE } from '@CORE@'
    for (const k of ['aliases.1', 'studio.avoidCreators.3', 'notify.args.2']) {
      const r = setConfigPath(k, '444444'); assert.equal(r.ok, false, k); assert.match(r.error, /一组值，不能按下标改/)
    }
    const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    assert.deepEqual(c.studio.avoidCreators, ['111111', '222222', '333333']); assert.deepEqual(c.notify.args, ['a', 'b']); assert.deepEqual(c.aliases, ['旧名1'])
    let r = setConfigPath('studio.avoidCreators', '111111、222222、444444'); assert.equal(r.ok, true, r.error)
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).studio.avoidCreators, ['111111', '222222', '444444'])
    r = setConfigPath('aliases', '旧名1、旧名2'); assert.equal(r.ok, true, r.error)
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).aliases, ['旧名1', '旧名2'])
    for (const bad of ['{"a":1}', 'true']) { r = setConfigPath('aliases', bad); assert.equal(r.ok, false, bad); assert.match(r.error, /一组名字/) }
  `)
  // 手改坏了的 aliases：别的设置照存，换成空的并提醒
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, aliases: { a: 1 } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.2'); assert.equal(r.ok, true, r.error); assert.match(r.warn, /aliases 不是一组名字/)
    assert.deepEqual(readConfig().aliases, [])
  `)
  // night 被写坏成一个数组：改其中一项时从默认值开始（以前提示「整组设」，照着做又被拒，绕圈）
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, night: [] }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.5'); assert.equal(r.ok, true, r.error)
    assert.equal(readConfig().night.skipChance, 0.5)
  `)
})

test('round 4: a keyword files under the whole like word it contains (longest first), not under a part; --per 1 still fills leftovers; unreadable reaction time is said plainly; feedback.json = null does not crash', (t) => {
  const LIKE13 = ['AI 作曲', 'Krita Godot', 'AI配音', 'AI滤镜', '星露谷', '饥荒', '蔚蓝档案', 'ACG', '烘焙', '柴犬', '仓鼠', '天文 科普', '徒步旅行']
  assert.deepEqual(P.prefMatcher(LIKE13, ['AI滤镜推荐'])('AI滤镜推荐 合集'), ['AI滤镜'])
  assert.deepEqual(P.prefMatcher(LIKE13, ['AI配音推荐'])('AI配音推荐 新品'), ['AI配音'])
  assert.deepEqual(P.prefMatcher(LIKE13, ['天文馆'])('天文馆 夜场 教程'), ['天文馆'])
  // --per 1：没命中的在第二轮补空位（以前 --per 1 时没有第二轮）
  const sb = sandbox(t, { preferences: { like: ['饥荒', '仓鼠'] } })
  sb.write('credentials.json', { sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test' })
  const env = { ...sb.env, TEST_REQUESTS: path.join(sb.home, 'requests.jsonl'), NODE_OPTIONS: '--import=' + href('tests/helpers/feed-fetch.mjs'), TEST_FEED_NO_SEARCH: '1', TEST_FEED_POPULAR: JSON.stringify(['饥荒 一', '仓鼠 一', { t: '某地 新闻', dm: 5 }]) }
  for (const per of ['1', '-3']) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), '--n', '6', '--per', per], { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.split('\n').filter((l) => /^\s+\d+\. BV/.test(l)).length, 3, per + '\n' + r.stdout)
  }
  // 表态时间读不出来：照样停，但说「读不出来」，不编天数
  const s = sandbox(t, { quota: { shareDaily: 0 } })
  s.write('feedback.json', { last: '', events: [] }); s.write('quota.json', { log: [] })
  let r = s.quota(['silence']); assert.match(r.stdout, /读不出来/); assert.doesNotMatch(r.stdout, /沉默天数: \d/)
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew']); assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /记录读不出来/)
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import { wakePrompt } from ${JSON.stringify(href('lib/scheduler.js'))}; console.log(wakePrompt({ atText: 'x' }, '', 5))`], { env: { ...s.env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /记录读不出来/); assert.doesNotMatch(p.stdout, /7 天没有/)
  // feedback.json 写成 null：不崩（当成没有记录）
  fs.writeFileSync(path.join(s.home, '.bili-ai', 'feedback.json'), 'null')
  r = s.quota(['check', '--type', 'comment', '--share', '--target', 'BVnew']); assert.equal(r.status, 0, r.stdout + r.stderr)
  const p2 = spawnSync(process.execPath, ['--input-type=module', '-e', `import { wakePrompt } from ${JSON.stringify(href('lib/scheduler.js'))}; console.log(wakePrompt({ atText: 'x' }, '', 5))`], { env: { ...s.env, BILI_WHALE_AGENT: '' }, encoding: 'utf8', timeout: 20000 })
  assert.equal(p2.status, 0, p2.stderr)
})

// ───────── 第五轮审查（2026-10-25）─────────

test('round 5: per-leaf for autoDaily / commentIntervalSec / a non-object voxcpm too; avoidCreators says what it dropped; aliases takes one number; list-value JSON hints point to something that works', (t) => {
  const s = sandbox(t)
  const base = JSON.parse(fs.readFileSync(s.cfgFile, 'utf8'))
  for (const [broken, key, value, warn] of [
    [{ listen: { commentIntervalSec: '5分钟', live: true } }, 'listen.live', 'false', /commentIntervalSec 不是秒数/],
    [{ quota: { autoDaily: '5条' } }, 'quota.shareDaily', '2', /autoDaily 不是数字/],
    [{ studio: { voxcpm: 'D:/x' } }, 'studio.maxPerWeek', '1', /studio.voxcpm 不是一组设置/],
  ]) {
    fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, ...broken }))
    s.script(`
      import assert from 'node:assert/strict'
      import { setConfigPath } from '@CORE@'
      const r = setConfigPath(${JSON.stringify(key)}, ${JSON.stringify(value)})
      assert.equal(r.ok, true, ${JSON.stringify(key)} + ' ' + r.error); assert.match(r.warn, ${warn})
    `)
  }
  fs.writeFileSync(s.cfgFile, JSON.stringify({ ...base, studio: { avoidCreators: ['111111'] } }))
  s.script(`
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    let r = setConfigPath('studio.avoidCreators', '某UP主')
    assert.equal(r.ok, true, r.error); assert.match(r.warn, /只能放 UP 主的 mid（数字），这几个没存：某UP主/)
    r = setConfigPath('studio.avoidCreators', '333333、12a45'); assert.match(r.warn, /12a45/); assert.deepEqual(readConfig().studio.avoidCreators, ['333333'])
    r = setConfigPath('aliases', '2077'); assert.equal(r.ok, true, r.error); assert.deepEqual(readConfig().aliases, ['2077'])
    r = setConfigPath('night.windows', '[{start:20:00,end:23:00,wakes:1}]'); assert.equal(r.ok, false); assert.match(r.error, /config edit/); assert.doesNotMatch(r.error, /逐项设置/)
    r = setConfigPath('aliases', '[旧名1,旧名2]'); assert.equal(r.ok, false); assert.match(r.error, /顿号/)
  `)
})

test('round 5: feedback.json = null or events not a list: the owner can still record a reaction (react used to crash on it)', (t) => {
  for (const bad of ['null', '"x"', '{"events":5}', '[]']) {
    const s = sandbox(t, { quota: { shareDaily: 0 } })
    fs.writeFileSync(path.join(s.home, '.bili-ai', 'feedback.json'), bad)
    s.write('quota.json', { log: [] })
    const env = { ...s.env, BILI_WHALE_AGENT: '' }
    const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/quota.mjs'), 'react', '--note', 'test'], { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(r.status, 0, bad + ' ' + r.stdout + r.stderr); assert.doesNotMatch(r.stderr, /TypeError/)
    const fb = JSON.parse(fs.readFileSync(path.join(s.home, '.bili-ai', 'feedback.json'), 'utf8'))
    assert.ok(fb && typeof fb === 'object' && !Array.isArray(fb) && fb.last && Array.isArray(fb.events), bad + ' ' + JSON.stringify(fb))
    assert.equal(Object.keys(fb).includes('0'), false, 'no junk index keys')
  }
})

test('round 5: a keyword files under a like even when that like was merged with its case twin; a bare --per uses the default', (t) => {
  assert.deepEqual(P.prefMatcher(['ACG', 'acg'], ['acg模型'])('acg模型分享'), ['ACG'])
  assert.deepEqual(P.prefMatcher(['acg', 'ACG'], ['acg模型'])('acg模型分享'), ['acg'])
  const sb = sandbox(t, { preferences: { like: ['饥荒', '仓鼠'] } })
  sb.write('credentials.json', { sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test' })
  const env = { ...sb.env, TEST_REQUESTS: path.join(sb.home, 'requests.jsonl'), NODE_OPTIONS: '--import=' + href('tests/helpers/feed-fetch.mjs'), TEST_FEED_NO_SEARCH: '1', TEST_FEED_POPULAR: JSON.stringify(['饥荒 一', '饥荒 二', '仓鼠 一', '仓鼠 二']) }
  for (const args of [['--n', '6', '--per'], ['--per', '--n', '6']]) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.split('\n').filter((l) => /^\s+\d+\. BV/.test(l)).length, 4, args.join(' ') + '\n' + r.stdout)
  }
})
