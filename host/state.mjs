/** 宿主进程的状态文件（daemon 写，CLI 读） */
import './env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_DIR } from './core.mjs'
import { cmdLineChecked } from '../tools/lib/filelock.mjs'

export const STATE = path.join(HOST_DIR, 'daemon.json')

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(Number(pid), 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function readDaemonState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null }
}

/** 宿主还活着吗：pid 在 + 心跳 2 分钟内 */
export function daemonAlive(st = readDaemonState()) {
  return Boolean(st && pidAlive(st.pid) && Date.now() - new Date(st.heartbeat ?? 0).getTime() < 120_000)
}

/**
 * daemon.json 里那个宿主进程还在吗 —— 要不要再起一个、看门狗要不要拉，都看这个（不看心跳新不新：笔记本睡醒那一下，
 * 心跳是睡之前写的，宿主其实还在）：
 *   · 进程在、命令行是 host/daemon.mjs（进程号会被别的程序复用：比如电脑刚重启过）→ { st, hung, staleMin }
 *     hung = 进程在、心跳却停了 2 分钟以上（卡住了？刚睡醒的话半分钟内会恢复）
 *   · 命令行查不了（PowerShell / WMI 出错）→ 退回去看心跳：2 分钟内 → 算在；不然 null
 *   · 别的 → null
 */
export function hostProcess(st = readDaemonState()) {
  if (!st?.pid || !pidAlive(st.pid)) return null
  const fresh = daemonAlive(st)
  const cmd = cmdLineChecked(st.pid)
  if (cmd === null) return fresh ? { st, hung: false, staleMin: 0 } : null
  if (!/host[\\/]daemon\.mjs/.test(cmd)) return null
  return { st, hung: !fresh, staleMin: fresh ? 0 : Math.round((Date.now() - new Date(st.heartbeat ?? 0).getTime()) / 60_000) }
}

