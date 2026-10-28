// 她的口味和分享门槛（2026-10-25）：
// - 爱看超过 6 个时每晚轮流搜 6 个（中午 12 点换下一组），几晚之内每个都轮到；以前只搜前 6 个
// - keywords 只给标题加分、不拿去搜；和爱看拆出来的词一样的不重复加；英文名字不分大小写，短缩写照写的认
// - 分享门槛照配置：评分卡写的是配置里的分数（以前写死「超过 12 就发」）；门槛写坏了分享一律拦下，config set 不让存
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const href = (p) => pathToFileURL(path.join(root, p)).href
const P = await import(href('tools/lib/prefs.mjs'))
const S = await import(href('tools/lib/share-policy.mjs'))

// 示例：13 个爱看（测轮换、拆词用）
const LIKE = ['AI 作曲', 'Krita Godot', 'AI配音', 'AI滤镜', '星露谷', '饥荒', '蔚蓝档案', 'ACG', '烘焙', '柴犬', '仓鼠', '天文 科普', '徒步旅行']
const at = (y, m, d, h) => new Date(y, m - 1, d, h, 30)

function sandbox(t, cfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-prefs-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'portable/profile')
  fs.mkdirSync(dsh, { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  const cfgFile = path.join(dsh, 'bili-whale.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ owner: { mid: '222', name: 'Owner' }, listen: { comment: false, dm: false, live: false }, ...cfg }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32), buvid3: 'test' }))
  return { home, cfgFile, env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: cfgFile, TEST_REQUESTS: path.join(home, 'requests.jsonl') } }
}
function script(env, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code.replaceAll('@CORE@', href('host/core.mjs'))], { env, encoding: 'utf8', timeout: 20000 })
  assert.ifError(r.error)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return r.stdout
}

test('wordList: arrays and 顿号-separated strings become trimmed, de-duplicated words; other types are empty', () => {
  assert.deepEqual(P.wordList(['  仓鼠 ', '仓鼠', 'Krita', 'krita', '', '天文   科普', 3, null, {}]), ['仓鼠', 'Krita', '天文 科普', '3'])
  assert.deepEqual(P.wordList('Mistral、Qwen，LLM; 只狼\n坦克世界'), ['Mistral', 'Qwen', 'LLM', '只狼', '坦克世界'])
  for (const v of [undefined, null, true, { a: 1 }, NaN]) assert.deepEqual(P.wordList(v), [])
  assert.equal(P.wordListProblem('preferences.like', LIKE), null)
  assert.equal(P.wordListProblem('preferences.like', '仓鼠、饥荒'), null)
  assert.match(P.wordListProblem('preferences.like', true), /一组词/)
  assert.match(P.wordListProblem('preferences.like', { a: 1 }), /一组词/)
  assert.match(P.wordListProblem('preferences.like', ['猫', { a: 1 }]), /只能放词/)
  assert.match(P.wordListProblem('preferences.like', ['猫'.repeat(31)]), /太长/)
  assert.match(P.wordListProblem('preferences.keywords', Array.from({ length: 51 }, (_, i) => 'w' + i)), /最多 50/)
})

test('searchTerms: six or fewer are all searched; more rotate six per night and every word comes up within a few nights', () => {
  assert.deepEqual(P.searchTerms(LIKE.slice(0, 6), { date: at(2026, 10, 25, 22) }), LIKE.slice(0, 6))
  assert.deepEqual(P.searchTerms(['仓鼠'], { date: at(2026, 10, 25, 22) }), ['仓鼠'])
  assert.deepEqual(P.searchTerms([], { date: at(2026, 10, 25, 22) }), [])
  for (const list of [LIKE, LIKE.slice(0, 12), LIKE.slice(0, 7)]) {
    const nights = Math.ceil(list.length / 6) + 1
    const seen = new Set()
    let prev = null
    for (let i = 0; i < nights; i += 1) {
      const terms = P.searchTerms(list, { date: at(2026, 10, 25 + i, 21) })
      assert.equal(terms.length, 6)
      assert.equal(new Set(terms).size, 6, 'no word twice in one night')
      assert.notDeepEqual(terms, prev, 'the next night searches a different group')
      prev = terms
      terms.forEach((x) => seen.add(x))
    }
    assert.equal(seen.size, list.length, `all ${list.length} words searched within ${nights} nights`)
  }
  // 12 个：两晚轮一遍，第三晚回到第一组
  const twelve = LIKE.slice(0, 12)
  const n1 = P.searchTerms(twelve, { date: at(2026, 10, 25, 21) })
  const n2 = P.searchTerms(twelve, { date: at(2026, 10, 26, 21) })
  assert.deepEqual([...n1, ...n2].sort(), [...twelve].sort())
  assert.deepEqual(P.searchTerms(twelve, { date: at(2026, 10, 27, 21) }), n1)
  // 每个词在任意连着 3 晚里至少搜一次（13 个、每晚 6 个）
  for (let s = 0; s < 20; s += 1) {
    const got = new Set([0, 1, 2].flatMap((i) => P.searchTerms(LIKE, { date: at(2026, 11, 1 + s + i, 21) })))
    assert.equal(got.size, LIKE.length)
  }
})

test('searchTerms: one night runs from noon to noon (18:00–06:00 is one group), local dates, DST-proof', () => {
  const evening = P.searchTerms(LIKE, { date: at(2026, 10, 25, 18) })
  assert.deepEqual(P.searchTerms(LIKE, { date: at(2026, 10, 25, 23) }), evening)
  assert.deepEqual(P.searchTerms(LIKE, { date: at(2026, 10, 26, 3) }), evening, 'after midnight is still the same night')
  assert.deepEqual(P.searchTerms(LIKE, { date: new Date(2026, 9, 26, 11, 59) }), evening)
  assert.notDeepEqual(P.searchTerms(LIKE, { date: new Date(2026, 9, 26, 12, 0) }), evening, 'noon starts the next night')
  // 夏令时结束 / 开始那天（德国 2026-10-25、2026-03-29 凌晨）前后也正好差一晚
  assert.equal(P.nightIndex(at(2026, 10, 24, 13)) + 1, P.nightIndex(at(2026, 10, 25, 13)))
  assert.equal(P.nightIndex(at(2026, 10, 25, 3)), P.nightIndex(at(2026, 10, 24, 13)))
  assert.equal(P.nightIndex(at(2026, 3, 29, 13)) - P.nightIndex(at(2026, 3, 28, 13)), 1)
  // n 写坏了用 6
  assert.equal(P.searchTerms(LIKE, { n: 'x', date: at(2026, 10, 25, 22) }).length, 6)
  assert.equal(P.searchTerms(LIKE, { n: 0, date: at(2026, 10, 25, 22) }).length, 6)
})

test('prefMatcher: like words split into parts, keywords are their own hits, duplicates are not counted twice, names ignore case, short acronyms do not', () => {
  const hits = P.prefMatcher(LIKE, ['Mistral', '只狼', 'krita', '滤镜', '仓鼠', 'AI'])
  assert.deepEqual(hits('krita code 实测：比 godot 好用吗'), ['Krita Godot'])
  assert.deepEqual(hits('Mistral V4 发布'), ['Mistral'])
  assert.deepEqual(hits('mistral 本地部署'), ['Mistral'])
  assert.deepEqual(hits('一个浏览器滤镜'), ['滤镜'])
  // 落在更长命中里面的不另算：AI滤镜 里的 AI（AI 作曲）和 滤镜（关键词）
  assert.deepEqual(hits('AI滤镜推荐'), ['AI滤镜'])
  assert.deepEqual(hits('AI配音 滤镜'), ['AI配音', '滤镜'], 'a separate 滤镜 elsewhere in the title still counts')
  assert.deepEqual(hits('Mistral AI 机器人滤镜'), ['AI 作曲', 'Mistral', '滤镜'])
  assert.deepEqual(hits('仓鼠日常'), ['仓鼠'], 'a keyword equal to a like word is not a second hit')
  assert.deepEqual(hits('天文学家讲黑洞'), ['天文 科普'], 'parts match anywhere in the title')
  // 「科普」这种什么视频都带的部分不单独算
  assert.deepEqual(hits('历史科普：大明为什么亡了'), [])
  assert.deepEqual(hits('汽车科普：涡轮增压原理'), [])
  assert.deepEqual(hits('天文 科普 合集'), ['天文 科普'])
  assert.deepEqual(hits('只狼：影逝二度 速通'), ['只狼'])
  // 短缩写照写的大小写，前后不能紧挨着同样大小写的字母：认 OpenAI、ChatLLM，不认 email / Spain / MAIN / RAID / AGAIN
  assert.deepEqual(hits('My email from Spain'), [])
  assert.deepEqual(hits('【MAIN STORY】蔚蓝档案 第十五章 TRAILER'), ['蔚蓝档案'])
  assert.deepEqual(hits('RAID SHADOW LEGENDS AGAIN'), [])
  assert.deepEqual(hits('OpenAI 发布会'), ['AI 作曲'])
  assert.deepEqual(hits('ChatLLM 新功能'), [], 'LLM is not in this keyword list')
  assert.deepEqual(P.prefMatcher([], ['LLM'])('ChatLLM 新功能'), ['LLM'])
  assert.deepEqual(P.prefMatcher([], ['LLM'])('LLM5 来了'), ['LLM'])
  assert.deepEqual(hits('ACG 舞蹈'), ['ACG'])
  assert.deepEqual(hits('acgd'), [])
  // 想认小写的就再写一个小写的：LLM 和 llm 各是一个词（去重也照这个规矩）
  assert.deepEqual(P.wordList(['LLM', 'llm', 'Krita', 'krita']), ['LLM', 'llm', 'Krita'])
  // 只差大小写的算同一个：各自照写的认，只算一个命中（以前 LLM、llm 各算一个、各占一类）
  assert.deepEqual(P.prefMatcher([], ['LLM', 'llm'])('llm-5 实测'), ['LLM'])
  assert.deepEqual(P.prefMatcher([], ['LLM', 'llm'])('ChatLLM 和 llm4o 对比'), ['LLM'])
  assert.deepEqual(P.prefMatcher(['ACG'], ['acg'])('acg 跳舞'), ['ACG'])
  assert.deepEqual(P.prefMatcher(['ACG'], ['acg'])('【ACG】初音 acg动作'), ['ACG'])
  assert.deepEqual(P.prefMatcher(['AI 作曲'], ['ai'])('ai 新闻'), ['AI 作曲'], 'a lowercase keyword joins the like word it is a part of')
  // 两个爱看拆出来同一个部分（AI）：只算前一个，标题不会同时命中两个
  assert.deepEqual(P.prefMatcher(['AI 作曲', 'AI 绘画'])('AI 新闻'), ['AI 作曲'])
  assert.deepEqual(P.prefMatcher(['AI 作曲', 'AI 绘画'])('AI 绘画教程'), ['AI 绘画'], 'the AI inside the longer hit "AI 绘画" is not counted again')
  // 搜索不分大小写：ACG 和 acg 只搜一次
  assert.deepEqual(P.searchTerms(['ACG', 'acg', '饥荒']), ['ACG', '饥荒'])
  // 一个字的部分不算词；没有爱看就什么都不命中
  assert.deepEqual(P.prefMatcher(['猫 狗'])('小猫'), [])
  assert.deepEqual(P.prefMatcher([], [])('什么都行'), [])
  // 偏好分：一个 +4，多一个 +1，最多 +6
  assert.deepEqual([0, 1, 2, 3, 7].map(P.prefScore), [0, 4, 5, 6, 6])
  // 一个数也算一个词；好几个词用空格连成一个的能认出来
  assert.deepEqual(P.wordList(2077), ['2077'], 'a single number is a one-word list (config set preferences.keywords 2077)')
  assert.equal(P.wordListProblem('preferences.keywords', 2077), null)
  assert.equal(P.joinedWords(['AI 作曲 Krita Godot 饥荒']), 'AI 作曲 Krita Godot 饥荒')
  assert.equal(P.joinedWords(LIKE), null)
})

test('share threshold: config value or 13; broken values block sharing instead of letting everything through', () => {
  const ok = { reason: '这是一条值得分享的视频理由', rank: 1 }
  assert.equal(S.shareThreshold({}), 13)
  assert.equal(S.shareThreshold({ share: { minScore: 10 } }), 10)
  assert.equal(S.shareThreshold({ share: { minScore: '10' } }), 10)
  assert.equal(S.shareThreshold({ share: { minScore: null } }), 13)
  for (const bad of ['', ' ', true, false, '十分', [], {}, NaN, Infinity, -1, '-1', 10.5, '10.5', 21]) assert.ok(Number.isNaN(S.shareThreshold({ share: { minScore: bad } })), String(bad))
  assert.throws(() => S.validateShare({ share: { minScore: -1 } }, { ...ok, score: 0 }), /读不出来/, 'a negative threshold no longer lets everything through')
  // 分享开关：整段写坏了、开关写成「关」「off」都算关（以前只认 false）
  for (const share of [false, null, 'off', [], { enabled: '关' }, { enabled: 'off' }, { enabled: 0 }, { enabled: 'false' }]) {
    assert.throws(() => S.validateShare({ share }, { ...ok, score: 20 }), /分享已关闭/, JSON.stringify(share))
    assert.match(S.scoreCardLines({ share }).at(-1), /分享现在关着/)
  }
  assert.equal(S.validateShare({ share: { minScore: 10 } }, { ...ok, score: 10 }).score, 10)
  assert.throws(() => S.validateShare({ share: { minScore: 10 } }, { ...ok, score: 9 }), /未达到阈值 10/)
  assert.throws(() => S.validateShare({}, { ...ok, score: 12 }), /未达到阈值 13/)
  assert.throws(() => S.validateShare({ share: { minScore: '' } }, { ...ok, score: 20 }), /读不出来/)
  assert.throws(() => S.validateShare({ share: { minScore: true } }, { ...ok, score: 20 }), /读不出来/)
})

test('score card: threshold, likes, keywords and dislikes come from config (no more hardcoded "over 12")', () => {
  const lines = S.scoreCardLines({ share: { enabled: true, minScore: 10 }, preferences: { like: LIKE, keywords: ['Mistral'], dislike: ['带货'] } })
  const card = lines.join('\n')
  assert.match(lines.at(-1), /≥ 10 才发/, 'her guide says the last line of the card carries the threshold')
  assert.match(card, /≥ 10 才发/)
  assert.match(card, /不到 10 = 今天没有值得发的/)
  assert.doesNotMatch(card, /12|13/)
  assert.match(card, /爱看：AI 作曲 · Krita Godot/)
  assert.match(card, /也算：Mistral/)
  assert.match(card, /不爱看：带货/)
  assert.match(S.scoreCardLines({}).join('\n'), /≥ 13 才发/)
  assert.match(S.scoreCardLines({ share: { enabled: false, minScore: 10 } }).join('\n'), /分享现在关着/)
  assert.match(S.scoreCardLines({ share: { minScore: 'x' } }).join('\n'), /读不出来/)
  assert.doesNotMatch(S.scoreCardLines({ preferences: { like: ['猫'] } }).join('\n'), /也算/)
})

test('config set: minScore must be a whole number 0–20; preference lists accept 顿号 strings and are stored as arrays', (t) => {
  const { env, cfgFile } = sandbox(t)
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    assert.equal(setConfigPath('share.minScore', '10').ok, true)
    assert.equal(readConfig().share.minScore, 10)
    for (const bad of ['21', '-1', '10.5', 'abc', 'true', '""', '[10]']) {
      const r = setConfigPath('share.minScore', bad)
      assert.equal(r.ok, false, bad); assert.match(r.error, /0 到 20 的整数/)
    }
    assert.equal(readConfig().share.minScore, 10, 'refused values are not saved')
    assert.equal(setConfigPath('share', 'false').ok, false, 'share as a single value is refused')
    assert.equal(setConfigPath('share.minScore', '0').ok, true)
    assert.equal(setConfigPath('share.minScore', '20').ok, true)
    assert.equal(setConfigPath('share.minScore', '13').ok, true)
    // 爱看：顿号隔开的一串字（PowerShell 里好打）存成数组
    assert.equal(setConfigPath('preferences.like', 'AI 作曲、Krita Godot、仓鼠').ok, true)
    assert.deepEqual(readConfig().preferences.like, ['AI 作曲', 'Krita Godot', '仓鼠'])
    assert.equal(setConfigPath('preferences.keywords', '["Mistral"," Qwen ","mistral"]').ok, true)
    assert.deepEqual(readConfig().preferences.keywords, ['Mistral', 'Qwen'])
    assert.equal(setConfigPath('preferences.keywords', '').ok, true)
    assert.deepEqual(readConfig().preferences.keywords, [])
    for (const [k, v, why] of [['preferences.like', 'true', /一组词/], ['preferences.like', '{"a":1}', /一组词/], ['preferences.dislike', '[1,{}]', /只能放词/], ['preferences.like', '["${'猫'.repeat(31)}"]', /太长/], ['preferences', '7', /逐项设/]]) {
      const r = setConfigPath(k, v)
      assert.equal(r.ok, false, k + '=' + v); assert.match(r.error, why)
    }
    assert.deepEqual(readConfig().preferences.like, ['AI 作曲', 'Krita Godot', '仓鼠'])
  `)
  // 手改坏了的（这次改的不是这一段）：只提醒、能收拾的收拾；share 整段写成 false → 分享先关着，不能反而打开
  const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cur, share: false, preferences: { like: '饥荒、星露谷', keywords: true } }))
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.2')
    assert.equal(r.ok, true, r.error)
    assert.match(r.warn, /share 不是一组设置/)
    assert.match(r.warn, /preferences.keywords 要是一组词/)
    const c = readConfig()
    assert.equal(c.share.enabled, false)
    assert.equal(c.share.minScore, 13)
    assert.deepEqual(c.preferences.like, ['饥荒', '星露谷'])
  `)
  const cur2 = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cur2, share: { enabled: true, minScore: '' } }))
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.3')
    assert.equal(r.ok, true, r.error)
    assert.match(r.warn, /share.minScore 不是 0 到 20 的整数/)
  `)
})

test('feed: searches six likes for tonight (not just the first six), keywords and names in any case count as hits, no other network', (t) => {
  const { env, home } = sandbox(t, { preferences: { like: LIKE, keywords: ['Mistral', '只狼'], dislike: ['带货'] } })
  env.NODE_OPTIONS = '--import=' + href('tests/helpers/feed-fetch.mjs')
  env.TEST_FEED_POPULAR = JSON.stringify(['mistral 新模型实测', '只狼 速通', '今天吃什么', 'krita 写代码'])
  const before = P.searchTerms(LIKE)
  const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), '--n', '40'], { env, encoding: 'utf8', timeout: 30000 })
  const after = P.searchTerms(LIKE)
  assert.ifError(r.error)
  assert.equal(r.status, 0, r.stderr)
  const reqs = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const searched = [...new Set(reqs.filter((q) => q.path.endsWith('/search/type')).map((q) => q.keyword))]
  assert.ok(JSON.stringify(searched) === JSON.stringify(before) || JSON.stringify(searched) === JSON.stringify(after), `searched ${searched}`)
  assert.equal(searched.length, 6)
  assert.equal(reqs.filter((q) => q.path.endsWith('/search/type')).length, 12, 'six words × two orders, same as before')
  assert.match(r.stdout, new RegExp(`今晚搜: ${searched.join(' · ')}（爱看一共 13 个，每晚轮流搜 6 个）`))
  assert.match(r.stdout, /标题加分词: Mistral · 只狼/)
  assert.match(r.stdout, /mistral 新模型实测 .*\[Mistral\]/)
  assert.match(r.stdout, /只狼 速通 .*\[只狼\]/)
  assert.match(r.stdout, /krita 写代码 .*\[Krita Godot\]/)
  for (const kw of searched) assert.match(r.stdout, new RegExp(`${kw} 搜到的`))
})

test('config set: share.enabled understands 开/关/on/off, junk is refused or fails closed; a broken share section never turns sharing on', (t) => {
  const { env, cfgFile } = sandbox(t)
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    for (const [v, want] of [['关', false], ['开', true], ['off', false], ['on', true], ['0', false], ['1', true], ['"false"', false], ['true', true]]) {
      const r = setConfigPath('share.enabled', v); assert.equal(r.ok, true, v + ' ' + r.error); assert.equal(readConfig().share.enabled, want, v)
    }
    const r = setConfigPath('share.enabled', 'maybe'); assert.equal(r.ok, false); assert.match(r.error, /true（开）或 false（关）/)
    assert.equal(readConfig().share.enabled, true)
  `)
  // 手改坏了：share 整段是 "off" → 改一项门槛：从默认值开始、分享先关着，不冒出 0 / 1 / 2 这种键
  const base = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  for (const broken of ['off', false, null]) {
    fs.writeFileSync(cfgFile, JSON.stringify({ ...base, share: broken }))
    script(env, `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import { setConfigPath } from '@CORE@'
      const r = setConfigPath('share.minScore', '10')
      assert.equal(r.ok, true, r.error); assert.match(r.warn, /原来不是一组设置.*分享先关着/)
      const share = JSON.parse(fs.readFileSync(${JSON.stringify(cfgFile)}, 'utf8')).share
      assert.deepEqual(Object.keys(share).sort(), ['enabled', 'minScore', 'silentAfterDays', 'silentStopDays', 'via'])
      assert.equal(share.enabled, false); assert.equal(share.minScore, 10)
    `)
  }
  // 手改坏了的开关 / 门槛：不挡关分享；开关坏了按关存
  fs.writeFileSync(cfgFile, JSON.stringify({ ...base, share: { enabled: true, via: 'comment', minScore: -5 } }))
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    let r = setConfigPath('share.enabled', 'false')
    assert.equal(r.ok, true, 'a bad old threshold must not block switching sharing off: ' + r.error)
    assert.match(r.warn, /share.minScore 不是 0 到 20 的整数（-5）.*全被拦下/)
    assert.equal(readConfig().share.enabled, false)
    r = setConfigPath('share.minScore', '10'); assert.equal(r.ok, true, r.error); assert.equal(readConfig().share.minScore, 10)
  `)
  fs.writeFileSync(cfgFile, JSON.stringify({ ...base, share: { enabled: 'nein', via: 'comment', minScore: 10 } }))
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    const r = setConfigPath('night.skipChance', '0.4')
    assert.equal(r.ok, true, r.error); assert.match(r.warn, /share.enabled 不是 true .{1,3} false（nein）：分享先关着/)
    assert.equal(readConfig().share.enabled, false)
  `)
  // 门槛：host 的提醒和她那边的拦法一致（-1、10.5 都拦；null 当没填）
  const tools = href('tools/lib/share-policy.mjs')
  for (const [ms, blocked] of [[-1, true], [10.5, true], ['', true], [null, false], [25, true], [12, false]]) {
    fs.writeFileSync(cfgFile, JSON.stringify({ ...base, share: { enabled: true, via: 'comment', minScore: ms } }))
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { shareThreshold } from ${JSON.stringify(tools)}
      import { config } from ${JSON.stringify(href('tools/lib/config.mjs'))}
      import { setConfigPath } from ${JSON.stringify(href('host/core.mjs'))}
      const before = shareThreshold(config())
      const r = setConfigPath('night.skipChance', '0.1')
      console.log(JSON.stringify({ before, warn: r.warn ?? '' }))
    `], { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(out.status, 0, out.stderr)
    const { before, warn } = JSON.parse(out.stdout.trim().split('\n').at(-1))
    assert.equal(before === null, blocked, `minScore ${ms}: tools ${before}`)   // NaN 序列化成 null
    assert.equal(/全被拦下/.test(warn), blocked, `minScore ${ms}: host warn ${warn}`)
  }
})

test('config set: list values typed the PowerShell way get a 顿号 hint; a like word that is several words glued by spaces is warned about', (t) => {
  const { env } = sandbox(t)
  script(env, `
    import assert from 'node:assert/strict'
    import { setConfigPath, readConfig } from '@CORE@'
    let r = setConfigPath('preferences.like', '[AI 作曲,Krita Godot]')
    assert.equal(r.ok, false); assert.match(r.error, /顿号隔开/); assert.doesNotMatch(r.error, /owner.mid/)
    r = setConfigPath('preferences.like', 'AI 作曲 Krita Godot 饥荒')
    assert.equal(r.ok, true); assert.match(r.warn, /像是好几个词连在一起了/)
    r = setConfigPath('preferences.like', 'AI 作曲、Krita Godot、饥荒')
    assert.equal(r.ok, true); assert.equal(r.warn ?? null, null)
    assert.deepEqual(readConfig().preferences.like, ['AI 作曲', 'Krita Godot', '饥荒'])
    r = setConfigPath('preferences.keywords', '2077、只狼'); assert.equal(r.ok, true, r.error); assert.deepEqual(readConfig().preferences.keywords, ['2077', '只狼'])
  `)
})

test('feed ranking with a long example list: AI titles hit through keywords no longer take the whole top 6; one like word takes at most two places', (t) => {
  const KW = ['Mistral', 'Qwen', 'LLM', 'Ollama', '小丑鱼', '机器人', 'Aseprite', '坦克世界', '只狼', 'Inkscape', '地图画', '手影', '夏目友人帐', '尤克里里', '滤镜']
  const { env } = sandbox(t, { preferences: { like: LIKE, keywords: KW } })
  env.NODE_OPTIONS = '--import=' + href('tests/helpers/feed-fetch.mjs')
  // 第二轮审查的例子：AI 类标题大多没有「AI」两个字，靠关键词命中 —— 以前每个关键词各占一类，前 6 名全是 AI
  const AI = ['Mistral V4 发布', 'Qwen K3 实测', 'LLM-5 来了', 'Ollama 滤镜教程', '机器人 框架对比', 'Krita Code 上手', 'AI滤镜 推荐']
  const OTHER = ['饥荒 新角色 前瞻', '仓鼠 日常', '烘焙 吐司', '星露谷 新版本', '徒步旅行 第三季']
  env.TEST_FEED_POPULAR = JSON.stringify([...AI, ...OTHER])
  const r = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), '--n', '6'], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  const picks = r.stdout.split('\n').filter((l) => /^\s+\d+\. BV/.test(l))
  assert.equal(picks.length, 6, r.stdout)
  const isAI = (l) => AI.some((x) => l.includes(x))
  const isOther = (l) => OTHER.some((x) => l.includes(x))
  assert.ok(picks.filter(isAI).length <= 3, `at most half AI:\n${picks.join('\n')}`)
  assert.ok(picks.filter(isOther).length >= 3, `at least 3 of the other likes:\n${picks.join('\n')}`)
  // 一个爱看最多 2 条（再多给几条同一个爱看的标题也一样）
  env.TEST_FEED_POPULAR = JSON.stringify(['饥荒 一', '饥荒 二', '饥荒 三', '饥荒 四', '仓鼠 日常'])
  const r2 = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), '--n', '20'], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r2.status, 0, r2.stderr)
  const oneLike = r2.stdout.split('\n').filter((l) => /^\s+\d+\. BV/.test(l) && /饥荒/.test(l))
  assert.ok(oneLike.length <= 2, oneLike.join('\n'))
  // 一类满了算进它命中的下一个爱看，不整条丢掉：「饥荒 仓鼠 合影」排在两条饥荒后面，饥荒满了它还能进来（算仓鼠）
  env.TEST_FEED_POPULAR = JSON.stringify(['饥荒 只狼 一', '饥荒 只狼 二', '饥荒 仓鼠 合影'])   // 三条分数一样，合影排在两条饥荒后面
  const r3 = spawnSync(process.execPath, [path.join(root, 'tools/commands/feed.mjs'), '--n', '20'], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r3.status, 0, r3.stderr)
  assert.match(r3.stdout, /饥荒 仓鼠 合影/)
})
