// 搜索结果页（tools/lib/websearch.mjs）：DuckDuckGo HTML 版和 Bing 的结果解析 —— 跳转链接还原成真网址、去广告、去重、
//   验证码 / 同意页 / 异常流量页 → blocked。用手写的小结果页（照两家的 HTML 结构），不下载任何东西
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { searchUrl, parseResults, ddgTarget, bingTarget } = await import(pathToFileURL(path.join(root, 'tools/lib/websearch.mjs')).href)

const enc = encodeURIComponent
const ddgLink = (u) => `//duckduckgo.com/l/?uddg=${enc(u)}&amp;rut=0f1e2d3c4b5a`
const ddgResult = (u, title, snippet, cls = 'web-result') => `
<div class="result results_links results_links_deep ${cls} ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${u}">${title}</a>
    </h2>
    <div class="result__extras"><div class="result__extras__url">
      <span class="result__icon"><a rel="nofollow" href="${u}"><img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/x.ico" name="i15" /></a></span>
      <a class="result__url" href="${u}">example</a>
    </div></div>
    <a class="result__snippet" href="${u}">${snippet}</a>
    <div class="clear"></div>
  </div>
</div>`
const ddgPage = (body) => `<!DOCTYPE html><html lang="en-US"><head><meta charset="UTF-8"><title>q at DuckDuckGo</title>
<script>var x = '<div class="result results_links web-result"><a class="result__a" href="https://script.example/">脚本里的</a></div>'</script></head>
<body class="body--html"><div class="header"><form action="/html/" method="post"><input name="q" value="q"></form></div>
<div id="links" class="results">${body}</div></body></html>`

test('searchUrl：两家的网址、搜索词编码；不认识的引擎报错', () => {
  assert.equal(searchUrl('ddg', ' 傅里叶 变换&x '), `https://html.duckduckgo.com/html/?q=${enc('傅里叶 变换&x')}`)
  assert.equal(searchUrl('bing', 'a b'), 'https://www.bing.com/search?q=a%20b&setlang=zh-Hans')
  assert.throws(() => searchUrl('google', 'x'))
  assert.throws(() => parseResults('google', ''))
})

test('DDG：还原 uddg 链接、去广告、去重、不要 javascript:、脚本里的假结果不算', () => {
  const zh = 'https://zh.wikipedia.org/wiki/傅里叶变换'
  const html = ddgPage([
    ddgResult('https://duckduckgo.com/y.js?ad_domain=ads.example&amp;ad_provider=bingv7aa&amp;u3=https%3A%2F%2Fads.example', '买买买', '广告', 'result--ad'),
    ddgResult(ddgLink('https://en.wikipedia.org/wiki/Fourier_transform'), 'Fourier transform - <b>Wikipedia</b>', 'In mathematics, the <b>Fourier</b> transform &amp; more'),
    ddgResult(ddgLink(zh), '傅里叶变换 - 维基百科', '<b>傅里叶</b>变换是一种线性积分变换'),
    ddgResult(ddgLink('https://en.wikipedia.org/wiki/Fourier_transform'), '重复的', '重复'),
    ddgResult(ddgLink('javascript:alert(1)'), '坏链接', 'x'),
    ddgResult('https://direct.example.org/page', '直接链接', '直接'),
  ].join('\n'))
  const r = parseResults('ddg', html)
  assert.equal(r.blocked, false)
  assert.deepEqual(r.results.map((x) => x.url), [
    'https://en.wikipedia.org/wiki/Fourier_transform', new URL(zh).href, 'https://direct.example.org/page',
  ])
  assert.equal(r.results[0].title, 'Fourier transform - Wikipedia')
  assert.equal(r.results[0].snippet, 'In mathematics, the Fourier transform & more')
  assert.equal(r.results[1].title, '傅里叶变换 - 维基百科')
  assert.ok(!r.results.some((x) => /买|脚本/.test(x.title)))
  assert.equal(ddgTarget('https://duckduckgo.com/y.js?ad_domain=x'), null)
  assert.equal(ddgTarget('/about'), null)
})

test('DDG：没有结果不算被拦；anomaly / challenge 页算被拦', () => {
  const none = parseResults('ddg', ddgPage('<div class="no-results">No results.</div>'))
  assert.deepEqual(none, { results: [], blocked: false })
  const anomaly = parseResults('ddg', `<html><body><div class="anomaly-modal__modal" data-testid="anomaly-modal">
    <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
    <form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&amp;cc=sre&amp;ti=1" method="POST"></form></div></body></html>`)
  assert.equal(anomaly.blocked, true)
  assert.deepEqual(anomaly.results, [])
})

// Bing 的跳转链接：/ck/a?…&u=a1<base64url(真网址)>
const b64 = (u) => Buffer.from(u, 'utf8').toString('base64url')
const bingLink = (u) => `https://www.bing.com/ck/a?!&amp;&amp;p=4c3b2a1d0e9f8a7bJmltdHM9MTczMDA&amp;ptn=3&amp;ver=2&amp;hsh=4&amp;fclid=1f2e3d4c&amp;u=a1${b64(u)}&amp;ntb=1`
const bingAlgo = (u, title, snippet) => `<li class="b_algo" data-id="" iid="SERP.5021"><div class="b_tpcn"><a class="tilk" aria-label="站点" href="${u}" h="ID=SERP,5021.1"><div class="tpic"><div class="wr_fav"><img src="data:image/png;base64,iVBOR" /></div></div><div class="tptxt"><div class="tptt">站点名</div><div class="tpmeta"><cite>example.com</cite></div></div></a></div><h2><a target="_blank" href="${u}" h="ID=SERP,5022.1">${title}</a></h2><div class="b_caption" role="contentinfo"><p class="b_lineclamp2 b_algoSlug"><span class="algoSlug_icon" data-priority="2">网页</span>${snippet}</p></div></li>`
const bingPage = (body, extra = '') => `<!DOCTYPE html><html lang="zh"><head><title>q - 搜索</title><script>var _w={};"<li class=\\"b_algo\\">"</script></head>
<body>${extra}<div id="b_content"><main aria-label="搜索结果"><ol id="b_results" class="">${body}<li class="b_pag"><nav><ul><li><a href="/search?q=q&amp;first=11">2</a></li></ul></nav></li></ol></main></div></body></html>`

test('Bing：还原 u=a1 链接、去掉 b_ad 那一块和 aclick、去重、直接链接也认', () => {
  const zh = 'https://zh.wikipedia.org/wiki/傅里叶变换'
  const ad = `<li class="b_ad b_adTop"><ul><li class="b_adLastChild"><div class="sb_add sb_adTA"><h2><a href="https://www.bing.com/aclick?ld=e8xyz&amp;u=aHR0cHM6Ly9hZHMuZXhhbXBsZS8">广告标题</a></h2><div class="b_caption"><p>广告内容</p></div></div></li>
    <li class="b_algo"><h2><a href="https://ads2.example/">广告里的 b_algo</a></h2><p>x</p></li></ul></li>`
  const html = bingPage([
    ad,
    bingAlgo(bingLink('https://example.com/page?a=1&b=2'), 'Example <strong>page</strong>', '摘要 &middot; 文字'),
    bingAlgo('https://direct.example.org/x', '直接', '直接摘要'),
    bingAlgo(bingLink(zh), '傅里叶变换', '中文摘要'),
    bingAlgo(bingLink('https://example.com/page?a=1&b=2'), '重复', '重复'),
    bingAlgo(bingLink('javascript:alert(1)'), '坏的', 'x'),
    bingAlgo('https://www.bing.com/search?q=other', '站内', 'x'),
    `<li class="b_ad b_adBottom"><ul><li><h2><a href="https://www.bing.com/aclick?x=1">底部广告</a></h2></li></ul></li>`,
  ].join('\n'), '<div id="bnp_container"><div class="bnp_cookie_banner">我们使用 cookie</div></div>')
  const r = parseResults('bing', html)
  assert.equal(r.blocked, false)
  assert.deepEqual(r.results.map((x) => x.url), ['https://example.com/page?a=1&b=2', 'https://direct.example.org/x', new URL(zh).href])
  assert.equal(r.results[0].title, 'Example page')
  assert.equal(r.results[0].snippet, '网页摘要 · 文字')
  assert.ok(!r.results.some((x) => /广告/.test(x.title)))
  assert.equal(bingTarget('https://www.bing.com/aclick?ld=1&u=aHR0cHM6Ly9hZHMuZXhhbXBsZS8'), null)
  assert.equal(bingTarget('https://www.bing.com/ck/a?u=a1' + b64('ftp://x.example/')), null)
  assert.equal(bingTarget('https://www.bing.com/ck/a?u=zz'), null)
})

test('Bing：验证码页、没有结果只有同意页 → 被拦；正常的「没有结果」不算', () => {
  const captcha = parseResults('bing', '<html><body><div id="b_captcha"><iframe src="/turing/captcha/challenge?q=x"></iframe></div></body></html>')
  assert.equal(captcha.blocked, true)
  const consent = parseResults('bing', '<html><body><div id="bnp_container">Before you continue, please accept cookies (consent)</div></body></html>')
  assert.equal(consent.blocked, true)
  const none = parseResults('bing', bingPage('<li class="b_no"><h1>没有与此相关的结果</h1></li>'))
  assert.deepEqual(none, { results: [], blocked: false })
})

test('结果页很大、很乱也不卡（线性）', () => {
  const junk = '<div><a href="x">'.repeat(100000)
  const t0 = performance.now()
  parseResults('ddg', ddgPage(junk))
  parseResults('bing', bingPage('<li class="b_algo"><h2>'.repeat(50000)))
  assert.ok(performance.now() - t0 < 2000)
})
