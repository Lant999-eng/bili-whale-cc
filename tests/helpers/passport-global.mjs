// node --import 用：把全局 fetch 换成假的 B站（TEST_PASSPORT 里是 fakeBili 的参数，JSON）
import { fakeBili } from './passport-fake.mjs'
globalThis.fetch = fakeBili(JSON.parse(process.env.TEST_PASSPORT || '{}')).fetch
