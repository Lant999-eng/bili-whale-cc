// 读书测试用（--import 挂上）：把 tools/lib/webfetch.mjs 换成 tests/helpers/web-fake-fetch.mjs —— 一个字节都不出本机
import { register } from 'node:module'
register(new URL('./web-mock-hooks.mjs', import.meta.url))
