// 测试用（NODE_OPTIONS=--import 预加载）：直播间接口一律返回 code 0（房间信息 / 发弹幕成功），不碰网络
globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, message: '0', data: { room_id: 999, short_id: 999, uid: 1, title: '测试直播间', live_status: 1 } }),
  { status: 200, headers: { 'content-type': 'application/json' } })
