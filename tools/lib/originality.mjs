// 原创查重（bili-whale-cc 加）—— 主人定：她不能抄别的 UP 主（尤其是别的 AI UP 主）的内容
//
// 交审前必跑，命中就拦（不靠她自觉）：
//   ① 文案 vs 她看过的每一条视频的字幕（<数据目录>/shots/subs/*.txt —— subtitles / debrief 留下的）
//      · 有一整句（≥ 20 个字，去掉标点空格后）原样出现 → 拦
//      · 8 字片段：重合占她文案的 ≥ 15%，或者共有 ≥ 30 个 → 拦（改几个字的"洗稿"也算；
//        用绝对个数是因为比例会被她自己写的大段文字稀释 —— 整段抄来、外面包一大圈自己的话也要拦得住）
//      · 5 字片段：共有 ≥ 80 个；或者 ≥ 40 个且占她文案 ≥ 5% → 拦（每隔七八个字改一个字，8 字片段就一个都对不上了；
//        绝对个数那一档同样是为了不被大段自己的话稀释）
//   ② 标题 vs B站 搜索结果 / 主人列的「别碰」UP 主 —— 在 studio.py 里联网查（查不成不拦，但报告里写明）
//   ③ 文案 vs 主人放的参考材料（老师的讲义；~/.bili-ai/reference/，她看不到原文）—— 见 tools/lib/reference.mjs
// 这一层是纯本地计算：不联网、不依赖 Python，所以查不了就等于没查 —— 失败一律按"拦"处理。
// 剧本的字段 / 形状和 studio.py 的 validate_script + script_text 对齐：两边对「剧本里有哪些字」不能有分歧
import fs from 'node:fs'
import path from 'node:path'

export const SAME8_MAX = 30
export const SAME5_MAX = 80

// NFKC 统一全角半角；再去掉空白、标点、符号，以及不可见的格式字符（零宽空格、软连字符…）和组合记号（变体选择符…）
// —— 以前零宽字符留在文本里，每隔几个字插一个，8 字 / 20 字片段就全对不上了
export const norm = (t) => String(t ?? '').normalize('NFKC').replace(/^\s*【[^】]{0,16}】/, '').replace(/[\s\p{P}\p{S}\p{C}\p{M}_]+/gu, '').toLowerCase()

export function shingles(t, n) {
  const out = new Set()
  for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n))
  return out
}

export function jaccard(a, b) {
  const A = shingles(norm(a), 2), B = shingles(norm(b), 2)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 不管是什么形状，把里面所有的字符串都捞出来（对象 / 数组里藏的字也算 —— 宁可多查，不能漏查） */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'number') out.push(String(v))
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

/**
 * 剧本里所有会出现在观众面前的文字（标题单独查）：简介、封面字、幻灯片标题 / 要点 / 角注、便签（字 + 小标题）、每一句台词。
 * scenes 和旧格式 segments 两个都查（studio.py 只会用其中一个，这里查两个的并集 = 只会多查）
 */
export function scriptText(script) {
  const s = script && typeof script === 'object' ? script : {}
  const scenes = [...(Array.isArray(s.scenes) ? s.scenes : []), ...(Array.isArray(s.segments) ? s.segments.map((x) => ({ lines: [{ text: x?.text }] })) : [])]
  const parts = [s.desc, s.cover?.text]
  for (const sc of scenes) {
    if (!sc || typeof sc !== 'object') continue
    parts.push(sc.slide?.title, sc.slide?.bullets, sc.slide?.note)
    parts.push(sc.note?.text, sc.note?.label)   // 便签（v0.11.15）：画在她旁边的字也是她的文案；顺序和 studio.py 的 script_text 一样（紧跟幻灯片）
    for (const l of Array.isArray(sc.lines) ? sc.lines : []) parts.push(l?.text)
  }
  return norm(strings(parts).join(''))
}

/** 拦不拦（规则见文件头；studio.py 的 local_overlap 用同一套） */
export const copiedTooMuch = ({ sample, ratio, same8, same5, mine5 }) =>
  Boolean(sample) || ratio >= 0.15 || same8 >= SAME8_MAX || same5 >= SAME5_MAX || (same5 >= SAME5_MAX / 2 && same5 / Math.max(1, mine5) >= 0.05)

/**
 * 她的文案（已 norm）和另一段文字（已 norm）重合多少：字幕和中文参考材料用同一套（copiedTooMuch 判拦不拦）。
 * mine = 她文案的片段集合（同一份文案和很多个文件比时只算一次）
 */
export function textOverlap(text, other, mine = { m5: shingles(text, 5), m8: shingles(text, 8), m20: shingles(text, 20) }) {
  const o8 = shingles(other, 8), o5 = shingles(other, 5)
  let same8 = 0, same5 = 0
  for (const x of mine.m8) if (o8.has(x)) same8 += 1
  for (const x of mine.m5) if (o5.has(x)) same5 += 1
  const ratio = same8 / Math.max(1, mine.m8.size)
  let sample = ''
  for (const x of mine.m20) {
    if (!other.includes(x)) continue
    // 往后延伸，找出最长的那段原样重合
    const i = text.indexOf(x)
    let j = i + 20
    while (j < text.length && other.includes(text.slice(i, j + 1))) j += 1
    if (j - i > sample.length) sample = text.slice(i, j)
  }
  return { sample, ratio, same8, same5, mine5: mine.m5.size }
}

/**
 * 文案 vs 本地字幕。返回 { hits, errors, checked }：
 *   · 字幕目录不存在 = 她还没看过任何带字幕的视频 → 没东西可抄，不算错
 *   · 目录 / 文件读不出来 = 没查成 → 记进 errors，调用方据此拦下（不能当成"没重复"）
 */
export function localOverlap(text, subsDir) {
  const hits = [], errors = []
  let files = []
  try { files = fs.readdirSync(subsDir).filter((f) => f.endsWith('.txt')) } catch (e) {
    if (e?.code !== 'ENOENT') errors.push(`字幕目录读不了：${e?.code ?? e}`)
    return { hits, errors, checked: 0 }
  }
  if (text.length < 20) return { hits, errors, checked: files.length }
  const mine = { m5: shingles(text, 5), m8: shingles(text, 8), m20: shingles(text, 20) }
  for (const f of files) {
    let other = ''
    try { other = norm(fs.readFileSync(path.join(subsDir, f), 'utf8').replace(/\[\d+:\d+(?::\d+)?(?:\.\d+)?\]/g, '')) } catch (e) {
      errors.push(`${f} 读不了：${e?.code ?? e}`)
      continue
    }
    if (other.length < 20) continue
    const o = textOverlap(text, other, mine)
    if (copiedTooMuch(o)) {
      hits.push({ kind: 'copied-text', source: (f.match(/BV[0-9A-Za-z]{10}/) ?? [f])[0], overlap: Number(o.ratio.toFixed(3)), shared8: o.same8, shared5: o.same5, sample: o.sample.slice(0, 60) })
    }
  }
  return { hits, errors, checked: files.length }
}

export function describeHit(h) {
  if (h.kind === 'copied-text') return `文案和 ${h.source} 的字幕重合${h.sample ? `（原样出现：「${h.sample}」）` : ''}${h.overlap ? ` · 片段重合 ${Math.round(h.overlap * 100)}%` : ''}${h.shared8 ? ` · 共有 8 字片段 ${h.shared8} 个` : ''}`
  if (h.kind === 'similar-title') return `标题和 ${h.source}（${h.by ?? '?'}）《${h.title}》太像（${Math.round(h.similarity * 100)}%）`
  if (h.kind === 'avoid-creator') return `标题和「别碰」名单里的 ${h.by ?? '?'} 的《${h.title}》太像（${Math.round(h.similarity * 100)}%）`
  // 主人放的参考材料（老师的讲义等，见 tools/lib/reference.mjs）：只引她自己剧本里的字，不引材料原文
  if (h.allowed) return '主人看过、放行了：' + describeHit({ ...h, allowed: false })
  if (h.kind === 'reference-text') return `有一段和参考材料「${h.source}」原样一样（连着 ${h.words} 个词${h.total > h.words ? `，几段加起来 ${h.total} 个词` : ''}）：「${h.sample}」—— 用你自己的话讲`
  if (h.kind === 'reference-numbers' && h.weak) return `${h.where}有几个数字和参考材料「${h.source}」里同一处的一样（${h.numbers.join('、')}）—— 是公认的数值就没事；是照着那道例题的，换一组自己的`
  if (h.kind === 'reference-numbers') return `${h.where}的例题数字和参考材料「${h.source}」里的一道一样（${h.numbers.join('、')}）—— 自己编一道题、换一组数字`
  if (h.kind === 'web-copied-text') return `文案和她读过的网页（${String(h.host ?? '?').slice(0, 80)}）有一段一样（共有片段约 ${Math.round(Number(h.ratio) * 100) || 0}%）—— 网页的字不能原样放进作品，用你自己的话讲`
  if (h.kind === 'reference-copied-text') return `文案和参考材料「${h.source}」重合${h.sample ? `（原样出现：「${h.sample}」）` : ''}${h.shared8 ? ` · 共有 8 字片段 ${h.shared8} 个` : ''} —— 用你自己的话讲`
  return JSON.stringify(h)
}
