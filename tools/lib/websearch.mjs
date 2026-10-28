// 搜索结果页（web search 用，只有方案 A 有）：DuckDuckGo 的 HTML 版和 Bing。
//   · 结果链接还原成真网址：DDG 的 //duckduckgo.com/l/?uddg=<编码过的网址>、Bing 的 bing.com/ck/a?…&u=a1<base64url>
//   · 去掉广告（DDG 的 result--ad、y.js 链接；Bing 的 b_ad 那一块和 aclick 链接）
//   · 验证码 / 同意页 / 「异常流量」页 → blocked: true（命令层说「这次搜不到」）
//   · 结果页按普通网页对待：不跑脚本，只扫标签（html2text.mjs 的 walkTags，线性）
import { walkTags, findClose, fragmentText, decodeEntities } from './html2text.mjs'

export const ENGINES = Object.freeze(['ddg', 'bing'])
const MAX_RESULTS = 30
const WANT = new Set(['href', 'class', 'id'])

/** 搜索词 → 结果页的网址 */
export function searchUrl(engine, q) {
  const query = encodeURIComponent(String(q ?? '').trim())
  if (engine === 'ddg') return `https://html.duckduckgo.com/html/?q=${query}`
  if (engine === 'bing') return `https://www.bing.com/search?q=${query}&setlang=zh-Hans`
  throw new Error(`不认识的搜索引擎：${engine}`)
}

const classes = (t) => new Set(String(t.attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean))
const httpUrl = (s) => {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.href.length <= 2048 ? u.href : null
  } catch { return null }
}
const hostIs = (u, d) => u.hostname === d || u.hostname.endsWith('.' + d)
// 标签后面到「</name」之间的字（最多看 8 KB）
const textAfter = (html, t, name, max) => {
  const k = findClose(html, t.end, name)
  const stop = k < 0 ? Math.min(html.length, t.end + 8192) : Math.min(k, t.end + 8192)
  return fragmentText(html.slice(t.end, stop), max)
}

/** DDG 的结果链接 → 真网址；广告（y.js）和站内链接 → null */
export function ddgTarget(href) {
  const h = decodeEntities(String(href ?? ''), true).trim()
  let u
  try { u = new URL(h, 'https://duckduckgo.com/') } catch { return null }
  if (hostIs(u, 'duckduckgo.com')) {
    if (u.pathname === '/l/' || u.pathname === '/l') return httpUrl(u.searchParams.get('uddg') ?? '')
    return null
  }
  return httpUrl(u.href)
}

/** Bing 的结果链接 → 真网址：/ck/a?…&u=a1<base64url>；别的 bing.com 链接（广告 aclick、站内）→ null */
export function bingTarget(href) {
  const h = decodeEntities(String(href ?? ''), true).trim()
  let u
  try { u = new URL(h, 'https://www.bing.com/') } catch { return null }
  if (hostIs(u, 'bing.com')) {
    if (u.pathname !== '/ck/a') return null
    const p = u.searchParams.get('u') ?? ''
    if (!p.startsWith('a1') || p.length > 4096) return null
    try { return httpUrl(Buffer.from(p.slice(2), 'base64url').toString('utf8')) } catch { return null }
  }
  return httpUrl(u.href)
}

// 一看就是被拦下的页面（不管有没有结果都算）
const HARD_BLOCK = {
  ddg: ['anomaly-modal', 'anomaly.js', 'challenge-form', 'bots use duckduckgo too'],
  bing: ['turing/captcha', 'b_captcha', 'captcha/challenge', 'id="challenge"'],
}
// 没有结果时才算的（结果里也可能正好有这些词）
const SOFT_BLOCK = ['captcha', 'unusual traffic', 'verify you are human', 'are you a robot', 'are you human', 'consent',
  'bnp_container', 'cookie', '异常流量', '人机验证', '验证码']

function parseDdg(html) {
  const out = []
  let cur = null
  walkTags(html, (t) => {
    if (t.close) return
    const cls = classes(t)
    if (t.name === 'div' && cls.has('result') && (cls.has('results_links') || cls.has('results_links_deep') || cls.has('web-result') || cls.has('result--ad'))) {
      cur = { ad: cls.has('result--ad'), title: '', url: null, snippet: '' }
      out.push(cur)
      return
    }
    if (!cur) return
    if (t.name === 'a' && cls.has('result__a') && !cur.title) {
      cur.url = ddgTarget(t.attrs.href)
      cur.title = textAfter(html, t, 'a', 200)
    } else if (cls.has('result__snippet') && !cur.snippet) {
      cur.snippet = textAfter(html, t, t.name, 400)
      if (!cur.url && t.name === 'a') cur.url = ddgTarget(t.attrs.href)
    }
  }, WANT)
  return out
}

function parseBing(html) {
  const out = []
  let cur = null, li = 0, adAt = -1
  walkTags(html, (t) => {
    const cls = t.close ? null : classes(t)
    if (t.name === 'li') {
      if (t.close) {
        if (adAt === li) adAt = -1
        li = Math.max(0, li - 1)
        return
      }
      li++
      if (adAt < 0 && [...cls].some((c) => c === 'b_ad' || c.startsWith('b_ad'))) { adAt = li; cur = null; return }
      if (cls.has('b_algo')) { cur = { ad: adAt >= 0, title: '', url: null, snippet: '', h2: false }; out.push(cur) }
      return
    }
    if (t.close || !cur) return
    if (t.name === 'h2') cur.h2 = true
    else if (t.name === 'a' && cur.h2 && !cur.title && t.attrs.href !== undefined) {
      cur.url = bingTarget(t.attrs.href)
      cur.title = textAfter(html, t, 'a', 200)
    } else if (t.name === 'p' && cur.title && !cur.snippet) cur.snippet = textAfter(html, t, 'p', 400)
  }, WANT)
  return out
}

/**
 * 结果页 → { results: [{ title, url, snippet }], blocked }。广告、还原不出真网址的、重复的都去掉；最多 30 条
 */
export function parseResults(engine, html) {
  const s = String(html ?? '')
  if (engine !== 'ddg' && engine !== 'bing') throw new Error(`不认识的搜索引擎：${engine}`)
  const raw = engine === 'ddg' ? parseDdg(s) : parseBing(s)
  const seen = new Set(), results = []
  for (const r of raw) {
    if (r.ad || !r.url || !r.title || seen.has(r.url)) continue
    seen.add(r.url)
    results.push({ title: r.title, url: r.url, snippet: r.snippet })
    if (results.length >= MAX_RESULTS) break
  }
  const low = s.toLowerCase()
  const blocked = HARD_BLOCK[engine].some((m) => low.includes(m)) || (!results.length && SOFT_BLOCK.some((m) => low.includes(m)))
  return { results: blocked ? [] : results, blocked }
}
