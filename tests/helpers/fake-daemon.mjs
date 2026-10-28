// 测试用：NODE_OPTIONS=--import 这个文件。冒充 host/daemon.mjs（真宿主的代码一行都不跑）：
//   命令行和真宿主一样（node …/host/daemon.mjs），所以 start 的「这个进程真的是宿主」那一关认它；
//   FAKE_DAEMON_DELAY 毫秒以后写 daemon.json 报到，之后每秒刷新心跳；FAKE_DAEMON_LIFE 毫秒以后自己退出；
//   每起一个就往 FAKE_DAEMON_MARK 里记一行进程号（测试数一共起了几个宿主）；FAKE_DAEMON_CRASH=1 = 一启动就退出。别的 node 进程里它什么都不做
import fs from 'node:fs'
import path from 'node:path'

if (/host[\\/]daemon\.mjs$/.test(process.argv[1] ?? '')) {
  const dir = path.join(process.env.DSH_HOME, 'whale-cc')
  fs.mkdirSync(dir, { recursive: true })
  if (process.env.FAKE_DAEMON_MARK) fs.appendFileSync(process.env.FAKE_DAEMON_MARK, process.pid + '\n')
  if (process.env.FAKE_DAEMON_CRASH === '1') process.exit(1)   // 起不来（比如配置坏了）：一启动就退出、不报到
  const beat = () => fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString(), scheduler: { ok: true, reason: 'fake' } }))
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DAEMON_DELAY ?? 0)))
  beat()
  const iv = setInterval(beat, 1000)
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DAEMON_LIFE ?? 30000)))
  clearInterval(iv)
  process.exit(0)
}
