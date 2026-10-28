// 参考材料查重（2026-10-24）：主人用 reference add 放老师的讲义；她交审 / studio check 时和讲义比 ——
// 照搬得多就拦，一句原话 / 几个数字对上只提醒（主人审片时看）；公认的数值、经典例子、目录 / 页眉 / 章节号不算；报告里没有讲义原文；
// 她交审之后主人才加的材料，批准时（上传前）再和新材料比一遍，主人看过可以 --reference-ok
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const R = await import(pathToFileURL(path.join(root, 'tools/lib/reference.mjs')).href)

const SECRET = 'GEHEIMMARKER'   // 只在讲义里出现：报告、输出、她的作品目录里都不该有
const FILLER = (n) => Array.from({ length: n }, (_, i) => `Absatz ${i % 7 === 0 ? 'Hinweis' : 'Text'} ohne Zahlen hier`).join(' ')
const HEADER = 'Musterhochschule – Lehrstuhl für Angewandte Mathematik – Vorlesung Analysis für Ingenieurwissenschaften – Wintersemester – Skript'
const SATZ = 'Sei f eine auf dem abgeschlossenen Intervall stetige und im Inneren differenzierbare Funktion, dann existiert eine Zwischenstelle, an der die Ableitung genau der Steigung der Sekante durch die beiden Randpunkte des Intervalls entspricht.'
// 例题：4,37 kΩ / 518 Ω / 13,02 V / 0,372 mF，结果 2,553 mA / 1,887 s —— 都是「少见」的数；4,7 kΩ、12 V 是标准值
const SKRIPT = [
  HEADER,
  'Inhaltsverzeichnis',
  '3.12 Der Mittelwertsatz der Differentialrechnung ........ 45',
  '4.21 Taylorreihen und Restglied ........ 61',
  '5.13 Grundlagen der Schaltungsanalyse ........ 80',
  '3.12 Der Mittelwertsatz',
  'Satz 3.12 (Mittelwertsatz der Differentialrechnung). ' + SATZ.replace('abgeschlossenen', 'abgeschlos-\nsenen'),
  `Beispiel. Wir betrachten die Schaltung mit R1 = 4,37 kΩ, R2 = 518 Ω, R3 = 4,7 kΩ, U0 = 13,02 V, U1 = 12 V und C = 0,372 mF. Ergebnis: I = 2,553 mA und τ = 1,887 s. ${SECRET} ist nur hier.`,
  HEADER,
  'Die Gr¨oße der Spannung h¨angt vom Widerstand ab und wird im n¨achsten Abschnitt ausf¨uhrlich hergeleitet werden, wobei wir die Kirchhoffschen Regeln f¨ur Knoten und Maschen verwenden.',
  'sin x cos x tan x ln x exp x lim sup det dim ker span rang',
  FILLER(200),
  HEADER,
  'Netz: 230 V, 50 Hz, Spitzenwert 325 V, Kreisfrequenz 314. Determinante: a11 a22 - a12 a21. Winkel 30, 45, 60 und 90 Grad. ε0 = 8,854·10⁻¹² und e = 1,602·10⁻¹⁹.',
  'Aufladung: nach τ 63,2 %, nach 2τ 86,5 %, nach 3τ 95,0 %, nach 4τ 98,2 %, nach 5τ 99,3 %. Grenzfrequenz 159 Hz, 1,59 kHz, 15,9 kHz; −3,01 dB und −6,02 dB.',
  'Fibonacci: 13, 21, 34, 55, 89, 144, 233. Taylor: 1/6 ≈ 0,1667, 1/24 ≈ 0,0417, 1/120 ≈ 0,0083; e ≈ 2,7183.',
  'Bisektion für √2: 1,5; 1,25; 1,375; 1,4375; 1,40625; 1,421875; 1,4140625. Fixpunkt von cos: 0,5403; 0,8576; 0,6543; 0,7935; 0,7014; 0,7640; 0,7391. Zins 5 %: 1,1025; 1,1576; 1,2155; 1,2763.',
  'Standardwerte: R = 4,7 kΩ, 330 Ω, U = 12 V, C = 0,25 mF.',
  FILLER(60),
  'Weiteres Beispiel: 1, 2, 3, 5 und 10 sind keine besonderen Zahlen.',
  'Fernes Beispiel 81,37', FILLER(150), 'und 6437', FILLER(150), 'und 0,0337', FILLER(150), 'und 4731.',
].join('\n')
const HAN = '这是一段中文参考材料，讲的是线性代数里矩阵的秩，以及秩和线性方程组解的个数之间的关系。'.repeat(6)

const script = (scenes, extra = {}) => ({ title: '测试', scenes, ...extra })
const line = (...texts) => ({ lines: texts.map((text) => ({ text })) })
function refDir(t, files = { 'Analysis Skript': SKRIPT }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-ref-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) R.saveReference(name, text, name + '.txt', d)
  return d
}
const kinds = (xs) => xs.map((h) => h.kind).sort()
const check = (s, d) => R.referenceOverlap(s, d)
const blocks = (s, d, kind) => { const r = check(s, d); assert.deepEqual(kinds(r.hits), [kind], JSON.stringify(s)); return r.hits[0] }
const flags = (s, d, kind) => { const r = check(s, d); assert.deepEqual(r.hits, [], JSON.stringify(s)); assert.deepEqual(kinds(r.flags), [kind], JSON.stringify(s)); return r.flags[0] }
const nothing = (s, d) => { const r = check(s, d); assert.deepEqual([r.hits, r.flags], [[], []], JSON.stringify(s)) }

test('numbers: Chinese commas and tuples separate, indices / exponents / section numbers do not count, thousands and decimal commas are read sensibly', () => {
  assert.deepEqual(R.numbersOf('4,70 und 4.7 und 2026 und 3 und 12 und 1999,5'), ['4.7', '4.7', '12', '1999.5'])
  assert.deepEqual(R.numbersOf('电阻4.37千欧，518欧，电源13.02伏，电容0.372毫法。'), ['4.37', '518', '13.02', '0.372'])
  assert.deepEqual(R.numbersOf('数值依次是13.02，518，4.37，0.372'), ['13.02', '518', '4.37', '0.372'])
  assert.deepEqual(R.numbersOf('4.37千欧,518欧、13.02伏；0.372毫法'), ['4.37', '518', '13.02', '0.372'])
  assert.deepEqual(R.numbersOf('13.02,518,4.37 和 (13,21) 和 1,2,3'), ['13.02', '518', '4.37', '13', '21'])   // 她的中文：这些逗号都是分隔
  assert.deepEqual(R.numbersOf('a11 a₁₂ x_13 R14 Z21 sin30 ε12 10⁻¹² 1.6e-19 2E17 10^-19 10^{-21} 10^23 x²³'), ['1.6'])   // 1.6e-19 只留底数
  assert.deepEqual(R.numbersOf('\\SI{17.5}{\\volt} 和 \\frac{4.37}{2}'), ['17.5', '4.37'])
  assert.deepEqual(R.numbersOf('U = -12 V, I = −0,37 A'), ['12', '0.37'])
  assert.deepEqual(R.numbersOf('定理 3.12、第 4.21 节、例 3、共 300 页：13.02 伏'), ['13.02'])
  assert.deepEqual([...new Set(R.numbersOf('Satz 3.12, (2.14), S. 45, Abb. 4.21, vgl. Satz 5.13, 1 ms. 4731', { notes: true }))], ['4731'])
  assert.deepEqual(R.numbersOf('10\u202F000 und 4{,}7 und 12 330'), ['10000', '4.7', '12', '330'])   // 细空格是千位，普通空格是两个数
  assert.deepEqual(R.numbersOf('10,000 元，1.000'), ['10000'])                                        // 她的中文：逗号是千位
  assert.deepEqual([...new Set(R.numbersOf('1.000 und 4,700 und (0,5)', { notes: true }))].sort(), ['0.5', '1000', '4.7', '4700'])   // 讲义：两种读法
  assert.deepEqual(R.numbersOf('13' + String.fromCharCode(0x200b) + '.02 伏'), ['13.02'])             // 数字中间塞看不见的字符
})

test('rare numbers: standard constants, derived standard values and classic sequences are never "rare"', () => {
  for (const v of ['230', '50', '325', '314', '45', '360', '8.854', '1.602', '3.14', '0.707', '4.7', '330', '12', '0.25', '2.2', '100', '30', '0.5', '4.3', '510', '17.5', '0.37',
    '63.2', '86.5', '95', '98.2', '99.3', '159', '1.59', '15.9', '0.159', '3.01', '6.02', '325.3', '650.5', '230.9', '565.7', '0.637', '1.11', '1.273', '0.424', '84.3', '5.71', '53.13', '36.87',
    '0.693', '2.303', '4.605', '2.197', '0.632', '0.368', '62.8', '628', '6283', '70.7', '141', '1.414', '1.732', '0.785', '0.318',
    '144', '233', '377', '1.618', '0.1667', '0.0417', '2.7083', '2.7167', '2.7183', '1.4167', '1.414216', '2.25', '2.5937', '2.7048', '1.6449', '40320', '5040', '1.0986', '2.3026', '0.301', '2.2361', '3.1623',
    '0.875', '0.9375', '0.96875', '997', '1024']) assert.equal(R.rareNumber(v), false, v)
  for (const v of ['4.37', '518', '13.02', '0.372', '2.553', '1.887', '6437', '4731']) assert.equal(R.rareNumber(v), true, v)
})

test('words: one standard sentence (10–19 words) is only a reminder; a copied paragraph (≥ 20, or ≥ 30 in pieces) blocks; PDF line breaks, split umlauts, invisible characters, title and segments are all handled', (t) => {
  const d = refDir(t)
  const eleven = 'Sei f eine auf dem abgeschlossenen Intervall stetige und im Inneren differenzierbare Funktion'
  let h = flags(script([{ slide: { title: 'Mittelwertsatz', bullets: [eleven] }, lines: [{ text: '这一页讲中值定理。' }] }]), d, 'reference-text')
  assert.equal(h.words, 11); assert.equal(h.source, 'Analysis Skript')
  h = blocks(script([{ slide: { bullets: [SATZ] } }]), d, 'reference-text'); assert.ok(h.words >= 25, String(h.words))
  // 两段各不到 20 个词，加起来 ≥ 30 → 拦
  const nineteen = 'Die Größe der Spannung hängt vom Widerstand ab und wird im nächsten Abschnitt ausführlich hergeleitet werden, wobei wir die Kirchhoffschen'
  assert.equal(flags(script([line(nineteen)]), d, 'reference-text').words, 19)
  h = blocks(script([line(eleven), line(nineteen)]), d, 'reference-text'); assert.equal(h.total, 30)
  // 同一句定义说两遍（定义页 + 复习页、幻灯片 + 角注）：讲义里还是那 19 个词 → 只提醒
  assert.equal(flags(script([line(nineteen), line('复习一下'), line(nineteen)]), d, 'reference-text').total, 19)
  assert.equal(flags(script([{ slide: { bullets: [nineteen], note: nineteen } }]), d, 'reference-text').total, 19)
  // 讲义里拆开的变音（PDF 抽出来的「Gr¨oße」）和她写的正常「Größe」对得上；词中间塞看不见的字符也一样
  flags(script([line('Die Größe der Spannung hängt vom Widerstand ab und wird im nächsten Abschnitt')]), d, 'reference-text')
  const zw = String.fromCharCode(0x200b)
  flags(script([line(`Sei f eine auf dem abge${zw}schlossenen Inter${zw}vall stetige und im Inneren differenzierbare Funktion`)]), d, 'reference-text')
  flags({ title: 'x', desc: eleven, scenes: [] }, d, 'reference-text')
  flags({ title: 'x', segments: [{ text: eleven }] }, d, 'reference-text')
  // 不算：9 个词、公式行（单位 / 函数名）、每页都有的页眉（她写学校名）、翻成中文
  nothing(script([{ slide: { bullets: ['Sei f eine auf dem abgeschlossenen Intervall stetige und im'] } }]), d)
  nothing(script([{ slide: { bullets: ['sin x cos x tan x ln x exp x lim sup det dim ker span rang'] } }]), d)
  nothing({ title: 'x', desc: HEADER, scenes: [] }, d)
  nothing(script([line('如果函数在闭区间上连续、在内部可导，就一定有一个中间点。')]), d)
})

test('words: a PDF that lost the space between two words ("dieserMatrix") still catches a copy typed with the space, also next to a line-break hyphen; a glue whose second word starts lowercase is not split by letter case', (t) => {
  // 粘连前 14 个词、后 12 个词（「Matrix」按 LaTeX 命令不算词）：各自不到 20、加起来不到 30 —— 不拆开的话只是提醒
  const glued = 'Nach Wahl von Basen wird jede lineare Abbildung durch eine Matrix beschrieben, und die Spalten dieserMatrix sind genau die Bilder der gegebenen Basis-\nvektoren, geschrieben in Koordinaten des Zielraums.'
  const typed = 'Nach Wahl von Basen wird jede lineare Abbildung durch eine Matrix beschrieben, und die Spalten dieser Matrix sind genau die Bilder der gegebenen Basisvektoren, geschrieben in Koordinaten des Zielraums.'
  const d = refDir(t, { 'Algebra Skript': [FILLER(60), glued, FILLER(60)].join('\n') })
  let h = blocks(script([line('我们来看：' + typed)]), d, 'reference-text'); assert.equal(h.words, 27)
  h = blocks(script([line(typed.replace('dieser Matrix', 'dieserMatrix'))]), d, 'reference-text')   // 照着抽出来的样子打（粘着）也拦
  // 只抄粘连后面那半句：还是只提醒
  flags(script([line('sind genau die Bilder der gegebenen Basisvektoren, geschrieben in Koordinaten des Zielraums')]), d, 'reference-text')
  // 后一个词小写开头的粘连（「Spaltendieser」）按大小写拆不了，讲义别处也没分开写过（见下一个测试）：她带空格打，两半各不到 20 个词 → 只提醒
  const d2 = refDir(t, { 'Algebra Skript': [FILLER(60), glued.replace('die Spalten dieserMatrix', 'die Spaltendieser Matrix'), FILLER(60)].join('\n') })
  flags(script([line(typed)]), d2, 'reference-text')
})

test('words: a glue whose second word starts lowercase ("unddie") is split by the notes\' own usage — one half a function word, the pair written apart elsewhere in the same notes; otherwise it is left alone', (t) => {
  // 粘连前 11 个词、后 12 个词：各自不到 20、加起来不到 30 —— 不切开只是提醒
  const glued = 'Gesucht sind alle Lösungen eines homogenen linearen Gleichungssystems mit reellen Koeffizienten, unddie Menge dieser Lösungen bildet stets einen Untervektorraum des Raumes aller passenden Spaltenvektoren.'
  const typed = glued.replace('unddie', 'und die')
  const apart = 'Wir addieren zwei Lösungen und die Summe ist wieder eine Lösung, und die Vielfachen ebenso.'   // 讲义别处分开写过「und die」
  const d = refDir(t, { 'Algebra Skript': [FILLER(60), glued, FILLER(30), apart, FILLER(60)].join('\n') })
  const h = blocks(script([line('我们来看：' + typed)]), d, 'reference-text'); assert.equal(h.words, 25)
  blocks(script([line(glued)]), d, 'reference-text')   // 照抽出来粘着的样子打也拦
  flags(script([line('Menge dieser Lösungen bildet stets einen Untervektorraum des Raumes aller passenden Spaltenvektoren')]), d, 'reference-text')   // 只抄后半句：还是提醒
  // 「und」「die」都单独出现过，但讲义里从没连着写过：不猜，不切 → 只提醒
  const never = 'Die Summe ist eine Lösung und ebenso die Vielfachen, die Differenz und das Negative.'
  const d2 = refDir(t, { 'Algebra Skript': [FILLER(60), glued, FILLER(30), never, FILLER(60)].join('\n') })
  flags(script([line(typed)]), d2, 'reference-text')
  // 两半都不是虚词的（两个形容词粘成「homogenenlinearen」）：讲义别处分开写过也不切 → 只提醒（认不出的那一类）
  const adjectives = typed.replace('homogenen linearen', 'homogenenlinearen')
  const d3 = refDir(t, { 'Algebra Skript': [FILLER(60), adjectives, FILLER(30), 'Die homogenen linearen Systeme und die homogenen linearen Gleichungen.', FILLER(60)].join('\n') })
  flags(script([line(typed)]), d3, 'reference-text')
})

test('numbers: a copied worked example (≥ 4 unusual numbers) blocks however it is written; a few matching numbers are only a reminder; standard tables, indices, section numbers and far-apart numbers are nothing', (t) => {
  const d = refDir(t)
  for (const s of [
    script([line('电阻 4.37 千欧，另一个 518 欧，电源 13.02 伏，电容 0.372 毫法，我们来算一下。')]),
    script([line('电阻4.37千欧，518欧，电源13.02伏，电容0.372毫法，结果电流2.553毫安。')]),
    script([line('数值依次是13.02，518，4.37，0.372')]),
    script([line('已知：4.37kΩ，518Ω，13.02V，0.372mF')]),
    script([line('电阻是 4.37 千欧和 518 欧。'), line('电源 13.02 伏，电容 0.372 毫法。')]),
    script([line('电阻是 4.37 千欧和 518 欧。'), { slide: { bullets: ['电源 13.02 伏', '电容 0.372 毫法'] } }]),
    // 同一个场景里另一行是她自己的四个数：按行看照样对上
    script([line('已知 R1=4.37kΩ，R2=518Ω，U0=13.02V，C=0.372mF。', '我自己再加一题：13.71、2.913、887、61.37。')]),
    // 同一行里后一句全是她自己的数：按句看照样对上
    script([line('已知 R1=4.37kΩ，R2=518Ω，U0=13.02V，C=0.372mF。我自己再加一题：13.71、2.91、61.37、8.63、5.27、9.46。')]),
    // 一步一个场景（每个场景只有一个数）：连着 4 个场景合起来看
    script([line('第一步，电阻是 4.37 千欧。'), line('第二步，另一个是 518 欧。'), line('第三步，电源 13.02 伏。'), line('第四步，电容 0.372 毫法。')]),
  ]) {
    const h = blocks(s, d, 'reference-numbers')
    assert.ok(['0.372', '13.02', '4.37', '518'].every((x) => h.numbers.includes(x)), JSON.stringify(h))
  }
  // 结果四舍五入了（1.887 → 1.89）也算进比例；只看原样的话 4/7 不到 60%
  for (const v of ['1.89', '9.46', '8.63']) assert.equal(R.rareNumber(v), true, v)
  blocks(script([line('4.37 千欧、518 欧、13.02 伏、0.372 毫法，时间常数 1.89 秒；换成 9.46 伏、8.63 毫法再算一遍。')]), d, 'reference-numbers')
  // 只提醒：对上 4 个，但只有 2 个少见的（另外两个是标准值）
  const f = flags(script([line('4.7 千欧、12 伏、4.37 千欧、518 欧')]), d, 'reference-numbers')
  assert.equal(f.weak, true); assert.deepEqual([...f.numbers].sort(), ['12', '4.37', '4.7', '518'])
  for (const s of [
    script([line('电容充电：过一个 τ 到 63.2%，两个 τ 到 86.5%，三个 τ 到 95%，四个 τ 到 98.2%，五个 τ 到 99.3%。')]),
    script([line('1 千欧配 1 微法，截止频率约 159 赫兹；配 100 纳法是 1.59 千赫，配 10 纳法是 15.9 千赫；这时候衰减 3.01 分贝、6.02 分贝。')]),
    script([line('斐波那契数列 13、21、34、55、89、144、233；e 的泰勒系数 1/6≈0.1667、1/24≈0.0417、1/120≈0.0083，e≈2.7183。')]),
    script([line('用二分法找 √2：中点依次是 1.5、1.25、1.375、1.4375、1.40625、1.421875、1.4140625。')]),
    script([line('解 cos x = x：反复取余弦，0.5403、0.8576、0.6543、0.7935、0.7014、0.7640，最后停在 0.7391。')]),
    script([line('年利率 5%：两年 1.1025 倍，三年 1.1576 倍，四年 1.2155 倍，五年 1.2763 倍。')]),
    script([line('家里插座是 230 伏、50 赫兹，峰值约 325 伏，角频率约等于 314。')]),
    script([line('二阶行列式：a11·a22 − a12·a21，也写成 a₁₁a₂₂ − a₁₂a₂₁。')]),
    script([line('特殊角：30、45、60、90 度。')]),
    script([line('真空介电常数 8.854×10⁻¹²，电子电荷 1.602×10⁻¹⁹，也写成 1.602e-19。')]),
    script([line('常见的电阻 4.7 千欧、330 欧，电源 12 伏，电容 0.25 毫法。')]),
    script([{ slide: { title: '这周讲什么', bullets: ['定理 3.12 中值定理', '第 4.21 节 泰勒', '第 5.13 节 电路分析', '定理 6.17'] } }]),
    script([{ slide: { bullets: ['3.12 Mittelwertsatz', '4.21 Taylorreihen', '5.13 Schaltungsanalyse'] } }]),
    script([line('1、2、3、5 和 10 都很常见。')]),
    script([line('81.37、6437、0.0337、4731 这几个数。')]),                     // 讲义里隔得很远
    script([line('4.37 千欧、518 欧、13.02 伏，换成 99.17 伏试试。')]),          // 只对上 3 个
  ]) nothing(s, d)
})

test('numbers: a number used all over a long Skript is not evidence of copying; in a short sheet nothing counts as "everywhere"', (t) => {
  const para = (i) => `Abschnitt ${i}: Die Versorgung ist 13,02 V. ${FILLER(40)}`
  const ex = 'Beispiel: R1 = 4,37 kΩ, R2 = 518 Ω, U0 = 13,02 V, C = 0,372 mF, I = 2,553 mA.'
  const d = refDir(t, { 'Schaltungen Skript': [...Array.from({ length: 30 }, (_, i) => para(i)), ex].join('\n'), 'Blatt 3': [para(1), para(2), ex].join('\n') })
  // 13.02 在长讲义里到处都是：剩下 4 个少见的照样拦；只剩 3 个就只是提醒
  let r = check(script([line('4.37 千欧、518 欧、13.02 伏、0.372 毫法、2.553 毫安')]), d)
  assert.deepEqual(r.hits.map((h) => h.source).sort(), ['Blatt 3', 'Schaltungen Skript'])
  r = check(script([line('4.37 千欧、518 欧、13.02 伏、0.372 毫法')]), d)
  assert.deepEqual(r.hits.map((h) => h.source), ['Blatt 3']); assert.deepEqual(r.flags.map((h) => h.source), ['Schaltungen Skript'])
})

test('reference overlap: Chinese material uses the same rules as subtitles (only from 200 Han characters); a broken reference counts as not checked; ids limit what is compared', (t) => {
  const d = refDir(t, { '线代讲义': HAN, '短的': HAN.slice(0, 150), 'Analysis Skript': SKRIPT })
  const s = script([line('今天说一下线性代数里矩阵的秩，以及秩和线性方程组解的个数之间的关系，这个很重要。')])
  let r = check(s, d)
  assert.deepEqual(kinds(r.hits), ['reference-copied-text']); assert.equal(r.hits[0].source, '线代讲义'); assert.ok(r.hits[0].sample.length >= 20)
  assert.equal(r.checked, 3); assert.deepEqual(r.refs.map((x) => x.name).sort(), ['Analysis Skript', '短的', '线代讲义']); assert.match(r.refs[0].sha256, /^[0-9a-f]{64}$/)
  r = R.referenceOverlap(s, d, { ids: [R.referenceId('Analysis Skript')] }); assert.equal(r.checked, 1); assert.deepEqual(r.hits, [])
  fs.rmSync(path.join(d, R.referenceId('线代讲义') + '.txt'))
  const broken = check(script([line('随便一句')]), d)
  assert.equal(broken.hits.length, 0); assert.match(broken.errors.join(), /参考材料「线代讲义」读不了.*reference list/)
  fs.writeFileSync(path.join(d, R.referenceId('短的') + '.json'), '{not json')
  assert.match(check(script([line('随便一句')]), d).errors.join(), /JSON 坏了.*reference list/)
  assert.deepEqual(check(script([line('随便一句')]), path.join(d, 'nope')), { hits: [], flags: [], errors: [], checked: 0, refs: [] })
})

test('reference store: names are checked, text is saved without a BOM, re-adding replaces and says so, broken entries are listed and removable by id', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-ref-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  for (const bad of ['', '   ', 'a/b', 'x\ny', 'C:dings', '--name', '-x', 'x'.repeat(41), 'a' + String.fromCharCode(0x2028) + 'b', 'ref-0123456789ab']) assert.throws(() => R.saveReference(bad, 'text', 'f.txt', d), undefined, JSON.stringify(bad))
  // 「ä」写成一个字和写成 a + 两点，是同一个名字
  const nfc = R.saveReference('Übung', 'eins', 'u.txt', d), nfd = R.saveReference('Übung'.normalize('NFD'), 'zwei', 'u.txt', d)
  assert.equal(nfd.id, nfc.id); assert.ok(nfd.replaced); assert.equal(R.removeReference('Übung'.normalize('NFD'), d).id, nfc.id)
  const s = R.saveReference(' Analysis Skript ', String.fromCharCode(0xfeff) + 'Hallo Welt 4,7', 'C:/x/analysis.pdf', d)
  assert.equal(s.name, 'Analysis Skript'); assert.equal(s.source, 'analysis.pdf'); assert.equal(s.replaced, null)
  assert.equal(fs.readFileSync(path.join(d, s.id + '.txt'), 'utf8'), 'Hallo Welt 4,7')
  const again = R.saveReference('Analysis Skript', 'neu', 'b.txt', d)
  assert.equal(again.replaced.source, 'analysis.pdf')
  assert.equal(R.listReferences(d).length, 1); assert.equal(R.listReferences(d)[0].chars, 3)
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [])
  // 40 个字（按字算，不按 UTF-16 算）：列出来、按名字删都对得上
  const emoji = '😀'.repeat(40)
  R.saveReference(emoji, 'x', 'e.txt', d); assert.equal(R.listReferences(d).find((r) => r.name === emoji)?.name, emoji); assert.equal(R.removeReference(emoji, d)?.name, emoji)
  // 坏掉的：查重时抛错（= 拦）；主人列表时照样列出来、能按 id 删
  const b = R.saveReference('Kaputt', 'x', 'k.txt', d), m = R.saveReference('Ohne Text', 'y', 'o.txt', d)
  fs.writeFileSync(path.join(d, b.id + '.json'), '{')
  fs.rmSync(path.join(d, m.id + '.txt'))
  fs.writeFileSync(path.join(d, 'ref-0123456789ab.txt'), 'verwaist')
  assert.throws(() => R.listReferences(d), /JSON 坏了/)
  const all = R.listReferences(d, { tolerant: true })
  assert.deepEqual(all.filter((x) => x.broken).map((x) => x.id).sort(), [b.id, m.id, 'ref-0123456789ab'].sort())
  for (const id of [b.id, m.id, 'ref-0123456789ab']) assert.equal(R.removeReference(id, d).id, id)
  assert.equal(R.removeReference('nope', d), null)
  assert.equal(R.removeReference('Analysis Skript', d).name, 'Analysis Skript')
  assert.deepEqual(fs.readdirSync(d), [])
})

// ─── 和她的 studio check / submit、主人的 reference / videos 命令、主人批准一起跑 ───
const CHANNEL = '# 频道设定\n## 和已有的 AI UP 主有什么不同\n我只讲自己每天真实遇到的事，不做比赛和测评。\n'
function sandbox(t, { venv: realVenv = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-refcli-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dsh = path.join(home, 'data')
  fs.mkdirSync(path.join(dsh, 'whale-work'), { recursive: true }); fs.mkdirSync(path.join(home, '.bili-ai'))
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'Whale' }, notify: { type: 'none' } }))
  fs.writeFileSync(path.join(home, '.bili-ai/credentials.json'), JSON.stringify({ sessdata: 'test-cookie-not-a-real-account', bili_jct: 'a'.repeat(32) }))
  let venv = realVenv
  if (!venv) {   // 假的 venv python：node 的硬链接，studio.py 由 fake-studio-py.mjs 冒充
    venv = path.join(home, 'venv')
    const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    fs.mkdirSync(path.dirname(py), { recursive: true })
    try { fs.linkSync(process.execPath, py) } catch { fs.copyFileSync(process.execPath, py) }
  }
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_STUDIO_VENV: venv, BILI_WHALE_ORIGINALITY_OFFLINE: '1',
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/fake-studio-py.mjs')).href }
  delete env.BILI_WHALE_AGENT
  fs.writeFileSync(path.join(dsh, 'whale-work', 'channel.md'), CHANNEL)
  fs.writeFileSync(path.join(home, '.bili-ai/channel-approved.json'), JSON.stringify({ sha: crypto.createHash('sha256').update(CHANNEL).digest('hex'), at: 't' }))
  return { env, agent: { ...env, BILI_WHALE_AGENT: '1', BILI_WHALE_AI_HOME: path.join(dsh, 'whale-work') }, home, dsh, work: path.join(dsh, 'whale-work'), refs: path.join(home, '.bili-ai', 'reference') }
}
const run = (file, args, env) => spawnSync(process.execPath, [path.join(root, file), ...args], { env, encoding: 'utf8', timeout: 30000 })
const cli = (s, ...args) => run('host/cli.mjs', args, s.env)
const studio = (s, ...args) => run('tools/bili.mjs', ['studio', ...args], s.agent)
const addRef = (s, name, text) => { const f = path.join(s.home, 'ref-src.txt'); fs.writeFileSync(f, text); const r = cli(s, 'reference', 'add', f, '--name', name); assert.equal(r.status, 0, r.stdout + r.stderr) }
function newWork(s, scenes) {
  const nr = studio(s, 'new', '--title', '中值定理' + crypto.randomBytes(3).toString('hex')); assert.equal(nr.status, 0, nr.stderr)
  const id = nr.stdout.match(/新作品 (\S+)/)[1], dir = path.join(s.work, 'studio', id)
  const write = (sc) => fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')), tid: 201, scenes: sc }))
  write(scenes)
  return { id, dir, write }
}
const COPIED = [{ bg_prompt: 'x', lines: [{ text: '我们来算一个电路：电阻4.37千欧，518欧，电源13.02伏，电容0.372毫法，结果电流2.553毫安。' }] },
  { slide: { title: 'Satz', bullets: [SATZ] }, lines: [{ text: '这一页讲中值定理。' }] }]
const FLAGGED = [{ bg_prompt: 'x', lines: [{ text: '先看一个电路：4.7 千欧、12 伏、4.37 千欧、518 欧，自己算算电流。' }] }]
const OWN = [{ bg_prompt: 'x', lines: [{ text: '换一个我自己的例子：电阻 2.2 千欧，电源 9 伏。中值定理说的是，函数在一段上连续又光滑，就一定有个地方的斜率等于平均斜率。' }] }]
const noSecret = (...outs) => { for (const out of outs) { assert.ok(!out.includes(SECRET)); assert.ok(!out.includes('Mittelwertsatz')); assert.ok(!out.includes('kΩ')); assert.ok(!out.includes('Kirchhoff')) } }

test('cli reference add / list / remove: encodings, name rules, strict arguments, near-empty files, replacing, broken entries, and a PDF without a working Python', (t) => {
  const s = sandbox(t)
  const f = path.join(s.home, 'analysis-skript.txt'); fs.writeFileSync(f, String.fromCharCode(0xfeff) + SKRIPT)
  let r = cli(s, 'reference', 'add', f)
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /参考材料「analysis-skript」已存好/); assert.match(r.stdout, /她被拦时会看到这份材料的名字「analysis-skript」/)
  noSecret(r.stdout + r.stderr)
  r = cli(s, 'reference', 'add', f, '--name', 'Analysis Skript'); assert.equal(r.status, 0)
  r = cli(s, 'reference', 'add', '--name=Analysis Skript', f); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /替换了之前的「Analysis Skript」（来自 analysis-skript\.txt/)
  // .md、带 BOM 的 UTF-16（记事本的「Unicode」）
  const md = path.join(s.home, 'algebra.md'); fs.writeFileSync(md, '# Algebra\n' + SKRIPT)
  assert.equal(cli(s, 'reference', 'add', md).status, 0)
  const u16 = path.join(s.home, 'notizen.txt'); fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SKRIPT, 'utf16le')]))
  assert.equal(cli(s, 'reference', 'add', u16).status, 0)
  assert.ok(fs.readFileSync(path.join(s.refs, R.referenceId('notizen') + '.txt'), 'utf8').includes('Mittelwertsatz'))
  // 文件名太长：名字截到 40 个字
  const long = path.join(s.home, 'S'.repeat(60) + '.txt'); fs.writeFileSync(long, SKRIPT)
  assert.equal(cli(s, 'reference', 'add', long).status, 0)
  r = cli(s, 'reference', 'list')
  assert.match(r.stdout, /Analysis Skript · \d+ 字 · 来自 analysis-skript\.txt · .* · ref-[0-9a-f]{12}/); assert.match(r.stdout, new RegExp(`^${'S'.repeat(40)} ·`, 'm'))
  // 拒绝：不是 UTF-8、几乎没字（扫描版）、坏名字、没给名字、多余的参数、不认的参数、不存在的文件、不认的格式、删不存在的
  const latin1 = path.join(s.home, 'latin1.txt'); fs.writeFileSync(latin1, Buffer.from('Gr\xf6\xdfe der Spannung '.repeat(100), 'latin1'))
  r = cli(s, 'reference', 'add', latin1); assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /不是 UTF-8/)
  const tiny = path.join(s.home, 'tiny.txt'); fs.writeFileSync(tiny, 'Seite 1')
  r = cli(s, 'reference', 'add', tiny); assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /几乎没抽出文字.*--force/)
  assert.equal(cli(s, 'reference', 'add', tiny, '--force').status, 0)
  for (const args of [['reference', 'add', f, '--name', 'a/b'], ['reference', 'add', f, '--name'], ['reference', 'add', f, '--name', '--force'], ['reference', 'add', f, '--name='],
    ['reference', 'add', f, '--name', 'A', '--name', 'B'], ['reference', 'add', f, 'Analysis', 'Skript'], ['reference', 'add', f, '--titel', 'x'], ['reference', 'add', path.join(s.home, 'nope.txt')],
    ['reference', 'remove', 'gibt es nicht'], ['reference', 'allow'], ['reference', 'allow', '../x'], ['reference', 'allow', 'nope-123', '--bogus'], ['reference', 'bogus'],
    ['videos', 'approve'], ['videos', 'approve', 'a1b2c3', '--bogus'], ['videos', 'approve', 'a1b2c3', 'd4e5f6']]) {
    r = cli(s, ...args); assert.equal(r.status, 2, args.join(' ') + r.stdout + r.stderr)
  }
  assert.match(cli(s, 'videos', 'approve', 'a1b2c3', '--reference-of').stdout, /不认识：--reference-of/)
  // 文件名当名字不合格：说清楚可以用 --name
  const dash = path.join(s.home, '-entwurf.txt'); fs.writeFileSync(dash, SKRIPT)
  r = cli(s, 'reference', 'add', dash); assert.equal(r.status, 2); assert.match(r.stdout + r.stderr, /名字取自文件名；用 --name 另起一个/)
  const docx = path.join(s.home, 'x.docx'); fs.writeFileSync(docx, 'x')
  assert.equal(cli(s, 'reference', 'add', docx).status, 2)
  const before = fs.readdirSync(s.refs).sort()
  const pdf = path.join(s.home, 'skript.pdf'); fs.writeFileSync(pdf, '%PDF-1.4 not really')
  r = cli(s, 'reference', 'add', pdf)   // 沙盒里的「python」是假的：读不出来，说清楚，什么都不存
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /PDF 读不出来|pypdf/)
  assert.deepEqual(fs.readdirSync(s.refs).sort(), before)
  // 坏掉的一份：list 照样列（带 id），按 id 能删
  const brokenId = R.referenceId('algebra')
  fs.writeFileSync(path.join(s.refs, brokenId + '.json'), '{')
  r = cli(s, 'reference', 'list'); assert.equal(r.status, 0); assert.match(r.stdout + r.stderr, new RegExp(`${brokenId}：说明读不了.*reference remove ${brokenId}`))
  assert.equal(cli(s, 'reference', 'remove', brokenId).status, 0)
  for (const n of ['analysis-skript', 'Analysis Skript', 'notizen', 'S'.repeat(40), 'tiny']) assert.equal(cli(s, 'reference', 'remove', ...n.split(' ')).status, 0, n)
  assert.deepEqual(fs.readdirSync(s.refs), [])
  assert.match(cli(s, 'reference', 'list').stdout, /还没有参考材料/)
})

const STUDIO_PY_BIN = process.env.STUDIO_TEST_PYTHON
test('cli reference add: a PDF is read with pypdf in the studio venv (stub pypdf; needs STUDIO_TEST_PYTHON)', { skip: !STUDIO_PY_BIN && '设 STUDIO_TEST_PYTHON 才跑', timeout: 180000 }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-pdf-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const mk = (dir, stub) => {
    const r = spawnSync(STUDIO_PY_BIN, ['-m', 'venv', '--without-pip', dir], { encoding: 'utf8', timeout: 120000 }); assert.equal(r.status, 0, r.stderr)
    if (!stub) return dir
    const sp = process.platform === 'win32' ? path.join(dir, 'Lib', 'site-packages') : fs.readdirSync(path.join(dir, 'lib')).map((v) => path.join(dir, 'lib', v, 'site-packages'))[0]
    fs.mkdirSync(path.join(sp, 'pypdf'), { recursive: true })
    fs.writeFileSync(path.join(sp, 'pypdf', '__init__.py'), [
      'class _P:',
      '    def __init__(s, t): s.t = t',
      '    def extract_text(s): return s.t',
      'class PdfReader:',
      '    def __init__(s, p):',
      '        data = open(p, encoding="utf-8").read()',
      '        if not data.startswith("%STUB"): raise ValueError("not a stub pdf")',
      '        s.pages = [_P(x) for x in data[5:].split("\\f")]',
    ].join('\n'))
    return dir
  }
  const s = sandbox(t, { venv: mk(path.join(base, 'v1'), true) })
  const pdf = path.join(s.home, 'analysis.pdf'); fs.writeFileSync(pdf, '%STUB' + SKRIPT.split('\n').join('\f'))
  let r = cli(s, 'reference', 'add', pdf)
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /参考材料「analysis」已存好/)
  assert.ok(fs.readFileSync(path.join(s.refs, R.referenceId('analysis') + '.txt'), 'utf8').includes(SECRET))
  const bad = path.join(s.home, 'enc.pdf'); fs.writeFileSync(bad, '%PDF-1.7 encrypted')
  r = cli(s, 'reference', 'add', bad); assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /PDF 读不出来：ValueError: not a stub pdf/)
  const s2 = sandbox(t, { venv: mk(path.join(base, 'v2'), false) })
  r = cli(s2, 'reference', 'add', pdf); assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /读 PDF 要 pypdf：再跑一次 node host\/cli\.mjs studio-setup/)
})

test('studio check / submit: copying from the owner\'s reference blocks the video, small overlaps are reminders; she never sees the reference text; a pass is never reused', (t) => {
  const s = sandbox(t)
  // 还没有材料时查过、通过了
  const w = newWork(s, COPIED)
  let r = studio(s, 'check', w.id); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'originality.json'), 'utf8')).referencesChecked, 0)
  // 主人加了讲义：再查就拦（报告里没有讲义原文）
  addRef(s, 'Analysis Skript', SKRIPT)
  r = studio(s, 'check', w.id)
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /第 1 个场景的例题数字和参考材料「Analysis Skript」里的一道一样（4\.37、518、13\.02、0\.372、2\.553）/)
  assert.match(r.stderr, /和参考材料「Analysis Skript」原样一样（连着 [23]\d 个词）/)
  assert.match(r.stderr, /你看不到原文：例题自己编/)
  const report = fs.readFileSync(path.join(w.dir, 'originality.json'), 'utf8')
  noSecret(r.stdout + r.stderr, report)
  assert.equal(JSON.parse(report).referencesChecked, 1); assert.equal(JSON.parse(report).references, undefined)   // 材料的 id / 指纹不写进她的报告
  // 交审同样被拦（先渲染一份）；之前那次「通过」不算数
  assert.equal(studio(s, 'render', w.id).status, 0)
  r = studio(s, 'submit', w.id, '--reason', '这是一条很有意思的视频')
  assert.notEqual(r.status, 0); assert.match(r.stderr, /原创查重没过/)
  assert.ok(!fs.existsSync(path.join(s.home, '.bili-ai', 'pending-videos.json')) || !fs.readFileSync(path.join(s.home, '.bili-ai', 'pending-videos.json'), 'utf8').includes(w.id))
  // 主人看过、放行这一份剧本：拦的那几处变成提醒，交得上去；她再改一个字就又拦
  r = cli(s, 'reference', 'allow', w.id)
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /拦：.*例题数字/); assert.match(r.stdout + r.stderr, /放行了作品/); noSecret(r.stdout + r.stderr)
  r = studio(s, 'check', w.id); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /主人看过、放行了：.*例题数字/)
  r = studio(s, 'submit', w.id, '--reason', '这是一条很有意思的视频'); assert.equal(r.status, 0, r.stdout + r.stderr)
  const pend = JSON.parse(fs.readFileSync(path.join(s.home, '.bili-ai', 'pending-videos.json'), 'utf8'))
  assert.ok((pend.items ?? pend).find((x) => x.id === w.id).originality.flags.some((f) => /^主人看过、放行了：/.test(f)))
  assert.match(cli(s, 'videos').stdout, /和参考材料对得上的地方（没拦，你看一下）：主人看过、放行了/)
  w.write([...COPIED, { lines: [{ text: '多一句。' }] }])
  assert.equal(studio(s, 'check', w.id).status, 2)
  assert.equal(cli(s, 'reference', 'allow', w.id, '--clear').status, 0)
  // 只对上几个数字：过，但提醒
  w.write(FLAGGED)
  r = studio(s, 'check', w.id); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /原创查重通过[\s\S]*提醒（这几处没拦，主人审片时会看到）[\s\S]*有几个数字和参考材料「Analysis Skript」里同一处的一样/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'originality.json'), 'utf8')).flags.length, 1)
  // 自己编的例题、自己的话：过，也没有提醒
  w.write(OWN)
  r = studio(s, 'check', w.id); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /原创查重通过/); assert.doesNotMatch(r.stdout, /提醒/)
})

test('studio check / submit fail closed: a broken reference store blocks, with advice for the owner and no reference text', (t) => {
  const s = sandbox(t)
  addRef(s, 'Analysis Skript', SKRIPT)
  const w = newWork(s, OWN)
  assert.equal(studio(s, 'check', w.id).status, 0)
  // .txt 不见了
  fs.rmSync(path.join(s.refs, R.referenceId('Analysis Skript') + '.txt'))
  let r = studio(s, 'check', w.id)
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /本地查重没查成：参考材料「Analysis Skript」读不了.*reference list/)
  const rep = JSON.parse(fs.readFileSync(path.join(w.dir, 'originality.json'), 'utf8'))
  assert.equal(rep.blocked, true); assert.equal(rep.hits.length, 0); assert.equal(rep.localErrors.length, 1)
  assert.equal(studio(s, 'render', w.id).status, 0)
  r = studio(s, 'submit', w.id, '--reason', '这是一条很有意思的视频'); assert.notEqual(r.status, 0); assert.match(r.stderr, /原创查重没过/)
  // 说明坏了
  addRef(s, 'Analysis Skript', SKRIPT)
  fs.writeFileSync(path.join(s.refs, R.referenceId('Analysis Skript') + '.json'), '{')
  r = studio(s, 'check', w.id)
  assert.equal(r.status, 2); assert.match(r.stderr, /JSON 坏了.*reference list/)
  noSecret(r.stdout + r.stderr, fs.readFileSync(path.join(w.dir, 'originality.json'), 'utf8'))
})

test('owner approve: references added after she submitted are compared (only those) before upload; the owner can look and say --reference-ok; videos list shows what was compared and the reminders', (t) => {
  const s = sandbox(t)
  const helper = path.join(s.home, 'approve.mjs')
  fs.writeFileSync(helper, `
    import cp from 'node:child_process'
    import {syncBuiltinESMExports} from 'node:module'
    const real=cp.execFile
    let uploads=0
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('upload')){uploads++;queueMicrotask(()=>cb(null,'{"ok":true,"bvid":"BV1aa411c7mD"}',''));return {kill(){}}}
      if(args.includes('existing')){queueMicrotask(()=>cb(null,'{"ok":true,"hits":[]}',''));return {kill(){}}}
      return real(exe,args,opt,cb)
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(pathToFileURL(path.join(root, 'host/core.mjs')).href)})
    const r=await core.approveVideo(process.argv[2],{referenceOk:process.argv[3]==='ok'})
    console.log(JSON.stringify({...r,uploads}))
  `)
  const approve = (id, ok = '') => { const r = spawnSync(process.execPath, [helper, id, ok], { env: s.env, encoding: 'utf8', timeout: 60000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()) }
  const submitted = (scenes) => {
    const w = newWork(s, scenes)
    assert.equal(studio(s, 'render', w.id).status, 0)
    const r = studio(s, 'submit', w.id, '--reason', '这是一条很有意思的视频'); assert.equal(r.status, 0, r.stdout + r.stderr)
    return w.id
  }
  const pending = (id) => { const p = JSON.parse(fs.readFileSync(path.join(s.home, '.bili-ai', 'pending-videos.json'), 'utf8')); return (p.items ?? p).find((x) => x.id === id) }
  // 交审时还没有讲义：照搬的那条也交上去了；主人后来加了讲义 → 批准时比出来，先不投
  const copied = submitted(COPIED)
  assert.match(cli(s, 'videos').stdout, /原创查重：通过（交审时还没有参考材料）/)
  addRef(s, 'Analysis Skript', SKRIPT)
  let o = approve(copied)
  assert.equal(o.ok, false); assert.equal(o.uploads, 0)
  assert.match(o.error, /她交审之后你加了 \/ 换了参考材料「Analysis Skript」[\s\S]*对上了：.*例题数字和参考材料「Analysis Skript」里的一道一样[\s\S]*--reference-ok/)
  // 又加了一份、然后它坏了：好的那份照样比，坏的那份记成没比成，一起告诉主人
  addRef(s, 'Kaputt', SKRIPT.replace(SECRET, 'x'))
  fs.writeFileSync(path.join(s.refs, R.referenceId('Kaputt') + '.json'), '{')
  o = approve(copied); assert.equal(o.ok, false); assert.equal(o.uploads, 0)
  assert.match(o.error, /对上了：.*「Analysis Skript」/); assert.match(o.error, /没比成：.*说明读不了/)
  assert.equal(cli(s, 'reference', 'remove', R.referenceId('Kaputt')).status, 0)
  // 交审时讲义已经在：只对上几个数字的那条照常交上去，队列里记着比过哪份、提醒了什么
  const flagged = submitted(FLAGGED)
  assert.deepEqual(pending(flagged).originality.references.map((x) => x.name), ['Analysis Skript'])
  assert.equal(pending(flagged).originality.flags.length, 1)
  const list = cli(s, 'videos').stdout
  assert.match(list, /和参考材料对得上的地方（没拦，你看一下）：.*有几个数字和参考材料「Analysis Skript」里同一处的一样/)
  assert.match(list, /原创查重：通过（也和参考材料「Analysis Skript」比过）/)
  // 之后又加了一份不相干的：批准时只和新的这份比（Analysis 的提醒交审时已经给过了）→ 照常投
  addRef(s, 'Algebra Skript', HAN + FILLER(30))
  o = approve(flagged); assert.equal(o.ok, true, JSON.stringify(o)); assert.equal(o.uploads, 1)
  // 照搬的那条：主人看过、说了 --reference-ok 才投
  o = approve(copied, 'ok'); assert.equal(o.ok, true, JSON.stringify(o)); assert.equal(o.uploads, 1)
})

test('owner approve: a page she read after submitting that matches the script stops the upload until the owner says --reference-ok (web reading, 2026-10-28)', (t) => {
  const s = sandbox(t)
  const helper = path.join(s.home, 'approve.mjs')
  fs.writeFileSync(helper, `
    import cp from 'node:child_process'
    import {syncBuiltinESMExports} from 'node:module'
    const real=cp.execFile
    let uploads=0
    cp.execFile=(exe,args,opt,cb)=>{
      if(args.includes('upload')){uploads++;queueMicrotask(()=>cb(null,'{"ok":true,"bvid":"BV1aa411c7mD"}',''));return {kill(){}}}
      if(args.includes('existing')){queueMicrotask(()=>cb(null,'{"ok":true,"hits":[]}',''));return {kill(){}}}
      return real(exe,args,opt,cb)
    }
    syncBuiltinESMExports()
    const core=await import(${JSON.stringify(pathToFileURL(path.join(root, 'host/core.mjs')).href)})
    const r=await core.approveVideo(process.argv[2],{referenceOk:process.argv[3]==='ok'})
    console.log(JSON.stringify({...r,uploads}))
  `)
  const approve = (id, ok = '') => { const r = spawnSync(process.execPath, [helper, id, ok], { env: s.env, encoding: 'utf8', timeout: 60000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()) }
  const said = '中值定理说的是，函数在一段区间上连续又光滑，就一定有个地方的切线斜率正好等于两端连线的平均斜率，这个地方不一定只有一个。'
  const w = newWork(s, [{ bg_prompt: 'x', lines: [{ text: said }] }])
  assert.equal(studio(s, 'render', w.id).status, 0)
  const sub = studio(s, 'submit', w.id, '--reason', '这是一条很有意思的视频'); assert.equal(sub.status, 0, sub.stdout + sub.stderr)
  // 交审之后她在读书回合里读到一页，里面正好有这一大段
  const fp = path.join(s.home, 'fp.mjs')
  fs.writeFileSync(fp, `const W = await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools/lib/webstate.mjs')).href)})
    W.addFingerprint({ url: 'https://example.org/mvt', host: 'example.org', text: '百科：' + ${JSON.stringify(said)} + '以上是定义。' })`)
  const fr = spawnSync(process.execPath, [fp], { env: s.env, encoding: 'utf8' }); assert.equal(fr.status, 0, fr.stderr)
  let o = approve(w.id)
  assert.equal(o.ok, false); assert.equal(o.uploads, 0)
  assert.match(o.error, /和她读过的网页比了一遍[\s\S]*example\.org[\s\S]*--reference-ok/)
  o = approve(w.id, 'ok'); assert.equal(o.ok, true, JSON.stringify(o)); assert.equal(o.uploads, 1)
})
