#!/usr/bin/env node
// 手动清理回合日志（设计文档 §3.4）。默认 dry-run：只列出将删的文件与理由；
// --apply 才真删；--days N 覆盖 30 天默认。与 prune-sessions / prune-vectors 同款纪律。
//
// 两个条件缺一不可（§3.4 休眠 GC 行）：会话 ≥N 天无任何活动（lastTurnAt），且日志
// 无未结算增量（max seqEnd ≤ lastSleepSeq）——有未结算增量的日志是增量来源，删了
// 就得整段重建；没到 idle 期限的删了也是白删（复活成本一样）。
import { listSessionBindings } from '../lib/state.js'
import { gcTurnLogs, turnLogPath } from '../lib/turn-log.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const daysFlag = args.indexOf('--days')
const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 30
// 0 used to mean "every log is old enough", which made this a wipe command with a
// harmless-looking flag. The log is a cache so deletion is recoverable, but the
// rebuild cost is real — refuse the footgun all the same.
if (!Number.isFinite(days) || days <= 0) {
  console.error('prune-turnlogs: --days must be a positive number of days (0 is not "all")')
  process.exit(2)
}

const result = gcTurnLogs(listSessionBindings(), { olderThanDays: days, dryRun: !apply })
for (const sessionId of result.deleted) {
  console.log(`${apply ? 'deleted' : 'would delete'} ${turnLogPath(sessionId)}`)
}
for (const item of result.kept) {
  console.log(`kept ${item.sessionId}: ${item.reason}`)
}
console.log(JSON.stringify({ dryRun: !apply, days, deleted: result.deleted, kept: result.kept }, null, 2))
