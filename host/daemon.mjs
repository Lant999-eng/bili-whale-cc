/**
 * bili-whale-cc 常驻宿主 —— 顶替 DSH：
 *   · 跑原版的生物钟 + 评论区 / 私信 / 直播间监听（lib/scheduler.js，一行没改逻辑）
 *   · 到点了往她的 Claude Code 会话里投一个回合（host/claude.mjs）
 *   · 配置文件一改就重算（等价于设置页"保存即生效"）
 *   · CLI 往队列里塞的回合（`cli.mjs wake`）也由这里执行
 *   · 每小时用 nav（只读）查一次她的 B站 登录还有效没有，失效 / 号不对时提醒你一次（host/bililogin.mjs；自动续期还没做）
 *   · 收主人在 QQ 上发给小号的私聊（host/qq-listen.mjs；配置 qq.inbound 打开才收）—— 那个文件缺了、坏了，宿主照样起来
 *
 * 用法：node host/daemon.mjs          （一般用 `node host/cli.mjs start` 在后台起）
 */
import './env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { startScheduler, personaText } from '../lib/scheduler.js'
import { BILI_MJS, DSH_HOME, HOST_DIR, CFG_FILE, readConfig, runtimeStatus, runBili } from './core.mjs'
import { runLoginCheck, scheduleLoginChecks } from './bililogin.mjs'
import { ClaudeSessionController, findClaude } from './claude.mjs'
import { ensureWorkDir } from './workdir.mjs'
import { STATE, readDaemonState, hostProcess } from './state.mjs'
import { loadModule } from './modules.mjs'

const LOG = path.join(HOST_DIR, 'daemon.log')
fs.mkdirSync(HOST_DIR, { recursive: true })

function log(m) {
  const line = `${new Date().toISOString()} ${m}\n`
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1')
    fs.appendFileSync(LOG, line)
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line)
}

async function main() {
  const prev = readDaemonState()
  // 另一个宿主还在（state.mjs 的 hostProcess：进程在、真的是宿主 —— 认命令行，进程号会被别的程序复用；心跳旧了也算还在：
  // 笔记本睡醒那一下心跳是睡之前写的，宿主其实没死，看门狗正好那时补跑一次，不能再起一个；命令行查不了就退回去看心跳）
  if (prev?.pid && Number(prev.pid) !== process.pid && hostProcess(prev)) {
    console.error(`宿主已经在跑了（pid ${prev.pid}）。要重启：node host/cli.mjs restart`)
    process.exit(1)
  }
  const rt = runtimeStatus()
  if (!rt.ok) { log('✗ ' + rt.reason); console.error(rt.reason); process.exit(1) }
  // 生物钟 / 监听（lib/scheduler.js）会自己再找一遍 node，但不认宿主正在用的这个 ——
  // 在 PATH 里没有 node 的终端起宿主就起不来；把宿主验过的这个交给它（她的回合也是这么传的）
  if (!process.env.DSH_NODE) process.env.DSH_NODE = rt.file
  const cwd = ensureWorkDir()
  const claudeBin = findClaude(readConfig().claude?.path)
  if (!claudeBin) log('⚠️ 找不到 claude —— 生物钟照跑，但到点叫不醒她（装 Claude Code 或填 claude.path）')

  const controller = new ClaudeSessionController({ cwd, log })
  let sched = null
  let schedStatus = { ok: false, reason: '未初始化' }
  try {
    sched = startScheduler({ sessionController: controller }, {
      dshHome: DSH_HOME, biliMjs: BILI_MJS, cwd, sessionId: 'bili-whale', log,
      isBusy: () => controller.isBusy(),
    })
    schedStatus = { ok: true, reason: '已启动（每 60 秒 tick）' }
  } catch (e) {
    schedStatus = { ok: false, reason: String(e?.message ?? e).slice(0, 300) }
    log('✗ 生物钟没起来：' + schedStatus.reason)
  }

  // QQ 收主人的私聊（host/qq-listen.mjs）：按需加载 —— 文件缺了、加载出错、启动出错，都只留一行日志，宿主别的事照常
  // （出错信息先抹 token：里面可能带着网络 / 配置里来的字）
  // （2026-10-27 起经报到单 host/modules/qq.mjs 加载：报到单不在 = 没装 QQ 模块，什么都不说；报到单坏了只说错误的种类）
  let qq = null
  const qqMod = await loadModule('qq')
  if (qqMod.error) log('⚠️ QQ 收消息没起来：QQ 模块加载出错（' + qqMod.error + '）')
  else if (qqMod.mod && typeof qqMod.mod.startHost !== 'function') log('⚠️ QQ 收消息没起来：QQ 模块的报到单不完整（没有 startHost）')
  else if (qqMod.mod) {
    try {
      qq = await qqMod.mod.startHost({ controller, log, runBili, personaText: () => personaText(CFG_FILE), sessionId: 'bili-whale' })
    } catch (e) {
      // 抹 token 用模块自己的；报到单里没有就只说错误的种类，不给原话
      let why = [e?.name ?? 'Error', e?.code].filter(Boolean).join(' ')
      try { if (typeof qqMod.mod.scrub === 'function') why = qqMod.mod.scrub(String(e?.message ?? e), 200) } catch {}
      log('⚠️ QQ 收消息没起来：' + why)
    }
  }
  // 心跳里的 QQ 模式：状态读不出来也别耽误心跳（心跳没写成，面板会以为宿主停了）
  const qqMode = () => { try { return qq?.status()?.mode ?? null } catch { return null } }

  const startedAt = new Date().toISOString()
  const beat = () => {
    try {
      fs.writeFileSync(STATE, JSON.stringify({
        pid: process.pid, startedAt, heartbeat: new Date().toISOString(),
        scheduler: schedStatus, claude: claudeBin, node: rt.file, workDir: cwd, dataDir: DSH_HOME,
        busy: controller.isBusy(), running: controller.running?.id ?? null, queued: controller.queue.length,
        qq: qqMode(),
      }, null, 2) + '\n')
    } catch {}
  }
  beat()
  // start 起宿主时把启动锁交给了宿主（锁里写着这个进程号）：报到了就放掉，别的 start 不用再等、电脑重启后也不会留一把旧锁
  try { const lock = path.join(HOST_DIR, 'start.lock'); if (Number(fs.readFileSync(lock, 'utf8').trim()) === process.pid) fs.rmSync(lock, { force: true }) } catch {}

  // 配置一改就生效：只有作息相关的改动才重排今天的计划（和 DSH 版设置页一致）
  let cfgMtime = 0
  let lastNight = JSON.stringify(readConfig().night ?? {})
  try { cfgMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  const watchCfg = () => {
    let m = 0
    try { m = fs.statSync(CFG_FILE).mtimeMs } catch {}
    if (m === cfgMtime) return
    cfgMtime = m
    const night = readConfig().night ?? {}
    // 只有这几项会改醒来的时间 / 要不要醒；maxVideos 不算（醒的时候现读，改它不该重抽今晚的计划）
    const pick = (n) => JSON.stringify(['windows', 'skipChance', 'minGapMin'].map((k) => n?.[k]))
    const changed = pick(JSON.parse(lastNight)) !== pick(night)
    lastNight = JSON.stringify(night)
    try { ensureWorkDir() } catch {}
    try { sched?.invalidate(changed); log(`配置已重载${changed ? '（作息变了，重排今天的计划）' : ''}`) } catch (e) { log('重载失败：' + e.message) }
  }

  // B站 登录还有效吗：启动 20 秒后查一次，之后每小时一次。风控熔断中就不去碰 B站
  const loginCheck = () => runLoginCheck({ log, runBili })

  const timers = [
    ...scheduleLoginChecks(loginCheck, { firstMs: Number(process.env.BILI_WHALE_LOGIN_CHECK_FIRST_MS) > 0 ? Number(process.env.BILI_WHALE_LOGIN_CHECK_FIRST_MS) : 20_000 }),
    setInterval(beat, 30_000),
    setInterval(watchCfg, 5_000),
    setInterval(() => controller.kick(), 5_000),   // CLI 塞进队列的回合
  ]
  controller.kick()   // 上次没跑完的回合接着跑
  log(`宿主已启动 · pid ${process.pid} · 数据 ${DSH_HOME} · 她的家 ${cwd} · claude ${claudeBin ?? '（没找到）'}`)

  const shutdown = (sig) => {
    log(`收到 ${sig}，退出`)
    timers.forEach(clearInterval)
    try { sched?.stop() } catch {}
    try { Promise.resolve(qq?.stop()).catch(() => {}) } catch {}   // 收消息停下（关 WS、清定时器）；马上就退出了，不等它
    controller.stop()
    try { fs.writeFileSync(STATE, JSON.stringify({ ...readDaemonState(), pid: null, stoppedAt: new Date().toISOString() }, null, 2)) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (e) => log('未捕获异常（已兜住）：' + (e?.stack ?? e)))
  process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝（已兜住）：' + (e?.stack ?? e)))
}

main()
