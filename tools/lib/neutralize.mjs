// 洗字（2026-10-28 从 tools/lib/letters.mjs 的 cleanLetter 拆出来）：给信、读书回合的网页正文、读书笔记、笔记标题、读书请求共用。
//   只改样子、不拒收：换行和控制字符变空格、看不见的格式字符去掉、像〔宿主〕【主人私信】的括号拆掉、所有括号换成（）、< > 换成 ‹ ›、空白合成一个 ——
//   洗过的字起不了新的一行、冒充不了宿主的标记。
//   拒收还是替换由各自决定：信整封拒（letters.mjs）；读书笔记把链接、联系方式、长号码换成（略）（redactNote）
import { neutralizeTags, URL_RE, CONTACT_RE, IM_RE, LONG_NUM, ownNumbers } from './textguard.mjs'

// 长得像 < > [ ] 的字（加拿大音节文字 ᐸ ᐳ、修饰符号 ˂ ˃ ˱ ˲、拼大括号用的半截括号 ⎡ ⎤ ⎣ ⎦ ⎛ ⎞ …）：先换成它们本身，后面跟着一起拆、一起换
export const LT_LIKE = /[ᐸ˂˱]/g, GT_LIKE = /[ᐳ˃˲]/g, LB_LIKE = /[⎛⎝⎡⎣⎧⎩]/g, RB_LIKE = /[⎞⎠⎤⎦⎫⎭]/g
// 引号一类的括号（« » ⸂ ⸃ …，Unicode 的 Pi / Pf）和角括号 ⌜ ⌝ ⌞ ⌟：和开 / 闭括号一样换成（）。
//   普通的弯引号 “ ” ‘ ’ 留着（输入法打出来的引号，换掉就读不通了；也拼不出宿主的标记 —— 像〔宿主〕的前面已经拆了）；
//   ‹ › 是下面 < > 换成的字，也留着（读出来再洗一遍还是同一个样子）
export const OPEN_LIKE = /(?![“‘‹])[\p{Pi}⌜⌞]/gu, CLOSE_LIKE = /(?![”’›])[\p{Pf}⌝⌟]/gu

/**
 * 洗一段字（只改样子）。max：先截到这么多个码位再洗（网页、笔记用：neutralizeTags 对套了很多层的假标记会越洗越慢，长度先有个头）；
 * 信不截（和拆出来之前一字不差）
 */
export function neutralizeText(raw, { max = Infinity } = {}) {
  let t = String(raw ?? '').replace(/^﻿/, '')
  if (Number.isFinite(max)) { const cps = [...t]; if (cps.length > max) t = cps.slice(0, max).join('') }
  t = t.replace(/\p{Cc}/gu, ' ')
  t = t.replace(/(?!‍)\p{Cf}/gu, '')
  t = t.replace(/\s+/gu, ' ').trim()
  t = t.replace(LT_LIKE, '<').replace(GT_LIKE, '>').replace(LB_LIKE, '[').replace(RB_LIKE, ']')
  t = neutralizeTags(t)
  t = t.replace(/\p{Ps}/gu, '（').replace(/\p{Pe}/gu, '）')
  t = t.replace(OPEN_LIKE, '（').replace(CLOSE_LIKE, '）')
  t = t.replace(/[<＜﹤]/g, '‹').replace(/[>＞﹥]/g, '›')
  return t.replace(/\s+/gu, ' ').trim()
}

/** 多行的字（网页正文）：每一行各洗一遍（行留着，行里起不了新的一行）；max 是整段的码位上限 */
export function neutralizeLines(raw, { max = 20_000 } = {}) {
  const cps = [...String(raw ?? '')]
  const src = cps.length > max ? cps.slice(0, max).join('') : cps.join('')
  return src.split(/\r?\n/).map((l) => neutralizeText(l, { max: 4_000 })).filter(Boolean).join('\n')
}

// 像密钥 / 编码的一长串（16 个以上的字母数字 + / = _ - %）
export const ENCODED_RUN = /[A-Za-z0-9+/=_%-]{16,}/g
const OMIT = '（略）'
// 看不见、又不算格式字符（neutralizeText 去不掉）的字：零宽连接、变体选择符、组合用的 CGJ、朝鲜文填充字、盲文空格、蒙古文变体选择符 ……
//   夹在字中间能让「主人」「https」这种词躲过检查。笔记里一律去掉（信里的 emoji 要零宽连接，信不走这里）
export const INVISIBLE = /[‍͏ᅟᅠ឴឵᠋-᠏⠀ㅤ︀-️ﾠ]|\uDB40[\uDD00-\uDDEF]/g
// 还有一大类：Unicode 标成「可以忽略、默认不显示」的字，和还没分配的码位（显示出来什么都没有、或者一个小方块）
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cn}]/gu
/** 笔记里去掉所有看不见的字（存下来的、给主人看的、附给她的都是这一份） */
export const stripInvisible = (s) => String(s ?? '').replace(INVISIBLE, '').replace(IGNORABLE, '')
// 长得和拉丁字母一样的西里尔 / 希腊字母（nоde bilі.mjs 里的 о、і）：查的时候当成拉丁字母
const CONFUSABLE = new Map(Object.entries({
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's',
  ԁ: 'd', ӏ: 'l', һ: 'h', ԛ: 'q', ԝ: 'w', α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
}))
/** 查用的样子（留着标点和空白）：NFKC、小写、像拉丁字母的换成拉丁字母、看不见的字去掉 */
export const looseForCheck = (s) => [...stripInvisible(String(s ?? '').normalize('NFKC')).toLowerCase()].map((c) => CONFUSABLE.get(c) ?? c).join('')
/** 查用的样子（只剩字母、数字、汉字）：再去掉组合符号、标点、符号和空白 —— 「主·人·说」「告-诉-主-人」「bili。mjs」都连起来 */
export const foldForCheck = (s) => looseForCheck(s).replace(/[\p{M}\p{P}\p{S}\s]+/gu, '')
/**
 * 读书笔记里的链接、邮箱、手机号 / 身份证 / 卡号、QQ / 微信号、8 位以上的号码、主人的号、像编码的一长串：换成（略）（不整篇拒 ——
 * 网页笔记里常有这些，整篇拒只会逼她想办法绕）。→ { text, n（换了几处） }。先洗过再换（调用方给的是 neutralizeText 洗过的）
 */
export function redactNote(t, { cfg = {} } = {}) {
  let n = 0
  const rep = (re) => { s = s.replace(re, () => { n += 1; return OMIT }) }
  const plain = stripInvisible(t)
  // 在 NFKC 折过的样子上找（全角的 ｈｔｔｐｓ：／／、１３８… 也认得出）；换了东西就交折过、再洗一遍的样子（全角括号折成半角了，洗回（））
  let s = stripInvisible(plain.normalize('NFKC'))
  rep(URL_RE); rep(CONTACT_RE); rep(IM_RE); rep(ENCODED_RUN); rep(LONG_NUM)
  // 换个写法的：拆开写的长号码（138-0013-8000、138 0013 8000）、汉字数字（一三八零零…）、光秃秃的 IP、
  // 把点写成「。 点 (dot) ·」的网址、(at) 写法的邮箱、中文顶级域名
  rep(/\d(?:[\s\-.·_]?\d){9,}/g)
  rep(/[零〇一二三四五六七八九两壹贰叁肆伍陆柒捌玖]{7,}/g)
  rep(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g)
  rep(/[a-z0-9][a-z0-9-]*\s*(?:。|点|[(（[]\s*dot\s*[)）\]]|·|\s\.\s?|\.\s)\s*(?:com|net|org|cn|io|xyz|top|me|cc|tv|info|co|de|uk|ru|jp|site|app|dev)\b/gi)
  rep(/[a-z0-9._-]+\s*[(（[]\s*at\s*[)）\]]\s*[a-z0-9.-]+/gi)
  rep(/[^\s（）]+\.(?:中国|中國|公司|网络|網絡|在线|网址|xn--[a-z0-9-]+)/g)
  for (const num of ownNumbers(cfg).filter((x) => /^\d{3,}$/.test(x))) rep(new RegExp(`(?<!\\d)${num}(?!\\d)`, 'g'))
  if (!n) return { text: plain, n }
  return { text: neutralizeText(s).replace(/(?:（略）\s*){2,}/g, OMIT), n }
}
