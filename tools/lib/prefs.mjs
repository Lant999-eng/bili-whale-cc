// 她的口味（config.preferences）怎么变成「今晚搜什么」和「标题里认哪些词」—— feed.mjs 用；拆出来是为了能离线测（2026-10-25）
//
// - like：她爱看的。每个都是一个能直接拿去 B 站搜的短词。
//   - 超过 6 个时每晚轮流搜 6 个：几晚轮一遍，每晚的搜索次数不变（搜得多了容易被风控）。
//   - 「一晚」从中午 12 点算起：18:00–06:00 这种跨午夜的一晚是同一组，醒几次都搜这一组（看过的会排除，结果不会重复）。
//   - 标题打分：整个词，或者按空格、/、·、顿号、逗号拆开的任意一部分出现在标题里，就算命中这个爱看。
//     一个字的部分、「科普」「教程」这种什么视频都会带的部分不单独算（不然「历史科普」也算天文科普）。
// - keywords：只在标题里认、不拿去搜的词（Mistral、只狼……），每个单独算一个命中。
// - 不重复算：一处命中落在另一个更长的命中里面，就不另算 ——「AI滤镜推荐」只算「AI滤镜」，不再加上「AI 作曲」的 AI 和关键词「滤镜」。
// - 大小写：英文名字不分大小写（Krita / krita）；三个字母以内的缩写（AI、GPT、ACG）照写的认，
//   而且前后不能紧挨着同样大小写的字母：AI 认 OpenAI、AI滤镜，不认 email、MAIN、RAID。
//   想认单独出现的小写（gpt-5、gpt4o）就再写一个小写的（gpt）：只差大小写的算同一个词，一个命中、一个类、只搜一次；chatgpt 这种连写的认不了。
// - 两个爱看拆出来同一个部分（「AI 作曲」「AI 绘画」都有 AI）：这个部分只算前一个。

export const SEARCH_PER_NIGHT = 6
const PARTS = /[\s·,，、/]+/
const SHORT = /^[A-Za-z0-9]{1,3}$/
// 什么视频都会带的部分：不单独算命中（整个词照样认）
export const GENERIC_PARTS = new Set(['科普', '教程', '推荐', '合集', '合辑', '盘点', '实况', '攻略', '解说', '测评', '日常', '视频', '分享', '集锦', '混剪', '入门'])
export const WORD_MAX = 30      // 一个词最长几个字（爱看要拿去搜）
export const LIST_MAX = 50      // 一栏最多几个词

/** 去重用的键：短缩写分大小写（GPT 和 gpt 是两个词，各认各的），别的不分 */
const keyOf = (w) => (SHORT.test(w) ? w : w.toLowerCase())

/** 一组词：数组，或者用顿号 / 逗号 / 分号 / 换行隔开的一串字（一个数也算一个词：2077）→ 去掉首尾空白、去重的字符串数组；别的类型 = 空数组 */
export function wordList(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[、，,；;\n]+/) : typeof v === 'number' && Number.isFinite(v) ? [v] : []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (typeof x !== 'string' && !(typeof x === 'number' && Number.isFinite(x))) continue
    const s = String(x).replace(/\s+/g, ' ').trim()
    if (!s || seen.has(keyOf(s))) continue
    seen.add(keyOf(s))
    out.push(s)
  }
  return out
}

/**
 * 一栏词哪里不对（存配置时用）：不是一组词、太长、太多 → 一句话；没问题 → null。
 * 能读成一组词的（数组、用顿号隔开的一串字、一个数）都算对，存的时候用 wordList 收拾。
 */
export function wordListProblem(name, v) {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return `${name} 要是一组词（["…","…"]，或者用顿号隔开的一串字）`
  if (Array.isArray(v) && v.some((x) => typeof x !== 'string' && !(typeof x === 'number' && Number.isFinite(x)))) return `${name} 里只能放词（字符串）`
  const list = wordList(v)
  const long = list.find((w) => w.length > WORD_MAX)
  if (long) return `${name} 里「${long.slice(0, 12)}…」太长了（一个词最多 ${WORD_MAX} 个字）`
  if (list.length > LIST_MAX) return `${name} 最多 ${LIST_MAX} 个词（现在 ${list.length} 个）`
  return null
}

/** 看起来像好几个词用空格连成了一个（PowerShell 里 config set preferences.like 科普 音乐 猫 这种）→ 那个词；没有 → null */
export function joinedWords(list) {
  return wordList(list).find((w) => w.split(' ').length >= 3) ?? null
}

/** 第几晚：本地日期，不到中午 12 点的算前一晚（不受夏令时影响） */
export function nightIndex(date = new Date()) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  return date.getHours() < 12 ? day - 1 : day
}

/** 今晚搜哪几个：不超过 n 个全搜；超过就从第 (第几晚 × n) 个开始连着取 n 个（到头接着从头取），每个几晚之内都会轮到 */
/** 要搜的爱看：B 站搜索不分大小写，ACG 和 acg 只算一个（不浪费一晚 6 个名额，2026-10-25 审查）；「爱看一共几个」也按它数 */
export function searchList(like) {
  const seen = new Set()
  return wordList(like).filter((w) => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
}

export function searchTerms(like, { n = SEARCH_PER_NIGHT, date = new Date() } = {}) {
  const list = searchList(like)
  const k = Math.max(1, Math.floor(Number(n)) || SEARCH_PER_NIGHT)
  if (list.length <= k) return list
  const start = (((nightIndex(date) * k) % list.length) + list.length) % list.length
  return Array.from({ length: k }, (_, i) => list[(start + i) % list.length])
}

const caseClass = (ch) => (/[A-Z]/.test(ch) ? '[A-Z]' : /[a-z]/.test(ch) ? '[a-z]' : '[0-9]')
/** 一个词在标题里出现的每一处 [开始, 结束) */
function spansOf(title, lower, tok) {
  const out = []
  if (SHORT.test(tok)) {
    const re = new RegExp(`(?<!${caseClass(tok[0])})${tok}(?!${caseClass(tok.at(-1))})`, 'g')
    for (const m of title.matchAll(re)) out.push([m.index, m.index + tok.length])
    return out
  }
  const t = tok.toLowerCase()
  for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) out.push([i, i + t.length])
  return out
}

/** 标题 → 命中了哪些：先是爱看（按配置里的顺序），再是 keywords；第一个就是这条标题的「主题」（feed 按它分类） */
export function prefMatcher(like, keywords = []) {
  // 只差大小写的算同一个（GPT / gpt、ACG / acg）：各自照写的认，但只算一个命中、一个类 —— 以前算两个（2026-10-25 审查）
  const labels = []
  const owner = new Map()   // 小写的词 → 它属于哪个标签
  const add = (label, tokens, isLike = false) => {
    let l = owner.get(label.toLowerCase())
    if (!l) { l = { label, tokens: [], forms: [] }; labels.push(l) }
    if (isLike && !l.forms.includes(label)) l.forms.push(label)   // 这个标签收了哪几个爱看（ACG、acg）：关键词找「含哪个爱看」时都要看（第五轮审查）
    for (const t of tokens) {
      const o = owner.get(t.toLowerCase())
      if (o && o !== l) { if (!o.tokens.includes(t)) o.tokens.push(t); continue }   // 关键词和某个爱看拆出来的部分一样（只差大小写）：算那个爱看的
      if (!l.tokens.includes(t)) l.tokens.push(t)
      owner.set(t.toLowerCase(), l)
    }
  }
  for (const p of wordList(like)) add(p, [p, ...p.split(PARTS).filter((t) => t.length >= 2 && !GENERIC_PARTS.has(t))], true)
  const likeLabels = [...labels]
  for (const k of wordList(keywords)) {
    if (owner.has(k.toLowerCase()) && owner.get(k.toLowerCase()).label === k) continue
    // 关键词里本来就有某个爱看（关键词「仓鼠表情包」、爱看「仓鼠」）：算那个爱看的一种写法 ——
    // 不然更长的关键词把爱看的命中「包住」，标题只算关键词，分类时也找不到它的爱看（2026-10-25 第三轮审查）
    // 要含的是整个爱看（不是拆出来的一部分），挑最长的：「AI滤镜推荐」算「AI滤镜」，不算「AI 作曲」的 AI；「天文馆」不算「天文 科普」（第四轮审查）
    const longest = (l) => Math.max(...l.forms.map((x) => x.length))
    const host = !owner.has(k.toLowerCase()) && [...likeLabels].sort((a, b) => longest(b) - longest(a)).find((l) => l.forms.some((x) => spansOf(k, k.toLowerCase(), x).length))
    if (host) { if (!host.tokens.includes(k)) host.tokens.push(k); owner.set(k.toLowerCase(), host); continue }
    add(k, [k])
  }
  for (let i = labels.length - 1; i >= 0; i -= 1) if (!labels[i].tokens.length) labels.splice(i, 1)
  return (title) => {
    const t = String(title ?? '')
    const lower = t.toLowerCase()
    const found = labels.map((l) => ({ l, spans: l.tokens.flatMap((tok) => spansOf(t, lower, tok)) })).filter((x) => x.spans.length)
    const all = found.flatMap((x) => x.spans.map((s) => ({ s, x })))
    // 这一处落在别的标签更长的一处命中里面
    const inside = (s, x) => all.some((o) => o.x !== x && o.s[1] - o.s[0] > s[1] - s[0] && o.s[0] <= s[0] && s[1] <= o.s[1])
    return found.filter((x) => !x.spans.every((s) => inside(s, x))).map((x) => x.l.label)
  }
}

/** 偏好分：命中一个 +4，多命中一个再 +1，最多 +6 —— 以前每个 +4、不封顶，AI 类标题一条能拿 +12～+24，前几名全是它 */
export const prefScore = (hits) => (hits > 0 ? 4 + Math.min(2, hits - 1) : 0)
