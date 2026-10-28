// 参考材料查重（2026-10-24）—— 主人定：老师发的讲义（Skript）只给主人自己备课用，不给她；
// 她交审时和讲义比一遍，照搬得太多就拦（和看过的字幕同一道闸：studio check / submit 的原创查重）。
// 主人批准时，如果她交审之后主人又加了 / 换了材料，上传前用审片快照里的剧本再和新材料比一遍（host/core.mjs）。
//
// 材料放在 ~/.bili-ai/reference/（主人用 node host/cli.mjs reference add 放进来）：
//   · 她的会话读不到这个目录；她跑的工具进程读得到，但报告里只写**她剧本里的字**，不写材料原文
//     （报告会写进她的作品目录、也打给她看）。材料的名字她看得到（说是哪一份）
//   · 只存抽出来的文字（<id>.txt）和一个说明（<id>.json：名字、原文件名、字数、指纹、加入时间），不存 PDF
//
// 她讲的是同一门课：公认的定义、定理的一句话、标准数值、经典例子（斐波那契、1/k!、RC 充电 63.2%…），
// 她自己讲也会和讲义一样 —— 这些不算照搬。所以分两档：
//   · 拦（她交不了审）：照搬得多 —— 一段 ≥ 20 个词原样一样、或者几段一共盖住讲义同一片（约一段）里 ≥ 30 个词
//     （按讲义里被盖住的词算：同一句说两遍、句式一样的几句定义不重复算）；
//     一处（一句 / 一行 / 一个场景 / 连着 2–4 个场景）≥ 4 个「少见」的数字在讲义同一片（约 2000 字）里原样出现
//     （一道例题连已知带结果整个搬过来）；中文材料按字幕的规矩
//   · 提醒（不拦，写进报告，主人审片时看得到）：一段 10–19 个词一样；一处 ≥ 4 个有辨识度的数字对上、里面 ≥ 2 个少见的
//   · 主人放行：被拦了、但主人看过觉得没问题（谁算都一样的东西）→ node host/cli.mjs reference allow <作品>，
//     放行的是这一份剧本（按指纹），被拦的那几处变成提醒
//   讲义只有三位有效数字时，「少见」的数不多，数字这一项多半只是提醒、不拦 —— 主要靠不给她原件
//
// 词：两个字母以上的拉丁字母词（äöüß、é 也算字母）。单位（kHz、mA…）、函数名（sin、ln、det…）、LaTeX 命令不算词。
//   PDF 抽出来的断行连字符「Differen-\ntial」、拆开的变音「a¨」、看不见的字符都先理顺；
//   讲义里的目录行、带编号的标题行、每页都重复的页眉页脚、页码行先去掉（主人给她的知识点清单里会有这些）；
//   PDF 丢了空格、粘成一个的词（「dieserMatrix」「unddie」），讲义这边另存拆开的词序（后一个词小写开头的只认得出一部分）
// 数字：
//   · 有辨识度 = 带小数、或者 ≥ 11 且不像年份；0–10 这种到处都有的不算
//   · 不算数字：贴着字母的下标 / 编号（a11、R12、a₁₁、x_12、sin30）、上标和指数（10⁻¹²、1.6e-19、10^-19）、
//     章节 / 定理 / 公式 / 页码编号（Satz 3.12、(2.14)、第 3 章、S. 45）
//   · 少见 = 三位以上有效数字，而且不是从常数 / 标准值算出来的（π、e、√2、ln、三角函数、dB、e^-k、1/k!、
//     部分和、(1+1/n)^n、斐波那契、阶乘、平方、质数、市电 230 V 的 √2 / √3 倍、1/(2π)…；按有效数字比，
//     0.159 / 1.59 / 159 / 15.9% 算同一个；成表的计算 —— 每一度的三角函数、一阶低通的表、复利、二分法、
//     不动点迭代 —— 从 4 位有效数字起算），也不是这份讲义里到处都出现的
// 查不出来的：她把德语句子翻成中文讲、照着讲义的图重画、跟着讲义的顺序讲、例题全是小整数或标准值 ——
// 这些靠「不给她原件」和主人审片。
// 读不出来的材料 = 没查成 = 拦（和字幕目录读不了一样）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME } from './paths.mjs'
import { norm, shingles, textOverlap, copiedTooMuch } from './originality.mjs'

export const REFERENCE_DIR = path.join(HOME, '.bili-ai', 'reference')
export const WORD_RUN = 10      // 连着这么多个词一样 = 一句原样（提醒）
export const WORD_BLOCK = 20    // 一段这么长 = 照搬（拦）
export const WORD_TOTAL = 30    // 或者几段（每段 ≥ WORD_RUN）一共盖住讲义同一片里这么多个词（拦）
const REGION_WORDS = 300        // 「同一片」= 讲义里这么多个词以内（大约一段）
export const NUM_MIN = 4        // 一处至少这么多个数字对上
const NUM_SHARE = 0.6           // 而且占她这一处（少见的 / 有辨识度的）数字的这么多
const NUM_WINDOW = 1200         // 讲义按这么长一段比（每 400 字起一段：800 字以内的例题一定整个落在某一段里）
const NUM_STEP = 400
const CJK_MIN = 200             // 材料里的汉字少于这么多，就不按中文比
const REF_HINT = '请主人跑 node host/cli.mjs reference list 看看'

// ─────────────── 词 ───────────────
const UMLAUT = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' }
/** 比词之前先理顺：PDF 拆开的变音拼回去、NFKC、看不见的字符去掉 */
const wordText = (t) => String(t ?? '')
  .replace(/([aouAOU])\u00A8|\u00A8([aouAOU])/g, (m, a, b) => UMLAUT[a ?? b])
  .normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '')
// 单位、函数名、希腊字母、LaTeX 命令：公式行里全是这些，不算「词」（两边都去掉，原样的句子照样连得上）
const NOT_WORDS = new Set(('hz khz mhz ghz db dbm dbv ms ns us ps mv kv ma ka mw kw gw kwh mwh va kva var nf pf uf mf mh uh nh rad sr ohm kohm mohm ' +
  'sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan arccot arsinh arcosh artanh ln lg ld log exp lim limsup liminf sup inf max min ' +
  'det rang rank dim ker im re span tr dx dy dz dt du dv ds dr id mod ggt kgv gcd lcm sgn sign grad div rot deg arg abs cis ' +
  'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega ' +
  'mathbb mathrm mathcal mathbf mathit frac dfrac tfrac sqrt cdot cdots ldots dots times left right begin end pmatrix bmatrix vmatrix matrix array quad qquad text ' +
  'infty partial nabla int iint oint sum prod leq geq le ge neq approx equiv sim propto subset subseteq supset cup cap setminus forall exists ' +
  'hat vec bar dot ddot tilde overline underline label ref eqref cite').split(' '))
/** 两个字母以上的拉丁字母词（小写、NFKC；äöüß、é 这些都算字母；看不见的字符去掉；PDF 拆开的「a¨」「¨a」拼回 ä；单位 / 函数名不算） */
export const latinWords = (t) => (wordText(t).toLowerCase()
  .match(/\p{Script=Latin}{2,}/gu) ?? []).filter((w) => !NOT_WORDS.has(w))

/** PDF 抽出来的断行连字符：「Differen-\ntialrechnung」→「Differentialrechnung」（只接小写字母接小写字母的） */
const dehyphen = (t) => String(t).replace(/(\p{Ll})[-\u00AD\u2010]\s*\n\s*(\p{Ll})/gu, '$1$2')

// 后一个词小写开头的粘连，一半得是这些虚词之一（「…und」「die…」「…ist」）
const GLUE_WORDS = new Set(('der die das den dem des ein eine einen einem einer eines und oder aber auch als wie wenn dann so dass ist sind war wird werden wurde ' +
  'kann können muss müssen soll sollen hat haben mit von für auf aus bei nach zu zum zur im in an am um durch über unter vor nicht nur noch schon sich ' +
  'man wir es er sie gilt sei also hier da dies diese dieser dieses wobei sowie gleich jeweils jede jeder jedes alle somit daher folgt gegeben').split(' '))
/**
 * PDF 里后一个词小写开头的粘连（「unddie」「Spannungist」）：字母大小写看不出来，只能看这份讲义自己怎么用词。
 * 切成两半要同时满足：一半是虚词；两半在这份讲义里都单独出现过 ≥ 2 次；分开的这两个词在讲义里连着出现过、而且不比粘着的少。
 * 三个连着粘的（「unddannist」）：虚词 + 剩下的又能切成两半。一个都没切就原样返回；切错了也只是讲义这边多一套词序
 */
function splitLowerGlues(text) {
  const t = wordText(text)
  const low = (t.match(/\p{Script=Latin}+/gu) ?? []).map((w) => w.toLowerCase())
  const freq = new Map(), pairs = new Map()
  low.forEach((w, i) => {
    freq.set(w, (freq.get(w) ?? 0) + 1)
    if (i) pairs.set(`${low[i - 1]} ${w}`, (pairs.get(`${low[i - 1]} ${w}`) ?? 0) + 1)
  })
  const n = (m, k) => m.get(k) ?? 0
  const two = (w) => {
    let best = null, seen = 0
    for (let k = 2; k <= w.length - 2; k += 1) {
      const a = w.slice(0, k), b = w.slice(k)
      if (!GLUE_WORDS.has(a) && !GLUE_WORDS.has(b)) continue
      if ((!GLUE_WORDS.has(a) && a.length < 3) || (!GLUE_WORDS.has(b) && b.length < 3)) continue
      if (n(freq, a) < 2 || n(freq, b) < 2) continue
      const p = n(pairs, `${a} ${b}`)
      if (p >= 1 && p >= n(freq, w) && p > seen) { best = [a, b]; seen = p }
    }
    return best
  }
  const cuts = new Map()
  const cut = (w) => {
    if (cuts.has(w)) return cuts.get(w)
    let c = w.length >= 5 ? two(w) : null
    for (let k = 2; !c && w.length >= 8 && k <= 6; k += 1) {
      const a = w.slice(0, k)
      if (!GLUE_WORDS.has(a) || n(freq, a) < 2) continue
      const rest = two(w.slice(k))
      if (rest && n(pairs, `${a} ${rest[0]}`) >= 1) c = [a, ...rest]
    }
    cuts.set(w, c)
    return c
  }
  let changed = false
  const out = t.replace(/\p{Script=Latin}+/gu, (w) => { const c = cut(w.toLowerCase()); if (!c) return w; changed = true; return c.join(' ') })
  return changed ? out : text
}

/** 讲义里不算正文的行：目录行（点线 + 页码）、带编号的短标题、页码行、每页都重复的页眉页脚（≥ 3 次） */
function cleanNotes(text) {
  const lines = String(text).split(/\r?\n/)
  const seen = new Map()
  for (const l of lines) { const k = l.trim(); if (k.length >= 8) seen.set(k, (seen.get(k) ?? 0) + 1) }
  return lines.filter((l) => {
    const k = l.trim()
    if (k.length >= 8 && seen.get(k) >= 3) return false
    if (/(?:\.\s?){4,}\s*\d+\s*$/.test(k)) return false                                   // 目录：Folgen ........ 15
    if (k.length <= 80 && /^\d+(?:\.\d+)*\.?\s+\p{Lu}\p{Ll}{2,}/u.test(k) && !/[=<>]|[.:]$/.test(k)) return false  // 标题：2.3 Folgen und Reihen（不以句号结尾；「510 Ω 17,5 V」这种数据行不算）
    if (/^(?:seite\s*)?\d{1,4}(?:\s*(?:\/|von|of)\s*\d{1,4})?$/i.test(k)) return false     // 页码
    return true
  }).join('\n')
}

// ─────────────── 数字 ───────────────
// 章节 / 定理 / 公式 / 页码编号：「Satz 3.12」「(2.14)」「第 3 章」「S. 45」—— 不是例题数据
const REF_NO_NOTES = /(?:\b(?:vgl\.\s*)?(?:Satz|Definition|Def\.|Lemma|Beispiel|Bsp\.|Bemerkung|Korollar|Folgerung|Proposition|Theorem|Kapitel|Kap\.|Abschnitt|Abschn\.|Aufgabe|Übung|Tabelle|Tab\.|Abbildung|Abb\.|Gleichung|Gl\.|Seite|S\.|Formel|Example|Exercise|Section|Chapter|Figure|Fig\.|Table|Eq\.|Page|p\.)|§)\s*\(?\d+(?:[.,]\d+)*[a-z]?\)?|\(\d+\.\d+[a-z]?\)/gi
const REF_NO_HERS = /(?:定理|定义|引理|例题|例子|例|命题|推论|性质|习题|练习|第|§|\b(?:Satz|Definition|Def\.|Lemma|Beispiel|Bsp\.|Kapitel|Kap\.|Abschnitt|Aufgabe|Seite|S\.))\s*\d+(?:\.\d+)*|\d+(?:\.\d+)*\s*(?:章|节|页|小节|讲|课)/gi
/** 先把写法理顺：看不见的字符去掉；全角逗号 / 顿号 / 分号是分隔；上标、下标整个去掉；LaTeX 的 {,} 是小数逗号；细空格隔开的千位接起来；
 *  括号里逗号隔开的一串整数是坐标 / 区间 / 向量；章节编号去掉。她的中文里：三个以上逗号连着的是一串数，带小数点的数旁边的逗号是分隔 */
function numText(t, notes, tuples = true) {
  let s = String(t ?? '').replace(/[\p{Cf}]/gu, '')
    .replace(/[\uFF0C\u3001\uFF1B]/g, ' ')
    .replace(/[\u00B2\u00B3\u00B9\u2070-\u209F]+/g, ' ')
    .replace(/\{,\}/g, ',')
    .replace(/(\d)[\u00A0\u2009\u202F](?=\d{3}(?!\d))/g, '$1')
    .normalize('NFKC')
    .replace(notes ? REF_NO_NOTES : REF_NO_HERS, ' ')
  if (tuples) s = s.replace(/([(\[])(\s*-?\d+(?:\s*,\s*-?\d+)+\s*)(?=[)\]])/g, (m, b, inner) => b + inner.replace(/,/g, ' '))
  if (!notes) {
    s = s.replace(/\d+(?:,\d+){2,}/g, (m) => (/^\d{1,3}(?:,\d{3})+$/.test(m) ? m : m.replace(/,/g, ' ')))
      .replace(/(\.\d+),(?=\d)/g, '$1 ').replace(/(\d),(?=\d+\.\d)/g, '$1 ')
  }
  return s
}
// 前面紧挨着数字、「数字+小数点」、字母 / 希腊字母 / _ ^（下标、编号、指数）、_{ ^{、或者「字母 / _ ^ 再加正负号」（1.6e-19、10^-19）的不算
const NUM_RE = /(?<!\d|\d[.,]|[A-Za-z\u0370-\u03FF_^]|[_^]\{|[A-Za-z\u0370-\u03FF_^][-+\u2212]|[_^]\{[-+\u2212])(\d+(?:[.,]\d+)?)(?!\d)/g
const distinctive = (v) => {
  const n = Number(v)
  return v.includes('.') || (n >= 11 && !(Number.isInteger(n) && n >= 1900 && n <= 2100))
}
function readNumbers(s, notes, out) {
  for (const m of s.matchAll(NUM_RE)) {
    const x = m[1]
    const reads = /^[1-9]\d{0,2}[.,]\d{3}$/.test(x)
      ? (notes ? [x.replace(/[.,]/, ''), x.replace(',', '.')] : [x.includes(',') ? x.replace(',', '') : x])
      : [x.replace(',', '.')]
    for (const r of reads) {
      const v = String(Number(r))
      if (v !== 'NaN' && distinctive(v)) out.push(v)
    }
  }
  return out
}
/**
 * 有辨识度的数字（「4,7」「4.7」「4.70」算同一个）。
 * 「1.000」「4,700」（千位还是小数看不出来）、「(4,7)」（坐标还是小数）：她的中文里按中文习惯读；讲义（notes）两种读法都算上
 */
export function numbersOf(t, { notes = false } = {}) {
  const out = readNumbers(numText(t, notes), notes, [])
  return notes ? readNumbers(numText(t, true, false), true, out) : out
}

// 有效数字：0.0159 → '159'，1590 → '159'，63.2 → '632'
const sigDigits = (s) => String(s).replace(/^-/, '').replace(/e[+-]?\d+$/i, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '')
// 常数 / 标准值 / 经典例子：按有效数字（3–6 位，四舍五入和截断都算）记下来；整数家族（阶乘、平方、质数…）按原值记
const CANON_SIG = new Set(), CANON_INT = new Set()
{
  // 四舍五入到 3–8 位；trunc = 也收截断的写法（π = 3.141…、√2 = 1.414… 这种常数会被人截着写）
  // from = 从几位有效数字起收（成表的计算值只按 4 位以上收：三位的太挤，收进来就什么都不算少见了）
  const addSig = (x, trunc = false, from = 3) => {
    if (!Number.isFinite(x) || x === 0) return
    const a = Math.abs(x), full = sigDigits(a.toPrecision(15))
    for (let s = from; s <= 8; s += 1) { CANON_SIG.add(sigDigits(a.toPrecision(s))); if (trunc) CANON_SIG.add(full.slice(0, s).replace(/0+$/, '')) }
  }
  const { PI, E, SQRT2, LN2, LN10 } = Math, SQRT3 = Math.sqrt(3), deg = (r) => (r * 180) / PI, rad = (d) => (d * PI) / 180
  const range = (a, b, st = 1) => Array.from({ length: Math.floor((b - a) / st) + 1 }, (_, i) => a + i * st)
  // 常数
  for (const c of [PI, E, SQRT2, SQRT3, LN2, LN10, Math.sqrt(5), (1 + Math.sqrt(5)) / 2, 2 / (1 + Math.sqrt(5)), PI ** 2 / 6, PI ** 2 / 8, PI ** 2 / 12, PI / 4, PI / 2, PI / 3, PI / 6,
    2 / PI, 4 / PI, 1 / PI, Math.sqrt(PI), E ** PI, PI ** E, E ** 2, 1 / E, Math.sqrt(E), Math.log(PI), 0.5772156649, 1.2020569, 0.9159655, PI / (2 * SQRT2), (2 * SQRT2) / PI,
    9.80665, 6.6743e-11, 1.25663706e-6, 8.8541878e-12, 1.602176634e-19, 9.1093837e-31, 1.67262192e-27, 6.02214076e23, 8.314462618, 1.380649e-23, 6.62607015e-34,
    1.054571817e-34, 299792458, 101325, 273.15, 96485.33, 5.670374e-8, 2.897771955e-3, 376.73, 0.02585, 0.0257, 1.12, 1.1, 0.0821]) addSig(c, true)
  // 课本里成表的值（只收这些「家族」，不做大范围的函数 × 自变量：三位有效数字一共才 900 个，收太多就什么都不算少见了）
  for (const x of [...range(1, 10), 0.5, 1.5, 2.5]) for (const v of [Math.sqrt(x), Math.log(x), Math.log10(x), Math.log2(x), PI * x, PI / x, x / PI]) addSig(v)
  for (const x of [SQRT2, 2, 3, 4, 5, 8, 10, 0.5, 1 / SQRT2, 0.1, 1.5, 100, 1000]) { addSig(20 * Math.log10(x)); addSig(10 * Math.log10(x)) }   // dB
  for (const v of [2 * PI, 1 / (2 * PI)]) addSig(v)                                                                               // ω = 2πf、f = 1/(2πRC)，按有效数字比 = 各个十的倍数都算
  for (const k of range(1, 10)) for (const v of [Math.exp(k), Math.exp(-k), 1 - Math.exp(-k), Math.exp(-k / 2), 1 - Math.exp(-k / 2)]) addSig(v)   // RC 充放电
  for (const p of [0.1, 0.5, 0.63, 0.9, 0.95, 0.99, 0.999]) addSig(-Math.log(1 - p))                                              // 几个 τ
  addSig(Math.log(9))
  // 三角函数：每 15°（还有 18°、36° 那一组）；弧度；3-4-5 三角形；一阶低通的相位
  for (const d of [...range(15, 75, 15), 18, 36, 54, 72]) for (const v of [Math.sin(rad(d)), Math.cos(rad(d)), Math.tan(rad(d)), rad(d)]) addSig(v)
  for (const r of [3 / 4, 4 / 3, 5 / 12, 12 / 5, 0.01, 0.1, 0.5, 2, 10, 100]) addSig(deg(Math.atan(r)))
  // 分数 p/q（q ≤ 8）、4/(nπ)（方波的傅里叶系数）
  for (const q of range(2, 8)) for (const p of range(1, 2 * q)) addSig(p / q)
  for (const n of range(1, 15, 2)) addSig(4 / (n * PI))
  // 课本里成表的计算（4 位有效数字起）：每一度的三角函数；一阶低通的 |H|、dB、相位；复利 / 欧拉法 (1+p)^n（1.1^n 从 3 位起）；
  // 二分法的中点、cos x = x 的不动点迭代、x³ = 2 的牛顿迭代
  for (const d of range(1, 89)) for (const v of [Math.sin(rad(d)), Math.cos(rad(d)), Math.tan(rad(d))]) addSig(v, false, 4)
  for (const x of [0.01, 0.1, 0.2, 0.25, 0.5, 1, 2, 4, 5, 10, 20, 100]) for (const v of [1 / Math.sqrt(1 + x * x), 20 * Math.log10(1 / Math.sqrt(1 + x * x)), deg(Math.atan(x))]) addSig(v, false, 4)
  for (const p of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.2, 0.5]) for (const n of range(1, 20)) addSig((1 + p) ** n, false, p === 0.1 ? 3 : 4)
  for (const [f, a0, b0] of [[(x) => x * x - 2, 1, 2], [(x) => x * x - 3, 1, 2], [(x) => x * x - 5, 2, 3], [(x) => x ** 3 - 2, 1, 2], [(x) => Math.cos(x) - x, 0, 1], [(x) => x ** 3 - x - 1, 1, 2]]) {
    let a = a0, b = b0
    for (let i = 0; i < 20; i += 1) { const m = (a + b) / 2; addSig(m, false, 4); if (f(a) * f(m) <= 0) b = m; else a = m }
  }
  for (const x0 of [0, 0.5, 1]) { let x = x0; for (let i = 0; i < 40; i += 1) { x = Math.cos(x); addSig(x, false, 4) } }
  for (const x0 of [1, 1.5, 2]) { let x = x0; for (let i = 0; i < 6; i += 1) { x = x - (x ** 3 - 2) / (3 * x * x); addSig(x, false, 4) } }
  // 级数、数列：部分和、1/k!、(1±1/n)^n、Heron、斐波那契的比
  let f = 1, sE = 0, sH = 0, sB = 0, sG2 = 0, sG3 = 0, sAH = 0, sL = 0
  for (const k of range(0, 20)) {
    if (k > 0) f *= k
    addSig(1 / f); sE += 1 / f; addSig(sE)
    if (k > 0) { sH += 1 / k; sB += 1 / (k * k); sAH += (k % 2 ? 1 : -1) / k; addSig(sH); addSig(sB); addSig(sAH) }
    sG2 += 0.5 ** k; sG3 += (1 / 3) ** k; sL += (k % 2 ? -1 : 1) / (2 * k + 1)
    for (const v of [sG2, sG2 - 1, sG3, sG3 - 1, sL, 4 * sL]) addSig(v)
  }
  for (const n of [...range(1, 20), 50, 100, 365, 1000, 1e4, 1e5, 1e6]) { addSig((1 + 1 / n) ** n); addSig((1 - 1 / n) ** n) }
  for (const a of [2, 3, 5, 7, 10]) for (let x0 of [1, 2, a]) { let x = x0; for (let i = 0; i < 6; i += 1) { x = (x + a / x) / 2; addSig(x) } }
  let fa = 1, fb = 1
  for (let i = 0; i < 30; i += 1) { CANON_INT.add(String(fb)); addSig(fb / fa); addSig(fa / fb); [fa, fb] = [fb, fa + fb] }
  // 电工：市电 / 常用电压的 √2、√3、2√2 倍；ω = 2π·50 / 60；1/√10、1/(2π√10)
  for (const u of [1, 5, 10, 12, 24, 48, 100, 110, 115, 120, 220, 230, 240, 380, 400, 690]) for (const v of [u * SQRT2, u / SQRT2, u * SQRT3, u / SQRT3, 2 * SQRT2 * u]) addSig(v)
  for (const v of [2 * PI * 50, 2 * PI * 60, 1 / (2 * PI * Math.sqrt(10)), 2 * PI * Math.sqrt(10), 1 / Math.sqrt(10)]) addSig(v)
  // 整数家族
  let fac = 1
  for (const n of range(1, 12)) { fac *= n; CANON_INT.add(String(fac)) }
  for (const n of range(1, 100)) { CANON_INT.add(String(n * n)); CANON_INT.add(String((n * (n + 1)) / 2)) }
  for (const n of range(1, 30)) CANON_INT.add(String(n ** 3))
  for (const n of range(1, 24)) { CANON_INT.add(String(2 ** n)); CANON_INT.add(String(2 ** n - 1)) }
  for (const n of range(1, 12)) CANON_INT.add(String(3 ** n))
  for (const n of range(1, 9)) CANON_INT.add(String(5 ** n))
  for (let n = 2; n < 1000; n += 1) { let p = true; for (let d = 2; d * d <= n; d += 1) if (n % d === 0) { p = false; break } if (p) CANON_INT.add(String(n)) }
  for (const n of range(1, 20)) { let c = 1; for (const k of range(0, n)) { CANON_INT.add(String(c)); c = (c * (n - k)) / (k + 1) } }
  for (const v of [360, 720, 1440, 3600, 86400, 365, 366, 1024, 65535, 65536, 255, 511, 1023, 496, 8128]) CANON_INT.add(String(v))
}

/** 「少见」的数字：三位以上有效数字，而且不是常数 / 标准值 / 经典例子（同一套有效数字的缩放、百分数都算） */
export function rareNumber(v) {
  const sig = sigDigits(v)
  return sig.length >= 3 && !CANON_SIG.has(sig) && !CANON_INT.has(String(v))
}

// ─────────────── 剧本 ───────────────
const flat = (v, out = []) => {
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'number') out.push(String(v))
  else if (Array.isArray(v)) for (const x of v) flat(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) flat(x, out)
  return out
}
/** 剧本里观众会看到 / 听到的文字，按场景分开、每处再按行分开（和 originality.mjs 的 scriptText 同样的字段；标题、简介、封面算一处） */
export function scriptParts(script) {
  const s = script && typeof script === 'object' ? script : {}
  const part = (where, ...xs) => { const lines = flat(xs); return { where, lines, text: lines.join('\n') } }
  const parts = [part('标题 / 简介 / 封面', s.title, s.desc, s.cover?.text)]
  const scenes = [...(Array.isArray(s.scenes) ? s.scenes : []), ...(Array.isArray(s.segments) ? s.segments.map((x) => ({ lines: [{ text: x?.text }] })) : [])]
  scenes.forEach((sc, i) => {
    if (!sc || typeof sc !== 'object') return
    // 便签（v0.11.15）的字和小标题也算这个场景里观众看到的字（和 scriptText 一样紧跟幻灯片）
    parts.push(part(`第 ${i + 1} 个场景`, sc.slide?.title, sc.slide?.bullets, sc.slide?.note, sc.note?.text, sc.note?.label, Array.isArray(sc.lines) ? sc.lines.map((l) => l?.text) : []))
  })
  return parts
}

// ─────────────── 材料库 ───────────────
const ID_RE = /^(ref-[0-9a-f]{12})\.(json|txt)$/
const cut40 = (s) => [...String(s)].slice(0, 40).join('')
/**
 * 主人放进来的参考材料：[{ id, name, source, chars, sha256, addedAt }]。目录不在 = 没有材料；读不了就抛错（调用方当「没查成」）。
 * tolerant（主人的 reference list / remove 用）：不抛错，坏掉的那份照样列出来 { id, name, broken: 原因 }，好让主人看到、删掉
 */
export function listReferences(dir = REFERENCE_DIR, { tolerant = false } = {}) {
  let names
  try { names = fs.readdirSync(dir) } catch (e) {
    if (e?.code === 'ENOENT') return []
    throw new Error(`参考材料目录读不了（${e?.code ?? e}）—— ${REF_HINT}`)
  }
  const ids = new Map()
  for (const f of names) { const m = f.match(ID_RE); if (m) ids.set(m[1], { ...ids.get(m[1]), [m[2]]: true }) }
  const out = []
  for (const [id, has] of [...ids].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!has.json) { if (tolerant) out.push({ id, name: id, broken: '只有文字、没有说明（存到一半？）—— 不算数' }); continue }
    let meta
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) } catch (e) {
      const why = `说明读不了（${e?.code ?? 'JSON 坏了'}）`
      if (tolerant) { out.push({ id, name: id, broken: why }); continue }
      throw new Error(`参考材料 ${id} 的${why} —— ${REF_HINT}`)
    }
    const r = { id, name: cut40(meta?.name ?? id), source: String(meta?.source ?? ''), chars: Number(meta?.chars) || 0, sha256: String(meta?.sha256 ?? ''), addedAt: meta?.addedAt ?? null }
    if (tolerant && !has.txt) r.broken = '抽出来的文字不见了 —— 她交审会一直被拦'
    out.push(r)
  }
  return out
}

export const referenceId = (name) => 'ref-' + crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12)

/** 材料的名字统一写法（NFC：「ä」不管是一个字还是 a + 两点，都算同一个名字） */
const nameOf = (name) => String(name ?? '').normalize('NFC').trim()

/** 材料的名字：给人看的（她也看得到），1–40 个字，不能有换行 / 控制字符 / 路径符号，不能以 - 开头，不能长得像别的材料的 id */
export function referenceNameProblem(name) {
  const n = nameOf(name)
  if (!n) return '名字不能是空的'
  if ([...n].length > 40) return '名字最多 40 个字（用 --name 起个短名字）'
  if (/[\p{C}\p{Zl}\p{Zp}\\/:*?"<>|]/u.test(n)) return '名字里不能有控制字符、换行或 \\ / : * ? " < > |'
  if (n.startsWith('-')) return '名字不能以 - 开头'
  if (/^ref-[0-9a-f]{12}$/.test(n)) return '名字不能是 ref- 加 12 位编号（那是 id 的写法）'
  return null
}

/** 一份材料里有多少能拿来比的东西（主人加材料时看：太少 = 多半是扫描版 PDF，查不了） */
export function referenceStats(text) {
  const t = String(text ?? '')
  return { words: latinWords(t).length, numbers: numbersOf(t, { notes: true }).length, han: hanOnly(t).length }
}
const hanOnly = (t) => norm(t).replace(/[^\p{Script=Han}]/gu, '')

/** 存一份材料（主人那边的 cli 用）：先写临时文件再改名，说明最后写（说明在 = 材料齐了）。replaced = 同名的旧材料（被换掉了） */
export function saveReference(name, text, source, dir = REFERENCE_DIR) {
  const why = referenceNameProblem(name)
  if (why) throw new Error(why)
  const raw = String(text ?? ''), body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw   // 记事本存的会带 BOM
  fs.mkdirSync(dir, { recursive: true })
  const id = referenceId(nameOf(name))
  const replaced = listReferences(dir, { tolerant: true }).find((r) => r.id === id) ?? null
  put(path.join(dir, `${id}.txt`), body)
  const meta = { name: nameOf(name), source: path.basename(String(source ?? '')), chars: [...body].length, sha256: crypto.createHash('sha256').update(body).digest('hex'), addedAt: new Date().toISOString() }
  put(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2) + '\n')
  return { id, ...meta, ...referenceStats(body), replaced }
}

/** 按名字或 id 删（坏掉的那份也能按 id 删）；先删说明：之后这份材料就不算了 */
export function removeReference(name, dir = REFERENCE_DIR) {
  const key = nameOf(name)
  const hit = listReferences(dir, { tolerant: true }).find((r) => r.name.normalize('NFC') === key || r.id === key)
  if (!hit) return null
  fs.rmSync(path.join(dir, `${hit.id}.json`), { force: true })
  fs.rmSync(path.join(dir, `${hit.id}.txt`), { force: true })
  return hit
}

/** 先写临时文件再改名（写到一半崩掉也不会留下半个文件） */
function put(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file) } finally { fs.rmSync(tmp, { force: true }) }
}

// ─────────────── 主人放行 ───────────────
// 她被参考材料拦了、但主人看过觉得没问题（比如是谁算都一样的标准表格）：主人用 reference allow <作品> 放行**这一份剧本**
// （按剧本的指纹记；她再改一个字就要重新放行）。放行的那几处变成提醒，主人审片时照样看得到。读不了材料不能放行（先修材料）。
// 记在 ~/.bili-ai/（她写不到），和频道设定的确认同一个做法
export const REFERENCE_ALLOW = path.join(HOME, '.bili-ai', 'reference-allow.json')
const readAllow = (file) => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {} } catch { return {} } }
/** 这个作品的这一份剧本（指纹）主人放行过没有 */
export function referenceAllowed(workId, scriptSha, file = REFERENCE_ALLOW) {
  const a = readAllow(file)[String(workId)]
  return a && scriptSha && a.sha === scriptSha ? a : null
}
/** 主人放行（sha = 这一份剧本的指纹）；sha 为 null = 取消放行 */
export function allowReference(workId, scriptSha, file = REFERENCE_ALLOW) {
  const all = readAllow(file)
  if (scriptSha) all[String(workId)] = { sha: scriptSha, at: new Date().toISOString() }
  else delete all[String(workId)]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  put(file, JSON.stringify(all, null, 2) + '\n')
}

// ─────────────── 比 ───────────────
/** 一份材料预先算好的东西（同一次查重里每份材料只读一次） */
function prepare(raw) {
  const text = cleanNotes(raw)
  // runs = 讲义里每 10 个连着的词；pos = 它们在讲义里的位置（算她一共搬了讲义的多少个词：同一句说两遍、句式一样的几句不重复算）
  const runs = new Set(), pos = new Map()
  const addRuns = (words, base) => {
    for (let i = 0; i + WORD_RUN <= words.length; i += 1) {
      const g = words.slice(i, i + WORD_RUN).join(' ')
      runs.add(g)
      const at = pos.get(g)
      if (!at) pos.set(g, [base + i]); else if (at.length < 8) at.push(base + i)
    }
  }
  const rawWords = latinWords(text)
  addRuns(rawWords, 0)
  const joined = dehyphen(text)
  if (joined !== text) addRuns(latinWords(joined), rawWords.length + 10 * REGION_WORDS)   // 原样的也留着：「Cauchy-\nSchwarz」这种本来就带连字符的（另起一套位置）
  // PDF 里词之间丢了空格，抽出来粘成一个（「dieserMatrix」），她照着打会带空格：讲义这边再留一份拆开的（又一套位置）。
  // 只拆「小写词紧跟大写开头的词」；后一个词小写开头的看下一段
  const unglued = joined.replace(/(\p{Ll}{2,})(?=\p{Lu}\p{Ll}{2,})/gu, '$1 ')
  if (unglued !== joined) addRuns(latinWords(unglued), 2 * (rawWords.length + 10 * REGION_WORDS))
  // 后一个词小写开头的（「unddie」）：按这份讲义自己的用词切开，再存一套（位置隔开 4 倍：上一套拆开后词会变多）。
  // 认得出的只是一部分（两边都不是虚词的、讲义别处没分开写过的认不出），剩下的靠提醒和主人审片
  const parted = splitLowerGlues(unglued)
  if (parted !== unglued) addRuns(latinWords(parted), 4 * (rawWords.length + 10 * REGION_WORDS))
  const windows = [], approx = []
  for (let i = 0; i < Math.max(1, text.length); i += NUM_STEP) {
    const nums = numbersOf(text.slice(i, i + NUM_WINDOW), { notes: true })
    windows.push(new Set(nums))
    // 四舍五入到少几位小数的写法（2.553 → 2.55、2.6）：只用来算比例，不算进「对上几个」
    const a = new Set()
    for (const v of nums) { const d = (v.split('.')[1] ?? '').length; for (let k = 0; k < d; k += 1) a.add(String(Number(Number(v).toFixed(k)))) }
    approx.push(a)
  }
  // 在这份讲义里到处都出现的数字：按不重叠的段数（够 20 段才算），超过 1/5 的段、至少 4 段
  const everywhere = new Set()
  const blocks = Math.ceil(text.length / NUM_WINDOW)
  if (blocks >= 20) {
    const seen = new Map()
    for (let i = 0; i < text.length; i += NUM_WINDOW) for (const v of new Set(numbersOf(text.slice(i, i + NUM_WINDOW), { notes: true }))) seen.set(v, (seen.get(v) ?? 0) + 1)
    for (const [v, k] of seen) if (k >= 4 && k > blocks / 5) everywhere.add(v)
  }
  return { runs, pos, windows, approx, everywhere, han: hanOnly(text) }
}

/** 这几段（她的词）盖住了讲义里多少个词：只数讲义里同一片（REGION_WORDS 个词以内）盖住的、每个位置只数一次 */
function covered(segs, ref) {
  const at = new Set()
  for (const seg of segs) {
    for (let i = 0; i + WORD_RUN <= seg.length; i += 1) for (const p of ref.pos.get(seg.slice(i, i + WORD_RUN).join(' ')) ?? []) for (let k = 0; k < WORD_RUN; k += 1) at.add(p + k)
  }
  const a = [...at].sort((x, y) => x - y)
  let best = 0
  for (let i = 0, j = 0; j < a.length; j += 1) { while (a[j] - a[i] >= REGION_WORDS) i += 1; best = Math.max(best, j - i + 1) }
  return best
}

/** 她这一处所有和材料原样一样的段（每段 ≥ WORD_RUN 个词、互不重叠、里面至少 6 个四个字母以上的词） */
function wordRuns(mine, ref) {
  const out = []
  for (let i = 0; i + WORD_RUN <= mine.length;) {
    if (!ref.runs.has(mine.slice(i, i + WORD_RUN).join(' '))) { i += 1; continue }
    let j = i + WORD_RUN
    // 往后延伸：每多一个词，再看最后 WORD_RUN 个词是不是也在材料里（不保证是同一处，只用来量长度）
    while (j < mine.length && ref.runs.has(mine.slice(j + 1 - WORD_RUN, j + 1).join(' '))) j += 1
    const seg = mine.slice(i, j)
    if (seg.filter((w) => w.length >= 4).length >= 6) out.push(seg)
    i = j
  }
  return out
}

/**
 * 她这一处的数字和材料比：
 *   拦 = 讲义同一片（连着三段，约 2000 字：一页长的例题也装得下）里 ≥ 4 个少见的数原样对上，
 *        而且再往外两段以内对上的（四舍五入到她那几位的也算）占她这几个少见的数 ≥ 60%
 *   提醒 = 同一段里 ≥ 4 个有辨识度的数对上、里面 ≥ 2 个少见的、占她这几个有辨识度的数 ≥ 60%
 */
function numberMatch(nums, ref) {
  const all = [...new Set(nums)]
  if (all.length < NUM_MIN) return null
  const rare = all.filter((x) => rareNumber(x) && !ref.everywhere.has(x))
  const W = ref.windows, inAny = (x, lo, hi, approx) => { for (let k = Math.max(0, lo); k <= Math.min(W.length - 1, hi); k += 1) if (W[k].has(x) || (approx && ref.approx[k].has(x))) return true; return false }
  let block = null
  if (rare.length >= NUM_MIN) {
    for (let i = 0; i < W.length; i += 1) {
      if (rare.filter((x) => inAny(x, i, i + 2, false)).length < NUM_MIN) continue
      const near = rare.filter((x) => inAny(x, i - 2, i + 4, true))
      if (near.length >= NUM_SHARE * rare.length && (!block || near.length > block.length)) block = near
    }
  }
  if (block) return { weak: false, numbers: block }
  let flag = null
  for (const w of ref.windows) {
    const inter = all.filter((x) => w.has(x))
    if (inter.length < NUM_MIN || inter.length < NUM_SHARE * all.length) continue
    if (inter.filter((x) => rare.includes(x)).length >= 2 && (!flag || inter.length > flag.length)) flag = inter
  }
  return flag ? { weak: true, numbers: flag } : null
}

/**
 * 剧本 vs 参考材料。返回 { hits, flags, errors, checked, refs }：
 *   · hits = 拦（照搬得多）；flags = 提醒（不拦，主人审片时看）；两种都只有她剧本里的字（sample / numbers），没有材料原文
 *   · 没有材料 = 没东西可比，不算错；材料读不出来 = 没查成 → 记进 errors，调用方据此拦下
 *   · refs = 比过的每份材料 { id, name, sha256 }（sha256 是这次真读到的文字的）：交审时记进队列，主人批准时看交审之后材料有没有变
 *   · ids：只比这几份（主人批准时只比交审之后新加 / 换过的）
 */
export function referenceOverlap(script, dir = REFERENCE_DIR, { ids = null } = {}) {
  const hits = [], flags = [], errors = [], checkedRefs = []
  let refs
  // 查重（不带 ids）：有一份坏了就整个算没查成（拦）；主人批准时只比指定的几份：坏的那几份记成没比成，别的照样比
  try { refs = ids ? listReferences(dir, { tolerant: true }) : listReferences(dir) } catch (e) { return { hits, flags, errors: [e.message], checked: 0, refs: checkedRefs } }
  if (ids) {
    refs = refs.filter((r) => ids.includes(r.id))
    for (const r of refs.filter((x) => x.broken)) errors.push(`参考材料「${r.name}」${r.broken} —— ${REF_HINT}`)
    refs = refs.filter((r) => !r.broken)
  }
  if (!refs.length) return { hits, flags, errors, checked: 0, refs: checkedRefs }
  const parts = scriptParts(script)
  const mineHan = hanOnly(parts.map((p) => p.text).join(''))
  const mineShingles = { m5: shingles(mineHan, 5), m8: shingles(mineHan, 8), m20: shingles(mineHan, 20) }
  const mineWords = parts.map((p) => latinWords(p.text))
  // 例题的已知量常常写在一句 / 一行里，一步一步讲时又会跨好几个场景：每一句、每一行、每个场景、连着的 2 / 3 / 4 个场景各看一遍
  const numberGroups = []
  for (const p of parts) {
    numberGroups.push({ where: p.where, nums: numbersOf(p.text) })
    for (const l of p.lines) {
      if (p.lines.length > 1) numberGroups.push({ where: p.where, nums: numbersOf(l) })
      const said = l.split(/[。！？；!?;]+/).filter((x) => x.trim())
      if (said.length > 1) for (const x of said) numberGroups.push({ where: p.where, nums: numbersOf(x) })
    }
  }
  for (const n of [2, 3, 4]) {
    for (let i = 1; i + n <= parts.length; i += 1) {
      const span = parts.slice(i, i + n)
      numberGroups.push({ where: n === 2 ? `${span[0].where}和${span[1].where}` : `${span[0].where}到${span[n - 1].where}`, nums: span.flatMap((p) => numbersOf(p.text)) })
    }
  }
  for (const r of refs) {
    let text
    try { text = fs.readFileSync(path.join(dir, `${r.id}.txt`), 'utf8') } catch (e) {
      errors.push(`参考材料「${r.name}」读不了（${e?.code ?? e}）—— ${REF_HINT}`)
      continue
    }
    checkedRefs.push({ id: r.id, name: r.name, sha256: crypto.createHash('sha256').update(text).digest('hex') })
    const ref = prepare(text)
    // ① 原样的德语 / 英语句子
    // 拦：最长的一段 ≥ 20 个词（而且真的盖住了讲义里 ≥ 20 个词）、或者几段一共盖住了讲义同一片里 ≥ 30 个词
    const runs = mineWords.flatMap((w) => wordRuns(w, ref))
    if (runs.length) {
      const longest = runs.reduce((a, b) => (b.length > a.length ? b : a))
      const total = covered(runs, ref)
      const h = { kind: 'reference-text', source: r.name, words: longest.length, total, sample: longest.join(' ').slice(0, 80) }
      ;((longest.length >= WORD_BLOCK && covered([longest], ref) >= WORD_BLOCK) || total >= WORD_TOTAL ? hits : flags).push(h)
    }
    // ② 照搬的例题数字（每份材料只报最重的一处）
    let num = null
    for (const g of numberGroups) {
      const m = numberMatch(g.nums, ref)
      if (m && (!num || (num.weak && !m.weak) || (num.weak === m.weak && m.numbers.length > num.numbers.length))) num = { where: g.where, ...m }
    }
    if (num) (num.weak ? flags : hits).push({ kind: 'reference-numbers', source: r.name, where: num.where, numbers: num.numbers.slice(0, 8), ...(num.weak ? { weak: true } : {}) })
    // ③ 中文材料：和字幕同一套
    if (ref.han.length >= CJK_MIN && mineHan.length >= 20) {
      const o = textOverlap(mineHan, ref.han, mineShingles)
      if (copiedTooMuch(o)) hits.push({ kind: 'reference-copied-text', source: r.name, overlap: Number(o.ratio.toFixed(3)), shared8: o.same8, shared5: o.same5, sample: o.sample.slice(0, 60) })
    }
  }
  return { hits, flags, errors, checked: refs.length, refs: checkedRefs }
}
