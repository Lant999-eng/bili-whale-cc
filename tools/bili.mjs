#!/usr/bin/env node
// 统一入口：node bili.mjs <命令> [参数...]
// 只是把你转到 commands/ 或 verify/ 下的具体脚本，参数原样透传。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_EXE } from './lib/nodebin.mjs'   // 2026-10-21：别用 process.execPath（Electron 里它是主程序 ✗）
import { credDirty, DIRTY_CRED_MSG } from './lib/cred.mjs'
import { configPath } from './lib/paths.mjs'
import { listenReady } from './lib/listen.mjs'
import { commandAllowed, listedIn, isSdmTurn, SDM_ONLY } from './lib/turn-policy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const map = {
  // —— 读（不需要写操作，安全） ——
  session: ['verify/session.mjs', '确认凭据属于哪个号'],
  thread: ['verify/thread.mjs', '导出一条评论的楼中楼结构（最多 200 条回复：10 页 × 20）'],
  'check-comment': ['verify/comment-exists.mjs', '按 rpid 复核评论是否存在'],
  'check-dynamic': ['verify/dynamic-inspect.mjs', '看动态的结构化内容（类型/图片/节点）'],
  'check-mention': ['verify/mention-check.mjs', '确认动态里的 @ 是不是真提及（查 opus 页）'],
  watch: ['verify/watch-replies.mjs', '盯一条评论的楼中楼等新回复：--aid --root --bvid [--uid 只认某人] [--minutes]'],
  'comment-await': ['commands/comment-await.mjs', '评论版"叫我起床"：廉价进程守「回复我的」，命中即退出叫醒 agent（0 token）：--minutes --interval [--only-owner]'],
  'comment-digest': ['commands/comment-digest.mjs', '今天谁找过人家（回复+@ 两个收件箱汇总，只读）：--hours 24 --pages 2 [--only-unread]'],
  'comment-images': ['commands/comment-images.mjs', '看 TA 那条评论附的图（只看这一条的，不看楼主的）：--oid --rpid <坐标里的 parent> [--root] [--type] [--mid] [--max 4] —— 下到 shots/comment-img，再用 Read 看'],
  recon: ['verify/dryrun.mjs', '发评论前的侦查：BV→aid + 评论区状态 + WBI 材料'],
  video: ['commands/video-content.mjs', '不点开视频也能还原它讲什么（读文字：简介/字幕/弹幕/评论）'],
  subtitles: ['commands/subtitles.mjs', '拉官方字幕全文（WBI 签名，带时间戳）：<BV> [--lan ai-zh] [--print N] —— 看视频最省的一条腿'],
  'watch-video': ['commands/bili-watch.mjs', '真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼九宫格 → 交给 read_image：<BV> [3x3|4x4] [--uniform]'],
  watched: ['commands/watched.mjs', '看片记录：show <BV>（取到了哪些素材、看的范围、你记过的理解、你对它做过什么）/ note <BV> --text "…"（记你看懂了什么；范围由工具盖上）/ list [--days 1]'],
  debrief: ['commands/debrief.mjs', '看懂一条视频（一条龙）：封面+简介+官方字幕+弹幕热区(对齐字幕)+热评+画面抽帧：<BV> [--bucket 30] [--top 5] [--grid 3x3] [--no-frames]'],
  listen: ['commands/listen.mjs', '听一条视频的声音（本机转写，带时间、情绪和背景音乐 / 笑声这类声音）：<BV> [--min 8] —— 没字幕、或想知道语气和背景音乐时用'],
  comments: ['commands/comments.mjs', '热评 / 最新评论（只读，匿名可读）：<BV> [--ps 20] [--pn 1] [--sort hot|time] [--json] —— 日报挑片只要"标题+热评"时用它，比 debrief 轻'],
  feed: ['commands/feed.mjs', '选题器（只读）：照主人配置的爱看捞候选（多的时候每晚轮流搜 6 个），排除看过的/已评论过的 [--n 6] [--per 2]'],
  quota: ['commands/quota.mjs', '限额闸（额度的代码强制部分）：status / check --auto|--share / silence / react --auto（查主人有没有表态）/ ask（记账由发言工具自己做）'],
  likes: ['commands/likes.mjs', '谁赞了她（「收到的赞」通知流，含点赞者 mid/昵称）：--hours 24 [--owner] [--json]'],
  selftest: ['commands/selftest.mjs', '启动测试（装完先跑这个）：配置/凭据/登录态/目录/ffmpeg + 下一步怎么起宿主'],
  deps: ['commands/deps.mjs', '依赖体检（装完先跑它）：cookie / ffmpeg / Node / 数据目录；--json 给 agent 判断'],
  memory: ['commands/memory.mjs', '观众记忆（按 UID / 评论线程，存在主人那边）：recall 回复前取 / note 记偏好·推测·待办 / forget 删 / correct 纠正 / done 待办做完 / show 看某人'],
  diary: ['commands/diary.mjs', '她的一天（可见性）：show 人读摘要 / log 记结构化事件 / tail 最近事件'],
  'read-request': ['commands/read-request.mjs', '想读点东西（宿主之后单独开一轮读书回合去读，笔记下次醒来时附给你）：--topic "…（≤40 字）" [--start https://<主人批准的网站>/…] --dry|--go（醒来那一轮，或主人在小窗 / 当面跟你聊的时候；默认要主人批准）'],
  web: ['commands/web.mjs', '文字浏览器（只在读书回合里）：search <词> / open <编号> / more / page'],
  note: ['commands/note.mjs', '读书笔记（只在读书回合里）：write --text "…（20–800 字，用自己的话）" [--title "…"]'],
  letter: ['commands/letter.mjs', '给明天的信（写给明天的自己；宿主收着，醒来时附在提示里）：write --text "…" --dry|--go（只在醒来那一轮，一轮最多一封，≤300 字，写下就改不了）/ show [--n 2]'],
  notify: ['commands/notify.mjs', '通知分发：把"自主发言后必须报备"落到代码里（后端 stdout/file/webhook/command，由 config.notify 决定）'],
  night: ['commands/whale-night.mjs', '生物钟：plan 掷骰子定今晚 / clock 到点退出叫醒她 / mark 兜底标记 / status 看计划'],
  search: ['commands/search.mjs', '按关键词搜视频（WBI 签名）：标题/UP/播放/简介/标签'],
  covers: ['diagnostics/fetch-covers.mjs', '抓视频元信息 + 封面图存到 covers/（供看图理解内容）'],
  whois: ['diagnostics/whois.mjs', '按 mid 查昵称（@ 人前先核准名字）'],
  // —— 写（会真的发出去；都必须显式 --dry 或 --go） ——
  'dm-await': ['commands/dm-await.mjs', '私信监听（宿主专用：取主人的私信送进你的会话；你的会话里不能用）'],
  'sdm-await': ['commands/sdm-await.mjs', '陌生人私信监听（宿主专用：有人先私信你时取那一批、单独叫醒你回 TA；你的会话里不能用）'],
  studio: ['commands/studio.mjs', '工作室（她自己做视频）：rules（细则，先看）/ new / render / submit（交主人审）/ list / show / stats / voices —— 发布只能主人批准'],
  fav: ['commands/fav.mjs', '收藏（我想留着）：判据强制 · --list / --check / <BV> --reason … --dry|--go'],
  dm: ['commands/dm.mjs', '私信（专属通道）：一天只锁定 1 个收信人（对这个人数不限）· 只发主人 · 必须互关'],
  sdm: ['commands/sdm.mjs', '回陌生人私信（只在宿主为 TA 叫醒你的那一回合；收件人由宿主定）：reply --msg "…" --dry|--go / skip --reason / mute --days / flag --kind / status'],
  qq: ['commands/qq.mjs', 'QQ（主人在 QQ 上找你时）：reply --msg "…" --go 回他（只能在 QQ 回合里用）'],
  comment: ['commands/comment.mjs', '发一条视频评论；带 --root/--parent 就是二级回复'],
  'reply-draft': ['commands/reply-draft.mjs', '待审回复（B 档：发前审核）：add 进队列 / list / drop / take'],
  'comment-del': ['commands/comment-del.mjs', '删除自己发的一条评论（x/v2/reply/del，只能删自己的）'],
  dynamic: ['commands/dynamic.mjs', '动态：post / rm / check'],
  'dynamic-image': ['commands/dynamic-image.mjs', '发图文动态（上传图片 + 可带 @节点）'],
  'dynamic-edit': ['commands/edit-dynamic.mjs', '编辑已存在的动态（文字/图片都能改，id 不变、评论与点赞保留）：<dyn_id> <文本文件> [--go]'],
  danmaku: ['commands/danmaku.mjs', '直播间弹幕：pre 预检 / send 发送 / history 回读 / live 实时流'],
  await: ['commands/danmaku-await.mjs', '直播间"叫我起床"：出现该回的弹幕就退出，交给 agent 回（质量优先）'],
  // —— 排查 ——
}

// 陌生人私信回合（宿主设的 BILI_WHALE_TURN = bili-whale-sdm-…，她改不了；2026-10-25 主人定、审查 #5 #13）：只放行这两个 ——
//   sdm（回这一个人、跳过、静音、要报主人的事用写死的句子 flag）· memory（它自己只认绑定里的那个人，认不准就不让用）。
//   别的一律不跑（退出码 2）：dm / comment / dynamic / danmaku / qq / notify / studio / fav 这些会公开发言、或者能把任意的话推给主人
//   （陌生人能借她给主人推一句「B站安全中心：请重新登录 <链接>」）；只读的也不给 —— diary、quota、feed 会说出主人的事。
//   看片的 debrief / watched / video（还有 subtitles / comments / search）v1 也不给：watched show 会打出她对这条视频做过的事
//   （给主人的分享和她写的理由）和电脑上的路径；debrief / video 会照陌生人给的 BV 去联网取素材、把封面字幕写进她平时的看片记录 ——
//   隔离的回合不该改她平时的状态，也不该让陌生人指挥这个号去刷接口。TA 分享视频时她只看得到卡片上的标题和 UP
//   （以后要看，另做一个只读、每回合限次、不写看片记录的 sdm 子命令）
// 读书回合（2026-10-28）只有 web / note write；别的回合没有 web / note，read-request 只在醒来那一轮和主人跟她聊天的回合（小窗、当面聊）—— 规矩在 lib/turn-policy.mjs（钩子、权限规则用同一份）
const TURN = String(process.env.BILI_WHALE_TURN ?? '')
const SDM_TURN = isSdmTurn(TURN)
// 给明天的信（2026-10-26）：主人没打开 letters.enabled 时 help 里不列它 —— 关着时她看到的工具清单和以前一字不差（开关只认 true，读不出来算关）
const lettersOn = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))?.letters?.enabled === true } catch { return false } }

// 脚本文件不在的命令不列、不跑（2026-10-27：QQ、陌生人私信能整块拔掉；公开版里没有它们的文件）。权限规则、Bash 闸门也照这个过滤（host/bash-gate.mjs）
const installed = (name) => Object.hasOwn(map, name) && fs.existsSync(path.join(here, map[name][0]))
const [cmd, ...rest] = process.argv.slice(2)
// 这一回合不能用的命令（含读书回合里的 help）：先挡，不列、不跑（退出码 2）。
//   陌生人回合的 help 照旧能看（列表里只有 sdm、memory；钩子那边本来就不放行它）
const bareHelp = !cmd || cmd === 'help' || cmd === '-h' || cmd === '--help'
const allowed = SDM_TURN && bareHelp ? { ok: true } : commandAllowed(cmd, rest[0], TURN)
if (!allowed.ok) {
  console.error(`✗ ${allowed.why}`)
  process.exit(2)
}
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('用法: node bili.mjs <命令> [参数...]\n')
  console.log('命令:')
  for (const [name, [, desc]] of Object.entries(map)) if (installed(name) && (name !== 'letter' || lettersOn()) && (name !== 'listen' || listenReady()) && (SDM_TURN || listedIn(name, TURN))) console.log(`  ${name.padEnd(16)} ${desc}`)
  console.log('\n安全约定（脚本里也强制）:')
  console.log('  · 写操作必须显式给 --dry（只打印请求）或 --go（真的发）')
  console.log('  · 先跑 session 确认是哪个号；写操作后一定用 check-*/thread/history 回读复核')
  console.log('  · 一次一条。批量、定时、多房间铺量不是这套工具的用途')
  if (SDM_TURN) console.log(`  · 现在是陌生人私信回合：只能用 ${SDM_ONLY.join('、')}`)
  process.exit(cmd ? 0 : 2)
}
// 2026-10-21 修 Issue #5：这 9 个脚本只认位置参数（argv[2]/argv[3]/…），
//   但 help 和 README 教的是 --key 形式 → 参数原样透传进去后，脚本拿到的是字符串 "--bvid"，
//   拼出的 URL 变成 ?bvid=--bvid → B站回 -400，看起来特别像 WBI 失效 / cookie 过期（极易误判 ✗）
//   这里做一层翻译：只在"给出的键正好是期望顺序的前缀"时才转位置参数；给不全就不动，
//   让脚本原来的报错照旧暴露出来（不猜、不静默 ✗）
import { translateNamed } from './lib/cli-args.mjs'

const entry = installed(cmd) ? map[cmd] : null
if (!entry) {
  console.error(`未知命令: ${cmd}\n跑 "node bili.mjs help" 看清单。`)
  process.exit(2)
}
// 凭据里的 cookie 带了换行 / 控制字符（手改、旧版本留下的）：很多工具会原样塞进请求头，Node 报错时把整条 cookie
// （SESSDATA、bili_jct）打印出来 —— 她看得到。这种时候除了不碰凭据的几个命令，一律先不跑，说清楚怎么修（2026-10-24 审查）。
// notify / reply-draft 照常跑：notify 走 B站 私信时自己会先查一遍（见 notify.mjs 的 dm 分支），查出来就改用备用方式
// qq 也照常跑：它只连本机的 NapCat，不碰 B站 凭据 —— 凭据坏了也能回主人的 QQ
// sdm 只有 reply 碰 cookie：凭据坏了也照常能 flag（自伤这种事要报得出去）/ skip / mute / status
// letter（给明天的信）只读写 ~/.bili-ai/letters.jsonl，不碰 cookie
// 读书的三条（web / note / read-request，2026-10-28）也不碰 B站 凭据：凭据坏了照样能读、能记、能交请求
const NO_CRED = new Set(['notify', 'quota', 'memory', 'diary', 'watched', 'reply-draft', 'qq', 'letter', 'web', 'note', 'read-request'])
// studio rules 只打印项目里的细则文件（v0.11.22），不碰凭据：凭据坏了也能看
const NO_CRED_SUB = { sdm: new Set(['flag', 'skip', 'mute', 'status']), studio: new Set(['rules']) }
if (!NO_CRED.has(cmd) && !(Object.hasOwn(NO_CRED_SUB, cmd) && NO_CRED_SUB[cmd].has(rest[0])) && credDirty()) {
  console.error(`✗ 先不跑，免得出错时把整条 cookie 打出来：${DIRTY_CRED_MSG}`)
  process.exit(3)
}
// BILI_WHALE_VIA = 这次跑的子命令；第一个参数像个动作词（小写字母和 -，最多 20 个字）就连它一起带上：'studio submit'、'studio channel'、
// 'reply-draft add'；不像的只有子命令：'comment'（后面是 --oid …）。它再起的进程（comment / dynamic / studio … 发完自己起 notify 报备）都带着它，
// notify 据此分得清「她亲手 notify」和别的工具代发的推送：公开发言的发后报备、交审视频（正好是 'studio submit'）不算 QQ 回合的回复条数，
// 交频道设定（'studio channel'）、待审回复、她亲手的 notify 都算（见 commands/notify.mjs）
const action = /^[a-z][a-z-]{0,19}$/.test(String(rest[0] ?? '')) ? rest[0] : ''
const via = action ? `${cmd} ${action}` : cmd
const r = spawnSync(NODE_EXE, [path.join(here, entry[0]), ...translateNamed(cmd, rest)], { stdio: 'inherit', env: { ...process.env, BILI_WHALE_VIA: via } })
// 子进程没起来 / 被信号结束：退出码 5（不和「正常的 1」混在一起，比如 dm-await 的 1 = 没有新私信）
if (r.error || r.status == null) console.error(`✗ ${cmd} 没跑完：${r.error?.message ?? r.signal ?? '未知原因'}`)
process.exit(r.status ?? 5)
