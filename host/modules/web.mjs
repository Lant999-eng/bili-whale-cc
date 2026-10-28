// 读书（2026-10-28，A 版）的报到单：读书回合由这里登记给宿主（turn）；主人的 cli web … 也在这里。
// 这一块的文件：tools/lib/webcage.mjs、webfetch.mjs、html2text.mjs、websearch.mjs、webstate.mjs、
// tools/commands/web.mjs、note.mjs、read-request.mjs、host/web-turn.mjs、host/web-cli.mjs、这张报到单，和 tests/ 里 web 开头的测试。
// 权限收紧（读书回合只给 web / note write、平时那一轮不给）写死在核心里：tools/lib/turn-policy.mjs、host/claude.mjs、host/turn-kinds.mjs
import * as webTurn from '../web-turn.mjs'
import { commands, doctor } from '../web-cli.mjs'

export const turn = webTurn
export const cli = { commands, doctor }
