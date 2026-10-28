/**
 * 必须是宿主每个入口的【第一个】import ——
 * tools/lib/paths.mjs 在被 import 的那一刻就把 DSH_HOME 定死了，所以要在它之前设好。
 *
 * Claude Code 版不依赖 DSH：数据目录默认是 ~/.bili-whale（不再借用 ~/.dsh）。
 * 想沿用 DSH 插件时代的数据，启动前设 DSH_HOME=~/.dsh 即可。
 */
import os from 'node:os'
import path from 'node:path'

const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
if (!process.env.DSH_HOME) process.env.DSH_HOME = path.join(home, '.bili-whale')
