// 一个可拔掉的模块有哪些文件（2026-10-28）：从它的报到单（host/modules/<名字>.mjs）开头的注释里读，不在测试里另抄一份 ——
//   「这一块的文件：」到「（清单到此）」为止（可以折行）；只写文件名的接着上一个带目录的写法（tools/lib/qq.mjs、qq-inbound.mjs …），
//   「tests/ 里 qq 开头的测试」= tests/qq*.test.mjs，helpers/… 在 tests/ 下面，「这张报到单」= 报到单自己。
//   报到单里写了、仓库里却没有的文件：抛错（说明清单旧了）。没装的模块（没有报到单，公开版就是这样）→ 空的一组
import fs from 'node:fs'
import path from 'node:path'

const END = '（清单到此）'
/** 只认仓库里面的相对路径：正斜杠、不带 . / .. 段、不是绝对路径 */
const safeRel = (p) => typeof p === 'string' && p !== '' && !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..')
/** dest 下面的 f 还在 dest 里面（删文件前再看一眼） */
const inside = (dest, f) => { const rel = path.relative(path.resolve(dest), path.resolve(dest, f)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) }

/** root = 项目根；返回相对 root 的路径（正斜杠、排好序、不重复） */
export function moduleFiles(root, name) {
  const manifest = `host/modules/${name}.mjs`
  let src
  try { src = fs.readFileSync(path.join(root, manifest), 'utf8') } catch (e) { if (e?.code === 'ENOENT') return []; throw e }
  const head = []
  for (const line of src.split(/\r?\n/)) {
    if (!line.startsWith('//')) break
    if (head.length || line.includes('这一块的文件：')) head.push(line.slice(2))
    if (head.length && line.includes(END)) break
  }
  // 清单可以折好几行，但必须以「（清单到此）」收尾：没写到就抛错，不会悄悄少删几个文件
  if (!head.length || !head.at(-1).includes(END)) throw new Error(`${manifest} 开头没有「这一块的文件：…${END}」`)
  const joined = head.join('\n')
  const text = joined.slice(joined.indexOf('这一块的文件：') + '这一块的文件：'.length, joined.indexOf(END))
  if (!text.includes('这张报到单')) throw new Error(`${manifest} 的清单里没有「这张报到单」`)
  const exists = (p) => fs.existsSync(path.join(root, p))
  const out = new Set()
  let dir = null
  for (const m of text.matchAll(/tests\/ 里 ([A-Za-z0-9_-]+) 开头的测试|这张报到单|[A-Za-z0-9_./-]+\.m?js/g)) {
    if (m[0] === '这张报到单') { out.add(manifest); continue }
    if (m[1]) {
      for (const f of fs.readdirSync(path.join(root, 'tests'))) if (f.startsWith(m[1]) && f.endsWith('.test.mjs')) out.add('tests/' + f)
      dir = 'tests'
      continue
    }
    let p
    if (!m[0].includes('/')) {
      if (!dir) throw new Error(`${manifest}：${m[0]} 前面没有带目录的文件`)
      p = dir + '/' + m[0]
    } else p = [m[0], dir === 'tests' ? 'tests/' + m[0] : null].find((x) => x && exists(x)) ?? m[0]
    if (!safeRel(p)) throw new Error(`${manifest} 里的 ${m[0]} 不是仓库里的相对路径（${p}）`)
    if (!exists(p)) throw new Error(`${manifest} 里写着 ${m[0]}，仓库里没有（${p}）：清单旧了`)
    out.add(p)
    dir = path.posix.dirname(p)
  }
  return [...out].sort()
}

/** 公开版要删掉的文件：两个模块（陌生人私信、QQ）的全部文件 */
export const PRIVATE_MODULES = ['sdm', 'qq']
export const privateModuleFiles = (root) => PRIVATE_MODULES.flatMap((n) => moduleFiles(root, n))

/** 把 root 抄到 dest（不抄 . 开头的东西、node_modules，skip 里的顶层目录也不抄），再删掉两个模块的文件 → 删掉的那些（相对路径） */
export function makePublicCopy(root, dest, { skip = [] } = {}) {
  const gone = privateModuleFiles(root)
  for (const e of fs.readdirSync(root)) {
    if (e.startsWith('.') || e === 'node_modules' || skip.includes(e)) continue
    fs.cpSync(path.join(root, e), path.join(dest, e), { recursive: true, filter: (f) => !path.basename(f).startsWith('.') && path.basename(f) !== 'node_modules' })
  }
  for (const f of gone) {
    if (!safeRel(f) || !inside(dest, f)) throw new Error(`要删的 ${f} 不在 ${dest} 里面`)
    fs.rmSync(path.join(dest, f), { force: true })
  }
  return gone
}
