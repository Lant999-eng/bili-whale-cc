// 跨进程的文件锁（独占创建一个 .lock 文件）—— 审片队列、发言账本这类「读整个文件 → 改 → 写回」都要先拿它。
//   · 拿锁：fs.openSync(file, 'wx')，谁先建成谁拿到；锁里写 { pid, at, token }
//   · 等锁：每 150ms 再试，最多 waitMs，等不到就抛错（调用方据此拒绝，不会两边同时改）
//   · 陈旧锁：拿锁的进程已经不在了、或者锁超过 staleMs → 清掉再抢（空文件 = 别人刚建还没写完，给它 5 秒）。
//     清掉别人的锁只在「回收锁」<file>.reclaim 里做，删之前再读一遍、还是刚才判断过期的那一把才删 ——
//     两个进程同时判断旧锁过期：A 删掉旧锁、拿到新锁之后，B 再进来读到的是 A 的新锁，不会删
//   · 放锁：锁里记着拿锁时的 token，只删 token 对得上的那一把（不会把别人的锁当成自己的放掉）
// 只给同步的 fn 用：锁住的那一段里不要有网络请求（要等网络的，用「预留 → 落账」两步，见 quota.mjs reserve）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
export const pidAlive = (pid) => {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/** 进程的程序名（查不到返回 ''） */
export function procName(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      return (String(r.stdout).match(/^"([^"]+)"/m) ?? [])[1] ?? ''
    }
    return String(spawnSync('ps', ['-p', String(Number(pid)), '-o', 'comm='], { encoding: 'utf8', timeout: 10_000 }).stdout).trim()
  } catch { return '' }
}

/**
 * 进程的完整命令行（查不到返回 ''）—— 用来确认「这个进程号还是不是当初那个进程」：进程号会被系统复用，
 * 光看进程号在不在、程序名像不像，可能会把别的程序（甚至整棵进程树）当成自己的去结束掉
 */
export function cmdLine(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
      return String(r.stdout ?? '').trim()
    }
    return String(spawnSync('ps', ['-p', String(Number(pid)), '-o', 'args='], { encoding: 'utf8', timeout: 10_000 }).stdout).trim()
  } catch { return '' }
}

/**
 * 同 cmdLine，但分得清「查不了」（PowerShell / WMI 出错、超时 → null）和「查到了：没有这个进程 / 不是它」（''、别的命令行）。
 * 判断「宿主是不是还在」时用它：查不了的时候不能当成「没有宿主」（会起出第二个），调用方退回去看心跳
 */
export function cmdLineChecked(pid) {
  if (process.env.BILI_WHALE_FAKE_CMDLINE_FAIL === '1') return null   // 测试用：装作查不了
  try {
    if (process.platform === 'win32') {
      const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
      const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.CommandLine } else { '' }`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
      if (r.error || r.signal || r.status !== 0) return null
      return String(r.stdout ?? '').trim()
    }
    const r = spawnSync('ps', ['-p', String(Number(pid)), '-o', 'args='], { encoding: 'utf8', timeout: 10_000 })
    if (r.error || r.signal) return null
    return String(r.stdout ?? '').trim()   // ps 找不到这个进程时退出码是 1、输出是空的：算「查到了，没有」
  } catch { return null }
}

/**
 * 临时文件改名成正式文件。Windows 上目标文件正被别的进程读着（哪怕只是 readFileSync 那几十微秒）改名会 EPERM / EBUSY：
 * 短暂重试；最后还是不行就删掉临时文件、抛错（不留一地 .tmp）
 */
export function renameRetry(tmp, file) {
  for (let i = 0; ; i += 1) {
    try { fs.renameSync(tmp, file); return } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e?.code) || i >= 40) {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        throw e
      }
      sleepMs(25)
    }
  }
}

/** 原子写：先写临时文件再改名 —— 别的进程读到的要么是旧的、要么是新的，不会读到写了一半的（以前读到半个文件会当成空账本） */
export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  renameRetry(tmp, file)
}

/**
 * 在锁里「读 → 改 → 原子写回」一个 JSON 账本。fn(cur) 返回新内容（返回 undefined = 就地改了 cur）。
 * 文件存在但读不出来 = 状态未知 → 抛错，不覆盖（以前读坏了就当空账本写回去，30 天的记录全没了）
 */
export function updateJsonLocked(file, fn, dflt = {}) {
  return withFileLock(file + '.lock', () => {
    let cur
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (e) {   // 记事本存的带 BOM
      if (fs.existsSync(file)) throw new Error(`${path.basename(file)} 读不出来（${e?.code ?? 'JSON 坏了'}），没改 —— 请主人看一下`)
      cur = structuredClone(dflt)
    }
    const next = fn(cur) ?? cur
    writeJsonAtomic(file, next)
    return next
  })
}

// Windows：另一个进程正在删这个名字时，独占新建同名文件报的是 EPERM / EACCES / EBUSY，不是 EEXIST —— 当成「占着」，等一下再试
const createBusy = (e) => process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)
// 回收一把锁只要几毫秒：回收锁超过这么久还在 = 拿它的进程卡死 / 崩了（它的进程号可能已经被别的程序复用，光看进程号会一直以为它还活着）
const RECLAIM_MAX_MS = 30_000

export function withFileLock(file, fn, { waitMs = 120_000, staleMs = 15 * 60_000, busy = '正被另一个进程占着，稍后再试' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  const t0 = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }))
      fs.closeSync(fd)
      break
    } catch (e) {
      if (e?.code !== 'EEXIST' && !createBusy(e)) throw e
      const seen = e?.code === 'EEXIST' ? peekLock(file) : null
      if (!seen) {                                           // 刚好被释放 / 正在被删 / 读不了（比如那里是个目录）：等一下再抢，同样有期限
        if (Date.now() - t0 > waitMs) throw new Error(busy)
        sleepMs(20)
        continue
      }
      const stale = lockStale(seen, staleMs)
      if (stale) reclaimStale(file, seen.raw, staleMs)
      if (Date.now() - t0 > waitMs) throw new Error(busy)   // 回收锁一直被占着也有个头
      if (stale) continue
      sleepMs(150)
    }
  }
  try { return fn() } finally { releaseOwn(file, token) }
}

/** 读一把锁：{ raw, cur（解析不了 = null）, age }；文件已经没了 / 读不了返回 null */
function peekLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    let cur = null
    try { cur = JSON.parse(raw) } catch {}
    return { raw, cur, age: Date.now() - fs.statSync(file).mtimeMs }
  } catch { return null }
}
const lockStale = ({ cur, age }, staleMs) => cur ? (!pidAlive(cur.pid) || Date.now() - Number(cur.at) > staleMs) : age > 5000

/**
 * 回收一把判断为过期的锁（raw = 判断时读到的内容）。所有回收都先拿回收锁 <file>.reclaim，在里面再读一遍：
 * 还是那一把、而且仍然过期才删。回收锁的主人不在了（进程没了，或者拿着它超过 RECLAIM_MAX_MS）才清它，见 removeDead
 */
function reclaimStale(file, raw, staleMs) {
  const rl = file + '.reclaim'
  const me = JSON.stringify({ pid: process.pid, at: Date.now(), token: crypto.randomBytes(6).toString('hex') })
  try {
    const fd = fs.openSync(rl, 'wx')
    fs.writeSync(fd, me)
    fs.closeSync(fd)
  } catch (e) {
    if (e?.code !== 'EEXIST' && !createBusy(e)) throw e
    const other = e?.code === 'EEXIST' ? peekLock(rl) : null
    const dead = other && (other.cur ? (!pidAlive(other.cur.pid) || Date.now() - Number(other.cur.at) > RECLAIM_MAX_MS) : other.age > 5000)
    if (dead) removeDead(rl, other.raw)
    else sleepMs(50)
    return
  }
  try {
    const now = peekLock(file)
    if (now && now.raw === raw && lockStale(now, staleMs)) fs.rmSync(file, { force: true })
  } finally {
    try { if (fs.readFileSync(rl, 'utf8') === me) fs.rmSync(rl, { force: true }) } catch {}
  }
}

/**
 * 清掉一把判断为「主人已经不在」的回收锁（deadRaw = 判断时读到的内容）。不按路径直接删 ——
 * 先改名挪到一个只有自己知道的名字（原子操作，几个进程同时来只有一个挪得走），挪走的确实是判断过的那一把才删；
 * 挪走的不是它（在这之间它已经被别人清掉、又有人新建了一把）就原样放回去，不会删掉别人刚建的回收锁
 */
function removeDead(rl, deadRaw) {
  const moved = `${rl}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.dead`
  try { fs.renameSync(rl, moved) } catch { return }
  let got = null
  try { got = fs.readFileSync(moved, 'utf8') } catch {}
  if (got !== deadRaw) { try { fs.linkSync(moved, rl) } catch {} }
  try { fs.rmSync(moved, { force: true }) } catch {}
}

/** 放锁：只删 token 是自己的那一把（锁已经被当成过期回收、换成了别人的，就不动） */
function releaseOwn(file, token) {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cur?.token === token) fs.rmSync(file, { force: true })
  } catch {}
}
