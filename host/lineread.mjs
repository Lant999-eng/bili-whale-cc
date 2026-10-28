// 命令行里一行一行地问（扫码登录 / 手动填 cookie 时用）：管道 / 终端都行；读到头 = null。
//   · 管道（脚本 / 测试喂答案）：先到的行排队，不会因为还没开始问就丢掉
//   · 终端：问之前把之前随手敲的（扫码那几分钟里按的回车 / y，连同敲了一半没回车的）扔掉 —— 只认看到问题之后的回答（TERM=dumb 也一样）；
//     问题交给 readline 显示（退格不会把问题擦掉）
//   · 终端里按 Ctrl+C 时 readline 自己接住了，不会传给进程 —— 转给 onCancel；按 Ctrl+D（输入结束）之后再问，一律当没回答（null）
import readline from 'node:readline'

export function lineReader(onCancel, { input = process.stdin, output = process.stdout, tty = Boolean(input.isTTY), settleMs = 50 } = {}) {
  let rl = null, closed = false
  const queue = [], waiters = []
  const open = () => {
    if (rl || closed) return
    // 不留历史：这里只问 y/N 和凭据，上下键翻出之前敲的（比如问题出来前那个 y）只会坏事；粘贴的 cookie 也不留在内存里
    rl = readline.createInterface({ input, output, terminal: tty, prompt: '', historySize: 0 })
    rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)))
    rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null) })
    rl.on('SIGINT', () => onCancel?.())
  }
  return {
    // fresh:false —— 不扔掉之前敲的（一次粘贴好几行时，后面几行是下一个问题的回答）
    async ask(q, { fresh = true } = {}) {
      open()
      if (tty && fresh) {
        await new Promise((r) => setTimeout(r, settleMs))   // 让之前敲进缓冲区的先到，再一起扔掉
        queue.length = 0
        if (closed) { output.write(q + '\n'); return null }
        try {
          // 敲了一半没回车的也清掉：直接清 readline 的行缓冲区 —— 模拟 Ctrl+E / Ctrl+U 在 TERM=dumb 时不管用；清不掉就当没回答
          const stale = rl.line
          rl.line = ''; rl.cursor = 0
          if (rl.line !== '') return null
          if (stale && process.env.TERM === 'dumb') output.write('\n')   // dumb 终端擦不掉已经显示的字（readline 不重画）：换一行再问
          rl.setPrompt(q); rl.prompt()   // 普通终端：重画这一行，显示着的半行也擦掉
        } catch { return null }
      } else if (tty) {
        if (closed) { output.write(q + '\n'); return queue.length ? queue.shift() : null }
        try { rl.setPrompt(q); rl.prompt() } catch { return queue.length ? queue.shift() : null }
      } else output.write(q)
      if (queue.length) return queue.shift()
      if (closed) return null
      return new Promise((r) => waiters.push(r))
    },
    close() { closed = true; rl?.close() },
  }
}
