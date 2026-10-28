// 网页转文字（读书回合的文字浏览器用）：一遍扫完，不用会被恶意网页拖死的正则（用到的正则只在小片段上、或者是线性的）。
//   · 去掉：注释、<script> <style> <noscript> <template> <svg> <math> <iframe> <object> 和 <head> 里的东西（<title> 留下当标题）、
//     藏起来的元素（hidden、aria-hidden="true"、行内样式 display:none / visibility:hidden / font-size:0 / opacity:0 等、常见的「隐藏」class）
//     —— 藏起来的、里面有字的数进 hidden，告诉她「跳过了 N 段藏起来的字」
//   · 看不见的 Unicode（零宽、方向控制、BOM、标签字符、变体选择符……）去掉；空白收拢；块级元素换行
//   · 链接只收解析成 http / https 的，去重、编号（最多 maxLinks 个），正文里在链接文字后面标 [n]；<meta refresh> 只当成一个链接，不跟
//   · 打开的元素用一个有上限的栈记；超过上限后再遇到要藏的元素，后面的全部不要（宁可少给，不漏藏起来的字）
//   · 只是尽量像浏览器：CSS 文件里定的隐藏、脚本改的内容都看不到 —— 这一层不是安全边界（安全边界是网络笼子）
//   · 冒充宿主的括号（〔宿主〕之类）不在这里洗，调用的一方用 textguard.mjs 的 neutralizeTags

const MAX_DEPTH = 512
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  'keygen', 'frame', 'basefont', 'bgsound', 'image'])
// 里面是原样文字、整段不要的
const RAW_DROP = new Set(['script', 'style', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes'])
// 里面照常解析、但整段不要的
const DROP = new Set(['template', 'svg', 'math', 'object', 'canvas', 'audio', 'video', 'datalist'])
const HEAD_OK = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template', 'head', 'html'])
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'legend', 'li', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead',
  'tr', 'ul', 'textarea'])
// 这些元素开始时会顺手关掉还开着的 <p>
const P_CLOSE = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const P_STOPS = new Set(['button', 'table', 'td', 'th', 'caption', 'html', 'object', 'template', 'marquee', 'applet', 'svg', 'math'])
const LI_STOPS = new Set(['ul', 'ol', 'menu', 'table', 'template'])
const DL_STOPS = new Set(['dl', 'table', 'template'])
const TR_STOPS = new Set(['table', 'tbody', 'thead', 'tfoot', 'template'])
const TD_STOPS = new Set(['tr', 'table', 'template'])
const HIDE_CLASS = new Set(['hidden', 'd-none', 'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'hide',
  'invisible', 'is-hidden', 'u-hidden', 'hidden-xs-up', 'a11y-hidden'])
// 只记这些属性（别的属性名照样扫过去，值不留）
export const NEED_ATTRS = new Set(['href', 'hidden', 'aria-hidden', 'style', 'class', 'http-equiv', 'content', 'open', 'aria-label', 'title', 'id'])

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

// ─────────────── 字符引用、看不见的字 ───────────────

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹',
  rsaquo: '›', middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', plusmn: '±', sect: '§', para: '¶', cent: '¢',
  pound: '£', yen: '¥', euro: '€', curren: '¤', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯', acute: '´',
  micro: 'µ', cedil: '¸', sup1: '¹', sup2: '²', sup3: '³', frac14: '¼', frac12: '½', frac34: '¾', uml: '¨', brvbar: '¦',
  shy: '\u00AD', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200C', zwj: '\u200D', lrm: '\u200E', rlm: '\u200F',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞', minus: '−', sum: '∑', prod: '∏', radic: '√', part: '∂',
  int: '∫', isin: '∈', notin: '∉', cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', and: '∧', or: '∨', forall: '∀', exist: '∃',
  empty: '∅', nabla: '∇', sdot: '⋅', lowast: '∗', prop: '∝', ang: '∠', there4: '∴', sim: '∼', cong: '≅', oplus: '⊕',
  otimes: '⊗', perp: '⊥', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', lang: '⟨', rang: '⟩', loz: '◊', spades: '♠',
  clubs: '♣', hearts: '♥', diams: '♦', star: '☆', starf: '★', check: '✓', cross: '✗', hyphen: '‐', dash: '‐', colon: ':',
  comma: ',', period: '.', excl: '!', quest: '?', num: '#', dollar: '$', percnt: '%', lpar: '(', rpar: ')', ast: '*',
  plus: '+', sol: '/', semi: ';', equals: '=', commat: '@', lsqb: '[', rsqb: ']', bsol: '\\', lowbar: '_', grave: '`',
  lcub: '{', rcub: '}', verbar: '|', vert: '|', Tab: '\t', NewLine: '\n',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', sigmaf: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô',
  Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', thorn: 'þ',
  eth: 'ð', ETH: 'Ð', THORN: 'Þ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
}
// 不带分号也认的几个（老网页常这么写）
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'])
// &#128; – &#159; 按 Windows-1252 解（浏览器也这么做）
const C1 = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹',
  140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š',
  155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' }
const ENT = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/y

function codePoint(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
  if (C1[cp]) return C1[cp]
  return String.fromCodePoint(cp)
}

/** 解 HTML 字符引用（常用的命名引用 + 数字引用）；inAttr：属性值里「&copy=」这种不带分号、后面跟着 = 或字母数字的不解（和浏览器一样） */
export function decodeEntities(str, inAttr = false) {
  const s = String(str ?? '')
  if (s.indexOf('&') < 0) return s
  const out = []
  let i = 0
  for (;;) {
    const j = s.indexOf('&', i)
    if (j < 0) { out.push(s.slice(i)); break }
    out.push(s.slice(i, j))
    ENT.lastIndex = j
    const m = ENT.exec(s)
    if (!m) { out.push('&'); i = j + 1; continue }
    if (m[1] !== undefined || m[2] !== undefined) {
      out.push(codePoint(m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16)))
      i = j + m[0].length
      continue
    }
    const name = m[3]
    if (m[4] === ';' && Object.hasOwn(NAMED, name)) { out.push(NAMED[name]); i = j + m[0].length; continue }
    // 不带分号：只认前缀是老写法的那几个（&ampx → &x）
    let hit = ''
    for (const l of LEGACY) if (name.startsWith(l) && l.length > hit.length) hit = l
    const after = s.charCodeAt(j + 1 + hit.length)
    if (hit && !(inAttr && (after === 61 || isAlpha(after) || (after >= 48 && after <= 57)))) {
      out.push(NAMED[hit]); i = j + 1 + hit.length; continue
    }
    out.push('&'); i = j + 1
  }
  return out.join('')
}

// 看不见的字：Unicode「默认忽略」一类（零宽、变体选择符、标签字符 E0000–E007F、韩文填充符、软连字符……）、方向控制、控制字符（换行、制表符以外）
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]|(?![\n\t])\p{Cc}/gu
// 看着是空白、但 \s 不算的
const ODD_SPACE = /[\u2800\u3000\u180E]/g
/** 去掉看不见的 Unicode 字符 */
export const stripInvisible = (s) => String(s ?? '').replace(INVISIBLE, '').replace(ODD_SPACE, ' ')
// 一行里的字：去看不见的字、空白收成一个、去两头
const inline = (s, max = Infinity) => {
  const t = stripInvisible(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? [...t].slice(0, max).join('').trim() : t
}

// ─────────────── 标签 ───────────────

/**
 * 读 s[i] 开始的一个标签（s[i] 是「<」，后面是字母或「/字母」）→ { name, close, self, attrs, start, end }；
 * end 是「>」后面的位置（没有「>」就到结尾）。属性名都转小写，同名的只认第一个；只留 want 里的属性值
 */
export function readTag(s, i, want = NEED_ATTRS) {
  const n = s.length
  let j = i + 1
  const close = s.charCodeAt(j) === 47
  if (close) j++
  const ns = j
  while (j < n) { const c = s.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++ }
  const name = s.slice(ns, j).toLowerCase()
  const attrs = Object.create(null)
  let self = false
  for (;;) {
    while (j < n) {
      const c = s.charCodeAt(j)
      if (isWs(c)) { j++; continue }
      if (c === 47) { self = true; j++; continue }
      break
    }
    if (j >= n) return { name, close, self, attrs, start: i, end: n }
    if (s.charCodeAt(j) === 62) return { name, close, self, attrs, start: i, end: j + 1 }
    self = false
    const as = j++
    while (j < n) { const c = s.charCodeAt(j); if (isWs(c) || c === 47 || c === 62 || c === 61) break; j++ }
    const an = s.slice(as, j).toLowerCase()
    while (j < n && isWs(s.charCodeAt(j))) j++
    let val = ''
    if (s.charCodeAt(j) === 61) {
      j++
      while (j < n && isWs(s.charCodeAt(j))) j++
      const q = s.charCodeAt(j)
      if (q === 34 || q === 39) {
        const k = s.indexOf(q === 34 ? '"' : "'", j + 1)
        if (k < 0) { val = s.slice(j + 1); j = n } else { val = s.slice(j + 1, k); j = k + 1 }
      } else {
        const vs = j
        while (j < n) { const c = s.charCodeAt(j); if (isWs(c) || c === 62) break; j++ }
        val = s.slice(vs, j)
      }
    }
    if (want.has(an) && !(an in attrs)) attrs[an] = val
  }
}

/** 从 from 起找「</name」（不分大小写，后面是空白、/、> 或结尾）的位置；没有 → -1。线性 */
export function findClose(s, from, name) {
  const L = name.length
  for (let k = s.indexOf('</', from); k >= 0; k = s.indexOf('</', k + 2)) {
    if (s.slice(k + 2, k + 2 + L).toLowerCase() !== name) continue
    const c = s.charCodeAt(k + 2 + L)
    if (Number.isNaN(c) || isWs(c) || c === 47 || c === 62) return k
  }
  return -1
}
// 找到的「</name」后面那个「>」之后的位置
const afterClose = (s, k) => { if (k < 0) return s.length; const g = s.indexOf('>', k); return g < 0 ? s.length : g + 1 }
const gtEnd = (s, from) => { const g = s.indexOf('>', from); return g < 0 ? s.length : g + 1 }

/**
 * 扫一遍：文字段 onText(a, b)，标签 onTag(tag)（返回一个数 = 从那里接着扫，用来跳过 <script> 这类的原样内容）。
 * 注释、<!DOCTYPE>、<?…>、「</ 」这种假标签跳过；不像标签的「<」留在文字里
 */
export function scanHtml(s, onText, onTag, want = NEED_ATTRS) {
  const n = s.length
  let i = 0, ts = 0
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    const c = s.charCodeAt(lt + 1)
    let skip = -1
    if (c === 33) {
      if (s.startsWith('<!--', lt)) {
        if (s.startsWith('<!-->', lt)) skip = lt + 5
        else if (s.startsWith('<!--->', lt)) skip = lt + 6
        else { const e = s.indexOf('-->', lt + 4); skip = e < 0 ? n : e + 3 }
      } else skip = gtEnd(s, lt + 2)
    } else if (c === 63) skip = gtEnd(s, lt + 2)
    else if (c === 47) {
      const c2 = s.charCodeAt(lt + 2)
      if (Number.isNaN(c2)) { i = lt + 1; continue }
      if (!isAlpha(c2)) skip = c2 === 62 ? lt + 3 : gtEnd(s, lt + 2)
    } else if (!isAlpha(c)) { i = lt + 1; continue }
    if (lt > ts) onText(ts, lt)
    if (skip >= 0) { i = ts = skip; continue }
    const t = readTag(s, lt, want)
    const r = onTag(t)
    if (r === false) return
    i = ts = typeof r === 'number' ? r : t.end
  }
  if (n > ts) onText(ts, n)
}

/** 遍历标签（给搜索结果页这类只看标签的用）：<script> <style> 之类的原样内容跳过；onTag 返回 false 就停 */
export function walkTags(html, onTag, want = NEED_ATTRS) {
  const s = String(html ?? '')
  scanHtml(s, () => {}, (t) => {
    if (onTag(t) === false) return false
    if (!t.close && (RAW_DROP.has(t.name) || t.name === 'title' || t.name === 'textarea')) {
      const k = findClose(s, t.end, t.name)
      return k < 0 ? s.length : k
    }
  }, want)
}

// ─────────────── 藏起来的元素 ───────────────

const ZERO = '0(?:\\.0*)?(?:px|em|rem|pt|pc|%|vw|vh|ex|ch)?(?:!important)?(?:;|$)'
const FONT0 = new RegExp(`(?:^|[;{])font-size:${ZERO}`)
const OPACITY0 = new RegExp(`(?:^|[;{])opacity:${ZERO}`)
const SIZE01 = /(?:^|[;{])(?:width|height|max-width|max-height):(?:0|1px)(?:!important)?(?:;|$)/
const FAR = /(?:^|[;{])(?:left|top|text-indent|margin-left|margin-top):-\d{3,}/

/** 行内样式是不是把它藏起来了（先解字符引用、去空白、转小写） */
export function styleHidden(style) {
  const x = decodeEntities(style, true).toLowerCase().replace(/\s+/g, '')
  if (!x) return false
  return x.includes('display:none') || x.includes('visibility:hidden') || x.includes('visibility:collapse') ||
    FONT0.test(x) || OPACITY0.test(x) || x.includes('color:transparent') || FAR.test(x) ||
    x.includes('clip-path:inset(50%') || x.includes('clip-path:inset(100%') || x.includes('transform:scale(0)') ||
    (SIZE01.test(x) && x.includes('overflow:hidden'))
}

function attrsHidden(a) {
  if ('hidden' in a) return true
  if ('aria-hidden' in a && a['aria-hidden'].trim().toLowerCase() === 'true') return true
  if (a.style && styleHidden(a.style)) return true
  if (a.class) for (const c of a.class.toLowerCase().split(/\s+/)) if (HIDE_CLASS.has(c)) return true
  return false
}

// ─────────────── 转文字 ───────────────

/**
 * 网页 → { title, text, links: [{ n, url, text }], hidden }。
 * baseUrl：网页的地址（相对链接按它解析；网页里第一个 <base href> 也认）。maxLinks：最多编几个号（默认 60）
 */
export function htmlToText(html, baseUrl, { maxLinks = 60 } = {}) {
  const s = String(html ?? '')
  let base = null
  try { base = baseUrl ? new URL(baseUrl) : null } catch { base = null }
  const out = []
  const links = [], byKey = new Map(), byRaw = new Map()
  const stack = [], counts = new Map()
  let drop = 0, pre = 0, foreign = 0, overflow = 0, dropRest = false
  let inHead = false, sawBody = false, baseSeen = false
  let hidden = 0, regionText = false, title = '', link = null

  const nl = () => out.push('\n')
  const hasText = (a, b) => { for (let k = a; k < b; k++) if (!isWs(s.charCodeAt(k))) return true; return false }

  const emit = (a, b) => {
    if (b <= a) return
    if (drop > 0 || dropRest) { if (!regionText && hasText(a, b)) regionText = true; return }
    if (inHead) { if (!hasText(a, b)) return; inHead = false }
    let t = stripInvisible(decodeEntities(s.slice(a, b)))
    t = pre > 0 ? t.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ') : t.replace(/\s+/g, ' ')
    if (!t) return
    out.push(t)
    if (link && link.text.length < 400) link.text += t.slice(0, 400)
  }

  // 链接：href → 编号（0 = 不编号）。满了以后只认已经见过的 href，不再解析新的
  const resolveHref = (raw) => {
    const h = decodeEntities(raw, true).trim()
    if (!h || h.length > 2048) return null
    let u
    try { u = new URL(h, base ?? undefined) } catch { return null }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.href.length > 2048 ? null : u.href
  }
  const linkNumber = (raw) => {
    if (byRaw.has(raw)) return byRaw.get(raw)
    if (links.length >= maxLinks) return 0
    const url = resolveHref(raw)
    let num = 0
    if (url) {
      num = byKey.get(url) ?? 0
      if (!num) { links.push({ n: links.length + 1, url, text: '' }); num = links.length; byKey.set(url, num) }
    }
    byRaw.set(raw, num)
    return num
  }
  const finishLink = () => {
    if (!link) return
    const l = link
    link = null
    if (!l.n) return
    const rec = links[l.n - 1]
    if (!rec.text) rec.text = inline(l.text, 80) || inline(decodeEntities(l.label, true), 80)
    out.push(`[${l.n}]`)
  }
  const metaRefresh = (content) => {
    const c = decodeEntities(String(content ?? ''), true).slice(0, 4096)
    let k = 0
    const ws = () => { while (k < c.length && isWs(c.charCodeAt(k))) k++ }
    ws()
    while (k < c.length && /[\d.]/.test(c[k])) k++
    ws()
    if (c[k] !== ';' && c[k] !== ',') return
    k++
    ws()
    if (c.slice(k, k + 3).toLowerCase() === 'url') {
      let j = k + 3
      while (j < c.length && isWs(c.charCodeAt(j))) j++
      if (c[j] === '=') { k = j + 1; ws() }
    }
    let u = c.slice(k).trim()
    if (u[0] === '"' || u[0] === "'") { const e = u.indexOf(u[0], 1); u = e < 0 ? u.slice(1) : u.slice(1, e) }
    if (!u) return
    const num = linkNumber(u)
    if (!num) return
    if (!links[num - 1].text) links[num - 1].text = '（网页想自动跳转到这里）'
    out.push(`\n（这页想自动跳转到 [${num}]，没有跟过去）\n`)
  }

  const push = (e) => {
    if (stack.length >= MAX_DEPTH) {
      if (e.d && !dropRest) { dropRest = true; hidden++ }
      if (!e.d) overflow++
      return
    }
    stack.push(e)
    counts.set(e.n, (counts.get(e.n) ?? 0) + 1)
    if (e.d) { if (drop === 0) regionText = false; drop++ }
    if (e.pre) pre++
    if (e.f) foreign++
  }
  const popTop = () => {
    const e = stack.pop()
    counts.set(e.n, counts.get(e.n) - 1)
    if (e.d) { drop--; if (drop === 0 && e.cnt && regionText) hidden++ }
    if (e.pre) pre--
    if (e.f) foreign--
    if (e.a) finishLink()
    if (BLOCK.has(e.n)) nl()
  }
  // 关到最近的 name 为止（最多往下看 limit 层，碰到 stops 里的就不关）；栈里没有这个名字的直接返回（O(1)）
  const closeTo = (name, limit = Infinity, stops = null) => {
    if (!counts.get(name)) return false
    for (let k = stack.length - 1, m = 0; k >= 0 && m < limit; k--, m++) {
      const x = stack[k].n
      if (x === name) { while (stack.length > k) popTop(); return true }
      if (stops?.has(x)) return false
    }
    return false
  }

  const startTag = (t) => {
    const name = t.name
    const a = t.attrs
    if (inHead && !HEAD_OK.has(name)) inHead = false
    if (name === 'html') return
    if (name === 'head') { if (!sawBody) inHead = true; return }
    if (name === 'body') { sawBody = true; inHead = false; return }
    if (name === 'meta') { if ((a['http-equiv'] ?? '').trim().toLowerCase() === 'refresh') metaRefresh(a.content); return }
    if (name === 'base') {
      if (!baseSeen && a.href !== undefined) {
        baseSeen = true
        try { const b = new URL(decodeEntities(a.href, true).trim(), base ?? undefined); if (b.protocol === 'http:' || b.protocol === 'https:') base = b } catch { /* 不认 */ }
      }
      return
    }
    if (VOID.has(name)) { if (name === 'br' || name === 'hr') nl(); return }
    // 隐式关闭（只往下看几层）
    if (P_CLOSE.has(name)) closeTo('p', 16, P_STOPS)
    if (name === 'li') closeTo('li', 16, LI_STOPS)
    else if (name === 'dt' || name === 'dd') { if (!closeTo('dt', 16, DL_STOPS)) closeTo('dd', 16, DL_STOPS) }
    else if (name === 'option') closeTo('option', 4)
    else if (name === 'optgroup') { closeTo('option', 4); closeTo('optgroup', 4) }
    else if (name === 'tr') closeTo('tr', 16, TR_STOPS)
    else if (name === 'td' || name === 'th') { if (!closeTo('td', 8, TD_STOPS)) closeTo('th', 8, TD_STOPS) }
    else if (name === 'a') { finishLink(); closeTo('a', 16) }
    if (HEADINGS.has(name) && stack.length && HEADINGS.has(stack[stack.length - 1].n)) popTop()

    let d = false, cnt = false
    if (DROP.has(name)) { d = true; cnt = name === 'template' }
    else if (name === 'dialog' && !('open' in a)) { d = true; cnt = true }
    if (!d && attrsHidden(a)) { d = true; cnt = true }
    // 自闭合只在 <svg> / <math> 里面（和它们自己）算数
    if (t.self && (foreign > 0 || name === 'svg' || name === 'math')) return
    if (BLOCK.has(name)) nl()
    if ((name === 'td' || name === 'th') && !drop) out.push(' ')
    const e = { n: name, d, cnt, pre: name === 'pre', f: name === 'svg' || name === 'math', a: false }
    if (name === 'a' && a.href !== undefined && !d && !drop && !dropRest && !foreign) {
      const num = linkNumber(a.href)
      if (num) { link = { n: num, text: '', label: a['aria-label'] || a.title || '' }; e.a = true }
    }
    push(e)
    if (name === 'li' && !drop && !dropRest) out.push('· ')
  }

  const endTag = (name) => {
    if (name === 'head') { inHead = false; return }
    if (name === 'html' || name === 'body') return
    if (name === 'br') { nl(); return }
    if (name === 'a') finishLink()
    if (name === 'p' && !counts.get('p')) { nl(); return }
    if (!closeTo(name) && overflow > 0) overflow--
  }

  scanHtml(s, emit, (t) => {
    if (t.close) { endTag(t.name); return }
    const name = t.name
    if (inHead && !HEAD_OK.has(name)) inHead = false
    if (RAW_DROP.has(name) && !(foreign && name !== 'script' && name !== 'style')) {
      const k = findClose(s, t.end, name)
      const stop = k < 0 ? s.length : k
      // <noscript> 里有字（开着脚本的浏览器不显示）也算藏起来的
      if (name === 'noscript' && !drop && !dropRest && !inHead && hasText(t.end, stop)) hidden++
      return afterClose(s, k)
    }
    if ((name === 'title' || name === 'textarea') && !foreign) {
      const k = findClose(s, t.end, name)
      const stop = k < 0 ? s.length : k
      if (name === 'title') {
        if (!title) title = inline(decodeEntities(s.slice(t.end, Math.min(stop, t.end + 4096))), 200)
      } else if (!drop && !dropRest && !attrsHidden(t.attrs)) {
        nl(); pre++; emit(t.end, stop); pre--; nl()
      }
      return afterClose(s, k)
    }
    startTag(t)
  })
  finishLink()
  while (stack.length) popTop()

  // 收拾：每行去两头空白、空白收成一个，连着的空行只留一行
  const lines = []
  for (const raw of out.join('').split('\n')) {
    const line = raw.replace(/ {2,}/g, ' ').trim()
    if (line) lines.push(line)
    else if (lines.length && lines[lines.length - 1] !== '') lines.push('')
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { title, text: lines.join('\n'), links, hidden }
}

/** 一小段 HTML 里的字（一行）：给搜索结果的标题、摘要用 */
export function fragmentText(html, max = 400) {
  return inline(htmlToText(html, null, { maxLinks: 0 }).text, max)
}
