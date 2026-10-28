#!/usr/bin/env node
/**
 * bili-whale-cc 管理命令 —— 顶替 DSH 的「设置 → 养鱼」页
 *
 *   node host/cli.mjs setup                 准备数据目录、她的家、默认配置；检查 node / claude
 *   node host/cli.mjs cookie --qr [--png]   扫码登录她那个 B站 号（推荐）：给你看是哪个号（昵称 + UID），你确认了才保存
 *   node host/cli.mjs cookie [--no-verify]  手动粘贴她那个号的 SESSDATA / bili_jct / buvid3（B站 的登录；和下面 Claude Code 的 login 是两回事）
 *   node host/cli.mjs login                 登录 Claude Code（她靠它醒来）
 *   node host/cli.mjs doctor                全面体检（运行时 / claude / 登录态 / 依赖 / 宿主）
 *   node host/cli.mjs start | stop | restart | status
 *   node host/cli.mjs autostart [on|off|status]   开机自启（Windows：你的「启动」文件夹；登录后约 30 秒宿主自己起来，已经在跑就不动）
 *   node host/cli.mjs shortcut [on [--name 名字] [--force]|off|status]   桌面上的启动按钮（双击：没在跑就启动，再开「她的小窗」+ 桌宠；哪一步没成才弹框说）
 *   node host/cli.mjs watchdog [on|off [--force]|status]   看门狗（Windows 计划任务）：你登录着的时候每 15 分钟看一眼，宿主没在跑就拉起来；你 stop 过就不拉
 *   node host/cli.mjs wake [--skip] [--queue-only]   现在就叫醒她跑一轮（宿主没开就在前台跑；--queue-only：宿主没开就不跑，小窗的「叫醒她」用）
 *   node host/cli.mjs open                  在终端里接上她的会话，当面聊
 *   node host/cli.mjs say "要说的话" | say --stdin   跟她说一句（排进她的回合、插队；她回的话显示在「她的小窗」里）—— 小窗底下的输入框就是跑这个
 *   node host/cli.mjs config [show|set <键> <值>|edit|path]
 *   node host/cli.mjs persona [show|set <文件>|edit|clear]
 *   node host/cli.mjs pending [list|approve <id>|reject <id> [理由]]     审她想回给别人的评论
 *   node host/cli.mjs replied [list|release <mid>]   「同一个人只回一条」的记录：看 / 解除（确认上次其实没发出去，或者想再回 TA 一次）
 *   node host/cli.mjs videos [list|play <id>|approve <id> [--retry] [--reference-ok]|reject <id> [理由]|resolve <id> none|<BV号>]   审她做的视频（批准 = 投稿）
 *   node host/cli.mjs react [说明]          补记一次你的表态（跨端说的话她看不见；当面聊 / 审片 / 审草稿会自动记）
 *   node host/cli.mjs studio-setup          装工作室依赖（配音 / 字幕 / ffmpeg / 投稿，进项目里的 .studio-venv）
 *   node host/cli.mjs listen-setup [--force] 装「听」：.listen-venv（sherpa-onnx，只用 CPU）+ SenseVoice / VAD 模型；装好后重启一次宿主
 *   node host/cli.mjs image-key             保存 OpenAI key（画图 + 配音共用；不回显、不进配置文件）
 *   node host/cli.mjs letters [list|--all|hide <id> [理由]|unhide <id>]   她给明天的信（醒来那一轮写给自己的便条，下次醒来附上最近两封）：看 / 收起某一封（不再附上，原文还在）/ 放回；开关 config set letters.enabled true|false（默认关）
 *   node host/cli.mjs channel [show|approve <指纹>|reject 意见]   她提的频道设定（你确认前她不能交审视频；指纹是 channel 打印的那一版的）
 *   node host/cli.mjs cast [list|add <id> --name … --image 立绘.png --voice …|sprites <id>|voice <id> --try …/--use …|remove <id>]   她的角色、声音
 *   node host/cli.mjs cast outfit <id> [<换装> | --clear]   看 / 设默认换装（立绘放 sprites/<换装>/<表情>.png；她可以在剧本里按视频换）
 *   node host/cli.mjs cast voice <id> --provider voxcpm --use 参考音.wav [--ref-text "…"]   本地 VoxCPM 配音（--try current 试听）
 *   node host/cli.mjs reference [list | add <讲义.pdf|.txt|.md> [--name 名字] [--force] | remove <名字或 id> | allow <作品 id> [--clear]]   参考材料：她交审时查重会和它比，她看不到原文；allow = 她被拦了、你看过放行这一份剧本
 *   背景音乐：默认按标题自动合成（studio.bgmSynth，studio/bgm_synth.py）；也可以把你确认能用的音乐放进 <数据目录>/bgm/（她写曲名、或者睡前故事才用）
 *   node host/cli.mjs logs [--n 10]
 *   node host/cli.mjs dashboard [--port 8765]   本地面板（只读，只在本机能打开；用它打印的一次性链接登录）：宿主在不在、她在做什么、今天发了什么、等你审的、出错的；--json 打印一次数据
 *   node host/cli.mjs window [--with-pet] [--no-open] [--top] [--pet on|off] [--stop [--force]] [--port 8766]「她的小窗」：她这会儿在干什么、表情、今天做了什么；
 *                                           底下能跟她说话、叫醒她、启动宿主、审视频 / 频道设定（都是替你跑这里的命令）；
 *                                           --no-open 只起后台服务 · --top 置顶一次 · --pet on|off 桌面上的她（桌宠）· --stop 停掉小窗服务（正在投稿时要加 --force）
 *   node host/cli.mjs notify-test
 *   node host/cli.mjs prompt                打印一段唤醒提示（交互式 /whale-wake 用）
 */
import './env.mjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import readline from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import {
  ROOT, DSH_HOME, HOST_DIR, AGENT_CONFIG_DIR, CFG_FILE, PERSONA_FILE, HOME,
  readConfig, writeConfig, setConfigPath, credState, writeCookie, getPersona, setPersona,
  runtimeStatus, runBili, listPending, approveDraft, rejectDraft, status as dayStatus,
  listVideos, approveVideo, rejectVideo, resolveVideo, listReplied, releaseReplied, ownerFeedback, videoFile, setImageKey, readMeta, VENV_DIR, IMAGE_KEY_FILE,
} from './core.mjs'
import { ClaudeSessionController, findClaude, permissionArgs, agentEnv, SYSTEM_LINES, killTree, RUNNING_FILE, liveTurn, isOurTurn, sessionProcs, claudeSpawnArgs } from './claude.mjs'
import { cmdLine } from '../tools/lib/filelock.mjs'
import { MODULE_NAMES, moduleInstalled, loadModule, optionalHook } from './modules.mjs'
import { qrLogin, qrMatrix, qrText, QR_PNG_FILE, probeLogin, describeLogin } from './bililogin.mjs'
import { lineReader } from './lineread.mjs'
import { ensureWorkDir, workDir, migrateLayout, reportMigration } from './workdir.mjs'
import { readDaemonState, daemonAlive, pidAlive, hostProcess, STATE } from './state.mjs'
import { wakePrompt, lettersNow, letterSkipBlock, letterSkipHint, webNotesNow, notesSkipBlock, notesDelivered } from '../lib/scheduler.js'
import { videosPerWake } from '../tools/lib/night-config.mjs'
import { REFERENCE_DIR, WORD_RUN, WORD_BLOCK, NUM_MIN, listReferences, saveReference, removeReference, referenceStats, referenceOverlap, allowReference, referenceAllowed } from '../tools/lib/reference.mjs'
import { projectDir } from '../tools/lib/studio.mjs'
import { LISTEN_VENV, LISTEN_MODELS, listenPython, listenReady, modelsValid, listenFfmpeg, MODEL_FILES, READY_FILE } from '../tools/lib/listen.mjs'
import { describeHit } from '../tools/lib/originality.mjs'
import { CAST_DIR, BGM_DIR, listCast, renderConfig, imageKey, channelStatus, approveChannel, rejectChannel, submittedChannel, voxcpmProblem, checkedVoxcpm, castVoiceLabel, outfitLabel, SPRITE_NAME_RE, TALK_DIR, writeJson } from '../tools/lib/studio.mjs'
import { uploadMeta, TAG_SHOW } from './review.mjs'
import { MAX_QUEUED, isWinId, newWinId, normalizeSay, winTurnText, appendChat, readAllStdin } from './winchat.mjs'
import { OPEN_TURN_PREFIX } from '../tools/lib/turn-ids.mjs'

const [cmd = 'help', ...rest] = process.argv.slice(2)
const ok = (s) => console.log('  ✓ ' + s)
const bad = (s) => console.log('  ✗ ' + s)
const warn = (s) => console.log('  ⚠️ ' + s)

// ─── 开机自启 / 桌面按钮（Windows）：都是你自己账号下的文件，不用管理员、不动注册表 ───
// 两个脚本都直接跑 node（不经过 cmd：路径里的 ! ^ & 这些不会被 cmd 再解释一遍），start 自己把说的话写进文件（--log 追加 / --out 新写）
const AUTOSTART_LOG = path.join(HOST_DIR, 'autostart.log')
const BUTTON_VBS = path.join(HOST_DIR, 'start-button.vbs'), BUTTON_ICO = path.join(HOST_DIR, 'start-button.ico'), BUTTON_STATE = path.join(HOST_DIR, 'start-button.json')
const CLI = path.join(ROOT, 'host', 'cli.mjs')
// APPDATA 设成空的也算没设（?? 只管 undefined）
const autostartFile = () => path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bili-whale-cc.vbs')
/** VBS 的字符串：里面的 " 写成 "" */
const vbsStr = (s) => '"' + String(s).replace(/"/g, '""') + '"'
/** 路径里有 %：Windows 跑脚本、打开快捷方式时会把 %名字% 当成环境变量展开，脚本就找错地方 —— 不装，说清楚 */
const percentPath = (...paths) => paths.find((p) => String(p).includes('%')) ?? null
/** Windows 的脚本程序按 UTF-16（带 BOM）才读得对中文 */
const writeUtf16 = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])) }
const readUtf16 = (file) => { try { const b = fs.readFileSync(file); return b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8') } catch { return null } }
function autostartScript(node) {
  return [
    "' bili-whale-cc 开机自启：node host/cli.mjs autostart on 写的，autostart off 删掉",
    "' 登录后等 30 秒（让网络连好），隐藏窗口跑 node host/cli.mjs start（已经在跑就不动）；它说的话追加进 autostart.log",
    "' node 或项目换过地方就什么都不做（node host/cli.mjs autostart status 会说脚本旧了）",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'WScript.Sleep 30000',
    `If fso.FileExists(${vbsStr(node)}) And fso.FileExists(${vbsStr(CLI)}) Then sh.Run ${vbsStr(`"${node}" "${CLI}" start --autostart --log "${AUTOSTART_LOG}"`)}, 0, False`,
    '',
  ].join('\r\n')
}
function buttonScript(node, title) {
  return [
    "' 桌面上的启动按钮：node host/cli.mjs shortcut on 写的，shortcut off 删掉",
    "' 双击：隐藏窗口跑 node host/cli.mjs start（没在跑就启动、已经在跑就不动），再开「她的小窗」+ 桌宠（window --with-pet）；",
    "' 都好就不弹框（小窗出来了就是结果），哪一步没成才弹个小框说清楚，8 秒后自己关",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `If Not (fso.FileExists(${vbsStr(node)}) And fso.FileExists(${vbsStr(CLI)})) Then`,
    `  sh.Popup ${vbsStr('启动按钮找不到 node 或项目了（换过地方？）—— 在项目里重新跑 node host/cli.mjs shortcut on')}, 15, ${vbsStr(title)}, 48`,
    '  WScript.Quit 1',
    'End If',
    "' 读一个结果文件（UTF-8）、读完删掉，去掉前后的空白和换行（VBS 的 Trim 不管换行）",
    'Function ReadOut(f)',
    '  Dim st, t',
    '  t = ""',
    '  On Error Resume Next',
    '  Set st = CreateObject("ADODB.Stream")',
    '  st.Type = 2',
    '  st.Charset = "utf-8"',
    '  st.Open',
    '  st.LoadFromFile f',
    '  t = st.ReadText',
    '  st.Close',
    '  fso.DeleteFile f, True',
    '  On Error GoTo 0',
    '  Do While Len(t) > 0 And InStr(" " & vbCr & vbLf & vbTab, Left(t, 1)) > 0',
    '    t = Mid(t, 2)',
    '  Loop',
    '  Do While Len(t) > 0 And InStr(" " & vbCr & vbLf & vbTab, Right(t, 1)) > 0',
    '    t = Left(t, Len(t) - 1)',
    '  Loop',
    '  ReadOut = t',
    'End Function',
    "' 每次双击一个新的结果文件：连点两下也不会抢同一个文件",
    'Randomize',
    `base = ${vbsStr(path.join(HOST_DIR, 'start-button-'))} & CStr(Int(Rnd * 1000000000))`,
    'out = base & ".txt"',
    `code = sh.Run(${vbsStr(`"${node}" "${CLI}" start --out "`)} & out & """", 0, True)`,
    'txt = ReadOut(out)',
    'If txt = "" Then txt = "没有拿到结果，看看 node host/cli.mjs status"',
    "' 宿主好了：开小窗 + 桌宠（已经开着就切到前面）；都好就不弹框",
    'If code = 0 Then',
    '  out2 = base & "-window.txt"',
    `  code = sh.Run(${vbsStr(`"${node}" "${CLI}" window --with-pet --out "`)} & out2 & """", 0, True)`,
    '  txt2 = ReadOut(out2)',
    '  If code = 0 Then WScript.Quit 0',
    '  If txt2 = "" Then txt2 = "小窗没开出来，看看 node host/cli.mjs window"',
    '  txt = txt & vbLf & txt2',
    'End If',
    'If code = 0 Then icon = 64 Else icon = 48',
    `sh.Popup txt, 8, ${vbsStr(title)}, icon`,
    '',
  ].join('\r\n')
}
/** 立绘裁成头像图标：透明边以内、上方居中的正方形（全身立绘的脸在上面） */
const ICON_PY = [
  'import sys',
  'from PIL import Image',
  'im = Image.open(sys.argv[1]).convert("RGBA")',
  'x0, y0, x1, y1 = im.split()[3].getbbox() or (0, 0) + im.size',
  'side = int(min(x1 - x0, y1 - y0) * 0.75)',
  'left = (x0 + x1) // 2 - side // 2',
  'im.crop((left, y0, left + side, y0 + side)).save(sys.argv[2], sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])',
].join('\n')
/** 跑一段 PowerShell（-EncodedCommand：中文、引号都不用再转义） */
function psRun(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() || String(r.error?.message ?? '') }
}
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
/** 开机自启：off（没开）/ on / stale（脚本和现在该写的不一样：老版本写的、node / 项目换过地方） */
function autostartState(rt = runtimeStatus()) {
  const cur = readUtf16(autostartFile())
  if (cur == null) return 'off'
  return rt.ok && cur === autostartScript(rt.file) ? 'on' : 'stale'
}
const buttonState = () => { try { const j = JSON.parse(fs.readFileSync(BUTTON_STATE, 'utf8')); return j && typeof j === 'object' && typeof j.lnk === 'string' ? j : null } catch { return null } }
/** 桌面按钮：off（没装过）/ on / stale（快捷方式不见了、脚本旧了、node / 项目换过地方） */
function shortcutState(rt = runtimeStatus(), state = buttonState()) {
  if (!state) return fs.existsSync(BUTTON_VBS) ? 'stale' : 'off'
  return fs.existsSync(state.lnk) && rt.ok && readUtf16(BUTTON_VBS) === buttonScript(rt.file, String(state.title ?? '')) ? 'on' : 'stale'
}
/** 任务管理器「启动应用」里把它禁用了没有（HKCU\…\StartupApproved\StartupFolder 里这一项第一个字节是奇数 = 禁用；没有这一项 = 没动过）；查不了返回 null */
function autostartDisabled() {
  if (process.platform !== 'win32') return null
  const key = ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Explorer', 'StartupApproved', 'StartupFolder'].join(path.win32.sep)
  const r = spawnSync('reg.exe', ['query', key, '/v', 'bili-whale-cc.vbs'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (r.error) return null
  if (r.status !== 0) return false
  const m = String(r.stdout).match(/REG_BINARY\s+([0-9A-Fa-f]{2})/)
  return m ? (parseInt(m[1], 16) & 1) === 1 : null
}
// ─── 看门狗（Windows 计划任务，你登录着的时候每 15 分钟）：宿主没在跑就拉起来；你 stop 过就不拉 ───
// 「你 stop 过」= stopped-by-owner.json 这个记号：stop 写，任何正常的 start（手动、双击桌面按钮、restart、登录时的开机自启）都会删掉
const WATCHDOG_TASK = 'bili-whale-cc-watchdog'
const WATCHDOG_VBS = path.join(HOST_DIR, 'watchdog.vbs')
const WATCHDOG_STATE = path.join(HOST_DIR, 'watchdog.json')         // { fails }：连着几次没拉起来
const WATCHDOG_MAX_FAILS = 4                                         // 连着这么多次（一小时）没拉起来就先不试了，等你手动 start
const STOPPED_MARK = path.join(HOST_DIR, 'stopped-by-owner.json')
// //B：批处理模式 —— 脚本出错、找不到脚本文件都不弹框（计划任务每 15 分钟跑一次，弹框会一直弹）
const WATCHDOG_ARGS = `//B //NoLogo "${WATCHDOG_VBS}"`
const localTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso ?? '') : d.toLocaleString('zh-CN', { hour12: false }) }
const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
function watchdogScript(node) {
  return [
    "' bili-whale-cc 看门狗：node host/cli.mjs watchdog on 写的，watchdog off 删掉（连同计划任务 " + WATCHDOG_TASK + "）",
    "' 计划任务每 15 分钟用它跑一次：隐藏窗口跑 node host/cli.mjs start --watchdog（宿主在跑、或者你 stop 过，就什么都不做）",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `If fso.FileExists(${vbsStr(node)}) And fso.FileExists(${vbsStr(CLI)}) Then CreateObject("WScript.Shell").Run ${vbsStr(`"${node}" "${CLI}" start --watchdog --log "${AUTOSTART_LOG}"`)}, 0, False`,
    '',
  ].join('\r\n')
}
/** 注册计划任务：每 15 分钟、只在你登录时跑（不用密码、不用管理员）、用电池也跑、同一时间只跑一个、最多跑 5 分钟、正常优先级 */
const watchdogRegisterPs = () => [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'try {',
  `  $a = New-ScheduledTaskAction -Execute (Join-Path (Join-Path $env:WINDIR 'System32') 'wscript.exe') -Argument ${psq(WATCHDOG_ARGS)}`,
  '  $t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)',
  '  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Priority 5',   // -Priority 5 = 正常（默认 7 = 低于正常：拉起来的宿主会一直低一档）
  "  $p = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited",
  `  Register-ScheduledTask -TaskName ${psq(WATCHDOG_TASK)} -TaskPath '\\' -Action $a -Trigger $t -Settings $s -Principal $p -Description ${psq('bili-whale-cc：宿主没在跑就拉起来（你 stop 过就不拉）。删掉：node host/cli.mjs watchdog off')} -Force | Out-Null`,
  "  [Console]::Out.WriteLine('OK')",
  "} catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message); exit 1 }",
].join('\n')
/**
 * 计划任务：register / remove / status（status → { state: 'Ready' | 'Disabled' | 'Running' | … | null（没有）, args: 它跑的参数 }）。
 * 任务名是固定的（一台电脑一个用户只有一个）：status 会核对它跑的是不是这个安装的脚本，off 不删指向别处的。
 * 测试里（BILI_WHALE_FAKE_TASKS=<文件>）不碰真的任务计划程序：要做的事记进那个文件
 */
function watchdogTask(op) {
  const fake = process.env.BILI_WHALE_FAKE_TASKS
  if (fake) {
    if (op === 'register') fs.writeFileSync(fake, JSON.stringify({ state: 'Ready', args: WATCHDOG_ARGS, script: watchdogRegisterPs() }))
    else if (op === 'remove') fs.writeFileSync(fake, '{}')
    const j = readJsonSafe(fake)
    return { ok: true, state: j?.state ?? null, args: j?.args ?? null }
  }
  const name = psq(WATCHDOG_TASK)
  const script = op === 'register' ? watchdogRegisterPs()
    : op === 'remove' ? `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Unregister-ScheduledTask -TaskName ${name} -Confirm:$false -ErrorAction SilentlyContinue; if (Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue) { [Console]::Out.WriteLine('ERR 计划任务删不掉'); exit 1 } else { [Console]::Out.WriteLine('OK') }`
    : `$t = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; if ($t) { [Console]::Out.WriteLine('STATE ' + $t.State); [Console]::Out.WriteLine('ARGS ' + $t.Actions[0].Arguments) } else { [Console]::Out.WriteLine('STATE none') }`
  const r = psRun(script)
  const lines = r.out.split(/\r?\n/).map((x) => x.trim())
  if (op === 'status') { const m = lines.find((x) => x.startsWith('STATE ')), a = lines.find((x) => x.startsWith('ARGS ')); return m ? { ok: true, state: m.slice(6) === 'none' ? null : m.slice(6), args: a ? a.slice(5) : null } : { ok: false, err: r.err } }
  const err = lines.find((x) => x.startsWith('ERR '))
  return r.ok && lines.includes('OK') ? { ok: true } : { ok: false, err: (err?.slice(4) || r.err || '没有输出').slice(0, 200) }
}
/** 看门狗现在什么样（watchdog status、doctor 用）：每一行是 [ok | warn | info, 文字] */
function watchdogReport(rt = runtimeStatus()) {
  const out = []
  const task = watchdogTask('status')
  const script = readUtf16(WATCHDOG_VBS)
  if (!task.ok) out.push(['warn', '看门狗：查不了计划任务（' + String(task.err ?? '').slice(0, 120) + '）'])
  else if (!task.state) out.push([script == null ? 'info' : 'warn', script == null ? '看门狗：没开（node host/cli.mjs watchdog on）' : '看门狗：脚本在、计划任务不见了 —— 重新 node host/cli.mjs watchdog on'])
  else if (task.args !== WATCHDOG_ARGS) out.push(['warn', `看门狗：计划任务 ${WATCHDOG_TASK} 跑的不是这个安装的脚本（${String(task.args ?? '?').slice(0, 160)}；别的安装、或者老版本建的）—— 重新 node host/cli.mjs watchdog on`])
  else if (task.state === 'Disabled') out.push(['warn', '看门狗：计划任务在「任务计划程序」里被禁用了 —— 在那里启用，或者重新 watchdog on'])
  else if (script == null) out.push(['warn', '看门狗：计划任务在、脚本不见了 —— 重新 node host/cli.mjs watchdog on'])
  else if (!rt.ok || script !== watchdogScript(rt.file)) out.push(['warn', '看门狗：开着，但脚本是旧的、或者 node / 项目换过地方 —— 重新 node host/cli.mjs watchdog on'])
  else out.push(['ok', `看门狗：开着（每 15 分钟看一眼；计划任务 ${WATCHDOG_TASK}）`])
  const mark = readJsonSafe(STOPPED_MARK)
  if (fs.existsSync(STOPPED_MARK)) out.push(['info', `宿主是你 stop 的${mark?.at ? `（${localTime(mark.at)}）` : ''}：看门狗不会拉；你 start、双击桌面按钮、restart，或者重启电脑登录后（开机自启），就恢复`])
  const fails = Number(readJsonSafe(WATCHDOG_STATE)?.fails) || 0
  if (fails >= WATCHDOG_MAX_FAILS) out.push(['warn', `看门狗连着 ${fails} 次没把宿主拉起来，先不试了 —— 看 ${path.join(HOST_DIR, 'daemon.out')}，修好以后手动 node host/cli.mjs start`])
  return out
}
// 她写的文字显示给你之前，把控制字符转义成可见的 \uXXXX：终端转义序列能把一段字藏起来、或者改写前面已经显示的行
const CTRL_ALL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g
const CTRL_KEEP_NL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g
const shown = (s, { keepNewlines = false } = {}) => String(s ?? '').replace(keepNewlines ? CTRL_KEEP_NL : CTRL_ALL, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const DAEMON = path.join(ROOT, 'host', 'daemon.mjs')

/** 问一句、输入不显示（存 token 用）：终端里逐字读、不回显；管道 / 测试里照常读一行（也不回显）。没回答（输入流结束、Ctrl+D）= null */
async function askHidden(question) {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    process.stdout.write(question + '\n')
    const rl = readline.createInterface({ input: stdin })
    const line = await new Promise((resolve) => { rl.once('line', resolve); rl.once('close', () => resolve(null)) })
    rl.close()
    return line
  }
  return new Promise((resolve) => {
    process.stdout.write(question)
    let buf = ''
    const done = (v) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(v) }
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return done(buf)
        if (ch === '\u0004') return done(null)   // Ctrl+D：没回答
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130) }   // Ctrl+C
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else if (ch >= ' ') buf += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

/** 和 lib/scheduler.js 里的 personaLine 同一套：设置里的三个字段 + ~/.bili-ai/persona.md */
function personaLine(cfg = readConfig()) {
  const p = cfg.persona ?? {}
  const bits = []
  if (p.name) bits.push(`你是「${p.name}」`)
  if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
  if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
  const txt = getPersona().trim()
  const extra = txt ? `\n\n［她的人设］以下是她专属的设定，写日记 / 说话 / 选题都以它为准；与上面［身份］里的名字/称呼/自称冲突时，以这一份为准 ✓：\n${txt.slice(0, 3000)}` : ''
  return (bits.length ? `［身份］${bits.join('，')}。（以此为准，别用别的称呼 ✓）` : '') + extra
}

/**
 * 试听（cast voice --try，VoxCPM 和 Edge / OpenAI 两条路）没做成的原因：和 studio render 一样，stderr 是空串时 `??` 接不上，
 * 超时 / 一声不吭退出就只剩一句空的（2026-10-25 审查）
 */
function tryFailReason(r, out, limit, timeoutNote = '') {
  return out?.error
    || (r.error?.code === 'ETIMEDOUT' ? `超过 ${limit}还没做完，被停掉了${timeoutNote}` : '')
    || (r.signal ? `试听进程被结束了（${r.signal}）` : '')
    || r.error?.message
    || String(r.stderr ?? '').trim().slice(-600)
    || `试听脚本退出码 ${r.status ?? '?'}，没有说原因`
}

// nb：读书笔记那一块（开着才有）；只拼字 —— 真的交给宿主以后 wake 再记「附过了」（cli prompt 预览不记）
function manualWakeText(skip = false, nb = webNotesNow()) {
  const cfg = readConfig()
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (skip) {
    const lb = lettersNow()   // 给明天的信：开着才有（关着时这段话一字不变）
    return [personaLine(cfg), `【今晚不看】主人手动让你今天休息（${now}）。`, ...letterSkipBlock(lb), ...notesSkipBlock(nb), '照常写两本日记，说明本次跳过；记录 diary log night-skip。', ...letterSkipHint(lb)].join('\n')
  }
  return wakePrompt({ atText: `${now}（主人手动叫醒）` }, personaLine(cfg), videosPerWake(cfg.night?.maxVideos), Number(cfg.claude?.timeoutMin) || 25, lettersNow(), nb)
}

/** `claude auth status` → { loggedIn, authMethod }（拿不到就 null） */
// 她用的是自己那份 Claude Code 配置目录（AGENT_CONFIG_DIR）：登录也登在那里，和你自己的 Claude Code 分开
const agentClaudeEnv = () => ({ ...process.env, CLAUDE_CONFIG_DIR: AGENT_CONFIG_DIR })

function claudeAuth(claude) {
  const sp = claudeSpawnArgs(claude, ['auth', 'status'])
  const r = spawnSync(sp.cmd, sp.args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, shell: sp.shell, env: agentClaudeEnv() })
  try { return JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{'))) } catch { return null }
}

function reportAuth(claude) {
  const a = claudeAuth(claude)
  if (a?.loggedIn) ok(`她的 Claude Code 已登录（${a.authMethod}；配置目录 ${AGENT_CONFIG_DIR}）`)
  else bad(`她的 Claude Code 还没登录 —— 她醒不过来。跑：node host/cli.mjs login（登在她专用的配置目录里，和你自己的 Claude Code 分开）`)
  if (process.env.ANTHROPIC_API_KEY) warn('环境变量里有 ANTHROPIC_API_KEY：她的会话会优先用它（按 API 计费），而不是登录的订阅')
}

/** 用系统默认程序打开一个文件（看图），打不开就算了 */
function openFile(f) {
  try {
    const [c, a] = process.platform === 'win32' ? ['explorer.exe', [f]] : process.platform === 'darwin' ? ['open', [f]] : ['xdg-open', [f]]
    spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
  } catch {}
}

/** 扫码登录她那个 B站 号（host/bililogin.mjs）：二维码过期 / 取消 / 出错 / 你没确认，原来的凭据都不动 */
async function qrCookie() {
  const png = rest.includes('--png')
  console.log('扫码登录她那个 B站 号（这是 B站 的登录；Claude Code 的登录是 node host/cli.mjs login，两回事）')
  console.log('  ⚠️ 用【她那个号】的 B站 App 扫，不是你自己的号。你最后确认之前，原来的凭据不会动。\n')
  const cleanup = () => { if (png) try { fs.rmSync(QR_PNG_FILE, { force: true }) } catch {} }
  const cancel = () => { cleanup(); console.log('\n已取消 —— 原来的凭据没动'); process.exit(130) }
  // Ctrl+C、关掉终端窗口（Windows 上是 SIGHUP / SIGBREAK）、被结束：都先把二维码图片删了
  const SIGS = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]
  for (const sig of SIGS) process.once(sig, cancel)
  const lines = lineReader(cancel)
  try {
    const r = await qrLogin({
      show: (url) => {
        cleanup()
        if (png) try { fs.mkdirSync(path.dirname(QR_PNG_FILE), { recursive: true }) } catch {}   // 第一次装好时 ~/.bili-ai 还没有
        const m = qrMatrix(url, { png: png ? QR_PNG_FILE : null })
        if (!m) { bad('画不出二维码：没找到装了 qrcode 的 Python。先装工作室依赖（node host/cli.mjs studio-setup），或者手动填：node host/cli.mjs cookie'); return false }
        console.log('\n' + qrText(m) + '\n')
        if (png && fs.existsSync(QR_PNG_FILE)) {
          console.log(`  终端里扫不出来的话，用图片版：${QR_PNG_FILE}（结束后自动删掉）`)
          if (process.env.BILI_WHALE_NO_OPEN !== '1') openFile(QR_PNG_FILE)
        } else if (png) warn('图片版没生成（Python 的 Pillow 有问题？）—— 先扫上面终端里的')
        return true
      },
      say: (t) => console.log(t),
      ask: lines.ask,
    })
    if (!r.saved) { bad(r.reason); process.exitCode = 1; return }
    ok(`已保存：她的 B站 号 = ${shown(r.self.name)}（UID ${r.self.mid}）${r.switched ? ' —— 已换号' : ''}`)
    if (!r.buvid3) warn('没拿到 buvid3（设备号）—— 大部分功能不受影响')
    if (r.warn) warn(r.warn)
    console.log(`  ${r.refreshToken ? 'refresh_token 也存下了，但' : ''}自动续期还没做：登录过期、或在别处被退出之后，宿主每小时的检查会发现，面板和通知会提醒你再扫一次。`)
    console.log('  宿主在跑的话不用重启：她下一次调用工具就用新的登录。')
  } finally { lines.close(); cleanup(); for (const sig of SIGS) process.removeListener(sig, cancel) }
}

function openInEditor(file) {
  const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
  spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' })
}

const commands = {
  async help() {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8')
    const off = MODULE_NAMES.filter((m) => !moduleInstalled(m))   // 没装的模块：它的命令说明不列
    console.log(src.slice(src.indexOf('/**') + 4, src.indexOf('*/')).replace(/^ \* ?/gm, '')
      .split('\n').filter((l) => !off.some((m) => l.trimStart().startsWith(`node host/cli.mjs ${m} `))).join('\n'))
  },

  async setup() {
    console.log('bili-whale-cc 安装检查\n')
    const rt = runtimeStatus()
    rt.ok ? ok(`node：${rt.file}`) : bad(rt.reason)
    const claude = findClaude(readConfig().claude?.path)
    claude ? ok(`claude：${claude}`) : bad('找不到 claude —— 装 Claude Code（https://claude.com/claude-code），或 config set claude.path <路径>')
    if (claude) reportAuth(claude)
    if (!fs.existsSync(CFG_FILE)) { writeConfig(readConfig()); ok(`已生成默认配置 ${CFG_FILE}`) } else ok(`配置：${CFG_FILE}`)
    const dir = ensureWorkDir()
    ok(`她的家：${dir}（CLAUDE.md 守则 + bili.mjs 入口）`)
    ok(`日记：${path.join(workDir(), 'whale-diary.md')} / whale-diary-private.md`)
    const c = credState()
    c.present && c.hasSess && c.hasJct ? ok('B站 凭据已填') : warn('还没登录她那个 B站 号：node host/cli.mjs cookie --qr（扫码），或 cookie（手动粘贴）')
    const cfg = readConfig()
    if (!cfg.owner?.mid) warn('还没填主人（你）的 mid 和昵称：node host/cli.mjs config set owner.mid 你的mid，再 config set owner.name 你的昵称')
    console.log('\n下一步：cookie → doctor → start（或 wake 先试一轮）')
  },

  async cookie() {
    if (rest.includes('--qr')) return qrCookie()
    const flags = Object.fromEntries(rest.map((a, i) => a.startsWith('--') ? [a.slice(2), rest[i + 1]] : null).filter(Boolean))
    let input = { sessdata: flags.sessdata, bili_jct: flags.bili_jct, buvid3: flags.buvid3 }
    const lines = lineReader(() => process.exit(130))   // 整个流程用同一个：管道一次喂进来的几行不会丢
    try {
    if (!input.sessdata || !input.bili_jct) {
      console.log('用【她那个号】登录 bilibili.com → F12 → Application（应用）→ Cookies → https://www.bilibili.com')
      console.log('逐个双击 Value 复制（要 .bilibili.com 那几行；不勾「显示已解码的 URL」）。⚠️ SESSDATA 是 HttpOnly，document.cookie 读不到，只能这样手抄。')
      console.log('⚠️ 填完之后别在浏览器里「退出登录」她的号 —— 退出会让这里存的 cookie 一起失效。建议用无痕窗口登录、复制完直接关窗口。')
      console.log('（更省事：node host/cli.mjs cookie --qr 用她那个号的 B站 App 扫码）\n')
      input = {
        sessdata: (await lines.ask('SESSDATA: ', { fresh: false })) ?? '',
        bili_jct: (await lines.ask('bili_jct: ', { fresh: false })) ?? '',
        buvid3: (await lines.ask('buvid3（可留空）: ', { fresh: false })) ?? '',
      }
    }
    // 和扫码一样：先给你看这组 cookie 是哪个号（昵称 + UID），你点头才写；换了号要把新 UID 打一遍
    const confirm = async ({ who, prev, switched, ownerUnknown }) => {
      console.log(`这组 cookie 登录的是：${shown(who.name)}（UID ${who.mid}）`)
      if (ownerUnknown) warn('还没填主人（你）的 UID，没法替你核对这是不是你自己的号 —— 确认是她的号再保存（填：node host/cli.mjs config set owner.mid 你的UID）')
      {
        if (switched) {
          console.log(`⚠️ 换号了：之前她用的是 ${shown(prev.name) || '?'}（UID ${prev.mid}），这组是 ${shown(who.name)}（UID ${who.mid}）。`)
          console.log('   换了之后她就用这个号看视频、回评论、私信你、投稿；以前的日记、观众记忆、额度账本都留着，记的是旧号时候的事。')
          return ((await lines.ask(`确认换成这个号，就把新 UID 打一遍（${who.mid}）；别的输入都算不换：`)) ?? '').trim() === who.mid
        }
        return /^\s*y(es)?\s*$/i.test((await lines.ask('保存成她的 B站 登录？[y/N] ')) ?? '')
      }
    }
    const r = await writeCookie(input, { verify: !rest.includes('--no-verify'), confirm })
    if (!r.ok) { console.log(shown(r.error, { keepNewlines: true })); process.exitCode = 1; return }
    console.log(shown(r.detail))
    if (r.warn) warn(r.warn)
    } finally { lines.close() }
  },

  async doctor() {
    console.log('bili-whale-cc 体检\n')
    const rt = runtimeStatus()
    rt.ok ? ok(`node 运行时：${rt.file}`) : bad(rt.reason)
    const cfg = readConfig()
    const claude = findClaude(cfg.claude?.path)
    if (claude) {
      const sp = claudeSpawnArgs(claude, ['--version'])
      const v = spawnSync(sp.cmd, sp.args, { encoding: 'utf8', windowsHide: true, shell: sp.shell })
      ok(`claude：${String(v.stdout || '').trim() || '?'}（${claude}）`)
      reportAuth(claude)
    } else bad('找不到 claude（装 Claude Code，或 config set claude.path <路径>）')
    const st = readDaemonState()
    if (!daemonAlive(st)) { const stuck = hostProcess(st); warn(stuck ? `宿主进程在（pid ${st.pid}），但心跳停了 ${stuck.staleMin} 分钟 —— 卡住了？node host/cli.mjs restart` : '宿主没在跑 —— 到点不会醒：node host/cli.mjs start') }
    else if (st.scheduler?.ok) ok(`宿主在跑（pid ${st.pid}）· 生物钟：${st.scheduler.reason}`)
    else bad(`宿主在跑（pid ${st.pid}），但生物钟没起来 —— 到点不会醒，私信 / 评论也没人听：${shown(st.scheduler?.reason ?? '?')}（修好后 node host/cli.mjs restart）`)
    if (process.platform === 'win32') {
      const as = autostartState(rt)
      if (as === 'on') ok('开机自启：开着（登录 Windows 后约 30 秒宿主自己起来）')
      else warn(as === 'off' ? '开机自启没开 —— 电脑重启后宿主不会自己起来：node host/cli.mjs autostart on' : '开机自启的脚本是旧的（node / 项目换过地方？）—— 重新 node host/cli.mjs autostart on')
      if (as !== 'off' && autostartDisabled() === true) warn('开机自启在任务管理器的「启动应用」里被禁用了 —— 在那里重新启用，登录时才会跑')
      const bs = shortcutState(rt)
      if (bs === 'on') ok('桌面按钮：装着')
      else if (bs === 'stale') warn('桌面按钮旧了（快捷方式不见了、或者 node / 项目换过地方）—— 重新 node host/cli.mjs shortcut on')
      for (const [k, s] of watchdogReport(rt)) (k === 'ok' ? ok : k === 'warn' ? warn : (x) => console.log('  · ' + x))(s)
    }
    cfg.owner?.mid ? ok(`主人：${cfg.owner.name || '?'}（mid ${cfg.owner.mid}）`) : warn('没填主人 mid / 昵称（分享 @ 谁？）')
    cfg.self?.mid ? ok(`她的号：${shown(cfg.self.name)}（mid ${cfg.self.mid}）`) : warn('还不知道她是哪个号（登录完会自动写）')
    // B站 登录还有效吗（只读的 nav；结果也写进面板看的 login-state.json）
    console.log(describeLogin(await probeLogin()).line)
    fs.existsSync(path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
      ? ok(`工作室依赖已装（${VENV_DIR}）· 配图：${cfg.studio?.image?.provider === 'none' ? '渐变卡片' : cfg.studio?.image?.model + (fs.existsSync(IMAGE_KEY_FILE) ? '' : '（⚠️ 没存 key：image-key）')}`)
      : warn('工作室依赖没装 —— 她做不了视频：node host/cli.mjs studio-setup')
    // 「听」是可选的：没装只提一句
    listenReady() ? ok(`「听」已装（${LISTEN_VENV}）`) : console.log('  · 「听」没装（可选：她听不了视频的声音 —— node host/cli.mjs listen-setup）')
    const castNow = listCast()
    castNow.length
      ? ok(`角色：${castNow.map((c) => `${c.name ?? c.id}（表情 ${c.sprites.length} 张${outfitLabel(c) ? `；换装 ${outfitLabel(c)}` : ''}）`).join('、')}`)
      : warn('还没有角色：node host/cli.mjs cast add <id> --name … --image 你的角色图.png')
    for (const c of castNow.filter((x) => x.outfitProblem)) {
      const fix = c.outfits?.length ? `node host/cli.mjs cast outfit ${c.id} <换装>` : `node host/cli.mjs cast outfit ${c.id} --clear`
      ;(c.outfitBroken ? bad : warn)(`${c.name ?? c.id}：${c.outfitProblem}${c.outfitBroken ? ' —— 用到她的视频会渲染失败：' + fix : ''}`)
    }
    // Windows 上文件名不分大小写：Neutral.png 也算
    for (const c of castNow) for (const o of c.outfits ?? []) if (!o.exprs.some((e) => e.toLowerCase() === 'neutral')) warn(`${c.name ?? c.id} 的换装「${o.name}」没有 neutral.png（不说话时、没写表情时会随便用一张）`)
    for (const c of castNow.filter((x) => x.flatIgnored?.length)) warn(`${c.name ?? c.id}：sprites/ 下平铺的 ${c.flatIgnored.join('、')} 用不上了（有换装文件夹时只用换装里的立绘）`)
    for (const c of castNow.filter((x) => x.tts === 'voxcpm')) {
      const why = voxcpmProblem(cfg.studio?.voxcpm ?? {}) ?? (fs.existsSync(path.join(CAST_DIR, c.id, String(c.voxcpm?.ref ?? ''))) && c.voxcpm?.ref ? null : `参考音不在：cast voice ${c.id} --provider voxcpm --use <参考音.wav>`)
      why ? bad(`${c.name ?? c.id} 用 VoxCPM 本地配音，但用不了 —— 她渲染会失败：${why}`) : ok(`${c.name ?? c.id}：VoxCPM 本地配音（${cfg.studio.voxcpm.model}）`)
    }
    let bgmN = 0
    try { bgmN = fs.readdirSync(BGM_DIR).filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f)).length } catch {}   // 和 studio.py 的 pick_bgm 认同样的格式
    const synth = cfg.studio?.bgmSynth !== false
    console.log(`  · 背景音乐：${synth ? '自动合成（代码现算，没有版权问题）' : '不自动合成'}${bgmN ? ` · 你放的音乐 ${bgmN} 首（她写曲名 / 写 true、或者睡前故事才用）` : `（也可以把你确认能用的音乐放进 ${BGM_DIR}）`}`)
    console.log(`  · 推送：${cfg.notify?.type ?? 'none'}${cfg.notify?.fallback ? `（失败时改用 ${cfg.notify.fallback}）` : cfg.notify?.type === 'command' ? '（失败时改用 desktop —— 自定义命令没配备用方式时默认这样）' : ''}${cfg.notify?.type === 'none' ? '（她报备的东西你收不到 —— 建议配一个，见 README）' : ''}`)
    // 可拔掉的模块自己的体检行：按 MODULE_NAMES 的顺序（和以前同一个顺序）；没装的什么都不说
    for (const name of MODULE_NAMES) {
      const m = await loadModule(name)
      if (m.mod) await m.mod.cli?.doctor?.(cfg, ui())
      else if (m.error) warn(`${name} 模块加载出错（${m.error}）`)
    }
    console.log('\n—— 工具链体检（bili.mjs deps）——')
    const d = await runBili(['deps'], { timeout: 90_000 })
    console.log(shown((d.out || d.err).trim(), { keepNewlines: true }))   // 里面有 B站 上的昵称（别人能改的字）
  },

  async login() {
    const claude = findClaude(readConfig().claude?.path)
    if (!claude) { console.log('找不到 claude'); process.exitCode = 1; return }
    console.log('给她登录 Claude Code（她用的就是这个账号的额度）…')
    console.log(`  登录信息存在她专用的配置目录：${AGENT_CONFIG_DIR}（和你自己的 Claude Code 分开 —— 你自己的权限、插件、MCP 都不会带进她的会话）\n`)
    const sp = claudeSpawnArgs(claude, ['auth', 'login'])
    spawnSync(sp.cmd, sp.args, { stdio: 'inherit', shell: sp.shell, env: agentClaudeEnv() })
    reportAuth(claude)
  },

  async start() {
    // 开机自启 / 桌面按钮 / 看门狗是隐藏窗口跑的：--log <文件> 把说的话追加进去，--out <文件> 写进一个新文件（出错的话也写进去）
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] ?? null : null }
    const sink = opt('--log') ?? opt('--out')
    if (opt('--out')) try { fs.writeFileSync(sink, '') } catch {}
    const say = (s) => { console.log(s); if (sink) try { fs.appendFileSync(sink, s + '\n') } catch {} }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // 宿主在跑 = host/state.mjs 的 hostProcess：daemon.json 里那个进程还在、而且真的是宿主（认命令行：进程号会被别的程序复用，
    // 比如电脑刚重启过）；不看心跳新不新（笔记本睡醒那一下心跳是睡之前写的，宿主其实还在）；命令行查不了就退回去看心跳
    const hostUp = () => hostProcess()
    // 等的时候先看便宜的（心跳新、进程在），再认身份（要起一次 PowerShell，约 0.8 秒）
    const quickUp = () => (daemonAlive(readDaemonState()) ? hostProcess() : null)
    const upMsg = (h) => (h.hung ? `宿主进程在（pid ${h.st.pid}），但心跳停了 ${h.staleMin} 分钟 —— 可能卡住了：node host/cli.mjs restart（电脑刚睡醒的话，等半分钟再看）` : `宿主已经在跑了（pid ${h.st.pid}）`)
    const watchdog = rest.includes('--watchdog')
    let acted = false   // 看门狗这一次真的去拉了（宿主在跑、你 stop 过、先不试了的时候都不算，也什么都不记）
    try {
      if (watchdog) {
        if (fs.existsSync(STOPPED_MARK)) return
        if (hostUp()) return
        if ((Number(readJsonSafe(WATCHDOG_STATE)?.fails) || 0) >= WATCHDOG_MAX_FAILS) return
        acted = true
        say(`[${new Date().toISOString()}] 看门狗：宿主没在跑，拉起来`)
      } else {
        // 正常的 start（手动、双击桌面按钮、restart、登录时的开机自启）：你想让它跑 —— 「你 stop 过」的记号作废，看门狗恢复
        for (const f of [STOPPED_MARK, WATCHDOG_STATE]) fs.rmSync(f, { force: true })
        if (rest.includes('--autostart')) say(`[${new Date().toISOString()}] 开机自启`)
      }
      let up = hostUp()
      if (up) { say(upMsg(up)); return }
      const rt = runtimeStatus()
      if (!rt.ok) { say(rt.reason); process.exitCode = 1; return }
      ensureWorkDir()
      fs.mkdirSync(HOST_DIR, { recursive: true })
      // 启动锁（开机自启、桌面按钮、看门狗、手动 start 可能同时来）：只让一个去起宿主，别的等它 —— 两个宿主刚起来时谁都还没写心跳，
      // 宿主自己的「已经在跑了」挡不住。锁里写着正在起宿主的进程号：先是这个 start 自己，起了宿主以后换成宿主的；
      // 那个进程还在、锁不到 60 秒 = 有人正在起（宿主报到后会自己放掉锁）；进程不在了、或者锁太旧（电脑重启后进程号被别的程序用了）= 作废
      const lock = path.join(HOST_DIR, 'start.lock')
      const lockPid = () => { try { return Number(fs.readFileSync(lock, 'utf8').trim()) || 0 } catch { return 0 } }
      let mine = false
      for (let tries = 0; tries < 3 && !mine; tries += 1) {
        try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); mine = true; break } catch (e) { if (e?.code !== 'EEXIST') throw e }
        const holder = lockPid()
        let age = Infinity
        try { age = Date.now() - fs.statSync(lock).mtimeMs } catch {}
        if (!holder || !pidAlive(holder) || age > 60_000) {
          await sleep(100)
          if (lockPid() === holder) fs.rmSync(lock, { force: true })   // 删之前再看一眼：还是那把作废的锁（没被别人换成新的）
          continue
        }
        for (let k = 0; k < 80 && fs.existsSync(lock); k += 1) {   // 有人正在起：等它（最多 20 秒）
          await sleep(250)
          if ((up = quickUp())) { say(upMsg(up)); return }
        }
        if ((up = hostUp())) { say(upMsg(up)); return }
        if (fs.existsSync(lock) && pidAlive(lockPid())) { say('另一个启动正在进行，等了 20 秒宿主还没起来 —— 等一会儿再看 node host/cli.mjs status'); process.exitCode = 1; return }
      }
      if (!mine) { say(`启动锁拿不到（${lock}）—— 看 node host/cli.mjs status`); process.exitCode = 1; return }
      let child = null
      try {
        if ((up = hostUp())) { say(upMsg(up)); return }
        if (watchdog && fs.existsSync(STOPPED_MARK)) { say('你刚刚 stop 了：看门狗不拉'); return }   // 动手前再看一眼（你可能正好在这时 stop）
        const out = fs.openSync(path.join(HOST_DIR, 'daemon.out'), 'a')
        child = spawn(rt.file, [DAEMON], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...rt.env, DSH_HOME } })
        child.unref()
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_NORMAL) } catch {}   // 看门狗是低一档跑的：宿主别跟着低一档
        try { fs.writeFileSync(lock, String(child.pid)) } catch {}   // 锁交给宿主：它报到之前，别的 start 都等它
        for (let i = 0; i < 60; i += 1) {   // 最多等 15 秒（电脑刚开机时宿主起得慢）
          await sleep(250)
          if ((up = quickUp())) { say(`✓ 宿主已在后台启动（pid ${up.st.pid}）。日志：${path.join(HOST_DIR, 'daemon.log')}`); return }
          if (!pidAlive(child.pid)) break
        }
        if (pidAlive(child.pid)) { say(`宿主进程起了（pid ${child.pid}），15 秒还没报到 —— 多半是电脑刚开机、起得慢；一会儿 node host/cli.mjs status 看看`); return }
        say(`宿主没起来，看 ${path.join(HOST_DIR, 'daemon.out')}`)
        process.exitCode = 1
      } finally {
        // 宿主报到了、或者没起成（进程没了）：放掉锁；宿主还在起：锁留着（里面是宿主的进程号），别的 start 会等它
        const held = lockPid()
        const st = readDaemonState()
        const stillStarting = Boolean(child && pidAlive(child.pid) && !(daemonAlive(st) && Number(st.pid) === child.pid))
        if ((held === process.pid || held === child?.pid) && !stillStarting) fs.rmSync(lock, { force: true })
      }
    } catch (e) { say('启动时出错：' + String(e?.message ?? e)); process.exitCode = 1 }
    finally {
      // 看门狗：拉起来了 → 失败次数清零；没拉起来 → 记一次，连着 WATCHDOG_MAX_FAILS 次就先不试了
      if (watchdog && acted) {
        if (!process.exitCode) fs.rmSync(WATCHDOG_STATE, { force: true })
        else {
          const fails = (Number(readJsonSafe(WATCHDOG_STATE)?.fails) || 0) + 1
          try { fs.writeFileSync(WATCHDOG_STATE, JSON.stringify({ fails, at: new Date().toISOString() })) } catch {}
          if (fails >= WATCHDOG_MAX_FAILS) say(`看门狗：连着 ${fails} 次没拉起来，先不试了 —— 看 ${path.join(HOST_DIR, 'daemon.out')}，修好以后手动 node host/cli.mjs start`)
        }
      }
    }
  },

  async stop(opts = {}) {
    // 记下「是你停的」：看门狗看到就不拉（任何正常的 start 都会删掉这个记号）。restart 也写：它停和起之间看门狗正好来，也不会抢着拉
    try { fs.mkdirSync(HOST_DIR, { recursive: true }); fs.writeFileSync(STOPPED_MARK, JSON.stringify({ at: new Date().toISOString() })) } catch {}
    if (!opts?.forRestart && fs.existsSync(WATCHDOG_VBS)) console.log('（记下了是你停的：看门狗不会把它拉起来；你 start、双击桌面按钮，或者重启电脑登录后，才会再起来）')
    // 有一个启动正在进行（启动锁里的进程还在、锁不到 60 秒）：等它完了再停 —— 不然这边说「没在跑」，那边宿主又起来了
    const lock = path.join(HOST_DIR, 'start.lock')
    const lockHolder = () => { try { const p = Number(fs.readFileSync(lock, 'utf8').trim()) || 0; return p && p !== process.pid && pidAlive(p) && Date.now() - fs.statSync(lock).mtimeMs <= 60_000 ? p : 0 } catch { return 0 } }
    for (let i = 0; i < 80 && lockHolder(); i += 1) {
      if (i === 0) console.log('（有一个启动正在进行：等它完了再停）')
      await new Promise((r) => setTimeout(r, 250))
    }
    { const p = lockHolder(); if (p && /host[\\/]daemon\.mjs/.test(cmdLine(p))) { killTree(p); console.log(`（还在起的宿主 pid ${p} 也停了）`) } }
    const st = readDaemonState()
    // 连她正在跑的回合一起结束（整棵进程树）：Windows 上只结束宿主，她的 claude 进程会留下继续跑，重启后同一个回合又被跑一遍。
    // 结束之前先确认身份：进程号会被系统复用（比如重启过），只结束命令行对得上的 —— 宿主是 host/daemon.mjs，回合带着它的会话 id
    const turn = (() => { try { return JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8')) } catch { return null } })()
    const turnOurs = Boolean(turn && isOurTurn(turn))
    // 记下的进程不在了、同一会话的 claude 还在（经 claude.cmd 启动、宿主崩过）：那些进程也要结束
    //   只认还在时限里的那条记录（liveTurn 自己会看时限）—— 很久以前留下的记录不算，免得误伤别的进程
    const turnExtra = turn && !turnOurs ? (liveTurn()?.pids ?? []) : []
    const turnLive = turnOurs || turnExtra.length > 0
    const killTurn = () => { if (turnOurs) killTree(turn.pid); for (const p of turnExtra) killTree(p) }
    // 记下「是主人停的」：下一个宿主看到它就不重跑（私信回合半路断了才会重跑一次，主人自己停的不算）
    // 先再读一次：确认还是刚才查过的那一条（查身份要一两秒，期间它可能跑完、下一回合已经写进来了）
    if (turnLive) {
      try {
        const now = JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8'))
        if (now?.pid === turn.pid && now?.at === turn.at) fs.writeFileSync(RUNNING_FILE, JSON.stringify({ ...turn, stoppedByOwner: true }))
      } catch {}
    }
    // 模块的回合（stopNote）：比如主人在别处发的消息她已经回了几条
    const modNote = async () => (await moduleTurns()).find((t) => t.re.test(String(turn.id ?? '')) && typeof t.stopNote === 'function')?.stopNote(turn.id) ?? ''
    const dmNote = !turnLive ? '' : String(turn.id ?? '').startsWith('bili-whale-dm-') ? '（这一回合是处理你的私信，没处理完；要紧的话再发一次）' : await modNote()
    const daemonLive = Boolean(hostProcess(st))   // 认身份（查不了就看心跳）：进程号会被系统复用，只结束对得上的
    if (!daemonLive) {
      if (st?.pid) fs.writeFileSync(STATE, JSON.stringify({ ...st, pid: null, stoppedAt: new Date().toISOString() }, null, 2))
      if (turnLive) { killTurn(); console.log(`宿主没在跑；它留下的回合 ${turn.id ?? ''}（pid ${[...(turnOurs ? [turn.pid] : []), ...turnExtra].join(',')}）已结束，不会重跑${dmNote}`) }
      else console.log('宿主没在跑')
      return
    }
    killTree(st.pid)
    if (turnLive) killTurn()
    if (pidAlive(st.pid)) { try { process.kill(Number(st.pid)) } catch (e) { console.log('停不掉：' + e.message); process.exitCode = 1; return } }
    fs.writeFileSync(STATE, JSON.stringify({ ...st, pid: null, stoppedAt: new Date().toISOString() }, null, 2))
    // running.json 留着：下一个宿主看到它的进程已经不在，会把那一条从队列里拿掉（不重跑）
    console.log(`✓ 已停止（pid ${st.pid}${turnLive ? `；她正在跑的回合 ${turn.id ?? ''} 也结束了，不会重跑${dmNote}` : ''}）`)
  },

  async restart() { await commands.stop({ forRestart: true }); await new Promise((r) => setTimeout(r, 800)); await commands.start() },

  async status() {
    const st = readDaemonState()
    const stuck = daemonAlive(st) ? null : hostProcess(st)   // 心跳停了：进程还在的话，是卡住了（start 不管用，要 restart）
    console.log(daemonAlive(st)
      ? `宿主：在跑（pid ${st.pid}）· 生物钟 ${st.scheduler?.ok ? '✓' : '✗ ' + st.scheduler?.reason} · ${st.running ? '她正在干活：' + st.running : '空闲'} · 排队 ${st.queued}`
      : stuck ? `宿主：进程在（pid ${st.pid}），但心跳停了 ${stuck.staleMin} 分钟 —— 卡住了？node host/cli.mjs restart（电脑刚睡醒的话，等半分钟再看）`
        : '宿主：没在跑（node host/cli.mjs start）')
    if (!daemonAlive(st) && !stuck && fs.existsSync(STOPPED_MARK)) console.log(`  是你 stop 的（${localTime(readJsonSafe(STOPPED_MARK)?.at)}）${fs.existsSync(WATCHDOG_VBS) ? '：看门狗不会拉' : ''}（start 或双击桌面按钮就起来）`)
    const s = dayStatus()
    console.log(`今天（${s.today}）：分享 ${s.sharesOn === false ? '已关' : `${s.shares}/${s.sharesMax ?? '不限'}`} · 对外发言 ${s.commentsToday} · 待审草稿 ${s.pending} · 待审视频 ${s.pendingVideos}`)
    if (s.plan) console.log(`计划：${s.plan.date} ${s.plan.action}${s.plan.atText ? ' @ ' + s.plan.atText : ''} · 今天醒了 ${s.plan.wakes} 次`)
    if (s.session) console.log(`会话：${s.session.id} · 从 ${String(s.session.startedAt).slice(0, 10)} 起 · ${s.session.turns ?? 0} 个回合`)
  },

  /** 开机自启（Windows：你自己的「启动」文件夹里放一个脚本）：autostart [on | off | status]。
   *  登录后等 30 秒，隐藏窗口跑 node host/cli.mjs start —— 和手动启动同一条路：已经在跑就不动、宿主的输出进 daemon.out；
   *  start 自己说的话（带时间）追加进 autostart.log */
  async autostart() {
    const sub = rest[0] ?? 'on'
    const rt = runtimeStatus()
    if (process.platform !== 'win32') {
      console.log(sub !== 'off' ? `把这一行加进 crontab -e：\n@reboot cd '${ROOT}' && '${rt.file ?? 'node'}' host/daemon.mjs >> '${path.join(HOST_DIR, 'daemon.out')}' 2>&1`
        : '用 crontab -e 删掉带 host/daemon.mjs 的那一行')
      return
    }
    const file = autostartFile()
    if (sub === 'off') { const had = fs.existsSync(file); fs.rmSync(file, { force: true }); ok(had ? '已取消开机自启' : '开机自启本来就没开'); return }
    if (sub === 'status') {
      const st = autostartState(rt)
      if (st !== 'off' && !rt.ok) console.log(`开机自启：开着，但现在找不到 node（${rt.reason}）`)
      else console.log({ off: '开机自启：没开（node host/cli.mjs autostart on）', on: `开机自启：开着（${file}）`, stale: '开机自启：开着，但脚本是旧的、或者 node / 项目换过地方 —— 重新 node host/cli.mjs autostart on' }[st])
      if (st !== 'off') {
        if (autostartDisabled() === true) console.log('  ⚠️ 在任务管理器的「启动应用」里被禁用了 —— 在那里重新启用，登录时才会跑')
        console.log(`  每次自启的结果：${AUTOSTART_LOG}`)
      }
      return
    }
    if (sub !== 'on') { console.log('用法：autostart [on | off | status]'); process.exitCode = 2; return }
    if (!rt.ok) { bad(rt.reason); process.exitCode = 1; return }
    const pct = percentPath(rt.file, CLI, AUTOSTART_LOG, file)
    if (pct) { bad(`路径里有 %（${pct}）：Windows 会把 %名字% 当成环境变量展开，脚本会找错地方 —— 装不了，换个没有 % 的路径`); process.exitCode = 2; return }
    fs.mkdirSync(HOST_DIR, { recursive: true })
    writeUtf16(file, autostartScript(rt.file))
    ok(`已加入开机自启：${file}`)
    console.log(`  你登录 Windows 后约 30 秒宿主自己起来（已经在跑就不动）；每次的结果记在 ${AUTOSTART_LOG}。取消：node host/cli.mjs autostart off`)
  },

  /** 桌面上的启动按钮（Windows）：shortcut [on [--name 名字] | off | status]。
   *  双击 = 隐藏窗口跑 node host/cli.mjs start（没在跑就启动、已经在跑就不动），弹个小框说结果（8 秒后自己关）。
   *  图标用她的立绘（默认换装的「浅笑」，没有就 neutral）裁出来的头像；工作室依赖没装就用系统默认图标 */
  async shortcut() {
    const sub = rest[0] ?? 'on'
    if (process.platform !== 'win32') { console.log('桌面按钮只做了 Windows 的'); process.exitCode = 2; return }
    const state = buttonState()
    const leftovers = () => { try { for (const x of fs.readdirSync(HOST_DIR)) if (/^start-button(-\d+)?(-window)?\.txt$/.test(x)) fs.rmSync(path.join(HOST_DIR, x), { force: true }) } catch {} }
    if (sub === 'off') {
      const hadScript = fs.existsSync(BUTTON_VBS)
      if (state?.lnk) fs.rmSync(state.lnk, { force: true })
      for (const x of [BUTTON_VBS, BUTTON_ICO, BUTTON_STATE]) fs.rmSync(x, { force: true })
      leftovers()
      if (state?.lnk) ok(`已删掉桌面上的「${shown(path.basename(state.lnk, '.lnk'))}」`)
      else if (hadScript) warn('按钮的记录不见了 / 坏了，不知道桌面上那个快捷方式叫什么：脚本已经删了，桌面上那个图标请你手动删掉')
      else ok('桌面按钮没装过')
      return
    }
    if (sub === 'status') {
      const st = shortcutState(runtimeStatus(), state)
      console.log({ off: '桌面按钮：没装（node host/cli.mjs shortcut on）', on: `桌面按钮：装着（${state?.lnk}）`, stale: '桌面按钮：装着，但快捷方式不见了、脚本是旧的、或者 node / 项目换过地方 —— 重新 node host/cli.mjs shortcut on' }[st])
      return
    }
    if (sub !== 'on') { console.log('用法：shortcut [on [--name 名字] [--force] | off | status]'); process.exitCode = 2; return }
    const rt = runtimeStatus()
    if (!rt.ok) { bad(rt.reason); process.exitCode = 1; return }
    const cast = listCast()[0]
    const at = rest.indexOf('--name'), force = rest.includes('--force')
    const title = String(at >= 0 ? rest[at + 1] ?? '' : cast?.name ?? 'bili-whale').trim()
    if (!title || title.startsWith('--') || /[\\/:*?"<>|%\p{C}]/u.test(title) || [...title].length > 30) {
      bad('名字不能空着、最多 30 个字、不能有 \\ / : * ? " < > | %' + (at < 0 ? `（默认用的是角色名「${shown(title)}」；用 --name 另起一个）` : ''))
      process.exitCode = 2; return
    }
    const pct = percentPath(rt.file, CLI, BUTTON_VBS)
    if (pct) { bad(`路径里有 %（${pct}）：Windows 会把 %名字% 当成环境变量展开，按钮会找错地方 —— 装不了，换个没有 % 的路径`); process.exitCode = 2; return }
    writeUtf16(BUTTON_VBS, buttonScript(rt.file, title))
    // 图标：她的立绘裁出头像（工作室的 Python + Pillow；没装就用默认图标）
    let icon = null
    const spriteDir = cast ? path.join(CAST_DIR, cast.id, 'sprites', ...(cast.defaultOutfit ? [cast.defaultOutfit] : [])) : null
    const sprite = spriteDir && ['浅笑', 'neutral'].map((e) => path.join(spriteDir, e + '.png')).find((x) => fs.existsSync(x))
    const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (sprite && fs.existsSync(py)) {
      const r = spawnSync(py, ['-I', '-c', ICON_PY, sprite, BUTTON_ICO], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      if (r.status === 0 && fs.existsSync(BUTTON_ICO)) icon = BUTTON_ICO
      else warn('头像图标没做出来（先用默认图标）：' + shown(String(r.stderr || r.error?.message || '').trim().split('\n').pop()))
    }
    // 出错一律停下、说出原因（不然 Save 失败了也照样打印路径、退出码 0）；最后确认快捷方式真的在
    const r = psRun([
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'try {',
      "  $desk = if ($env:BILI_WHALE_DESKTOP) { $env:BILI_WHALE_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }",
      "  if (-not $desk -or -not (Test-Path -LiteralPath $desk -PathType Container)) { throw ('桌面文件夹不在：' + $desk) }",
      `  $lnk = Join-Path $desk ${psq(title + '.lnk')}`,
      // 桌面上已经有同名的快捷方式、又不是这个按钮上次建的：不悄悄盖掉（之后 shortcut off 还会把它删了）
      `  if ((Test-Path -LiteralPath $lnk) -and ($lnk -ne ${psq(state?.lnk ?? '')}) -and -not $${force ? 'true' : 'false'}) { throw ('桌面上已经有一个「' + (Split-Path -Leaf $lnk) + '」了（不是这个按钮建的）—— 换个名字（--name），或者加 --force 覆盖') }`,
      '  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)',
      "  $s.TargetPath = Join-Path (Join-Path $env:WINDIR 'System32') 'wscript.exe'",
      `  $s.Arguments = ${psq('"' + BUTTON_VBS + '"')}`,
      `  $s.WorkingDirectory = ${psq(ROOT)}`,
      ...(icon ? [`  $s.IconLocation = ${psq(icon + ',0')}`] : []),
      `  $s.Description = ${psq(`启动${title}（宿主没在跑就启动，已经在跑就不动）`)}`,
      '  $s.Save()',
      "  if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { throw ('快捷方式没写出来：' + $lnk) }",
      "  [Console]::Out.WriteLine('OK ' + $lnk)",
      "} catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message); exit 1 }",
    ].join('\n'))
    const said = r.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const okLine = said.find((x) => x.startsWith('OK ')), errLine = said.find((x) => x.startsWith('ERR '))
    if (!r.ok || !okLine) { bad('桌面快捷方式没建成：' + shown((errLine?.slice(4) || r.err || '没有输出').slice(0, 200))); process.exitCode = 1; return }
    const lnk = okLine.slice(3)
    // 换了名字：旧的那个快捷方式删掉（不然桌面上留两个）
    if (state?.lnk && path.resolve(state.lnk).toLowerCase() !== path.resolve(lnk).toLowerCase()) fs.rmSync(state.lnk, { force: true })
    fs.writeFileSync(BUTTON_STATE, JSON.stringify({ lnk, title, at: new Date().toISOString() }, null, 2))
    leftovers()
    ok(`桌面上放好了「${shown(title)}」：${lnk}`)
    console.log('  双击：宿主没在跑就启动、已经在跑就不动，再打开「她的小窗」和桌宠（开着就切到前面）；哪一步没成才弹个小框说清楚（8 秒后自己关）。删掉：node host/cli.mjs shortcut off')
  },

  /** 看门狗（Windows 计划任务）：watchdog [on | off | status]。你登录着的时候每 15 分钟看一眼：宿主没在跑就拉起来（记进 autostart.log）。
   *  你 stop 过就不拉（stopped-by-owner.json；手动 start / 双击桌面按钮 / restart / 登录时的开机自启都会删掉这个记号）；
   *  连着 4 次没拉起来就先不试了，等你手动 start */
  async watchdog() {
    const sub = rest[0] ?? 'on'
    if (process.platform !== 'win32') { console.log('看门狗只做了 Windows 的（别的系统可以用 cron / systemd 每 15 分钟跑一次 node host/cli.mjs start --watchdog）'); process.exitCode = 2; return }
    const rt = runtimeStatus()
    if (sub === 'status') { for (const [k, s] of watchdogReport(rt)) (k === 'ok' ? ok : k === 'warn' ? warn : console.log)(s); return }
    if (sub === 'off') {
      const cur = watchdogTask('status')
      if (cur.ok && cur.state && cur.args !== WATCHDOG_ARGS && !rest.includes('--force')) {
        bad(`计划任务 ${WATCHDOG_TASK} 跑的不是这个安装的脚本（${shown(String(cur.args ?? '?').slice(0, 160))}）—— 没删。确定要删：watchdog off --force`)
        process.exitCode = 2; return
      }
      const r = watchdogTask('remove')
      if (!r.ok) { bad('计划任务没删掉：' + shown(r.err)); process.exitCode = 1; return }
      for (const x of [WATCHDOG_VBS, WATCHDOG_STATE]) fs.rmSync(x, { force: true })
      ok('看门狗关了（计划任务删掉了）')
      return
    }
    if (sub !== 'on') { console.log('用法：watchdog [on | off [--force] | status]'); process.exitCode = 2; return }
    if (!rt.ok) { bad(rt.reason); process.exitCode = 1; return }
    const pct = percentPath(rt.file, CLI, AUTOSTART_LOG, WATCHDOG_VBS)
    if (pct) { bad(`路径里有 %（${pct}）：Windows 会把 %名字% 当成环境变量展开，脚本会找错地方 —— 装不了，换个没有 % 的路径`); process.exitCode = 2; return }
    fs.mkdirSync(HOST_DIR, { recursive: true })
    writeUtf16(WATCHDOG_VBS, watchdogScript(rt.file))
    const r = watchdogTask('register')
    if (!r.ok) { bad('计划任务没建成：' + shown(r.err)); process.exitCode = 1; return }
    fs.rmSync(WATCHDOG_STATE, { force: true })
    ok(`看门狗开了：你登录着的时候每 15 分钟看一眼，宿主没在跑就拉起来（记在 ${AUTOSTART_LOG}）`)
    console.log('  你 stop 过就不拉；你 start、双击桌面按钮、restart，或者重启电脑登录后（开机自启），就恢复。关掉：node host/cli.mjs watchdog off')
  },

  async wake() {
    const nb = webNotesNow()
    const text = manualWakeText(rest.includes('--skip'), nb)
    const cwd = ensureWorkDir()
    if (daemonAlive()) {
      const c = new ClaudeSessionController({ cwd })
      c.stopped = true   // 只入队，由宿主去跑
      await c.prompt({ requestId: 'manual-' + Date.now(), content: [{ type: 'text', text }] })
      notesDelivered(nb)
      console.log('✓ 已交给宿主，她马上醒（node host/cli.mjs logs 看结果）')
      return
    }
    // 小窗的「叫醒她」：宿主没开就不在前台跑（那样会在小窗服务底下跑好几分钟、谁也看不到）—— 让主人先启动宿主
    if (rest.includes('--queue-only')) { console.log('宿主没在跑：先启动宿主（小窗里的「启动宿主」，或者 node host/cli.mjs start），再叫醒她'); process.exitCode = 3; return }
    console.log('宿主没在跑 —— 在前台跑这一轮（几分钟）…')
    const c = new ClaudeSessionController({ cwd, log: (m) => console.log(m) })
    await c.prompt({ requestId: 'manual-' + Date.now(), content: [{ type: 'text', text }] })
    notesDelivered(nb)
    let told = false, held = null
    while (c.isBusy() && !c.paused) {
      // 队列里只剩模块那种「跑之前要读得出配置」的回合（configHeld）、配置又读不出来：宿主修好以后会接着处理，这里不等
      if (!c.running && c.queue.length) {
        held ??= (await moduleTurns()).filter((t) => typeof t.configHeld === 'string')
        const t = held.find((k) => c.queue.every((x) => k.re.test(String(x?.id ?? ''))))
        if (t) {
          const { readConfigStrict } = await import('./core.mjs')
          if (!readConfigStrict().ok) { console.log(t.configHeld); break }
        }
      }
      c.kick()   // 和宿主每 5 秒踢一次一样：上一个回合跑完了，这一个才能开始（以前只等不踢，会一直卡住）
      const t = !c.running && liveTurn()
      if (t && !told) { console.log(`等上一个回合（${t.id ?? ''}，pid ${t.pid}）跑完…`); told = true }
      await new Promise((r) => setTimeout(r, 1000))
    }
    await commands.logs(['--n', '1'])
  },

  async open() {
    const cfg = readConfig()
    const claude = findClaude(cfg.claude?.path)
    if (!claude) { console.log('找不到 claude'); process.exitCode = 1; return }
    const st = readDaemonState()
    const pauseFile = path.join(HOST_DIR, 'paused.json')
    // 先挂上「暂停」，再看有没有她的回合在跑：宿主开新回合前会看暂停标记，所以挂上之后再查到的就是全部
    //（以前只看宿主心跳里的 running：刚开的回合、宿主停了留下的回合、前台 wake 的回合都看不到，两边会同时用同一个会话）
    fs.mkdirSync(HOST_DIR, { recursive: true })
    fs.writeFileSync(pauseFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    await new Promise((r) => setTimeout(r, 1500))
    const busy = liveTurn()?.id ?? (daemonAlive(st) && readDaemonState()?.running) ?? null
    if (busy) {
      fs.rmSync(pauseFile, { force: true })
      console.log(`她正在跑一个回合（${busy}），等她干完再接（node host/cli.mjs status）`)
      return
    }
    const cwd = ensureWorkDir()
    await ownerFeedback('主人来当面聊天')   // 主人来找她 = 表态（沉默衰减清零）—— 这一条只能由主人这边记
    const c = new ClaudeSessionController({ cwd })
    const sess = c.session(cfg)
    const rt = runtimeStatus()
    if (!rt.ok) { console.log(rt.reason); process.exitCode = 1; fs.rmSync(pauseFile, { force: true }); return }
    const env = agentEnv(rt)
    // 当面聊不是宿主排的回合：你终端环境里万一有 BILI_WHALE_TURN（比如从她的回合里继承来的），别带进她的会话 ——
    // 不然她在这里也能当成「醒来那一轮」写给明天的信、当成哪种特别的回合跑那几个命令。
    // 换成当面聊自己的编号（2026-10-28 主人定）：只用来认出「主人在跟她聊」—— 能交读书请求；信照样写不了（不是醒来那一轮）
    env.BILI_WHALE_TURN = OPEN_TURN_PREFIX + Date.now()
    // 人设和醒来 / 私信回合一样带上（以前当面聊没有人设，她只能按守则里「没人设就中性地说话」来）。
    // claude 是 .cmd 的话参数要经过 cmd.exe：双引号里的 %名字% 也会被换成环境变量（用户名、目录…），人设里的 % 先换成全角的
    const sysText = [SYSTEM_LINES[0] + ' 现在是主人本人在终端里和你当面聊。 ' + SYSTEM_LINES[2], personaLine(cfg)].filter(Boolean).join('\n\n')
    const args = [...permissionArgs({ interactive: true }), '--append-system-prompt',
      /\.(cmd|bat)$/i.test(claude) ? sysText.replace(/%/g, '％') : sysText,
      ...(sess.fresh ? ['--session-id', sess.id] : ['--resume', sess.id])]
    console.log(`接上她的会话 ${sess.id}（宿主的回合会排队等你聊完）…\n`)
    const sp = claudeSpawnArgs(claude, args)
    const r = spawnSync(sp.cmd, sp.args, { cwd, env, stdio: 'inherit', shell: sp.shell })
    fs.rmSync(pauseFile, { force: true })
    if (sess.fresh && r.status === 0) fs.writeFileSync(path.join(HOST_DIR, 'session.json'), JSON.stringify({ ...sess, fresh: undefined, used: true }, null, 2))
  },

  /**
   * 跟她说一句（小窗底下的输入框跑的就是这个；终端里也能用）：排进她的回合（插队，排在普通回合前面），
   * 原话另记一份给小窗显示（host/winchat.mjs）。她这一回合最后那段话就是回你的，显示在小窗里 —— 主人选的只回在小窗，不走私信、不走别的聊天软件。
   * 宿主没在跑就不投（不在前台跑：小窗服务底下跑几分钟没人看得到）。退出码：0 投了 · 1 没投成 · 2 用法 · 3 宿主没在跑
   */
  async say() {
    const fromStdin = rest.includes('--stdin')
    const words = rest.filter((a) => a !== '--stdin')
    if (fromStdin && words.length) { console.log('用法：say "要说的话"，或者 say --stdin（从标准输入读）'); process.exitCode = 2; return }
    let raw
    try { raw = fromStdin ? await readAllStdin() : words.join(' ') } catch (e) { console.log('✗ ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 2; return }
    const n = normalizeSay(raw)
    if (n.error) { console.log(raw.trim() ? '✗ ' + n.error : '用法：say "要说的话"，或者 say --stdin（从标准输入读）'); process.exitCode = 2; return }
    if (!daemonAlive()) { console.log('宿主没在跑：她收不到。先启动宿主（小窗里的「启动宿主」，或者 node host/cli.mjs start），再跟她说'); process.exitCode = 3; return }
    const c = new ClaudeSessionController({ cwd: ensureWorkDir() })
    c.stopped = true   // 只入队，由宿主去跑
    // 正在跑的回合：只读 running.json（liveTurn 要起 PowerShell 查进程，慢的时候几十秒 —— 小窗那边等不了那么久）。
    // 只认还在队列里的那个：回合跑完就出队，running.json 万一没删掉也不会多算一个（daemon.json 半分钟才写一次，不用它）
    const rf = (() => { try { return JSON.parse(fs.readFileSync(RUNNING_FILE, 'utf8')) } catch { return null } })()
    const runningOf = (queue) => (typeof rf?.id === 'string' && rf.id && queue.some((x) => x?.id === rf.id) ? rf.id : null)
    const before = c.queue
    const waiting = before.filter((x) => isWinId(x?.id) && x.id !== runningOf(before)).length
    if (waiting >= MAX_QUEUED) { console.log(`✗ 已经有 ${waiting} 句排着她还没回：等她回完再说`); process.exitCode = 1; return }
    const id = newWinId()
    // 先记原话、再投：记不进去就不投（投了小窗里却看不到，主人会以为她没收到、再说一遍）；投不成就补一行 cancel，这句在小窗里整个不算
    try { appendChat({ id, at: new Date().toISOString(), text: n.text }) } catch (e) {
      try { appendChat({ id, cancel: true }) } catch {}   // 万一那一行其实记上了（追加完才出的错）：补 cancel，免得小窗里多一句「没等到」
      console.log('✗ 没交给她：小窗的聊天记录写不进去（' + String(e?.message ?? e).slice(0, 120) + '）'); process.exitCode = 1; return
    }
    try { await c.prompt({ requestId: id, content: [{ type: 'text', text: winTurnText(n.text, personaLine(readConfig())) }], priority: true }) } catch (e) {
      try { appendChat({ id, cancel: true }) } catch {}
      console.log('✗ 没交给她：' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; return
    }
    // 前面还有几个：插队会排到正在跑的那个前面（这边的 c 不知道哪个在跑），所以不算正在跑的那个的位置，有一个在跑就 +1（和小窗的聊天记录一样算）
    const after = c.queue
    const running = runningOf(after)
    const q = after.map((x) => x?.id).filter((x) => typeof x === 'string' && x !== running)
    const ahead = Math.max(0, q.indexOf(id)) + (running ? 1 : 0)
    console.log(`✓ 交给她了${ahead ? `（前面还有 ${ahead} 个回合）` : ''}：她回的话会出现在小窗里（node host/cli.mjs logs 也看得到）`)
    if (c.paused) warn('你正在终端里和她当面聊：这一句等你聊完才轮到')
    await ownerFeedback('主人在小窗里跟她说话')   // 主人来找她 = 表态（沉默衰减清零），和当面聊一样。放在最后：慢了也不耽误上面那句「交给她了」
  },

  async config() {
    const sub = rest[0] ?? 'show'
    if (sub === 'path') { console.log(CFG_FILE); return }
    if (sub === 'edit') { if (!fs.existsSync(CFG_FILE)) writeConfig(readConfig()); openInEditor(CFG_FILE); return }
    if (sub === 'set') {
      const r = setConfigPath(rest[1] ?? '', rest.slice(2).join(' '))
      if (!r.ok) { console.log(r.error); process.exitCode = 1; return }
      console.log(`✓ 已保存${r.schedulingChanged ? '（作息变了，宿主会重排今天的计划）' : ''}`)
      if (r.warn) warn(r.warn)
      return
    }
    console.log(JSON.stringify(readConfig(), null, 2))
  },

  async persona() {
    const sub = rest[0] ?? 'show'
    if (sub === 'show') { console.log(getPersona() || `（还没写人设 —— node host/cli.mjs persona edit；文件在 ${PERSONA_FILE}）`); return }
    if (sub === 'clear') { console.log(setPersona('').detail); return }
    if (sub === 'set') {
      const file = rest[1]
      if (!file || !fs.existsSync(file)) { console.log('给一个文件：persona set <人设.md>'); process.exitCode = 1; return }
      const r = setPersona(fs.readFileSync(file, 'utf8'))
      console.log(r.ok ? r.detail : r.error)
      return
    }
    if (sub === 'edit') {
      if (!fs.existsSync(PERSONA_FILE)) setPersona('# 我是谁\n\n# 说话\n\n# 我在意什么\n\n# 我绝不会\n\n# 日记怎么写 / 分享的标准\n')
      openInEditor(PERSONA_FILE)
      return
    }
    console.log('用法：persona [show|set <文件>|edit|clear]')
  },

  async pending() {
    const sub = rest[0] ?? 'list'
    if (sub === 'approve') {
      const r = await approveDraft(rest[1])
      if (r.ok) console.log(`✓ 已发出 rpid=${r.rpid}`)
      else if (r.uncertain) console.log(`⚠️ 不知道发没发出去：${r.error}`)
      else console.log(`✗ ${r.error ?? r.err ?? r.out}${r.requeued ? '（草稿已放回队列）' : ''}`)
      if (!r.ok) process.exitCode = 1
      return
    }
    if (sub === 'reject') { const r = await rejectDraft(rest[1], rest.slice(2).join(' ')); console.log(r.ok ? '✓ 已否掉（她会记住这种不要）' : '✗ ' + (r.error ?? r.out)); return }
    const items = listPending()
    if (!items.length) { console.log('没有待审的回复'); return }
    for (const it of items) {
      // 先给 B站 上查到的（那条评论真正的作者和原文），她自己写的 who / src 只当参考
      const real = it.real
      console.log(`[${shown(it.id)}] 回 ${real ? `${shown(real.name)}（mid ${shown(real.mid)}）` : `${shown(it.who || '?')}（她写的，没核实到）`}`)
      console.log(`   发到：${({ 1: '视频', 11: '动态', 17: '动态', 12: '专栏' })[it.type ?? '1'] ?? '?'}评论区 type=${shown(it.type ?? '1')} oid=${shown(it.oid)} root=${shown(it.root)} parent=${shown(it.parent)}${it.bvid ? `（视频 ${shown(it.bvid)}）` : ''}`)
      if (real) console.log(`   TA 在 B站 上说：${shown(String(real.text).slice(0, 200))}`)
      else if (it.src) console.log(`   她转述 TA 说：${shown(String(it.src).slice(0, 120))}`)
      console.log(`   她想回：${shown(it.message, { keepNewlines: true })}`)
    }
    console.log('\n批准：pending approve <id>    否掉：pending reject <id> [理由]')
  },

  /** 「同一个人只回一条」的判重记录：看 / 解除 */
  async replied() {
    const sub = rest[0] ?? 'list'
    if (sub === 'release') {
      const r = releaseReplied(rest[1])
      console.log(r.ok ? `✓ 已解除（删掉了 ${r.removed} 条记录）—— 她可以再回 TA 一次` : '✗ ' + r.error)
      if (!r.ok) process.exitCode = 1
      return
    }
    let rows
    try { rows = listReplied() } catch (e) { console.log('✗ 判重账本读不了：' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; return }
    if (!rows.length) { console.log('30 天内没有判重记录'); return }
    for (const { mid, list } of rows) {
      for (const x of list) {
        const st = !x.pending ? `已发出 rpid=${shown(x.rpid ?? '?')}` : x.uncertain ? '⚠️ 结果不确定（可能其实发出去了）' : '正在发，或者上次没等到结果'
        console.log(`mid ${shown(mid)} ${shown(x.name ?? '')} · ${shown(x.at)} · ${shown(x.target ?? '')} · ${st}`)
      }
    }
    console.log('\n解除：replied release <mid>（确认上次其实没发出去、或者就是想再回这个人一次）')
  },

  async videos() {
    const sub = rest[0] ?? 'list'
    const id = rest[1]
    if (sub === 'approve') {
      const args = rest.slice(1), vid = args.find((a) => !a.startsWith('--'))
      const unknown = args.filter((a) => a.startsWith('--') && a !== '--retry' && a !== '--reference-ok')
      if (!vid || unknown.length || args.filter((a) => !a.startsWith('--')).length > 1) { console.log('videos approve <id> [--retry] [--reference-ok]' + (unknown.length ? `（不认识：${unknown.map(shown).join(' ')}）` : '')); process.exitCode = 2; return }
      console.log('投稿中（上传 + 提交，视频大的话要几分钟）…')
      // --reference-ok：她交审之后你加了讲义、上传前比出了对得上的地方，你看过觉得没问题，照样投
      const r = await approveVideo(vid, { retry: args.includes('--retry'), referenceOk: args.includes('--reference-ok') })
      if (r.duplicate) warn(`又投出了一条多余的稿件 ${r.bvid ?? '（没拿到 BV 号）'}：` + r.error)
      else if (r.ok && r.existing) console.log(`✓ 没有重新上传：之前那次结果不确定的投稿其实成功了 —— B站 上就是 ${r.bvid ?? ''}（状态 ${r.state ?? '?'}），按它记账\n  https://www.bilibili.com/video/${r.bvid ?? ''}`)
      else console.log(r.ok ? `✓ 已投稿 ${r.bvid ?? ''}（B站 还要审核，过了才公开）${r.bvid ? '\n  https://www.bilibili.com/video/' + r.bvid : ''}` : '✗ 没投出去：' + r.error)
      for (const n of r.notes ?? []) warn('投稿成功了，但' + n)
      if (!r.ok) process.exitCode = 1
      return
    }
    if (sub === 'reject') {
      const r = rejectVideo(id, rest.slice(2).filter((x) => x !== '--force').join(' '), { force: rest.includes('--force') })
      console.log(r.ok ? '✓ 已否掉（理由会写进她的作品记录，她下次能看到）' : '✗ ' + r.error)
      if (r.ok && r.uncertain) warn(`这条之前有 ${r.uncertain} 次投稿结果不确定（B站 可能已经收到了）。这个记录不会因为退回而消失：她重交之后你批准时，会先去 B站 核对`)
      if (!r.ok) process.exitCode = 1
      return
    }
    if (sub === 'resolve') {
      // 去创作中心看过之后，亲自了结「结果不确定」的投稿：none = B站 上没有 / 多出来的已删掉；BV号 = 这个作品在 B站 上就是这一条
      if (!id || !rest[2]) { console.log('videos resolve <id> none | <BV号>'); process.exitCode = 2; return }
      const r = await resolveVideo(id, rest[2], { force: rest.includes('--force') })
      if (!r.ok) { console.log('✗ ' + r.error); process.exitCode = 1; return }
      console.log(rest[2] === 'none' ? `✓ 已了结 ${r.resolved} 次不确定的投稿（现在可以照常批准）` : `✓ 已记成发布：${r.bvid}（这个作品以后不会再投）`)
      return
    }
    if (sub === 'play') {
      const f = videoFile(id ?? '')
      if (!fs.existsSync(f)) { console.log('找不到审片快照：' + f + '（只放快照里的那一份 —— 她作品目录里的成片她还能改，不算数）'); process.exitCode = 1; return }
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', f]] : process.platform === 'darwin' ? ['open', [f]] : ['xdg-open', [f]]
      spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      console.log('已用默认播放器打开：' + f)
      return
    }
    const items = listVideos()
    if (!items.length) { console.log('没有等你审的视频'); return }
    for (const it of items) {
      const m = readMeta(it.id)
      console.log(`[${it.id}] ${shown(it.title)}（${it.seconds} 秒）`)
      const dressed = it.outfits && typeof it.outfits === 'object' ? Object.entries(it.outfits).map(([k, v]) => `${k} 穿${v}`).join('、') : ''
      if (dressed) console.log(`   换装：${shown(dressed)}`)
      console.log(`   她为什么想发：${shown(it.reason)}`)
      if (Array.isArray(it.originality?.flags) && it.originality.flags.length) console.log('   ⚠️ 和参考材料对得上的地方（没拦，你看一下）：' + shown(it.originality.flags.join('；')))
      const refsSeen = Array.isArray(it.originality?.references) ? it.originality.references : null
      console.log(`   原创查重：${it.originality?.passed ? '通过' : '（老版本交的，没查）'}${refsSeen ? (refsSeen.length ? `（也和参考材料${refsSeen.map((r) => `「${shown(r.name)}」`).join('')}比过）` : '（交审时还没有参考材料）') : ''}${it.originality?.notes?.length ? ' · ⚠️ ' + shown(it.originality.notes.join('；')) : ''}`)
      console.log(`   审片快照：${videoFile(it.id)}    封面：${path.join(path.dirname(videoFile(it.id)), 'cover.jpg')}`)
      // 会一起投上去的简介 / 标签 / 分区（来自审片快照里的剧本，就是会上传的那一份）—— 以前审片时看不到。
      // 标签的整理规则和 studio.py upload_meta 一模一样（host/review.mjs 的 uploadMeta：小窗的审核面板也用它）
      let sc = null
      try { sc = JSON.parse(fs.readFileSync(path.join(path.dirname(videoFile(it.id)), 'script.json'), 'utf8')) } catch {}
      if (sc) {
        const { tags, desc, descLen, descDropped, part, partKnown } = uploadMeta(sc)   // 分区名照 bilibili_api 自带的分区表；对不上就明说（上传前还会挡一次）
        const partText = part ? `（${part}）` : partKnown ? '（⚠️ 不是投稿用的子分区，上传前会被挡下）' : ''
        console.log(`   分区 tid=${shown(sc.tid ?? '?')}${partText} · 标签：${shown(tags.slice(0, TAG_SHOW).join(' / ')) || '（无）'} / AI生成`)
        const chars = [...desc]   // 按字符数（表情算一个）：和她写的一共几个字同一个算法，也不会把表情从中间截开
        console.log(`   简介：${desc ? shown(chars.slice(0, 300).join(''), { keepNewlines: true }) + (descLen > 300 ? `…（共 ${descLen} 字，全文在快照的 script.json）` : '') : '（空）'}（末尾会自动加 AI 创作声明）`)
        if (descDropped) console.log(`   ⚠️ 她写的简介超出 B站 简介上限：只发前 ${chars.length} 字，后面 ${descDropped} 字不会发出去`)
      } else console.log('   ⚠️ 读不到快照里的剧本')
      if (Array.isArray(m.history) && m.history.length) console.log(`   她的作品记录（她写的，仅供参考）：${shown(m.history.map((h) => String(h?.note ?? '')).filter(Boolean).slice(-2).join(' · '))}`)
    }
    console.log('\n先看：videos play <id>    发：videos approve <id>    不发：videos reject <id> 理由')
  },

  async 'studio-setup'() {
    const cfg = readConfig()
    const tries = [cfg.studio?.python ? [cfg.studio.python, []] : null,
      process.platform === 'win32' ? ['py', ['-3']] : null, ['python3', []], ['python', []]].filter(Boolean)
    let base = null
    for (const [exe, pre] of tries) {
      const v = spawnSync(exe, [...pre, '-c', 'import sys;print(sys.version_info>=(3,10))'], { encoding: 'utf8', windowsHide: true })
      if (String(v.stdout).trim() === 'True') { base = [exe, pre]; break }
    }
    if (!base) { console.log('找不到 Python 3.10+：装一个（winget install Python.Python.3.12），或 config set studio.python <路径>'); process.exitCode = 1; return }
    const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!fs.existsSync(py)) {
      console.log(`建虚拟环境：${VENV_DIR}`)
      const r = spawnSync(base[0], [...base[1], '-m', 'venv', VENV_DIR], { stdio: 'inherit' })
      if (r.status !== 0) { process.exitCode = 1; return }
    }
    console.log('装依赖（edge-tts / pillow / imageio-ffmpeg / bilibili-api / pypdf）…')
    const r = spawnSync(py, ['-m', 'pip', 'install', '-q', '--no-cache-dir', '-r', path.join(ROOT, 'studio', 'requirements.txt')], { stdio: 'inherit' })
    if (r.status !== 0) { console.log('✗ pip 失败（看上面的报错）'); process.exitCode = 1; return }
    ok('工作室依赖装好了。她现在可以 studio new / render / submit 了')
    if ((cfg.studio?.image?.provider ?? 'none') === 'none') console.log('  （想给她配 AI 配图：config set studio.image \'{"provider":"openai-compatible","baseUrl":"…","model":"…"}\' 再 image-key）')
  },

  /** 「听」（2026-10-26）：装 .listen-venv（sherpa-onnx，只用 CPU）+ 下 SenseVoiceSmall（int8）和 silero VAD 两个模型
   *  （k2-fsa/sherpa-onnx 官方发布页）。主人自己跑；下过的不重下（--force 重下）。装好后要重启一次宿主，她的命令清单里才有 listen */
  async 'listen-setup'() {
    const cfg = readConfig()
    // 先看现有的模型可不可信（记号在、大小对得上）：不可信的（上次装到一半、文件被截短、旧版装的没有记号）一律重下，
    //   不拿现有的文件去补一个记号。记号等到要动模型时才删 —— 找不到 Python、pip 失败，现有的安装照旧能用
    const trusted = modelsValid()
    const mark = path.join(LISTEN_MODELS, READY_FILE)
    const tries = [cfg.studio?.python ? [cfg.studio.python, []] : null,
      process.platform === 'win32' ? ['py', ['-3']] : null, ['python3', []], ['python', []]].filter(Boolean)
    let base = null
    for (const [exe, pre] of tries) {
      const v = spawnSync(exe, [...pre, '-c', 'import sys;print(sys.version_info>=(3,10))'], { encoding: 'utf8', windowsHide: true })
      if (String(v.stdout).trim() === 'True') { base = [exe, pre]; break }
    }
    if (!base) { console.log('找不到 Python 3.10+：装一个（winget install Python.Python.3.12），或 config set studio.python <路径>'); process.exitCode = 1; return }
    const py = listenPython()
    if (!fs.existsSync(py)) {
      console.log(`建虚拟环境：${LISTEN_VENV}`)
      const r = spawnSync(base[0], [...base[1], '-m', 'venv', LISTEN_VENV], { stdio: 'inherit' })
      if (r.status !== 0) { process.exitCode = 1; return }
    }
    console.log('装依赖（sherpa-onnx / numpy，只用 CPU）…')
    const r = spawnSync(py, ['-m', 'pip', 'install', '-q', '--no-cache-dir', '-r', path.join(ROOT, 'studio', 'requirements-listen.txt')], { stdio: 'inherit' })
    if (r.status !== 0) { bad('pip 失败（看上面的报错）'); process.exitCode = 1; return }
    const force = rest.includes('--force') || !trusted
    const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
    const vad = path.join(LISTEN_MODELS, 'silero_vad.onnx')
    const svModel = path.join(LISTEN_MODELS, 'sense-voice', 'model.int8.onnx'), svTokens = path.join(LISTEN_MODELS, 'sense-voice', 'tokens.txt')
    fs.mkdirSync(path.dirname(svModel), { recursive: true })
    // 「装完了」的记号先删掉、最后才写：这次装到一半断掉，她那边就当没装好
    fs.rmSync(mark, { force: true })
    // 先下到 .part 再改名：下到一半断掉不会留下一个像是完整的模型
    const download = async (url, dest) => {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`)
      const { pipeline } = await import('node:stream/promises')
      const { Readable } = await import('node:stream')
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'))
      fs.renameSync(dest + '.part', dest)
    }
    try {
      if (force || !fs.existsSync(vad)) { console.log('下 silero VAD（约 2 MB）…'); await download(REL + 'silero_vad.onnx', vad) }
      if (force || !fs.existsSync(svModel) || !fs.existsSync(svTokens)) {
        const tar = path.join(LISTEN_MODELS, 'sense-voice.tar.bz2')
        console.log('下 SenseVoiceSmall int8（一两百 MB，要等一会儿）…')
        await download(REL + 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2', tar)
        // 压缩包里只取这两个文件，按固定名字写出来（不照包里的路径解：写不到模型目录以外）
        const x = spawnSync(py, ['-c', [
          'import sys, tarfile',
          'src, model, tokens = sys.argv[1:4]',
          'want = {"model.int8.onnx": model, "tokens.txt": tokens}',
          'got = set()',
          'with tarfile.open(src, "r:bz2") as t:',
          '    for m in t:',
          '        n = m.name.rsplit("/", 1)[-1]',
          '        if m.isfile() and n in want and n not in got:',
          '            open(want[n] + ".part", "wb").write(t.extractfile(m).read())',
          '            got.add(n)',
          'sys.exit(0 if len(got) == 2 else 3)'].join('\n'), tar, svModel, svTokens], { stdio: 'inherit' })
        fs.rmSync(tar, { force: true })
        if (x.status !== 0) { bad('压缩包里没找到 model.int8.onnx / tokens.txt'); process.exitCode = 1; return }
        // 两个都解出来了才换上（先写 .part，再改名）
        for (const f of [svModel, svTokens]) fs.renameSync(f + '.part', f)
      }
    } catch (e) { bad(String(e?.message ?? e).slice(0, 200)); process.exitCode = 1; return }
    for (const f of [svModel, svTokens, vad]) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
      console.log(`  ${path.relative(LISTEN_MODELS, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  sha256 ${h.slice(0, 16)}…`)
    }
    const files = Object.fromEntries(MODEL_FILES.map((f) => [f, fs.statSync(path.join(LISTEN_MODELS, f)).size]))
    fs.writeFileSync(mark + '.part', JSON.stringify({ version: 1, at: new Date().toISOString(), files }, null, 2))
    fs.renameSync(mark + '.part', mark)
    ok(`「听」装好了（${LISTEN_VENV} · 模型在 ${LISTEN_MODELS}）`)
    const ff = await listenFfmpeg()
    ff ? ok(`ffmpeg：${ff}`) : warn('没找到 ffmpeg —— 她「听」的时候要用它转声音：先跑 node host/cli.mjs studio-setup（会带一个），或者装一个 ffmpeg')
    console.log('  她的命令清单是宿主启动时定的：重启一次宿主（node host/cli.mjs restart），她才用得上 listen')
  },

  /** 参考材料（老师的讲义等，2026-10-24）：她交审时原创查重会和它比；原文只在 ~/.bili-ai/reference，她看不到。
   *  reference [list] | add <讲义.pdf|.txt|.md> [--name 名字] [--force] | remove <名字或 id> */
  async reference() {
    const sub = rest[0] ?? 'list'
    if (sub === 'list') {
      let refs
      try { refs = listReferences(REFERENCE_DIR, { tolerant: true }) } catch (e) { bad(e.message); process.exitCode = 1; return }
      if (!refs.length) { console.log(`还没有参考材料。加一份：node host/cli.mjs reference add <讲义.pdf|.txt|.md> [--name 名字]（存在 ${REFERENCE_DIR}，她看不到）`); return }
      for (const r of refs) {
        // 坏掉的也列出来（她交审会一直被拦）：给 id，好删
        if (r.broken && r.name === r.id) { warn(`${r.id}：${r.broken} —— reference remove ${r.id} 删掉，再重新 add`); continue }
        console.log(`${shown(r.name)} · ${r.chars} 字 · 来自 ${shown(r.source || '?')} · ${String(r.addedAt ?? '').slice(0, 16).replace('T', ' ')} · ${r.id}`)
        if (r.broken) warn(`  ${r.broken} —— reference remove ${r.id} 删掉，再重新 add`)
      }
      return
    }
    if (sub === 'add') {
      // 只认：一个文件、--name 名字（或 --name=名字）、--force；别的一律不认（免得名字没起上、她看到的是文件名）
      let file = null, given = null, force = false
      const args = rest.slice(1)
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i]
        if (a === '--force') force = true
        else if (a === '--name' || a.startsWith('--name=')) {
          if (given !== null) { bad('--name 只能给一次'); process.exitCode = 2; return }
          given = a === '--name' ? args[(i += 1)] : a.slice('--name='.length)
          if (!given || given.startsWith('--') || !given.trim()) { bad('--name 后面要跟一个名字'); process.exitCode = 2; return }
        } else if (a.startsWith('--') || file !== null) { bad(`看不懂的参数：${shown(a)}（reference add <讲义.pdf|.txt|.md> [--name 名字] [--force]；名字里有空格就加引号）`); process.exitCode = 2; return }
        else file = a
      }
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { bad('给一个文件：reference add <讲义.pdf|.txt|.md> [--name 名字]'); process.exitCode = 2; return }
      const ext = path.extname(file).toLowerCase()
      let text
      if (ext === '.txt' || ext === '.md') {
        // 编码：UTF-8，或者带 BOM 的 UTF-16（记事本的「Unicode」）。别的（GBK、Latin-1…）不猜 —— 猜错了存进去的是乱码，查重永远对不上
        const buf = fs.readFileSync(file)
        try {
          if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2))
          else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2))
          else text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
        } catch { bad('这个文件不是 UTF-8（也不是带 BOM 的 UTF-16）：用记事本「另存为」、编码选 UTF-8，再加'); process.exitCode = 2; return }
      } else if (ext === '.pdf') {
        // 用工作室的 Python + pypdf 抽文字（只读这个文件，不联网）；没装 pypdf 就说怎么装
        const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        if (!fs.existsSync(py)) { bad('读 PDF 要先装工作室依赖：node host/cli.mjs studio-setup'); process.exitCode = 1; return }
        const PDF_TEXT = [
          'import sys, json',
          'try:',
          '    from pypdf import PdfReader',
          'except ImportError:',
          '    print(json.dumps({"ok": False, "error": "nopypdf"})); sys.exit(0)',
          'try:',
          '    r = PdfReader(sys.argv[1])',
          '    pages = [(p.extract_text() or "") for p in r.pages]',
          '    print(json.dumps({"ok": True, "pages": len(pages), "text": "\\n".join(pages)}))',
          'except Exception as e:',
          '    print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)[:200]}))',
        ].join('\n')
        const r = spawnSync(py, ['-I', '-c', PDF_TEXT, path.resolve(file)], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } })
        let out = null
        try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
        if (out?.error === 'nopypdf') { bad('读 PDF 要 pypdf：再跑一次 node host/cli.mjs studio-setup（会装上）；或者先把讲义另存成 .txt'); process.exitCode = 1; return }
        if (!out?.ok || typeof out.text !== 'string') { bad('PDF 读不出来：' + shown(String(out?.error ?? r.error?.message ?? r.stderr ?? '').slice(0, 160)) + '（加密了？可以先另存成 .txt）'); process.exitCode = 1; return }
        text = out.text
      } else { bad('只认 .pdf / .txt / .md'); process.exitCode = 2; return }
      // 名字默认是文件名（太长就截到 40 个字）；她被拦时看得到名字
      const name = given !== null ? given.trim() : [...path.basename(file, path.extname(file)).trim()].slice(0, 40).join('').trim()
      const stats = referenceStats(text)
      if (stats.words < 200 && stats.han < 200 && !force) {
        bad(`几乎没抽出文字（拉丁字母的词 ${stats.words} 个、汉字 ${stats.han} 个）—— 是扫描版的 PDF 吗？这样查不了，没存。先用别的工具转成文字再加；确实就这么短，加 --force`)
        process.exitCode = 2; return
      }
      let saved
      try { saved = saveReference(name, text, file) } catch (e) { bad(e.message + (given === null ? '（名字取自文件名；用 --name 另起一个）' : '')); process.exitCode = 2; return }
      if (saved.replaced) warn(`替换了之前的「${shown(saved.replaced.name)}」（来自 ${shown(saved.replaced.source || '?')}，${saved.replaced.chars} 字）`)
      ok(`参考材料「${shown(saved.name)}」已存好：${saved.chars} 字（拉丁字母的词 ${saved.words} 个、有辨识度的数字 ${saved.numbers} 个、汉字 ${saved.han} 个）`)
      console.log(`  她交审时会和它比。拦：一段 ≥ ${WORD_BLOCK} 个词原样一样、一道例题的数字整个搬过来（≥ ${NUM_MIN} 个少见的数对上）、中文大段重合；只提醒（你审片时看得到）：一句 ${WORD_RUN} 个词以上的原话、几个数字对上。公认的数值、经典例子不算。她看不到原文；她翻成中文讲的查不出来，要靠你审片。`)
      console.log(`  她被拦时会看到这份材料的名字「${shown(saved.name)}」（看不到内容）；不想让她看到文件名，就用 --name 另起一个。已经在等你审的视频，批准时（上传前）会再和它比一遍`)
      return
    }
    if (sub === 'allow') {
      // 她被讲义拦了、你看过觉得没问题（谁算都一样的标准表格之类）：放行她这个作品**现在这一份剧本**（按指纹；她再改就要重新放行）
      const wid = rest[1], clear = rest.includes('--clear')
      if (!wid || wid.startsWith('--') || !/^[0-9A-Za-z_-]{3,80}$/.test(wid) || rest.slice(2).some((a) => a !== '--clear')) { console.log('用法：reference allow <作品 id> [--clear]'); process.exitCode = 2; return }
      if (clear) { allowReference(wid, null); ok(`取消了作品 ${wid} 的放行`); return }
      let buf, script
      try { buf = fs.readFileSync(path.join(projectDir(wid), 'script.json')); script = JSON.parse(buf.toString('utf8')) } catch (e) { bad(`作品 ${shown(wid)} 的剧本读不了（${e?.code ?? 'JSON 坏了'}）`); process.exitCode = 2; return }
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      const r = referenceOverlap(script)
      for (const h of r.hits) console.log('  拦：' + shown(describeHit(h)))
      for (const h of r.flags) console.log('  提醒：' + shown(describeHit(h)))
      if (r.errors.length) { for (const e of r.errors) bad(e); bad('参考材料读不了 —— 先修好（reference list），读不了的不能放行'); process.exitCode = 1; return }
      if (!r.hits.length) { console.log(referenceAllowed(wid, sha) ? '这一份已经放行过了' : '这一份剧本和参考材料没有会拦的地方，不用放行'); return }
      allowReference(wid, sha)
      ok(`放行了作品 ${wid} 现在这一份剧本：上面这几处不再拦她，变成提醒（你审片时 videos 里看得到）。她再改剧本就要重新放行；取消：reference allow ${wid} --clear`)
      return
    }
    if (sub === 'remove') {
      const name = rest.slice(1).filter((x) => !x.startsWith('--')).join(' ').trim()
      let r
      try { r = removeReference(name) } catch (e) { bad(e.message); process.exitCode = 1; return }
      if (r) ok(`已删掉参考材料「${shown(r.name)}」（只删了抽出来的文字，你原来的文件没动）`)
      else { bad('没有叫这个名字的参考材料：' + shown(name) + '（reference list 看名字和 id）'); process.exitCode = 2 }
      return
    }
    console.log('用法：reference [list] | add <讲义.pdf|.txt|.md> [--name 名字] [--force] | remove <名字或 id> | allow <作品 id> [--clear]')
    process.exitCode = 2
  },

  async cast() {
    const sub = rest[0] ?? 'list'
    const id = rest[1]
    const flags = {}
    const images = []
    for (let i = 2; i < rest.length; i += 1) {
      if (!rest[i].startsWith('--')) continue
      const k = rest[i].slice(2), v = rest[i + 1]
      if (k === 'image') images.push(v); else flags[k] = v
      i += 1
    }
    // profile.json：读的时候认 BOM（记事本 / PowerShell 存的）；读不出来就不改（以前当成 {} 重写，声音、参考音、描述就全没了）
    const readProf = (f) => {
      try {
        const s = fs.readFileSync(f, 'utf8')
        const p = JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
        return p && typeof p === 'object' && !Array.isArray(p) ? { prof: p } : { error: 'profile.json 不是一个对象' }
      } catch (e) { return e?.code === 'ENOENT' ? { missing: true } : { error: `profile.json 读不出来（${e?.code ?? 'JSON 坏了'}）` } }
    }
    if (sub === 'list') {
      const cast = listCast()
      if (!cast.length) { console.log(`还没有角色。加一个：node host/cli.mjs cast add <id> --name 名字 --image 立绘.png --voice zh-CN-XiaoyiNeural --desc "外貌描述"\n（角色放在 ${CAST_DIR}）`); return }
      for (const c of cast) {
        console.log(`${c.id} · ${c.name ?? ''} · 声音 ${castVoiceLabel(c)} · 参考图 ${c.refs.length} · 表情 ${c.sprites.join('/') || '无'}${outfitLabel(c) ? ` · 换装 ${outfitLabel(c)}` : ''}${c.desc ? '\n   ' + c.desc : ''}`)
        if (c.outfitProblem) warn(c.outfitProblem)
        if (c.flatIgnored?.length) warn(`${c.id}：sprites/ 下平铺的 ${c.flatIgnored.join('、')} 用不上了（有换装文件夹时只用换装里的立绘）`)
      }
      return
    }
    if (!/^[a-z0-9_-]{2,32}$/.test(String(id ?? ''))) { console.log('角色 id 用小写字母 / 数字 / - _，比如 cast add xiaojing …'); process.exitCode = 2; return }
    const dir = path.join(CAST_DIR, id)
    if (sub === 'add') {
      const profFile = path.join(dir, 'profile.json')
      const pr = readProf(profFile)
      if (pr.error) { bad(`${pr.error}，没改 —— 先修好它：${profFile}`); process.exitCode = 2; return }
      fs.mkdirSync(path.join(dir, 'sprites'), { recursive: true })
      const prof = pr.prof ?? {}
      for (const k of ['name', 'voice', 'rate', 'pitch', 'color', 'desc', 'tts', 'instructions']) if (flags[k] !== undefined) prof[k] = flags[k]
      prof.name ??= id
      writeJson(profFile, prof)   // 先写临时文件再改名：她正在渲染时读到的不会是写了一半的文件
      const existing = fs.readdirSync(dir).filter((f) => /^ref/i.test(f)).length
      images.forEach((img, k) => {
        if (!fs.existsSync(img)) { warn('找不到图片：' + img); return }
        fs.copyFileSync(img, path.join(dir, `ref${existing + k + 1}${path.extname(img).toLowerCase() || '.png'}`))
      })
      ok(`角色 ${id}（${prof.name}）已保存：${dir}`)
      if (!readConfig().studio?.host) {
        const r = setConfigPath('studio.host', JSON.stringify(id))
        r.ok ? ok(`${prof.name} 是第一个角色，设为主角（改：config set studio.host '"<id>"'）`) : warn('没设成主角：' + r.error)
      }
      const c = listCast().find((x) => x.id === id)
      console.log(`  参考图 ${c?.refs.length ?? 0} 张 · 表情立绘 ${c?.sprites.length ?? 0} 张`)
      if (!c?.refs.length) warn('还没有参考图：cast add ' + id + ' --image <立绘.png>')
      console.log(`  下一步：node host/cli.mjs cast sprites ${id}（用参考图生成 6 种表情的透明底立绘；要先配好 AI 画图）`)
      console.log('  已经有透明底的表情立绘？直接放进 ' + path.join(dir, 'sprites') + '，文件名就是表情名（neutral.png / happy.png …）')
      console.log(`  几套换装：每套一个文件夹 sprites/<换装>/<表情>.png（张嘴的说话版放 sprites/<换装>/${TALK_DIR}/），再 cast outfit ${id} <换装> 定默认`)
      return
    }
    if (sub === 'outfit') {
      // 看 / 设默认换装：cast outfit <id> [<换装> | --clear]。她在剧本里写 "outfit": {"<id>": "<换装>"} 按视频换，不写就穿这里定的
      const profFile = path.join(dir, 'profile.json')
      const pr = readProf(profFile)
      if (pr.missing) { bad('没有这个角色：' + id); process.exitCode = 2; return }
      if (pr.error) { bad(`${pr.error}，没改 —— 先修好它：${profFile}`); process.exitCode = 2; return }
      const prof = pr.prof
      if (rest.includes('--clear')) {   // 不要默认换装了（比如换装文件夹撤掉、回到平铺立绘）
        delete prof.outfit
        writeJson(profFile, prof)
        ok(`${prof.name ?? id} 不再指定默认换装（有换装文件夹时穿排第一的那套，没有就用平铺的 sprites/<表情>.png）`)
        return
      }
      const c = listCast().find((x) => x.id === id)
      const names = (c?.outfits ?? []).map((o) => o.name)
      const want = rest[2]
      if (want === undefined) {
        if (!names.length) console.log(`${id} 还没有换装（立绘是平铺的 sprites/<表情>.png）。要几套换装：放成 sprites/<换装>/<表情>.png`)
        for (const o of c?.outfits ?? []) console.log(`${o.name === c.defaultOutfit ? '★' : ' '} ${o.name}：${o.exprs.join(' / ')}${o.talking.length ? `（说话版 ${o.talking.length} 张）` : ''}`)
        if (c?.outfitProblem) warn(c.outfitProblem + (names.length ? '' : `：node host/cli.mjs cast outfit ${id} --clear`))
        if (c?.flatIgnored?.length) warn(`sprites/ 下平铺的 ${c.flatIgnored.join('、')} 用不上了（有换装文件夹时只用换装里的立绘）`)
        if (names.length) console.log(`改默认：node host/cli.mjs cast outfit ${id} <换装>    不指定：cast outfit ${id} --clear`)
        return
      }
      if (!(SPRITE_NAME_RE.test(want) && want !== TALK_DIR) || !names.includes(want)) { bad(`没有「${shown(want)}」这套换装（有：${names.join('、') || '无'}）`); process.exitCode = 2; return }
      prof.outfit = want
      writeJson(profFile, prof)   // 先写临时文件再改名：她正在渲染时读到的不会是写了一半的文件
      ok(`${prof.name ?? id} 的默认换装改成「${want}」（她在剧本里不写 outfit 时就穿这套）`)
      return
    }
    if (sub === 'sprites') {
      const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      if (!fs.existsSync(py)) { console.log('先装工作室依赖：node host/cli.mjs studio-setup'); process.exitCode = 1; return }
      const cfgFile = path.join(dir, '.sprites-config.json')
      fs.writeFileSync(cfgFile, JSON.stringify(renderConfig()))
      const exprs = flags.exprs ?? 'neutral,happy,thinking,surprised,sad,smug'
      console.log(`生成表情立绘：${exprs}（每张约 0.05~0.2 美元，几十秒一张）…`)
      const r = spawnSync(py, [path.join(ROOT, 'studio', 'studio.py'), 'sprites', dir, '--config', cfgFile, '--exprs', exprs, ...(flags.outfit ? ['--outfit', flags.outfit] : []), ...(rest.includes('--force') ? ['--force'] : [])],
        { encoding: 'utf8', env: { ...process.env, BILI_WHALE_IMAGE_KEY: imageKey(), PYTHONUTF8: '1' }, timeout: 30 * 60_000 })
      fs.rmSync(cfgFile, { force: true })
      console.log((r.stdout + '\n' + r.stderr).trim().slice(-1200))
      console.log(`看一眼：${path.join(dir, 'sprites')}（不像就删掉那张重新生成，或换一张更清楚的参考图）`)
      return
    }
    if (sub === 'voice') {
      // 试听：cast voice <id> --try sage,shimmer [--instructions "…"] [--text "…"] [--provider edge]
      // 选定：cast voice <id> --use sage [--instructions "…"] [--provider edge]
      const profFile = path.join(dir, 'profile.json')
      const pr = readProf(profFile)
      if (pr.missing) { console.log('没有这个角色：' + id); process.exitCode = 2; return }
      if (pr.error) { bad(`${pr.error}，没改 —— 先修好它：${profFile}`); process.exitCode = 2; return }
      const prof = pr.prof
      const provider = flags.provider ?? 'openai'
      const instructions = flags.instructions ?? prof.instructions ?? ''
      if (!['openai', 'edge', 'voxcpm'].includes(provider)) { bad(`不认识的 --provider ${shown(provider)}（openai / edge / voxcpm）`); process.exitCode = 2; return }
      if (provider === 'voxcpm') {
        // 本地 VoxCPM：--use 参考音.wav —— 复制进角色目录（渲染只认那里的 voice.wav，剧本改不了），连同「它念的是什么」（续写要用）
        if (flags.use) {
          const src = flags.use
          const st = fs.statSync(src, { throwIfNoEntry: false })
          if (!st?.isFile()) { bad('找不到参考音：' + src); process.exitCode = 2; return }
          const head = Buffer.alloc(12)
          const fd = fs.openSync(src, 'r')
          try { fs.readSync(fd, head, 0, 12, 0) } finally { fs.closeSync(fd) }
          if (!/\.wav$/i.test(src) || st.size > 20 * 1024 * 1024) { bad('参考音要是 .wav 文件（20MB 以内；几秒到半分钟的一段说话）：' + src); process.exitCode = 2; return }
          if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') { bad('这不是 wav 文件（文件头不是 RIFF/WAVE）：' + src); process.exitCode = 2; return }
          let refText = flags['ref-text']
          if (refText === undefined) {   // 没给 --ref-text：看旁边有没有同名 .json（{"text": …}）或 .txt
            const base = src.replace(/\.wav$/i, '')
            try { refText = JSON.parse(fs.readFileSync(base + '.json', 'utf8')).text } catch {}
            if (refText === undefined) try { refText = fs.readFileSync(base + '.txt', 'utf8') } catch {}
          }
          refText = String(refText ?? '').replace(/^\uFEFF/, '').replace(/\t/g, ' ').trim()
          if (!refText) { bad('还要告诉我参考音里念的是什么：--ref-text "…"（或者在 wav 旁边放一个同名 .txt）'); process.exitCode = 2; return }
          if (refText.length > 500 || shown(refText) !== refText) { bad('参考音的文字要在 500 字以内、一行、不带控制字符'); process.exitCode = 2; return }
          // 按内容起名（voice-<指纹>.wav），不覆盖原来那个：她正在渲染的话，那次渲染从头到尾还是用开始时的那份
          const bytes = fs.readFileSync(src)
          const name = `voice-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.wav`
          const dest = path.join(dir, name), tmp = dest + `.${process.pid}.tmp`
          fs.writeFileSync(tmp, bytes)
          fs.renameSync(tmp, dest)
          Object.assign(prof, { tts: 'voxcpm', voxcpm: { ref: name, ref_text: refText } })
          writeJson(profFile, prof)
          ok(`${prof.name ?? id} 的声音：VoxCPM 本地 · 参考音已复制到 ${dest}\n   它念的是：${refText}`)
          const why = voxcpmProblem()
          if (why) warn(why + '（不弄好她渲染会失败）')
          console.log(`  试听（和她渲染走同一条路）：node host/cli.mjs cast voice ${id} --provider voxcpm --try current [--text "…"]`)
          const edgeVoice = /^[a-z]{2,3}-[A-Z]{2}(-\w+)?-\w+Neural$/.test(String(prof.voice ?? '')) ? prof.voice : 'zh-CN-XiaoyiNeural'
          console.log(`  换回 Edge：node host/cli.mjs cast voice ${id} --provider edge --use ${edgeVoice}`)
          return
        }
        if (!flags.try) { console.log(`用法：cast voice ${id} --provider voxcpm --use <参考音.wav> [--ref-text "参考音念的字"]；试听：--try current [--text "…"]`); return }
        if (prof.tts !== 'voxcpm') { bad(`${prof.name ?? id} 还没设成 VoxCPM：先 cast voice ${id} --provider voxcpm --use <参考音.wav>`); process.exitCode = 1; return }
        const vc = checkedVoxcpm()   // 交给 studio.py 的就是查过的这一份（第五轮审查）
        if (vc.why) { bad(vc.why); process.exitCode = 1; return }
        const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        if (!fs.existsSync(py)) { console.log('先装工作室依赖：node host/cli.mjs studio-setup'); process.exitCode = 1; return }
        const text = flags.text ?? '……嗯，我醒了。今天收件箱里有一条留言，我想了很久，还是不知道该怎么回。也许，就先这样吧。'
        const outDir = path.join(dir, 'voice-samples')
        const cfgFile = path.join(dir, '.voice-config.json')
        fs.writeFileSync(cfgFile, JSON.stringify({ ...renderConfig(), voxcpm: vc.voxcpm }))
        console.log('VoxCPM 试听中（加载模型二十秒左右，再加上念的时间）…')
        const r = spawnSync(py, [path.join(ROOT, 'studio', 'studio.py'), 'voices', '--config', cfgFile, '--provider', 'voxcpm', '--try', id, '--text', text, '--out', outDir],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' }, timeout: 15 * 60_000 })
        fs.rmSync(cfgFile, { force: true })
        let out = null
        try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
        if (!out?.ok) { console.log('✗ 试听没做成：' + tryFailReason(r, out, '15 分钟', '（后台的配音进程可能还要几分钟才让出显卡）')); process.exitCode = 1; return }
        ok('试听做好了：')
        for (const f of out.files) console.log('   ' + f)
        return
      }
      if (flags['ref-text'] !== undefined || /\.wav$/i.test(String(flags.use ?? '')) || /[\\/]/.test(String(flags.use ?? ''))) {
        bad(`--use ${shown(flags.use ?? '')} 像是一段参考音：本地配音要写 --provider voxcpm（不写默认是 OpenAI 的声音名，比如 sage）`); process.exitCode = 2; return
      }
      if (flags.use) {
        Object.assign(prof, { tts: provider, voice: flags.use })
        if (provider === 'openai') prof.instructions = instructions
        writeJson(profFile, prof)
        ok(`${prof.name ?? id} 的声音：${provider} · ${flags.use}${provider === 'openai' && instructions ? `\n   语气：${instructions}` : ''}`)
        return
      }
      if (!flags.try) { console.log('用法：cast voice <id> --try sage,shimmer,coral [--instructions "语气描述"] [--text "试听的话"]；选定：--use sage'); return }
      const py = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      if (!fs.existsSync(py)) { console.log('先装工作室依赖：node host/cli.mjs studio-setup'); process.exitCode = 1; return }
      if (provider === 'openai' && !imageKey()) { console.log('先存 OpenAI key：node host/cli.mjs image-key'); process.exitCode = 1; return }
      const text = flags.text ?? '……嗯，我醒了。今天收件箱里有一条留言，我想了很久，还是不知道该怎么回。也许，就先这样吧。'
      const outDir = path.join(dir, 'voice-samples')
      const cfgFile = path.join(dir, '.voice-config.json')
      fs.writeFileSync(cfgFile, JSON.stringify(renderConfig()))
      const r = spawnSync(py, [path.join(ROOT, 'studio', 'studio.py'), 'voices', '--config', cfgFile, '--provider', provider, '--try', flags.try,
        '--text', text, '--instructions', instructions, '--out', outDir],
        { encoding: 'utf8', env: { ...process.env, BILI_WHALE_IMAGE_KEY: imageKey(), PYTHONUTF8: '1' }, timeout: 10 * 60_000 })
      fs.rmSync(cfgFile, { force: true })
      let out = null
      try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {}
      if (!out?.ok) { console.log('✗ 试听没做成：' + tryFailReason(r, out, '10 分钟')); process.exitCode = 1; return }
      ok('试听做好了：')
      for (const f of out.files) console.log('   ' + f)
      console.log(`听完选一个：node host/cli.mjs cast voice ${id} --use <声音>${provider === 'openai' ? ' --instructions "…"（试听的语气不会记下：要这个语气就再写一遍；不写 = 用之前存的）' : ' --provider edge'}`)
      return
    }
    if (sub === 'remove') { fs.rmSync(dir, { recursive: true, force: true }); ok('已删除角色 ' + id); return }
    console.log('用法：cast [list|add <id> --name … --image … --voice … --color #ff7a45 --desc "…"|sprites <id> [--exprs a,b] [--outfit 换装] [--force]|outfit <id> [<换装> | --clear]|voice <id> --try a,b | --use a [--instructions "…"]|voice <id> --provider voxcpm --use 参考音.wav [--ref-text "…"] | --try current|remove <id>]')
  },

  async channel() {
    const sub = rest[0] ?? 'show'
    const st = channelStatus()
    if (sub === 'approve') {
      const r = approveChannel(rest[1])
      if (!r.ok) { console.log('✗ ' + r.error); process.exitCode = 1; return }
      console.log('✓ 已确认她交上来的那一版频道设定（就是你看到的那一版）—— 她现在可以交审视频了（她以后改设定要重新确认）')
      if (r.changedSince) warn('她交上来之后又改过文件：现在文件里的不是你确认的那一版，她交审视频之前得重新 studio channel submit')
      await ownerFeedback('主人确认了她的频道设定')
      return
    }
    if (sub === 'reject') {
      const r = rejectChannel(rest.slice(1).join(' '))
      console.log('✓ 已退回' + (r.feedback ? '，意见写进了她的 channel-feedback.md，她下次会改' : ''))
      if (!r.feedback) warn('意见没写进她的 channel-feedback.md（那个位置被占了），退回本身已经生效')
      await ownerFeedback('主人看了她的频道设定，提了意见')
      return
    }
    // 给你看的是她交上来的那一版（approve 确认的就是它，要带上下面的指纹）；还没交就显示草稿。
    // 她交了之后把文件删掉，交上来的那一版照样显示（以前文件一没就显示「还没写」，等你确认的那一版被藏起来）
    const subm = submittedChannel()
    if (st.state === 'none' && subm?.text == null) { console.log('她还没写频道设定（她醒来时会先写；也可以叫醒她：node host/cli.mjs wake）'); return }
    if (subm?.text != null) {
      console.log(shown(subm.text, { keepNewlines: true }))
      console.log(`—— 这是她 ${new Date(subm.at).toLocaleString('zh-CN')} 交上来的那一版 · 指纹 ${subm.sha.slice(0, 12)}`)
      // 上面这一版的状态：拿它自己的指纹和确认记录比（不能用「文件现在是不是确认过的那版」—— 文件可能改回了以前确认过的另一版）
      if (st.approvedSha && st.approvedSha === subm.sha) console.log(`—— 这一版：已确认（${st.approvedAt}）`)
      else if (subm.rejectedAt) console.log(`—— 这一版：你已经退回了（${new Date(subm.rejectedAt).toLocaleString('zh-CN')}），等她改了重新交`)
      else console.log(`—— 这一版：等你确认 —— 确认：channel approve ${subm.sha.slice(0, 12)}    退回：channel reject 你的意见`)
      // 她现在文件里的那一版（交审视频按它算），单独说
      if (st.state === 'none') warn('她现在的频道设定文件不见了（删掉了 / 读不了）—— 交审视频会被拦；要她重新写、重新 studio channel submit')
      else if (subm.text === st.text) console.log('—— 她现在的文件：就是上面这一版')
      else if (st.state === 'approved') warn(`她现在的文件和上面不一样：是你 ${st.approvedAt} 确认过的另一版（指纹 ${st.approvedSha.slice(0, 12)}）—— 交审视频按那一版算`)
      else warn(`她现在的文件和上面不一样${st.approvedSha ? '，也不是你确认过的版本' : ''} —— 交审视频会被拦，要重新确认：让她重新 studio channel submit`)
    } else {
      console.log(shown(st.text, { keepNewlines: true }))
      console.log(st.state === 'approved' ? `—— 状态：已确认（${st.approvedAt}）` : '—— 这是草稿，她还没交给你确认（approve 不了）')
    }
  },

  async 'image-key'() {
    // 不回显：终端里 askHidden 逐字读；管道照常读一行。没回答（输入流结束、Ctrl+D）= 不动原来的 key（留空回车才是删除）
    const key = await askHidden('OpenAI API key（画图和配音共用，留空 = 删除；输入不显示）：')
    if (key === null) { console.log('没输入，key 没动'); return }
    console.log(setImageKey(key).detail + `  · 存在 ${IMAGE_KEY_FILE}`)
  },

  async logs(argv = rest) {
    const n = Number(argv[argv.indexOf('--n') + 1]) || 10
    const dir = path.join(HOST_DIR, 'logs')
    let lines = []
    // 多读几天当上下文：日志里的 costUsd 是会话累计，每行显示这一回合花的（同一会话前后两行相减，见 host/turncost.mjs）
    try { for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(x)).sort().slice(-10)) lines.push(...fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) } catch {}
    if (!lines.length) console.log('（还没有回合记录）')
    const { turnCosts } = await import('./turncost.mjs')
    const cost = turnCosts(lines.map((l) => { try { return JSON.parse(l) } catch { return null } }))
    for (const l of lines.slice(-n)) {
      try {
        const j = JSON.parse(l)
        const c = cost.get(j.id)
        console.log(`${j.at.slice(0, 16).replace('T', ' ')}  ${j.ok ? '✓' : '✗'}  ${j.id}${c != null ? `  $${c.toFixed(3)}` : ''}${j.ms ? `  ${Math.round(j.ms / 1000)}s` : ''}`)
        console.log('   ' + String(j.result ?? '').replace(/\s+/g, ' ').slice(0, 300))
      } catch {}
    }
  },

  /** 跨端的表态（微信里回了她一句、口头夸了她…）她那边看不见，主人在这里补记一次（沉默衰减清零）。她自己记不了 */
  async react() {
    const note = rest.join(' ').trim() || '主人表态了（cli react）'
    const r = await runBili(['quota', 'react', '--note', note], { timeout: 30_000 })
    console.log((r.out || r.err).trim())
    if (!r.ok) process.exitCode = 1
  },

  /** 本地面板（host/dashboard.mjs）：用打印出来的一次性链接打开（10 分钟内有效、只能用一次，换成 cookie）。面板已经开着：只要一个新链接打印出来，不起第二个 */
  async dashboard(argv = rest) {
    const { startDashboard, collect, liveDashboard, requestCode } = await import('./dashboard.mjs')
    if (argv.includes('--json')) { console.log(JSON.stringify(collect(), null, 2)); return }
    const i = argv.indexOf('--port')
    const port = Number(i >= 0 ? argv[i + 1] : 8765)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.log('--port 要是 1024–65535 之间的数'); process.exitCode = 2; return }
    // 换了浏览器 / 链接过期了：面板还开着，就请它发一个新口令（在它的 dashboard.json 旁边放张条子，数据目录里只有你读写得了），
    // 从 dashboard.json 拿来拼链接 —— 只打印在这个终端里；每次都是新的，两个浏览器各拿各的。面板没理（更新前起的）就给它现在那个，照实说
    const live = await liveDashboard()
    if (live) {
      const fresh = await requestCode(live)
      const cur = fresh ?? live
      const min = Math.floor((Date.parse(cur.codeExpiresAt) - Date.now()) / 60_000)
      const valid = `${Number.isFinite(min) ? Math.max(1, min) + ' 分钟内' : ''}有效、只能用一次`
      const other = i >= 0 && live.port !== port ? `，在 ${live.port} 端口，没换成 ${port}；要换先在它的终端里 Ctrl+C` : ''
      console.log(fresh
        ? `本地面板已经开着（pid ${live.pid}${other}）。新的链接（${valid}；一个链接给一个浏览器）：\n  http://127.0.0.1:${live.port}/?k=${cur.code}`
        : `本地面板已经开着（pid ${live.pid}${other}），但它没发新口令（可能是更新前起的面板）。这是它现在的链接（还没被用掉的话和上次打印的一样；${valid}）：\n  http://127.0.0.1:${live.port}/?k=${cur.code}`)
      return
    }
    const server = startDashboard({ port, log: (m) => console.log(m) })
    server.on('listening', () => console.log(`本地面板：${server.link()}\n  用浏览器打开这个链接（10 分钟内有效、只能用一次；打开后浏览器记住登录 12 小时、2 小时没打开就作废，地址栏里不留口令）。只读；没拿链接换过登录的请求什么数据都拿不到。\n  注意：cookie 不分端口 —— 同一个浏览器里再打开本机别的网页服务（127.0.0.1 / localhost 的别的端口），那个服务也收得到这个登录。最好在单独的浏览器个人资料（或 InPrivate 窗口）里只开面板；Ctrl+C 关掉面板，所有登录马上作废。\n  换了浏览器 / 链接过期了：面板开着时另开一个终端再跑一次 node host/cli.mjs dashboard，每次拿一个新链接。Ctrl+C 关掉`))
    server.on('error', (e) => { console.log(e?.code === 'EADDRINUSE' ? `端口 ${port} 被占用了：换一个，比如 --port ${port + 1}` : '面板起不来：' + (e?.message ?? e)); process.exitCode = 1 })
    // Ctrl+C / 关掉终端：先删掉 dashboard.json（里面有口令）再退
    const stop = () => { try { server.stop() } catch {} process.exit(0) }
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, stop)
  },

  /** 「她的小窗」：只读的小窗服务（host/window.mjs，127.0.0.1:8766）+ Edge 应用窗口 / 桌宠。逻辑都在 window.mjs 的 windowCommand（那边能单测） */
  async window(argv = rest) {
    const { windowCommand } = await import('./window.mjs')
    process.exitCode = await windowCommand(argv)
  },

  /**
   * 她给明天的信（2026-10-26，记忆方案第二项）：letters [list]（最近 10 封，新的在前）· letters --all · letters hide <id> [理由] · letters unhide <id>。
   * 只读 ~/.bili-ai/letters.jsonl；收起 / 放回是追加一条记录（原文不删；她看不到理由）。她写的字都经 shown()
   */
  async letters() {
    const L = await import('../tools/lib/letters.mjs')
    const sub = rest[0] ?? 'list'
    const USAGE = '用法：letters [list] | letters --all | letters hide <id> [理由] | letters unhide <id>'
    if (sub === 'hide' || sub === 'unhide') {
      const id = String(rest[1] ?? '')
      if (!id || (sub === 'unhide' && rest.length > 2)) { console.log(USAGE); process.exitCode = 2; return }
      try {
        const r = L.hideLetter(id, { reason: rest.slice(2).join(' '), unhide: sub === 'unhide' })
        if (sub === 'hide') r.result === 'same' ? warn(`${id} 本来就收着 —— 什么都没改`) : ok(`已收起 ${id}：下次醒来不再附上（原文还在；放回：node host/cli.mjs letters unhide ${id}）`)
        else r.result === 'same' ? warn(`${id} 没收起过 —— 什么都没改`) : ok(`已放回 ${id}：${L.MAX_AGE_DAYS} 天以内的话，又会附在提示里`)
      } catch (e) { bad(shown(e?.message ?? e)); process.exitCode = Number(e?.exitCode) || 1 }
      return
    }
    const all = sub === '--all'
    if ((sub !== 'list' && !all) || rest.length > 1) { console.log(USAGE); process.exitCode = 2; return }
    const cfg = readConfig()
    const on = L.lettersEnabled(cfg)
    const r = L.readLetters({ cfg })
    const next = new Set(on ? L.latestLetters({ cfg }).map((x) => x.id) : [])
    console.log('—— 她给明天的信 ——')
    console.log(on ? `开关：开着（下次醒来附上最近 ${L.INJECT_N} 封：${L.MAX_AGE_DAYS} 天以内、没收起的）`
      : '开关：关着（默认）—— 打开：node host/cli.mjs config set letters.enabled true（这一版第一次打开要重启一次宿主，她才用得上 letter 命令）')
    if (r.broken) bad(`~/.bili-ai/letters.jsonl 读不出来（${shown(r.broken)}）`)
    if (r.corrupt) warn(`有 ${r.corrupt} 行读不出来 / 没通过检查：不附上、不列`)
    const list = (all ? r.letters : r.letters.slice(-10)).slice().reverse()
    if (!list.length) console.log('  （还没有）')
    for (const x of list) {
      const h = r.hidden.get(x.id)
      const tags = [h ? `已收起${h.reason ? '（' + h.reason + '）' : ''}` : '', next.has(x.id) ? '下次醒来会附上' : ''].filter(Boolean)
      console.log(`  ${x.id} · ${new Date(x.at).toLocaleString('zh-CN', { hour12: false })} · ${L.OWNER_KIND_LABEL[x.kind]} · ${x.len} 字${tags.length ? ' · ' + shown(tags.join(' · ')) : ''}`)
      console.log('    ' + shown(x.text))
    }
    if (!all && r.letters.length > list.length) console.log(`  （还有 ${r.letters.length - list.length} 封更早的：letters --all）`)
    console.log('  收起某一封（不再附上，原文还在）：node host/cli.mjs letters hide <id> [理由] · 放回：letters unhide <id>')
  },

  async 'notify-test'() {
    const r = await runBili(['notify', '--test'], { timeout: 60_000 })
    console.log((r.out + '\n' + r.err).trim())
    if (!r.ok) process.exitCode = 1   // 以前没发成也以 0 退出
  },

  async prompt() { console.log(manualWakeText(rest.includes('--skip'))) },
}

/**
 * 模块的回合在 cli 里怎么说（host/<模块>-panel.mjs 的 turn：stopNote、configHeld）。没装的没有；
 * 文件加载出错也当没有（这几句只是补充说明，不能让 stop / wake 跟着出错；装坏了 doctor 会说）
 */
let modTurns = null
async function moduleTurns() {
  if (!modTurns) {
    modTurns = []
    for (const [name, rel] of [['qq', 'qq-panel.mjs'], ['sdm', 'sdm-panel.mjs']]) { try { const m = await optionalHook(name, rel); if (m?.turn) modTurns.push(m.turn) } catch {} }
  }
  return modTurns
}

/** 交给可拔掉的模块用的那几样（模块里的命令、体检行照旧这样打印、这样设退出码） */
const ui = () => ({ rest, ok, bad, warn, shown, askHidden, readConfig, runBili })
// 可拔掉的模块自己带的命令：装了才有（不是核心命令时才去找；报到单坏了说一句）
if (!Object.hasOwn(commands, cmd)) {
  for (const name of MODULE_NAMES) {
    if (!moduleInstalled(name)) continue
    const m = await loadModule(name)
    if (m.error) console.log(`  ⚠️ ${name} 模块加载出错（${m.error}）`)
    const f = m.mod?.cli?.commands?.[cmd]
    if (typeof f === 'function') { commands[cmd] = () => f(ui()); break }
  }
}
const fn = commands[cmd]
// 每条命令之前都先把老布局搬一次（只搬没搬过的，不覆盖）：主人在搬家之前就跑 videos / channel，
// 以前会在新位置写出半个作品目录，让那个作品永远搬不过来
if (fn && !['help', 'prompt', 'dashboard', 'window'].includes(cmd)) {   // 面板、小窗只读：不搬文件
  try { reportMigration(migrateLayout(), (m) => console.log(m + '\n')) } catch (e) { console.log('  ⚠️ 搬老数据出错：' + String(e?.message ?? e).slice(0, 160)) }
}
if (!fn) { console.log(`未知命令：${cmd}\n`); await commands.help(); process.exitCode = 2 } else await fn()
