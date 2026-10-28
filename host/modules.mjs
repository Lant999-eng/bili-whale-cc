// 可拔掉的模块（2026-10-27）：QQ、陌生人私信。每个模块在 host/modules/<名字>.mjs 有一张报到单，宿主、cli 启动时找它：
//   · 找不到报到单 = 没装（公开版就是这样）：什么都不说，命令、体检、帮助里都没有它
//   · 找到了但加载出错 = 装坏了：照旧要报出来。出错信息可能带着配置、网络来的字（token 之类），这里只给错误的种类和代码，不给原话
// 安全上的事不交给模块：陌生人私信回合的权限收紧、队列里剩下的这两种回合怎么处理，都写死在核心里（模块不在也照样收紧）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modules')
/** 顺序有用：体检里先陌生人私信、后 QQ（和拆开之前一样）；读书（2026-10-28）排最后 */
export const MODULE_NAMES = ['sdm', 'qq', 'web']
export const moduleInstalled = (name) => MODULE_NAMES.includes(name) && fs.existsSync(path.join(DIR, name + '.mjs'))

/**
 * 模块的一个钩子文件（设置、面板、实时画面、定时任务这些核心要调用的小文件）：模块没装 → null；装了 → import（出错就抛，和以前静态引用出错一样）。
 * rel 相对 host/（'qq-panel.mjs'、'../lib/sdm-ticker.mjs'）。钩子文件不引用核心的宿主文件、也不引用报到单（顶层 await 遇到循环引用会卡死）
 */
export async function optionalHook(name, rel) {
  if (!moduleInstalled(name)) return null
  return import(pathToFileURL(path.join(path.dirname(DIR), rel)).href)
}

const loaded = new Map()
/** → { mod }（装了）| { mod: null }（没装）| { mod: null, error }（装坏了：只有错误的种类和代码） */
export async function loadModule(name) {
  if (!loaded.has(name)) {
    loaded.set(name, moduleInstalled(name)
      ? import(pathToFileURL(path.join(DIR, name + '.mjs')).href).then((mod) => ({ mod }), (e) => ({ mod: null, error: [e?.name ?? 'Error', e?.code].filter(Boolean).join(' ') }))
      : Promise.resolve({ mod: null }))
  }
  return loaded.get(name)
}
