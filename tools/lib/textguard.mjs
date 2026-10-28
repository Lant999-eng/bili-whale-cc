// 洗字、查字的工具：她要往外发的字（公开发言的出门检查、信、陌生人私信）、要报给主人的字、像〔宿主〕的标记。
// 2026-10-27 从 sdm.mjs（陌生人私信）和 qq.mjs（QQ）原样搬来：这两块以后能整块拔掉，核心用的东西不能跟着它们走。
// sdm.mjs / qq.mjs 照旧转出这些名字。

// ─────────────── 像〔宿主〕的标记（原在 qq.mjs） ───────────────
// 括号：Unicode 里所有的开 / 闭括号和引号（Ps / Pe / Pi / Pf），再加上算作数学符号的尖括号 —— 以前是手写的一张表，
// 漏了〈（U+2329）、⟬、❨ 这类长得像的（2026-10-24 复核）。朝哪边都算（「〕宿主〔」在某些排版下也像标记）
export const BRACKET = '[\\p{Ps}\\p{Pe}\\p{Pi}\\p{Pf}<>＜＞﹤﹥⌜⌝⌞⌟]'
// 认标记时夹在中间的东西还要算上组合附加符（重音、圈、声调符号……贴在括号或字上几乎看不出来，2026-10-24 二轮复核）。
// 只用来认，不用来删 —— 正文里别处的附加符照常保留
export const GAP = '[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Cc}\\p{Z}\\s\\p{M}' + String.fromCharCode(0x2800) + ']*'
const TAG_LIKE = new RegExp(`${BRACKET}${GAP}宿${GAP}主${GAP}${BRACKET}`, 'gu')
// 双向控制符（LRM / RLM / ALM、嵌入、覆盖、隔离，一共 12 个）：「〔主宿〕」配上 RLO 会显示成「〔宿主〕」。
// 控制字符（换行、制表符以外的 C0 / C1，比如 DEL）：有的界面画成空白，「〔宿␡主〕」看起来就是「〔宿主〕」（2026-10-24 复核）。
// 这两类一律删掉 —— 零宽连接符、变体选择符不能删（表情、国旗要用），它们夹在标记里的情况上面的 IGN 已经认得
const BIDI_ALL = /\p{Bidi_Control}/gu
const CTRL_ALL = /(?![\n\t])\p{Cc}/gu
/**
 * 正文里任何像〔宿主〕标记的东西都改成不带括号的「宿主」二字（只有消息开头、由代码加的才算标记）。
 * 改到再也找不出为止：「〔〔宿主〕〕」改一遍里面那层，外面那层正好又拼成一个〔宿主〕
 */
export function neutralizeTags(s) {
  let out = String(s ?? '').replace(BIDI_ALL, '').replace(CTRL_ALL, '')
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(TAG_LIKE, '宿主') }
  return out
}

// ─────────────── 她要发出去的字（原在 sdm.mjs） ───────────────
export const TEXT_MAX = 300          // 一条私信最多多少字（和 dm.mjs 一样按 .length 算）
export const BIDI = /\p{Bidi_Control}/u
export const BAD_CTRL = /(?![\n])\p{Cc}/u
// 网址：带协议的、www. 开头的、像域名的（字母数字 + 点 + 两个以上字母的后缀 —— 不列后缀表：.moe .dev .ai .hk 都算；「node.js」这种也会被当成链接，宁可错拦）。
//   「@」后面的域名也算（「bilibili.com:@evil.cn」「去 @evil.cn」）—— 只有邮箱的那一半不算（a@b.com 归联系方式）
export const URL_RE = /(?:https?:\/\/|www\.)[^\s，。！？、；「」『』（）()<>"'【】]+|(?<![\w.-])(?<![\w.+-]@)(?:[a-z0-9-]+\.)+[a-z]{2,}(?![a-z0-9-])(?:\/[^\s，。！？、；]*)?/gi
// B站 的链接：域名后面只能跟端口号（数字）、路径、? 或 #（「https://www.bilibili.com:@evil.cn」这种带 @ 的其实去的是 evil.cn）
const BILI_URL = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:bilibili\.com|b23\.tv)(?::\d{1,5})?(?:[/?#]|$)/i
export const isBiliUrl = (u) => BILI_URL.test(String(u))
// 联系方式：手机号、15–19 位长号、身份证、邮箱（和记忆模块的 CONTACT 一样）+「QQ / 微信 / vx / 群 + 号」
export const CONTACT_RE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{15,19}(?!\d)|(?<!\d)\d{17}[\dXx](?![\dXx])|[\w.+-]+@[\w-]+\.[a-z]{2,}/gi
//   号要带数字（「qq音乐」「qqmusic」不算）；前面紧挨着英文字母的不算（「devx」里的 vx）；单个「Q」后面直接跟数字也算（「Q2938475610」，虚构的号码）
export const IM_RE = /(?<![a-z])(?:qq|扣扣|企鹅|微信|威信|薇信|weixin|wechat|vx|wx|v信|群号?|tg|telegram|电报)\s*(?:号码?|id)?\s*[:：是为]?\s*(?=[a-z0-9_-]*\d)[a-z0-9_-]{5,}|(?<![a-z0-9])q\s*[:：]?\s*\d{5,}/gi
// 8 位以上的一串数字（QQ 号、UID、各种号码 —— 带不带「QQ」这个词都算）；前面紧挨着字母 / 下划线的不算（av 号、bili_123…），链接里的（/ = & # 后面）不算
export const LONG_NUM = /(?<![\dA-Za-z_/=&#])\d{8,}(?!\d)/g
const NUM_WHY = '正文里有一串号码 —— 私信里不发号码（QQ、UID、手机号这类都不发）'
export const LOCAL_PATH = /(?<![A-Za-z])[A-Za-z]:[\\/]|\\Users\\|\/Users\/|\/home\/|\.bili-ai|\.bili-whale|whale-work|whale-cc/i
const COOKIE_NAMES = /SESSDATA|bili_jct|DedeUserID|buvid3|refresh_token/i
const numIn = (s, n) => Boolean(n) && /^\d{3,}$/.test(n) && new RegExp(`(?<!\\d)${n}(?!\\d)`).test(s)
// 比对之前先「折叠」：零宽 / 方向控制字符去掉；全角、花体的字母数字和「．」「＠」换成半角（「example．com」「ＱＱ：２９３８…」「𝟏𝟑𝟖…」绕不过去）。
// 中文标点（，！？：（））不动 —— 给她看的字基本还是原样
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
export const foldText = (s) => String(s ?? '').replace(INVISIBLE, '')
  .replace(/[^\x00-\x7F]/gu, (c) => { const k = c.normalize('NFKC'); return /^[A-Za-z0-9.@]$/.test(k) ? k : c })

/**
 * 她要发的这句话能不能发 → { ok: true, text（收拾好的） } 或 { ok: false, why }。全在联网之前做（--dry 不联网）：
 * 1–300 字的纯文字；不带站外链接（B站 的链接、BV / av 号可以）、手机号 / QQ / 微信 / 邮箱、8 位以上的号码、主人的 UID 和 QQ、电脑路径、cookie 的名字。
 * 都在「折叠」过的那一份上查（全角、零宽字符绕不过去）；号码不论是谁的都是同一句话 —— 不说「这是主人的号」（不然陌生人拿号码一试就知道了）
 */
export function checkReplyText(raw, { cfg } = {}) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim()
  if (!text) return { ok: false, why: '--msg 是空的' }
  if (BIDI.test(text) || BAD_CTRL.test(text)) return { ok: false, why: '正文里有看不见的控制字符 —— 只发普通文字' }
  if (text.length > TEXT_MAX) return { ok: false, why: `太长了（${text.length} 字，一条最多 ${TEXT_MAX} 字）：私信像聊天，一两句就够` }
  // 主人的 UID 是连链接一起查的（space.bilibili.com/<主人> 也不行）
  const hit = scanOutbound(text, { nums: ownNumbers(cfg) })
  if (hit?.kind === 'link') return { ok: false, why: `不发站外链接（${hit.link.slice(0, 40)}）—— B站 的链接、BV 号可以` }
  if (hit?.kind === 'contact') return { ok: false, why: '不发手机号、QQ、微信、邮箱这类联系方式（也不跟人交换）' }
  if (hit?.kind === 'number') return { ok: false, why: NUM_WHY }
  if (hit?.kind === 'path') return { ok: false, why: '正文里像有电脑上的路径 —— 不往外说' }
  if (hit?.kind === 'cookie') return { ok: false, why: '正文里有登录凭据的名字 —— 不往外说' }
  return { ok: true, text }
}

/** 主人的 UID、QQ，她自己的 QQ（配置里的这一组：查号码时连它们一起查） */
export const ownNumbers = (cfg) => [cfg?.owner?.mid, cfg?.qq?.ownerQq, cfg?.qq?.selfQq].map((x) => String(x ?? '').trim())

/**
 * 她要往外发的字「扫一遍」（回陌生人私信的 checkReplyText、公开发言的 tools/lib/outbound.mjs 共用；话怎么说由调用的一方定）：
 * 在折叠过的一份上依次找 站外链接 → 联系方式 → 号码（8 位以上的一串、nums 里的号）→ 电脑路径（只在链接以外的地方找：「https://」里的「s:/」不算）→ cookie 的名字。
 * 第一个命中的 → { kind: 'link' | 'contact' | 'number' | 'path' | 'cookie', link（只有 link 有：第一条站外链接） }；都没有 → null。
 * 号码只说「是号码」，不说是谁的
 */
export function scanOutbound(text, { nums = [] } = {}) {
  const f = foldText(text)
  const links = (f.match(URL_RE) ?? []).filter((u) => !isBiliUrl(u))
  if (links.length) return { kind: 'link', link: links[0] }
  if (f.match(CONTACT_RE) || f.match(IM_RE)) return { kind: 'contact' }
  if (f.match(LONG_NUM) || nums.some((n) => numIn(f, String(n ?? '').trim()))) return { kind: 'number' }
  if (LOCAL_PATH.test(f.replace(URL_RE, ' '))) return { kind: 'path' }
  if (COOKIE_NAMES.test(f)) return { kind: 'cookie' }
  return null
}
