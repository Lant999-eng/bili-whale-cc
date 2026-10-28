// 命令行一行一行地问（host/lineread.mjs）：终端里问之前敲的（连同敲了一半没回车的 y）不算回答 ——
//   普通终端、TERM 没设、TERM=dumb（readline 换成简化的按键处理，Ctrl+E / Ctrl+U 不管用）都一样；
//   管道喂的答案排队不丢；一次粘贴好几行（fresh:false）后面的留给下一个问题
import test from 'node:test'
import assert from 'node:assert/strict'
import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import { lineReader } from '../host/lineread.mjs'

const ESC = String.fromCharCode(27)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// TERM 在建 readline 的时候读（dumb → 简化的按键处理），prompt() 显示问题时也读：整个用例期间都设着，结束还原
function withTerm(t, term) {
  const had = Object.hasOwn(process.env, 'TERM'), old = process.env.TERM
  if (term === undefined) delete process.env.TERM; else process.env.TERM = term
  t.after(() => { if (had) process.env.TERM = old; else delete process.env.TERM })
}
function reader(t, { tty, onCancel = null } = {}) {
  const input = new PassThrough(), output = new PassThrough()
  let out = ''
  output.setEncoding('utf8'); output.on('data', (d) => { out += d })
  const lr = lineReader(onCancel, { input, output, tty })
  t.after(() => lr.close())
  return { lr, input, out: () => out }
}

const TERMS = [['TERM 没设', undefined], ['TERM=xterm-256color', 'xterm-256color'], ['TERM=dumb', 'dumb']]

for (const [label, term] of TERMS) {
  test(`terminal (${label}): a half-typed y before the confirm question is dropped, so Enter alone is no; keys typed just before it too; Ctrl+C goes to onCancel; Ctrl+D means no answer`, async (t) => {
    withTerm(t, term)
    let cancelled = 0
    const { lr, input, out } = reader(t, { tty: true, onCancel: () => { cancelled += 1 } })
    let p = lr.ask('保存？[y/N] ')
    input.write('y')                                   // 扫码那几分钟里敲的 y，没回车
    await sleep(150)
    input.write('\r')                                  // 问题出来以后只按了回车
    assert.equal(await p, '')
    // 屏幕上：普通终端回到行首、清掉，再画问题（显示着的 y 擦掉）；dumb 终端擦不掉、也不能有控制字符 —— 换一行再问
    const shown = out(), before = shown.slice(0, shown.indexOf('保存？[y/N] '))
    if (term === 'dumb') {
      assert.ok(!shown.includes(ESC), JSON.stringify(shown))
      assert.equal(before, 'y\n')
    } else {
      assert.ok(before.startsWith('y') && before.endsWith(ESC + '[1G' + ESC + '[0J'), JSON.stringify(shown))
    }
    assert.ok(!shown.includes('保存？[y/N] y'), JSON.stringify(shown))
    // 敲了一半、光标还挪回去过（方向键）：一样扔掉
    p = lr.ask('Q2 ')
    input.write('yes' + ESC + '[D')
    await sleep(150)
    input.write('\r')
    assert.equal(await p, '')
    // 问题显示出来之前 10 毫秒敲的一整行：不算回答
    p = lr.ask('Q3 ')
    setTimeout(() => input.write('y\r'), 10)
    await sleep(150)
    input.write('n\r')
    assert.equal(await p, 'n')
    // Ctrl+C 转给 onCancel，之后照常回答
    p = lr.ask('Q4 ')
    await sleep(100)
    input.write(String.fromCharCode(3))
    await sleep(50)
    assert.equal(cancelled, 1)
    input.write('z\r')
    assert.equal(await p, 'z')
    // Ctrl+D（输入结束）：这一问和之后再问都当没回答
    p = lr.ask('Q5 ')
    await sleep(100)
    input.write(String.fromCharCode(4))
    assert.equal(await p, null)
    assert.equal(await lr.ask('Q6 '), null)
  })

  test(`terminal (${label}): pasted lines are kept for the next questions when asked with fresh:false, but a leftover line or half line is not taken as the confirmation`, async (t) => {
    withTerm(t, term)
    const { lr, input } = reader(t, { tty: true })
    const p = lr.ask('SESSDATA: ', { fresh: false })
    input.write('one\rtwo\ry\r')                        // 一次粘贴三行：最后多出来一个 y
    assert.equal(await p, 'one')
    assert.equal(await lr.ask('bili_jct: ', { fresh: false }), 'two')
    const c = lr.ask('保存？[y/N] ')
    input.write('y')                                   // 又敲了一半
    await sleep(150)
    input.write('\r')
    assert.equal(await c, '')
  })
}

for (const [label, term] of TERMS.filter(([, x]) => x !== 'dumb')) {
  test(`terminal (${label}): arrow keys cannot bring back what was typed before the question (no history)`, async (t) => {
    withTerm(t, term)
    const { lr, input } = reader(t, { tty: true })
    let p = lr.ask('再来一张？[y/N] ')
    await sleep(100)
    input.write('n\r')
    assert.equal(await p, 'n')
    p = lr.ask('保存？[y/N] ')
    input.write('y' + ESC + '[A')                      // 问题出来前：敲了 y、又按了上
    await sleep(150)
    input.write(ESC + '[B' + '\r')                     // 问题出来后：按下、回车
    assert.equal(await p, '')
    p = lr.ask('保存？[y/N] ')
    await sleep(100)
    input.write(ESC + '[A' + '\r')                     // 上一个回答也翻不出来
    assert.equal(await p, '')
  })
}

test('terminal: if the half-typed text cannot be cleared, the question counts as unanswered (null), never the leftover y', async (t) => {
  withTerm(t, 'xterm-256color')
  // 模拟哪天 readline 的行缓冲区清不掉：赋空字符串不生效
  const proto = readline.Interface.prototype
  Object.defineProperty(proto, 'line', { configurable: true, get() { return this._stuckLine ?? '' }, set(v) { if (v || this._stuckLine === undefined) this._stuckLine = v } })
  t.after(() => { delete proto.line })
  const { lr, input } = reader(t, { tty: true })
  const p = lr.ask('保存？[y/N] ')
  input.write('y')
  await sleep(150)
  input.write('\r')
  assert.equal(await p, null)
})

test('piped input (scripts / tests): answers fed before the question are kept in order, CRLF works, pasted lines stay queued, end of input means no answer; TERM does not matter', async (t) => {
  withTerm(t, 'dumb')
  const { lr, input, out } = reader(t, { tty: false })
  input.write('y\r\n')                                 // 问之前就喂好的答案（Windows 管道是 CRLF）
  await sleep(20)
  assert.equal(await lr.ask('保存？[y/N] '), 'y')
  const p = lr.ask('UID: ')
  input.write('44')                                    // 分两次到的一行
  await sleep(20)
  input.write('4\n')
  assert.equal(await p, '444')
  input.write('one\ntwo\n')
  assert.equal(await lr.ask('A ', { fresh: false }), 'one')
  assert.equal(await lr.ask('B '), 'two')
  input.end()
  assert.equal(await lr.ask('C '), null)
  assert.equal(out(), '保存？[y/N] UID: A B C ')         // 问题原样输出，没有控制字符
})
