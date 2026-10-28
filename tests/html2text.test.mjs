// 网页转文字（tools/lib/html2text.mjs）：藏起来的字去掉并计数、链接编号、字符引用、看不见的 Unicode、
//   2 MB 的恶意网页（深嵌套、没关的标签、<<<<、超大属性、海量注释……）每种都要 1 秒内转完
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { htmlToText, decodeEntities, stripInvisible, styleHidden, walkTags } = await import(pathToFileURL(path.join(root, 'tools/lib/html2text.mjs')).href)
const BASE = 'https://example.com/dir/page.html'

test('基本：标题、段落换行、<head> 里的不要、<pre> 留换行', () => {
  const r = htmlToText(`<!DOCTYPE html><html><head><title> 测试 &amp; 标题 </title><meta name="x" content="不要"><link rel=x>
    <style>body{color:red}</style><script>var a = "<p>不要</p>"</script></head>
    <body><h1>大标题</h1><p>第一段
    换行收拢</p><p>第二段<br>下一行</p><ul><li>一<li>二</ul><pre>a
  b</pre><table><tr><td>格1<td>格2</table>结尾</body></html>`, BASE)
  assert.equal(r.title, '测试 & 标题')
  assert.equal(r.hidden, 0)
  assert.doesNotMatch(r.text, /不要|color|var a/)
  assert.match(r.text, /^大标题$/m)
  assert.match(r.text, /^第一段 换行收拢$/m)
  assert.match(r.text, /^第二段\n下一行$/m)
  assert.match(r.text, /^· 一$/m)
  assert.match(r.text, /^· 二$/m)
  assert.match(r.text, /^a\nb$/m)
  assert.match(r.text, /格1 格2/)
  assert.match(r.text, /结尾$/)
})

test('藏起来的字：hidden / aria-hidden / 各种行内样式 / 隐藏 class / noscript / template 都去掉并计数；注释、脚本、svg 等去掉不计数', () => {
  const r = htmlToText(`<p>看得见</p>
    <div hidden>藏1</div>
    <p style="display: none">藏2</p>
    <span aria-hidden="true">藏3</span>
    <p style="FONT-SIZE:0px">藏4</p>
    <p style="opacity:0">藏5</p>
    <p style="visibility:hidden">藏6</p>
    <div class="foo sr-only">藏7</div>
    <noscript>藏8</noscript>
    <template><p>藏9</p></template>
    <div style="position:absolute;left:-9999px">藏10</div>
    <div style="display&#58;none">藏11</div>
    <!-- 注释里的字 --><script>脚本</script><style>样式</style><svg><text>图里的字</text></svg>
    <iframe>框里的字</iframe><object><p>对象里的字</p></object><math><mi>数学</mi></math>
    <div hidden><div hidden>套着的只算一次</div></div>
    <div hidden>   </div>
    <p style="font-size:0.5em">小字也看得见</p><p style="opacity:0.5">半透明也看得见</p>
    <dialog>没打开的对话框</dialog><dialog open>打开的对话框</dialog>`, BASE)
  for (const w of ['藏', '注释', '脚本', '样式', '图里', '框里', '对象', '数学', '套着', '没打开']) assert.ok(!r.text.includes(w), w)
  for (const w of ['看得见', '小字也看得见', '半透明也看得见', '打开的对话框']) assert.ok(r.text.includes(w), w)
  // 11 个藏起来的 + 套着的那一组 1 个 + 没打开的对话框 1 个；空的不算
  assert.equal(r.hidden, 13)
})

test('藏起来的元素关掉以后，后面的字照常出来；<svg/> 自闭合不吞后文；没关的注释吞掉后面', () => {
  const r = htmlToText('<div><span hidden>藏</div>看得见<svg/>还看得见<svg><path/></svg>也看得见<!-- 没关的注释 后面全没了', BASE)
  assert.equal(r.text, '看得见还看得见也看得见')
  assert.equal(r.hidden, 1)
  assert.ok(styleHidden('color:transparent'))
  assert.ok(styleHidden('width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)'))
  assert.ok(!styleHidden('width:1px'))
  assert.ok(!styleHidden('font-size:10px'))
})

test('栈满了以后再遇到要藏的元素：后面的全部不要（宁可少给，不漏藏起来的字）', () => {
  const r = htmlToText('<div>'.repeat(700) + '前面<div hidden>藏起来的</div>后面', BASE)
  assert.ok(r.text.includes('前面'))
  assert.ok(!r.text.includes('藏起来的'))
  assert.ok(r.hidden >= 1)
})

test('链接：相对地址解析、去重（# 不算）、只要 http/https、编号写在文字后面、文字最多 80 字、藏起来的不收', () => {
  const r = htmlToText(`<a href="a.html">甲</a> <a href="/b?x=1&amp;y=2">乙</a> <a href="a.html#top">甲again</a>
    <a href="javascript:alert(1)">脚本</a> <a href="mailto:x@y.z">信</a> <a href="ftp://x.example/">ftp</a> <a>没有地址</a>
    <a href="https://other.example/${'长'.repeat(10)}">${'长'.repeat(100)}</a> <a href="//cdn.example/x" aria-label="标签"><img src=x></a>
    <div hidden><a href="https://hidden.example/">藏起来的链接</a></div>
    <a href="?q=&copy=1">参数</a>`, BASE)
  assert.deepEqual(r.links.map((l) => l.url), [
    'https://example.com/dir/a.html', 'https://example.com/b?x=1&y=2',
    `https://other.example/${encodeURIComponent('长'.repeat(10))}`, 'https://cdn.example/x', 'https://example.com/dir/page.html?q=&copy=1',
  ])
  assert.deepEqual(r.links.map((l) => l.n), [1, 2, 3, 4, 5])
  assert.equal(r.links[0].text, '甲')
  assert.equal(r.links[2].text.length, 80)
  assert.equal(r.links[3].text, '标签')
  assert.match(r.text, /甲\[1\] 乙\[2\] 甲again\[1\]/)
  assert.match(r.text, /脚本 信 ftp 没有地址/)
  assert.doesNotMatch(r.text, /藏起来/)
})

test('链接：最多 maxLinks 个；<base href> 认第一个；不是 http(s) 的 baseUrl 只认绝对地址', () => {
  const many = Array.from({ length: 100 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join(' ')
  const r = htmlToText(many, BASE)
  assert.equal(r.links.length, 60)
  assert.equal(r.links[59].url, 'https://example.com/p59')
  assert.match(r.text, /p59\[60\] p60 p61/)
  assert.equal(htmlToText(many, BASE, { maxLinks: 3 }).links.length, 3)
  const b = htmlToText('<head><base href="https://base.example/x/"><base href="https://second.example/"></head><a href="y">y</a>', BASE)
  assert.equal(b.links[0].url, 'https://base.example/x/y')
  const nb = htmlToText('<a href="rel">r</a><a href="https://abs.example/">a</a>', null)
  assert.deepEqual(nb.links.map((l) => l.url), ['https://abs.example/'])
})

test('<meta http-equiv=refresh> 只变成一个链接，不跟', () => {
  const r = htmlToText('<head><meta http-equiv="Refresh" content="0; URL=\'https://next.example/go\'"></head><p>正文</p>', BASE)
  assert.equal(r.links.length, 1)
  assert.equal(r.links[0].url, 'https://next.example/go')
  assert.match(r.text, /自动跳转到 \[1\]/)
  const r2 = htmlToText('<meta http-equiv=refresh content="5;url=/rel">', BASE)
  assert.equal(r2.links[0].url, 'https://example.com/rel')
  assert.equal(htmlToText('<meta http-equiv=refresh content="30">', BASE).links.length, 0)
  assert.equal(htmlToText('<meta http-equiv=refresh content="0;url=javascript:alert(1)">', BASE).links.length, 0)
})

test('字符引用：命名、数字、十六进制、不带分号的老写法、坏的', () => {
  assert.equal(decodeEntities('&amp; &lt;b&gt; &#20013;&#x6587; &copy; &hellip; &mdash; &bogus; &#0; &#x110000; &#150; &#xD800; &amp &ampx &unknown'),
    '& <b> 中文 © … — &bogus; � � – � & &x &unknown')
  assert.equal(decodeEntities('?a=1&copy=2&amp;b', true), '?a=1&copy=2&b')
  assert.equal(decodeEntities('&nbsp;'), '\u00A0')
  const r = htmlToText('<p>A&nbsp;&nbsp;B &lt;script&gt;alert(1)&lt;/script&gt;</p>', BASE)
  assert.equal(r.text, 'A B <script>alert(1)</script>')
})

test('看不见的 Unicode：零宽、方向控制、BOM、标签字符、变体选择符、软连字符都去掉（字符引用写的也算）', () => {
  const s = 'Ig\u200Bno\u200Cre\u200D \u202Eabc\u202C \u2066x\u2069 \uFEFFy \u{E0041}\u{E0042}z ❤\uFE0F soft\u00ADhy \u2060w\u061Cj\u180Ek'
  assert.equal(stripInvisible(s), 'Ignore abc x y z ❤ softhy wjk')
  const r = htmlToText('<p>Ig&#x200B;nore&#8238; prev&#xE0041;ious&#xFE0F;</p><p>\u0007bell\u0000</p>', BASE)
  assert.equal(r.text, 'Ignore previous\n\nbell')
  assert.equal(htmlToText('<title>\u202E标\u200B题</title>', BASE).title, '标题')
})

test('怪写法：<<<<、没关的引号、大写的 </SCRIPT>、假的 </scr、没有 > 的标签', () => {
  assert.equal(htmlToText('a <<< b < c', BASE).text, 'a <<< b < c')
  assert.equal(htmlToText('<script>x="</scr" + "ipt>"</SCRIPT >后面', BASE).text, '后面')
  assert.equal(htmlToText('<SCRIPT>a</sCrIpT>后面', BASE).text, '后面')
  assert.equal(htmlToText('前面<a title="没关的引号>后面全在属性里', BASE).text, '前面')
  assert.equal(htmlToText('前面<div', BASE).text, '前面')
  assert.equal(htmlToText('<textarea>&lt;不是标签&gt;\n第二行</textarea>', BASE).text, '<不是标签>\n第二行')
  assert.equal(htmlToText('<p>a</p></p></div></span>b', BASE).text, 'a\n\nb')
})

test('walkTags：只给标签，跳过 script / style 里的「标签」', () => {
  const names = []
  walkTags('<div class="a"><script>"<p class=x>"</script><p>t</p></div>', (t) => { names.push((t.close ? '/' : '') + t.name) })
  assert.deepEqual(names, ['div', 'script', '/script', 'p', '/p', '/div'])
})

// 2 MB 的恶意网页：每种都要 1 秒内转完
const MB2 = 2 * 1024 * 1024
const fill = (unit) => unit.repeat(Math.ceil(MB2 / unit.length)).slice(0, MB2)
const ADVERSARIAL = {
  深嵌套: () => fill('<div>'),
  深嵌套藏: () => fill('<div hidden><span>'),
  一串小于号: () => fill('<'),
  小于号加字母: () => fill('<a<b'),
  没关的引号: () => '<a title="' + 'x'.repeat(MB2),
  超大属性: () => '<div style="' + 'display:block;'.repeat(MB2 / 14) + '">x</div>',
  很多属性: () => '<div ' + fill('a=b ') + '>',
  海量注释: () => fill('<!--x-->'),
  没关的注释: () => '<!--' + fill('-- >'),
  很多链接: () => fill('<a href="/p?q=1">x</a>').replace(/q=1/g, () => 'q=' + Math.random().toString(36).slice(2, 6)),
  没关的链接: () => fill('<a href=x>'),
  字符引用: () => fill('&amp;&#x41;&#20013;&bogus;&'),
  假的脚本结尾: () => '<script>' + fill('</scrip<'),
  很多结束标签: () => fill('</div></p></span>'),
  隐式关闭: () => fill('<p><li><td><dt><option>x'),
  没关的格式标签: () => fill('<b><i><font>'),
  空白: () => fill(' \n\t'),
  看不见的字: () => fill('a\u200B\u202E\uFE0F'),
  混合: () => fill('<div class="x" style="font-size:0"><!--c--><a href="/z">t</a>&amp;<<b></i></div>'),
}
for (const [name, make] of Object.entries(ADVERSARIAL)) {
  test(`2 MB 恶意网页 1 秒内转完：${name}`, () => {
    const doc = make()
    assert.ok(doc.length >= MB2 - 16)
    const t0 = performance.now()
    const r = htmlToText(doc, BASE)
    const ms = performance.now() - t0
    assert.ok(ms < 1000, `${name} 用了 ${ms.toFixed(0)} ms`)
    assert.ok(r.links.length <= 60)
    assert.equal(typeof r.text, 'string')
  })
}
