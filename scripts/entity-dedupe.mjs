#!/usr/bin/env node
// scripts/entity-dedupe.mjs — 实体名字碎片的体检与修复（docs/pending-work.md §14.2 P7）
//
// 规划与执行都在 lib/entity-repair.js 里——启动自愈、诊断页的修复按钮和本脚本共用同一套
// 判据，不存在"脚本会合、程序不会合"这种分叉。这里只是命令行外壳。
//
// 两类结论，处理方式不同：
//   · attested（可证明）——片段首尾重叠重建出的完整名在正文里出现过，或短名从未独立于长名出现。
//   · similar（只是相似）——编辑距离 / 名字核撞上来的两个称呼。默认**不动**，要 `--include-similar`
//     且逐条打印后仍由你决定；批量自动跑永远只碰 attested。
//
// 从不删除记忆：合并只改指向，条目正文一字不动（硬规则 5）。孤立节点只列出来。
//
// 用法：
//   node scripts/entity-dedupe.mjs                      # 全部库体检（默认 dry-run，零写入）
//   node scripts/entity-dedupe.mjs --library <id>       # 只看一个库
//   node scripts/entity-dedupe.mjs --apply              # 先图备份，再合并 attested 组
//   node scripts/entity-dedupe.mjs --apply --include-similar
//   DSH_MEMU_HOME=<dsh home>/dsh-memu-memory node scripts/entity-dedupe.mjs
import process from 'node:process'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const options = { apply: false, library: null, help: false, includeSimilar: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--include-similar') options.includeSimilar = true
    else if (arg === '--library') options.library = String(argv[++i] || '')
    else if (arg.startsWith('--library=')) options.library = arg.slice('--library='.length)
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('unknown argument: ' + arg + ' (see --help)')
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node scripts/entity-dedupe.mjs [--library <id>] [--apply] [--include-similar]')
    console.log('dry-run by default; --apply takes one graph backup first, then merges the provable groups')
    return
  }
  const state = await import('../lib/state.js')
  const repair = await import('../lib/entity-repair.js')
  const backup = await import('../lib/backup.js')

  if (options.library && !state.getLibrary(String(options.library))) throw new Error('library not found: ' + options.library)
  const plan = repair.planAllRepairs({
    listLibraries: state.listLibraries,
    loadPrivateIndex: state.loadPrivateIndex,
    libraryId: options.library || null,
  })

  for (const entry of plan.plans) {
    if (!entry.groups.length && !entry.ambiguous.length) continue
    console.log(`\n[${entry.libraryId}] — ${entry.scanned} 个实体，${entry.groups.length} 组可证明，${entry.ambiguous.length} 组只是相似`
      + (entry.partial ? '（正文只扫了最近 3000 条）' : ''))
    for (const line of repair.summarizePlan({ groups: entry.groups })) console.log('  · ' + line)
    for (const line of repair.summarizePlan({ groups: entry.ambiguous })) console.log('  ? ' + line + '  ← 需人工确认')
  }
  for (const failure of plan.failures) console.log(`  ! [${failure.libraryId}] 规划失败：${failure.error}`)

  if (!plan.attested && !plan.similar) {
    console.log('\n没有需要处理的实体组。')
    return
  }
  if (!options.apply) {
    console.log(`\ndry-run：可自动合并 ${plan.attested} 组，相似待确认 ${plan.similar} 组。确认无误后加 --apply（会先做一次图备份）`)
    return
  }
  const groups = []
  for (const entry of plan.plans) {
    const picked = options.includeSimilar ? [...entry.groups, ...entry.ambiguous] : entry.groups
    if (picked.length) groups.push({ libraryId: entry.libraryId, picked })
  }
  if (!groups.length) {
    console.log('\n没有可自动合并的组；相似候选请加 --include-similar 或到关系图谱里逐个确认。')
    return
  }
  // 备份在任何写之前：合并只改指向，但撤销要靠这份快照。
  const created = await backup.createBackup({ label: 'entity-dedupe' })
  console.log('\n图备份：' + (created?.name || created?.dir || JSON.stringify(created)))

  let merged = 0
  let made = 0
  let protectedRows = 0
  const failures = []
  for (const entry of groups) {
    const result = repair.applyRepairGroups(entry.libraryId, entry.picked)
    merged += result.merged
    made += result.created
    protectedRows += result.restored
    for (const failure of result.failures) failures.push(`[${entry.libraryId}] ${failure.group}: ${failure.error}`)
  }
  console.log(`\n已合并 ${merged} 组（新建完整名 ${made} 个，写回被清扫误伤的实体 ${protectedRows} 个）。`)
  console.log('下一步重算确定性边：node scripts/rebuild-auto-links.mjs --apply')
  if (failures.length) {
    console.log('\n失败明细：')
    for (const line of failures) console.log('  ! ' + line)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('entity-dedupe failed: ' + (error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
}
