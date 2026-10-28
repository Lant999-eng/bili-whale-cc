// 公开发言的出门检查（2026-10-26 主人定）：她发出去、主人以外的人也看得到的字，发之前在代码里过一遍 ——
//   评论 / 楼中楼回复 / 分享评论（@ 主人）· 动态（文字、图文、编辑已发的动态）· 直播弹幕（tools/commands/ 下的 comment、dynamic、dynamic-image、edit-dynamic、danmaku）。
//   以前只靠她的守则；她的会话里同时有主人的私信、日记和记忆，守则漏一次就是公开的。
//   · 查的就是回陌生人私信那一套（tools/lib/sdm.mjs 的 scanOutbound，先「折叠」：全角、零宽字符绕不过去）：站外链接、手机号 / QQ / 微信 / 邮箱、
//     8 位以上的一串数字、主人的 UID 和 QQ、她自己的 QQ（配置里的）、电脑上的路径、cookie 的名字。没有主人自定的词表
//   · 公开的比私信多收拾一步（只在这里做，私信的 checkReplyText 一字不变）：
//     - 看不见的字一律先拿掉再查：变体选择符（FE0F）、键帽「⃣」、标签字符、韩文填充符、组合附加符号（删除线之类）—— 「7️⃣6️⃣5️⃣」「2938️475610」「evil️.cn」都绕不过去
//     - 英文字母中间的「。」「｡」当成点（「evil。cn」浏览器照样能打开）
//     - 小数点后面的数字、像日期的 8 位数（20261026）、整的大数（100000000）不算长号码 —— 她讲数学、说播放量用得着；2^32 = 4294967296 这种还是要改写
//     - B站 链接里的 ? 后面、路径里不是 id 的位置上的长数字也查（私信那一套在链接里不查）
//     - 路径、cookie 名多认几种写法（%USERPROFILE%\、\\wsl$、AppData\、/root/、「SESS DATA」「bili＿jct」），B站 链接里的也查
//   · 长度上限还是各命令自己的（评论 1000 字、弹幕看房间……），不用私信的 300 字；空的不在这里管（各命令自己要求有没有正文）
//   · B站 的 id 先换掉再查号码（只换真正是 id 的那几种样子）：BV / av / cv 号、space.bilibili.com/<UID>、t.bilibili.com/<动态>、/opus/<图文>、
//     live.bilibili.com/<直播间>、b23.tv 都能发；别的位置上的 15–19 位长号（银行卡、身份证）照样拦。
//     主人的 UID / QQ、她的 QQ 在没换过的那一份上另查（space.bilibili.com/<主人> 照样不发；中间夹空格、横线、顿号、逗号的也算）；「@主人的昵称」可以
//   · 不让发的话只说是哪一类、怎么改：不说是谁的号，不把命中的号码抄出来（站外链接只报域名，域名里 5 位以上的数字也遮掉）
//   · 各命令在联网、占额度、记账、上锁、写文件之前调它（--dry、预演也一样）；不让发 → 退出码 2（和别的「拒绝发送、改了再来」一样），什么都没发
//   · 主人还要审的（待审回复草稿、交审的视频标题 / 简介 / 标签）用 publicAdvice：不拦，只把过不了的地方写进给主人的审核通知
//   · 拦不住的：换个说法说出来的私事（「主人今天在……」）、拆开写的别人的号码、汉字写的数字、「evil 点 cn」这种看得见的写法 —— 这些还靠她的守则
//   · 前提：她改不了自己命令的环境变量（BILI_WHALE_CONFIG / DSH_HOME 指到不存在的文件，配置就退回默认、主人的号查不到 —— 和 BILI_WHALE_AGENT 是同一个前提）
//   · Codex 复查（2026-10-26）后再补：「bilibili.com。CN」大写后缀；主人的号夹在更长的数字里（07654321、0.76543210）；
//     字母开头的长数字（id87654321）；「QQ 20261026」这种标了 QQ 的日期样数字；字母的微信号（wx: abcdef）；「a@昵称」的邮箱；
//     ~/ 开头和一般的 /a/b 路径；B站 链接里 vd_source 这类跟踪参数不再误拦；站外域名里的数字全部遮掉
import { BIDI, BAD_CTRL, URL_RE, LOCAL_PATH, IM_RE, foldText, isBiliUrl, scanOutbound, ownNumbers } from './textguard.mjs'
import { readConfigStrict } from './config.mjs'

/** 各通道在提示里的叫法 */
export const PUBLIC_CHANNELS = {
  comment: '评论',
  reply: '回复',
  share: '分享评论',
  dynamic: '动态',
  'dynamic-image': '图文动态',
  'dynamic-edit': '动态（编辑）',
  danmaku: '弹幕',
  video: '视频的标题 / 简介 / 标签',
}

// 看不见、但会把数字 / 网址拆开的字：Unicode 的「默认忽略」一类（零宽、变体选择符 FE0F、标签字符、韩文填充符、蒙古文变体选择符……）
//   + 组合附加符号（键帽 20E3、删除线 0336 这类叠在字上的）。只从「查的那一份」里拿掉，发出去的还是她写的原样
const INVISIBLE_MORE = /[\p{Default_Ignorable_Code_Point}\p{M}]/gu
// 英文字母 / 数字中间的「。」「｡」：浏览器把它们当成点（「evil。cn」「bilibili.com。CN」都能打开）—— 大小写都算；BV 号后面的不换（「BV1xx。Nice」是句号）
const IDEO_DOT = /(?<=[A-Za-z0-9])(?<!BV1[0-9A-Za-z]{9})[。｡](?=[A-Za-z]{2,})/g
// 全角 / 别的写法的下划线、横线、冒号、斜杠、反斜杠：换成半角再查（「abc＿123」「C：＼Users」「abc－123」）
const WIDE_PUNCT = { '＿': '_', '－': '-', '‐': '-', '‑': '-', '−': '-', '：': ':', '／': '/', '＼': '\\' }
/** 查之前的那一份：拿掉看不见的字 → 折叠（全角、花体换半角）→ 全角标点换半角 → 字母中间的「。」换成点 */
const prep = (s) => foldText(String(s ?? '').replace(INVISIBLE_MORE, '')).replace(/[＿－‐‑−：／＼]/g, (c) => WIDE_PUNCT[c]).replace(IDEO_DOT, '.')

// B站 链接里真正是 id 的几种样子（只换这些；别的位置上的长数字照样查）：UID 最长 16 位、动态 / 图文 19 位、直播间 12 位
const BILI_URL_IDS = [
  /(?<=^(?:https?:\/\/)?space\.bilibili\.com\/)\d{1,16}(?!\d)/i,
  /(?<=^(?:https?:\/\/)?t\.bilibili\.com\/)\d{1,19}(?!\d)/i,
  /(?<=^(?:https?:\/\/)?live\.bilibili\.com\/(?:h5\/)?)\d{1,12}(?!\d)/i,
  /(?<=^[^?#]*\/(?:opus|dynamic)\/)\d{1,19}(?!\d)/i,      // www / m.bilibili.com/opus/<图文>、m.bilibili.com/dynamic/<动态>
  /(?<=^[^?#]*\/(?:space|list)\/)\d{1,16}(?!\d)/i,        // m.bilibili.com/space/<UID>、www.bilibili.com/list/<UID>
]
// B站 链接里的跟踪参数（分享时自动带的）：值里常有 8 位以上的数字，但不是号码 —— 只在 B站 链接里、只换长得完全对的值
//   （vd_source / share_session_id 是 32 位十六进制，ts / timestamp 是 10 或 13 位的时间戳；后面紧接着的字不动：「vd_source=abc我的手机…」照样查）
//   值要整个对得上（后面紧跟着还是能放进值里的字就不算：「ts=1765432199abc」「vd_source=<32 位>_x」照样查）
const BILI_TRACK = /([?&#](?:vd_source|share_session_id)=)[0-9a-f]{32}(?![A-Za-z0-9_.~%-])|([?&#](?:ts|timestamp)=)1[6-9]\d{8}(?:\d{3})?(?![A-Za-z0-9_.~%-])/gi
/**
 * B站 的 id 先换成「#」：上面那几种链接里的 id、B站 链接里的跟踪参数；正文 / 链接里的 BV 号、av / cv 号（av 号最长 16 位，同 video-id.mjs；
 * 17 位以上的不是 av 号，照样查）、默认昵称「bili_」后面的数字。都是号码规则会误拦的，别的不动
 */
const maskBiliIds = (f) => f
  .replace(URL_RE, (u) => (isBiliUrl(u) ? BILI_URL_IDS.reduce((x, re) => x.replace(re, '#'), u).replace(BILI_TRACK, (m, a, b) => `${a ?? b}#`) : u))
  .replace(/(?<![0-9A-Za-z])BV1[0-9A-Za-z]{9}(?![0-9A-Za-z])/g, 'BV#')
  .replace(/(?<![A-Za-z])(av|cv)\d{1,16}(?![0-9A-Za-z_])/gi, '$1#')      // 整个词就是 av / cv 号才换（「av87654321hello」不算）
  .replace(/(?<![A-Za-z0-9])bili_\d+(?![0-9A-Za-z_])/gi, 'bili_#')
// 不算长号码的数：小数点后面的（0.333333333、3.14159265358979）、像日期的 8 位（20261026）、整的大数（100000000、10000000）
const DATE8 = /^(?:19|20)\d\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/
const ROUND = /^[1-9]\d?0{6,}$/
const maskMath = (f) => f
  .replace(/(?<=\d\.)\d+/g, '#')
  .replace(/(?<!\d)\d{8,}(?!\d)/g, (n) => (DATE8.test(n) || ROUND.test(n) ? '#' : n))
/** B站 链接的 ? / # 后面那段（只到英文字符为止）：只用来判断「联系方式」是不是出在参数里 */
const dropBiliQuery = (f) => f.replace(URL_RE, (u) => (isBiliUrl(u) ? u.replace(/[?#][\x21-\x7E]*/g, '') : u))

// 私信那一套在链接里（/ = & # 后面）、字母后面不查长数字；公开的哪里都查（「id87654321」也算；B站 的 id、BV / av 号、小数、日期上面已经换掉了）
const LONG_NUM_ANY = /(?<!\d)\d{8,}(?!\d)/
// 写明了是 QQ / 微信 / 电报……的账号：字母开头的也算；私信那一套只认带数字的。
//   「wx: abcdef」「微信号是 fake_handle」「加我微信 abcdef」拦；「微信：Windows 版更新了」「QQ：Android 版」不拦 ——
//   全名加冒号的，后面那个词带下划线 / 数字、或者是 6 个以上的小写字母（像账号）才算
const PLAT = 'qq|扣扣|企鹅|微信|威信|薇信|weixin|wechat|telegram|电报|discord|whatsapp|推特|twitter'
const HANDLE_SHORT = /(?<![a-z])(?:vx|wx|v信|tg)\s*[:：]\s*@?[A-Za-z][A-Za-z0-9_.-]{3,}/i
const HANDLE_ACCT = new RegExp(`(?<![a-z])(?:${PLAT}|vx|wx|v信|tg)\\s*(?:号码?|id|账号|帐号)\\s*[:：是为]?\\s*@?[A-Za-z][A-Za-z0-9_.-]{3,}`, 'i')
const HANDLE_ADD = /加\s*我?\s*(?:qq|微信|vx|wx|v信|tg|telegram|电报|discord)\s*[:：]?\s*@?[A-Za-z][A-Za-z0-9_.-]{3,}/i
const HANDLE_NAME = new RegExp(`(?<![a-z])(?:${PLAT})\\s*[:：]\\s*@?([A-Za-z][A-Za-z0-9_.-]{3,})`, 'gi')
// 平台名后面直接跟「@账号」的（「Telegram: @FakeUser」「wx @bili_123…」）：@ 就是账号的记号，大小写都算
const HANDLE_AT = new RegExp(`(?<![a-z])(?:${PLAT}|vx|wx|v信|tg)\\s*(?:号码?|id|账号|帐号)?\\s*[:：]?\\s*@[A-Za-z0-9_][A-Za-z0-9_.-]{2,}`, 'i')
// 「微信：Windows 版」「QQ：android 版」「微信：windows11」「QQ：v9.9.9」：产品名、版本号不是账号
const NOT_HANDLE = /^(?:(?:windows|android|linux|macos|mac|ios|ipados|harmonyos|iphone|ipad|desktop|mobile|online|beta|update|version|official|web|wechat|weixin|qq|tim)\d*|v?\d+(?:\.\d+)+)$/i
// 前面说了「联系我 / 加我 / 找我 / 私聊」的，平台名后面的词算账号（「联系我：微信：FakeHandle」）—— 产品名、版本号除外（「私聊用微信 Android 版」）
const HANDLE_CTX = new RegExp(`(?:联系|加我|找我|私聊|私我)[^。！？\\n]{0,6}(?:${PLAT}|vx|wx|v信|tg)\\s*[:：]?\\s*@?([A-Za-z][A-Za-z0-9_.-]{3,})`, 'gi')
// 「我的微信是 FakeHandle」「我微信号为 fake」：自己报出来的账号
const HANDLE_MINE = new RegExp(`我的?(?:${PLAT}|vx|wx|v信|tg)(?:号码?|账号|帐号|id)?\\s*(?:[:：]|是|为)\\s*@?([A-Za-z][A-Za-z0-9_.-]{3,})`, 'gi')
// 写明了是电话的号（「电话：+1-202-555-0147」「我的电话是 (202) 555-0147」「手机 (02) 1234 5678」）：国外的写法也算；
//   数字至少 7 个；整个是日期 / 钟点的不算（「周末约电话 2026-11-01」「我的手机 2026-10-26 刚买的」）
const LABELLED_PHONE = /(?:电话|手机|座机|tel|phone|call|致电)\s*(?:号码?)?\s*(?:[:：]|是|为)?\s*(\+?\(?\d[\d\s().-]{5,}\d)/gi
const isDateLike = (n) => /^(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?$/.test(n.trim())
const labelledPhone = (s) => [...s.matchAll(LABELLED_PHONE)].some((m) => !isDateLike(m[1]) && m[1].replace(/\D/g, '').length >= 7)
// 平台名 + 冒号后面那个词像不像账号：带下划线 / 数字 / 中间的横线、大小写混着（FakeHandle、fakeHandle）、6 个以上的字母（Fakehandle）；产品名、版本号不算
const looksHandle = (w) => {
  const h = w.replace(/[._-]+$/, '')   // 句末的点不算账号的一部分（「微信：fakehandle.」）
  return !NOT_HANDLE.test(h) && (/[_\d-]/.test(h) || /[a-z][A-Z]/.test(h) || /^[A-Za-z][a-z]{5,}$/.test(h))
}
const labelledHandle = (s) => HANDLE_SHORT.test(s) || HANDLE_ACCT.test(s) || HANDLE_ADD.test(s) || HANDLE_AT.test(s) || labelledPhone(s) ||
  [...s.matchAll(HANDLE_CTX)].some((m) => !NOT_HANDLE.test(m[1].replace(/[._-]+$/, ''))) ||
  [...s.matchAll(HANDLE_MINE)].some((m) => !NOT_HANDLE.test(m[1].replace(/[._-]+$/, ''))) ||
  [...s.matchAll(HANDLE_NAME)].some((m) => looksHandle(m[1]))
const IM_ONE = new RegExp(IM_RE.source, 'i')   // 不带 g：test() 不留 lastIndex
// 邮箱：在换掉昵称、B站 id 之前查（「av87654321@bilibili.com」「"fake name"@owner.moe」「fake @ qq . com」）
//   带空格的那种：分隔只认英文的点（「OK @Owner。 VIP」是句号，不算），后缀只认常见的、不像英文单词的那些
//   （vip / top / me / de 这种会和普通的英文、德语撞：「。 VIP 大会员」「Kap 2. de Morgan」）
const SPACED_TLD = 'com|net|org|cn|edu|gov|dev|io|xyz|tv|app|icu|biz|info'
const EMAIL_ANY = new RegExp(`[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)*\\.[a-z]{2,}|"[^"\\n]{1,64}"@[\\w-]+(?:\\.[\\w-]+)*\\.[a-z]{2,}` +
  `|[\\w.+-]+\\s*@\\s*[\\w-]+(?:\\s*\\.\\s*[\\w-]+)*\\s*\\.\\s*(?:${SPACED_TLD})(?![\\w-])`, 'i')
// 点、句号两边带空格的网址（「去 example。 com 看看」「evil . cn」「example . dev」）：只认上面那些后缀；在去掉 B站 链接的那一份上查
//   （「b23.tv/AbCdEf。 VIP」不算）
const SPACED_HOST = new RegExp(`[A-Za-z0-9-]+\\s*[。｡.]\\s+(?:${SPACED_TLD})(?![A-Za-z0-9-])|[A-Za-z0-9-]+\\s+[。｡.]\\s*(?:${SPACED_TLD})(?![A-Za-z0-9-])`, 'i')
// 带汉字（或别的非英文字）的域名 —— 私信那一套的网址规则只认英文的：
//   · 「例子.cn」「bilibili.com.公司.cn」：整段都是非英文字母 / 数字的一节，后面「.」接英文后缀（「推荐b23.tv」「（b23.tv」这种挨着中文的不算）
//   · 「例子。cn」「bilibili.com。例子。cn」「xx。中国」：「。」接常见后缀（汉字句号后面的英文一般不是后缀，所以只认这几个）
const IDN_LABEL = '(?:(?![\\x00-\\x7F])[\\p{L}\\p{N}])+'
const IDN_TLD = 'com|net|org|cn|xyz|top|cc|vip|icu|info|biz|io|me|so|tv|hk|tw|jp|ru|uk|de|中国|公司|网络|网址'
const IDN_HOST = new RegExp(`${IDN_LABEL}\\.(?:[A-Za-z0-9-]+\\.)*[a-z]{2,}(?![a-z0-9-])|(?<=[\\p{L}\\p{N}])[。｡](?:${IDN_TLD})(?![\\p{L}\\p{N}-])` +
  `|(?<=[\\p{L}\\p{N}])\\.\\p{Script=Han}{2,4}(?![\\p{L}\\p{N}-])`, 'iu')   // 汉字后缀：「例子.中国」「bilibili.com.香港」
// 路径多认几种：%USERPROFILE%\、\\wsl$\ 和别的 \\机器\、AppData\、Desktop\ 之类、~/ 开头的、/root/ /etc/ 这类 Linux 目录
const PATH_MORE = /%[A-Z_][A-Z0-9_]*%[\\/]|\\\\(?:wsl|[\w.$-]+\\)|AppData[\\/]|(?:Desktop|Documents|Downloads)\\|(?<![\w~])~[\\/]|(?<![\w.-])\/(?:root|etc|opt|mnt|var|tmp|usr|srv)\//i
// 一般的 /a/b 路径（两段以上，前面不挨着英文字母、数字、括号；挨着汉字的算：「文件在/data/notes」）：只在链接以外找（B站 链接的 /video/BV… 不算）。
//   至少有一段 2 个字以上、而且第一段或最后一段是字母开头（「/1.23/notes」算）；
//   「1/2」「TCP/IP」「2026/10/26」「2026 /10/26」「(x+y)/2/3」「中文字幕/1080P/60fps」「1 /x/y = 1/(x*y)」都不算
//   第一段是英文的，后面的段可以是汉字（「/data/私人/日记」）；「./」「../」开头的相对路径也算（「./notes/private」）。
//   有一段 2 个字以上、而且带字母才算（「1 /x/10 = 0.1/x」不算）
//   调用的一方已经把网址去掉了，所以前面挨着冒号也算（「文件：/data/notes」—— 全角冒号查之前换成了半角）
const UNIX_PATH_C = /(?<![A-Za-z0-9_.\/~)\]\\-])\/[A-Za-z0-9._-]+(?:\/[\p{L}\p{N}._-]+)+/gu
const REL_PATH = /(?<![\w.])\.\.?\/[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)*/u
// 第一段就是汉字的（「文件在/私人/日记」）：前面得是空白、开头、冒号、「在 / 于」或括号 —— 「上海/北京/广州」不算
const HAN_PATH = /(?:^|(?<=[\s在于:「（(]))\/(?![\x00-\x7F])\p{L}[\p{L}\p{N}._-]*(?:\/[\p{L}\p{N}._-]+)+/u
const isUnixPath = (s) => REL_PATH.test(s) || HAN_PATH.test(s) || [...s.matchAll(UNIX_PATH_C)].some(([p]) => {
  const segs = p.split('/').filter(Boolean)
  return segs.some((x) => x.length >= 2 && /\p{L}/u.test(x)) && (/^[A-Za-z._]/.test(segs[0]) || /^[A-Za-z._]/.test(segs.at(-1)))
})
// cookie 名中间夹空格、横线、全角下划线的也算（「SESS DATA」「bili＿jct」）；refresh_token 只认带下划线的（「refresh token」是普通说法）
const COOKIE_MORE = /SESS[\s_＿-]*DATA|bili[\s_＿-]*jct|Dede[\s_＿-]*User[\s_＿-]*ID|buvid[\s_＿-]*3|refresh[_＿]token/i

// 主人 / 她自己的号：6 位以上的，数字之间夹最多 3 个不是字母数字的字（空格、横线、全角横线、顿号、逗号、斜杠、emoji……）也算；
//   夹在更长的数字里也算（「07654321」「0.76543210」—— 不然前后多一位就躲进了 B站 id、小数的放行里）。5 位以下的还要求前后不是数字
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
//   查之前空白先合成一个（「7654    321」）；5 位的也认中间夹的隔断，但前后不能挨着数字（「54 321」）
const ownRe = (n) => new RegExp(n.length >= 6 ? [...n].join('[^\\p{L}\\p{N}]{0,3}')
  : n.length === 5 ? `(?<!\\d)${[...n].join('[^\\p{L}\\p{N}]{0,3}')}(?!\\d)` : `(?<!\\d)${n}(?!\\d)`, 'u')

/** 站外链接只报域名（路径、参数里可能夹着别的东西）：去掉协议、「xx@」前面那段，数字全遮掉（拆开写的号也不抄回去），最多 40 字 */
const hostOf = (u) => String(u).replace(/^(?:https?:\/\/)?/i, '').split(/[/?#]/)[0].split('@').pop().replace(/\d+/g, '…').slice(0, 40)

const WHY = {
  control: () => '正文里有看不见的控制字符 —— 只发普通文字',
  link: (h) => `公开的话里不放站外链接（${hostOf(h.link)}）—— B站 的链接、BV 号可以；像 bili.mjs、check.jpg 这种文件名、英文字母中间夹的「。」也会被当成链接，换个说法或者去掉后缀`,
  contact: () => '公开的话里不放手机号、QQ、微信、邮箱这类联系方式 —— 把这一段删掉',
  number: () => '公开的话里有一串不能公开的号码（QQ、UID、手机号这类，或者 8 位以上的长数字，很大的整数也算）—— 删掉它；' +
    '大数写成「约 43 亿」「4.29×10^9」或者加逗号「4,294,967,296」；提视频、动态用 BV 号或 B站 链接（? 后面的参数去掉），日期、时间、集数、小数可以',
  path: () => '公开的话里像有电脑上的路径 —— 不往外说（说「自查图」「剧本」这类叫法，别写路径）',
  cookie: () => '公开的话里有登录凭据的名字 —— 不往外说，把这一段删掉',
}

/**
 * 她要公开发的这段字能不能发 → { ok: true, text（原样，不改她写的字） } 或 { ok: false, kind, why }。
 * cfg：主人的配置（要 owner.mid / owner.name、qq.ownerQq / qq.selfQq）。每个通道查的都一样（通道只决定 publicGate 的提示里怎么叫它）
 */
export function checkPublicText(raw, { cfg = {} } = {}) {
  const text = String(raw ?? '')
  const t = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  if (!t.trim()) return { ok: true, text }
  if (BIDI.test(t) || BAD_CTRL.test(t)) return { ok: false, kind: 'control', why: WHY.control() }
  let f = prep(t)
  // 联系方式先在原样（只折叠过）的那一份上查 —— 换昵称、换 B站 id、换小数日期之前（换过以后会把它们拆开或藏起来）：
  //   写明了 QQ / 微信……的号和账号（「QQ 20261026」「wx bili_13800138000」「QQ BV1123456789」「Telegram: @FakeUser」）、邮箱
  //   （带 http:// 的网址里「用户名@域名」那段不算邮箱：那是站外链接，下面按链接报）
  if (IM_ONE.test(f) || labelledHandle(f) || EMAIL_ANY.test(f.replace(/https?:\/\/\S+/gi, ' '))) return { ok: false, kind: 'contact', why: WHY.contact() }
  // 「@主人的昵称」可以（分享评论开头就是它）：查之前换成「@主人」—— 昵称里像域名、像号码的部分不算。
  //   后面紧跟着字母、数字、点、横线的不换（「@Owner.evil.cn」照常当链接查）；前面挨着邮箱用户名能用的字（含引号）时不换
  const name = prep(String(cfg?.owner?.name ?? '').trim())
  const g = name ? f.replace(new RegExp(`(?<![A-Za-z0-9!#$%&'*+/=?^_\`{|}~."-])@${escRe(name)}(?![\\w.-])`, 'g'), '@主人') : f
  // 站外链接：在换掉 B站 id、小数之前查（「av87654321.cn」「123.456.cn」换过就不像网址了）；带汉字的域名另外认
  const off = (g.match(URL_RE) ?? []).find((u) => !isBiliUrl(u)) ?? g.match(IDN_HOST)?.[0] ?? g.replace(URL_RE, ' ').match(SPACED_HOST)?.[0]
  if (off) return { ok: false, kind: 'link', why: WHY.link({ link: off }) }
  // 电脑上的路径（「/data/20261026/notes」「/av12345678/notes」「文件在/data/notes」）
  if (LOCAL_PATH.test(g) || PATH_MORE.test(g) || isUnixPath(g.replace(URL_RE, ' '))) return { ok: false, kind: 'path', why: WHY.path() }
  const scan = maskMath(maskBiliIds(g))
  let hit = scanOutbound(scan)
  // 「联系方式」只出在 B站 链接的参数里（?oid=113024680135791 这种长 id；这个号是虚构的例子）→ 按号码说：那句话会告诉她把 ? 后面去掉
  if (hit?.kind === 'contact' && scanOutbound(dropBiliQuery(scan))?.kind !== 'contact') hit = { kind: 'number' }
  if (hit) return { ok: false, kind: hit.kind, why: WHY[hit.kind](hit) }
  // 主人的 UID / QQ、她的 QQ：在 B站 的 id 没换过的那一份上查（space.bilibili.com/<主人> 也不行；小数点后面的也算）
  const nums = ownNumbers(cfg).filter((n) => /^\d{3,}$/.test(n))
  const fs1 = f.replace(/\s+/g, ' ')
  if (nums.some((n) => ownRe(n).test(fs1))) return { ok: false, kind: 'number', why: WHY.number() }
  // 私信那一套之外再查的：链接里的长数字、路径（连 B站 链接里的也查）、cookie 名的变体
  if (LONG_NUM_ANY.test(scan)) return { ok: false, kind: 'number', why: WHY.number() }
  // cookie 名一个字母一个字母隔开写的（「S E S S D A T A」「b i l i _ j c t」）：单个字母之间的空格去掉再查一遍
  const unspaced = scan.replace(/(?<![A-Za-z_])([A-Za-z_])\s+(?=[A-Za-z_](?![A-Za-z]))/g, '$1')
  if (COOKIE_MORE.test(scan) || COOKIE_MORE.test(unspaced)) return { ok: false, kind: 'cookie', why: WHY.cookie() }
  return { ok: true, text }
}

/**
 * 命令里用：现读主人的配置再查 → 能发 = null；不能发 = { code, msg }（调用的一方打 msg 到 stderr、按 code 退出，什么都不发）。
 *   查不过 → 2：一行给她看的话（哪一类、怎么改，不抄出命中的东西）
 *   配置文件在、但读不出来（主人手改到一半）→ 3：查不了主人的号，这次先不发（不能退回默认值 —— 默认里没有主人的号，等于不查）
 */
export function publicGate(text, { channel = '' } = {}) {
  const label = PUBLIC_CHANNELS[channel] ?? '公开发言'
  const cfg = readConfigStrict()
  if (!cfg) return { code: 3, msg: `✗ 这条${label}没发：配置文件读不出来，查不了哪些号码不能公开 —— 什么都没发；请主人看一下配置` }
  const r = checkPublicText(text, { cfg })
  if (!r.ok) return { code: 2, msg: `✗ 这条${label}没发：${r.why} —— 什么都没发` }
  return null
}

/**
 * 主人还要审的公开文字（待审回复草稿、交审视频的标题 / 简介 / 标签）：同一套检查，但不拦 —— 过得了 = null；
 * 过不了 = 一句话（给她看，也写进给主人的审核通知：回复草稿批准时还会被 publicGate 拦下，视频的字主人自己看）
 */
export function publicAdvice(text, { channel = '' } = {}) {
  const label = PUBLIC_CHANNELS[channel] ?? '公开发言'
  const cfg = readConfigStrict()
  if (!cfg) return `这条${label}没法做出门检查：配置文件读不出来，查不了哪些号码不能公开`
  const r = checkPublicText(text, { cfg })
  return r.ok ? null : `这条${label}过不了公开发言的检查：${r.why}`
}
