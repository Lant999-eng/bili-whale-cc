// 测试用（--import 预加载）：fetch 换成假的 —— 不联网，每次调用往 stderr 打一行 FETCH，回一个空的成功回包
let n = 0
globalThis.fetch = async () => {
  n += 1
  process.stderr.write(`FETCH ${n}\n`)
  const body = JSON.stringify({ code: 0, message: '0', data: { items: [], cursor: { is_end: true, id: 0, time: 0 }, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } } })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}
