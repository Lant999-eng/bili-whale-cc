// 开机自启 + 桌面按钮（2026-10-24）：电脑意外关机重启后宿主没起来 → 主人要「登录 Windows 后自动启动」和桌面上一个启动按钮。
// 两样都是主人账号下的文件（启动文件夹里的脚本、桌面上的快捷方式），都直接跑 node host/cli.mjs start（已经在跑就不动）。
// 宿主一律是假的（tests/helpers/fake-daemon.mjs：命令行和真宿主一样，只写心跳）；生成的脚本用 cscript //B 真的跑
// （不弹窗：开机自启那份去掉 30 秒的等待；按钮那份把弹框换成写文件）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const win = process.platform === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BOM = String.fromCharCode(0xfeff)
const alivePid = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function sandbox(t, { dirName = 'data', fake = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-auto-'))
  const dsh = path.join(home, dirName), appdata = path.join(home, 'Roaming'), desk = path.join(home, 'Desktop')
  for (const d of [dsh, appdata, desk, path.join(home, '.bili-ai')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(dsh, 'bili-whale.config.json'), JSON.stringify({ owner: { mid: '222', name: 'Owner' }, self: { mid: '333', name: 'Whale' }, notify: { type: 'none' } }))
  const mark = path.join(home, 'daemons.txt')
  const env = { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: dsh, DSH_NODE: process.execPath, APPDATA: appdata, BILI_WHALE_DESKTOP: desk,
    BILI_WHALE_CONFIG: path.join(dsh, 'bili-whale.config.json'), BILI_WHALE_STUDIO_VENV: path.join(home, 'no-venv'),
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'tests/helpers/fake-daemon.mjs')).href, FAKE_DAEMON_MARK: mark, FAKE_DAEMON_LIFE: '30000',
    // 计划任务一律是假的：哪个测试忘了设，也碰不到主人真的任务计划程序（真任务名只有一个，被测试改掉过一次）
    BILI_WHALE_FAKE_TASKS: path.join(home, 'tasks.json'),
    // 按钮还会开「她的小窗」+ 桌宠（window --with-pet）：测试里绝不开 Edge / 桌宠，小窗服务用沙盒自己的端口（别碰主人机器上开着的 8766）
    BILI_WHALE_WINDOW_NO_EDGE: '1', BILI_WHALE_WINDOW_PORT: String(20000 + Math.floor(Math.random() * 30000)),
    ...Object.fromEntries(Object.entries(fake).map(([k, v]) => [k, String(v)])) }
  delete env.BILI_WHALE_AGENT
  const startup = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bili-whale-cc.vbs')
  const hostDir = path.join(dsh, 'whale-cc')
  const daemons = () => { try { return fs.readFileSync(mark, 'utf8').trim().split('\n').filter(Boolean).map(Number) } catch { return [] } }
  t.after(async () => {   // 假宿主、按钮起的小窗服务都收掉，再删沙盒
    for (const pid of daemons()) try { process.kill(pid) } catch {}
    try { process.kill(JSON.parse(fs.readFileSync(path.join(hostDir, 'window.json'), 'utf8')).pid) } catch {}
    await sleep(300)
    fs.rmSync(home, { recursive: true, force: true })
  })
  /** 直接起一个假宿主（相当于宿主已经在跑），等它报到 */
  async function fakeHost(delay = 0) {
    const c = spawn(process.execPath, [path.join(root, 'host', 'daemon.mjs')], { env: { ...env, FAKE_DAEMON_DELAY: String(delay) }, stdio: 'ignore' })
    if (delay === 0) { const end = Date.now() + 15000; while (Date.now() < end && !fs.existsSync(path.join(hostDir, 'daemon.json'))) await sleep(100) }
    return c.pid
  }
  return { env, home, dsh, desk, startup, hostDir, daemons, fakeHost }
}
const cli = (s, ...args) => spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), ...args], { env: s.env, encoding: 'utf8', timeout: 90000 })
const cliAsync = (s, ...args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(root, 'host/cli.mjs'), ...args], { env: s.env })
  let out = ''
  c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
  c.on('exit', (code) => resolve({ code, out }))
})
const utf16 = (f) => { const b = fs.readFileSync(f); assert.deepEqual([b[0], b[1]], [0xff, 0xfe], 'UTF-16 BOM'); return b.subarray(2).toString('utf16le') }
const writeUtf16 = (f, text) => fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
/** 用 cscript //B（不弹任何框）跑一份脚本 */
const cscript = (file, env) => spawnSync('cscript.exe', ['//B', '//NoLogo', file], { env, encoding: 'utf8', timeout: 90000 })
async function waitFor(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200) } return fn() }

test('autostart on / status / off: a UTF-16 Startup script that (after 30 s) runs node directly — run for real it logs to autostart.log', { skip: !win && '只有 Windows', timeout: 180000 }, async (t) => {
  const s = sandbox(t)
  assert.match(cli(s, 'autostart', 'status').stdout, /开机自启：没开/)
  let r = cli(s, 'autostart', 'on')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /已加入开机自启/)
  const vbs = utf16(s.startup)
  assert.match(vbs, /WScript\.Sleep 30000/)
  assert.doesNotMatch(vbs, /cmd /)
  assert.ok(vbs.includes(`fso.FileExists("${process.execPath}")`), vbs)
  assert.match(vbs, /cli\.mjs"" start --autostart --log ""[^"]*autostart\.log""", 0, False/)
  assert.match(cli(s, 'autostart', 'status').stdout, /开机自启：开着/)
  // 真的跑一遍（去掉 30 秒等待）：宿主在跑 → 只记一句、不起第二个
  const host = await s.fakeHost()
  const quick = path.join(s.home, 'autostart-quick.vbs'); writeUtf16(quick, vbs.replace('WScript.Sleep 30000', ''))
  r = cscript(quick, s.env); assert.equal(r.status, 0, r.stdout + r.stderr)
  const logFile = path.join(s.hostDir, 'autostart.log')
  const log = await waitFor(() => { try { const x = fs.readFileSync(logFile, 'utf8'); return /已经在跑了/.test(x) && x } catch { return null } })
  assert.equal(log, `${log.split('\n')[0]}\n宿主已经在跑了（pid ${host}）\n`); assert.match(log, /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] 开机自启\n/)
  assert.deepEqual(s.daemons(), [host])
  // node 换过地方：脚本什么都不做（不报错、不弹框）；status 说旧了
  const moved = path.join(s.home, 'autostart-moved.vbs'); writeUtf16(moved, vbs.replace('WScript.Sleep 30000', '').split(process.execPath).join(path.join(s.home, 'gone', 'node.exe')))
  r = cscript(moved, s.env); assert.equal(r.status, 0, r.stdout + r.stderr)
  await sleep(1500); assert.equal(fs.readFileSync(logFile, 'utf8'), log)
  fs.writeFileSync(s.startup, 'old')
  assert.match(cli(s, 'autostart', 'status').stdout, /脚本是旧的/)
  assert.equal(cli(s, 'autostart', 'on').status, 0); assert.match(cli(s, 'autostart', 'status').stdout, /开机自启：开着/)
  assert.match(cli(s, 'autostart', 'off').stdout, /已取消开机自启/); assert.equal(fs.existsSync(s.startup), false)
  assert.match(cli(s, 'autostart', 'off').stdout, /本来就没开/)
  assert.equal(cli(s, 'autostart', 'bogus').status, 2)
  // APPDATA 设成空的：退回到 HOME\AppData\Roaming（不是写到当前目录）
  r = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'autostart', 'on'], { env: { ...s.env, APPDATA: '' }, cwd: s.home, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(fs.existsSync(path.join(s.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bili-whale-cc.vbs')))
  assert.equal(fs.existsSync(path.join(s.home, 'Microsoft')), false)
})

test('autostart / shortcut refuse paths with % (Windows would expand %NAME% and the script would look in the wrong place)', { skip: !win && '只有 Windows' }, (t) => {
  const s = sandbox(t, { dirName: 'a%OS%b' })
  let r = cli(s, 'autostart', 'on'); assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /路径里有 %/); assert.equal(fs.existsSync(s.startup), false)
  r = cli(s, 'shortcut', 'on', '--name', 'x'); assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /路径里有 %/)
  assert.equal(cli(s, 'shortcut', 'on', '--name', 'a%b').status, 2)
})

test('start --autostart --log / --out: what start says goes into the file (with a timestamp for autostart); already running changes nothing', { skip: !win && '只有 Windows', timeout: 60000 }, async (t) => {
  const s = sandbox(t)
  const host = await s.fakeHost()
  const log = path.join(s.home, 'a.log'), out = path.join(s.home, 'o.txt')
  fs.writeFileSync(log, 'earlier\n'); fs.writeFileSync(out, 'stale\n')
  let r = cli(s, 'start', '--autostart', '--log', log)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`^earlier\\n\\[\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\] 开机自启\\n宿主已经在跑了（pid ${host}）\\n$`))
  r = cli(s, 'start', '--out', out)
  assert.equal(fs.readFileSync(out, 'utf8'), r.stdout); assert.equal(r.stdout, `宿主已经在跑了（pid ${host}）\n`)
  assert.deepEqual(s.daemons(), [host]); assert.equal(fs.existsSync(path.join(s.hostDir, 'start.lock')), false)
})

test('start: a heartbeat from a process that is not the host (pid reused after a reboot) does not count — it starts the host', { skip: !win && '只有 Windows', timeout: 60000 }, (t) => {
  const s = sandbox(t)
  fs.mkdirSync(s.hostDir, { recursive: true })
  fs.writeFileSync(path.join(s.hostDir, 'daemon.json'), JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString() }))   // 心跳是新的，可进程是测试本身
  const r = cli(s, 'start')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /✓ 宿主已在后台启动（pid \d+）/)
  assert.equal(s.daemons().length, 1); assert.equal(fs.existsSync(path.join(s.hostDir, 'start.lock')), false)
})

test('start lock: two starts while the host is slow to report (cold boot) still give exactly one host; a lock left by a dead process does not block', { skip: !win && '只有 Windows', timeout: 120000 }, async (t) => {
  // 宿主 6.5 秒才报到（比以前 start 只等 5 秒还久）：两个 start 几乎同时来
  const s = sandbox(t, { fake: { FAKE_DAEMON_DELAY: 6500 } })
  const a = cliAsync(s, 'start'); await sleep(400); const b = cliAsync(s, 'start')
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(s.daemons().length, 1, ra.out + rb.out)
  assert.equal(ra.code, 0, ra.out); assert.match(ra.out, /✓ 宿主已在后台启动/)
  assert.equal(rb.code, 0, rb.out); assert.match(rb.out, /宿主已经在跑了/)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'start.lock')), false)
  // 有人正在起（锁里是一个活着的进程）：等它报到，自己不起
  const s2 = sandbox(t)
  const slow = await s2.fakeHost(1500)
  fs.mkdirSync(s2.hostDir, { recursive: true })
  fs.writeFileSync(path.join(s2.hostDir, 'start.lock'), String(slow))
  const rc = await cliAsync(s2, 'start')
  assert.equal(rc.code, 0, rc.out); assert.match(rc.out, new RegExp(`宿主已经在跑了（pid ${slow}）`))
  assert.deepEqual(s2.daemons(), [slow])
  // 上一个 start 崩了留下的锁（进程不在了）：不用等，直接起
  const s3 = sandbox(t)
  fs.mkdirSync(s3.hostDir, { recursive: true })
  let dead = 4000000; while (alivePid(dead)) dead += 4
  fs.writeFileSync(path.join(s3.hostDir, 'start.lock'), String(dead))
  const t0 = Date.now(); const rd = await cliAsync(s3, 'start')
  assert.equal(rd.code, 0, rd.out); assert.match(rd.out, /✓ 宿主已在后台启动/)
  assert.ok(Date.now() - t0 < 9000, `等了 ${Date.now() - t0} ms`)
  assert.equal(s3.daemons().length, 1); assert.equal(fs.existsSync(path.join(s3.hostDir, 'start.lock')), false)
})

test('shortcut on / status / off: desktop shortcut to wscript + UTF-16 launcher; run for real it shows what start said; renaming replaces the old shortcut; someone else\'s shortcut is not overwritten; failures are reported', { skip: !win && '只有 Windows', timeout: 240000 }, async (t) => {
  const s = sandbox(t)
  assert.match(cli(s, 'shortcut', 'status').stdout, /桌面按钮：没装/)
  let r = cli(s, 'shortcut', 'on', '--name', '测试 角色')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /桌面上放好了「测试 角色」/)
  const lnk = path.join(s.desk, '测试 角色.lnk'), launcher = path.join(s.hostDir, 'start-button.vbs')
  assert.ok(fs.existsSync(lnk))
  const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); $s.TargetPath; $s.Arguments; '[' + $s.IconLocation + ']'`], { encoding: 'utf8', timeout: 60000 })
  const [target, args, icon] = q.stdout.trim().split(/\r?\n/)
  assert.match(target, /wscript\.exe$/i); assert.equal(args, `"${launcher}"`)
  assert.equal(icon, '[,0]')   // 沙盒里没有工作室的 Python：用默认图标
  const vbs = utf16(launcher)
  assert.doesNotMatch(vbs, /cmd /)
  assert.match(vbs, /sh\.Popup txt, 8, "测试 角色", icon/)
  assert.match(cli(s, 'shortcut', 'status').stdout, /桌面按钮：装着/)
  // 真的跑一遍（弹框换成写文件）：宿主在跑 → start 退出码 0 → 再开「她的小窗」+ 桌宠（window --with-pet；沙盒里不开 Edge / 桌宠，
  // 只起沙盒自己端口上的小窗服务）→ 都好就不弹框（小窗出来了就是结果）；每次的结果文件用完就删
  assert.match(vbs, / window --with-pet --out /)
  const host = await s.fakeHost()
  const result = path.join(s.home, 'popup.txt')
  const asFile = (text) => text.replace(/^sh\.Popup txt, 8, .*$/m, `Set rs = CreateObject("ADODB.Stream"): rs.Type = 2: rs.Charset = "utf-8": rs.Open: rs.WriteText txt & "|" & code & "|" & icon: rs.SaveToFile "${result}", 2: rs.Close`)
  const quick = path.join(s.home, 'button-quick.vbs'); writeUtf16(quick, asFile(vbs))
  r = cscript(quick, s.env); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(fs.existsSync(result), false, '宿主和小窗都好：不弹框')
  const w = JSON.parse(fs.readFileSync(path.join(s.hostDir, 'window.json'), 'utf8'))
  assert.equal(w.port, Number(s.env.BILI_WHALE_WINDOW_PORT)); assert.ok(alivePid(w.pid), '小窗服务起来了')
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.hostDir, 'window-ctl.json'), 'utf8')).pet, true, '桌宠也记成开着')
  assert.deepEqual(fs.readdirSync(s.hostDir).filter((x) => /^start-button-\d+(-window)?\.txt$/.test(x)), [])
  assert.deepEqual(s.daemons(), [host])
  // 小窗没开出来（端口被别的程序占着）→ 弹框：宿主那句 + 小窗那句、警告图标、退出码不是 0
  assert.equal(cli(s, 'window', '--stop').status, 0)
  const busy = net.createServer(); await new Promise((ok) => busy.listen(Number(s.env.BILI_WHALE_WINDOW_PORT), '127.0.0.1', ok))
  try { r = cscript(quick, s.env) } finally { busy.close() }
  assert.match(fs.readFileSync(result, 'utf8').replace(BOM, ''), new RegExp(`^宿主已经在跑了（pid ${host}）\\n[\\s\\S]*小窗服务没起来[\\s\\S]*\\|1\\|48$`))
  fs.rmSync(result)
  assert.deepEqual(fs.readdirSync(s.hostDir).filter((x) => /^start-button-\d+(-window)?\.txt$/.test(x)), [])
  // node 换过地方：按钮提示重新装（这里换成写文件），不去跑
  const movedText = asFile(vbs).split(`fso.FileExists("${process.execPath}")`).join(`fso.FileExists("${path.join(s.home, 'gone', 'node.exe')}")`)
    .replace(/^ {2}sh\.Popup .*, 15, .*$/m, `  Set rs = CreateObject("ADODB.Stream"): rs.Type = 2: rs.Charset = "utf-8": rs.Open: rs.WriteText "moved": rs.SaveToFile "${result}", 2: rs.Close`)
  const moved = path.join(s.home, 'button-moved.vbs'); writeUtf16(moved, movedText)
  r = cscript(moved, s.env); assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.equal(fs.readFileSync(result, 'utf8').replace(BOM, ''), 'moved')
  // 脚本旧了 / 快捷方式被删了：status 说旧了
  writeUtf16(launcher, 'old'); assert.match(cli(s, 'shortcut', 'status').stdout, /装着，但/)
  assert.equal(cli(s, 'shortcut', 'on', '--name', '测试 角色').status, 0); assert.match(cli(s, 'shortcut', 'status').stdout, /桌面按钮：装着/)
  fs.rmSync(lnk); assert.match(cli(s, 'shortcut', 'status').stdout, /装着，但/)
  // 换名字：旧的快捷方式删掉，桌面上只剩新的
  assert.equal(cli(s, 'shortcut', 'on', '--name', '测试 角色').status, 0)
  r = cli(s, 'shortcut', 'on', '--name', 'TestBot'); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(fs.readdirSync(s.desk).sort(), ['TestBot.lnk'])
  // 桌面上已经有一个同名的、不是这个按钮建的：不盖（要盖加 --force）
  fs.writeFileSync(path.join(s.desk, '别人的.lnk'), 'not ours')
  r = cli(s, 'shortcut', 'on', '--name', '别人的'); assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /已经有一个「别人的\.lnk」了/)
  assert.equal(fs.readFileSync(path.join(s.desk, '别人的.lnk'), 'utf8'), 'not ours')
  assert.match(fs.readFileSync(path.join(s.hostDir, 'start-button.json'), 'utf8'), /TestBot\.lnk/)
  r = cli(s, 'shortcut', 'on', '--name', '别人的', '--force'); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(fs.readdirSync(s.desk).sort(), ['别人的.lnk'])
  // 建不成（桌面文件夹不在）：说清楚、退出码 1、状态不变
  r = spawnSync(process.execPath, [path.join(root, 'host/cli.mjs'), 'shortcut', 'on', '--name', '别的'], { env: { ...s.env, BILI_WHALE_DESKTOP: path.join(s.home, 'no-desktop') }, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /桌面快捷方式没建成：桌面文件夹不在/)
  assert.match(fs.readFileSync(path.join(s.hostDir, 'start-button.json'), 'utf8'), /别人的\.lnk/)
  for (const bad of [['--name'], ['--name', 'a/b'], ['--name', '--force'], ['--name', 'x'.repeat(31)]]) assert.equal(cli(s, 'shortcut', 'on', ...bad).status, 2, bad.join(' '))
  // 记录坏了：status 说旧了；off 删掉脚本，并说清楚桌面上的要手动删
  fs.writeFileSync(path.join(s.hostDir, 'start-button.json'), '{')
  assert.match(cli(s, 'shortcut', 'status').stdout, /装着，但/)
  assert.match(cli(s, 'shortcut', 'off').stdout, /记录不见了 \/ 坏了.*手动删掉/)
  assert.equal(fs.existsSync(launcher), false)
  // 正常的 off
  fs.rmSync(path.join(s.desk, '别人的.lnk'))
  assert.equal(cli(s, 'shortcut', 'on', '--name', '测试角色').status, 0)
  r = cli(s, 'shortcut', 'off'); assert.match(r.stdout, /已删掉桌面上的「测试角色」/)
  assert.deepEqual(fs.readdirSync(s.desk), [])
  for (const f of ['start-button.vbs', 'start-button.json']) assert.equal(fs.existsSync(path.join(s.hostDir, f)), false, f)
  assert.match(cli(s, 'shortcut', 'status').stdout, /桌面按钮：没装/)
  assert.equal(cli(s, 'shortcut', 'bogus').status, 2)
})

// ─── 看门狗：计划任务每 15 分钟跑 start --watchdog；你 stop 过就不拉 ───
test('watchdog on / status / off: a UTF-16 script + a per-user scheduled task (every 15 min, only while logged on, also on battery) — faked here, the real Task Scheduler is not touched', { skip: !win && '只有 Windows', timeout: 120000 }, (t) => {
  const s = sandbox(t)
  const tasks = path.join(s.home, 'tasks.json')
  s.env.BILI_WHALE_FAKE_TASKS = tasks
  assert.match(cli(s, 'watchdog', 'status').stdout, /看门狗：没开/)
  let r = cli(s, 'watchdog', 'on')
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /看门狗开了/)
  const vbs = utf16(path.join(s.hostDir, 'watchdog.vbs'))
  assert.doesNotMatch(vbs, /cmd |Popup|Sleep/)
  assert.ok(vbs.includes(`fso.FileExists("${process.execPath}")`), vbs)
  assert.match(vbs, /cli\.mjs"" start --watchdog --log ""[^"]*autostart\.log""", 0, False/)
  const ps = JSON.parse(fs.readFileSync(tasks, 'utf8')).script
  const args = `//B //NoLogo "${path.join(s.hostDir, 'watchdog.vbs')}"`   // //B：找不到脚本、脚本出错都不弹框
  for (const want of ["-TaskName 'bili-whale-cc-watchdog'", '-RepetitionInterval (New-TimeSpan -Minutes 15)', '-LogonType Interactive', '-RunLevel Limited', '-AllowStartIfOnBatteries', '-DontStopIfGoingOnBatteries', '-MultipleInstances IgnoreNew', '-Priority 5', 'wscript.exe', `-Argument '${args}'`]) assert.ok(ps.includes(want), want)
  assert.match(cli(s, 'watchdog', 'status').stdout, /看门狗：开着（每 15 分钟/)
  fs.writeFileSync(tasks, JSON.stringify({ state: 'Disabled', args })); assert.match(cli(s, 'watchdog', 'status').stdout, /被禁用了/)
  fs.writeFileSync(tasks, JSON.stringify({ state: 'Ready', args })); writeUtf16(path.join(s.hostDir, 'watchdog.vbs'), 'old'); assert.match(cli(s, 'watchdog', 'status').stdout, /脚本是旧的/)
  assert.equal(cli(s, 'watchdog', 'on').status, 0)
  fs.rmSync(path.join(s.hostDir, 'watchdog.vbs')); assert.match(cli(s, 'watchdog', 'status').stdout, /计划任务在、脚本不见了/)
  assert.equal(cli(s, 'watchdog', 'on').status, 0)
  // 计划任务被别的安装 / 测试改成了跑别处的脚本：status 说出来；off 不删（要删加 --force）
  const elsewhere = '//B //NoLogo "C:\\somewhere\\else\\watchdog.vbs"'
  fs.writeFileSync(tasks, JSON.stringify({ state: 'Ready', args: elsewhere }))
  assert.match(cli(s, 'watchdog', 'status').stdout, /跑的不是这个安装的脚本/)
  r = cli(s, 'watchdog', 'off'); assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /没删。确定要删：watchdog off --force/)
  assert.equal(JSON.parse(fs.readFileSync(tasks, 'utf8')).args, elsewhere); assert.ok(fs.existsSync(path.join(s.hostDir, 'watchdog.vbs')))
  r = cli(s, 'watchdog', 'off', '--force'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /看门狗关了/)
  assert.equal(cli(s, 'watchdog', 'on').status, 0)
  r = cli(s, 'watchdog', 'off'); assert.equal(r.status, 0); assert.match(r.stdout, /看门狗关了/)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'watchdog.vbs')), false); assert.deepEqual(JSON.parse(fs.readFileSync(tasks, 'utf8')), {})
  assert.match(cli(s, 'watchdog', 'status').stdout, /看门狗：没开/)
  assert.equal(cli(s, 'watchdog', 'bogus').status, 2)
  const p = sandbox(t, { dirName: 'a%OS%b' }); p.env.BILI_WHALE_FAKE_TASKS = path.join(p.home, 'tasks.json')
  r = cli(p, 'watchdog', 'on'); assert.equal(r.status, 2); assert.match(r.stdout, /路径里有 %/)
})

test('start --watchdog: host running → nothing (not even a log line); host down → starts it and logs; you stopped it → leaves it; any normal start clears your stop', { skip: !win && '只有 Windows', timeout: 180000 }, async (t) => {
  const s = sandbox(t)
  const log = path.join(s.hostDir, 'autostart.log')
  const wd = () => cli(s, 'start', '--watchdog', '--log', log)
  const logText = () => { try { return fs.readFileSync(log, 'utf8') } catch { return '' } }
  // 宿主在跑：什么都不做、不记
  const host = await s.fakeHost()
  let r = wd(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.stdout, ''); assert.equal(logText(), '')
  // 你 stop：记号写下，宿主停了；看门狗不拉、不记
  r = cli(s, 'stop'); assert.equal(r.status, 0, r.stdout + r.stderr)
  await waitFor(() => !alivePid(host)); assert.equal(alivePid(host), false)
  assert.ok(fs.existsSync(path.join(s.hostDir, 'stopped-by-owner.json')))
  assert.match(cli(s, 'status').stdout, /是你 stop 的（[^）]+）（start 或双击桌面按钮就起来）/)   // 这个沙盒没开看门狗：不提它
  r = wd(); assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(logText(), ''); assert.deepEqual(s.daemons(), [host])
  // 正常的 start（这里是手动；双击按钮、开机自启、restart 一样）：记号作废
  r = cli(s, 'start'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /✓ 宿主已在后台启动/)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'stopped-by-owner.json')), false)
  const second = s.daemons()[1]
  // 宿主自己没了（崩了 / 被结束）、你没 stop 过：看门狗拉起来、记一笔
  process.kill(second); await waitFor(() => !alivePid(second))
  fs.writeFileSync(path.join(s.hostDir, 'daemon.json'), JSON.stringify({ pid: second, heartbeat: new Date(Date.now() - 5 * 60_000).toISOString() }))
  r = wd(); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(logText(), /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] 看门狗：宿主没在跑，拉起来\n✓ 宿主已在后台启动（pid \d+）/)
  assert.equal(s.daemons().length, 3)
  // restart：中间写了记号、最后 start 又清掉；不打「看门狗不会拉」那句
  fs.writeFileSync(path.join(s.hostDir, 'watchdog.vbs'), 'x')
  assert.match(cli(s, 'stop').stdout, /记下了是你停的/)
  r = cli(s, 'restart'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /记下了是你停的/)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'stopped-by-owner.json')), false)
})

test('start --watchdog: when the host keeps failing to start, it gives up after 4 tries (no endless log) until you start it by hand', { skip: !win && '只有 Windows', timeout: 180000 }, async (t) => {
  const s = sandbox(t, { fake: { FAKE_DAEMON_CRASH: 1 } })
  const log = path.join(s.hostDir, 'autostart.log')
  fs.mkdirSync(s.hostDir, { recursive: true })
  for (let i = 1; i <= 4; i += 1) {
    const r = cli(s, 'start', '--watchdog', '--log', log); assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.hostDir, 'watchdog.json'), 'utf8')).fails, i)
  }
  assert.match(fs.readFileSync(log, 'utf8'), /连着 4 次没拉起来，先不试了/)
  const before = fs.readFileSync(log, 'utf8'), tries = s.daemons().length
  let r = cli(s, 'start', '--watchdog', '--log', log); assert.equal(r.status, 0); assert.equal(r.stdout, '')
  assert.equal(fs.readFileSync(log, 'utf8'), before); assert.equal(s.daemons().length, tries)
  s.env.BILI_WHALE_FAKE_TASKS = path.join(s.home, 'tasks.json')
  assert.match(cli(s, 'watchdog', 'status').stdout, /连着 4 次没把宿主拉起来，先不试了/)
  // 你手动 start（修好了）：计数清零，看门狗恢复
  delete s.env.FAKE_DAEMON_CRASH
  r = cli(s, 'start'); assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(fs.existsSync(path.join(s.hostDir, 'watchdog.json')), false)
})

test('watchdog script run for real (cscript //B, no window): host down → started and logged; you stopped it → nothing', { skip: !win && '只有 Windows', timeout: 180000 }, async (t) => {
  const s = sandbox(t)
  s.env.BILI_WHALE_FAKE_TASKS = path.join(s.home, 'tasks.json')
  assert.equal(cli(s, 'watchdog', 'on').status, 0)
  const vbs = path.join(s.hostDir, 'watchdog.vbs'), log = path.join(s.hostDir, 'autostart.log')
  let r = cscript(vbs, s.env); assert.equal(r.status, 0, r.stdout + r.stderr)
  const got = await waitFor(() => { try { const x = fs.readFileSync(log, 'utf8'); return /✓ 宿主已在后台启动/.test(x) && x } catch { return null } }, 30000)
  assert.match(got || '', /看门狗：宿主没在跑，拉起来\n✓ 宿主已在后台启动（pid \d+）/)
  assert.equal(s.daemons().length, 1)
  assert.equal(cli(s, 'stop').status, 0); await waitFor(() => !alivePid(s.daemons()[0]))
  const before = fs.readFileSync(log, 'utf8')
  r = cscript(vbs, s.env); assert.equal(r.status, 0); await sleep(4000)
  assert.equal(fs.readFileSync(log, 'utf8'), before); assert.equal(s.daemons().length, 1)
})

test('start --watchdog right after the laptop wakes up: the host is alive but its heartbeat is old — it must not start a second host', { skip: !win && '只有 Windows', timeout: 60000 }, async (t) => {
  const s = sandbox(t)
  const host = await s.fakeHost(60000)   // 这个假宿主 60 秒内不写心跳（像是刚睡醒）
  fs.mkdirSync(s.hostDir, { recursive: true })
  fs.writeFileSync(path.join(s.hostDir, 'daemon.json'), JSON.stringify({ pid: host, heartbeat: new Date(Date.now() - 10 * 60_000).toISOString() }))
  const log = path.join(s.hostDir, 'autostart.log')
  let r = cli(s, 'start', '--watchdog', '--log', log)
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.stdout, '')
  r = cli(s, 'start'); assert.equal(r.status, 0); assert.match(r.stdout, new RegExp(`宿主进程在（pid ${host}），但心跳停了 10 分钟 —— 可能卡住了：node host/cli.mjs restart`))
  assert.match(cli(s, 'status').stdout, new RegExp(`宿主：进程在（pid ${host}），但心跳停了 10 分钟 —— 卡住了？`))
  assert.deepEqual(s.daemons(), [host])
})

test('stop while a watchdog start is in flight: stop waits for it and then stops that host too — no host left running, your stop is kept', { skip: !win && '只有 Windows', timeout: 120000 }, async (t) => {
  const s = sandbox(t, { fake: { FAKE_DAEMON_DELAY: 3000 } })   // 宿主 3 秒才报到
  fs.mkdirSync(s.hostDir, { recursive: true })
  const log = path.join(s.hostDir, 'autostart.log')
  const wd = cliAsync(s, 'start', '--watchdog', '--log', log)
  await waitFor(() => s.daemons().length === 1, 10000)   // 看门狗已经把宿主起了、宿主还没报到
  const st = await cliAsync(s, 'stop')
  assert.equal(st.code, 0, st.out); assert.match(st.out, /有一个启动正在进行：等它完了再停/)
  await wd
  const host = s.daemons()[0]
  await waitFor(() => !alivePid(host), 10000)
  assert.equal(alivePid(host), false, '看门狗起的那个宿主也停了')
  assert.ok(fs.existsSync(path.join(s.hostDir, 'stopped-by-owner.json')))
  // 之后看门狗不拉
  const r = cli(s, 'start', '--watchdog', '--log', log); assert.equal(r.stdout, ''); assert.equal(s.daemons().length, 1)
})

test('start lock: a lock older than 60 s does not count even if its pid is alive (pid reused after a reboot)', { skip: !win && '只有 Windows', timeout: 60000 }, async (t) => {
  const s = sandbox(t)
  fs.mkdirSync(s.hostDir, { recursive: true })
  const lock = path.join(s.hostDir, 'start.lock')
  fs.writeFileSync(lock, String(process.pid))   // 进程在（就是测试自己），但锁是两分钟前的
  const old = new Date(Date.now() - 120_000); fs.utimesSync(lock, old, old)
  const t0 = Date.now(); const r = await cliAsync(s, 'start')
  assert.equal(r.code, 0, r.out); assert.match(r.out, /✓ 宿主已在后台启动/)
  assert.ok(Date.now() - t0 < 9000, `等了 ${Date.now() - t0} ms`)
  assert.equal(s.daemons().length, 1); assert.equal(fs.existsSync(lock), false)
})

test('start: if the process identity cannot be checked (PowerShell / WMI failing), a fresh heartbeat still counts — no second host', { skip: !win && '只有 Windows', timeout: 60000 }, async (t) => {
  const s = sandbox(t)
  const host = await s.fakeHost()
  s.env.BILI_WHALE_FAKE_CMDLINE_FAIL = '1'
  const r = cli(s, 'start'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, new RegExp(`宿主已经在跑了（pid ${host}）`))
  assert.deepEqual(s.daemons(), [host])
})

test('status: "you stopped it" shows local time, and only mentions the watchdog when it is on', { skip: !win && '只有 Windows', timeout: 60000 }, (t) => {
  const s = sandbox(t)
  assert.equal(cli(s, 'stop').status, 0)
  let out = cli(s, 'status').stdout
  assert.match(out, /是你 stop 的（\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}）（start 或双击桌面按钮就起来）/)
  assert.doesNotMatch(out, /看门狗/)
  assert.equal(cli(s, 'watchdog', 'on').status, 0)
  out = cli(s, 'status').stdout
  assert.match(out, /是你 stop 的（[^）]+）：看门狗不会拉/)
})
