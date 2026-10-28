// 模块解析钩子：谁 import tools/lib/webfetch.mjs，都拿到假的那一份
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context)
  if (r.url.endsWith('/tools/lib/webfetch.mjs')) return { ...r, url: new URL('./web-fake-fetch.mjs', import.meta.url).href, shortCircuit: true }
  return r
}
