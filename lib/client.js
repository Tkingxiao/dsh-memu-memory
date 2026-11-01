window.__ModuleLoader__.load({
  id: 'dsh-memu-memory',
  factory: (require) => {
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom/client') } catch {}
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'dsh-memu-memory'
    const SETTINGS_PAGES = ['engine', 'connection', 'settings', 'folders', 'libraries', 'browser', 'global', 'prompts', 'stats', 'memories', 'logs', 'lexicon', 'help']
    const EMPTY_SESSIONS = Object.freeze({ byId: Object.freeze({}), ids: Object.freeze([]) })
    const TAB_ID = `${NS}:memory`
    const TAB_KIND = 'dsh-memu-memory'
    const h = React.createElement

    // A write made in one pane was invisible in the other: the sidebar fetched
    // its snapshot once and then kept painting stale rows while the memory
    // browser added or archived entries. Both panes live in this one bundle, so a
    // module-level tick is enough to make the sidebar refetch immediately. Writes
    // we cannot hear about that way (a tool call mid-turn, a second window) arrive
    // through the revision heartbeat in the sidebar instead.
    const memoryWriteListeners = new Set()
    // Identity of a painted snapshot. The counter alone is not enough: a write served
    // by another module instance (a tool call mid-turn, a curator job, a second
    // window) moves the on-disk stamp but not the counter, which is precisely why the
    // panel used to sit stale until someone pressed Refresh by hand. Comparing the
    // pair makes the heartbeat hear writes from anywhere.
    function sidebarMarker(res) {
      const rev = typeof res?.revision === "number" ? String(res.revision) : ""
      const stamp = typeof res?.stamp === "string" ? res.stamp : ""
      return rev + "|" + stamp
    }
    // One heartbeat for every surface that paints memory or settings. Each pane
    // polls the two-field marker above and refetches only when it moves; hidden
    // panes send nothing, and returning to the window refetches once. Three open
    // panes therefore cost about one cheap RPC per second — the beat must never
    // grow a payload (AGENTS §7.4).
    const BEAT_MS = 2500
    function useMemoryBeat({ call, markerRef, onBeat, force = false, intervalMs = BEAT_MS }) {
      React.useEffect(() => {
        const id = setInterval(async () => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return
          try {
            if (force) { await onBeat(); return }
            const res = await call("getSidebarState", { revisionOnly: true })
            // null means nothing has been painted yet; the mount fetch owns that case.
            if (markerRef.current === null) return
            const next = sidebarMarker(res)
            if (next === markerRef.current) return
            const previous = markerRef.current
            const result = await onBeat()
            if (result !== false && markerRef.current === previous) markerRef.current = next
          } catch {}
        }, intervalMs)
        // Never hold the host process open for a poll (matters in tests too).
        if (id && typeof id.unref === "function") id.unref()
        return () => clearInterval(id)
      }, [call, markerRef, onBeat, force, intervalMs])
      React.useEffect(() => {
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined
        const onVisible = () => {
          if (document.visibilityState === "hidden") return
          void onBeat()
        }
        document.addEventListener("visibilitychange", onVisible)
        return () => document.removeEventListener("visibilitychange", onVisible)
      }, [onBeat])
    }
    // The standalone WebUI is another document (a tab or the in-app overlay), so it
    // needs the same tick over a channel. A channel never receives its own posts,
    // which is what keeps this from bouncing back: the inbound path runs the local
    // listeners without re-announcing. Metadata only — the receiver always refetches
    // from the server, the message never carries rows.
    let syncChannel = null
    function runWriteListeners() {
      for (const listener of memoryWriteListeners) {
        try {
          listener()
        } catch {}
      }
    }
    function broadcastMemoryWrite(kind, libraryId) {
      try {
        syncChannel?.postMessage({
          type: "memory-write",
          kind: kind || "memory",
          libraryId: libraryId || null,
          at: new Date().toISOString(),
        })
      } catch {}
    }
    function notifyMemoryWrite(kind, libraryId) {
      runWriteListeners()
      broadcastMemoryWrite(kind, libraryId)
    }

    try {
      if (typeof BroadcastChannel === "function") {
        const channel = new BroadcastChannel("dsh-memu-memory")
        channel.onmessage = (event) => {
          if (event && event.data && event.data.type === "memory-write") runWriteListeners()
        }
        syncChannel = channel
        channel.unref?.()
      }
    } catch {}

    const zh = {
      inboundToolNames: '外部消息工具白名单',
      reviewResolution: '复核方式',
      reviewReplace: '替代旧事实',
      reviewCoexist: '按条件并存',
      reviewConditions: '说明不同适用条件（至少 8 字）',
      pageMemories: 'MemU 记忆',
      descMemories: '跨库记忆、来源与状态',
      pageLogs: '日志',
      descLogs: '召回、写入、整理与向量的活动记录，可筛选、复制、下载',
      logSearch: '搜索 id / 标题 / 错误',
      logRefresh: '刷新',
      logCopyAll: '复制全部',
      logDownload: '下载',
      logCopyOne: '复制',
      logLocate: '定位记忆',
      logEmpty: '没有匹配的日志。',
      logAllKinds: '全部类型',
      logKindRecall: '召回',
      logKindWrite: '写入',
      logKindConsolidate: '整理',
      logKindCurate: '提炼',
      logKindVector: '向量',
      logKindError: '错误',
      logKindSystem: '系统',
      logKindCheck: '主动检查',
      logClear: '清空日志',
      runLogTitle: '整理记录',
      runLogEmpty: '还没有整理记录。',
      runLogOpen: '全部日志',
      dedupedNotice: '未写入：库里已有几乎相同的记忆 [{id}]。要补充内容请在原条目上编辑合并；确属两次独立观测时才需要 allow_duplicate 重写。',
      consolidateFeedTitle: '整理提醒',
      consolidateFailedCol: '失败',
      consolidateOkCol: '成功',
      consolidateFailed: '失败',
      consolidateDone: '完成',
      consolidateFailedCount: '失败 {n}',
      consolidateJumpHint: '在记忆工作室中打开这条记忆所在的库',
      consolidateExpand: '展开',
      consolidateCollapse: '收起',
      consolidateClear: '清除失败记录',
      consolidateClearHint: '只删除失败的整理日志；成功记录与其它日志不动',
      consolidateCleared: '已清除 {n} 条失败记录',
      allLibraries: '全部记忆库',
      wallAllBlocked: '当前宿主只允许单库读取，已显示第一个记忆库',
      linkCountTag: '关联 {n}',
      linkRemoved: '关联已移除',
      searchMemories: '搜索标题、内容或标签',
      poolReview: '待复核',
      poolInactive: '已失效',
      wallReadError: '部分记忆库读取失败',
      wallLimit: '仅展示最近 300 条',
      wallScopePrivate: '私有',
      wallScopeGlobal: '全局',
      wallFilterScope: '范围',
      wallFilterStatus: '状态',
      wallFilterLayer: '层级',
      wallAllLayers: '全部层级',
      multiSelect: '多选',
      wallSelected: '已选 {n} 条',
      wallSelectAll: '全选本页',
      wallClearSelection: '清空选择',
      wallMultiExit: '退出多选',
      viewMemory: '查看此记忆',
      entityDelete: '删除实体',
      entityDeleteForceHint: '仍被记忆或关系引用；再点一次将连同引用一起删除',
      openMemu: '打开 MemU WebUI',
      saved: '已保存',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择文本',
      confirmAction: '确认此操作？',
      relationState: '关系当前状态',
      familiarity: '熟悉度（未知可留空）',
      trust: '信任（未知可留空）',
      warmth: '温度（未知可留空）',
      boundaries: '边界（每行一条）',
      callbacks: '共同记号（每行一条）',
      openPromises: '未兑现的约定（每行一条）',
      relationEvidence: '依据记忆',
      relationHistory: '历史版本',
      contextScope: '消息与角色作用域',
      contextScopeHint: '留空 = 这层不做隔离；填了之后只召回相同作用域的记忆（旧条目不会删除）。',
      contextSave: '保存作用域',
      channelId: '群组 / 频道 ID',
      characterId: '当前角色 ID',
      worldId: '世界线 ID',
      branchId: '剧情分支 ID',
      exportZip: '导出 ZIP（含图片）',
      exportStarted: '已开始导出：{file}',
      memorySaved: '记忆已保存',
      memoryArchived: '记忆已归档',
      memoryRestored: '记忆已恢复',
      memoryDeleted: '记忆已删除',
      bulkDone: '批量操作完成：{n} 条',
      curatorReview: '全局记忆审核',
      descCuratorReview: '控制全局提炼的写入方式：自动模式只暂扣冲突、缺证据与高风险改写；全部待审把每个内容改动都送进复核队列。',
      curatorReviewAuto: '自动（默认）',
      curatorReviewAll: '全部待审',
      archiveTooLarge: '附件包超过单次导入上限（16 MB），请拆分',
      openSettings: '打开设置页',
      sidebarSettings: '在侧边栏保留完整设置',
      visionCaptionEnabled: '允许发送图片到视觉描述服务',
      visionService: '图片描述服务（可选）',
      attachmentMissing: '附件缺失',
      relations: '关系',
      adjacency: '邻接列表',
      graphView: '关系图',
      viewMemories: '记忆',
      viewRelations: '节点图',
      close: '关闭',
      openInBrowser: '在记忆浏览中打开',
      globalReadOnly: '全局记忆在这里只读；需要修改请去全局记忆页。',
      confidenceLabel: '置信度',
      tagsLabel: '标签',
      memoryMissing: '这条记忆已经不在了。',
      focusMemory: '聚焦条目',
      relationKind: '关系类型',
      relationNote: '关系依据（至少 8 字）',
      relationTarget: '关联目标',
      relationCreate: '建立关联',
      relationRemove: '移除关联',
      relationConfirm: '确认移除？',
      entityNew: '新建实体',
      entityName: '实体名称',
      entityAliases: '别名（逗号分隔）',
      entityKind: '实体类型',
      graphEmpty: '还没有关联',
      graphAutoLink: '自动',
      deletedNode: '[已删除]',
      graphLimited: '仅显示最多 200 个节点',
      graphFit: '适应全图',
      graphZoomIn: '放大',
      graphZoomOut: '缩小',
      graphOptions: '图谱设置',
      graphRepulsion: '节点斥力',
      graphDistance: '连线距离',
      graphLabels: '显示标签',
      graphMotion: '动态布局',
      graphLoadError: '图谱加载失败，请重试',
      nav: 'MemU 记忆',
      guideDesc: '记忆库、注入与全局记忆',
      engine: 'MemU 引擎',
      engineReady: '已就绪',
      engineInstalling: '安装中',
      engineError: '安装失败',
      engineIdle: '未安装',
      recommended: '推荐版本',
      current: '当前版本',
      refresh: '刷新',
      warning: '更新到未经验证的最新版可能导致 CLI 变化或记忆功能损坏。只安装插件声明的推荐版本。',
      memorySettings: '记忆设置',
      settingsTuning: '注入与召回',
      autoInject: '注入模式',
      privateTopK: '私有 topK',
      globalTopK: '全局 topK',
      mustRememberCap: '永久记忆软上限',
      shortTermTtlHours: '短期记忆保留（小时，0=关闭）',
      anchorTokens: '锚点 token',
      turnTokens: '召回 token',
      injectionTotalTokens: '注入总 token',
      dedupeTurns: '去重轮数',
      globalEveryNTurns: '全局每 N 轮',
      minUserChars: '最短用户消息',
      randomCueChance: '随机侧事件概率',
      autoInstall: '自动安装引擎',
      sleepConsolidation: '空闲后整理记忆',
      sleepAfterIdleMinutes: '空闲多久后整理（分钟）',
      autoCurateEveryHours: '全局自动提炼间隔（小时，0=关闭）',
      autoCurateSessionLimit: '每次最多纳入的对话数',
      memoryMode: 'MemU 存储模式',
      memoryModeHint: 'local 把记忆留在本机；cloud 交给 MemU 官方后端，需要 ~/.memu/config.env 里的厂商凭据。',
      memoryBackend: '记忆后端',
      backendAgent: '本地（会话 Agent）',
      backendApi: '启用向量库',
      backendAgentHint: '由当前对话的 Agent 在本地 JSON/索引路径中总结与写入；不启用 MemU、worker 或 embedding。',
      backendApiHint: '启用向量库后，选择本地受管模型或 API embedding；MemU 仍在本地存储与检索。',
      vectorSource: 'Embedding 来源',
      vectorSourceLocal: '本地',
      vectorSourceApi: 'API',
      vectorSourceHint: '本地使用已校验的 loopback embedding worker；API 使用下方 MemU embedding 服务配置。',
      managedVectorStatus: '状态',
      managedVectorDownloading: '下载中',
      managedVectorVerifying: '校验中',
      managedVectorFailed: '失败',
      managedVectorProgress: '下载进度',
      managedVectorCurrent: '当前文件',
      managedVectorRetry: '重试',
      managedVectorRebuilding: '重建中',
      managedVectorGeneration: '代际',
      managedVectorNoCatalog: '模型目录暂不可用，请稍后刷新。',
      engineLatestVersions: '最新版本',
      engineLatestHint: '从 PyPI 主动查询；插件只安装声明的推荐版本，不会自动追最新。',
      engineQueryVersions: '查询最新版本',
      engineQuerying: '查询中…',
      engineQueryFailed: '查询失败，可稍后重试',
      engineLatestTag: '最新',
      habitsInjection: '生活质感（时段感受）',
      decay: '残留强度',
      accessed: '上次想起',
      neverAccessed: '还没被想起过',
      peakTag: '高峰',
      anniversaryTag: '纪念日',
      dueDateTag: '日期',
      salientDateLabel: '日期（MM-DD 每年复现，YYYY-MM-DD 一次性）',
      salientDatePlaceholder: '例如 10-29 或 2026-10-29，留空则不设日期',
      moodTag: '情绪',
      reviews: '待复核',
      reviewsEmpty: '没有等待复核的记忆。',
      reviewScopePrivate: '私有库',
      // 包 F2：集合吸收（absorb）复核与撤销。
      absorbTag: '集合吸收 · {n} 条',
      absorbSourcesTag: '集合记忆 · {n} 条来源',
      absorbUndo: '撤销合并',
      absorbUndone: '已撤销合并，来源记忆已恢复',
      absorbSourcesLabel: '吸收来源',
      absorbLinksLabel: '关联记忆',
      accuracyTag: '细节未必准',
      accept: '接受',
      reject: '丢弃',
      reviewReason: '原因',
      noMemoriesView: '这个记忆库还是空的。可以先在对话里让 agent 记点什么，或用上面的表单手写一条。',
      browseActiveTab: '活跃',
      browseArchivedTab: '已归档',
      browseArchivedEmpty: '这个库目前没有已归档的记忆。归档只是把记忆移出注入与召回、正文还在——清理就在这一页做。',
      browseArchivedHint: '删除是永久的：正文会从索引和引擎里一起拿走，之后既不能召回也不能恢复。所以先点一下「删除」，再点「确认删除」。',
      deleteForever: '删除',
      confirmDelete: '确认删除',
      cancelDelete: '取消',
      descOverview: 'MemU / Python 引擎的安装、修复、版本与备份。',
      descConnection: '选择词法或向量召回；本地向量需先分别下载运行时与模型，再切换重建。',
      descSettings: '注入频率、召回条数、衰减与自动化。',
      descLibraries: '同文件夹的对话自动共用一个记忆库；删除对话不会删除记忆。',
      descBrowser: '按库浏览、手写、修改、归档与导出记忆。',
      descGlobal: '跨对话共享的全局记忆，由非主 agent 的 curator 提炼。',
      descPrompts: '记忆相关的提示词可编辑、可恢复默认，并随插件版本更新。',
      pageFolders: '文件夹',
      descFolders: '每个工作区文件夹两个开关：私有记忆决定这个文件夹里的对话是否共用本地记忆库；全局记忆决定是否注入跨对话共享的长期记忆。关闭开关不会删除已有记忆。',
      folderPrivate: '私有记忆',
      folderGlobal: '全局记忆',
      folderNoLibrary: '尚无私有库',
      folderMissing: '已不在 DSH 工作区',
      folderEmpty: '还没有工作区文件夹。先在 DSH 里添加一个文件夹，这里就会出现它的记忆开关。',
      folderPrivateHint: '让这个文件夹里的对话共用一个私有记忆库',
      folderGlobalHint: '让这个文件夹里的对话读取全局记忆',
      folderSaveFailed: '保存失败',
      installStep: '当前步骤',
      installElapsed: '已用时',
      installLog: '安装日志',
      stepResolvingPython: '解析 Python',
      stepCreatingVenv: '创建虚拟环境',
      stepInstallingDeps: '安装依赖',
      stepVerifying: '校验 CLI',
      stepBackingUp: '备份记忆',
      stepReady: '完成',
      stepFailed: '失败',
      newSessionPrompt: '新会话弹窗',
      embedding: 'MemU Embedding',
      embedSource: '向量服务位置',
      embedSourceLocal: '本地',
      embedSourceRemote: '远程',
      embedSourceLocalHint: '本机的 OpenAI 兼容向量服务（例如 Ollama：{url}，模型 {model}）。DSH 自身没有 embedding 能力，所以“本地”要求你自己先把该服务跑起来；不需要厂商 API key。',
      managedVector: '受管本地向量模型',
      managedVectorHint: '下载固定制品到插件数据目录；选择只记录待切换模型，切换会创建新向量空间并保留旧空间。',
      managedVectorDownload: '下载并校验',
      managedVectorSelect: '选择待切换',
      managedVectorSwitch: '切换并重建',
      managedVectorRollback: '回滚上一空间',
      managedVectorTest: '测试当前模型',
      managedVectorActive: '当前生效',
      managedVectorRequested: '待切换',
      managedVectorInstalled: '已安装',
      managedVectorPending: '待核验',
      managedVectorUnavailable: '不可用',
      managedVectorSizePending: '大小待核验',
      managedVectorFailure: '切换失败',
      managedVectorRuntimeHint: '没有检测到已核实的本地运行时。点「下载运行时」把目录里 pin 住的制品装进插件数据目录：不需要手动设置 DSH_MEMU_EMBED_RUNTIME_DIR，也不需要另起 Ollama。',
      managedVectorRuntimeMissing: '运行时未安装',
      managedVectorRuntimeInstalling: '运行时安装中',
      managedVectorRuntimeInstalled: '运行时已就绪（受管）',
      managedVectorRuntimeConfigured: '运行时已就绪（环境变量）',
      managedVectorRuntimeFailed: '运行时安装失败',
      managedVectorRuntimeUnsupported: '此平台没有已核实的运行时制品',
      managedVectorRuntimeInstall: '下载运行时',
      managedVectorRuntimeTitle: '运行环境',
      managedVectorModelsTitle: '模型',
      managedVectorReady: '已就绪',
      vectorRebuildTitle: '重建进度',
      vectorStagePreparing: '准备中',
      vectorStagePrepared: '已准备',
      vectorStageSyncing: '写入向量',
      vectorStageSwitching: '切换中',
      vectorStageFailed: '失败',
      vectorStageCommitted: '已切换',
      managedVectorCommitted: '已写入',
      managedVectorSkipped: '跳过',
      managedVectorFailedCount: '失败',
      vectorSwitchDoneHint: '新记忆会自动写入这个向量空间；召回已切到向量路径。',
      vectorAbortedHint: '重建已停止，当前向量空间未改变；再次点击可续建。',
      managedVectorAborted: '已停止',
      vectorRouteLabel: '召回路由',
      vectorRouteLocal: '本地向量',
      vectorRouteRemote: '远程向量',
      vectorRouteLexical: '词法',
      vectorIndexedTag: '已入向量库',
      vectorIndexedMigrated: '已入向量库（迁移）',
      vectorIndexedNow: '当前已入向量库',
      vectorIndexedUnit: '条',
      vectorSwitchWrote: '切换时写入',
      managedVectorConfirmDownload: '确认下载并校验模型制品？运行时需另行下载。',
      managedVectorPrerequisites: '使用顺序：安装 MemU 引擎 → 下载运行时 → 下载并选择已核验模型 → 切换并重建。准备完成前保持词法召回；不需要 Ollama 或手动环境变量。',
      managedVectorSwitchBlocked: '切换前请先下载已核验的运行时，并下载、选择模型。',
      managedVectorConfirmSwitch: '确认切换？这会在新空间重建向量并短暂冻结写入。',
      managedVectorConfirmRollback: '确认回滚到上一向量空间？',
      managedVectorRetention: '备份最多保留 3 份，较旧的完整备份会自动清理。',
      embedSourceRemoteHint: '用你自己填写的 provider / Base URL / API Key 调第三方向量服务。',
      embedKeyNotNeeded: '本地向量服务无需 API Key',
      embedKeyRemoteHint: '只有远程向量服务需要填写 API Key',
      testConnectionHint: '连不上向量服务 {url}。请先启动本机服务（例如 ollama serve），并确认模型 {model} 已拉取；这与 API Key 无关。',
      embedSourceSwitched: '已切换向量位置',
      provider: 'Provider',
      model: 'Embedding 模型',
      baseUrl: 'Base URL',
      apiKey: 'API Key',
      keyConfigured: '已配置，留空不修改',
      keyMissing: '未配置',
      saveConfig: '保存配置',
      testConfig: '测试',
      clearKey: '清除密钥',
      summaryHint: '远程总结：整理记忆时由这里配置的远程模型写记忆，需要兼容 OpenAI 的 /chat/completions 接口；留空则沿用上面的服务商与密钥。',
      summaryModel: '总结模型',
      summaryBaseUrl: '总结 Base URL',
      summaryApiKey: '总结 API Key',
      testOk: '测试通过',
      configPath: '配置文件',
      configSaved: '已保存',
      pageOverview: 'MemU 引擎',
      pageConnection: '连接与向量',
      pageSettings: '记忆设置',
      pageLibraries: '记忆库',
      pageGlobal: '全局记忆',
      pagePrompts: '提示词',
      pageStats: '统计',
      descStats: '这个库最近在长还是在睡、哪几条从没被想起、写得多还是用得多。',
      statsWindow: '近 {days} 天',
      statsScope: '统计范围',
      statsWritten: '写入',
      statsInjected: '注入',
      statsRecalled: '召回',
      statsArchived: '归档',
      statsActivity: '活跃度',
      statsActivityHint: '每天有多少条记忆真正进入上下文。空着的那天不是出错，只是没有记忆被写、也没有被想起。',
      statsActivityEmpty: '近 30 天没有记忆进入上下文',
      statsDistribution: '命中分布',
      statsDistributionHint: '一个点一条记忆：越靠右写得越早，越靠上被注入得越多。长期躺在右下角的那批，就是该归档的。',
      statsDistributionEmpty: '还没有可画的记忆。',
      statsScatterIdle: '还没有记忆被注入过。等它们被召回一次，这里才有分布。',
      statsHealth: '库健康度',
      statsActive: '活跃',
      statsAvgStrength: '平均残留强度',
      statsStale: '最久没被想起',
      statsStaleEmpty: '每条都还在被想起。',
      statsStaleDays: '{days} 天没动静',
      statsStaleToday: '今天还动过',
      statsRatio: '写读比',
      statsRatioHint: '近 7 天写入与注入的条数。长期大于 1 说明写得比用得多，该收紧提示词了。',
      statsRatioBusy: '写得比用得多',
      statsUnavailable: '统计文件读不出来（原文件已保留），这个库暂时没有数据。记忆本身不受影响。',
      statsNoLibrary: '还没有记忆库；统计从第一条记忆开始。',
      statsShown: '显示 {shown} / {total} 条',
      pageConfig: '设置',
      openWebUi: 'WebUI',
      openWebUiHint: '打开完整 WebUI：记忆、引擎、设置、文件夹、提示词（浏览器拦下新标签页时在应用内打开）',
      pageBinding: '当前对话',
      pagePrivate: '私有记忆',
      pageBrowser: '记忆浏览',
      browser: '记忆浏览',
      reload: '读取',
      browse: '浏览',
      export: '导出 JSON',
      importJson: '导入 JSON',
      importHint: '选择导出的 JSON 或图片 ZIP。按正文去重；已归档与失效条目跳过；老版本里限定在某段对话的条目会按「共享」导入，并在报告里单独列出（要收窄请补 context 字段）。',
      importDone: '导入完成（新增 / 跳过）',
      importAdjusted: '已按新语义调整',
      importEngineWarning: '记忆已写入索引，但引擎提交失败，语义检索暂时看不到它们',
      newMemory: '新建记忆',
      memoryTitle: '标题（可留空）',
      memoryContent: '记忆内容',
      add: '写入',
      browserIndexOnly: '显示本地索引，正文以此为准。',
      // Enum display labels. Stored values stay English; only these flip with locale.
      layerLongTerm: '长期记忆',
      layerAnchor: '锚点记忆',
      layerMustRemember: '永久记忆',
      stActive: '使用中',
      stArchived: '已归档',
      stSuppressed: '已压制',
      stSuperseded: '已被取代',
      stPendingReview: '待复核',
      dmGeneral: '通用',
      dmCoding: '编程',
      dmRp: '角色扮演',
      dmMixed: '混合',
      dmUniversal: '跨领域通用',
      dmPersonal: '个人',
      dmOther: '其他',
      dmUnknown: '未知',
      dmProjectPrefix: '项目：',
      modeSmart: '智能（每回合最多一次）',
      modeAnchor: '只放锚点',
      modePerTurn: '每回合都检索',
      modeOff: '关闭',
      marginalizedTag: '边缘化',
      openLoopTag: '未了之事',
      layerShortTerm: '短期',
      stExpired: '已过期',
      discCanTell: '可以说',
      discOnlyIfAsked: '问才说',
      discNeverSay: '别说出口',
      ownerMe: '我',
      ownerUs: '我们',
      ownerAboutUser: '关于他',
      ownerAboutProject: '关于项目',
      visShared: '共享',
      visSecret: '秘密',
      sourceUserSaid: '对方的话',
      sourceInferred: '我推断',
      sourceImagined: '我编的',
      sourceTold: '转述',
      disclosureLabel: '说出口径',
      sourceLabel: '来源',
      ownerLabel: '归属',
      visibilityLabel: '可见范围',
      relevanceThreshold: '检索相关度下限（相对最高分，0=不限）',
      shortTermExpires: '过期',
      engineNotInstalled: '未安装',
      engineIsInstalled: '已安装并就绪',
      engineVersionHistory: '历史版本',
      engineCurrentTag: '使用中',
      engineRecommendedTag: '推荐',
      engineNotInstalledRow: '本机没有该版本的运行环境',
      engineSwitchTo: '切换到此版本',
      engineSwitchConfirm: '切换到 {version}？\n\n切换前会自动备份记忆数据。若该版本自检不通过则不会切换。',
      engineSwitchBlocked: '只有已经装好的版本才能切换。推荐版本请用「{action}」按钮安装。',
      engineRepair: '修复',
      engineInstall: '安装',
      engineSourceLabel: '安装源',
      engineInstalledAt: '安装时间',
      archivedLibraries: '归档记忆库',
      noArchived: '没有归档的记忆库。',
      archivedHint: '文件夹从 DSH 移除或在本机消失后，记忆库会自动归档；记忆不会被删除，需要你手动删除，或设置自动删除天数。',
      restore: '恢复',
      deleteForever: '彻底删除',
      deleteLibraryConfirm: '彻底删除记忆库 {name}？这会删掉它的 MemU 数据库和索引，无法恢复。',
      scopeMissing: '文件夹不存在',
      purgeArchivedAfterDays: '归档清理候选阈值（天，0=不提示）',
      engineVersionHint: '插件升级后旧版本仍留在本机，可以切回去。切换前自动备份，切换前会先自检。',
      engineNoVersions: '还没有装过任何版本，点「安装」装上推荐版本。',
      engineUsableTag: '可用',
      engineBrokenTag: '自检失败',
      engineUnprobedTag: '未自检',
      engineProbedAt: '自检时间',
      engineRemoveVersion: '删除',
      engineRemoveConfirm: '删除版本 {version}？只删除本机引擎目录，记忆数据不动。',
      enginePrune: '清理旧版本',
      enginePruneDone: '已清理 {removed} 个旧版本，保留 {kept} 个。',
      backups: '备份',
      descBackups: '切换引擎和恢复备份前都会自动备份。备份含 state.json、index/*.json、manifest 与引擎信息，带 sha256 校验。',
      noBackups: '还没有备份。',
      backupNoManifest: '旧格式备份（无校验）',
      backupRestore: '恢复',
      backupDelete: '删除',
      backupDeleteConfirm: '删除备份 {name}？这个备份目录会被永久删除，不能撤销。',
      backupRestoreConfirm: '用备份 {name} 覆盖当前数据？当前数据会先自动备份一次。',
      backupRestored: '已恢复，数据已重载。',
      organizedRemote: '已由远程模型整理，写入 {count} 条记忆',
      organizedAgent: '已在后台子会话里整理，你的对话不会多出一轮',
      save: '保存',
      settingsReset: '恢复默认',
      settingsResetConfirm: '确认恢复默认？',
      libraries: '记忆库',
      noLibraries: '暂无记忆库。',
      newLibrary: '新建记忆库',
      name: '名称',
      create: '创建',
      scope: '文件夹',
      privateCount: '私有记忆',
      pinned: '永久记忆',
      bound: '绑定对话',
      globalMemory: '全局记忆',
      prompts: '提示词',
      promptCustom: '自定义',
      promptDefault: '默认',
      promptUpdated: '默认版本已更新',
      promptSave: '保存',
      promptReset: '恢复默认',
      promptResetAll: '全部恢复默认',
      promptGroupGeneral: '通用',
      promptGroupRp: 'RP（角色扮演）',
      promptGroupCoding: 'Coding（编码）',
      promptGroupGeneralHint: '所有会话都会用；变体缺失时回落到这里',
      promptGroupVariantHint: '只在该领域的会话生效',
      promptInherited: '沿用通用稿',
      promptScopePrivate: '私有记忆',
      promptDomainNew: '新类型名',
      promptDomainRemove: '删除这个类型页',
      promptDomainRemoveConfirm: '删除类型页 {name}？已写的这一页内容文件不会自动删除，但会从列表里消失。',
      promptPageEmpty: '这个类型页下没有提示词。只有分层提示词（指南、策略、整理）会按类型分开。',
      promptScopeGlobal: '全局记忆',
      variables: '变量',
      curation: '提炼全局记忆',
      startCuration: '开始提炼',
      noLiveSession: '没有活跃对话可作为 curator 的父会话。',
      privateMemory: '私有记忆',
      currentLibrary: '当前记忆库',
      domain: '领域',
      domainPromptHint: '决定这次对话的提示词与记忆过滤；写代码请选 Coding，角色扮演选 RP。',
      usePrivate: '使用私有记忆',
      useGlobal: '使用全局记忆',
      organize: '整理这次对话',
      initMemory: '初始化记忆库',
      noBinding: '这个对话还没有绑定记忆库。',
      unnamedLibrary: '未命名记忆库',
      needsWorkspaceFirst: '这个对话还没有选工作区文件夹。记忆库就是文件夹，请先在上方选择文件夹再初始化。',
      layerFolder: '文件夹',
      layerConversation: '当前对话',
      currentConversation: '当前对话',
      folderNoMemory: '这个文件夹没有启用记忆。到 设置 → 文件夹 里打开私人或全局记忆后，这里才会生效。',
      folderExpand: '展开这个文件夹下的对话',
      folderNoSessions: '这个文件夹下还没有记忆对话。',
      untitledSession: '未命名对话',
      folderSwitchOff: '这个文件夹已关闭该项记忆；先到 设置 → 文件夹 打开。',
      clampedNotice: '文件夹没有启用这一层记忆，开关无法打开。',
      noPrivate: '暂无私有记忆。',
      noGlobal: '暂无全局记忆。',
      archive: '归档',
      memoryPromptTitle: '这次对话要使用记忆吗？',
      memoryPromptBody: '记忆保存在 ~/.dsh/dsh-memu-memory/，删除对话不会删除记忆。',
      chooseLibrary: '选择已有记忆库',
      createLibrary: '新建记忆库',
      folderLibrary: '用文件夹自带的记忆库',
      memOffTitle: '不用记忆',
      memOffDesc: '这段对话什么都不记。已有记忆仍留在磁盘上，之后可以在侧边栏改。',
      memPrivateTitle: '只用私有记忆',
      memGlobalTitle: '只用全局记忆',
      memGlobalDesc: '不建私有记忆库，只用跨对话记住的偏好、工具和工作方式。',
      memPrivateDesc: '记住这段对话，并和这个文件夹下的其它对话共用同一个记忆库。',
      memBothTitle: '私有 + 全局',
      memBothDesc: '再加上跨对话记忆：你的偏好、工具链、工作方式。与私有记忆冲突时，以私有记忆为准。',
      memBlockedByFolder: '这个文件夹已关闭记忆——先到 设置 → 文件夹 打开。',
      advanced: '高级：换一个记忆库',
      rememberChoice: '记住我的选择，下次新对话直接用',
      confirm: '确定',
      later: '稍后',
      // —— 词典页 ——
      pageLexicon: '词典',
      descLexicon: '每个记忆库一本词典：黑话、梗、触发词与术语的释义、归档与命中统计。',
      lexiconScope: '词条管理',
      lexiconNoLibrary: '还没有记忆库；词典随私有记忆库创建。',
      lexiconTotal: '共 {total} 条',
      lexiconTerm: '词条',
      lexiconKind: '类型',
      lexiconAllKinds: '全部类型',
      lexiconKindSlang: '黑话',
      lexiconKindMeme: '梗',
      lexiconKindTrigger: '触发词',
      lexiconKindTerm: '术语',
      lexiconMeaning: '释义',
      lexiconUsage: '用法',
      lexiconAliases: '别名（逗号分隔）',
      lexiconExamples: '例句（每行一条）',
      lexiconSensitivity: '敏感度',
      lexiconSensitivityAll: '全部敏感度',
      lexiconNormal: '普通',
      lexiconSensitive: '敏感',
      lexiconStatus: '状态',
      lexiconAllStatus: '全部状态',
      lexiconStPending: '待审',
      lexiconStRejected: '已驳回',
      lexiconPending: '待审',
      lexiconApprove: '通过',
      lexiconReject: '驳回',
      lexiconHits: '命中次数',
      lexiconStrength: '强度',
      lexiconSourceMemory: '来源记忆 ↗',
      lexiconSearch: '搜索词条 / 释义 / 别名',
      lexiconNew: '新建词条',
      lexiconCreate: '写入词典',
      lexiconEdit: '编辑词条',
      lexiconSaveDone: '词条已保存。',
      lexiconReviewDone: '审核完成。',
      lexiconAddDone: '词条已写入。',
      lexiconDelete: '删除词条',
      lexiconDeleteHint: '删除是永久的：先点一下「删除词条」，再点「确认删除」。',
      lexiconDeleted: '已删除 {n} 条词条。',
      lexiconPrev: '上一页',
      lexiconNext: '下一页',
      lexiconPageOf: '第 {page} / {pages} 页',
      lexiconEmpty: '这个词库还没有词条。',
      lexiconNoMatch: '没有匹配的词条。',
      lexiconTabActive: '使用中 ({n})',
      lexiconTabArchived: '已归档 ({n})',
      lexiconArchivedEmpty: '没有已归档的词条。',
      lexiconArchive: '归档',
      lexiconRestore: '恢复',
      lexiconArchiveDone: '词条已归档，可随时恢复。',
      lexiconRestoreDone: '词条已恢复。',
      lexiconArchivedCount: '已归档 {n} 条词条。',
      lexiconRestoredCount: '已恢复 {n} 条词条。',
      lexiconCardUsage: '用法',
      lexiconCardAliases: '别名',
      loading: '加载中…',
      // ── 包 C/D/E 新增键（词典提案态 + 实体可见性 + 帮助页）──
      lexiconProposal: '提案',
      lexiconPendingEmpty: '没有待审的词条提案。',
      lexiconHitsDetail: '命中明细：候选 {candidate} · 注入 {injection} · 查询 {query}',
      orphanEntities: '未关联实体 ({n})',
      orphanPruneHint: '这些实体没有被任何记忆或关系引用，插件下次启动时会自动清理。',
      entityEmpty: '这个词库还没有实体。',
      firstRunTitle: '先建一个记忆库',
      firstRunDesc: '还没有任何记忆库。新建一个私有库后，会话里的记忆才有地方落。',
      firstRunGoLibraries: '去新建库',
      firstRunGuide: '查看快速上手',
      pageHelp: '帮助',
      descHelp: '快速上手、作用域/标注说明、常见问题与反馈入口',
      helpQuickStart: '快速开始',
      helpGoTo: '前往 →',
      helpStep1: '新建一个私有库：在「记忆库」页新建。成功时列表里出现当前项目的库，文件夹页也能看到它。',
      helpStep2: '在会话里绑定库：在对话中让助手调用 memu_bind（或发送 /memu 绑定），或在新会话卡里选定作用域。成功后侧栏会话卡显示已绑定这个库。',
      helpStep3: '选择注入模式：在设置的「注入模式」里选 smart（按需）/ anchor-only（只锚点）/ per-turn（每轮）/ off（关闭）。成功时状态卡显示已选模式，下一轮按它注入。',
      helpStep4: '在记忆页确认与修正：MemU 记忆页列出召回与写入的条目。点开抽屉看全文、改错字、归档不需要的内容；成功时改动立即生效。',
      helpStep5: '在词典页维护黑话：AI 写入的词条会自动 active 并参与注入；你可以编辑、归档/恢复、彻底删除，sensitive trigger 只能由你添加或修改。成功时词条出现在「使用中」，归档的进入「已归档」可恢复。',
      helpScopes: '私有与全局怎么判断',
      helpScopesDesc: '先看文件夹上限，再看本会话开关，最后得到生效作用域。',
      helpScopesChain: '判断顺序：工作区 → 文件夹策略（useLibrary / useGlobal 上限）→ 会话绑定（实际开关）→ effectiveScope。文件夹是天花板，会话只能在天花板以内生效。',
      helpScopesPrivate: '私有 = 本文件夹内所有会话共享同一个库：换对话仍读同一份，写入对所有会话可见，可编辑、归档与恢复。',
      helpScopesGlobal: '全局 = curator 在后台跨会话整理写入，按 domain 与 applies_to 过滤；界面上只读，只能复核、撤销合并或移除链接，不能手改正文。',
      helpScopesWhere: '在哪里改：文件夹页设上限；侧栏会话卡设本对话开关；全局页只审阅。',
      helpScopesPitfallsTitle: '常见误区',
      helpScopesPitfall1: '文件夹关掉全局后，会话无法再打开它——上限优先，开关会显示为禁用。',
      helpScopesPitfall2: '只开全局、不开私有的对话没有私有库，私有记忆工具会明确报错而不是凭空建库。',
      helpScopesPitfall3: '条目带上下文（频道/角色/世界线/分支/knownBy）时，不匹配的会话看不到它；这是过滤，不是丢失。',
      helpTitleCards: '标题卡与召回',
      helpTitleCardsBody: '锚点与本回合召回只显示标题卡：标题、标签和 id，正文不注入；全文仍在记忆页抽屉与召回工具里。',
      helpTitleCardsRecall: '标题是目录：用标题关键词，或标题卡里方括号内的 id 调 memu_private_recall / memu_global_recall，工具返回仍是全文。',
      helpTitleCardsRule: '标题写作：8–40 字，写具体的人/物/事件或结论（如「Yuike 名字来自小时候的白猫」），不要空标题或「关于XX的事」；细节放进 content。',
      helpArchiveDelete: '归档、删除与撤回',
      helpArchiveDeleteArchive: '归档 = 软删除：随时可恢复，关系与链接保留，不级联；条目移到「已归档」页签，不再注入。',
      helpArchiveDeleteDelete: '彻底删除：界面只对已归档条目开放，需两段确认，永久且不可撤销；会级联清掉指向它的入边，并清理因此孤立的实体。',
      helpArchiveDeleteLexicon: '词典同口径：归档可恢复，删除永久；模型没有删除或复核路径，sensitive 词条只有用户能改。',
      helpArchiveDeleteAbsorb: '合并（absorb）：合并稿成为新 active，目标标记 superseded，来源归档；在全局页对合并稿点「撤销合并」可整体撤回，全局链接也可逐条移除。',
      helpArchiveDeleteSessionGone: '删除的对话不会触发整理失败：扫描会标记 sessionGone 并跳过，不反复重试。',
      helpVector: '向量库',
      helpVectorSetup: 'memoryBackend=api + vectorSource=local 表示：MemU 负责存储与检索，本地受管 embedding 模型提供向量。到「连接与向量」选本地来源，并在同页的受管向量区下载运行时与模型，就绪后切换。',
      helpVectorCount: '「当前已入向量库 N 条」统计的是当前 active 代际里已有向量的条数；条目上的「已入向量库 · gN」是该条写入时的代际标签。',
      helpVectorFallback: '向量未激活（只有 requested 或重建失败）时，召回自动回退词法检索：仍然可用，只是语义匹配更弱。',
      helpVectorRebuild: '切换模型或修复失败要重建：新代际建成前旧代际保持只读，成功后的新记忆写入新代际；失败不会改当前代际，可以再点一次续建。',
      helpAutoLink: '私有自动关联与实体枢纽',
      helpAutoLinkRule: "先跑算法，不额外花模型 token：同库、同上下文/轨道、可见且非 secret 的两条记忆，若共享稀有名称/别名、内容不冲突，就直接建立 memory↔memory 链接并标 source:'auto'。",
      helpAutoLinkHub: '实体枢纽：「猫娘yuike」与「yuike名字的由来」共享 yuike，算法会复用或创建 yuike 实体，并把两条记忆连到它；人物/物品类型按保守信号推断。',
      helpAutoLinkWorker: '拿不准的候选交给本次整理 worker（memu_private_link_suggest）带证据裁决；不会另起一次完整整理，也不重读转录；没有候选就不连。',
      helpAutoLinkSafety: '自动关联只改图元数据：不改正文、不写向量、不删除。关系图显示「自动」标记和移除（×）；实体删除仍按既有规则。',
      helpLabels: '标注速查表',
      helpLabelsDesc: '记忆与关系图上会出现的标记。',
      helpLabelColLabel: '标注',
      helpLabelColMeaning: '含义',
      helpLabelSource: 'source',
      helpLabelSourceMeaning: '来源：inferred 推断 / user_said 用户原话（可引用）/ told 转述 / imagined 想象。imagined 不能当事实。',
      helpLabelLayer: 'layer',
      helpLabelLayerMeaning: '层级：must_remember 必记 / long_term 长期 / short_term 短期指针（只给指针，不含正文）。',
      helpLabelOpenLoop: 'open_loop',
      helpLabelOpenLoopMeaning: '未闭环：还有承诺或悬念没交代。',
      helpLabelMarginalized: 'marginalized',
      helpLabelMarginalizedMeaning: '已边缘化：移出主记忆但未删除，仍可检索。',
      helpLabelDate: 'date / anniversary',
      helpLabelDateMeaning: '日期：date 是一次性某天；anniversary 每年重复（生日/纪念日）。',
      helpLabelAttachment: '附件N',
      helpLabelAttachmentMeaning: '标题卡上的附件计数，不展开 caption；正文与图片在抽屉或工具里。',
      helpLabelVector: '已入向量库 · gN',
      helpLabelVectorMeaning: '该条已写入第 N 代向量空间；「当前已入向量库 N 条」统计 active 代际。',
      helpLabelReviewRisk: 'reviewRisk',
      helpLabelReviewRiskMeaning: '全局条目的复核风险分（0–2）；越高越可能进「待复核」，它不是置信度。',
      helpLabelLexicon: 'lexicon kind / sensitive / hitCount · 自动',
      helpLabelLexiconMeaning: '词典：kind 是词条类型；sensitive 仅用户可管；hitCount 是命中次数。关系图「自动」= 算法建立的链接。',
      helpSidebar: '侧边栏地图',
      helpSidebarDesc: '侧栏几个提醒与开关的位置。',
      helpSidebarAlerts: '「整理提醒」跨会话汇总整理结果：失败行需要处理，点 ↗ 打开该条记忆所在的库；「清除失败记录」只删失败日志，成功记录与其他日志不动。',
      helpSidebarReview: '「待复核」= pending_review：内容还没通过复核，所以不注入；侧栏统计只显示数量，审阅入口在「全局记忆」页的待复核队列（私有条目也在这里带「私有库」标签）。',
      helpSidebarRunLog: '「整理记录」列最近几次整理的状态、时间与消息；「整理提醒」展开后分失败/成功两列。',
      helpSidebarReviewMode: '审核模式开关在全局记忆页：「auto」只暂扣冲突、缺证据与高风险改写，「review-all」把所有内容操作送进复核。',
      helpSidebarFirstRun: '首次安装卡只在没有任何记忆库时出现；建好第一个库后自动消失，没有关闭按钮，也不写本地存储。',
      helpSidebarFallback: 'WebUI 若不允许「全部库」读取（宿主返回 403），记忆墙会退回第一个可访问的库并明确提示，不会整页空白；多库选项会禁用。',
      helpSidebarScope: '本对话的作用域卡在侧栏「记忆」页：顶部两层显示文件夹与会话，控制卡里是私有/全局开关，下方折叠卡可设频道/角色/世界线/分支。',
      helpFaq: '常见问题',
      helpFaq1: '为什么没有召回？',
      helpFaq1A: '按顺序检查：会话是否绑定库（memu_bind / /memu 绑定）；注入模式是否 off；文件夹或会话的私有/全局开关是否关掉；条目是否还在 active 且未被上下文（频道/角色/世界线/分支/knownBy）或 domain 过滤。本地向量未激活不会让召回消失，只会回退到词法。',
      helpFaq2: '私有库和全局记忆有什么区别？',
      helpFaq2A: '私有库由本文件夹所有会话共享，写入即可编辑、归档、恢复；全局由 curator 在后台跨会话整理写入，按 domain/applies_to 过滤，界面里只读，只能复核、撤销合并或移除链接。',
      helpFaq3: '为什么有些记忆不会被注入？',
      helpFaq3A: '常见原因：pending_review（等内容复核）、archived/suppressed/expired/superseded、visibility=secret（自动注入会跳过）、上下文或 domain 不匹配。词典条目没有 pending 复核：写入即 active，归档的才不注入。',
      helpFaq4: '为什么锚点只有标题？怎么拿到正文？',
      helpFaq4A: '锚点与本回合召回是目录：只给标题、标签和 id，避免挤占预算，也避免模型引用没拿到的原文。正文用 memu_private_recall / memu_global_recall 按标题关键词或 id 取，工具仍返回全文；也可在记忆页抽屉里直接读。',
      helpFaq5: '整理合并（absorb）之后，原来的条目去哪了？怎么撤销？',
      helpFaq5A: '合并不会删除任何东西：合并稿成为新的 active 条目，被吸收的来源归档、被取代的目标标记 superseded。在全局记忆页找到合并稿，点「撤销合并」即可整体恢复原状；全局链接也可以逐条移除。',
      helpFaq6: '词典为什么自动生效？怎么归档？为什么某条不注入？',
      helpFaq6A: '词典写入即 active，没有待审队列；归档会立即停止注入且可恢复，彻底删除只在管理面提供、不可撤销。词条不注入时检查是否已归档、上下文/可见性是否匹配。sensitive trigger 只有用户能改。',
      helpFaq7: '自动关联和实体枢纽怎么撤销？',
      helpFaq7A: '关系图里带「自动」的边是算法建立的：点旁边的 × 两段确认后即可移除。移除只改图元数据，不改正文、不写向量、不删记忆。实体删除沿用既有规则：被引用时默认拒绝，确认后才连同入边一起移除。',
      helpFaq8: '自动备份和导出 JSON/ZIP 有什么区别？',
      helpFaq8A: '自动备份是整机快照：插件状态、全局/私有索引、词典、提示词、附件引用与 MemU 数据库，外加逐文件校验和的 manifest；切换引擎/恢复前会自动做一份。导出 JSON/ZIP 是单库导出，ZIP 额外带图片附件；两种导出都能再导入回来。',
      helpFaq9: '删除的对话还会被整理吗？',
      helpFaq9A: '不会。会话被删除后，空闲整理扫描会把它标记为 sessionGone 并跳过，只记一条 check 级日志，不反复重试，也不影响其他会话的整理。',
      helpFaq10: '本地向量模型未激活怎么办？',
      helpFaq10A: '没有 active 向量代际时会回退词法检索，仍可用但语义更弱。「当前已入向量库 N 条」指 active 代际里的条数；切换模型或修复失败后要重建，旧代际在重建期间只读，失败不会动当前代际，可再点一次续建。',
      helpFeedback: '反馈',
      helpOpenIssue: '提交 Issue',
      helpCopyDiagnostics: '复制诊断信息',
      helpDocs: '打开文档',
    }

    const en = {
      inboundToolNames: 'External message tool allowlist',
      reviewResolution: 'Resolution',
      reviewReplace: 'Replace the old fact',
      reviewCoexist: 'Coexist under distinct conditions',
      reviewConditions: 'Explain distinct conditions (at least 8 characters)',
      pageMemories: 'MemU Memory',
      descMemories: 'Memories, provenance and status across libraries',
      pageLogs: 'Logs',
      descLogs: 'Recall, writes, consolidation and vector activity; filter, copy or download',
      logSearch: 'Search id / title / error',
      logRefresh: 'Refresh',
      logCopyAll: 'Copy all',
      logDownload: 'Download',
      logCopyOne: 'Copy',
      logLocate: 'Open memory',
      logEmpty: 'No matching log entries.',
      logAllKinds: 'All kinds',
      logKindRecall: 'Recall',
      logKindWrite: 'Write',
      logKindConsolidate: 'Consolidate',
      logKindCurate: 'Curate',
      logKindVector: 'Vector',
      logKindError: 'Error',
      logKindSystem: 'System',
      logKindCheck: 'Check',
      logClear: 'Clear log',
      runLogTitle: 'Runs',
      runLogEmpty: 'No runs recorded yet.',
      runLogOpen: 'All logs',
      dedupedNotice: 'Not written: the library already holds a near-identical memory [{id}]. Edit and merge into that entry instead; pass allow_duplicate only for two genuinely independent observations.',
      consolidateFeedTitle: 'Consolidation alerts',
      consolidateFailedCol: 'Failed',
      consolidateOkCol: 'Succeeded',
      consolidateFailed: 'Fail',
      consolidateDone: 'Done',
      consolidateFailedCount: '{n} failed',
      consolidateJumpHint: 'Open the library holding this memory in the memory studio',
      consolidateExpand: 'Expand',
      consolidateCollapse: 'Collapse',
      consolidateClear: 'Clear failures',
      consolidateClearHint: 'Deletes only failed consolidation logs; successes and other logs stay',
      consolidateCleared: 'Cleared {n} failure logs',
      allLibraries: 'All libraries',
      wallAllBlocked: 'This host only allows one library per read; showing the first library',
      linkCountTag: 'Links {n}',
      linkRemoved: 'Link removed',
      searchMemories: 'Search titles, content or tags',
      poolReview: 'Review',
      poolInactive: 'Inactive',
      wallReadError: 'Some libraries could not be read',
      wallLimit: 'Showing the latest 300 entries',
      wallScopePrivate: 'Private',
      wallScopeGlobal: 'Global',
      wallFilterScope: 'Scope',
      wallFilterStatus: 'Status',
      wallFilterLayer: 'Layer',
      wallAllLayers: 'All layers',
      multiSelect: 'Multi-select',
      wallSelected: '{n} selected',
      wallSelectAll: 'Select page',
      wallClearSelection: 'Clear selection',
      wallMultiExit: 'Exit select',
      viewMemory: 'View',
      entityDelete: 'Delete entity',
      entityDeleteForceHint: 'Still referenced by memories or relations; click again to delete with its links',
      openMemu: 'Open MemU WebUI',
      saved: 'Saved',
      copied: 'Copied',
      copyFailed: 'Copy failed; select the text manually',
      confirmAction: 'Confirm this action?',
      relationState: 'Current relationship',
      familiarity: 'Familiarity (blank = unknown)',
      trust: 'Trust (blank = unknown)',
      warmth: 'Warmth (blank = unknown)',
      boundaries: 'Boundaries (one per line)',
      callbacks: 'Callbacks (one per line)',
      openPromises: 'Open promises (one per line)',
      relationEvidence: 'Evidence memory',
      relationHistory: 'History',
      contextScope: 'Message and character scope',
      contextScopeHint: 'Leave blank for no isolation; a value limits recall to matching memories (nothing is deleted).',
      contextSave: 'Save scope',
      channelId: 'Group / channel ID',
      characterId: 'Current character ID',
      worldId: 'World ID',
      branchId: 'Story branch ID',
      exportZip: 'Export ZIP (with images)',
      exportStarted: 'Export started: {file}',
      memorySaved: 'Memory saved',
      memoryArchived: 'Memory archived',
      memoryRestored: 'Memory restored',
      memoryDeleted: 'Memory deleted',
      bulkDone: 'Bulk action finished: {n}',
      curatorReview: 'Curation review mode',
      descCuratorReview: 'How global curation writes: auto holds conflicts, missing evidence and risky rewrites for review; review-everything sends each content change to the review queue.',
      curatorReviewAuto: 'Auto (default)',
      curatorReviewAll: 'Review everything',
      archiveTooLarge: 'Attachment archive exceeds 16 MB; split it before importing',
      openSettings: 'Open settings',
      sidebarSettings: 'Keep full settings in the sidebar',
      visionCaptionEnabled: 'Allow sending images to the vision description service',
      visionService: 'Image description service (optional)',
      attachmentMissing: 'Attachment missing',
      relations: 'Relations',
      adjacency: 'Adjacency',
      graphView: 'Graph',
      viewMemories: 'Memories',
      viewRelations: 'Node graph',
      close: 'Close',
      openInBrowser: 'Open in the browser',
      globalReadOnly: 'Global memories are read-only here; edit them on the global page.',
      confidenceLabel: 'Confidence',
      tagsLabel: 'Tags',
      memoryMissing: 'This memory no longer exists.',
      focusMemory: 'Focus',
      relationKind: 'Relation kind',
      relationNote: 'Evidence (at least 8 characters)',
      relationTarget: 'Target',
      relationCreate: 'Link',
      relationRemove: 'Remove link',
      relationConfirm: 'Confirm removal?',
      entityNew: 'New entity',
      entityName: 'Entity name',
      entityAliases: 'Aliases (comma separated)',
      entityKind: 'Entity kind',
      graphEmpty: 'No connections yet',
      graphAutoLink: 'Auto',
      deletedNode: '[deleted]',
      graphLimited: 'Showing at most 200 nodes',
      graphFit: 'Fit graph',
      graphZoomIn: 'Zoom in',
      graphZoomOut: 'Zoom out',
      graphOptions: 'Graph settings',
      graphRepulsion: 'Repulsion',
      graphDistance: 'Link distance',
      graphLabels: 'Show labels',
      graphMotion: 'Live layout',
      graphLoadError: 'Graph failed to load. Retry',
      nav: 'MemU memory',
      guideDesc: 'Memory libraries, injection, and global memory',
      engine: 'MemU engine',
      engineReady: 'Ready',
      engineInstalling: 'Installing',
      engineError: 'Failed',
      engineIdle: 'Not installed',
      recommended: 'Recommended',
      current: 'Current',
      refresh: 'Refresh',
      warning: 'Unverified latest releases can change the CLI or break memory. Only the recommended version declared by the plugin is installed.',
      memorySettings: 'Memory settings',
      settingsTuning: 'Injection & recall',
      autoInject: 'Injection mode',
      privateTopK: 'Private topK',
      globalTopK: 'Global topK',
      mustRememberCap: 'Permanent memory cap',
      shortTermTtlHours: 'Short-term TTL in hours (0=off)',
      anchorTokens: 'Anchor tokens',
      turnTokens: 'Recall tokens',
      injectionTotalTokens: 'Injection total tokens',
      dedupeTurns: 'Dedupe turns',
      globalEveryNTurns: 'Global every N turns',
      minUserChars: 'Min user chars',
      randomCueChance: 'Random cue chance',
      autoInstall: 'Auto-install engine',
      sleepConsolidation: 'Consolidate after idle',
      sleepAfterIdleMinutes: 'Idle minutes before consolidating',
      autoCurateEveryHours: 'Auto global curation every N hours (0=off)',
      autoCurateSessionLimit: 'Max conversations per auto run',
      memoryMode: 'MemU storage mode',
      memoryModeHint: 'local keeps memory on this machine; cloud hands storage to the MemU backend and needs vendor credentials in ~/.memu/config.env.',
      memoryBackend: 'Memory backend',
      backendAgent: 'Local (session agent)',
      backendApi: 'Enable vector store',
      backendAgentHint: 'The session agent summarizes and writes through the local JSON/index path; no MemU, worker, or embedding is enabled.',
      backendApiHint: 'Enable the vector store, then choose a managed local model or API embedding; MemU storage and retrieval remain local.',
      vectorSource: 'Embedding source',
      vectorSourceLocal: 'Local',
      vectorSourceApi: 'API',
      vectorSourceHint: 'Local uses the verified loopback embedding worker; API uses the MemU embedding service configured below.',
      managedVectorStatus: 'Status',
      managedVectorDownloading: 'Downloading',
      managedVectorVerifying: 'Verifying',
      managedVectorFailed: 'Failed',
      managedVectorProgress: 'Download progress',
      managedVectorCurrent: 'Current file',
      managedVectorRetry: 'Retry',
      managedVectorRebuilding: 'Rebuilding',
      managedVectorGeneration: 'Generation',
      managedVectorNoCatalog: 'The model catalog is temporarily unavailable. Refresh and try again.',
      engineLatestVersions: 'Latest versions',
      engineLatestHint: 'Queried from PyPI. The plugin still installs only its declared recommended version.',
      engineQueryVersions: 'Check latest',
      engineQuerying: 'Checking…',
      engineQueryFailed: 'Check failed; retry later',
      engineLatestTag: 'latest',
      habitsInjection: 'Domestic texture (sense of the hour)',
      decay: 'Remaining strength',
      accessed: 'Last recalled',
      neverAccessed: 'Never recalled yet',
      peakTag: 'peak',
      anniversaryTag: 'anniversary',
      dueDateTag: 'date',
      salientDateLabel: 'Date (MM-DD recurs yearly, YYYY-MM-DD is one-off)',
      salientDatePlaceholder: 'e.g. 10-29 or 2026-10-29; empty for no date',
      moodTag: 'mood',
      reviews: 'Awaiting review',
      reviewsEmpty: 'No memories are waiting for review.',
      reviewScopePrivate: 'private library',
      // Package F2: set-absorb (absorb) review and undo.
      absorbTag: 'Set absorb · {n} entries',
      absorbSourcesTag: 'Merged memory · {n} sources',
      absorbUndo: 'Undo merge',
      absorbUndone: 'Merge undone; source memories restored',
      absorbSourcesLabel: 'Absorbed sources',
      absorbLinksLabel: 'Linked memories',
      accuracyTag: 'details may be off',
      accept: 'Accept',
      reject: 'Discard',
      reviewReason: 'Reason',
      noMemoriesView: 'This library is empty. Let the agent note something in a conversation, or write one above.',
      browseActiveTab: 'Active',
      browseArchivedTab: 'Archived',
      browseArchivedEmpty: 'No archived memories in this library. Archiving takes a memory out of injection and recall but keeps the body — this is where it gets cleaned up.',
      browseArchivedHint: 'Deleting is permanent: the body leaves the index and the engine together, and cannot be recalled or restored afterwards. The first click only arms it; the second one deletes.',
      deleteForever: 'Delete',
      confirmDelete: 'Delete for good',
      cancelDelete: 'Cancel',
      descOverview: 'MemU / Python engine installation, repair, versions, and backups.',
      descConnection: 'Choose lexical or vector recall. Local vectors require separate runtime and model downloads before switching and rebuilding.',
      descSettings: 'Injection cadence, recall depth, decay, and automation.',
      descLibraries: 'Conversations in the same folder share one library; deleting a conversation never deletes memory.',
      descBrowser: 'Browse, write, edit, archive, and export memories per library.',
      descGlobal: 'Cross-conversation memory distilled by a non-main curator agent.',
      descPrompts: 'Memory prompts are editable, restorable, and update with the plugin version.',
      pageFolders: 'Folders',
      descFolders: 'Two switches per workspace folder: Private memory decides whether conversations in this folder share one local library; Global memory decides whether cross-conversation memory is injected. Turning either off never deletes existing memories.',
      folderPrivate: 'Private',
      folderGlobal: 'Global',
      folderNoLibrary: 'No private library yet',
      folderMissing: 'No longer a DSH workspace',
      folderEmpty: 'No workspace folders yet. Add one in DSH and its memory switches will appear here.',
      folderPrivateHint: 'Let conversations in this folder share one private library',
      folderGlobalHint: 'Let conversations in this folder read global memory',
      folderSaveFailed: 'Save failed',
      installStep: 'Current step',
      installElapsed: 'Elapsed',
      installLog: 'Install log',
      stepResolvingPython: 'Resolving Python',
      stepCreatingVenv: 'Creating venv',
      stepInstallingDeps: 'Installing dependencies',
      stepVerifying: 'Verifying CLI',
      stepBackingUp: 'Backing up memory',
      stepReady: 'Done',
      stepFailed: 'Failed',
      newSessionPrompt: 'New-session prompt',
      embedding: 'MemU Embedding',
      embedSource: 'Embedding endpoint',
      embedSourceLocal: 'Local',
      embedSourceRemote: 'Remote',
      embedSourceLocalHint: 'An OpenAI-compatible embedding server on this machine (for example Ollama: {url}, model {model}). DSH has no embedding capability of its own, so "local" still requires you to run that service; no vendor API key is needed.',
      managedVector: 'Managed local vector model',
      managedVectorHint: 'Download pinned artifacts into plugin data; selection only records a pending profile. Switching rebuilds a new vector space and keeps the old one.',
      managedVectorDownload: 'Download and verify',
      managedVectorSelect: 'Select pending',
      managedVectorSwitch: 'Switch and rebuild',
      managedVectorRollback: 'Rollback previous space',
      managedVectorTest: 'Test active model',
      managedVectorActive: 'Active',
      managedVectorRequested: 'Pending switch',
      managedVectorInstalled: 'Installed',
      managedVectorPending: 'Pending verification',
      managedVectorUnavailable: 'Unavailable',
      managedVectorSizePending: 'Size pending verification',
      managedVectorFailure: 'Switch failed',
      managedVectorRuntimeHint: 'No verified local runtime was found. Download runtime fetches the pinned artifacts from the catalog into plugin data; no DSH_MEMU_EMBED_RUNTIME_DIR and no Ollama needed.',
      managedVectorRuntimeMissing: 'Runtime not installed',
      managedVectorRuntimeInstalling: 'Installing runtime',
      managedVectorRuntimeInstalled: 'Runtime ready (managed)',
      managedVectorRuntimeConfigured: 'Runtime ready (environment variable)',
      managedVectorRuntimeFailed: 'Runtime install failed',
      managedVectorRuntimeUnsupported: 'No verified runtime artifacts for this platform',
      managedVectorRuntimeInstall: 'Download runtime',
      managedVectorRuntimeTitle: 'Runtime',
      managedVectorModelsTitle: 'Models',
      managedVectorReady: 'Ready',
      vectorRebuildTitle: 'Rebuild progress',
      vectorStagePreparing: 'Preparing',
      vectorStagePrepared: 'Prepared',
      vectorStageSyncing: 'Writing vectors',
      vectorStageSwitching: 'Switching',
      vectorStageFailed: 'Failed',
      vectorStageCommitted: 'Switched',
      managedVectorCommitted: 'Written',
      managedVectorSkipped: 'Skipped',
      managedVectorFailedCount: 'Failed',
      vectorSwitchDoneHint: 'New memories are written into this vector space; recall now uses it.',
      vectorAbortedHint: 'The rebuild stopped; the active space is unchanged. Retry to resume.',
      managedVectorAborted: 'Stopped',
      vectorRouteLabel: 'Recall route',
      vectorRouteLocal: 'Local vectors',
      vectorRouteRemote: 'Remote vectors',
      vectorRouteLexical: 'Lexical',
      vectorIndexedTag: 'In vector store',
      vectorIndexedMigrated: 'In vector store (from rebuild)',
      vectorIndexedNow: 'Currently indexed',
      vectorIndexedUnit: 'items',
      vectorSwitchWrote: 'Written during switch',
      managedVectorConfirmDownload: 'Download and verify this model artifact? Download the runtime separately.',
      managedVectorPrerequisites: 'Install the MemU engine → download the runtime → download and select a verified model → switch and rebuild. Keep lexical recall until ready; no Ollama or manual environment variable is needed.',
      managedVectorSwitchBlocked: 'Download a verified runtime, then download and select a model before switching.',
      managedVectorConfirmSwitch: 'Switch now? This rebuilds a new vector space and briefly freezes writes.',
      managedVectorConfirmRollback: 'Roll back to the previous vector space?',
      managedVectorRetention: 'At most 3 complete backups are kept; older complete backups are cleaned up automatically.',
      embedSourceRemoteHint: 'Call a third-party embedding service with the provider / Base URL / API Key you enter.',
      embedKeyNotNeeded: 'No API key needed for a local embedding server',
      embedKeyRemoteHint: 'Only remote embedding services require an API key',
      testConnectionHint: 'Cannot reach the embedding server at {url}. Start it first (for example: ollama serve) and pull {model}; this is unrelated to the API key.',
      embedSourceSwitched: 'Embedding endpoint switched',
      provider: 'Provider',
      model: 'Embedding model',
      baseUrl: 'Base URL',
      apiKey: 'API Key',
      keyConfigured: 'Configured; leave blank to keep',
      keyMissing: 'Not configured',
      saveConfig: 'Save config',
      testConfig: 'Test',
      clearKey: 'Clear key',
      summaryHint: 'Remote summary: memories are written by the remote model configured here, which must expose an OpenAI-compatible /chat/completions endpoint. Blank fields fall back to the provider/key above.',
      summaryModel: 'Summary model',
      summaryBaseUrl: 'Summary base URL',
      summaryApiKey: 'Summary API key',
      testOk: 'Test passed',
      configPath: 'Config file',
      configSaved: 'Saved',
      pageOverview: 'MemU engine',
      pageConnection: 'Connection & vectors',
      pageSettings: 'Memory settings',
      pageLibraries: 'Libraries',
      pageGlobal: 'Global memory',
      pagePrompts: 'Prompts',
      pageStats: 'Stats',
      descStats: 'Whether this library is growing or sleeping, which memories were never recalled, and whether you write more than you use.',
      statsWindow: 'Last {days} days',
      statsScope: 'Scope',
      statsWritten: 'Written',
      statsInjected: 'Injected',
      statsRecalled: 'Recalled',
      statsArchived: 'Archived',
      statsActivity: 'Activity',
      statsActivityHint: 'How many memories reached the context each day. A blank day is not an error — nothing was written and nothing came up.',
      statsActivityEmpty: 'No memory reached the context in this window.',
      statsDistribution: 'Hit distribution',
      statsDistributionHint: 'One dot per memory: further right means older, further up means injected more often. The cloud in the bottom-right is the archive shortlist.',
      statsDistributionEmpty: 'Nothing to plot yet.',
      statsScatterIdle: 'No memory has been injected yet. Once recall surfaces one, the distribution appears here.',
      statsHealth: 'Library health',
      statsActive: 'Live',
      statsAvgStrength: 'Mean remaining strength',
      statsStale: 'Longest not thought of',
      statsStaleEmpty: 'Every memory is still being recalled.',
      statsStaleDays: '{days} days untouched',
      statsStaleToday: 'Touched today',
      statsRatio: 'Write/read ratio',
      statsRatioHint: 'Written against injected over the last 7 days. A ratio above 1 for long means writing more than you use — time to tighten the prompts.',
      statsRatioBusy: 'Writing more than reading',
      statsUnavailable: 'The statistics file could not be read (the original is kept), so this library has no numbers right now. Memories are unaffected.',
      statsNoLibrary: 'No library yet; statistics start with the first memory.',
      statsShown: 'Showing {shown} / {total}',
      pageConfig: 'Settings',
      openWebUi: 'WebUI',
      openWebUiHint: 'Open the full WebUI — memories, engine, settings, folders and prompts (opens in-app when the browser blocks a new tab)',
      pageBinding: 'This chat',
      pagePrivate: 'Private',
      pageBrowser: 'Memory browser',
      browser: 'Memory browser',
      reload: 'Load',
      browse: 'Browse',
      export: 'Export JSON',
      importJson: 'Import JSON',
      importHint: 'Import exported JSON or an image ZIP. Duplicate and inactive entries are skipped; entries an older export scoped to one conversation are imported as shared and listed separately in the report (add context fields to narrow them).',
      importDone: 'Imported (added / skipped)',
      importAdjusted: 'adjusted to the current semantics',
      importEngineWarning: 'Memories are in the index, but the engine commit failed, so semantic recall cannot see them yet',
      newMemory: 'New memory',
      memoryTitle: 'Title (optional)',
      memoryContent: 'Memory content',
      add: 'Write',
      browserIndexOnly: 'Showing the local index, the authoritative copy.',
      layerLongTerm: 'Long-term',
      layerAnchor: 'Anchor',
      layerMustRemember: 'Permanent',
      stActive: 'Active',
      stArchived: 'Archived',
      stSuppressed: 'Suppressed',
      stSuperseded: 'Superseded',
      stPendingReview: 'Needs review',
      dmGeneral: 'General',
      dmCoding: 'Coding',
      dmRp: 'Roleplay',
      dmMixed: 'Mixed',
      dmUniversal: 'Universal',
      dmPersonal: 'Personal',
      dmOther: 'Other',
      dmUnknown: 'Unknown',
      dmProjectPrefix: 'Project: ',
      modeSmart: 'Smart (max once per turn)',
      modeAnchor: 'Anchor only',
      modePerTurn: 'Recall every turn',
      modeOff: 'Off',
      marginalizedTag: 'marginalized',
      openLoopTag: 'open loop',
      layerShortTerm: 'Short-term',
      stExpired: 'expired',
      discCanTell: 'may say',
      discOnlyIfAsked: 'only if asked',
      discNeverSay: 'never out loud',
      ownerMe: 'me',
      ownerUs: 'us',
      ownerAboutUser: 'about them',
      ownerAboutProject: 'about project',
      visShared: 'shared',
      visSecret: 'secret',
      sourceUserSaid: 'their words',
      sourceInferred: 'inferred',
      sourceImagined: 'made up',
      sourceTold: 'relayed',
      disclosureLabel: 'Disclosure',
      sourceLabel: 'Source',
      ownerLabel: 'Owner',
      visibilityLabel: 'Visibility',
      relevanceThreshold: 'Min relevance (relative to top hit, 0 = off)',
      shortTermExpires: 'expires',
      engineIsInstalled: 'Installed and ready',
      engineNotInstalled: 'Not installed',
      engineVersionHistory: 'Installed versions',
      engineCurrentTag: 'In use',
      engineRecommendedTag: 'Recommended',
      engineNotInstalledRow: 'No runtime for this version on this machine',
      engineSwitchTo: 'Switch to this version',
      engineSwitchConfirm: 'Switch to {version}?\n\nMemory data is backed up first. The switch is aborted if that version fails its self-check.',
      engineSwitchBlocked: 'Only an already-installed version can be switched to. Use "{action}" to install the recommended version.',
      engineRepair: 'Repair',
      engineInstall: 'Install',
      engineSourceLabel: 'Index',
      engineInstalledAt: 'Installed',
      archivedLibraries: 'Archived libraries',
      noArchived: 'No archived libraries.',
      archivedHint: 'A library is archived when its folder leaves DSH or disappears from this machine. Memory is never deleted automatically — delete it by hand, or set an auto-delete age.',
      restore: 'Restore',
      deleteForever: 'Delete forever',
      deleteLibraryConfirm: 'Permanently delete {name}? This removes its MemU database and index and cannot be undone.',
      scopeMissing: 'Folder missing',
      purgeArchivedAfterDays: 'Archive cleanup review after days (0=off)',
      engineVersionHint: 'Older engines stay on this machine after a plugin upgrade, so you can roll back. A switch backs up first and self-checks the target.',
      engineNoVersions: 'Nothing installed yet — use Install to get the recommended version.',
      engineUsableTag: 'usable',
      engineBrokenTag: 'probe failed',
      engineUnprobedTag: 'not probed',
      engineProbedAt: 'probed',
      engineRemoveVersion: 'Remove',
      engineRemoveConfirm: 'Remove version {version}? Only the local engine directory is deleted; memory data is untouched.',
      enginePrune: 'Prune old versions',
      enginePruneDone: 'Removed {removed} old version(s), kept {kept}.',
      backups: 'Backups',
      descBackups: 'A backup is taken automatically before an engine switch and before a restore. It contains state.json, index/*.json, the prompt manifest and engine info, with sha256 checksums.',
      noBackups: 'No backups yet.',
      backupNoManifest: 'legacy backup (no checksums)',
      backupRestore: 'Restore',
      backupDelete: 'Delete',
      backupDeleteConfirm: 'Delete backup {name}? The directory is removed permanently and cannot be undone.',
      backupRestoreConfirm: 'Overwrite current data with backup {name}? Current data is backed up first.',
      backupRestored: 'Restored; data reloaded.',
      organizedRemote: 'Remote model consolidated and wrote {count} memories',
      organizedAgent: 'Consolidating in a background fork; your own chat gets no extra turn',
      save: 'Save',
      settingsReset: 'Reset defaults',
      settingsResetConfirm: 'Confirm reset?',
      libraries: 'Libraries',
      noLibraries: 'No memory libraries yet.',
      newLibrary: 'New library',
      name: 'Name',
      create: 'Create',
      scope: 'Folder',
      privateCount: 'Private',
      pinned: 'Permanent',
      bound: 'Sessions',
      globalMemory: 'Global memory',
      prompts: 'Prompts',
      promptCustom: 'Custom',
      promptDefault: 'Default',
      promptUpdated: 'Default changed',
      promptSave: 'Save',
      promptReset: 'Reset',
      promptResetAll: 'Reset all',
      promptGroupGeneral: 'General',
      promptGroupRp: 'RP (roleplay)',
      promptGroupCoding: 'Coding',
      promptGroupGeneralHint: 'Used by every conversation; variants fall back here',
      promptGroupVariantHint: 'Only used by conversations in this domain',
      promptInherited: 'follows general',
      promptScopePrivate: 'Private memory',
      promptDomainNew: 'New type',
      promptDomainRemove: 'Delete this type page',
      promptDomainRemoveConfirm: 'Delete type page {name}? Files already written for it stay on disk but it leaves the list.',
      promptPageEmpty: 'No prompts in this type page. Only the layered prompts (guide, policy, consolidation) are split by type.',
      promptScopeGlobal: 'Global memory',
      variables: 'Variables',
      curation: 'Extract global memory',
      startCuration: 'Start',
      noLiveSession: 'No live conversation available as the curator parent.',
      privateMemory: 'Private memory',
      currentLibrary: 'Current library',
      domain: 'Domain',
      domainPromptHint: 'Chooses this conversation\'s prompt variant and memory filter. Pick Coding for engineering work, RP for roleplay.',
      usePrivate: 'Use private memory',
      useGlobal: 'Use global memory',
      organize: 'Organize this conversation',
      initMemory: 'Initialize memory',
      noBinding: 'This conversation is not bound to a memory library.',
      unnamedLibrary: 'Unnamed library',
      needsWorkspaceFirst: 'This conversation has no workspace folder yet. A library is a folder — pick one above before initializing.',
      layerFolder: 'Folder',
      layerConversation: 'Conversation',
      currentConversation: 'This conversation',
      folderNoMemory: 'Memory is off for this folder. Turn on private or global memory in Settings → Folders to use it here.',
      folderExpand: 'Show the conversations in this folder',
      folderNoSessions: 'No memory conversations in this folder yet.',
      untitledSession: 'Untitled conversation',
      folderSwitchOff: 'This folder has this layer switched off. Enable it in Settings → Folders first.',
      clampedNotice: 'The folder has this memory layer off, so the switch cannot be turned on.',
      noPrivate: 'No private memories.',
      noGlobal: 'No global memories.',
      archive: 'Archive',
      memoryPromptTitle: 'Use memory for this conversation?',
      memoryPromptBody: 'Memory is stored in ~/.dsh/dsh-memu-memory/. Deleting the conversation does not delete memory.',
      chooseLibrary: 'Choose an existing library',
      createLibrary: 'Create a new library',
      folderLibrary: "Use this folder's library",
      memOffTitle: 'No memory',
      memOffDesc: 'This conversation keeps nothing. Existing memories stay on disk and the setting can be changed later in the sidebar.',
      memPrivateTitle: 'Private memory only',
      memGlobalTitle: 'Global memory only',
      memGlobalDesc: 'No private library for this conversation; only the cross-conversation layer (preferences, tooling, working style).',
      memPrivateDesc: 'Remembers this conversation, and shares the memory library of this folder with other chats in it.',
      memBothTitle: 'Private + global',
      memBothDesc: 'Adds cross-conversation memory for your preferences, tooling and working style. Private memory still wins on conflict.',
      memBlockedByFolder: 'This folder has memory switched off — enable it in Settings → Folders first.',
      advanced: 'Advanced: use a different library',
      rememberChoice: 'Remember this choice for new conversations',
      confirm: 'Confirm',
      later: 'Later',
      // —— Lexicon page ——
      pageLexicon: 'Lexicon',
      descLexicon: 'One lexicon per memory library: slang, memes, triggers and terms with meanings, archive and hit counts.',
      lexiconScope: 'Terms',
      lexiconNoLibrary: 'No memory libraries yet; a lexicon comes with each private library.',
      lexiconTotal: '{total} terms',
      lexiconTerm: 'Term',
      lexiconKind: 'Kind',
      lexiconAllKinds: 'All kinds',
      lexiconKindSlang: 'Slang',
      lexiconKindMeme: 'Meme',
      lexiconKindTrigger: 'Trigger',
      lexiconKindTerm: 'Term',
      lexiconMeaning: 'Meaning',
      lexiconUsage: 'Usage',
      lexiconAliases: 'Aliases (comma separated)',
      lexiconExamples: 'Examples (one per line)',
      lexiconSensitivity: 'Sensitivity',
      lexiconSensitivityAll: 'All sensitivities',
      lexiconNormal: 'Normal',
      lexiconSensitive: 'Sensitive',
      lexiconStatus: 'Status',
      lexiconAllStatus: 'All statuses',
      lexiconStPending: 'Pending',
      lexiconStRejected: 'Rejected',
      lexiconPending: 'Pending',
      lexiconApprove: 'Approve',
      lexiconReject: 'Reject',
      lexiconHits: 'Hits',
      lexiconStrength: 'Strength',
      lexiconSourceMemory: 'Source memory ↗',
      lexiconSearch: 'Search terms / meanings / aliases',
      lexiconNew: 'New term',
      lexiconCreate: 'Add to lexicon',
      lexiconEdit: 'Edit term',
      lexiconSaveDone: 'Term saved.',
      lexiconReviewDone: 'Review recorded.',
      lexiconAddDone: 'Term added.',
      lexiconDelete: 'Delete terms',
      lexiconDeleteHint: 'Deletion is permanent: click "Delete terms" once, then confirm.',
      lexiconDeleted: 'Deleted {n} terms.',
      lexiconPrev: 'Previous',
      lexiconNext: 'Next',
      lexiconPageOf: 'Page {page} / {pages}',
      lexiconEmpty: 'This lexicon has no terms yet.',
      lexiconNoMatch: 'No matching terms.',
      lexiconTabActive: 'In use ({n})',
      lexiconTabArchived: 'Archived ({n})',
      lexiconArchivedEmpty: 'No archived terms.',
      lexiconArchive: 'Archive',
      lexiconRestore: 'Restore',
      lexiconArchiveDone: 'Term archived — you can restore it anytime.',
      lexiconRestoreDone: 'Term restored.',
      lexiconArchivedCount: 'Archived {n} term(s).',
      lexiconRestoredCount: 'Restored {n} term(s).',
      lexiconCardUsage: 'Usage',
      lexiconCardAliases: 'Aliases',
      loading: 'Loading…',
      // ── Package C/D/E keys (lexicon proposals + entity visibility + help page) ──
      lexiconProposal: 'Proposal',
      lexiconPendingEmpty: 'No pending term proposals.',
      lexiconHitsDetail: 'Hit detail: {candidate} candidates · {injection} injections · {query} queries',
      orphanEntities: 'Unlinked entities ({n})',
      orphanPruneHint: 'No memory or relationship references these entities; the plugin cleans them up automatically at the next startup.',
      entityEmpty: 'No entities in this library yet.',
      firstRunTitle: 'Create a memory library first',
      firstRunDesc: 'There are no libraries yet. Memories from your conversations need one to land in.',
      firstRunGoLibraries: 'Create a library',
      firstRunGuide: 'Quick start guide',
      pageHelp: 'Help',
      descHelp: 'Quick start, scope and label reference, FAQ and feedback',
      helpQuickStart: 'Quick start',
      helpGoTo: 'Go →',
      helpStep1: 'Create a private library: create one on the Libraries page. Success looks like the project library in the list, and the folders page showing it too.',
      helpStep2: 'Bind the library in the conversation: ask the assistant to call memu_bind (or send the /memu bind command), or pick the scope in the new-session card. Success looks like the sidebar session card naming this library.',
      helpStep3: 'Pick an injection mode: in Settings → Injection mode choose smart (on demand), anchor-only (anchor only), per-turn (every turn) or off. Success looks like the status card showing the chosen mode and the next turn following it.',
      helpStep4: 'Confirm and correct on the memory page: the MemU memory page lists recalled and written entries. Open the drawer for the full text, fix mistakes, archive what you do not need; changes take effect immediately.',
      helpStep5: 'Maintain slang on the lexicon page: entries the AI writes become active automatically and join injection; you can edit, archive/restore and permanently delete, and sensitive triggers are user-only. Success looks like the term under "In use", with archived ones restorable under "Archived".',
      helpScopes: 'Private vs global',
      helpScopesDesc: 'The folder sets the ceiling, the conversation sets the switches.',
      helpScopesChain: 'Decision order: workspace → folder policy (useLibrary / useGlobal ceilings) → session binding (actual switches) → effectiveScope. The folder is a ceiling; a conversation can only work within it.',
      helpScopesPrivate: 'Private = every conversation in this folder shares one library: another chat in the same folder reads the same entries, writes are visible to all of them, and entries stay editable, archivable and restorable.',
      helpScopesGlobal: 'Global = the curator consolidates across conversations in the background and writes it, filtered by domain and applies_to; in the UI it is read-only — review, undo a merge or remove a link, never hand-edit the body.',
      helpScopesWhere: 'Where to change it: the folders page sets the ceilings; the sidebar session card sets this conversation; the global page only reviews.',
      helpScopesPitfallsTitle: 'Common pitfalls',
      helpScopesPitfall1: 'With global off in the folder, a conversation cannot turn it back on — the ceiling wins and the switch is shown disabled.',
      helpScopesPitfall2: 'A conversation with global only has no private library; private-memory tools say so instead of creating one silently.',
      helpScopesPitfall3: 'Entries carrying context (channel / character / world / branch / knownBy) stay hidden from conversations that do not match; that is filtering, not loss.',
      helpTitleCards: 'Title cards and recall',
      helpTitleCardsBody: 'The anchor and per-turn recall show title cards only: title, tags and id; bodies are not injected. The full text still lives in the memory drawer and the recall tools.',
      helpTitleCardsRecall: 'The title is a directory: recall by title keyword, or by the id shown in brackets on the card, with memu_private_recall / memu_global_recall; the tools still return the full text.',
      helpTitleCardsRule: 'Title rule: 8–40 characters naming the concrete person/object/event or conclusion ("Yuike is named after a childhood white cat"); no empty titles or "about X" labels; details belong in content.',
      helpArchiveDelete: 'Archive, delete and undo',
      helpArchiveDeleteArchive: 'Archive = soft delete: restorable at any time, links and relationships kept, no cascade; the entry moves to the "Archived" tab and stops being injected.',
      helpArchiveDeleteDelete: 'Permanent delete: the UI offers it only for archived entries, with a two-step confirmation. It is final and also removes inbound links to the entry and prunes entities left orphaned by it.',
      helpArchiveDeleteLexicon: 'The lexicon follows the same rules: archive is restorable, delete is permanent; the model has no delete or review path, and sensitive terms stay user-managed.',
      helpArchiveDeleteAbsorb: 'Absorb: the merged entry becomes active, the target is marked superseded and the sources are archived. On the global page press "Undo merge" on the merged entry to roll it all back; global links can also be removed one by one.',
      helpArchiveDeleteSessionGone: 'A deleted conversation never fails consolidation: the sweep marks it sessionGone and skips it instead of retrying forever.',
      helpVector: 'Vector store',
      helpVectorSetup: 'memoryBackend=api with vectorSource=local means MemU keeps storing and retrieving locally while a managed embedding model supplies the vectors. Pick the local source on "Connection & vectors", then download the runtime and model in the managed-vector area on the same page and switch.',
      helpVectorCount: '"Currently indexed N items" counts entries that already have vectors in the active generation; "In vector store · gN" on an entry is the generation tag it was written into.',
      helpVectorFallback: 'With no active generation (only requested, or a failed rebuild) recall falls back to lexical search: still usable, weaker semantics.',
      helpVectorRebuild: 'Rebuild when switching models or repairing a failure: the old generation stays read-only until the new one commits, and new memories then go to the new generation. A failed rebuild leaves the active generation unchanged; press again to resume.',
      helpAutoLink: 'Private auto-links and entity hubs',
      helpAutoLinkRule: "Algorithm first, zero extra model tokens: two memories in the same library, same context/track, visible and not secret, sharing a rare name/alias and not conflicting are linked memory↔memory with source:'auto'.",
      helpAutoLinkHub: 'Entity hub: "猫娘yuike" and "yuike名字的由来" share yuike, so the algorithm reuses or creates a yuike entity and links both memories to it; person/thing kind is inferred conservatively.',
      helpAutoLinkWorker: 'Uncertain candidates go to the current consolidation worker (memu_private_link_suggest), which adjudicates with evidence; it never starts another full consolidation or rereads the transcript, and no candidates means no links.',
      helpAutoLinkSafety: 'Auto-links only add graph metadata: no body changes, no vectors, no deletion. The graph shows an "Auto" badge and a remove (×); entity deletion still follows the existing rules.',
      helpLabels: 'Label cheat sheet',
      helpLabelsDesc: 'Badges you will see on memories and in the relationship graph.',
      helpLabelColLabel: 'Label',
      helpLabelColMeaning: 'Meaning',
      helpLabelSource: 'source',
      helpLabelSourceMeaning: 'Provenance: inferred / user_said (quotable) / told / imagined. imagined must never be treated as fact.',
      helpLabelLayer: 'layer',
      helpLabelLayerMeaning: 'Layer: must_remember / long_term / short_term pointer (a pointer only, no body).',
      helpLabelOpenLoop: 'open_loop',
      helpLabelOpenLoopMeaning: 'Open loop: a promise or suspense line is still unresolved.',
      helpLabelMarginalized: 'marginalized',
      helpLabelMarginalizedMeaning: 'Marginalized: pulled out of primary memory but not deleted; still searchable.',
      helpLabelDate: 'date / anniversary',
      helpLabelDateMeaning: 'Date: date is one specific day; anniversary repeats every year (birthday / memorial).',
      helpLabelAttachment: '附件N',
      helpLabelAttachmentMeaning: 'Attachment count on a title card; captions are not expanded there — body and images live in the drawer or tools.',
      helpLabelVector: 'In vector store · gN',
      helpLabelVectorMeaning: 'The entry is in generation N of the vector space; "Currently indexed N items" counts the active generation.',
      helpLabelReviewRisk: 'reviewRisk',
      helpLabelReviewRiskMeaning: 'Review risk score (0–2) for global entries; higher means more likely held for review. It is not confidence.',
      helpLabelLexicon: 'lexicon kind / sensitive / hitCount · Auto',
      helpLabelLexiconMeaning: 'Lexicon: kind is the term type; sensitive is user-managed; hitCount is how often it hit. Graph "Auto" = an algorithm-created link.',
      helpSidebar: 'Sidebar map',
      helpSidebarDesc: 'Where the reminders and switches live in the sidebar.',
      helpSidebarAlerts: 'Consolidation alerts aggregate results across conversations: failed rows need attention, ↗ opens the library holding that memory, and "Clear failures" deletes only failed logs — successes and other logs stay.',
      helpSidebarReview: '"Needs review" = pending_review: nobody has approved the content yet, so it is not injected. The sidebar only shows the count; the review queue is on the global page (private items are tagged "private library" there).',
      helpSidebarRunLog: '"Runs" lists recent consolidation status, time and message; expanding the alerts card splits failures and successes into two columns.',
      helpSidebarReviewMode: 'The review-mode switch is on the global memory page: "auto" holds only conflicts, missing evidence and risky rewrites; "review-all" sends every content operation to review.',
      helpSidebarFirstRun: 'The first-install card appears only while there are no libraries; it disappears once the first one exists. There is no dismiss button and no local storage.',
      helpSidebarFallback: 'If the host forbids all-library browsing (403), the memory wall falls back to the first accessible library and says so instead of going blank; the multi-library option is disabled.',
      helpSidebarScope: 'The conversation scope card is on the sidebar Memory page: the top shows folder and conversation, the control card holds the private/global switches, and the collapsed card below sets channel / character / world / branch.',
      helpFaq: 'FAQ',
      helpFaq1: 'Why is nothing being recalled?',
      helpFaq1A: 'Check in order: is the conversation bound to a library (memu_bind / the /memu bind command); is the injection mode off; are the folder or conversation private/global switches off; is the entry still active and not filtered by context (channel/character/world/branch/knownBy) or domain. A missing local vector generation does not empty recall — it only falls back to lexical search.',
      helpFaq2: 'How do private libraries differ from global memory?',
      helpFaq2A: 'A private library is shared by every conversation in the folder: writes are editable, archivable and restorable. Global memory is written by the curator across conversations, filtered by domain/applies_to, and read-only in the UI — review, undo a merge or remove a link, never hand-edit.',
      helpFaq3: 'Why are some memories not injected?',
      helpFaq3A: 'Common reasons: pending_review (waiting for approval), archived/suppressed/expired/superseded, visibility=secret (automatic injection skips it), or a context/domain mismatch. Lexicon terms have no pending review anymore: they are active on write and only archived terms stop being injected.',
      helpFaq4: 'Why does the anchor show only titles, and how do I get the body?',
      helpFaq4A: 'The anchor and per-turn recall are a directory: title, tags and id only, to save budget and avoid quoting text the model was not given. Fetch the body with memu_private_recall / memu_global_recall by title keyword or id; the tools still return full text, and the memory-page drawer shows it too.',
      helpFaq5: 'Where did the original entries go after an absorb, and how do I undo it?',
      helpFaq5A: 'Absorbing deletes nothing: the merged entry becomes active, the target is marked superseded and the sources are archived. Find the merged entry on the global memory page and press "Undo merge" to restore everything; global links can be removed individually.',
      helpFaq6: 'The lexicon writes automatically — how do I archive, and why is a term not injected?',
      helpFaq6A: 'Lexicon terms go active immediately: there is no pending queue. Archiving stops injection at once and is restorable; permanent deletion exists only in the admin UI and cannot be undone. If a term is not injected, check whether it is archived or its context/visibility does not match. Sensitive triggers are user-only.',
      helpFaq7: 'How do I undo an auto-link or entity hub?',
      helpFaq7A: 'Edges with the "Auto" badge in the relationship graph were created by the algorithm: press × and confirm to remove one. Removal only touches graph metadata — no body, no vector, no deletion. Entity deletion follows the existing rules: refused while referenced, and force also removes the inbound links.',
      helpFaq8: 'Automatic backups vs JSON/ZIP export?',
      helpFaq8A: 'An automatic backup is a whole-install snapshot: plugin state, global/private indexes, lexicon, prompts, attachment references and the MemU databases, plus a manifest with per-file checksums; one is taken before engine switches/restores. JSON/ZIP export is per-library, and ZIP also carries image attachments; both exports can be imported back.',
      helpFaq9: 'Are deleted conversations still consolidated?',
      helpFaq9A: 'No. Once a conversation is deleted, the idle sweep marks it sessionGone and skips it, records a check-level log instead of an error, and does not retry forever or affect other conversations.',
      helpFaq10: 'The vector model is inactive — what happens?',
      helpFaq10A: 'Recall falls back to lexical search: still usable, weaker semantically. "Currently indexed N items" counts the active generation. Switching models or repairing a failure requires a rebuild; the old generation stays read-only during it, a failed rebuild leaves the active generation unchanged, and pressing again resumes.',
      helpFeedback: 'Feedback',
      helpOpenIssue: 'Open an issue',
      helpCopyDiagnostics: 'Copy diagnostics',
      helpDocs: 'Documentation',
    }

    // One token table for both surfaces. Every colour goes through a DSH alias so
    // the panel follows the host theme instead of hard-coding a light palette that
    // turns unreadable in dark mode.
    const V = {
      border: 'var(--dsw-alias-border-l1, #dfe1e6)',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04))',
      surfaceRaised: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
      accent: 'var(--dsw-alias-brand-primary, #2563eb)',
      accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 10%, transparent)',
      text: 'var(--dsw-alias-label-primary, inherit)',
      textDim: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.72))',
      danger: 'var(--dsw-alias-label-error, #c0392b)',
      warn: 'var(--dsw-alias-label-warning, #b7791f)',
      radius: 12,
      radiusSm: 8,
    }

    const S = {
      page: { padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1040, color: V.text, fontFamily: 'inherit' },
      section: { border: `1px solid ${V.borderSoft}`, borderRadius: 16, padding: 18, background: V.surface },
      h2: { fontSize: 13.5, margin: 0, fontWeight: 600, lineHeight: 1.3 },
      h3: { fontSize: 13, margin: '0 0 8px', fontWeight: 650 },
      secHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 11 },
      secDesc: { fontSize: 11.5, color: V.textDim, margin: '3px 0 0', lineHeight: 1.5, maxWidth: '60ch' },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '7px 0' },
      label: { fontSize: 12, color: V.textDim, minWidth: 132 },
      input: { height: 32, padding: '0 10px', borderRadius: 9, border: `1px solid ${V.borderSoft}`, background: V.surfaceRaised, color: V.text, minWidth: 120, fontSize: 12.5, outline: 'none' },
      textarea: { width: '100%', minHeight: 150, padding: 10, borderRadius: V.radiusSm, border: `1px solid ${V.border}`, background: 'var(--dsw-alias-bg-base, transparent)', color: V.text, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.6, outline: 'none', boxSizing: 'border-box' },
      btn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 32, padding: '0 14px', borderRadius: 10, border: `1px solid ${V.borderSoft}`, background: 'transparent', color: V.text, cursor: 'pointer', fontSize: 12.5, fontWeight: 550, lineHeight: 1.2, whiteSpace: 'nowrap', flexShrink: 0, transition: 'background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease' },
      // The on-accent text has to come from the theme too: a light brand colour
      // (yellow, mint) makes hardcoded white disappear.
      primary: { background: V.accent, color: 'var(--dsw-alias-label-primary-inverted, #fff)', border: '1px solid transparent', fontWeight: 600 },
      ghost: { border: `1px solid ${V.borderSoft}`, color: V.textDim },
      muted: { fontSize: 12, color: V.textDim },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      item: { border: `1px solid ${V.borderSoft}`, borderRadius: 12, padding: 12, background: V.surfaceRaised },
      tag: { fontSize: 11, padding: '3px 9px', borderRadius: 999, background: V.surfaceRaised, color: V.textDim, whiteSpace: 'nowrap' },
      empty: { padding: '26px 12px', textAlign: 'center', color: V.textDim, fontSize: 12.5, border: `1.5px dashed ${V.borderSoft}`, borderRadius: 14 },
      bar: { height: 5, borderRadius: 999, background: V.surfaceRaised, overflow: 'hidden', minWidth: 64, flex: 1 },
      barFill: { height: '100%', borderRadius: 999, background: V.accent, transition: 'width .2s ease' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, backdropFilter: 'blur(2px)' },
      modal: { width: 480, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflow: 'auto', background: V.surfaceRaised, color: 'var(--dsw-alias-label-primary, #111)', borderRadius: 14, padding: 22, boxShadow: '0 18px 48px rgba(0,0,0,.28)' },
      tab: { height: '100%', display: 'flex', flexDirection: 'column', gap: 0, color: V.text, overflow: 'hidden' },
      // Top tab bar for the narrow right-hand panel: full-bleed tabs with an
      // underline for the active one, then an independently scrolling body.
      topBar: { flexShrink: 0, padding: '10px 12px 0', borderBottom: `1px solid ${V.border}`, background: V.surface },
      topBarRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
      tabBody: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 12 },
      // Settings page header: top tabs with the engine verdict pinned at the end,
      // wrapping instead of clipping when the settings pane is narrow.
      tabsHead: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderBottom: `1px solid ${V.border}`, marginBottom: 4 },
      body: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 16 },
      footer: { marginTop: 'auto', paddingTop: 12, borderTop: `1px solid ${V.border}` },
    }

    // One scoped stylesheet for the settings page. Class names carry the `dshm-`
    // prefix so they cannot leak into the host, and colours ride the DSH aliases
    // with fallbacks so light and dark both work.
    const NAV_ITEM_H = 38
    const NAV_GAP = 4
    const UI_CSS = `
.dshm-root{letter-spacing:0!important}
.dshm-root *{letter-spacing:0!important;min-width:0}
.dshm-root section{border-radius:6px!important}
.dshm-card-head,.dshm-card-actions{flex-wrap:wrap}
.dshm-card-head>div:not([class]){flex:1 1 180px!important;min-width:120px}
.dshm-card-actions{max-width:100%}
.dshm-card-actions>div{flex-wrap:wrap;max-width:100%}
.dshm-card-head{display:flex;flex-wrap:wrap}
.dshm-root .dshm-btn{white-space:normal;overflow-wrap:anywhere;border-radius:4px!important}
.dshm-card:hover{transform:none!important;box-shadow:none!important}
.dshm-wall-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:12px;margin-top:18px}
.dshm-wall-item{display:flex;flex-direction:column;gap:10px;min-height:220px;width:100%;padding:16px;border:1px solid var(--dsw-alias-border-l1,#ccc);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;text-align:left;cursor:pointer;font:inherit}
.dshm-wall-item:hover{border-color:var(--dsw-alias-brand-primary,#167b69)}
.dshm-wall-item>strong{font-size:15px;overflow-wrap:anywhere}
.dshm-wall-item>p{margin:0;color:var(--dsw-alias-label-secondary,#777);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dshm-wall-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dshm-wall-meta>span{overflow-wrap:anywhere}
.dshm-wall-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:auto}
.dshm-wall-item>meter{width:100%;height:5px;accent-color:var(--dsw-alias-brand-primary,#167b69)}
.dshm-wall-cover{position:relative;display:block;margin:-16px -16px 0;overflow:hidden;border-radius:5px 5px 0 0;background:var(--dsw-alias-bg-layer-2,#eef);aspect-ratio:16/9}
.dshm-wall-cover img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .4s ease}
.dshm-wall-item:hover .dshm-wall-cover img{transform:scale(1.04)}
.dshm-wall-cover-count{position:absolute;right:8px;bottom:8px;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.6;background:rgba(8,12,20,.6);color:#fff}
.dshm-inbound-tools{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,#777);border-radius:4px;padding:7px;min-width:0;max-width:100%;flex:1}
/* In-place detail drawer. The wall opens one card here instead of jumping to the
   browser: the list keeps its filters, scroll position and context. */
.dshm-wall-views{margin:2px 0 4px}
.dshm-wall-graph{margin-top:4px}
.dshm-drawer-backdrop{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:rgba(10,14,22,.38);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:dshm-fade-in .2s ease both}
.dshm-drawer{width:min(480px,100%);height:100%;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:22px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);border-left:1px solid var(--dsw-alias-border-l1,#ddd);box-shadow:-24px 0 60px -34px rgba(0,0,0,.45);animation:dshm-drawer-in .3s cubic-bezier(.22,1,.36,1) both}
.dshm-drawer-head{display:flex;align-items:flex-start;gap:10px}
.dshm-drawer-title{margin:4px 0 6px;font-size:17px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.dshm-drawer-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dshm-drawer-form{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.dshm-drawer-inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshm-drawer-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-drawer-copy{margin:4px 0;white-space:pre-wrap;line-height:1.7;font-size:13px}
.dshm-drawer-note{margin-top:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-drawer-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,#ddd)}
@keyframes dshm-drawer-in{from{transform:translateX(28px);opacity:0}to{transform:none;opacity:1}}
.dshm-brand-tile{background:transparent!important;box-shadow:none!important;width:36px!important;height:36px!important}
.dshm-brand-tile img{display:block;object-fit:contain}
.dshm-graph-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.dshm-graph-tools input,.dshm-graph-tools select{min-width:0;max-width:100%;padding:7px;border:1px solid var(--dsw-alias-border-l2,#505158);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#242529);color:inherit;font:inherit}
.dshm-graph-tools input{flex:1 1 160px}
.dshm-root select{height:32px;max-width:100%;padding:0 30px 0 10px!important;border:1px solid var(--dsw-alias-border-l1,#dfe1e6);border-radius:9px;background-color:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12.5px;line-height:1.2;text-overflow:ellipsis;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23808a99' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important;background-repeat:no-repeat!important;background-position:right 9px center!important;background-size:10px 6px!important}
.dshm-root select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dshm-graph-list{display:grid;gap:8px;margin:12px 0}
.dshm-graph-edge{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1,#43444a);padding:10px 0;min-width:0}
.dshm-graph-edge>div{flex:1;min-width:0;overflow-wrap:anywhere}
.dshm-graph-edge small{display:block;opacity:.7;margin-top:5px}
.dshm-graph-viewport{position:relative;min-width:0;border:1px solid var(--dsw-alias-border-l1,#43444a);border-radius:4px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dshm-graph-canvas{display:block;box-sizing:border-box;width:100%;height:480px;max-height:65vh;min-height:300px;touch-action:none;cursor:grab;outline-offset:-3px}
.dshm-graph-toolbar{display:flex;align-items:center;gap:4px;min-height:40px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#43444a)}
.dshm-graph-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:19px;cursor:pointer}
.dshm-graph-icon:hover,.dshm-graph-icon[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2,#eceef5)}
.dshm-graph-scale{min-width:48px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;opacity:.65}
.dshm-graph-toolbar>.dshm-graph-icon:last-child{margin-left:auto}
.dshm-graph-options{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#43444a);font-size:12px}
.dshm-graph-options label{display:flex;align-items:center;gap:8px;min-width:0}
.dshm-graph-options input[type=range]{width:110px;max-width:35vw;accent-color:var(--dsw-alias-brand-primary,#3b5bdb)}
.dshm-graph-tooltip{position:absolute;z-index:2;max-width:min(260px,calc(100% - 12px));padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,#ccc);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;box-shadow:0 2px 8px #0002;font-size:12px;overflow-wrap:anywhere;pointer-events:none}
.dshm-graph-error{position:absolute;inset:50% 10px auto;text-align:center}
.dshm-graph-stage{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:16px;align-items:start;margin:12px 0}
.dshm-graph-stage .dshm-graph-list{margin:0}
.dshm-graph-node{max-width:100%;padding:3px 9px;border:1px solid var(--dsw-alias-border-l1,#ccc);border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12.5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:border-color .18s ease,color .18s ease,background .18s ease}
.dshm-graph-node:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}
.dshm-graph-unlink{flex:none;min-width:24px;height:24px;padding:0 6px;border:0;border-radius:7px;background:none;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));font:inherit;font-size:14px;line-height:1;cursor:pointer;transition:background .18s ease,color .18s ease}
.dshm-graph-unlink:hover{background:color-mix(in srgb,var(--dsw-alias-label-error,#b43e45) 10%,transparent);color:var(--dsw-alias-label-error,#b43e45)}
.dshm-graph-unlink.is-armed{width:auto;padding:0 8px;font-size:11.5px;color:var(--dsw-alias-label-error,#b43e45);background:color-mix(in srgb,var(--dsw-alias-label-error,#b43e45) 12%,transparent)}
@media (max-width:1100px){.dshm-graph-stage{grid-template-columns:minmax(0,1fr)}}
.dshm-graph-missing{opacity:.5}
/* The sidebar's context-scope form: a collapsed card instead of four bare
   inputs and a browser-default button. */
.dshm-scope{width:100%;margin:0 0 10px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));overflow:hidden;flex-shrink:0}
.dshm-scope>summary{display:flex;align-items:center;gap:7px;padding:9px 12px;list-style:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));transition:color .18s ease}
.dshm-scope>summary::-webkit-details-marker{display:none}
.dshm-scope>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .2s ease;margin-right:1px}
.dshm-scope[open]>summary::before{transform:rotate(45deg)}
.dshm-scope>summary:hover{color:var(--dsw-alias-label-primary,inherit)}
.dshm-scope>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-2px}
.dshm-scope-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0 12px 12px}
.dshm-scope-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-scope-field>span{display:block;min-height:15px}
.dshm-tab-body>*{flex-shrink:0}
.dshm-scope-field input{height:32px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:9px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12.5px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}
.dshm-scope-field input:focus{border-color:var(--dsw-alias-brand-primary,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 16%,transparent)}
.dshm-scope-actions{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.dshm-scope-hint{grid-column:1/-1;margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-scope-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-media{margin:10px 0}
.dshm-media-grid{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0}
.dshm-media-grid figure{margin:0;max-width:240px}
.dshm-media-grid img{display:block;max-width:100%;max-height:240px;object-fit:contain;border-radius:4px}
.dshm-media-grid figcaption{font-size:12px;overflow-wrap:anywhere}
.dshm-relation-field{display:grid;gap:5px;margin:10px 0}
.dshm-relation-field textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:4px;padding:8px;resize:vertical;max-width:100%}
/* Layout and type scale follow the plugin's reference surface (dsh-any-background):
   a 158px rail with a brand tile and a brand-tinted sliding indicator, a page
   header with an overline, 16px cards, and container queries rather than a
   hardcoded breakpoint. Every colour is a host token so a custom theme carries. */
.dshm-root{position:relative;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);padding:22px 26px;width:100%;min-width:0;container-type:inline-size;font-family:inherit;animation:dshm-fade-in .35s ease both;--dshm-mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace}
.dshm-root *,.dshm-root *::before,.dshm-root *::after{box-sizing:border-box}
.dshm-root button{font-family:inherit}

.dshm-shell{display:grid;grid-template-columns:158px minmax(0,1fr);gap:26px;align-items:start;width:100%;max-width:980px;margin:0 auto}
.dshm-nav{position:sticky;top:0;display:flex;flex-direction:column;gap:18px;min-width:0}
.dshm-brand{display:flex;align-items:center;gap:10px;padding:2px 6px}
.dshm-brand-tile{width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary-inverted,#fff));background:var(--dsw-alias-brand-primary,#2563eb);box-shadow:0 4px 14px -4px var(--dsw-alias-brand-primary,#2563eb)}
.dshm-brand-name{font-size:13px;font-weight:650;letter-spacing:.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-brand-tag{font-size:9px;letter-spacing:.16em;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));text-transform:uppercase}
.dshm-nav-list{position:relative;display:flex;flex-direction:column;gap:var(--dshm-nav-gap,4px)}
.dshm-nav-ind{position:absolute;left:0;right:0;top:0;height:var(--dshm-nav-h,38px);border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 13%,transparent);transition:transform .38s cubic-bezier(.22,1,.36,1);pointer-events:none}
.dshm-nav-item{position:relative;z-index:1;display:flex;align-items:center;gap:10px;height:var(--dshm-nav-h,38px);padding:0 12px;border:0;background:none;border-radius:11px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .22s ease}
.dshm-nav-item:hover{color:var(--dsw-alias-label-primary,inherit)}
.dshm-nav-item.on{color:var(--dsw-alias-brand-primary,#2563eb);font-weight:600}
.dshm-nav-item svg{flex:none;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.dshm-nav-item:hover svg{transform:scale(1.14) rotate(-5deg)}
.dshm-nav-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
/* One tab strip for every "pick one of these" control — the sidebar's page row,
   the embedded settings rail, the prompt scope, the browser's active/archived
   split, the memory backend. is-row is the compact form used inside a page; it
   is also what the narrow sidebar surface flips the rail into, so the two
   never drift again. */
.dshm-nav-list.is-row{flex-direction:row;flex-wrap:wrap;gap:2px}
.dshm-nav-list.is-row .dshm-nav-ind{display:none}
.dshm-nav-list.is-row .dshm-nav-item{flex:none;height:30px;padding:0 10px;font-size:12px;gap:7px;border-radius:9px;transition:color .22s ease,background .2s ease,box-shadow .2s ease}
.dshm-nav-list.is-row .dshm-nav-item svg{width:14px;height:14px}
.dshm-nav-list.is-row .dshm-nav-item.on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.dshm-nav-item:disabled{opacity:.45;cursor:default}
.dshm-nav-item:disabled:hover{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-x{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));font:inherit;font-size:14px;line-height:1;opacity:.6;cursor:pointer;transition:opacity .18s ease,background .18s ease,color .18s ease}
.dshm-x:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-error,#e5484d)}
.dshm-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}

.dshm-page{min-width:0;display:flex;flex-direction:column;gap:13px;animation:dshm-page-in .26s cubic-bezier(.22,1,.36,1) both}
.dshm-head{margin:2px 0 5px}
.dshm-overline{font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--dsw-alias-brand-primary,#2563eb);opacity:.9}
.dshm-h1{margin:4px 0 0;font-size:21px;font-weight:700;letter-spacing:-.01em}
.dshm-desc{margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));max-width:56ch}

/* Cards. The inline style object still carries the colours; these add the motion
   and hover that inline styles cannot express. */
.dshm-card{transition:transform .28s ease,box-shadow .28s ease,border-color .28s ease}
.dshm-card:hover{transform:translateY(-2px);box-shadow:0 10px 28px -12px rgba(0,0,0,.28)}
.dshm-rise{animation:dshm-rise-in .34s cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--d,0) * 38ms)}
.dshm-card-head{display:flex;align-items:flex-start;gap:11px}
.dshm-card-ico{width:32px;height:32px;flex:none;border-radius:10px;display:grid;place-items:center;color:var(--dsw-alias-brand-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 12%,transparent)}
.dshm-card-title{font-size:13.5px;font-weight:600;line-height:1.3}
.dshm-card-sub{margin-top:3px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));max-width:60ch}
/* 连接与向量：大选择卡 + 分步卡片 + 一个显眼的主操作。原来把切换按钮塞在标题栏里，
   三个小按钮和状态标签挤在一行，既不好点也看不出主次。 */
.dshm-choice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:10px}
.dshm-choice{position:relative;display:flex;flex-direction:column;gap:5px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#dfe1e6);border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease,transform .18s ease}
.dshm-choice:hover:not(:disabled){transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 42%,transparent)}
.dshm-choice.on{border-color:var(--dsw-alias-brand-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 8%,transparent);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#2563eb)}
.dshm-choice:disabled{opacity:.6;cursor:not-allowed}
.dshm-choice-top{display:flex;align-items:center;gap:8px}
.dshm-choice-title{font-size:13.5px;font-weight:650;line-height:1.35}
.dshm-choice-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-choice-mark{width:18px;height:18px;flex:none;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--dsw-alias-brand-primary,#2563eb)}
.dshm-step{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:14px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));display:flex;flex-direction:column;gap:8px}
.dshm-step-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshm-step-title{font-size:12.5px;font-weight:650;line-height:1.35}
.dshm-step-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshm-model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.dshm-model{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:14px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));display:flex;flex-direction:column;gap:8px}
.dshm-model-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}
.dshm-primary-lg{min-height:38px;padding:0 20px;font-size:13px;border-radius:11px}
.dshm-cta-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}
.dshm-rebuild{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 28%,transparent)}
.dshm-rebuild-bar{height:10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));overflow:hidden}
.dshm-rebuild-bar>span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#2563eb);transition:width .32s ease}
.dshm-rebuild-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-rebuild .dshm-vector-progress{display:flex;flex-direction:column;gap:6px}
.dshm-rebuild progress{width:100%;height:12px;border-radius:999px;appearance:none;-webkit-appearance:none;border:0;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.dshm-rebuild progress::-webkit-progress-bar{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));border-radius:999px}
.dshm-rebuild progress::-webkit-progress-value{background:var(--dsw-alias-brand-primary,#2563eb);border-radius:999px;transition:width .3s ease}
.dshm-rebuild progress::-moz-progress-bar{background:var(--dsw-alias-brand-primary,#2563eb);border-radius:999px}
.dshm-card-actions{margin-left:auto;display:flex;gap:8px;flex:none;align-items:center}

.dshm-root input:not([type=checkbox]):not([type=radio]):focus,.dshm-root textarea:focus,.dshm-root select:focus{border-color:var(--dsw-alias-brand-primary,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 18%,transparent)}
.dshm-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 5px 14px -6px rgba(0,0,0,.32)}
.dshm-btn:active:not(:disabled){transform:translateY(0) scale(.97);box-shadow:none}
.dshm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dshm-toggle{transition:background .28s ease,border-color .28s ease}
.dshm-toggle-knob{transition:transform .28s cubic-bezier(.22,1,.36,1)}
.dshm-error{color:var(--dsw-alias-label-error,#c0392b);font-size:12px;line-height:1.6}
.dshm-muted{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-subhead{margin:14px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));letter-spacing:.02em}
.dshm-chart{display:block;width:100%;height:auto;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;margin:2px 0}
.dshm-stat{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}
.dshm-stat-v{font-size:20px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.dshm-stat-k{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-stat-note{margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
.dshm-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));flex-wrap:wrap;margin-bottom:2px}
.dshm-prompt-layout{display:grid;grid-template-columns:minmax(140px,190px) minmax(0,1fr);gap:16px;align-items:start}
.dshm-prompt-pages-wrap{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshm-prompt-pages{min-width:0}
.dshm-prompt-new{display:flex;gap:4px;margin-top:4px}
.dshm-prompt-body{min-width:0}
.dshm-prompt-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap}
.dshm-prompt-meta{flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
.dshm-prompt-actions{display:flex;gap:6px;flex-shrink:0;margin-left:auto}
@container (max-width:900px){
  .dshm-prompt-layout{grid-template-columns:minmax(0,1fr)}
  .dshm-prompt-pages{flex-direction:row;flex-wrap:wrap;gap:2px}
  .dshm-prompt-pages>div{flex:none}
  .dshm-prompt-new{max-width:240px}
}
@container (max-width:480px){
  .dshm-prompt-meta{flex-basis:100%}
  .dshm-prompt-actions{width:100%;justify-content:flex-end;margin-left:0}
}
@media (max-width:760px){
  .dshm-prompt-layout{grid-template-columns:minmax(0,1fr)}
  .dshm-prompt-pages{flex-direction:row;flex-wrap:wrap;gap:2px}
  .dshm-prompt-pages>div{flex:none}
}
@media (max-width:520px){
  .dshm-prompt-meta{flex-basis:100%}
  .dshm-prompt-actions{width:100%;justify-content:flex-end;margin-left:0}
}

@container (max-width:620px){
  .dshm-shell{grid-template-columns:minmax(0,1fr);gap:14px}  .dshm-nav{position:static;gap:10px}
  .dshm-brand{padding:0 2px}
  .dshm-nav-list{flex-direction:row;flex-wrap:wrap;gap:2px}
  .dshm-nav-ind{display:none}
  .dshm-nav-item{flex:none;height:32px;padding:0 10px;font-size:12px}
  .dshm-nav-item.on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
  .dshm-h1{font-size:18px}
}
@container (max-width:480px){
  .dshm-root{padding:14px}
  .dshm-page{gap:10px}
  .dshm-overline{font-size:10px}
  .dshm-h1{font-size:17px}
  .dshm-desc{font-size:12px}
}
/* The host renders the wall inside a pane, not a viewport: the merged graph needs
   to stack by its own width, not the browser's. */
@container (max-width:900px){
  .dshm-graph-stage{grid-template-columns:minmax(0,1fr)}
}

/* Sidebar surface: the panel is narrow and scrolls. The rail carries is-row in its
   own markup here, so only the page scroll and the type scale differ. */
[data-dshm-surface="sidebar"].dshm-root{padding:12px 12px 0;height:100%;min-height:0;overflow:hidden}
[data-dshm-surface="sidebar"] .dshm-shell{display:flex;flex-direction:column;align-items:stretch;gap:11px;height:100%;min-height:0;max-width:none}
[data-dshm-surface="sidebar"] .dshm-nav{position:static;gap:8px;flex:none}
[data-dshm-surface="sidebar"] .dshm-brand{padding:0 2px}
[data-dshm-surface="sidebar"] .dshm-brand-tile{width:24px;height:24px;border-radius:7px}
[data-dshm-surface="sidebar"] .dshm-page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-bottom:16px;scrollbar-width:thin;gap:10px}
[data-dshm-surface="sidebar"] .dshm-h1{font-size:17px}
[data-dshm-surface="sidebar"] .dshm-desc{font-size:12px}
[data-dshm-surface="sidebar"] .dshm-card{padding:12px}

@keyframes dshm-fade-in{from{opacity:0}to{opacity:1}}
@keyframes dshm-page-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes dshm-rise-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .dshm-root *,.dshm-root *::before,.dshm-root *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`

    async function rpc(ctx, endpoint, payload = {}) {
      const res = await ctx.connection.rpc.call('/dsh-memu-memory', endpoint, payload)
      if (!res || res.ok !== true) throw new Error(res?.error?.message || `rpc ${endpoint} failed`)
      return res.value
    }

    /**
     * Opens the standalone page.
     *
     * The environment decides how, because two of the three ways are commonly
     * blocked: `window.open` (popup blocker) and `<a target="_blank">` (host or
     * browser policy). Navigating *this* tab always works but unloads DSH, and
     * coming back rebuilds the app from scratch — that "forced refresh" is what
     * we had before. So the fallback is an in-app overlay instead.
     *
     * Note `window.open(..., 'noopener')` returns null even on success, which is
     * why the blocked check must not pass that flag.
     */
    function openWebUiPage(page = null, { libraryId = null } = {}) {
      // libraryId 走 query：SettingsPage 的 standalone 分支从 search 里取 browseLibId，
      // 跳进去就停在出错记忆所在的库；hash 只决定落到哪个页面。
      const query = libraryId ? '?libraryId=' + encodeURIComponent(libraryId) : ''
      let url = '/dsh-memu-memory/ui' + query + '#/settings/' + (page || 'memories')
      try { url = new URL(url, window.location.href).toString() } catch {}
      let win = null
      try { win = window.open(url, '_blank') } catch { win = null }
      if (win) {
        // Keep the opener reference: the page's "返回 DSH" button closes this tab
        // and focuses the app. Same origin, so nothing crosses a trust boundary.
        try { win.focus() } catch {}
        return 'tab'
      }
      try {
        toggleWebUiOverlay(url)
        return 'overlay'
      } catch {
        return 'blocked'
      }
    }

    /** The same page in an iframe over the app: no new window, no unload. */
    function toggleWebUiOverlay(url) {
      const ATTR = 'data-dsh-memu-memory-webui'
      const existing = document.querySelector(`[${ATTR}]`)
      if (existing) {
        if (typeof existing.__close === 'function') existing.__close()
        else existing.remove()
        return
      }
      // The host's own scrollbar sits at the viewport edge, outside any fixed
      // overlay, and shows up as a dark strip on the right. Freeze the host while
      // the panel is open and restore both scroll containers on close.
      const html = document.documentElement || null
      const body = document.body || null
      const previous = {
        html: html?.style?.overflow ?? '',
        body: body?.style?.overflow ?? '',
      }
      if (html?.style) html.style.overflow = 'hidden'
      if (body?.style) body.style.overflow = 'hidden'

      const wrap = document.createElement('div')
      wrap.setAttribute(ATTR, '')
      wrap.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483000', 'display:flex',
        'align-items:center', 'justify-content:center', 'padding:24px',
        'background:rgba(6,8,12,.55)', 'backdrop-filter:blur(6px)',
      ].join(';')

      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = 'MemU WebUI'
      // No max-width: the page should fill the overlay's content box. The old
      // 1600px cap left a dark band on wide windows.
      frame.style.cssText = [
        'width:100%', 'height:100%', 'border:0',
        'border-radius:16px', 'background:#f4f5f9',
        'box-shadow:0 30px 80px -30px rgba(0,0,0,.85)',
      ].join(';')

      const closeOverlay = () => {
        try { document.removeEventListener('keydown', onKey) } catch {}
        try { window.removeEventListener('message', onMessage) } catch {}
        try { wrap.remove() } catch {}
        if (html?.style) html.style.overflow = previous.html
        if (body?.style) body.style.overflow = previous.body
      }
      wrap.__close = closeOverlay
      const onKey = (event) => { if (event.key === 'Escape') closeOverlay() }
      // The close control lives inside the page (next to 刷新), because a floating
      // one sat outside the panel and did not read as part of it.
      const onMessage = (event) => {
        if (event.origin !== window.location.origin) return
        if (!event.data || event.data.type !== 'dsh-memu-memory-webui-close') return
        closeOverlay()
      }
      document.addEventListener('keydown', onKey)
      window.addEventListener('message', onMessage)
      // Clicking the dimmed margin outside the panel also closes it.
      wrap.addEventListener('click', (event) => { if (event.target === wrap) closeOverlay() })

      wrap.appendChild(frame)
      document.body.appendChild(wrap)
    }

    // Tiny stroke glyphs for the settings rail. Inline SVG keeps the plugin
    // dependency-free and inherits currentColor, so the theme drives it.
    function glyph(paths) {
      return function Glyph({ size = 16 }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        }, paths.map((d, i) => h('path', { key: i, d })))
      }
    }
    const GlyphGauge = glyph(['M4 18a8 8 0 1 1 16 0', 'M12 15l4-5'])
    const GlyphSliders = glyph(['M4 8h16', 'M4 16h16', 'M9 5v6', 'M15 13v6'])
    const GlyphFolder = glyph(['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'])
    const GlyphStack = glyph(['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5'])
    const GlyphSearch = glyph(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'])
    const GlyphGlobe = glyph(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'])
    const GlyphText = glyph(['M5 6h14', 'M5 11h14', 'M5 16h9'])
    const GlyphLayers = glyph(['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'])
    const GlyphChart = glyph(['M4 19V5', 'M4 19h16', 'M8 15v-4', 'M12 15V8', 'M16 15v-6'])
    const GlyphQuestion = glyph(['M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.4-3 4', 'M12 17.5h.01'])

    // Thirty daily bars, written by hand: the bundle purity gate refuses absolute
    // imports, and a chart this small does not need a library. Zero days still draw
    // a faint 1px mark — a gap in the row reads as missing data, not as a quiet day.
    function ActivityBars({ days, label, emptyLabel }) {
      // The viewBox is wider than tall so the chart fills a desktop card without
      // becoming a 300px-tall band: SVG scales with its width, and a 320-wide box
      // stretched to a 1100px card is exactly how the first version looked empty.
      const width = 720
      const height = 112
      const pad = 10
      const base = height - 18
      const slot = (width - pad * 2) / Math.max(1, days.length)
      const max = Math.max(0, ...days.map((day) => Number(day.injected) || 0))
      return h('svg', {
        className: 'dshm-chart',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': label,
      },
      h('line', { x1: pad, y1: base, x2: width - pad, y2: base, stroke: 'currentColor', strokeWidth: 1, opacity: 0.16 }),
      max === 0 && emptyLabel
        ? h('text', { x: width / 2, y: base - 16, textAnchor: 'middle', fontSize: 11, fill: 'currentColor', opacity: 0.7 }, emptyLabel)
        : null,
      days.map((day, i) => {
        const count = Number(day.injected) || 0
        const bar = max === 0 ? 0 : Math.round((count / max) * (base - pad))
        return h('rect', {
          key: day.date,
          x: pad + i * slot + slot * 0.16,
          y: base - Math.max(count > 0 ? 3 : 1, bar),
          width: Math.max(2, slot * 0.68),
          height: Math.max(count > 0 ? 3 : 1, bar),
          rx: 1.6,
          fill: 'var(--dsw-alias-brand-primary, #2563eb)',
          opacity: count > 0 ? 0.9 : 0.16,
        }, h('title', null, `${day.date} · ${count}`))
      }))
    }

    // One point per memory: x = days since written, y = times injected. The cloud
    // hugging the bottom-right is the archive shortlist — plenty of time, no use.
    function HitScatter({ points, label }) {
      const width = 720
      const height = 200
      const pad = 16
      const maxAge = Math.max(1, ...points.map((p) => Number(p.ageDays) || 0))
      const maxInject = Math.max(1, ...points.map((p) => Number(p.injectCount) || 0))
      const x = (age) => pad + ((Number(age) || 0) / maxAge) * (width - pad * 2)
      const y = (count) => height - pad - ((Number(count) || 0) / maxInject) * (height - pad * 2)
      return h('svg', {
        className: 'dshm-chart',
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': label,
      },
      h('line', { x1: pad, y1: height - pad, x2: width - pad, y2: height - pad, stroke: 'currentColor', strokeWidth: 1, opacity: 0.16 }),
      h('line', { x1: pad, y1: pad, x2: pad, y2: height - pad, stroke: 'currentColor', strokeWidth: 1, opacity: 0.16 }),
      // Bare numbers, no translated words: the axes are "days since written" and
      // "times injected", and both extremes are enough to read the cloud.
      h('text', { x: width - pad, y: height - 4, textAnchor: 'end', fontSize: 10, fill: 'currentColor', opacity: 0.55 }, `${maxAge}d`),
      h('text', { x: pad + 5, y: pad + 4, fontSize: 10, fill: 'currentColor', opacity: 0.55 }, String(maxInject)),
      h('text', { x: pad + 5, y: height - pad - 5, fontSize: 10, fill: 'currentColor', opacity: 0.55 }, '0'),
      points.map((point) => h('circle', {
        key: point.id,
        cx: Math.round(x(point.ageDays) * 10) / 10,
        cy: Math.round(y(point.injectCount) * 10) / 10,
        r: 3.4,
        fill: 'var(--dsw-alias-brand-primary, #2563eb)',
        opacity: Number(point.injectCount) > 0 ? 0.85 : 0.4,
      }, h('title', null, `${point.title || point.id} · ${point.ageDays ?? '?'}d · ${point.injectCount}`))))
    }

    function Section({ title, children, right, desc, icon: Icon, delay = 0 }) {
      return h('section', {
        className: 'dshm-card dshm-rise',
        style: { ...S.section, '--d': delay },
      },
      h('div', { className: 'dshm-card-head' },
        Icon ? h('div', { className: 'dshm-card-ico' }, h(Icon, { size: 16 })) : null,
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('h2', { className: 'dshm-card-title', style: S.h2 }, title),
          desc ? h('div', { className: 'dshm-card-sub', style: S.secDesc }, desc) : null),
        right ? h('div', { className: 'dshm-card-actions' }, right) : null),
      h('div', { style: { marginTop: 12 } }, children))
    }

    function Empty({ children }) {
      return h('div', { style: S.empty }, children)
    }

    // 0..1 strength meter used by the memory browser's decay column.
    function Bar({ value, title }) {
      const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)
      return h('div', { style: S.bar, title: title || `${pct}%` },
        h('div', { style: { ...S.barFill, width: `${pct}%` } }))
    }

    function Button({ children, onClick, disabled, primary, style, title, type = 'button', 'aria-pressed': ariaPressed }) {
      return h('button', {
        type,
        className: 'dshm-btn',
        // Without this the prop never reaches the node, and every hover hint on
        // the surface silently stops working.
        title,
        'aria-pressed': ariaPressed,
        style: { ...S.btn, ...(primary ? S.primary : {}), ...(style || {}), opacity: disabled ? 0.5 : 1 },
        onClick,
        disabled,
      }, children)
    }

    function Field({ label, children, hint }) {
      return h('label', { style: S.row },
        h('span', { style: S.label }, label),
        children,
        hint ? h('span', { style: S.muted }, hint) : null)
    }

    // A session-level switch sitting in a tight row. Field is wrong here: its
    // label reserves a 132px column, so side-by-side Fields push each checkbox
    // away from its own text and it reads as the neighbour's switch. Keep the
    // box and the words in one pill so the pairing cannot be misread.
    function CheckRow({ label, checked, disabled, title, onChange }) {
      return h('label', {
        title: title || '',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px 4px 8px', borderRadius: 9,
          border: `1px solid ${V.borderSoft}`,
          fontSize: 12, color: V.textDim, whiteSpace: 'nowrap',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        },
      },
      h('input', {
        type: 'checkbox',
        checked: checked === true,
        disabled: disabled === true,
        style: { margin: 0, flexShrink: 0, accentColor: V.accent, cursor: 'inherit' },
        onChange: (e) => onChange(e.target.checked),
      }),
      h('span', null, label))
    }

    // Accessible switch used by the folder list. Native checkbox input is avoided
    // because the settings pane's dark theme makes an unstyled checkbox vanish.
    function Toggle({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: label,
        className: 'dshm-toggle',
        disabled,
        onClick: () => onChange(!checked),
        style: {
          width: 42, height: 24, padding: 0, position: 'relative', flexShrink: 0,
          borderRadius: 999, border: `1px solid ${checked ? V.accent : V.borderSoft}`,
          background: checked ? V.accent : 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          transition: 'background .15s ease, border-color .15s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 20 : 2,
          width: 18, height: 18, borderRadius: '50%',
          background: checked ? '#fff' : V.textDim,
          transition: 'left .15s ease',
        },
      }))
    }

    // The stored enums stay English (they are data, and they go into prompts and
    // exports); only the display flips with the host language.
    const LAYER_LABELS = { long_term: 'layerLongTerm', anchor: 'layerAnchor', must_remember: 'layerMustRemember', short_term: 'layerShortTerm' }
    const STATUS_LABELS = { active: 'stActive', archived: 'stArchived', suppressed: 'stSuppressed', superseded: 'stSuperseded', pending_review: 'stPendingReview', expired: 'stExpired' }
    const DISCLOSURE_LABELS = { can_tell: 'discCanTell', only_if_asked: 'discOnlyIfAsked', never_say: 'discNeverSay' }
    const OWNER_LABELS = { me: 'ownerMe', us: 'ownerUs', about_user: 'ownerAboutUser', about_project: 'ownerAboutProject' }
    const VISIBILITY_LABELS = { shared: 'visShared', secret: 'visSecret' }
// Provenance. `inferred` is the default and the least interesting value, but it is
// still shown in the browser: the whole failure mode this label exists for is a
// memory quietly claiming to be a quote.
const SOURCE_LABELS = { user_said: 'sourceUserSaid', inferred: 'sourceInferred', imagined: 'sourceImagined', told: 'sourceTold' }
    const DOMAIN_LABELS = { general: 'dmGeneral', coding: 'dmCoding', rp: 'dmRp', mixed: 'dmMixed', universal: 'dmUniversal', personal: 'dmPersonal', other: 'dmOther', unknown: 'dmUnknown' }
    const INJECT_LABELS = { smart: 'modeSmart', 'anchor-only': 'modeAnchor', 'per-turn': 'modePerTurn', off: 'modeOff' }

    // Unknown values fall through verbatim: a newer host enum must stay readable
    // even when this build has no label for it yet.
    function enumText(t, map, value) {
      const key = map[value]
      return key ? t(key) : String(value ?? '')
    }

    function domainText(t, value) {
      const raw = String(value ?? 'unknown')
      if (raw.startsWith('project:')) return `${t('dmProjectPrefix')}${raw.slice('project:'.length)}`
      return enumText(t, DOMAIN_LABELS, raw)
    }

    // 情绪构成的短标签：同样的 valence 可能来自怒，也可能来自哀，一个数字分不出来。
    // 四轴固定且术语极短，就地映射，不为四个轴各加一个 i18n key。
    const EMOTION_TAG_LABELS = { joy: '喜', anger: '怒', sorrow: '哀', fear: '惧' }
    function emotionTagText(emotion) {
      if (!emotion || typeof emotion !== 'object') return ''
      return Object.entries(EMOTION_TAG_LABELS)
        .map(([axis, label]) => ({ label, share: Number(emotion[axis]) || 0 }))
        .filter((item) => item.share >= 0.05)
        .sort((a, b) => b.share - a.share)
        .slice(0, 2)
        .map((item) => `${item.label}${item.share.toFixed(1)}`)
        .join('/')
    }

    // Tags are labels, not decoration — except when the label is a warning. A memory
    // marked "never say out loud" has to look different from one that can be said,
    // otherwise the badge is just more grey text to skim past.
    const TAG_TONES = {
      warn: { color: V.warn, background: 'color-mix(in srgb, currentColor 12%, transparent)' },
      info: { color: V.accent, background: V.accentSoft },
    }

    function Tag({ children, tone }) {
      const style = tone && TAG_TONES[tone] ? { ...S.tag, ...TAG_TONES[tone] } : S.tag
      return h('span', { style }, children)
    }

    // The host lists untitled sessions (renamed title events are async), so fall
    // back to a short id rather than the full `session-…` string in the picker.
    function sessionLabel(s) {
      return s.title || `…${String(s.id || '').slice(-8)}`
    }

    function Modal({ title, children, onClose, footer }) {
      // Dialog semantics are what let a theme plugin recognise this as a prompt: its
      // card fill is pinned opaque for `[role=dialog][aria-modal=true]`, while page
      // ground (--dsw-alias-bg-base) is left translucent by design. `aria-label`
      // rather than `aria-labelledby`, which that exemption excludes on purpose to
      // tell prompts apart from the settings panel.
      return h('div', { style: S.overlay, onClick: (e) => { if (e.target === e.currentTarget) onClose?.() } },
        h('div', { style: S.modal, role: 'dialog', 'aria-modal': 'true', 'aria-label': typeof title === 'string' ? title : undefined },
          h('h3', { style: { margin: '0 0 10px', fontSize: 16 } }, title),
          children,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } }, footer || null)))
    }

    // Library selectors previously showed the whole absolute scope path, which made
    // every option a long, nearly identical line. Keep the folder leaf as context and
    // disambiguate same-looking names with a short id suffix only when needed.
    function libraryBaseLabel(lib) {
      const name = String(lib?.name || lib?.id || '')
      const leaf = String(lib?.scopeKey || '').split(/[\\/]/).filter(Boolean).pop() || ''
      return leaf && leaf.toLowerCase() !== name.toLowerCase() ? `${name} · ${leaf}` : name
    }
    function libraryOptionLabel(lib, libraries = []) {
      const base = libraryBaseLabel(lib)
      const duplicated = (Array.isArray(libraries) ? libraries : []).filter((item) => libraryBaseLabel(item) === base).length > 1
      return duplicated ? `${base} · ${String(lib?.id || '').slice(-4)}` : base
    }

    function useRpc(ctx) {
      return React.useCallback((endpoint, payload) => rpc(ctx, endpoint, payload), [ctx])
    }

    function useCurrentSession(ctx) {
      const source = React.useMemo(() => {
        const sr = ctx.get?.('sidebarRight') || ctx.sidebarRight
        if (sr?.mounted?.getSnapshot) {
          return { subscribe: sr.mounted.subscribe.bind(sr.mounted), get: sr.mounted.getSnapshot.bind(sr.mounted) }
        }
        const ui = ctx.get?.('uiSession') || ctx.uiSession
        const cur = ui?.adapter?.current
        if (cur?.getSnapshot) {
          return { subscribe: typeof cur.subscribe === 'function' ? cur.subscribe.bind(cur) : function () { return function () {} }, get: function () { return cur.getSnapshot()?.key } }
        }
        return null
      }, [ctx])
      return React.useSyncExternalStore(
        source?.subscribe || (() => () => {}),
        source?.get || (() => undefined),
        source?.get || (() => undefined),
      )
    }

    function useSessionList(ctx) {
      const store = ctx.sessions?.list
      const subscribe = React.useMemo(() => (store?.subscribe ? store.subscribe.bind(store) : () => () => {}), [store])
      const getSnapshot = React.useMemo(() => (store?.getSnapshot ? store.getSnapshot.bind(store) : () => EMPTY_SESSIONS), [store])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function ContextScope({ binding, sessionId, call, t }) {
      const [notice, setNotice] = React.useState('')
      if (!binding) return null
      return h('details', { className: 'dshm-scope' },
        h('summary', null, t('contextScope')),
        h('form', {
          className: 'dshm-scope-form',
          onSubmit: async event => {
            event.preventDefault()
            const values = new FormData(event.currentTarget)
            const context = {}
            for (const key of ['channelId', 'characterId', 'worldId', 'branchId']) context[key] = String(values.get(key) || '').trim()
            try {
              await call('setMemoryContext', { sessionId, context })
              notifyMemoryWrite('context', binding.libraryId)
              setNotice(t('saved'))
            } catch (error) { setNotice(String(error.message || error)) }
            setTimeout(() => setNotice(''), 2600)
          },
        },
        ['channelId', 'characterId', 'worldId', 'branchId'].map(key => h('label', { key, className: 'dshm-scope-field' },
          h('span', null, t(key)),
          h('input', {
            name: key,
            defaultValue: binding.memoryContext?.[key] || '',
            'aria-label': t(key),
            maxLength: 128,
          }))),
        h('p', { className: 'dshm-scope-hint' }, t('contextScopeHint')),
        h('div', { className: 'dshm-scope-actions' },
          h(Button, { type: 'submit', primary: true }, t('contextSave')),
          notice ? h('span', { className: 'dshm-scope-note', role: 'status' }, notice) : null)))
    }

    function MemoryAttachments({ items, t, initialOpen = false }) {
      const [open, setOpen] = React.useState(initialOpen)
      const [failed, setFailed] = React.useState({})
      if (!items?.length) return null
      return h('details', { className: 'dshm-media', open, onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', null, '▧ ' + items.length),
        open ? h('div', { className: 'dshm-media-grid' }, items.map(item => h('figure', { key: item.sha256 },
          item.url && !item.hidden && !item.missing && !failed[item.sha256]
            ? h('img', { src: item.url, loading: 'lazy', alt: item.caption || '', onError: () => setFailed(previous => ({ ...previous, [item.sha256]: true })) })
            : h('span', null, item.hidden ? t('visSecret') : t('attachmentMissing')),
          item.hidden ? null : h('figcaption', null, item.caption || '[图片]')))) : null)
    }

    function VisionConfigPanel({ call, config, t }) {
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      return h('form', { className: 'dshm-graph-tools', onSubmit: async event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        setBusy(true)
        try {
          await call('saveMemuConfig', { visionBaseUrl: data.get('url'), visionModel: data.get('model'), visionApiKey: data.get('key') || undefined })
          setMessage(t('saved'))
          notifyMemoryWrite('settings')
        } catch (error) { setMessage(String(error.message || error)) } finally { setBusy(false) }
        setTimeout(() => setMessage(''), 2600)
      } },
        h('input', { name: 'url', type: 'url', defaultValue: config?.baseUrl || '', placeholder: 'https://host/v1', 'aria-label': t('baseUrl') }),
        h('input', { name: 'model', defaultValue: config?.model || '', placeholder: t('model'), 'aria-label': t('model') }),
        h('input', { name: 'key', type: 'password', autoComplete: 'new-password', placeholder: config?.hasKey ? '********' : 'API key', 'aria-label': 'API key' }),
        h('button', { className: 'dshm-btn', type: 'submit', disabled: busy }, t('save')),
        message ? h('span', { role: 'status' }, message) : null)
    }

    let graphModulePromise = null
    function loadGraphModule() {
      if (window.DshMemuGraph) return Promise.resolve(window.DshMemuGraph)
      if (!graphModulePromise) graphModulePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/dsh-memu-memory/ui-assets/graph-view.js'
        script.async = true
        const timer = setTimeout(() => fail(), 15000)
        const fail = () => {
          clearTimeout(timer); script.remove(); graphModulePromise = null
          reject(new Error('Graph module unavailable'))
        }
        script.onerror = fail
        script.onload = () => {
          clearTimeout(timer)
          if (!window.DshMemuGraph) { fail(); return }
          resolve(window.DshMemuGraph)
        }
        document.head.appendChild(script)
      })
      return graphModulePromise
    }

    function GraphCanvas({ graph, focus, onFocus, t }) {
      const ref = React.useRef(null)
      const tooltipRef = React.useRef(null)
      const viewRef = React.useRef(null)
      const latest = React.useRef({ graph, focus, onFocus, t })
      latest.current = { graph, focus, onFocus, t }
      const [zoom, setZoom] = React.useState(1)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [options, setOptions] = React.useState({ repulsion: 120, distance: 100, labels: true, motion: true })
      const optionsRef = React.useRef(options)
      optionsRef.current = options
      const [loadError, setLoadError] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      React.useEffect(() => {
        const canvas = ref.current
        if (!canvas?.getContext) return undefined
        let disposed = false
        setLoadError(false)
        void loadGraphModule().then(module => {
          if (disposed) return
          const view = module.createGraphView(canvas, {
            onFocus: id => latest.current.onFocus(id),
            onZoom: setZoom,
            tooltip: tooltipRef.current,
            reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
            emptyLabel: latest.current.t('graphEmpty'),
          })
          viewRef.current = view
          view.configure(optionsRef.current)
          view.update(latest.current.graph, latest.current.focus)
        }).catch(() => { if (!disposed) setLoadError(true) })
        return () => {
          disposed = true
          viewRef.current?.dispose(); viewRef.current = null
        }
      }, [attempt])
      React.useEffect(() => { viewRef.current?.update(graph, focus) }, [graph, focus])
      React.useEffect(() => { viewRef.current?.configure(options) }, [options])
      const icon = (label, text, action, extra = {}) => h('button', {
        type: 'button', className: 'dshm-graph-icon', title: t(label), 'aria-label': t(label), onClick: action, ...extra,
      }, text)
      return h('div', { className: 'dshm-graph-viewport' },
        h('div', { className: 'dshm-graph-toolbar' },
          icon('graphZoomOut', '-', () => viewRef.current?.zoom(.8)),
          h('output', { className: 'dshm-graph-scale', 'aria-label': t('graphView') }, Math.round(zoom * 100) + '%'),
          icon('graphZoomIn', '+', () => viewRef.current?.zoom(1.25)),
          icon('graphFit', '⛶', () => viewRef.current?.fit()),
          icon('graphOptions', h(GlyphSliders), () => setSettingsOpen(value => !value), { 'aria-expanded': settingsOpen })),
        settingsOpen ? h('div', { className: 'dshm-graph-options' },
          [['repulsion', 'graphRepulsion', 30, 350], ['distance', 'graphDistance', 40, 220]].map(([key, label, min, max]) =>
            h('label', { key }, t(label), h('input', { type: 'range', min, max, step: 5, value: options[key],
              onChange: event => setOptions(value => ({ ...value, [key]: Number(event.target.value) })) }))),
          [['labels', 'graphLabels'], ['motion', 'graphMotion']].map(([key, label]) =>
            h('label', { key }, h('input', { type: 'checkbox', checked: options[key],
              onChange: event => setOptions(value => ({ ...value, [key]: event.target.checked })) }), t(label)))) : null,
        h('canvas', { ref, className: 'dshm-graph-canvas', role: 'img', tabIndex: 0, 'aria-label': t('graphView') }),
        h('div', { ref: tooltipRef, className: 'dshm-graph-tooltip', hidden: true, 'aria-hidden': true }),
        loadError ? h('div', { className: 'dshm-graph-error', role: 'alert' },
          h('button', { className: 'dshm-btn', type: 'button', onClick: () => setAttempt(value => value + 1) }, t('graphLoadError'))) : null)
    }

    function RelationshipPanel({ call, libraryId, entities, files, t }) {
      const [from, setFrom] = React.useState('')
      const [to, setTo] = React.useState('')
      const [snapshot, setSnapshot] = React.useState(null)
      const [message, setMessage] = React.useState('')
      React.useEffect(() => {
        let alive = true
        setSnapshot(null)
        if (from && to && from !== to) void call('getRelationship', { libraryId, fromId: from, toId: to })
          .then(value => { if (alive) setSnapshot(value.relationship || { state: {} }) })
          .catch(error => { if (alive) setMessage(String(error.message || error)) })
        return () => { alive = false }
      }, [call, libraryId, from, to])
      const options = entities.map(entity => h('option', { key: entity.id, value: entity.id }, entity.name))
      return h('details', null, h('summary', null, t('relationState')),
        h('div', { className: 'dshm-graph-tools' },
          h('select', { value: from, title: t('focusMemory'), onChange: event => setFrom(event.target.value) }, h('option', { value: '' }, '—'), options),
          ' → ', h('select', { value: to, title: t('relationTarget'), onChange: event => setTo(event.target.value) }, h('option', { value: '' }, '—'), options)),
        snapshot ? h('form', { key: from + to + (snapshot.revision || 0), onSubmit: async event => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          const state = {}
          for (const key of ['familiarity', 'trust', 'warmth']) state[key] = values.get(key) === '' ? null : Number(values.get(key))
          for (const key of ['boundaries', 'callbacks', 'openPromises']) state[key] = String(values.get(key) || '').split('\n').map(value => value.trim()).filter(Boolean)
          try {
            const value = await call('updateRelationship', { libraryId, fromId: from, toId: to, state, evidenceIds: [values.get('evidence')], reason: values.get('reason') })
            setSnapshot(value.relationship); setMessage(t('saved')); notifyMemoryWrite('relation', libraryId)
          } catch (error) { setMessage(String(error.message || error)) }
          setTimeout(() => setMessage(''), 2600)
        } },
          h('div', { className: 'dshm-graph-tools' }, ['familiarity', 'trust', 'warmth'].map(key => h('label', { key }, t(key),
            h('input', { type: 'number', name: key, min: 0, max: 1, step: .05, defaultValue: snapshot.state?.[key] ?? '' })))),
          ['boundaries', 'callbacks', 'openPromises'].map(key => h('label', { key, className: 'dshm-relation-field' }, t(key),
            h('textarea', { name: key, rows: 2, defaultValue: (snapshot.state?.[key] || []).join('\n') }))),
          h('div', { className: 'dshm-graph-tools' },
            h('select', { name: 'evidence', required: true, title: t('relationEvidence'), defaultValue: snapshot.evidenceIds?.[0] || '' },
              h('option', { value: '' }, t('relationEvidence')), files.map(file => h('option', { key: file.id, value: file.id }, file.title || file.id))),
            h('input', { name: 'reason', required: true, minLength: 8, placeholder: t('relationNote'), defaultValue: snapshot.reason || '' }),
            h('button', { type: 'submit', className: 'dshm-btn', style: S.btn }, t('save'))),
          snapshot.history?.length ? h('details', null, h('summary', null, t('relationHistory') + ' (' + snapshot.history.length + ')'),
            snapshot.history.slice(-10).reverse().map((item, index) => h('p', { key: index }, item.validFrom + ' → ' + item.validTo + ' · ' + item.reason))) : null) : null,
        message ? h('p', { role: 'status' }, message) : null)
    }

    function GraphPanel({ call, libraryId, files, t }) {
      const [graph, setGraph] = React.useState({ nodes: [], edges: [] })
      const [entities, setEntities] = React.useState([])
      const [focus, setFocus] = React.useState('')
      const [target, setTarget] = React.useState('')
      const [kind, setKind] = React.useState('relation')
      const [note, setNote] = React.useState('')
      const [entityName, setEntityName] = React.useState('')
      const [entityKind, setEntityKind] = React.useState('person')
      const [armed, setArmed] = React.useState('')
      // deleteEntity 被后端拒绝（仍被引用）的实体 id：此时再点确认升级为 force。
      const [deleteRefused, setDeleteRefused] = React.useState('')
      const [error, setError] = React.useState('')
      const requestId = React.useRef(0)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; requestId.current++ }
      }, [])
      const refresh = React.useCallback(async () => {
        const id = ++requestId.current
        const [next, list] = await Promise.all([
          call('getGraph', { libraryId, focusId: focus || null, depth: 2, limit: 200 }),
          call('listEntities', { libraryId }),
        ])
        if (mounted.current && id === requestId.current) {
          setGraph(next); setEntities(list.items || []); setError('')
        }
      }, [call, libraryId, focus])
      React.useEffect(() => {
        let active = true
        if (libraryId) refresh().catch(error => { if (active) setError(String(error.message || error)) })
        return () => { active = false; requestId.current++ }
      }, [refresh, files])
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(''), 2500)
        return () => clearTimeout(timer)
      }, [armed])
      React.useEffect(() => {
        if (!error) return undefined
        const timer = setTimeout(() => setError(''), 2600)
        return () => clearTimeout(timer)
      }, [error])
      const act = async (method, payload) => {
        try {
          await call(method, { libraryId, ...payload })
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) await refresh()
        } catch (error) { if (mounted.current) setError(String(error.message || error)) }
      }
      const titles = new Map(graph.nodes.map(node => [node.id, node.missing ? t('deletedNode') : node.title]))
      const edges = graph.edges.filter(edge => !focus || edge.from === focus || edge.to === focus).sort((a, b) => b.confidence - a.confidence)
      // 实体行：改名表单 + 删除按钮。删除是文字按钮（§6.4 包 D，原灰色 × 读不出
      // 语义）：未 armed 显示「删除」，armed 显示「确认删除」，后端拒绝过（仍被
      // 引用）再点确认升级为 force——「确认删除!」，连同引用一起删，force 明示的
      // 代价。title 与两段确认保持不变，后端 force 语义零改动。
      const entityForm = entity => h('form', { key: entity.id, className: 'dshm-graph-tools', onSubmit: event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        void act('renameEntity', { entityId: entity.id, name: String(data.get('name')), aliases: String(data.get('aliases')).split(',').map(value => value.trim()).filter(Boolean) })
      } },
        h('input', { name: 'name', defaultValue: entity.name, 'aria-label': t('entityName') }),
        h('input', { name: 'aliases', defaultValue: (entity.aliases || []).join(', '), placeholder: t('entityAliases'), 'aria-label': t('entityAliases') }),
        h('button', { type: 'submit', className: 'dshm-btn', style: S.btn }, t('save')),
        h('button', {
          type: 'button',
          className: `dshm-graph-unlink${armed === 'entity:' + entity.id ? ' is-armed' : ''}`,
          title: deleteRefused === entity.id ? t('entityDeleteForceHint') : t('entityDelete'),
          'aria-label': deleteRefused === entity.id ? t('entityDeleteForceHint') : t('entityDelete'),
          onClick: async () => {
            const key = 'entity:' + entity.id
            if (armed !== key) { setArmed(key); return }
            try {
              await call('deleteEntity', { libraryId, entityId: entity.id, force: deleteRefused === entity.id })
              setArmed(''); setDeleteRefused('')
              notifyMemoryWrite('relation', libraryId)
              if (mounted.current) await refresh()
            } catch (failure) {
              const message = String(failure?.message || failure)
              if (/referenced|引用/.test(message)) setDeleteRefused(entity.id)
              if (mounted.current) setError(message)
            }
          },
        }, armed === 'entity:' + entity.id ? (deleteRefused === entity.id ? t('relationConfirm') + '!' : t('relationConfirm')) : t('entityDelete')))
      return h('div', null,
        error ? h('div', { className: 'dshm-toast', role: 'status' }, error) : null,
        h('div', { className: 'dshm-graph-tools' },
          h('select', { value: focus, title: t('focusMemory'), onChange: event => setFocus(event.target.value) },
            h('option', { value: '' }, t('focusMemory')),
            [...files, ...entities.map(entity => ({ id: entity.id, title: entity.name }))].map(file =>
              h('option', { key: file.id, value: file.id }, file.title || file.id)))),
        graph.truncated ? h('p', null, t('graphLimited')) : null,
        // The canvas and the adjacency list are one view: the picture shows the
        // shape, the list keeps the reasons readable and clickable. Neither is an
        // alternate mode, so there is no toggle to forget.
        h('div', { className: 'dshm-graph-stage' },
          h(GraphCanvas, { key: libraryId, graph, focus, onFocus: setFocus, t }),
          h('div', { className: 'dshm-graph-list' }, edges.length ? edges.map(edge => h('div', { key: edge.from + edge.to + edge.kind, className: 'dshm-graph-edge' },
            h('div', null, h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.from) }, titles.get(edge.from) || edge.from),
              ' → ', h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.to) }, titles.get(edge.to) || edge.to),
              // 私有自动关联（§5.7）：source:'auto' 的边来自算法/实体枢纽，不是用户手连。
              // 只多一个可点读的小 Tag；kind/confidence/note 与移除按钮保持原样。
              edge.source === 'auto' ? h('span', { style: { margin: '0 5px', verticalAlign: 'middle' } }, h(Tag, { tone: 'info' }, t('graphAutoLink'))) : null,
              h('small', null, edge.kind + ' · ' + Math.round(edge.confidence * 100) + '% · ' + edge.note)),
            h('button', {
              type: 'button',
              className: `dshm-graph-unlink${armed === edge.from + edge.to + edge.kind ? ' is-armed' : ''}`,
              title: t('relationRemove'),
              onClick: () => {
                const key = edge.from + edge.to + edge.kind
                if (armed !== key) setArmed(key)
                else { setArmed(''); void act('unlinkEntry', { fromId: edge.from, toId: edge.to, kind: edge.kind }) }
              },
            }, armed === edge.from + edge.to + edge.kind ? t('relationConfirm') : '×'))) : h(Empty, null, t('graphEmpty')))),
        h('div', { className: 'dshm-graph-tools' },
          h('select', { value: target, title: t('relationTarget'), onChange: event => setTarget(event.target.value) },
            h('option', { value: '' }, t('relationTarget')),
            [...files, ...entities.map(entity => ({ id: entity.id, title: entity.name }))].filter(file => file.id !== focus).map(file => h('option', { key: file.id, value: file.id }, file.title || file.id))),
          h('select', { value: kind, title: t('relationKind'), onChange: event => setKind(event.target.value) }, ['relation', 'commitment', 'event', 'person', 'conflict'].map(value => h('option', { key: value, value }, value))),
          h('input', { value: note, placeholder: t('relationNote'), onChange: event => setNote(event.target.value) }),
          h(Button, { disabled: !focus || !target || note.trim().length < 8, onClick: () => act('linkEntries', { fromId: focus, toId: target, kind, note }) }, t('relationCreate'))),
        h('div', { className: 'dshm-graph-tools' },
          h('input', { value: entityName, placeholder: t('entityName'), onChange: event => setEntityName(event.target.value) }),
          h('select', { value: entityKind, title: t('entityKind'), onChange: event => setEntityKind(event.target.value) }, ['person', 'place', 'thing', 'org'].map(value => h('option', { key: value, value }, value))),
          h(Button, { disabled: !entityName.trim(), onClick: () => act('createEntity', { name: entityName, kind: entityKind }) }, t('entityNew'))),
        h(RelationshipPanel, { call, libraryId, entities, files, t }),
        entities.length === 0 ? h(Empty, null, t('entityEmpty')) : null,
        // 孤立分组（§6.4 包 D）：listEntities 给出 linked 派生标记。被引用的实体照常
        // 渲染；孤立实体（linked=false，没有任何记忆 link/关系快照指着）收进折叠区，
        // 默认收起——它们是启动 prune 还没跑到的残余，不该和正常实体平起平坐。
        entities.filter(entity => entity.linked !== false).map(entityForm),
        (() => {
          const orphans = entities.filter(entity => entity.linked === false)
          if (!orphans.length) return null
          return h('details', { key: 'dshm-orphans', className: 'dshm-graph-orphans', style: { margin: '8px 0' } },
            h('summary', { style: { cursor: 'pointer', fontSize: 12, color: V.textDim } },
              t('orphanEntities').replace('{n}', String(orphans.length))),
            h('div', { style: { ...S.muted, margin: '6px 0' } }, t('orphanPruneHint')),
            orphans.map(entityForm))
        })())
    }

    function InboundToolsInput({ names, onChange }) {
      const [text, setText] = React.useState(() => names.join(', '))
      const focused = React.useRef(false)
      const key = JSON.stringify(names)
      React.useEffect(() => { if (!focused.current) setText(names.join(', ')) }, [key])
      return h('input', {
        className: 'dshm-inbound-tools', type: 'text', value: text,
        onFocus: () => { focused.current = true },
        onBlur: () => { focused.current = false },
        onChange: event => {
          setText(event.target.value)
          const values = [...new Set(event.target.value.split(',').map(value => value.trim()).filter(Boolean))]
          if (values.length <= 20 && values.every(value => /^[A-Za-z0-9_.:/-]{1,160}$/.test(value))) onChange(values)
        },
      })
    }

    function WallCover({ item }) {
      const [failed, setFailed] = React.useState(false)
      const cover = (item.attachments || []).find(entry => entry.url && !entry.hidden && !entry.missing)
      if (!cover || failed) return null
      return h('span', { className: 'dshm-wall-cover' },
        h('img', { src: cover.url, alt: '', loading: 'lazy', onError: () => setFailed(true) }),
        item.attachmentCount > 1 ? h('span', { className: 'dshm-wall-cover-count' }, '▧ ' + item.attachmentCount) : null)
    }

    function MemoryWallPanel({ call, libraries, revision, stamp, onOpen, t, indexed = null, focus = null, onNotice = null, initialLibraryId = '' }) {
      // 成功提示走宿主面板的 notice 通道（spec §6.2）：失败仍走本面板的 error 通道，
      // 同一动作只走一条。onNotice 缺省时静默（面板也可能在无 notice 通道的宿主里用）。
      const notice = (message) => { if (typeof onNotice === 'function' && message) onNotice(message) }
      const [data, setData] = React.useState({ items: [], total: 0, errors: [] })
      const [libraryId, setLibraryId] = React.useState(initialLibraryId || '')
      const [multiBlocked, setMultiBlocked] = React.useState(false)
      const [view, setView] = React.useState('memories')
      const [graphLib, setGraphLib] = React.useState('')
      const [pool, setPool] = React.useState('active')
      const [layer, setLayer] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState('')
      const [version, setVersion] = React.useState(0)
      // 组分类：私有 / 全局两块，默认私有、私有靠前。全局条目只读，所以多选只在私有块。
      const [scope, setScope] = React.useState('private')
      const [multi, setMulti] = React.useState(false)
      const [selectedIds, setSelectedIds] = React.useState(() => new Set())
      const [wallBusy, setWallBusy] = React.useState(false)
      const [deleteArmedMulti, setDeleteArmedMulti] = React.useState(false)
      // Opens in place instead of jumping to the browser: one card, one request, and
      // the wall stays where the reader left it. `null` means the drawer is closed.
      const [detail, setDetail] = React.useState(null)
      const [deleteArmed, setDeleteArmed] = React.useState(false)
      const reload = () => setVersion(value => value + 1)
      // 全局记忆页"查看此记忆"的落点：带着 id 进来，定位到对应块并直接开抽屉。
      React.useEffect(() => {
        if (!focus?.id) return
        setMulti(false)
        setSelectedIds(new Set())
        setScope(focus.libraryId ? 'private' : 'global')
        void openDetail({ id: focus.id, libraryId: focus.libraryId || null, title: focus.title || focus.id })
      }, [focus])
      const firstLibraryId = libraries?.[0]?.id || ''
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const value = await call('browseWall', { libraryId: libraryId || null, limit: 300 })
            if (!alive) return
            setData(value)
            setError('')
          } catch (failure) {
            if (!alive) return
            const message = String(failure?.message || failure)
            // 宿主对“全部记忆库”多库读取返回 403（browseWall 无法表达为单库授权）时，
            // 退到第一个库并明确告知；单库 + 全局（browseWall 总会带全局）仍能出数据，
            // 不再整页空。用户可手动切换库；多库选项保留为禁用。
            if (!libraryId && firstLibraryId && /forbidden|403/i.test(message)) {
              try {
                const value = await call('browseWall', { libraryId: firstLibraryId, limit: 300 })
                if (!alive) return
                setData(value)
                setError('')
                setMultiBlocked(true)
                setLibraryId(firstLibraryId)
                return
              } catch (fallbackFailure) {
                if (alive) setError(String(fallbackFailure?.message || fallbackFailure))
                return
              }
            }
            setError(message)
          }
        }
        void load()
        return () => { alive = false }
      }, [call, libraryId, revision, stamp, version, firstLibraryId])
      React.useEffect(() => {
        if (graphLib && libraries.some((lib) => lib.id === graphLib)) return
        const selected = libraryId && libraries.some((lib) => lib.id === libraryId) ? libraryId : ''
        const first = selected || libraries[0]?.id || ''
        if (first) setGraphLib(first)
        else if (graphLib) setGraphLib('')
      }, [graphLib, libraryId, libraries])
      React.useEffect(() => {
        if (!detail) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setDetail(null) }
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('keydown', onKey)
          document.body.style.overflow = previous
        }
      }, [detail])

      const poolOf = item => item.status === 'pending_review' ? 'review' : item.status === 'archived' ? 'archived'
        : ['suppressed', 'expired', 'superseded'].includes(item.status) || item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? 'inactive' : 'active'
      const items = Array.isArray(data?.items) ? data.items : []
      const inScope = item => scope === 'global' ? item.libraryId === null : item.libraryId !== null
      const scoped = items.filter(inScope)
      const rows = scoped.filter(item => poolOf(item) === pool)
      const keyOf = item => (item.libraryId || 'global') + item.id
      const selectedRows = visible => visible.filter(item => selectedIds.has(keyOf(item)))
      const layerMatch = (item, value) => value === 'all' || (value === 'anchor' ? item.layer === 'must_remember' && poolOf(item) === 'active' : item.layer === value)
      const text = String(query || '').toLowerCase()
      const visible = rows.filter(item => layerMatch(item, layer) && (!text || [item.title, item.preview, (item.tags || []).join(' ')].join(' ').toLowerCase().includes(text)))

      const draftOf = (file) => ({
        title: file.title || '',
        content: file.content || '',
        tags: (Array.isArray(file.tags) ? file.tags : []).join(', '),
        openLoop: file.openLoop === true,
        disclosure: file.disclosure || 'can_tell',
        confidence: typeof file.confidence === 'number' ? String(file.confidence) : '',
        // The date is the field most likely to be wrong (a day, a year, a one-off
        // versus a recurring anniversary), so the panel must be able to correct it.
        salientDate: file.salientDate || '',
      })
      const patchDraft = (patch) => setDetail(prev => prev && prev.draft
        ? { ...prev, draft: { ...prev.draft, ...patch } }
        : prev)
      const openDetail = async (item) => {
        setDeleteArmed(false)
        setDetail({ item, file: null, draft: null, busy: true, error: '', readonly: !item.libraryId })
        try {
          if (item.libraryId) {
            const res = await call('getMemory', { libraryId: item.libraryId, id: item.id })
            const file = { id: res.id, libraryId: res.libraryId, ...res.entry, attachments: res.attachments || [] }
            setDetail({ item, file, draft: draftOf(file), busy: false, error: '', readonly: false })
            return
          }
          const res = await call('listGlobal', {})
          const file = (res.files || []).find(entry => entry.id === item.id) || null
          setDetail({ item, file, draft: null, busy: false, error: file ? '' : t('memoryMissing'), readonly: true })
        } catch (failure) {
          setDetail(prev => prev ? { ...prev, busy: false, error: String(failure?.message || failure) } : prev)
        }
      }
      const refreshDetail = async (current) => {
        const res = await call('getMemory', { libraryId: current.item.libraryId, id: current.item.id })
        const file = { id: res.id, libraryId: res.libraryId, ...res.entry, attachments: res.attachments || [] }
        setDetail({ ...current, file, draft: draftOf(file), busy: false, error: '' })
        reload()
      }
      const saveDetail = async () => {
        const current = detail
        if (!current?.file || current.readonly || !current.draft) return
        setDetail({ ...current, busy: true, error: '' })
        try {
          const draft = current.draft
          const patch = {
            title: draft.title,
            content: draft.content,
            tags: draft.tags.split(',').map(value => value.trim()).filter(Boolean),
            openLoop: draft.openLoop,
            disclosure: draft.disclosure,
            // Empty string is the "clear the date" sentinel the RPC understands.
            salientDate: String(draft.salientDate || '').trim(),
          }
          const confidence = draft.confidence === '' ? NaN : Number(draft.confidence)
          if (Number.isFinite(confidence)) patch.confidence = Math.max(0, Math.min(1, confidence))
          await call('updateMemory', { libraryId: current.item.libraryId, id: current.item.id, patch })
          await refreshDetail(current)
          notice(t('memorySaved'))
        } catch (failure) {
          setDetail(prev => prev ? { ...prev, busy: false, error: String(failure?.message || failure) } : prev)
        }
      }
      const setDetailStatus = async (status) => {
        const current = detail
        if (!current?.file || current.readonly) return
        setDetail({ ...current, busy: true, error: '' })
        try {
          await call('updateMemory', { libraryId: current.item.libraryId, id: current.item.id, patch: { status } })
          await refreshDetail(current)
          // 归档/恢复/保存是三个不同结果，同一条通知通道但各说各话。
          notice(status === 'archived' ? t('memoryArchived') : status === 'active' ? t('memoryRestored') : t('memorySaved'))
        } catch (failure) {
          setDetail(prev => prev ? { ...prev, busy: false, error: String(failure?.message || failure) } : prev)
        }
      }
      const deleteDetail = async () => {
        const current = detail
        if (!current?.file || current.readonly || current.file.status !== 'archived') return
        setDetail({ ...current, busy: true, error: '' })
        try {
          await call('deleteMemory', { libraryId: current.item.libraryId, id: current.item.id })
          setDetail(null)
          setDeleteArmed(false)
          notifyMemoryWrite('memory', current.item.libraryId)
          notice(t('memoryDeleted'))
          reload()
        } catch (failure) {
          setDetail(prev => prev ? { ...prev, busy: false, error: String(failure?.message || failure) } : prev)
        }
      }

      // —— 多选批量操作（只对私有块生效；全局只读）——
      // 逐条走既有 RPC（updateMemory patch.status / deleteMemory），循环里失败的条目
      // 记下来一次性报错：部分成功不能说成全部成功，也不该让一条失败吞掉其余的成果。
      const exitMulti = () => { setMulti(false); setSelectedIds(new Set()); setDeleteArmedMulti(false) }
      const bulkApply = async (action) => {
        const targets = selectedRows(visible).filter(item => action === 'archive'
          ? ['active', 'inactive'].includes(poolOf(item))
          : action === 'restore' || action === 'delete' ? item.status === 'archived' : false)
        if (targets.length === 0) return
        setWallBusy(true); setError('')
        let done = 0
        const failures = []
        for (const item of targets) {
          try {
            if (action === 'delete') await call('deleteMemory', { libraryId: item.libraryId, id: item.id })
            else await call('updateMemory', { libraryId: item.libraryId, id: item.id, patch: { status: action === 'archive' ? 'archived' : 'active' } })
            done += 1
          } catch (failure) { failures.push(`${item.title || item.id}: ${String(failure?.message || failure)}`) }
        }
        setWallBusy(false)
        setDeleteArmedMulti(false)
        setSelectedIds(new Set())
        if (done > 0) { notifyMemoryWrite('memory', libraryId || null); reload() }
        // 部分成功不说成全部成功：有失败只走 error（带 done/total 前缀），全成功才报 notice。
        if (failures.length > 0) setError(`${done}/${targets.length} · ` + failures.slice(0, 3).join('；'))
        else if (done > 0) notice(t('bulkDone').replace('{n}', String(done)))
      }

      const shown = detail ? { ...detail.item, ...(detail.file || {}) } : null
      const detailForm = detail && detail.file && !detail.readonly
        ? h('div', { className: 'dshm-drawer-form' },
          h('input', {
            style: S.input, value: detail.draft.title, placeholder: t('memoryTitle'),
            'aria-label': t('memoryTitle'), onChange: (event) => patchDraft({ title: event.target.value }),
          }),
          h('textarea', {
            style: { ...S.textarea, minHeight: 170 }, value: detail.draft.content,
            'aria-label': t('memoryContent'), onChange: (event) => patchDraft({ content: event.target.value }),
          }),
          h('input', {
            style: S.input, value: detail.draft.tags, placeholder: 'tag1, tag2',
            'aria-label': t('tagsLabel'), onChange: (event) => patchDraft({ tags: event.target.value }),
          }),
          h('label', { className: 'dshm-drawer-field' },
            h('span', { className: 'dshm-drawer-label' }, t('salientDateLabel')),
            h('input', {
              style: S.input, value: detail.draft.salientDate || '', placeholder: t('salientDatePlaceholder'),
              onChange: (event) => patchDraft({ salientDate: event.target.value }),
            })),
          h('div', { className: 'dshm-drawer-inline' },
            h('label', { className: 'dshm-drawer-field' },
              h('span', { className: 'dshm-drawer-label' }, t('disclosureLabel')),
              h('select', {
                style: S.input,
                value: detail.draft.disclosure,
                onChange: (event) => patchDraft({ disclosure: event.target.value }),
              }, ['can_tell', 'only_if_asked', 'never_say'].map(value => h('option', { key: value, value }, enumText(t, DISCLOSURE_LABELS, value))))),
            h('label', { className: 'dshm-drawer-field is-narrow' },
              h('span', { className: 'dshm-drawer-label' }, t('confidenceLabel')),
              h('input', {
                style: S.input, type: 'number', min: 0, max: 1, step: 0.05,
                value: detail.draft.confidence,
                onChange: (event) => patchDraft({ confidence: event.target.value }),
              })),
            h('label', { className: 'dshm-drawer-switch' },
              h('input', {
                type: 'checkbox', checked: detail.draft.openLoop,
                onChange: (event) => patchDraft({ openLoop: event.target.checked }),
              }),
              t('openLoopTag'))),
          h('div', { className: 'dshm-drawer-note' },
            t('decay') + ' ' + Math.round((Number(shown.decay) || 0) * 100) + '% · ' +
            (shown.updatedAt ? String(shown.updatedAt).slice(0, 16).replace('T', ' ') : '')))
        : detail && detail.file && detail.readonly
          ? (() => {
            // 全局条目只读（spec §6.7 UI）：详情抽屉里只读展示 links / absorbedFrom，
            // 不提供编辑、不提供手动全局关联。links 移除按钮在全局页（F1 接入）。
            const absorbed = Array.isArray(detail.file.absorbedFrom) ? detail.file.absorbedFrom : []
            const links = Array.isArray(detail.file.links) ? detail.file.links : []
            return h(React.Fragment, null,
              h('p', { className: 'dshm-drawer-copy' }, detail.file.content || shown.preview),
              absorbed.length || links.length
                ? h('div', { className: 'dshm-drawer-note', style: { lineHeight: 1.7 } },
                  absorbed.length
                    ? h('div', null, h('strong', null, t('absorbSourcesTag').replace('{n}', String(absorbed.length))),
                      h('div', { style: { marginTop: 2 } }, absorbed.slice(0, 8).join('、'),
                        absorbed.length > 8 ? `… +${absorbed.length - 8}` : ''))
                    : null,
                  links.length
                    ? h('div', { style: absorbed.length ? { marginTop: 6 } : null },
                      h('strong', null, `${t('absorbLinksLabel')} · ${links.length}`),
                      h('div', { style: { marginTop: 2 } }, links.slice(0, 8).map((link, index) =>
                        h('div', { key: `${link.id || index}` }, `· ${link.kind || 'related'} → ${link.to || '?'}`)),
                      links.length > 8 ? h('div', null, `… +${links.length - 8}`) : null))
                    : null)
                : null,
              h('p', { className: 'dshm-drawer-note' }, t('globalReadOnly')))
          })()
          : detail && detail.busy
            ? h(Empty, null, t('loading'))
            : null

      const detailView = detail
        ? h('div', {
          className: 'dshm-drawer-backdrop',
          onClick: (event) => { if (event.target === event.currentTarget) setDetail(null) },
        },
        h('aside', {
          className: 'dshm-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': shown.title || shown.id,
        },
        h('div', { className: 'dshm-drawer-head' },
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'dshm-overline' },
              (shown.libraryId ? shown.libraryName : t('globalMemory')) + ' · ' + enumText(t, LAYER_LABELS, shown.layer)),
            h('h3', { className: 'dshm-drawer-title' }, shown.title || shown.id),
            h('div', { className: 'dshm-drawer-meta' },
              h(Tag, { tone: shown.source === 'imagined' ? 'warn' : (shown.source === 'user_said' ? 'info' : undefined) },
                enumText(t, SOURCE_LABELS, shown.source)),
              h(Tag, null, enumText(t, STATUS_LABELS, shown.status)),
              // 这条记忆有没有进向量库，直接写在条目上（remember 提交成功后落盘）。
              shown.vector
                ? h(Tag, { tone: 'info' }, `${t('vectorIndexedTag')}${shown.vector.model ? ' · ' + shown.vector.model : ''}${shown.vector.generation ? ' · g' + shown.vector.generation : ''}`)
                : (() => {
                  // 迁移写库不碰索引，老条目没有 entry.vector；用账本判断它是否已入当前代际。
                  const bucketKey = detail.item.libraryId || 'global'
                  const ids = indexed && Array.isArray(indexed[bucketKey]) ? indexed[bucketKey] : null
                  return ids && ids.includes(detail.item.id) ? h(Tag, { tone: 'info' }, t('vectorIndexedMigrated')) : null
                })(),
              shown.openLoop ? h(Tag, null, t('openLoopTag')) : null,
              shown.marginalized ? h(Tag, null, t('marginalizedTag')) : null)),
          h('button', { type: 'button', className: 'dshm-x', 'aria-label': t('close'), onClick: () => setDetail(null) }, '×')),
        detail.error ? h('div', { className: 'dshm-error', role: 'alert' }, detail.error) : null,
        detailForm,
        detail.file && !detail.readonly ? h(MemoryAttachments, { items: detail.file.attachments, t, initialOpen: true }) : null,
        h('div', { className: 'dshm-drawer-actions' },
          !detail.readonly
            ? h(Button, { primary: true, disabled: detail.busy, onClick: () => { void saveDetail() } }, t('save'))
            : null,
          !detail.readonly && detail.file
            ? h(Button, {
              style: S.ghost,
              disabled: detail.busy,
              onClick: () => { void setDetailStatus(detail.file.status === 'archived' ? 'active' : 'archived') },
            }, detail.file.status === 'archived' ? t('restore') : t('archive'))
            : null,
          !detail.readonly && detail.file?.status === 'archived'
            ? deleteArmed
              ? h(React.Fragment, null,
                h(Button, {
                  style: { ...S.ghost, color: V.danger, borderColor: V.danger },
                  disabled: detail.busy,
                  onClick: () => { void deleteDetail() },
                }, t('confirmDelete')),
                h(Button, { style: S.ghost, disabled: detail.busy, onClick: () => setDeleteArmed(false) }, t('cancelDelete')))
              : h(Button, {
                style: { ...S.ghost, color: V.danger },
                disabled: detail.busy,
                title: t('browseArchivedHint'),
                onClick: () => setDeleteArmed(true),
              }, t('deleteForever'))
            : null,
          h(Button, {
            style: S.ghost,
            onClick: () => { const item = detail.item; setDetail(null); onOpen(item) },
          }, t('openInBrowser')),
          h(Button, { style: S.ghost, onClick: () => setDetail(null) }, t('close')))))
        : null

      const validLib = (id) => id && libraries.some((lib) => lib.id === id) ? id : ''
      const graphLibrary = validLib(graphLib) || validLib(libraryId) || libraries[0]?.id || ''
      const graphFiles = React.useMemo(() => items
        .filter(item => item.libraryId === graphLibrary)
        .map(item => ({ id: item.id, title: item.title })), [items, graphLibrary])
      const graphView = h('div', { className: 'dshm-card dshm-wall-graph' },
        libraries.length === 0
          ? h(Empty, null, t('noLibraries'))
          : h(React.Fragment, null,
            h('div', { className: 'dshm-graph-tools' },
              h('select', {
                value: graphLibrary,
                title: libraries.find((lib) => lib.id === graphLibrary)?.scopeKey || t('currentLibrary'),
                // One library drives both views, otherwise the graph's focus list can
                // be empty when the wall is filtered to a different library.
                onChange: (event) => { setGraphLib(event.target.value); setLibraryId(event.target.value) },
              },
              libraries.map(lib => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries))))),
            h(GraphPanel, { key: graphLibrary, call, libraryId: graphLibrary, files: graphFiles, t })))

      // Category filters used to reuse the compact nav pills (2px gap, 30px high) and
      // stacked directly on top of each other. Give every group its own segmented
      // control, a label and breathing room so the state/layer filters are distinct.
      const wallTabGroup = (items, current, onSelect, { label = '', className = '', marginTop = 0, extra = null } = {}) => h('div', {
        className,
        style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: `${marginTop}px 0 0` },
      },
        label ? h('span', { style: { ...S.muted, fontSize: 11.5, minWidth: 30 } }, label) : null,
        h('div', {
          role: 'tablist',
          'aria-label': label || undefined,
          style: {
            display: 'inline-flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 4,
            padding: 4, maxWidth: '100%', boxSizing: 'border-box',
            border: `1px solid ${V.borderSoft}`, borderRadius: V.radius, background: V.surface,
          },
        }, items.map(([value, text]) => {
          const selected = current === value
          return h('button', {
            key: value, type: 'button', role: 'tab', 'aria-selected': selected,
            className: 'dshm-nav-item',
            style: {
              height: 34, minHeight: 34, padding: '0 14px', border: 0, borderRadius: V.radiusSm,
              background: selected ? V.accentSoft : 'transparent',
              color: selected ? V.accent : V.textDim,
              fontWeight: selected ? 650 : 500, fontSize: 12.5, lineHeight: 1.2,
              cursor: 'pointer', whiteSpace: 'nowrap',
              transition: 'background .18s ease, color .18s ease',
            },
            onClick: () => onSelect(value),
          }, text)
        })),
        extra)

      const scopeItems = [['private', 'wallScopePrivate'], ['global', 'wallScopeGlobal']]
        .map(([value, key]) => [value, t(key) + ' (' + items.filter(item => value === 'global' ? item.libraryId === null : item.libraryId !== null).length + ')'])
      const poolItems = [['active', 'browseActiveTab'], ['archived', 'browseArchivedTab'], ['review', 'poolReview'], ['inactive', 'poolInactive']]
        .map(([value, key]) => [value, t(key) + ' (' + scoped.filter(item => poolOf(item) === value).length + ')'])
      const layerItems = ['all', 'must_remember', 'long_term', 'short_term', 'anchor']
        .map(value => [value, (value === 'all' ? t('wallAllLayers') : enumText(t, LAYER_LABELS, value)) + ' (' + rows.filter(item => layerMatch(item, value)).length + ')'])
      const selectedLibrary = libraries.find((lib) => lib.id === libraryId) || null
      const librarySelect = scope === 'private' && libraries.length
        ? h('select', {
          value: libraryId,
          title: selectedLibrary?.scopeKey || t('currentLibrary'),
          'aria-label': t('currentLibrary'),
          style: { ...S.input, flex: '0 1 220px', minWidth: 150, maxWidth: 260 },
          onChange: (event) => {
            const value = event.target.value
            setLibraryId(value)
            if (value) setMultiBlocked(false)
          },
        },
        h('option', { value: '', disabled: multiBlocked }, t('allLibraries')),
        libraries.map((lib) => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries))))
        : null
      const hasOptionControls = scope === 'private' || multiBlocked || data?.total > items.length
      const multiToggle = scope === 'private'
        ? h(Button, {
          'aria-pressed': multi,
          style: multi ? { ...S.ghost, color: V.accent, borderColor: V.accent } : S.ghost,
          onClick: () => { if (multi) exitMulti(); else setMulti(true) },
        }, multi ? t('wallMultiExit') : t('multiSelect'))
        : null
      const multiActions = multi && scope === 'private' ? (() => {
        const chosen = selectedRows(visible)
        const archiveN = chosen.filter(item => ['active', 'inactive'].includes(poolOf(item))).length
        const restoreN = chosen.filter(item => item.status === 'archived').length
        const deleteN = restoreN
        return h(React.Fragment, null,
          h('span', { style: S.muted }, t('wallSelected').replace('{n}', String(chosen.length))),
          h(Button, { style: S.ghost, disabled: chosen.length === visible.length, onClick: () => setSelectedIds(new Set(visible.map(keyOf))) }, t('wallSelectAll')),
          h(Button, { style: S.ghost, disabled: chosen.length === 0, onClick: () => setSelectedIds(new Set()) }, t('wallClearSelection')),
          h(Button, { style: S.ghost, disabled: wallBusy || archiveN === 0, onClick: () => { void bulkApply('archive') } }, t('archive') + ` (${archiveN})`),
          h(Button, { style: S.ghost, disabled: wallBusy || restoreN === 0, onClick: () => { void bulkApply('restore') } }, t('restore') + ` (${restoreN})`),
          deleteArmedMulti
            ? h(React.Fragment, null,
              h(Button, { style: { ...S.ghost, color: V.danger, borderColor: V.danger }, disabled: wallBusy || deleteN === 0, onClick: () => { void bulkApply('delete') } }, t('confirmDelete') + ` (${deleteN})`),
              h(Button, { style: S.ghost, disabled: wallBusy, onClick: () => setDeleteArmedMulti(false) }, t('cancelDelete')))
            : h(Button, { style: { ...S.ghost, color: V.danger }, disabled: wallBusy || deleteN === 0, title: t('browseArchivedHint'), onClick: () => setDeleteArmedMulti(true) }, t('deleteForever') + ` (${deleteN})`))
      })() : null

      return h('div', { className: 'dshm-wall' },
        wallTabGroup([['memories', t('viewMemories')], ['relations', t('viewRelations')]], view, setView, { className: 'dshm-wall-views' }),
        error || data.errors?.length ? h('p', { className: 'dshm-error', role: 'alert' }, error || t('wallReadError')) : null,
        view === 'relations'
          ? graphView
          : h(React.Fragment, null,
            // 组分类：私有 / 全局（默认私有、私有靠前）。计数按各自的块算，切换即重置多选。
            // The library selector belongs to the scope row, not the search row: it
            // narrows the same private block the two tabs switch between.
            wallTabGroup(scopeItems, scope, (value) => { setScope(value); exitMulti() }, { label: t('wallFilterScope'), marginTop: 10, extra: librarySelect }),
            h('div', { className: 'dshm-graph-tools', style: { marginTop: 10, marginBottom: 0 } },
              h('input', {
                type: 'search',
                style: { ...S.input, width: '100%', flex: '1 1 100%' },
                value: query, placeholder: t('searchMemories'), 'aria-label': t('searchMemories'),
                onChange: event => setQuery(event.target.value),
              })),
            hasOptionControls ? h('div', {
              className: 'dshm-graph-tools',
              role: multi ? 'toolbar' : undefined,
              'aria-label': multi ? t('multiSelect') : undefined,
              style: { marginTop: 8, marginBottom: 0 },
            },
              // 多选只对私有块：全局条目只读，批量操作没有意义。
              multiToggle,
              multiActions,
              multiBlocked ? h('span', { style: S.muted, role: 'status' }, t('wallAllBlocked')) : null,
              data?.total > items.length ? h('span', { style: S.muted }, t('wallLimit') + ` (${items.length}/${data.total})`) : null) : null,
            wallTabGroup(poolItems, pool, setPool, { label: t('wallFilterStatus'), marginTop: 12 }),
            wallTabGroup(layerItems, layer, setLayer, { label: t('wallFilterLayer'), marginTop: 10 }),
            visible.length ? h('div', { className: 'dshm-wall-grid' }, visible.map(item =>
              h('button', {
                key: keyOf(item), type: 'button', className: 'dshm-wall-item' + (multi && selectedIds.has(keyOf(item)) ? ' is-selected' : ''),
                style: multi && selectedIds.has(keyOf(item)) ? { outline: '2px solid ' + V.accent, outlineOffset: -2 } : undefined,
                onClick: () => {
                  // 多选模式下点卡片 = 勾选/取消勾选；正常模式打开抽屉。
                  if (multi && scope === 'private') {
                    setSelectedIds(prev => { const next = new Set(prev); if (next.has(keyOf(item))) next.delete(keyOf(item)); else next.add(keyOf(item)); return next })
                    return
                  }
                  void openDetail(item)
                },
              },
                multi && scope === 'private' ? h(Tag, { tone: selectedIds.has(keyOf(item)) ? 'info' : null }, selectedIds.has(keyOf(item)) ? '✓' : '□') : null,
                h(WallCover, { item }),
                h('div', { className: 'dshm-wall-meta' }, h('span', null, item.libraryId ? item.libraryName : t('globalMemory')), h('span', null, enumText(t, LAYER_LABELS, item.layer))),
                h('strong', null, item.title || item.id),
                h('p', null, item.preview),
                h('div', { className: 'dshm-wall-tags' },
                  h(Tag, null, enumText(t, SOURCE_LABELS, item.source)),
                  item.status !== 'active' ? h(Tag, { tone: 'warn' }, enumText(t, STATUS_LABELS, item.status)) : null,
                  item.openLoop ? h(Tag, null, t('openLoopTag')) : null,
                  item.attachmentCount ? h(Tag, null, '▧ ' + item.attachmentCount) : null),
                h('meter', { min: 0, max: 1, value: item.decay, 'aria-label': t('decay') }))))
              : h(Empty, null, t('noMemoriesView'))),
        detailView)
    }

    // The stored enums stay English (they are data); only the display flips with
    // the host language.
    const LEXICON_KIND_LABELS = { slang: 'lexiconKindSlang', meme: 'lexiconKindMeme', trigger: 'lexiconKindTrigger', term: 'lexiconKindTerm' }
    // 公开生命周期两档：页签文案带计数占位符，数字来自 RPC 的 statusCounts。
    const LEXICON_TAB_LABELS = { active: 'lexiconTabActive', archived: 'lexiconTabArchived' }
    const EMPTY_LEXICON_DRAFT = { term: '', kind: 'term', meaning: '', usage: '', aliases: '', examples: '' }

    // 词典页（§2.4）：公开生命周期只有 active / archived，卡片流对齐记忆墙的
    // 交互约定（筛选/分页都在 RPC 侧完成，每页 50 条，客户端不缓存全量），但没有审核
    // ——模型写入直接生效，用户只做编辑 / 归档 / 恢复 / 删除。归档与恢复可逆、一击
    // 生效；删除是管理面独有的永久动作，两段确认。带 sourceMemoryId 的词条可跳回
    // 记忆墙对应条目（wallFocus 接力棒，见 SettingsPage）。
    function LexiconPanel({ call, libraries, t, onFocusMemory, sessionId }) {
      const [libraryId, setLibraryId] = React.useState('')
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('active')
      const [kind, setKind] = React.useState('')
      const [queryInput, setQueryInput] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [page, setPage] = React.useState(1)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [editingId, setEditingId] = React.useState('')
      const [editDraft, setEditDraft] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const [newDraft, setNewDraft] = React.useState(EMPTY_LEXICON_DRAFT)
      const [multi, setMulti] = React.useState(false)
      const [selectedIds, setSelectedIds] = React.useState(() => new Set())
      const [deleteArmed, setDeleteArmed] = React.useState('')
      const [armedBulk, setArmedBulk] = React.useState('')

      // 宿主可能把面板与别的块并排渲染；读取状态时保持类型收窄，坏形状按空值处理，
      // 不在渲染期抛错（设置页任何一块抛错整页都会变空白）。
      const safeNewDraft = newDraft && typeof newDraft === 'object' ? newDraft : EMPTY_LEXICON_DRAFT
      const safeQueryInput = typeof queryInput === 'string' ? queryInput : ''
      const chosenIds = () => selectedIds instanceof Set ? selectedIds : new Set()

      const activeLib = libraryId || libraries[0]?.id || ''
      const emptyView = { items: [], total: 0, page: 1, pages: 1, counts: {}, statusCounts: { active: 0, archived: 0 } }
      const load = React.useCallback(async () => {
        if (!activeLib) { setData(emptyView); return }
        setBusy(true)
        try {
          // 只取当前页、当前页签：状态页签、kind、搜索、分页全在 RPC 侧收窄，
          // 客户端不缓存任何全量词条列表。
          const res = await call('lexiconList', {
            libraryId: activeLib, sessionId: sessionId || undefined, page, pageSize: 50,
            status, kind: kind || undefined, q: query || undefined,
          })
          setData(res || emptyView)
          setError('')
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }, [call, activeLib, page, status, kind, query, sessionId])
      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => {
        if (!error && !notice) return undefined
        const timer = setTimeout(() => { setError(''); setNotice('') }, 2600)
        return () => clearTimeout(timer)
      }, [error, notice])
      // 两段确认要能自行退场：armed 不会一直挂着；切页签/筛选/动作也会显式清掉。
      React.useEffect(() => {
        if (!deleteArmed && !armedBulk) return undefined
        const timer = setTimeout(() => { setDeleteArmed(''); setArmedBulk('') }, 2500)
        return () => clearTimeout(timer)
      }, [deleteArmed, armedBulk])

      const resetSelection = () => { setSelectedIds(new Set()); setDeleteArmed(''); setArmedBulk('') }
      const resetTransient = () => { setEditingId(''); setEditDraft(null); setCreating(false); setMulti(false); resetSelection() }
      const changeLibrary = (value) => { setLibraryId(value); setPage(1); resetTransient() }
      const changeStatus = (value) => {
        if (value === status) return
        setStatus(value); setPage(1); setEditingId(''); setEditDraft(null); resetSelection()
      }
      const changeFilter = (setter) => (value) => { setter(value); setPage(1); setEditingId(''); setEditDraft(null); resetSelection() }
      const applySearch = () => { setQuery(safeQueryInput.trim()); setPage(1); setEditingId(''); setEditDraft(null); resetSelection() }
      const hitsTotal = (e) => {
        const counts = e.hitCounts && typeof e.hitCounts === 'object' ? e.hitCounts : {}
        return (Number(counts.candidate) || 0) + (Number(counts.injection) || 0) + (Number(counts.query) || 0)
      }
      const clipText = (value, max) => {
        const text = String(value ?? '')
        return text.length > max ? text.slice(0, max) + '…' : text
      }
      const draftOf = (e) => ({
        meaning: e.meaning || '',
        usage: e.usage || '',
        aliases: (Array.isArray(e.aliases) ? e.aliases : []).join(', '),
        examples: (Array.isArray(e.examples) ? e.examples : []).join('\n'),
        sensitivity: e.sensitivity || 'normal',
        strength: typeof e.strength === 'number' ? String(e.strength) : '',
      })
      const toggleEdit = (e) => {
        if (editingId === e.id) { setEditingId(''); setEditDraft(null); return }
        setCreating(false)
        setEditingId(e.id)
        setEditDraft(draftOf(e))
      }
      const splitList = (value, limit) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, limit)
      const splitExamples = (value) => String(value || '').split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 8)
      const strengthOf = (value) => {
        if (String(value ?? '').trim() === '') return undefined
        const n = Number(value)
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined
      }
      const act = async (fn) => {
        setBusy(true)
        try { await fn() } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const saveEdit = () => {
        const current = editingId
        const draft = editDraft
        if (!current || !draft) return
        const patch = {
          meaning: draft.meaning,
          usage: draft.usage,
          aliases: splitList(draft.aliases, 20),
          examples: splitExamples(draft.examples),
          sensitivity: draft.sensitivity,
        }
        const strength = strengthOf(draft.strength)
        if (strength !== undefined) patch.strength = strength
        return act(async () => {
          await call('lexiconUpdate', { libraryId: activeLib, sessionId: sessionId || undefined, termId: current, patch })
          setEditingId(''); setEditDraft(null); setDeleteArmed(''); setArmedBulk('')
          notifyMemoryWrite('lexicon', activeLib)
          setNotice(t('lexiconSaveDone'))
          setError('')
          await load()
        })
      }
      // 归档 / 恢复（§2.4）：可逆的一击动作，不走审核、不产生 revision。
      const setLifecycle = (e, action) => {
        setDeleteArmed(''); setArmedBulk('')
        return act(async () => {
          await call(action === 'archive' ? 'lexiconArchive' : 'lexiconRestore', { libraryId: activeLib, termId: e.id })
          notifyMemoryWrite('lexicon', activeLib)
          setNotice(action === 'archive' ? t('lexiconArchiveDone') : t('lexiconRestoreDone'))
          setError('')
          await load()
        })
      }
      // 删除是永久动作，只走管理面：两段确认由卡片按钮负责，这里只发 RPC。
      const deleteTerm = (e) => {
        setDeleteArmed(''); setArmedBulk('')
        return act(async () => {
          await call('lexiconDelete', { libraryId: activeLib, termId: e.id })
          notifyMemoryWrite('lexicon', activeLib)
          setNotice(t('lexiconDeleted').split('{n}').join('1'))
          setError('')
          await load()
        })
      }
      const submitNew = () => {
        const draft = safeNewDraft
        if (!String(draft.term || '').trim() || !String(draft.meaning || '').trim()) return
        return act(async () => {
          await call('lexiconAdd', {
            libraryId: activeLib,
            sessionId: sessionId || undefined,
            term: draft.term, kind: draft.kind, meaning: draft.meaning, usage: draft.usage,
            aliases: splitList(draft.aliases, 20), examples: splitExamples(draft.examples),
          })
          setCreating(false)
          setNewDraft({ ...EMPTY_LEXICON_DRAFT, kind: draft.kind })
          notifyMemoryWrite('lexicon', activeLib)
          setNotice(t('lexiconAddDone'))
          setError('')
          // 新词条总是 active：留在归档页签会看不见刚写入的词，切回使用中。
          setStatus('active')
          setPage(1)
          await load()
        })
      }
      const exitMulti = () => { setMulti(false); resetSelection() }
      const bulkApply = (action) => {
        const wanted = action === 'archive' ? 'active' : action === 'restore' ? 'archived' : null
        const rows = (Array.isArray(data?.items) ? data.items : []).filter((e) => chosenIds().has(e.id) && (!wanted || (e.status || 'active') === wanted))
        if (!rows.length) return
        // 与记忆墙的 bulkApply 同一约定：部分成功不能说成全部成功——成功数进 notice，
        // 失败明细进 error（带 done/total 前缀），两列分开读。
        return act(async () => {
          let done = 0
          const failures = []
          for (const row of rows) {
            try {
              if (action === 'delete') await call('lexiconDelete', { libraryId: activeLib, termId: row.id })
              else await call(action === 'archive' ? 'lexiconArchive' : 'lexiconRestore', { libraryId: activeLib, termId: row.id })
              done += 1
            } catch (failure) { failures.push(`${row.term || row.id}: ${String(failure?.message || failure)}`) }
          }
          setArmedBulk(''); setDeleteArmed(''); setSelectedIds(new Set())
          if (done > 0) {
            notifyMemoryWrite('lexicon', activeLib)
            await load()
            setNotice(action === 'delete'
              ? t('lexiconDeleted').split('{n}').join(String(done))
              : action === 'archive'
                ? t('lexiconArchivedCount').split('{n}').join(String(done))
                : t('lexiconRestoredCount').split('{n}').join(String(done)))
          }
          if (failures.length > 0) setError(`${done}/${rows.length} · ` + failures.slice(0, 3).join('；'))
        })
      }
      const toggleSelect = (id) => setSelectedIds((prev) => {
        const next = prev instanceof Set ? new Set(prev) : new Set()
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
      })

      const items = Array.isArray(data?.items) ? data.items : []
      const counts = data?.counts && typeof data.counts === 'object' ? data.counts : {}
      const statusCounts = data?.statusCounts && typeof data.statusCounts === 'object' ? data.statusCounts : { active: 0, archived: 0 }
      // The old row reused the generic nav pills (2px gap, 30px high) and sat directly
      // above the count tags, so the two rows read as one cramped button cluster. Keep
      // the state switch as its own segmented control and give the counts their own
      // line; the kind counts are real filter chips, not decoration.
      const statusTabs = h('div', {
        role: 'tablist',
        'aria-label': t('lexiconStatus'),
        style: {
          display: 'inline-flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 4,
          padding: 4, margin: '2px 0 12px', maxWidth: '100%', boxSizing: 'border-box',
          border: `1px solid ${V.borderSoft}`, borderRadius: V.radius, background: V.surface,
        },
      }, Object.entries(LEXICON_TAB_LABELS).map(([value, key]) => {
        const selected = status === value
        return h('button', {
          key: value, type: 'button', role: 'tab', 'aria-selected': selected,
          className: 'dshm-nav-item',
          style: {
            height: 36, minHeight: 36, padding: '0 16px', border: 0, borderRadius: V.radiusSm,
            background: selected ? V.accentSoft : 'transparent',
            color: selected ? V.accent : V.textDim,
            fontWeight: selected ? 650 : 500, fontSize: 12.5, lineHeight: 1.2,
            cursor: 'pointer', whiteSpace: 'nowrap',
            transition: 'background .18s ease, color .18s ease, box-shadow .18s ease',
          },
          onClick: () => changeStatus(value),
        }, t(key).split('{n}').join(String(statusCounts[value] ?? 0)))
      }))
      const countsRow = h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '0 0 14px' } },
        h('span', { style: { ...S.muted, marginRight: 2 } }, t('lexiconTotal').split('{total}').join(String(data?.total ?? 0))),
        Object.entries(LEXICON_KIND_LABELS).map(([value, key]) => {
          const selected = kind === value
          const n = Number(counts[value]) || 0
          return h('button', {
            key: value, type: 'button',
            'aria-pressed': selected,
            title: `${t(key)} · ${n}`,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 6,
              minHeight: 30, padding: '0 11px', borderRadius: 999,
              border: `1px solid ${selected ? V.accent : V.borderSoft}`,
              background: selected ? V.accentSoft : V.surfaceRaised,
              color: selected ? V.accent : V.textDim,
              cursor: 'pointer', fontSize: 11.5, lineHeight: 1, whiteSpace: 'nowrap',
              transition: 'background .18s ease, border-color .18s ease, color .18s ease',
            },
            onClick: () => changeFilter(setKind)(selected ? '' : value),
          }, t(key), h('b', { style: { fontWeight: 650, color: selected ? V.accent : V.text } }, String(n)))
        }))
      const filterRow = h('div', { className: 'dshm-graph-tools', style: { flexWrap: 'wrap', marginTop: 0 } },
        h('input', {
          type: 'search', style: S.input, value: safeQueryInput, placeholder: t('lexiconSearch'),
          'aria-label': t('lexiconSearch'),
          onChange: (e) => setQueryInput(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') applySearch() },
        }),
        h(Button, { style: S.ghost, onClick: applySearch, disabled: busy }, t('logRefresh')),
        h(Button, { style: S.ghost, onClick: () => { setCreating((v) => !v); setEditingId(''); setEditDraft(null); setDeleteArmed(''); setArmedBulk('') } }, t('lexiconNew')),
        activeLib ? h(Button, { style: S.ghost, onClick: () => (multi ? exitMulti() : setMulti(true)), disabled: busy }, t('multiSelect')) : null)
      const newForm = creating
        ? h('div', { style: { ...S.item, display: 'block' } },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { style: { ...S.input, flex: '1 1 160px' }, value: safeNewDraft.term, placeholder: t('lexiconTerm'), 'aria-label': t('lexiconTerm'), onChange: (e) => setNewDraft({ ...safeNewDraft, term: e.target.value }) }),
            h('select', { style: S.input, value: safeNewDraft.kind, 'aria-label': t('lexiconKind'), onChange: (e) => setNewDraft({ ...safeNewDraft, kind: e.target.value }) },
              Object.entries(LEXICON_KIND_LABELS).map(([value, key]) => h('option', { key: value, value }, t(key))))),
          h('textarea', { style: { ...S.textarea, minHeight: 54, marginTop: 8 }, value: safeNewDraft.meaning, placeholder: t('lexiconMeaning'), 'aria-label': t('lexiconMeaning'), onChange: (e) => setNewDraft({ ...safeNewDraft, meaning: e.target.value }) }),
          h('input', { style: { ...S.input, marginTop: 8 }, value: safeNewDraft.usage, placeholder: t('lexiconUsage'), 'aria-label': t('lexiconUsage'), onChange: (e) => setNewDraft({ ...safeNewDraft, usage: e.target.value }) }),
          h('input', { style: { ...S.input, marginTop: 8 }, value: safeNewDraft.aliases, placeholder: t('lexiconAliases'), 'aria-label': t('lexiconAliases'), onChange: (e) => setNewDraft({ ...safeNewDraft, aliases: e.target.value }) }),
          h('textarea', { style: { ...S.textarea, minHeight: 54, marginTop: 8 }, value: safeNewDraft.examples, placeholder: t('lexiconExamples'), 'aria-label': t('lexiconExamples'), onChange: (e) => setNewDraft({ ...safeNewDraft, examples: e.target.value }) }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h(Button, { primary: true, disabled: busy || !String(safeNewDraft.term || '').trim() || !String(safeNewDraft.meaning || '').trim(), onClick: () => void submitNew() }, t('lexiconCreate')),
            h(Button, { style: S.ghost, disabled: busy, onClick: () => setCreating(false) }, t('cancelDelete'))))
        : null
      const editForm = (e) => {
        const draft = editingId === e.id && editDraft && typeof editDraft === 'object' ? editDraft : null
        if (!draft) return null
        return h('div', { style: { marginTop: 8, borderTop: `1px solid ${V.borderSoft}`, paddingTop: 8 } },
          h('textarea', { style: { ...S.textarea, minHeight: 54 }, value: draft.meaning, 'aria-label': t('lexiconMeaning'), onChange: (event) => setEditDraft({ ...draft, meaning: event.target.value }) }),
          h('input', { style: { ...S.input, marginTop: 8 }, value: draft.usage, 'aria-label': t('lexiconUsage'), onChange: (event) => setEditDraft({ ...draft, usage: event.target.value }) }),
          h('input', { style: { ...S.input, marginTop: 8 }, value: draft.aliases, 'aria-label': t('lexiconAliases'), onChange: (event) => setEditDraft({ ...draft, aliases: event.target.value }) }),
          h('textarea', { style: { ...S.textarea, minHeight: 54, marginTop: 8 }, value: draft.examples, 'aria-label': t('lexiconExamples'), onChange: (event) => setEditDraft({ ...draft, examples: event.target.value }) }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', { style: S.input, value: draft.sensitivity, 'aria-label': t('lexiconSensitivity'), onChange: (event) => setEditDraft({ ...draft, sensitivity: event.target.value }) },
              h('option', { value: 'normal' }, t('lexiconNormal')),
              h('option', { value: 'sensitive' }, t('lexiconSensitive'))),
            h('input', { style: { ...S.input, maxWidth: 90 }, type: 'number', min: 0, max: 1, step: 0.05, value: draft.strength, 'aria-label': t('lexiconStrength'), onChange: (event) => setEditDraft({ ...draft, strength: event.target.value }) }),
            h(Button, { primary: true, disabled: busy, onClick: () => void saveEdit() }, t('save')),
            h(Button, { style: S.ghost, disabled: busy, onClick: () => { setEditingId(''); setEditDraft(null) } }, t('cancelDelete'))))
      }
      // 卡片流（§2.4）：term 是标题，meaning 是正文（≤120 字），usage/aliases 是次要行；
      // 命中三计数与 strength 同记忆墙一样不抢标题的位置。
      const renderCard = (e) => {
        const editing = editingId === e.id
        const aliases = Array.isArray(e.aliases) ? e.aliases : []
        const armed = deleteArmed === e.id
        const selection = chosenIds()
        const hits = e.hitCounts && typeof e.hitCounts === 'object' ? e.hitCounts : {}
        const hitsTitle = t('lexiconHitsDetail')
          .split('{candidate}').join(String(Number(hits.candidate) || 0))
          .split('{injection}').join(String(Number(hits.injection) || 0))
          .split('{query}').join(String(Number(hits.query) || 0))
        return h('div', {
          key: e.id,
          style: { ...S.item, display: 'flex', flexDirection: 'column', gap: 7, minHeight: 150, ...(multi && selection.has(e.id) ? { outline: '2px solid ' + V.accent, outlineOffset: -2 } : {}) },
        },
        h('div', { style: { display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' } },
          multi ? h('input', { type: 'checkbox', checked: selection.has(e.id), 'aria-label': e.term || e.id, onChange: () => toggleSelect(e.id), style: { margin: 0, accentColor: V.accent, flexShrink: 0 } }) : null,
          h('strong', { style: { fontSize: 15, fontWeight: 650, lineHeight: 1.3, overflowWrap: 'anywhere', flex: '1 1 120px' } }, e.term || e.id),
          h(Tag, null, enumText(t, LEXICON_KIND_LABELS, e.kind)),
          e.sensitivity === 'sensitive' ? h(Tag, { tone: 'warn' }, t('lexiconSensitive')) : null),
        h('p', { style: { margin: 0, fontSize: 12.5, lineHeight: 1.55, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } },
          clipText(e.meaning, 120) || '—'),
        e.usage ? h('div', { style: { ...S.muted, overflowWrap: 'anywhere' } }, `${t('lexiconCardUsage')} · ${clipText(e.usage, 80)}`) : null,
        aliases.length ? h('div', { style: { ...S.muted, overflowWrap: 'anywhere' } }, `${t('lexiconCardAliases')} · ${aliases.slice(0, 4).join(', ')}`) : null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 'auto' } },
          h('span', { style: S.muted, title: hitsTitle }, `⌁ ${hitsTotal(e)}`),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 90px', minWidth: 70 } },
            h(Bar, { value: e.strength ?? 0, title: `${t('lexiconStrength')} ${Math.round((Number(e.strength) || 0) * 100)}%` })),
          e.sourceMemoryId ? h(Button, {
            style: { ...S.ghost, padding: '1px 7px', flexShrink: 0 },
            title: t('lexiconSourceMemory'),
            onClick: () => onFocusMemory?.({ id: e.sourceMemoryId, libraryId: activeLib, title: e.term || e.id, at: Date.now() }),
          }, t('lexiconSourceMemory')) : null),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h(Button, { style: { ...S.ghost, padding: '2px 9px' }, disabled: busy, onClick: () => { setDeleteArmed(''); setArmedBulk(''); toggleEdit(e) } }, editing ? t('cancelDelete') : t('lexiconEdit')),
          // 归档 / 恢复是一击可逆动作；删除才要两段确认。
          h(Button, { style: { ...S.ghost, padding: '2px 9px' }, disabled: busy, onClick: () => void setLifecycle(e, status === 'archived' ? 'restore' : 'archive') },
            status === 'archived' ? t('lexiconRestore') : t('lexiconArchive')),
          armed
            ? h(React.Fragment, null,
              h(Button, { style: { ...S.ghost, color: V.danger, borderColor: V.danger, padding: '2px 9px' }, disabled: busy, onClick: () => void deleteTerm(e) }, t('confirmDelete')),
              h(Button, { style: { ...S.ghost, padding: '2px 9px' }, disabled: busy, onClick: () => setDeleteArmed('') }, t('cancelDelete')))
            : h(Button, { style: { ...S.ghost, color: V.danger, padding: '2px 9px' }, disabled: busy, title: t('lexiconDeleteHint'), onClick: () => { setArmedBulk(''); setDeleteArmed(e.id) } }, t('lexiconDelete'))),
        editing ? editForm(e) : null)
      }
      const selectedRows = items.filter((e) => chosenIds().has(e.id))
      const multiBar = multi
        ? (() => {
          const action = status === 'archived' ? 'restore' : 'archive'
          const actionLabel = action === 'archive' ? t('lexiconArchive') : t('lexiconRestore')
          const actionCount = selectedRows.filter((e) => (e.status || 'active') === (action === 'archive' ? 'active' : 'archived')).length
          const bulkButton = (value, label, count, danger) => {
            const armed = armedBulk === value
            return h(Button, {
              style: { ...S.ghost, ...(danger ? { color: V.danger } : {}), ...(armed ? { borderColor: danger ? V.danger : V.accent } : {}) },
              disabled: busy || count === 0,
              title: value === 'delete' ? t('lexiconDeleteHint') : undefined,
              onClick: () => {
                setDeleteArmed('')
                if (armedBulk !== value) { setArmedBulk(value); return }
                setArmedBulk('')
                void bulkApply(value)
              },
            }, (armed ? (value === 'delete' ? t('confirmDelete') : t('confirmAction')) : label) + ` (${count})`)
          }
          return h('div', { className: 'dshm-graph-tools', role: 'toolbar', 'aria-label': t('multiSelect') },
            h('span', { style: S.muted }, t('wallSelected').replace('{n}', String(selectedRows.length))),
            h(Button, { style: S.ghost, disabled: selectedRows.length === items.length, onClick: () => setSelectedIds(new Set(items.map((e) => e.id))) }, t('wallSelectAll')),
            h(Button, { style: S.ghost, disabled: selectedRows.length === 0, onClick: () => resetSelection() }, t('wallClearSelection')),
            // 批量归档/恢复/删除都是两段确认：第一次点只是 arm 当前动作。
            bulkButton(action, actionLabel, actionCount, false),
            bulkButton('delete', t('lexiconDelete'), selectedRows.length, true),
            armedBulk ? h(Button, { style: S.ghost, disabled: busy, onClick: () => setArmedBulk('') }, t('cancelDelete')) : null,
            h(Button, { style: S.ghost, onClick: exitMulti }, t('wallMultiExit')))
        })()
        : null
      const pager = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 } },
        h(Button, { style: S.ghost, disabled: busy || (data?.page || 1) <= 1, onClick: () => setPage(Math.max(1, (data?.page || 1) - 1)) }, t('lexiconPrev')),
        h('span', { style: S.muted }, t('lexiconPageOf').split('{page}').join(String(data?.page || 1)).split('{pages}').join(String(data?.pages || 1))),
        h(Button, { style: S.ghost, disabled: busy || (data?.page || 1) >= (data?.pages || 1), onClick: () => setPage((data?.page || 1) + 1) }, t('lexiconNext')),
        busy ? h('span', { style: S.muted }, t('loading')) : null)

      return h(React.Fragment, null,
        h(Section, {
          title: t('lexiconScope'),
          desc: t('descLexicon'),
          icon: GlyphStack,
          right: h(Button, { style: S.ghost, onClick: () => { setPage(1); resetTransient(); return load() }, disabled: busy }, t('refresh')),
        },
        h('div', { style: S.row },
          h('span', { style: S.label }, t('currentLibrary')),
          h('select', {
            style: { ...S.input, flex: 1 }, value: libraryId,
            title: libraries.find((lib) => lib.id === activeLib)?.scopeKey || t('currentLibrary'),
            onChange: (e) => changeLibrary(e.target.value),
          },
          libraries.length === 0 ? h('option', { value: '' }, t('noLibraries')) : null,
          libraries.map((lib) => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries))))),
        libraries.length === 0
          ? h(Empty, null, t('lexiconNoLibrary'))
          : h(React.Fragment, null, statusTabs, countsRow, filterRow, multiBar, newForm,
            error && typeof error === 'string' ? h('div', { className: 'dshm-error', role: 'alert' }, error) : null,
            notice && typeof notice === 'string' ? h('div', { style: { ...S.muted, marginTop: 6, color: V.accent } }, notice) : null,
            items.length === 0
              ? h(Empty, null, query || kind ? t('lexiconNoMatch')
                : status === 'archived' ? t('lexiconArchivedEmpty') : t('lexiconEmpty'))
              : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 10, marginTop: 10 } }, items.map(renderCard)),
            pager)))
    }

    function SettingsPage({ ctx, t, embedded, standalone = false }) {
      const PAGE = {
        overview: 0,
        connection: 1,
        settings: 2,
        folders: 3,
        libraries: 4,
        browser: 5,
        global: 6,
        prompts: 7,
        stats: 8,
        memories: 9,
        // logs:10 之前缺失：SETTINGS_PAGES 里有 'logs' 但 PAGE 没有对应索引，
        // 任何"跳到日志页"的入口都会错位到词典。补上，help 才能落在正确的 12。
        logs: 10,
        lexicon: 11,
        help: 12,
      }
      const call = useRpc(ctx)
      const sessionId = useCurrentSession(ctx)
      const [state, setState] = React.useState(null)
      const [prompts, setPrompts] = React.useState([])
      const [promptsLoaded, setPromptsLoaded] = React.useState(false)
      const [drafts, setDrafts] = React.useState({})
      const [sessions, setSessions] = React.useState([])
      const [globalFiles, setGlobalFiles] = React.useState([])
      const [globalLoaded, setGlobalLoaded] = React.useState(false)
      const [selected, setSelected] = React.useState([])
      const [job, setJob] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [vectorOperation, setVectorOperation] = React.useState('')
      const [vectorError, setVectorError] = React.useState('')
      // 全局记忆页"查看此记忆"的接力棒：带着 id 切到 MemU 记忆页，墙直接开对应抽屉。
      const [wallFocus, setWallFocus] = React.useState(null)
      // Success messages need their own slot: reusing `error` would paint a good
      // outcome in red and make the next real failure easy to miss.
      const [notice, setNotice] = React.useState('')
      const [configDraft, setConfigDraft] = React.useState(null)
      const [configBusy, setConfigBusy] = React.useState(false)
      const [configNotice, setConfigNotice] = React.useState('')
      const [page, setPage] = React.useState(() => standalone
        ? (SETTINGS_PAGES.includes(String(window.location.hash || '').replace(/^#\/settings\//, ''))
          ? SETTINGS_PAGES.indexOf(String(window.location.hash || '').replace(/^#\/settings\//, '')) : PAGE.memories)
        : 0)
      const pendingSettings = React.useRef({})
      // Hook order is a contract: every hook below must run on every render,
      // including the loading branch (`if (!state) return ...` further down).
      // Putting these next to the other state declarations is what keeps the
      // count stable — a hook after that early return is React error #310.
      const [logKind, setLogKind] = React.useState('')
      const [logQueryInput, setLogQueryInput] = React.useState('')
      const [logQuery, setLogQuery] = React.useState('')
      const [logRows, setLogRows] = React.useState([])
      const [logStats, setLogStats] = React.useState(null)
      const [logBusy, setLogBusy] = React.useState(false)
      const [logNotice, setLogNotice] = React.useState('')
      const loadLogs = React.useCallback(async () => {
        setLogBusy(true)
        try {
          const data = await call('getActivityLog', { limit: 300, kind: logKind || undefined, q: logQuery || undefined })
          setLogRows(Array.isArray(data?.events) ? data.events : [])
          setLogStats(data?.stats || null)
          setLogNotice('')
        } catch (error) { setLogNotice(String(error?.message || error)) } finally { setLogBusy(false) }
      }, [call, logKind, logQuery])
      React.useEffect(() => { void loadLogs() }, [loadLogs])
      const settingsTimer = React.useRef(null)
      const saveChain = React.useRef(Promise.resolve())
      const [resetArmed, setResetArmed] = React.useState(false)
      const [actionArmed, setActionArmed] = React.useState('')
      const confirmAction = key => {
        if (actionArmed !== key) { setActionArmed(key); return false }
        setActionArmed('')
        return true
      }
      const actionLabel = (key, label) => actionArmed === key ? t('confirmAction') : label
      React.useEffect(() => {
        if (!error && !notice && !configNotice) return undefined
        const timer = setTimeout(() => { setError(''); setNotice(''); setConfigNotice('') }, 2600)
        return () => clearTimeout(timer)
      }, [error, notice, configNotice])
      const [folders, setFolders] = React.useState([])
      const [foldersLoaded, setFoldersLoaded] = React.useState(false)
      const [folderBusy, setFolderBusy] = React.useState('')
      const [expandedFolders, setExpandedFolders] = React.useState(() => new Set())
      const [folderSessions, setFolderSessions] = React.useState({})
      const [newLibName, setNewLibName] = React.useState('')
      const [browseLibId, setBrowseLibId] = React.useState(() => standalone ? new URLSearchParams(window.location.search).get('libraryId') || '' : '')
      const [browseFiles, setBrowseFiles] = React.useState([])
      const [browseSource, setBrowseSource] = React.useState('')
      const [browseDraft, setBrowseDraft] = React.useState({})
      const [browseBusy, setBrowseBusy] = React.useState(false)
      // 'active' | 'archived'. Archiving used to be a one-way door in the UI: the entry
      // stayed in the same list with a different tag, so the mess you were trying to
      // tidy up never actually left. Two lists, and only the archived one offers delete.
      const [browseView, setBrowseView] = React.useState('active')
      // Permanent deletion is two clicks, and only for the row that was armed.
      const [deleteArmed, setDeleteArmed] = React.useState('')
      React.useEffect(() => {
        if (!actionArmed && !deleteArmed) return undefined
        const timer = setTimeout(() => { setActionArmed(''); setDeleteArmed('') }, 2500)
        return () => clearTimeout(timer)
      }, [actionArmed, deleteArmed])
      // A memory with a date is the common case for a real plan ("明天考试"), so the
      // create form asks for it up front instead of leaving the field to the RPC.
      const [newMem, setNewMem] = React.useState({ title: '', content: '', layer: 'long_term', salientDate: '' })
      const [reviews, setReviews] = React.useState([])
      const [reviewDrafts, setReviewDrafts] = React.useState({})
      const [versionInfo, setVersionInfo] = React.useState(null)
      const [versionBusy, setVersionBusy] = React.useState(false)
      const [backups, setBackups] = React.useState([])
      const [backupsLoaded, setBackupsLoaded] = React.useState(false)
      const [engineSizes, setEngineSizes] = React.useState({})
      const [promptPage, setPromptPage] = React.useState('general')
      const [promptScope, setPromptScope] = React.useState('private')
      const [promptDomains, setPromptDomains] = React.useState([])
      const [newDomainId, setNewDomainId] = React.useState('')
      // Statistics page: one library at a time, fetched on demand (it reads the
      // whole index for the scatter, so it is not part of the first paint).
      const [statsLibId, setStatsLibId] = React.useState('')
      const [statsData, setStatsData] = React.useState(null)
      const [statsBusy, setStatsBusy] = React.useState(false)
      // Which snapshot the painted settings belong to (task E). Refetched only when
      // the marker moves, so a write made in another window lands within one beat.
      const markerRef = React.useRef(null)

      const adoptState = (value) => {
        setState({ ...value, settings: { ...value?.settings, ...pendingSettings.current } })
        markerRef.current = sidebarMarker(value)
        setBrowseLibId((prev) => prev || value?.libraries?.[0]?.id || '')
        if (value?.memuConfig) {
          setConfigDraft((prev) => prev || {
            provider: value.memuConfig.provider || 'openai',
            model: value.memuConfig.model || '',
            baseUrl: value.memuConfig.baseUrl || '',
            apiKey: '',
            summaryModel: value.summaryConfig?.model || '',
            summaryBaseUrl: value.summaryConfig?.baseUrl || '',
            summaryApiKey: '',
          })
        }
      }

      // The first paint only needs settings, libraries, and engine status. Loading
      // prompts, global files, sessions, reviews, and job history here is what made
      // opening MemU settings feel stuck: five RPCs, two of them full scans.
      const refresh = React.useCallback(async () => {
        try {
          adoptState(await call('getSettingsState', {}))
          return true
        } catch (e) {
          setError(String(e?.message || e))
          return false
        }
      }, [call])
      const flushSettings = React.useCallback(() => {
        clearTimeout(settingsTimer.current)
        const patch = pendingSettings.current
        if (!Object.keys(patch).length) return saveChain.current
        pendingSettings.current = {}
        saveChain.current = saveChain.current.catch(() => {}).then(async () => {
          let error
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await call('setSettings', { patch })
              broadcastMemoryWrite('settings')
              return
            } catch (failure) { error = failure }
          }
          pendingSettings.current = { ...patch, ...pendingSettings.current }
          console.warn('dsh-memu-memory: settings save failed after retry')
          setError(String(error?.message || error))
        })
        return saveChain.current
      }, [call])
      React.useEffect(() => {
        const flush = () => { void flushSettings() }
        window.addEventListener?.('pagehide', flush)
        return () => { window.removeEventListener?.('pagehide', flush); clearTimeout(settingsTimer.current); flush() }
      }, [flushSettings])
      React.useEffect(() => {
        if (!standalone) return undefined
        const sync = () => {
          const index = SETTINGS_PAGES.indexOf(String(window.location.hash || '').replace(/^#\/settings\//, ''))
          if (index >= 0) setPage(index)
        }
        window.addEventListener('hashchange', sync)
        return () => window.removeEventListener('hashchange', sync)
      }, [standalone])
      React.useEffect(() => {
        if (standalone) {
          window.history.replaceState(null, '', '#/settings/' + SETTINGS_PAGES[page])
          window.dispatchEvent?.(new Event('dsh-memu-memory:navigation'))
        }
      }, [standalone, page])
      React.useEffect(() => {
        if (!resetArmed) return undefined
        const timer = setTimeout(() => setResetArmed(false), 2500)
        return () => clearTimeout(timer)
      }, [resetArmed])

      const refreshEngine = React.useCallback(async () => {
        try {
          const engine = await call('getEngine', {})
          setState((prev) => (prev ? { ...prev, engine } : prev))
        } catch {}
      }, [call])

      const loadPrompts = React.useCallback(async () => {
        try {
          const res = await call('getPrompts', {})
          const list = res?.prompts || []
          setPrompts(list)
          setPromptDomains(res?.domains || [])
          setDrafts((prev) => {
            const next = { ...prev }
            for (const p of list) if (next[p.key] === undefined) next[p.key] = p.text
            return next
          })
          setPromptsLoaded(true)
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      const addDomainPage = async () => {
        const value = String(newDomainId || '').trim().toLowerCase()
        if (!value) return
        setBusy(true)
        setError('')
        try {
          const res = await call('addPromptDomain', { domain: value })
          setPromptDomains(res?.domains || [])
          setNewDomainId('')
          setPromptPage(value)
          await loadPrompts()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const removeDomainPage = async (domain) => {
        if (!confirmAction('domain:' + domain)) return
        setBusy(true)
        try {
          const res = await call('removePromptDomain', { domain })
          setPromptDomains(res?.domains || [])
          if (promptPage === domain) setPromptPage('general')
          await loadPrompts()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }

      const loadSessions = React.useCallback(async () => {
        try {
          const res = await call('listSessions', { limit: 80 })
          setSessions(res?.sessions || [])
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      const loadGlobal = React.useCallback(async () => {
        try {
          const res = await call('listGlobal', {})
          setGlobalFiles(res?.files || [])
          setGlobalLoaded(true)
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      // Two queues: the global curator's and the currently browsed library's. They
      // are shown in one list because "something needs a human decision" is one job,
      // and each row says which library it came from.
      const loadReviews = React.useCallback(async () => {
        try {
          const [globalQueue, privateQueue] = await Promise.all([
            call('listReviews', sessionId ? { sessionId } : {}),
            browseLibId
              ? call('listReviews', { libraryId: browseLibId, sessionId: sessionId || undefined }).catch(() => ({ items: [] }))
              : Promise.resolve({ items: [] }),
          ])
          setReviews([...(privateQueue?.items || []), ...(globalQueue?.items || [])])
        } catch (e) { setError(String(e?.message || e)) }
      }, [call, browseLibId])

      const loadFolders = React.useCallback(async () => {
        try {
          const res = await call('listFolders', {})
          setFolders(res?.folders || [])
          setFoldersLoaded(true)
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      const loadStatsFor = React.useCallback(async (libraryId) => {
        if (!libraryId) { setStatsData(null); return }
        setStatsBusy(true)
        try {
          setStatsData(await call('getStats', { libraryId, days: 30 }))
        } catch (e) {
          setError(String(e?.message || e))
          setStatsData(null)
        } finally { setStatsBusy(false) }
      }, [call])

      const loadFolderSessions = React.useCallback(async (scopeKey) => {
        try {
          const res = await call('listFolderSessions', { scopeKey })
          setFolderSessions((prev) => ({ ...prev, [scopeKey]: res?.sessions || [] }))
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      const toggleFolder = (folder) => {
        const key = folder.scopeKey
        const willExpand = !expandedFolders.has(key)
        setExpandedFolders((prev) => {
          const next = new Set(prev)
          if (willExpand) next.add(key)
          else next.delete(key)
          return next
        })
        if (willExpand) void loadFolderSessions(key)
      }

      const setSessionSwitch = async (s, field, value) => {
        setBusy(true)
        try {
          await call('setSessionScope', { sessionId: s.sessionId, [field]: value })
          // The list is recomputed on the server so the folder ceiling is applied
          // the same way the sidebar applies it. This is a pull, not a live sync.
          const scopeKey = s.effective?.folder?.scopeKey
          if (scopeKey) await loadFolderSessions(scopeKey)
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }

      const loadVersions = React.useCallback(async (force = false) => {        setVersionBusy(true)
        try {
          setVersionInfo(await call('listVersions', { force }))
        } catch (e) {
          setVersionInfo({ ok: false, versions: [], errors: [String(e?.message || e)] })
        } finally { setVersionBusy(false) }
      }, [call])

      React.useEffect(() => { void refresh() }, [refresh])
      // Changes made in the standalone WebUI arrive on the shared channel; refetch
      // so a switch the user just flipped there is not shown as stale here.
      React.useEffect(() => {
        const onWrite = () => { void refresh() }
        memoryWriteListeners.add(onWrite)
        return () => { memoryWriteListeners.delete(onWrite) }
      }, [refresh])
      // Writes we cannot hear about over the channel — a tool call, a curator job,
      // another host process — land through the on-disk half of the marker.
      const vectorWorking = !!vectorOperation || ['downloading', 'verifying', 'installing'].includes(state?.localVector?.runtime?.status || '') || Object.values(state?.localVector?.installations || {}).some(item => ['downloading', 'verifying'].includes(item.status)) || ['preparing', 'prepared', 'syncing', 'switching'].includes(state?.localVector?.vector?.pending?.status)
      useMemoryBeat({ call, markerRef, onBeat: refresh, force: vectorWorking })
      // Sizes need a directory walk; ask for them after the page has painted.
      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const res = await call('getEngineSizes', {})
            if (alive && res?.sizes) setEngineSizes(res.sizes)
          } catch {}
        })()
        return () => { alive = false }
      }, [call, state?.engine?.currentVersion])
      // Ask once on open, in the background: the page paints from cached state and
      // the version card fills in when PyPI answers.
      React.useEffect(() => { void loadVersions(false) }, [loadVersions])
      React.useEffect(() => {
        if (state?.engine?.status !== 'installing') return undefined
        const id = setInterval(() => { void refreshEngine() }, 1200)
        return () => clearInterval(id)
      }, [state?.engine?.status, refreshEngine])
      React.useEffect(() => {
        if (page === PAGE.folders && !foldersLoaded) void loadFolders()
        else if (page === PAGE.prompts && !promptsLoaded) void loadPrompts()
        else if (page === PAGE.global) {
          if (!globalLoaded) void loadGlobal()
          void loadSessions()
          void loadReviews()
        }
      }, [page, foldersLoaded, promptsLoaded, globalLoaded, loadFolders, loadPrompts, loadGlobal, loadSessions, loadReviews])
      React.useEffect(() => {
        if (page !== PAGE.browser || !browseLibId) return undefined
        let alive = true
        void call('browseLibrary', { libraryId: browseLibId, sessionId: sessionId || undefined }).then(result => {
          if (!alive) return
          setBrowseFiles(result.files || [])
          setBrowseSource(result.source || '')
        }).catch(error => { if (alive) setError(String(error.message || error)) })
        return () => { alive = false }
      }, [call, page, browseLibId, sessionId, state?.revision, state?.stamp])
      // Statistics are per library and read the whole index for the scatter, so they
      // load only when that page is open. Every settings refresh (a heartbeat heard a
      // write) re-reads them, which is what keeps the page honest.
      React.useEffect(() => {
        if (page !== PAGE.stats) return
        const target = statsLibId || state?.libraries?.[0]?.id || ''
        if (!target) return
        if (target !== statsLibId) { setStatsLibId(target); return }
        void loadStatsFor(target)
      }, [page, statsLibId, state?.libraries, loadStatsFor])
      React.useEffect(() => {
        if (job?.status !== 'running') return undefined
        const id = setInterval(async () => {
          try {
            const next = await call('jobStatus', { jobId: job.id })
            if (next) setJob(next)
            if (next && next.status !== 'running') {
              await refresh()
              await loadGlobal()
            }
          } catch {}
        }, 2000)
        return () => clearInterval(id)
      }, [job?.status, job?.id, call, refresh, loadGlobal])
      // Cross-window sync. Another window, or the sidebar itself, can flip a session's
      // scopes while this panel sits open, and a stale list reads as "my change did
      // nothing". Poll only the folders that are actually expanded; a global timer
      // would re-read every folder on the machine forever.
      const expandedKey = Array.from(expandedFolders).sort().join('|')
      React.useEffect(() => {
        if (page !== PAGE.folders || !expandedKey) return undefined
        const keys = expandedKey.split('|')
        let alive = true
        const id = setInterval(() => {
          if (!alive) return
          // Sequential on purpose: one folder at a time keeps a slow disk from
          // turning five folders into a burst of parallel scans.
          void (async () => {
            for (const key of keys) {
              if (!alive) return
              await loadFolderSessions(key)
            }
          })()
        }, 5000)
        return () => { alive = false; clearInterval(id) }
      }, [page, expandedKey, loadFolderSessions])

      const saveSettings = async () => {
        await flushSettings()
      }
      // Defaults live on the server (state.js DEFAULT_SETTINGS): the page asks for
      // them rather than carrying a second copy that would drift from the code.
      const resetSettingsNow = async () => {
        if (!resetArmed) { setResetArmed(true); return }
        setResetArmed(false)
        await flushSettings()
        setBusy(true)
        setError('')
        try {
          await call('resetSettings', {})
          broadcastMemoryWrite('settings')
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const setupEngine = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await call('setup', { force: true })
          if (res?.engine) setState((prev) => (prev ? { ...prev, engine: res.engine } : prev))
          else await refreshEngine()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const switchEngine = async (version) => {
        const target = (engine.versions || []).find((v) => v.version === version)
        if (!target || !target.installed) {
          setError(t('engineSwitchBlocked').split('{action}').join(engine.installed ? t('engineRepair') : t('engineInstall')))
          return
        }
        if (target.current) return
        if (!confirmAction('switch:' + version)) return
        setBusy(true)
        setError('')
        try {
          await call('switchEngine', { version })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const removeVersion = async (version) => {
        if (!confirmAction('version:' + version)) return
        setBusy(true)
        setError('')
        try {
          const res = await call('removeEngineVersion', { version })
          if (res?.ok === false) setError(res.error || 'remove failed')
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const pruneVersions = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await call('pruneEngineVersions', { keep: 3 })
          setNotice(t('enginePruneDone')
            .split('{removed}').join(String((res?.removed || []).length))
            .split('{kept}').join(String((res?.kept || []).length)))
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const loadBackups = React.useCallback(async () => {
        try {
          const res = await call('listBackups', {})
          setBackups(res?.backups || [])
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])
      const restoreBackup = async (name) => {
        if (!confirmAction('restore:' + name)) return
        setBusy(true)
        setError('')
        try {
          await call('restoreBackup', { name })
          setNotice(t('backupRestored'))
          await refresh()
          await loadBackups()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      // Declared after loadBackups: an effect that depends on it must live below
      // its declaration, or the first render hits the temporal dead zone.
      React.useEffect(() => {
        // Backups are only shown on the overview page; load them once, lazily.
        if (page !== 0 || backupsLoaded) return
        setBackupsLoaded(true)
        void loadBackups()
      }, [page, backupsLoaded, loadBackups])
      const deleteBackupNow = async (name) => {
        if (!confirmAction('backup:' + name)) return
        setBusy(true)
        setError('')
        try {
          const res = await call('deleteBackup', { name })
          setBackups(res?.backups || [])
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const savePrompt = async (key) => {
        setBusy(true)
        try {
          await call('savePrompt', { key, text: drafts[key] || '' })
          await loadPrompts()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const resetPrompt = async (key) => {
        setBusy(true)
        try {
          await call('resetPrompt', { key })
          setDrafts((prev) => { const next = { ...prev }; delete next[key]; return next })
          await loadPrompts()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const resetAllPrompts = async () => {
        setBusy(true)
        try {
          await call('resetAllPrompts', {})
          setDrafts({})
          await loadPrompts()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const startCuration = async () => {
        const parent = sessions.find((s) => s.live)?.id
        if (!parent) { setError(t('noLiveSession')); return }
        if (selected.length === 0) return
        setBusy(true)
        try {
          const created = await call('generateGlobal', { sessionId: parent, sessionIds: selected })
          setJob(created)
          setSelected([])
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const setSetting = (key, value) => {
        setState((prev) => prev ? { ...prev, settings: { ...prev.settings, [key]: value } } : prev)
        pendingSettings.current = { ...pendingSettings.current, [key]: value }
        clearTimeout(settingsTimer.current)
        settingsTimer.current = setTimeout(() => { void flushSettings() }, 250)
      }
      const setBackend = async (backend) => {
        setSetting('memoryBackend', backend)
        setConfigNotice('')
        try {
          await call('setSettings', { patch: { memoryBackend: backend } })
          broadcastMemoryWrite('settings')
          await refresh()
        } catch (e) { setError(String(e?.message || e)) }
      }
      const createLibrary = async () => {
        const name = newLibName.trim()
        if (!name) return
        setBusy(true)
        try {
          await call('createLibrary', { name })
          setNewLibName('')
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const setFolderPolicy = async (folder, key, value) => {
        setFolderBusy(folder.scopeKey)
        setError('')
        try {
          const res = await call('setFolderPolicy', { scopeKey: folder.scopeKey, [key]: value })
          if (Array.isArray(res?.folders)) setFolders(res.folders)
          broadcastMemoryWrite('folders', folder.scopeKey)
          await refresh()
        } catch (e) { setError(`${t('folderSaveFailed')}: ${String(e?.message || e)}`) } finally { setFolderBusy('') }
      }
      const archiveLibrary = async (libraryId) => {
        setBusy(true)
        try {
          await call('archiveLibrary', { libraryId })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const restoreLibraryNow = async (libraryId) => {
        setBusy(true)
        try {
          await call('restoreLibrary', { libraryId })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const deleteLibraryNow = async (lib) => {
        if (!confirmAction('library:' + lib.id)) return
        setBusy(true)
        try {
          await call('deleteLibrary', { libraryId: lib.id })
          if (browseLibId === lib.id) { setBrowseLibId(''); setBrowseFiles([]) }
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const openBrowser = async (libraryId) => {
        const id = libraryId || browseLibId
        if (!id) return
        if (!libraryId) setBrowseLibId(id)
        setBrowseBusy(true)
        try {
          const res = await call('browseLibrary', { libraryId: id })
          setBrowseFiles(res?.files || [])
          setBrowseSource(res?.source || 'engine')
          setBrowseDraft({})
          setDeleteArmed('')
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const openBrowserFromLibrary = (libraryId) => {
        setPage(PAGE.browser)
        void openBrowser(libraryId)
      }
      const addMemory = async () => {
        if (!browseLibId || !newMem.content.trim()) return
        setBrowseBusy(true)
        try {
          const payload = { libraryId: browseLibId, content: newMem.content, title: newMem.title, layer: newMem.layer }
          const dated = String(newMem.salientDate || '').trim()
          if (dated) payload.salientDate = dated
          if (payload.layer === 'must_remember') {
            payload.pinReason = 'user_explicit_note'
            payload.pinSource = 'user_explicit'
          }
          const created = await call('addMemory', payload)
          // 事实级去重：几乎相同的重写被拒。表单留着、
          // 说明给足，否则用户看到的是"点了没反应"。
          if (created?.deduped === true) {
            setError(t('dedupedNotice').replace('{id}', created.existingId || '?'))
            return
          }
          notifyMemoryWrite('memory', browseLibId)
          setNotice(t('memorySaved'))
          setNewMem({ title: '', content: '', layer: 'long_term', salientDate: '' })
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const saveMemory = async (id) => {
        const patch = browseDraft[id] || {}
        if (Object.keys(patch).length === 0) return
        setBrowseBusy(true)
        try {
          await call('updateMemory', { libraryId: browseLibId, id, patch })
          notifyMemoryWrite('memory', browseLibId)
          setNotice(t('memorySaved'))
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const archiveMemory = async (id) => {
        setBrowseBusy(true)
        try {
          await call('archiveMemory', { libraryId: browseLibId, id })
          notifyMemoryWrite('memory', browseLibId)
          setNotice(t('memoryArchived'))
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const restoreMemory = async (id) => {
        setBrowseBusy(true)
        try {
          await call('updateMemory', { libraryId: browseLibId, id, patch: { status: 'active' } })
          notifyMemoryWrite('memory', browseLibId)
          setNotice(t('memoryRestored'))
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const deleteMemoryForever = async (id) => {
        setBrowseBusy(true)
        setError('')
        try {
          await call('deleteMemory', { libraryId: browseLibId, id })
          notifyMemoryWrite('memory', browseLibId)
          setNotice(t('memoryDeleted'))
          setDeleteArmed('')
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const resolveReview = async (item, action) => {
        setBusy(true)
        try {
          await call('resolveReview', {
            id: item.id,
            action,
            resolution: reviewDrafts[item.id]?.resolution || 'replace',
            reason: reviewDrafts[item.id]?.reason || '',
            sessionId: sessionId || undefined,
            ...(item.libraryId ? { libraryId: item.libraryId } : {}),
          })
          notifyMemoryWrite('review', item.libraryId || null)
          await loadReviews()
          await refresh()
          // A private review lives in the browser's list, so that view is stale now.
          if (item.libraryId && browseLibId === item.libraryId) await openBrowser(item.libraryId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      // 撤销集合合并（spec §4.11 undo-absorb / §6.7 UI）：全局元数据动作，不带
      // libraryId；两段确认由 actionLabel/confirmAction 承担。成功后刷新全局列表。
      const undoAbsorb = async (id) => {
        if (!confirmAction('undo-absorb:' + id)) return
        setBusy(true)
        try {
          await call('resolveReview', { id, action: 'undo-absorb', sessionId: sessionId || undefined })
          setNotice(t('absorbUndone'))
          const res = await call('listGlobal', {})
          setGlobalFiles((res.files || []))
          setGlobalLoaded(true)
          await loadReviews()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const removeGlobalLink = async (link) => {
        const linkId = String(link?.id || '')
        if (!linkId || !confirmAction('unlink:' + linkId)) return
        setBusy(true)
        try {
          await call('resolveReview', { linkId, action: 'unlink', sessionId: sessionId || undefined })
          setNotice(t('linkRemoved'))
          const res = await call('listGlobal', {})
          setGlobalFiles(res.files || [])
          setGlobalLoaded(true)
          await loadReviews()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      // 导出契约（spec §6.2）：显式对象参数——libraryId 缺省取当前浏览库，但调用点可以
      // 传入别的 id（契约保证 payload、回退文件名、成功提示都用**传入**的 id）。
      const exportLibraryNow = async ({ libraryId = browseLibId, includeAttachments = false } = {}) => {
        if (!libraryId) return
        setBrowseBusy(true)
        try {
          const data = await call('exportLibrary', { libraryId, sessionId: sessionId || undefined, includeAttachments, delivery: includeAttachments ? 'download' : undefined })
          if (data.downloadUrl) {
            const link = document.createElement('a')
            link.href = data.downloadUrl; link.download = data.filename; link.click()
          } else {
            const blob = data.base64
              ? new Blob([Uint8Array.from(atob(data.base64), char => char.charCodeAt(0))], { type: 'application/zip' })
              : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = data.filename || `dsh-memu-memory-${libraryId}.json`
            a.click()
            URL.revokeObjectURL(url)
          }
          setNotice(t('exportStarted').replace('{file}', data.filename || ''))
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }

      // Import reads the file in the browser and hands the text to the server: the
      // host already owns the state directory, so no path guessing is needed.
      // 同一契约：payload 与 ZIP 上传 URL 都用**传入**的 libraryId，成功后回到该库。
      const importLibraryNow = ({ libraryId = browseLibId } = {}) => {
        if (!libraryId) return
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json,.json,application/zip,.zip'
        input.onchange = async () => {
          const file = input.files && input.files[0]
          if (!file) return
          setBrowseBusy(true)
          setNotice('')
          setError('')
          try {
            const payload = { libraryId, sessionId: sessionId || undefined }
            let res
            if (file.name.toLowerCase().endsWith('.zip')) {
              const sessionQuery = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
              const response = await fetch('/dsh-memu-memory/import/' + encodeURIComponent(libraryId) + '.zip' + sessionQuery, {
                method: 'POST', credentials: 'same-origin', body: file, headers: { 'content-type': 'application/zip' },
              })
              const result = await response.json()
              if (!result.ok) throw new Error(result.error?.message || 'Archive import failed')
              res = result.value
            } else {
              payload.memories = await file.text()
              res = await call('importMemories', payload)
            }
            const c = res.counts || {}
            const skipped = (c.duplicate || 0) + (c.invalid || 0) + (c.dead || 0) + (c.expired || 0)
            // `downgraded` entries did land in the library — calling them skipped would
            // undercount what the user just imported, so they get their own suffix.
            const adjusted = c.downgraded || 0
            setNotice(`${t('importDone')}: +${res.imported || 0} / −${skipped}${adjusted ? ` · ${t('importAdjusted')}: ${adjusted}` : ''}`)
            if (res.engineWarning) setError(`${t('importEngineWarning')}: ${res.engineWarning}`)
            notifyMemoryWrite('import', libraryId)
            await openBrowser(libraryId)
            await refresh()
          } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
        }
        input.click()
      }

      if (!state) return h('div', { style: S.page }, error || t('loading'))

      const engine = state.engine || {}
      // Old server payloads (or a stale client bundle) may omit `versions`.
      // Never leave the history section blank while a current engine exists.
      const engineVersions = (engine.versions || []).length > 0
        ? engine.versions
        : engine.currentVersion
          ? [{
              version: engine.currentVersion,
              installed: true,
              current: true,
              recommended: engine.currentVersion === engine.recommendedVersion,
              installedAt: engine.currentInstalledAt || engine.state?.finishedAt || null,
              mirror: engine.currentMirror || null,
            }]
          : []
      const settings = state.settings || {}
      const memoryBackend = settings.memoryBackend === 'api' ? 'api' : 'agent'
      const latestVersions = (versionInfo?.versions || []).slice(0, 3)
      const memuConfig = state.memuConfig || { providers: [] }
      const localVector = state.localVector || { catalog: [], installations: {}, vector: {} }
      const requestedModel = localVector.vector?.requested?.catalogId
      const requestedInstall = localVector.installations?.[requestedModel] || {}
      const vectorCanSwitch = localVector.runtime?.ready === true && requestedInstall.installed === true && requestedInstall.fingerprintMatches !== false
      const vectorSource = settings.vectorSource || memuConfig.source || 'local'
      const isLocalEmbed = vectorSource === 'local'
      const draft = configDraft || {
        provider: memuConfig.provider || 'openai',
        model: memuConfig.model || '',
        baseUrl: memuConfig.baseUrl || '',
        apiKey: '',
        summaryModel: state.summaryConfig?.model || '',
        summaryBaseUrl: state.summaryConfig?.baseUrl || '',
        summaryApiKey: '',
      }
      const setConfig = (key, value) => setConfigDraft((prev) => ({
        ...(prev || draft), [key]: value,
      }))
      const saveConfig = async () => {
        setConfigBusy(true)
        setConfigNotice('')
        try {
          await call('saveMemuConfig', {
            provider: draft.provider,
            model: draft.model,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
            summaryModel: draft.summaryModel,
            summaryBaseUrl: draft.summaryBaseUrl,
            summaryApiKey: draft.summaryApiKey,
          })
          setConfigDraft((prev) => ({ ...(prev || draft), apiKey: '', summaryApiKey: '' }))
          setConfigNotice(t('configSaved'))
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setConfigBusy(false) }
      }
      const testConfig = async () => {
        setConfigBusy(true)
        setConfigNotice('')
        try {
          const result = await call('testMemuConfig', {})
          setConfigNotice(`${t('testOk')} (${result.files} file${result.files === 1 ? '' : 's'})`)
        } catch (e) {
          const message = String(e?.message || e)
          if (isLocalEmbed && /Connection error|ECONNREFUSED|fetch failed|timed out/i.test(message)) {
            setConfigNotice(t('testConnectionHint')
              .split('{url}').join(memuConfig.baseUrl || memuConfig.localBaseUrl || '')
              .split('{model}').join(memuConfig.model || memuConfig.localModel || ''))
          } else {
            setError(message)
          }
        } finally { setConfigBusy(false) }
      }
      const clearKey = async () => {
        setConfigBusy(true)
        setConfigNotice('')
        try {
          await call('saveMemuConfig', { clearKey: true })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setConfigBusy(false) }
      }
      const setEmbedSource = async (source) => {
        if (source === vectorSource) return
        setConfigBusy(true)
        setConfigNotice('')
        try {
          await call('setEmbeddingSource', { source })
          // The draft has to follow the host-side rewrite or the next 保存 would
          // push the old endpoint straight back over it.
          setConfigDraft(null)
          setConfigNotice(t('embedSourceSwitched'))
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setConfigBusy(false) }
      }
      const managedVectorAction = async (endpoint, payload = {}) => {
        const labels = {
          downloadLocalVectorModel: 'managedVectorDownload',
          selectLocalVectorModel: 'managedVectorSelect',
          switchLocalVectorProfile: 'managedVectorSwitch',
          rollbackLocalVectorProfile: 'managedVectorRollback',
          installLocalVectorRuntime: 'managedVectorRuntimeInstall',
        }
        setBusy(true)
        setVectorOperation(labels[endpoint] || endpoint)
        setError('')
        setNotice('')
        setVectorError('')
        try {
          await call(endpoint, payload)
          setNotice(`${t('managedVectorStatus')}: ${t(labels[endpoint] || 'managedVectorStatus')}`)
        } catch (e) {
          const message = String(e?.message || e)
          setVectorError(message)
          setError(message)
        } finally {
          await refresh()
          setBusy(false)
          setVectorOperation('')
        }
      }
      const managedVectorDownload = async (id) => {
        if (!confirmAction(`download:${id}`)) return
        await managedVectorAction('downloadLocalVectorModel', { id, confirmed: true })
      }
      const managedVectorSelect = async (id) => managedVectorAction('selectLocalVectorModel', { id })
      const managedVectorSwitch = async () => {
        if (!vectorCanSwitch) { setVectorError(t('managedVectorSwitchBlocked')); return }
        if (!confirmAction('switch')) return
        await managedVectorAction('switchLocalVectorProfile', { confirmed: true })
      }
      const managedVectorRollback = async () => {
        if (!confirmAction('rollback')) return
        await managedVectorAction('rollbackLocalVectorProfile', { confirmed: true })
      }
      const managedVectorRuntimeInstall = async () => {
        if (!confirmAction('runtime')) return
        await managedVectorAction('installLocalVectorRuntime', { confirmed: true })
      }

      const renderVectorProgress = (progress, migration = false) => {
        if (!progress) return null
        const total = Number(migration ? progress.total : progress.totalBytes) || 0
        const done = Number(migration ? progress.completed : progress.bytes) || 0
        const label = t(migration ? 'managedVectorRebuilding' : 'managedVectorProgress')
        const current = migration ? progress.current?.itemId : progress.current
        return h('div', { className: 'dshm-vector-progress' },
          h('div', { role: 'status', 'aria-live': 'polite' }, `${label}: ${done} / ${total}${migration ? ` · ${t('managedVectorGeneration')} ${progress.generation} · ${progress.stage}` : ' bytes'}`),
          h('progress', { max: total || 1, value: total > 0 ? Math.min(done, total) : undefined, 'aria-label': label }),
          current ? h('div', { style: S.muted }, `${t('managedVectorCurrent')}: ${current}`) : null)
      }

      const engineStatusText = engine.status === 'ready' ? t('engineReady')
        : engine.status === 'installing' ? t('engineInstalling')
          : engine.status === 'error' ? t('engineError') : t('engineIdle')

      const renderEngineVersion = (v) => h('div', { key: v.version, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: S.row },
            h('strong', null, v.version),
            v.current ? h(Tag, null, t('engineCurrentTag')) : null,
            v.recommended ? h(Tag, null, t('engineRecommendedTag')) : null,
            v.installed ? null : h(Tag, null, t('engineNotInstalledRow')),
            // "installed" ≠ "usable": a venv whose python vanished still has a
            // directory. Only a probe says it can actually run.
            v.installed && v.usable === true ? h(Tag, null, t('engineUsableTag')) : null,
            v.installed && v.usable === false ? h(Tag, { style: { borderColor: V.danger, color: V.danger } }, v.probeError || t('engineBrokenTag')) : null,
            v.installed && v.usable === null ? h(Tag, null, t('engineUnprobedTag')) : null),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            v.current || !v.installed ? null : h(Button, {
              onClick: () => switchEngine(v.version),
              disabled: busy,
              primary: true,
            }, actionLabel('switch:' + v.version, t('engineSwitchTo'))),
            !v.installed || v.current ? null : h(Button, {
              onClick: () => removeVersion(v.version),
              disabled: busy,
              style: S.ghost,
            }, actionLabel('version:' + v.version, t('engineRemoveVersion'))))),
        h('div', { style: S.muted }, [
          v.installedAt ? `${t('engineInstalledAt')}: ${String(v.installedAt).slice(0, 19).replace('T', ' ')}` : null,
          v.mirror ? `${t('engineSourceLabel')}: ${v.mirror}` : null,
          typeof (engineSizes[v.version] ?? v.sizeBytes) === 'number'
            ? `${Math.round((engineSizes[v.version] ?? v.sizeBytes) / 1024 / 1024)} MB`
            : null,
          v.probeAt ? `${t('engineProbedAt')}: ${String(v.probeAt).slice(0, 19).replace('T', ' ')}` : null,
        ].filter(Boolean).join(' · ') || '—'))

      const ENGINE_STEP_ORDER = ['resolving-python', 'creating-venv', 'installing-deps', 'verifying', 'backing-up', 'ready']
      const ENGINE_STEP_LABELS = {
        'resolving-python': 'stepResolvingPython',
        'creating-venv': 'stepCreatingVenv',
        'installing-deps': 'stepInstallingDeps',
        verifying: 'stepVerifying',
        'backing-up': 'stepBackingUp',
        ready: 'stepReady',
        failed: 'stepFailed',
      }
      const engineStepBase = String(engine.state?.step || '').split(':')[0]
      const engineStepIndex = ENGINE_STEP_ORDER.indexOf(engineStepBase)
      const engineProgress = engine.status === 'ready'
        ? 100
        : engine.status === 'installing'
          ? (engineStepIndex >= 0 ? Math.round(((engineStepIndex + 1) / ENGINE_STEP_ORDER.length) * 100) : 5)
          : 0
      const engineStepLabel = ENGINE_STEP_LABELS[engineStepBase] ? t(ENGINE_STEP_LABELS[engineStepBase]) : engineStepBase
      const engineElapsed = engine.state?.startedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(engine.state.startedAt)) / 1000))
        : null
      let installProgress = null
      if (engine.status === 'installing' || engine.status === 'error') {
        const logLines = (engine.logTail || []).slice(-6).join('\n')
        const statusText = engine.status === 'error'
          ? t('engineError')
          : `${engineProgress}%${engineElapsed == null ? '' : ` · ${t('installElapsed')} ${engineElapsed}s`}`
        installProgress = h('div', { style: { ...S.item, margin: '10px 0', padding: 12 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
            h('strong', { style: { fontSize: 12.5 } }, `${t('installStep')}: ${engineStepLabel || '…'}`),
            h('span', { style: S.muted }, statusText)),
          h('div', { style: { ...S.bar, marginTop: 8 } },
            h('div', { style: { ...S.barFill, width: `${Math.max(4, engineProgress)}%` } })),
          logLines
            ? h('div', { style: { marginTop: 10 } },
              h('div', { style: { ...S.muted, marginBottom: 4 } }, t('installLog')),
              h('pre', {
                style: {
                  margin: 0, padding: 8, borderRadius: V.radiusSm, background: V.surfaceRaised,
                  color: V.textDim, fontSize: 11, lineHeight: 1.45, maxHeight: 120,
                  overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                },
              }, logLines))
            : null)
      }


      const engineBlock = h(React.Fragment, null,
        h(Section, {
          title: t('engine'),
          desc: t('descOverview'),
          right: h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, {
              onClick: setupEngine, disabled: busy || engine.status === 'installing', primary: true,
            }, engine.installed ? t('engineRepair') : t('engineInstall')),
            h(Button, { onClick: refresh, style: S.ghost }, t('refresh'))),
        },
        h('div', { style: S.row },
          h(Tag, null, engineStatusText),
          h('span', { style: S.muted }, engine.installed ? t('engineIsInstalled') : t('engineNotInstalled')),
          h('span', { style: S.muted }, `${t('current')}: ${engine.currentVersion || '—'}`),
          h('span', { style: S.muted }, `${t('recommended')}: ${engine.recommendedVersion || '?'}`)),
        installProgress,
        engine.state?.error ? h('div', { style: { color: V.danger, fontSize: 12 } }, engine.state.error) : null,
        h('div', { style: { ...S.muted, marginTop: 8, lineHeight: 1.5 } }, engine.updateWarning || t('warning'))),

        h(Section, { title: t('engineVersionHistory'), desc: t('engineVersionHint') },
          engineVersions.length === 0
            ? h(Empty, null, t('engineNoVersions'))
            : h('div', { style: S.list }, engineVersions.map(renderEngineVersion))),

        h(Section, {
          title: t('engineLatestVersions'),
          desc: t('engineLatestHint'),
          right: h(Button, {
            onClick: () => loadVersions(true), disabled: versionBusy, style: S.ghost,
          }, versionBusy ? t('engineQuerying') : t('engineQueryVersions')),
        },
        !versionInfo
          ? h('div', { style: S.muted }, t('engineQuerying'))
          : versionInfo.ok === false
            ? h('div', { style: { ...S.muted, color: V.danger } },
              `${t('engineQueryFailed')}${versionInfo.errors?.length ? ` · ${versionInfo.errors[0]}` : ''}`)
            : latestVersions.length === 0
              ? h('div', { style: S.muted }, t('engineQueryFailed'))
              : h('div', { style: S.list }, latestVersions.map((version) => h('div', {
                key: version, style: S.item,
              },
              h('div', { style: S.row },
                h('strong', null, version),
                version === versionInfo.latest ? h(Tag, null, t('engineLatestTag')) : null,
                version === engine.currentVersion ? h(Tag, null, t('engineCurrentTag')) : null),
              h('div', { style: S.muted }, `${versionInfo.source || 'PyPI'} · ${String(versionInfo.fetchedAt || '').slice(0, 19).replace('T', ' ')}`))))),

        h(Section, {
          title: t('backups'),
          desc: t('descBackups'),
          right: h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { onClick: () => { void loadBackups() }, disabled: busy, style: S.ghost }, t('refresh')),
            h(Button, { onClick: pruneVersions, disabled: busy, style: S.ghost }, t('enginePrune'))),
        },
        !backupsLoaded
          ? h('div', { style: S.muted }, t('loading'))
          : backups.length === 0
            ? h(Empty, null, t('noBackups'))
            : h('div', { style: S.list }, backups.slice(0, 20).map((b) => h('div', { key: b.name, style: S.item },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
                h('div', null,
                  h('strong', null, String(b.createdAt).slice(0, 19).replace('T', ' ')),
                  h('div', { style: S.muted },
                    [b.engine?.version ? `engine ${b.engine.version}` : null,
                      typeof b.files === 'number' ? `${b.files} files` : null,
                      typeof b.bytes === 'number' ? `${Math.round(b.bytes / 1024)} KB` : null,
                      b.hasManifest ? null : t('backupNoManifest')].filter(Boolean).join(' · '))),
                h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                  h(Button, { onClick: () => restoreBackup(b.name), disabled: busy, style: S.ghost }, actionLabel('restore:' + b.name, t('backupRestore'))),
                  h(Button, {
                    onClick: () => deleteBackupNow(b.name),
                    disabled: busy,
                    style: { ...S.ghost, color: V.danger },
                  }, actionLabel('backup:' + b.name, t('backupDelete'))))))))),

      )

      const connectionBlock = h(React.Fragment, null,
        h(Section, {
          title: t('memoryBackend'),
          desc: memoryBackend === 'api' ? t('backendApiHint') : t('backendAgentHint'),
        },
        h('div', { style: { ...S.row, marginTop: 4 } },
          h('div', { className: 'dshm-nav-list is-row', role: 'tablist' },
            [['agent', t('backendAgent')], ['api', t('backendApi')]].map(([value, label]) => h('button', {
              key: value,
              type: 'button',
              role: 'tab',
              'aria-selected': memoryBackend === value,
              disabled: configBusy,
              className: `dshm-nav-item${memoryBackend === value ? ' on' : ''}`,
              onClick: () => setBackend(value),
            }, label)))),
        memoryBackend === 'api' ? h(Field, { label: t('vectorSource') },
          h('div', { className: 'dshm-nav-list is-row', role: 'tablist', 'aria-label': t('vectorSource') },
            [['local', t('vectorSourceLocal')], ['api', t('vectorSourceApi')]].map(([value, label]) => h('button', {
              key: value, type: 'button', role: 'tab', title: label, 'aria-selected': vectorSource === value,
              disabled: configBusy || busy, className: `dshm-nav-item${vectorSource === value ? ' on' : ''}`, onClick: () => setEmbedSource(value),
            }, label))), h('div', { style: S.muted }, t('vectorSourceHint'))) : null,
        memoryBackend === 'api' && !isLocalEmbed
          ? h(React.Fragment, null,
            h('div', { style: S.muted }, `${t('configPath')}: ${memuConfig.path || '—'}`),
            h(Field, { label: t('provider') },
              h('select', { style: S.input, value: draft.provider, onChange: (e) => setConfig('provider', e.target.value) },
                (memuConfig.providers || ['openai', 'jina', 'voyage', 'doubao', 'openrouter']).map((p) => h('option', { key: p, value: p }, p)))),
            h(Field, { label: t('model') }, h('input', { style: S.input, value: draft.model, placeholder: 'default', onChange: (e) => setConfig('model', e.target.value) })),
            h(Field, { label: t('baseUrl') }, h('input', { style: S.input, value: draft.baseUrl, placeholder: 'default', onChange: (e) => setConfig('baseUrl', e.target.value) })),
            h(Field, { label: t('apiKey') }, h('input', {
              type: 'password',
              style: S.input,
              value: draft.apiKey,
              placeholder: memuConfig.hasKey ? t('keyConfigured') : t('keyMissing'),
              onChange: (e) => setConfig('apiKey', e.target.value),
            })),
            h('div', { style: { ...S.muted, marginTop: 12, lineHeight: 1.55 } }, t('summaryHint')),
            h(Field, { label: t('summaryModel') }, h('input', {
              style: S.input, value: draft.summaryModel || '', placeholder: 'deepseek-chat',
              onChange: (e) => setConfig('summaryModel', e.target.value),
            })),
            h(Field, { label: t('summaryBaseUrl') }, h('input', {
              style: S.input, value: draft.summaryBaseUrl || '', placeholder: 'https://api.deepseek.com/v1',
              onChange: (e) => setConfig('summaryBaseUrl', e.target.value),
            })),
            h(Field, { label: t('summaryApiKey') }, h('input', {
              type: 'password', style: S.input, value: draft.summaryApiKey || '',
              placeholder: state.summaryConfig?.hasKey ? t('keyConfigured') : t('keyMissing'),
              onChange: (e) => setConfig('summaryApiKey', e.target.value),
            })))
          : null,
        configNotice ? h('div', { style: { ...S.muted, marginTop: 6 } }, configNotice) : null,
        memoryBackend === 'api'
          ? h('div', { className: 'dshm-cta-row' },
            h(Button, { onClick: saveConfig, disabled: configBusy, primary: true, className: 'dshm-primary-lg' }, t('saveConfig')),
            h(Button, { onClick: testConfig, disabled: configBusy }, t('testConfig')),
            h(Button, { onClick: clearKey, disabled: configBusy, style: S.ghost }, t('clearKey')))
          : null),
        memoryBackend === 'api' && isLocalEmbed ? h(Section, {
          title: t('managedVector'),
          desc: t('managedVectorHint'),
          right: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            vectorOperation ? h('span', { role: 'status', 'aria-live': 'polite' }, h(Tag, { tone: 'info' }, `${t('managedVectorStatus')}: ${t(vectorOperation)}`)) : null,
            localVector.vector?.active ? h(Tag, { tone: 'info' }, `${t('managedVectorActive')}: ${localVector.vector.active.catalogId}${localVector.vector.active.generation ? ' · g' + localVector.vector.active.generation : ''}`) : null,
            localVector.vector?.requested ? h(Tag, { tone: 'warn' }, `${t('managedVectorRequested')}: ${localVector.vector.requested.catalogId || ''}`) : null,
            h(Tag, localVector.vector?.active ? { tone: 'info' } : null,
              `${t('vectorRouteLabel')}: ${localVector.vector?.active ? (vectorSource === 'api' ? t('vectorRouteRemote') : t('vectorRouteLocal')) : t('vectorRouteLexical')}`)),
        },
          // 全页只有一个显眼的主操作。条件不满足时保持可见但禁用，并把原因写在旁边：
          // 把按钮藏起来，用户只会看到“什么都没发生”。
          h('div', { className: 'dshm-cta-row' },
            h(Button, {
              onClick: managedVectorSwitch,
              disabled: busy || !vectorCanSwitch || !localVector.vector?.requested,
              primary: true,
              className: 'dshm-primary-lg',
              title: t(vectorCanSwitch ? 'managedVectorSwitch' : 'managedVectorSwitchBlocked'),
            }, actionLabel('switch', t('managedVectorSwitch'))),
            localVector.vector?.active
              ? h(Button, { onClick: managedVectorRollback, disabled: busy, title: t('managedVectorRollback'), style: S.ghost }, actionLabel('rollback', t('managedVectorRollback')))
              : null,
            h('span', { style: { ...S.muted, color: vectorCanSwitch ? V.textDim : V.warn } },
              t(vectorCanSwitch ? 'managedVectorPrerequisites' : 'managedVectorSwitchBlocked'))),
          // 重建进度单独成块。三种终态分开渲染：committed 是“已切换”，failed 是失败，
          // preparing/syncing 才是进行中。之前把 active.lastMigration 也当进度，成功之后
          // 还会一直显示“重建中 8/8”，让人无法判断到底切没切。
          (() => {
            const activeVector = localVector.vector?.active || null
            const pending = localVector.vector?.pending
            if (!pending) {
              const last = activeVector?.lastMigration || null
              if (!activeVector) return null
              return h('div', { className: 'dshm-step dshm-rebuild' },
                h('div', { className: 'dshm-step-head' },
                  h('span', { className: 'dshm-step-title' }, t('vectorRebuildTitle')),
                  h(Tag, { tone: 'info' }, t('vectorStageCommitted')),
                  activeVector.generation ? h(Tag, null, `${t('managedVectorGeneration')} ${activeVector.generation}`) : null,
                  activeVector.fingerprint ? h('span', { style: S.muted }, String(activeVector.fingerprint).slice(0, 8)) : null),
                last ? h('div', { style: { fontSize: 12.5 } }, `${t('vectorSwitchWrote')} ${last.committed || 0}${last.total ? ' / ' + last.total : ''}`) : null,
                (() => {
                  const counts = localVector.vector?.indexed
                  const total = counts ? Object.values(counts).reduce((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0) : null
                  return total === null ? null : h('div', { style: S.muted }, `${t('vectorIndexedNow')} ${total} ${t('vectorIndexedUnit')}`)
                })(),
                h('div', { style: S.muted }, t('vectorSwitchDoneHint')))
            }
            const progress = pending.report?.progress || null
            const status = String(pending.status || '')
            const failedItems = Array.isArray(pending.error?.failedItems) ? pending.error.failedItems : []
            const total = Number(progress?.total) || 0
            const done = Number(progress?.completed) || 0
            const committed = Number(progress?.committed) || 0
            const generation = progress?.generation ?? pending.generation
            const fingerprint = progress?.fingerprint ?? pending.fingerprint
            const head = (label, tone) => h('div', { className: 'dshm-step-head' },
              h('span', { className: 'dshm-step-title' }, t('vectorRebuildTitle')),
              label ? h(Tag, tone ? { tone } : null, label) : null,
              generation ? h(Tag, null, `${t('managedVectorGeneration')} ${generation}`) : null,
              fingerprint ? h('span', { style: S.muted }, String(fingerprint).slice(0, 8)) : null)
            if (status === 'committed') {
              return h('div', { className: 'dshm-step dshm-rebuild' },
                head(t('vectorStageCommitted'), 'info'),
                h('div', { style: { fontSize: 12.5 } }, `${t('managedVectorCommitted')} ${done}${total ? ' / ' + total : ''}`),
                h('div', { style: S.muted }, t('vectorSwitchDoneHint')))
            }
            if (status === 'aborted') {
              return h('div', { className: 'dshm-step dshm-rebuild' },
                head(t('managedVectorAborted'), 'warn'),
                h('div', { style: S.muted }, t('vectorAbortedHint')))
            }
            if (status === 'failed') {
              return h('div', { className: 'dshm-step dshm-rebuild' },
                head(t('vectorStageFailed'), 'warn'),
                total ? h('div', { style: S.muted }, `${t('managedVectorCommitted')} ${committed} / ${total}`) : null,
                failedItems.length
                  ? h('div', { style: { ...S.muted, color: V.danger, display: 'flex', flexDirection: 'column', gap: 2 } },
                    failedItems.slice(0, 6).map(item => h('div', { key: String(item.itemId || item.libraryId) + item.code },
                      `${item.itemId || item.libraryId || '?'} · ${item.code} · ${item.message || ''}`)))
                  : null)
            }
            return h('div', { className: 'dshm-step dshm-rebuild' },
              head(progress ? t('vectorStageSyncing') : null, 'info'),
              renderVectorProgress(progress, true),
              h('div', { className: 'dshm-rebuild-meta' },
                committed ? h('span', null, `${t('managedVectorCommitted')} ${committed}`) : null,
                progress?.skipped ? h('span', null, `${t('managedVectorSkipped')} ${progress.skipped}`) : null,
                progress?.failed ? h('span', { style: { color: V.danger } }, `${t('managedVectorFailedCount')} ${progress.failed}`) : null,
                progress?.current?.itemId ? h('span', { style: S.muted }, String(progress.current.itemId)) : null),
              failedItems.length
                ? h('div', { style: { ...S.muted, color: V.danger, display: 'flex', flexDirection: 'column', gap: 2 } },
                  failedItems.slice(0, 6).map(item => h('div', { key: String(item.itemId || item.libraryId) + item.code },
                    `${item.itemId || item.libraryId || '?'} · ${item.code} · ${item.message || ''}`)))
                : null)
          })(),
          (() => {
            const failure = vectorError || localVector.vector?.pending?.error?.message || ''
            if (!failure) return null
            return h('div', { role: 'alert', style: { ...S.muted, color: V.danger, marginTop: 4 } },
              h('strong', null, `${t('managedVectorFailure')}: `), failure)
          })(),
          // 步骤 1：运行环境
          (() => {
            const runtime = localVector.runtime || {}
            const busyRuntime = ['downloading', 'verifying', 'installing'].includes(runtime.status)
            const ready = runtime.ready === true
            const label = ready
              ? (runtime.source === 'env' ? t('managedVectorRuntimeConfigured') : t('managedVectorRuntimeInstalled'))
              : runtime.status === 'unsupported' ? t('managedVectorRuntimeUnsupported')
                : runtime.status === 'failed' ? t('managedVectorRuntimeFailed')
                  : busyRuntime ? t('managedVectorRuntimeInstalling') : t('managedVectorRuntimeMissing')
            const announce = busyRuntime || Boolean(runtime.error?.message)
            return h('div', { className: 'dshm-step', ...(announce ? { role: 'status', 'aria-live': 'polite' } : {}) },
              h('div', { className: 'dshm-step-head' },
                h('span', { className: 'dshm-step-title' }, '1 · ' + t('managedVectorRuntimeTitle')),
                h(Tag, ready ? { tone: 'info' } : { tone: 'warn' }, label)),
              ready
                ? h('div', { style: S.muted }, runtime.version ? `v${runtime.version}` : t('managedVectorReady'))
                : h('div', { style: S.muted }, t('managedVectorRuntimeHint')),
              !ready && !busyRuntime && runtime.status !== 'unsupported'
                ? h('div', { className: 'dshm-step-actions' },
                  h(Button, { onClick: managedVectorRuntimeInstall, disabled: busy, primary: true, title: t('managedVectorRuntimeInstall') }, actionLabel('runtime', t('managedVectorRuntimeInstall'))))
                : null,
              runtime.error?.message ? h('div', { style: { ...S.muted, color: V.danger } }, runtime.error.message) : null,
              renderVectorProgress(runtime.progress))
          })(),
          // 步骤 2：模型
          h('div', { className: 'dshm-step' },
            h('div', { className: 'dshm-step-head' },
              h('span', { className: 'dshm-step-title' }, '2 · ' + t('managedVectorModelsTitle')),
              h(Tag, null, String((localVector.catalog || []).length))),
            (localVector.catalog || []).length === 0
              ? h('div', { style: S.muted }, t('managedVectorNoCatalog'))
              : h('div', { className: 'dshm-model-grid' }, (localVector.catalog || []).map(entry => {
                const install = localVector.installations?.[entry.id] || {}
                const isActive = localVector.vector?.active?.catalogId === entry.id
                const isRequested = localVector.vector?.requested?.catalogId === entry.id
                const canSelect = install.installed === true && install.fingerprintMatches !== false
                const pendingArtifact = entry.availability === 'pending' || (entry.pendingReasons || []).length > 0
                const sizeText = Number(entry.totalBytes) > 0 ? `${Math.max(1, Math.round(entry.totalBytes / 1024))} KB` : t('managedVectorSizePending')
                const statusText = install.installed ? t('managedVectorInstalled') : pendingArtifact ? t('managedVectorPending') : (install.status || entry.availability || t('managedVectorUnavailable'))
                return h('div', { key: entry.id, className: 'dshm-model' },
                  h('div', null,
                    h('div', { className: 'dshm-step-title' }, entry.displayName || entry.id),
                    h('div', { className: 'dshm-model-meta' },
                      h(Tag, null, `${entry.dimension || '?'}d`),
                      h(Tag, null, sizeText),
                      h(Tag, install.installed ? { tone: 'info' } : pendingArtifact ? { tone: 'warn' } : null, statusText),
                      isActive ? h(Tag, { tone: 'info' }, t('managedVectorActive')) : null,
                      isRequested ? h(Tag, { tone: 'warn' }, t('managedVectorRequested')) : null)),
                  h('div', { className: 'dshm-step-actions' },
                    !install.installed && entry.availability === 'available'
                      ? h(Button, { onClick: () => managedVectorDownload(entry.id), disabled: busy, primary: true, title: t('managedVectorDownload') }, actionLabel(`download:${entry.id}`, t('managedVectorDownload')))
                      : null,
                    canSelect && !isActive
                      ? h(Button, { onClick: () => managedVectorSelect(entry.id), disabled: busy, title: t('managedVectorSelect'), style: S.ghost }, t('managedVectorSelect'))
                      : null),
                  install.error?.message || (entry.pendingReasons || []).length
                    ? h('div', { style: S.muted, role: 'status' }, install.error?.message || (entry.pendingReasons || []).join('；'))
                    : null,
                  renderVectorProgress(install.progress))
              })))
        ) : null,

      )

      const settingsBlock = h(React.Fragment, null, h(Section, {
        title: t('settingsTuning'),
        right: h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
          h(Button, { onClick: resetSettingsNow, disabled: busy, style: S.ghost }, resetArmed ? t('settingsResetConfirm') : t('settingsReset')),
          h(Button, { onClick: saveSettings, disabled: busy, primary: true }, t('save'))),
      },
        h('div', { className: 'dshm-settings-grid' },
        h(Field, { label: t('autoInject') },
          h('select', { style: S.input, value: settings.autoInject || 'smart', onChange: (e) => setSetting('autoInject', e.target.value) },
            ['smart', 'anchor-only', 'per-turn', 'off'].map((v) => h('option', { key: v, value: v }, enumText(t, INJECT_LABELS, v))))),
        // 下面这些 ?? 回落值必须与 lib/state.js 的 DEFAULT_SETTINGS 一致：浏览器 bundle 不能
        // import 服务端模块，这里是客户端唯一的一份副本。它只在首次 getState 回来之前显示，
        // 但用户恰好在这段窗口里点「保存」就会把回落值持久化，等于悄悄改掉默认值。
        // 一致性由 tests/ui-defaults.test.mjs 守着。
        h(Field, { label: t('privateTopK') }, h('input', { type: 'number', style: S.input, value: settings.privateTopK ?? 5, onChange: (e) => setSetting('privateTopK', Number(e.target.value)) })),
        h(Field, { label: t('globalTopK') }, h('input', { type: 'number', style: S.input, value: settings.globalTopK ?? 5, onChange: (e) => setSetting('globalTopK', Number(e.target.value)) })),
        h(Field, { label: t('mustRememberCap') }, h('input', { type: 'number', style: S.input, value: settings.mustRememberCap ?? 12, onChange: (e) => setSetting('mustRememberCap', Number(e.target.value)) })),
        h(Field, { label: t('shortTermTtlHours') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.shortTermTtlHours ?? 72, onChange: (e) => setSetting('shortTermTtlHours', Number(e.target.value)) })),
        h(Field, { label: t('anchorTokens') }, h('input', { type: 'number', style: S.input, value: settings.anchorTokens ?? 800, onChange: (e) => setSetting('anchorTokens', Number(e.target.value)) })),
        h(Field, { label: t('turnTokens') }, h('input', { type: 'number', style: S.input, value: settings.turnTokens ?? 800, onChange: (e) => setSetting('turnTokens', Number(e.target.value)) })),
        h(Field, { label: t('injectionTotalTokens') }, h('input', { type: 'number', style: S.input, value: settings.injectionTotalTokens ?? 2000, onChange: (e) => setSetting('injectionTotalTokens', Number(e.target.value)) })),
        h(Field, { label: t('dedupeTurns') }, h('input', { type: 'number', style: S.input, value: settings.dedupeTurns ?? 16, onChange: (e) => setSetting('dedupeTurns', Number(e.target.value)) })),
        h(Field, { label: t('globalEveryNTurns') }, h('input', { type: 'number', style: S.input, value: settings.globalEveryNTurns ?? 6, onChange: (e) => setSetting('globalEveryNTurns', Number(e.target.value)) })),
        h(Field, { label: t('minUserChars') }, h('input', { type: 'number', style: S.input, value: settings.minUserChars ?? 6, onChange: (e) => setSetting('minUserChars', Number(e.target.value)) })),
        h(Field, { label: t('relevanceThreshold') }, h('input', { type: 'number', step: '0.05', min: 0, max: 1, style: S.input, value: settings.relevanceThreshold ?? 0.4, onChange: (e) => setSetting('relevanceThreshold', Number(e.target.value)) })),
        h(Field, { label: t('randomCueChance') }, h('input', { type: 'number', step: '0.01', min: 0, max: 1, style: S.input, value: settings.randomCueChance ?? 0.02, onChange: (e) => setSetting('randomCueChance', Number(e.target.value)) })),
        h(Field, { label: t('autoInstall') }, h('input', { type: 'checkbox', checked: settings.autoInstallEngine !== false, onChange: (e) => setSetting('autoInstallEngine', e.target.checked) })),
        h(Field, { label: t('newSessionPrompt') }, h('input', { type: 'checkbox', checked: settings.newSessionPromptDismissed !== true, onChange: (e) => setSetting('newSessionPromptDismissed', !e.target.checked) })),
        h(Field, { label: t('habitsInjection') }, h('input', { type: 'checkbox', checked: settings.habitsInjection !== false, onChange: (e) => setSetting('habitsInjection', e.target.checked) })),
        h(Field, { label: t('sidebarSettings') }, h(Toggle, { checked: settings.sidebarSettings === true, label: t('sidebarSettings'), onChange: value => setSetting('sidebarSettings', value) })),
        h(Field, { label: t('visionCaptionEnabled') }, h(Toggle, { checked: settings.visionCaptionEnabled === true, label: t('visionCaptionEnabled'), onChange: value => setSetting('visionCaptionEnabled', value) })),
        h(Field, { label: t('inboundToolNames') }, h(InboundToolsInput, {
          names: settings.inboundToolNames || [], onChange: values => setSetting('inboundToolNames', values),
        })),
        h(Field, { label: t('sleepConsolidation') }, h('input', { type: 'checkbox', checked: settings.sleepConsolidation === true, onChange: (e) => setSetting('sleepConsolidation', e.target.checked) })),
        h(Field, { label: t('sleepAfterIdleMinutes') }, h('input', { type: 'number', min: 1, style: S.input, value: settings.sleepAfterIdleMinutes ?? 3, onChange: (e) => setSetting('sleepAfterIdleMinutes', Number(e.target.value)) })),
        h(Field, { label: t('autoCurateEveryHours') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.autoCurateEveryHours ?? 0, onChange: (e) => setSetting('autoCurateEveryHours', Number(e.target.value)) })),
        h(Field, { label: t('autoCurateSessionLimit') }, h('input', { type: 'number', min: 1, max: 30, style: S.input, value: settings.autoCurateSessionLimit ?? 8, onChange: (e) => setSetting('autoCurateSessionLimit', Number(e.target.value)) })),
        h(Field, { label: t('purgeArchivedAfterDays') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.purgeArchivedAfterDays ?? 0, onChange: (e) => setSetting('purgeArchivedAfterDays', Number(e.target.value)) })),
        h(Field, { label: t('memoryMode') },
          h('select', { style: S.input, value: settings.memoryMode || 'local', onChange: (e) => setSetting('memoryMode', e.target.value) },
            ['local', 'cloud'].map((v) => h('option', { key: v, value: v }, v)))),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('memoryModeHint')))),
        h(Section, { title: t('visionService') }, h(VisionConfigPanel, { call, config: state.visionConfig, t })))

      const renderLibraryItem = (lib) => h('div', { key: lib.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('strong', null, lib.name || lib.id),
            h('div', { style: S.muted }, lib.id)),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Button, { onClick: () => openBrowserFromLibrary(lib.id) }, t('browse')),
            h(Button, { onClick: () => archiveLibrary(lib.id), disabled: busy }, t('archive')))),
        h('div', { style: S.muted }, `${t('scope')}: ${lib.scopeKey || '—'}`),
        h('div', { style: S.row },
          h(Tag, null, `${t('privateCount')}: ${lib.privateCount ?? 0}`),
          h(Tag, null, `${t('pinned')}: ${lib.pinnedCount ?? 0}`),
          h(Tag, null, `${t('bound')}: ${lib.boundSessions ?? 0}`)))

      const renderArchivedItem = (lib) => h('div', { key: lib.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('strong', null, lib.name || lib.id),
            h('div', { style: S.muted }, `${t('scope')}: ${lib.scopeKey || '—'}`)),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Button, { onClick: () => restoreLibraryNow(lib.id), disabled: busy, style: S.ghost }, t('restore')),
            h(Button, { onClick: () => deleteLibraryNow(lib), disabled: busy, style: S.ghost }, actionLabel('library:' + lib.id, t('deleteForever'))))),
        h('div', { style: S.row },
          lib.scopeMissing ? h(Tag, null, t('scopeMissing')) : null,
          h(Tag, null, `${t('privateCount')}: ${lib.privateCount ?? 0}`),
          lib.archivedAt ? h('span', { style: S.muted }, `${String(lib.archivedAt).slice(0, 10)}`) : null))

      const librariesBlock = h(React.Fragment, null,
        h(Section, { title: t('newLibrary') },
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, flex: 1 }, value: newLibName, placeholder: t('name'),
              onChange: (e) => setNewLibName(e.target.value),
            }),
            h(Button, { onClick: createLibrary, disabled: busy || !newLibName.trim(), primary: true }, t('create')))),
        h(Section, { title: t('libraries'), desc: t('descLibraries'), right: h(Button, { onClick: refresh, style: S.ghost }, t('refresh')) },
          (state.libraries || []).length === 0
            ? h(Empty, null, t('noLibraries'))
            : h('div', { style: S.list }, (state.libraries || []).map(renderLibraryItem))),
        h(Section, { title: `${t('archivedLibraries')} (${(state.archivedLibraries || []).length})`, desc: t('archivedHint') },
          (state.archivedLibraries || []).length === 0
            ? h(Empty, null, t('noArchived'))
            : h('div', { style: S.list }, (state.archivedLibraries || []).map(renderArchivedItem))))

      const renderGlobalItem = (f) => {
        // 集合记忆（spec §6.7 UI）：absorbedFrom → 「集合记忆 · N 条来源」Tag +
        // 「撤销合并」两段确认按钮（resolveReview action:'undo-absorb'）。links
        // 只读展示 + 「移除」（resolveReview action:'unlink'），不提供手动全局关联。
        const absorbed = Array.isArray(f.absorbedFrom) ? f.absorbedFrom : []
        const links = Array.isArray(f.links) ? f.links : []
        const titleOf = (id) => (globalFiles.find((item) => item.id === id)?.title) || id
        return h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('strong', null, f.title || f.id),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Tag, null, domainText(t, f.domain)),
            h(Tag, null, `conf ${f.confidence ?? '?'}`),
            links.length ? h(Tag, { tone: 'info' }, t('linkCountTag').replace('{n}', String(links.length))) : null,
            absorbed.length ? h(Tag, { tone: 'info' }, t('absorbSourcesTag').replace('{n}', String(absorbed.length))) : null,
            // 撤销合并：两段确认（点一次变为「确认此操作？」，再点才发请求）。
            absorbed.length
              ? h(Button, {
                style: S.ghost,
                title: t('absorbUndo'),
                disabled: busy,
                onClick: () => { void undoAbsorb(f.id) },
              }, actionLabel('undo-absorb:' + f.id, t('absorbUndo')))
              : null,
            // 查看此记忆：切到 MemU 记忆页的全局块并直接打开对应条目的抽屉。
            h(Button, {
              style: S.ghost,
              title: t('viewMemory'),
              onClick: () => { setWallFocus({ id: f.id, libraryId: null, title: f.title || f.id, at: Date.now() }); setPage(PAGE.memories) },
            }, t('viewMemory')))),
        h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } },
          String(f.content || '').slice(0, 400)),
        links.length
          ? h('div', { style: { ...S.muted, marginTop: 4 } },
            links.slice(0, 8).map((link) => h('div', { key: link.id || (link.to + ':' + link.kind), style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              h('span', null, `${link.kind || 'related'} · ${titleOf(link.to)}`),
              h(Button, {
                style: { ...S.ghost, padding: '1px 6px' },
                disabled: busy,
                onClick: () => { void removeGlobalLink(link) },
              }, actionLabel('unlink:' + (link.id || ''), t('relationRemove'))))),
            links.length > 8 ? h('div', null, `… +${links.length - 8}`) : null)
          : null
      )
      }

      const renderSessionChoice = (s) => h('label', {
        key: s.id,
        style: { ...S.item, display: 'flex', gap: 8, alignItems: 'flex-start' },
      },
        h('input', {
          type: 'checkbox',
          checked: selected.includes(s.id),
          onChange: (e) => setSelected((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)),
        }),
        h('div', { style: { minWidth: 0 } },
          h('div', null, sessionLabel(s), s.live ? h('span', { style: S.muted }, ' · live') : null),
          h('div', { style: S.muted }, `${s.cwd || '—'} · ${s.agentPreset || 'general'}`))
      )

      const renderReviewItem = (r) => {
        // 集合吸收提案（spec §6.7 UI）：pendingAbsorb → 「集合吸收 · N 条」Tag +
        // 来源标题列表（≤6，从 globalFiles 的 id→标题映射）；accept 恒为 replace
        // （合并稿不能与自己的来源并存，服务端对 coexist 直接抛错），所以隐藏
        // 复核方式选择器；保留 accept/reject，不做批量接受。
        const absorbSources = r.pendingAbsorb && Array.isArray(r.pendingAbsorb.sourceIds) ? r.pendingAbsorb.sourceIds : []
        const titleOf = (id) => {
          const file = (globalFiles || []).find((item) => item.id === id)
          return (file && (file.title || file.id)) || id
        }
        return h('div', { key: r.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('strong', null, r.title || r.id),
            h('div', { style: S.row },
              h(Tag, { tone: r.libraryId ? 'info' : undefined }, r.libraryId ? t('reviewScopePrivate') : (r.domain || 'unknown')),
              r.pendingAbsorb ? h(Tag, { tone: 'info' }, t('absorbTag').replace('{n}', String(absorbSources.length + 1))) : null,
              r.reviewReason ? h(Tag, null, `${t('reviewReason')}: ${r.reviewReason}`) : null,
              typeof r.confidence === 'number' ? h(Tag, null, `conf ${r.confidence}`) : null)),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Button, { onClick: () => resolveReview(r, 'accept'), disabled: busy, primary: true }, t('accept')),
            h(Button, { onClick: () => resolveReview(r, 'reject'), disabled: busy, style: S.ghost }, t('reject')))),
        absorbSources.length
          ? h('div', { style: { ...S.muted, marginTop: 4, lineHeight: 1.6 } },
            absorbSources.slice(0, 6).map((id) => h('div', { key: id }, `· ${titleOf(id)}`)),
            absorbSources.length > 6 ? h('div', null, `… +${absorbSources.length - 6}`) : null)
          : null,
        h('div', { style: { ...S.muted, marginTop: 6, whiteSpace: 'pre-wrap' } }, String(r.content || '').slice(0, 800)),
        // 集合吸收的 accept 固定 replace：不渲染 coexist 选择器。
        !r.pendingAbsorb
          ? h('div', { className: 'dshm-graph-tools' },
            h('select', { title: t('reviewResolution'), value: reviewDrafts[r.id]?.resolution || 'replace',
              onChange: event => setReviewDrafts(previous => ({ ...previous, [r.id]: { ...previous[r.id], resolution: event.target.value } })) },
              h('option', { value: 'replace' }, t('reviewReplace')), h('option', { value: 'coexist' }, t('reviewCoexist'))),
            reviewDrafts[r.id]?.resolution === 'coexist' ? h('input', { placeholder: t('reviewConditions'), value: reviewDrafts[r.id]?.reason || '',
              onChange: event => setReviewDrafts(previous => ({ ...previous, [r.id]: { ...previous[r.id], reason: event.target.value } })) }) : null)
          : null,
        (r.evidence || []).length > 0
          ? h('div', { style: { ...S.muted, marginTop: 6, lineHeight: 1.6 } },
            r.evidence.map((e, i) => h('div', { key: `${r.id}-ev-${i}` }, `· ${e.sessionId}：${String(e.quote || '').slice(0, 160)}`)))
          : null)
      }

      const globalBlock = h(React.Fragment, null,
        h(Section, {
          title: `${t('reviews')} (${reviews.length})`,
          right: h(Button, { onClick: loadReviews, disabled: busy, style: S.ghost }, t('refresh')),
        },
          reviews.length === 0
            ? h(Empty, null, t('reviewsEmpty'))
            : h('div', { style: S.list }, reviews.map(renderReviewItem))),
        h(Section, { title: t('globalMemory'), desc: t('descGlobal') },
          globalFiles.length === 0
            ? h(Empty, null, t('noGlobal'))
            : h('div', { style: S.list }, globalFiles.map(renderGlobalItem))
        ),
        h(Section, {
          title: t('curation'),
          right: h(Button, {
            onClick: startCuration,
            disabled: busy || selected.length === 0 || !sessions.some((x) => x.live),
            primary: true,
          }, `${t('startCuration')} (${selected.length})`),
        },
          !sessions.some((x) => x.live) ? h('div', { style: S.muted }, t('noLiveSession')) : null,
          h('div', { style: { ...S.list, maxHeight: 320, overflow: 'auto', marginTop: 8 } },
            sessions.filter((x) => x.origin !== 'subagent').map(renderSessionChoice)
          ),
          job ? h('div', { style: { ...S.muted, marginTop: 8 } },
            `${job.status}${job.step ? ` · ${job.step}` : ''}`,
            job.error ? h('div', { style: { color: V.danger } }, job.error) : null) : null
        ),
        // 审核模式（spec §6.1 包 A）：这是设置页的 globalBlock，不是侧栏那个只读块。
        h(Section, { title: t('curatorReview'), desc: t('descCuratorReview') },
          h(Field, { label: t('curatorReview') },
            h('select', {
              style: S.input,
              value: settings.curatorReviewMode || 'auto',
              onChange: (e) => setSetting('curatorReviewMode', e.target.value),
            },
            h('option', { value: 'auto' }, t('curatorReviewAuto')),
            h('option', { value: 'review-all' }, t('curatorReviewAll')))))
      )

      const renderPromptItem = (p) => h('div', { key: p.key, style: S.item },
        h('div', { className: 'dshm-prompt-head' },
          h('div', { className: 'dshm-prompt-meta' },
            h('strong', null, p.title || p.key),
            h('div', { style: S.muted }, p.description || ''),
            h('div', { style: S.row },
              h(Tag, null, p.domain ? domainText(t, p.domain) : t('promptGroupGeneral')),
              h(Tag, null, p.source === 'user' ? t('promptCustom') : t('promptDefault')),
              p.inheritedFrom ? h(Tag, null, t('promptInherited')) : null,
              p.defaultUpdated ? h(Tag, null, t('promptUpdated')) : null,
              h('span', { style: S.muted }, `${t('variables')}: ${(p.variables || []).join(', ') || '—'}`))),
          h('div', { className: 'dshm-prompt-actions' },
            h(Button, { onClick: () => savePrompt(p.key), disabled: busy }, t('promptSave')),
            h(Button, { onClick: () => resetPrompt(p.key), disabled: busy }, t('promptReset')))),
        h('textarea', {
          style: { ...S.textarea, marginTop: 8 },
          value: drafts[p.key] ?? p.text ?? '',
          onChange: (e) => setDrafts((prev) => ({ ...prev, [p.key]: e.target.value })),
        }))

      const promptScopeTabs = h('div', { className: 'dshm-nav-list is-row', role: 'tablist', style: { marginBottom: 10 } },
        [['private', t('promptScopePrivate')], ['global', t('promptScopeGlobal')]].map(([value, label]) => h('button', {
          key: value,
          type: 'button',
          role: 'tab',
          'aria-selected': promptScope === value,
          className: `dshm-nav-item${promptScope === value ? ' on' : ''}`,
          onClick: () => setPromptScope(value),
        }, label)))

      const scopedPrompts = prompts.filter((p) => (p.scope || 'private') === promptScope)
      // Pages are a list you pick from, not three hardcoded segments. A page only
      // appears when the current scope actually has prompts for it, so 全局 shows
      // just 通用 (the curator is not domain-layered).
      const pageIds = ['general', ...promptDomains.filter((d) => scopedPrompts.some((p) => p.domain === d))]
      const activePage = pageIds.includes(promptPage) ? promptPage : 'general'
      const pagePrompts = scopedPrompts.filter((p) => (activePage === 'general' ? !p.domain : p.domain === activePage))
      const pageLabel = (id) => (id === 'general' ? t('promptGroupGeneral') : domainText(t, id))

      // One row per type page: the page itself is a tab, the remove control sits
      // outside it. A nested role="button" inside a <button> is not reachable by
      // keyboard and is invalid markup, so the two are siblings.
      const promptPageList = h('div', { className: 'dshm-nav-list dshm-prompt-pages', role: 'tablist' },
        pageIds.map((id) => {
          const removable = id !== 'general' && promptScope === 'private'
          return h('div', {
            key: id,
            style: { display: 'flex', alignItems: 'center', gap: 2 },
          },
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': activePage === id,
            className: `dshm-nav-item${activePage === id ? ' on' : ''}`,
            style: { flex: '1 1 auto', minWidth: 0 },
            onClick: () => setPromptPage(id),
          }, pageLabel(id)),
          removable
            ? h('button', {
              type: 'button',
              className: 'dshm-x',
              title: actionLabel('domain:' + id, t('promptDomainRemove')),
              'aria-label': `${t('promptDomainRemove')} ${pageLabel(id)}`,
              onClick: () => void removeDomainPage(id),
            }, actionArmed === 'domain:' + id ? '?' : '×')
            : null)
        }))

      const promptPageBody = h('div', { className: 'dshm-prompt-body' },
        pagePrompts.length === 0
          ? h(Empty, null, t('promptPageEmpty'))
          : h('div', { style: { ...S.list, gap: 14 } }, pagePrompts.map(renderPromptItem)))

      const promptsBlock = h(Section, { title: t('prompts'), desc: t('descPrompts'), right: h(Button, { onClick: resetAllPrompts, disabled: busy, style: S.ghost }, t('promptResetAll')) },
        promptScopeTabs,
        h('div', { className: 'dshm-prompt-layout' },
          h('div', { className: 'dshm-prompt-pages-wrap' },
            promptPageList,
            promptScope === 'private'
              ? h('div', { className: 'dshm-prompt-new' },
                h('input', {
                  style: { ...S.input, minWidth: 0, width: 88, padding: '4px 7px', fontSize: 12 },
                  placeholder: t('promptDomainNew'),
                  value: newDomainId,
                  onChange: (e) => setNewDomainId(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') void addDomainPage() },
                }),
                h(Button, { onClick: addDomainPage, disabled: busy || !newDomainId.trim(), style: S.ghost }, '+'))
              : null),
          promptPageBody))

      const renderBrowserItem = (f) => {
        const draft = browseDraft[f.id] || {}
        const set = (key, value) => setBrowseDraft((prev) => ({
          ...prev, [f.id]: { ...(prev[f.id] || {}), [key]: value },
        }))
        // 有构成就讲构成；没有就回到旧的单值标签，老条目照旧可读。
        const moodText = emotionTagText(f.emotion)
          || (typeof f.moodValence === 'number' && f.moodValence !== 0 ? f.moodValence.toFixed(2) : '')
        return h('div', { key: f.id, style: S.item },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
            h('div', { style: S.row },
              h(Tag, null, enumText(t, LAYER_LABELS, f.layer || 'long_term')),
              f.marginalized ? h(Tag, null, t('marginalizedTag')) : null,
              f.openLoop ? h(Tag, null, t('openLoopTag')) : null,
              // What the memory is allowed to do with itself. Hiding these in the data
              // meant the only way to notice a misfiled "never say out loud" was to
              // open the JSON.
              f.disclosure && f.disclosure !== 'can_tell'
                ? h(Tag, { tone: f.disclosure === 'never_say' ? 'warn' : 'info' }, enumText(t, DISCLOSURE_LABELS, f.disclosure))
                : null,
              f.visibility === 'secret' ? h(Tag, { tone: 'warn' }, enumText(t, VISIBILITY_LABELS, 'secret')) : null,
              // Provenance, always shown here: the browser is where you audit a memory,
              // so "where did this come from" is not an optional detail. A quote and an
              // inference read identically once injected — this tag is the difference.
              h(Tag, { tone: f.source === 'imagined' ? 'warn' : (f.source === 'user_said' ? 'info' : undefined) },
                enumText(t, SOURCE_LABELS, f.source || 'inferred')),
              f.owner === 'about_user' ? h(Tag, { tone: 'info' }, enumText(t, OWNER_LABELS, 'about_user')) : null,
              // Keep the year: a deadline sliced from offset 5 reads "10-29 14:30", which
          // is indistinguishable from a stale entry once the year turns over.
          f.expiresAt ? h(Tag, null, `${t('shortTermExpires')} ${String(f.expiresAt).slice(0, 16).replace('T', ' ')}`) : null,
              f.peak ? h(Tag, null, t('peakTag')) : null,
              // A dated memory is an appointment, not an anniversary; the tag has to
              // say which, because only one of them means "this happens every year".
              f.salientDate
                ? h(Tag, null, `${/^\d{4}-\d{2}-\d{2}$/.test(f.salientDate) ? t('dueDateTag') : t('anniversaryTag')} ${f.salientDate}`)
                : null,
              moodText ? h(Tag, null, `${t('moodTag')} ${moodText}`) : null,
              typeof f.accuracy === 'number' && typeof f.confidence === 'number' && f.accuracy <= 0.6 && f.accuracy < f.confidence - 0.1
        ? h(Tag, { tone: 'warn' }, `${t('accuracyTag')} ${f.accuracy}`) : null,
              h(Tag, null, enumText(t, STATUS_LABELS, f.status || 'active'))),
            h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
              h(Button, { onClick: () => saveMemory(f.id), disabled: busy || browseBusy }, t('save')),
              h(Button, { onClick: () => archiveMemory(f.id), disabled: busy || browseBusy, style: S.ghost }, t('archive')))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 4px' } },
            h('span', { style: { ...S.muted, minWidth: 72 } }, t('decay')),
            h(Bar, { value: f.decay, title: `${Math.round((Number(f.decay) || 0) * 100)}%` }),
            h('span', { style: S.muted }, f.lastAccessAt
              ? `${t('accessed')}: ${String(f.lastAccessAt).slice(0, 10)}`
              : t('neverAccessed'))),
          h(MemoryAttachments, { items: f.attachments, t }),
          h('input', {
            style: { ...S.input, width: '100%', marginTop: 8 },
            value: draft.title ?? f.title ?? '', placeholder: t('name'),
            onChange: (e) => set('title', e.target.value),
          }),
          h('textarea', {
            style: { ...S.textarea, marginTop: 6, minHeight: 90 },
            value: draft.content ?? f.content ?? '',
            onChange: (e) => set('content', e.target.value),
          }),
          h('input', {
            style: { ...S.input, width: '100%', marginTop: 6 },
            value: (draft.tags ?? f.tags ?? []).join(', '), placeholder: 'tag1, tag2',
            onChange: (e) => set('tags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean)),
          }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
            h('select', {
              style: { ...S.input, flex: '1 1 120px', minWidth: 0 },
              title: t('disclosureLabel'),
              value: draft.disclosure ?? f.disclosure ?? 'can_tell',
              onChange: (e) => set('disclosure', e.target.value),
            }, ['can_tell', 'only_if_asked', 'never_say'].map((v) => h('option', { key: v, value: v }, enumText(t, DISCLOSURE_LABELS, v)))),
            h('select', {
              style: { ...S.input, flex: '1 1 110px', minWidth: 0 },
              title: t('ownerLabel'),
              value: draft.owner ?? f.owner ?? 'me',
              onChange: (e) => set('owner', e.target.value),
            }, ['me', 'us', 'about_user', 'about_project'].map((v) => h('option', { key: v, value: v }, enumText(t, OWNER_LABELS, v)))),
            h('select', {
              style: { ...S.input, flex: '1 1 110px', minWidth: 0 },
              title: t('visibilityLabel'),
              value: draft.visibility ?? f.visibility ?? 'shared',
              onChange: (e) => set('visibility', e.target.value),
            }, ['shared', 'secret'].map((v) => h('option', { key: v, value: v }, enumText(t, VISIBILITY_LABELS, v)))),
            h('select', {
              style: { ...S.input, flex: '1 1 110px', minWidth: 0 },
              title: t('sourceLabel'),
              value: draft.source ?? f.source ?? 'inferred',
              onChange: (e) => set('source', e.target.value),
            }, ['user_said', 'inferred', 'imagined', 'told'].map((v) => h('option', { key: v, value: v }, enumText(t, SOURCE_LABELS, v))))))
      }

      const browsePool = file => file.status === 'pending_review' ? 'review' : file.status === 'archived' ? 'archived'
        : ['suppressed', 'expired', 'superseded'].includes(file.status) || file.expiresAt && Date.parse(file.expiresAt) <= Date.now() ? 'inactive' : 'active'
      const archShown = browseFiles.filter(file => browsePool(file) === browseView)
      // An archived row is a body you are deciding about, not a draft you are editing:
      // no title/content/tag fields, just enough to recognise it plus the two exits.
      const renderArchivedMemory = (f) => h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: S.row },
            h(Tag, null, enumText(t, LAYER_LABELS, f.layer || 'long_term')),
            h(Tag, { tone: 'warn' }, enumText(t, STATUS_LABELS, f.status || 'archived')),
            h(Tag, { tone: f.source === 'imagined' ? 'warn' : (f.source === 'user_said' ? 'info' : undefined) },
              enumText(t, SOURCE_LABELS, f.source || 'inferred')),
            f.updatedAt ? h('span', { style: S.muted }, String(f.updatedAt).slice(0, 10)) : null),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Button, { onClick: () => restoreMemory(f.id), disabled: busy || browseBusy, style: S.ghost }, t('restore')),
            deleteArmed === f.id
              ? h(React.Fragment, null,
                h(Button, {
                  onClick: () => deleteMemoryForever(f.id),
                  disabled: busy || browseBusy,
                  style: { ...S.ghost, color: V.danger, borderColor: V.danger },
                }, t('confirmDelete')),
                h(Button, { onClick: () => setDeleteArmed(''), disabled: browseBusy, style: S.ghost }, t('cancelDelete')))
              : h(Button, {
                onClick: () => setDeleteArmed(f.id),
                disabled: busy || browseBusy,
                title: t('browseArchivedHint'),
                style: { ...S.ghost, color: V.danger },
              }, t('deleteForever')))),
        f.title ? h('div', { style: { marginTop: 6 } }, h('strong', null, f.title)) : null,
        h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } }, String(f.content || '').slice(0, 400)))

      const browserBlock = h(React.Fragment, null,
        h(Section, { title: t('newMemory') },
          h('input', {
            style: { ...S.input, width: '100%' }, value: newMem.title, placeholder: t('memoryTitle'),
            onChange: (e) => setNewMem((prev) => ({ ...prev, title: e.target.value })),
          }),
          h('textarea', {
            style: { ...S.textarea, marginTop: 6, minHeight: 80 }, value: newMem.content, placeholder: t('memoryContent'),
            onChange: (e) => setNewMem((prev) => ({ ...prev, content: e.target.value })),
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
            h('input', {
              style: { ...S.input, flex: '1 1 150px', minWidth: 0 }, value: newMem.salientDate,
              placeholder: t('salientDatePlaceholder'),
              onChange: (e) => setNewMem((prev) => ({ ...prev, salientDate: e.target.value })),
            }),
            h('select', {
              style: S.input, value: newMem.layer,
              onChange: (e) => setNewMem((prev) => ({ ...prev, layer: e.target.value })),
            }, ['long_term', 'short_term', 'must_remember'].map((v) => h('option', { key: v, value: v }, enumText(t, LAYER_LABELS, v)))),
            h(Button, { onClick: addMemory, disabled: busy || browseBusy || !newMem.content.trim(), primary: true }, t('add')))),
        h(Section, {
          title: t('browser'),
          desc: t('descBrowser'),
          right: h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
            h(Button, { onClick: () => importLibraryNow(), disabled: !browseLibId || browseBusy, style: S.ghost, title: t('importHint') }, t('importJson')),
            h(Button, { onClick: () => exportLibraryNow(), disabled: !browseLibId, style: S.ghost }, t('export')),
            h(Button, { onClick: () => exportLibraryNow({ includeAttachments: true }), disabled: !browseLibId, title: t('exportZip') }, t('exportZip')),
            h(Button, { onClick: () => openBrowser(browseLibId), disabled: busy || !browseLibId, primary: true }, t('reload'))),
        },
        h('div', { style: S.row },
          h('span', { style: S.label }, t('currentLibrary')),
          h('select', {
            style: { ...S.input, flex: 1 }, value: browseLibId,
            title: (state.libraries || []).find((lib) => lib.id === browseLibId)?.scopeKey || t('currentLibrary'),
            onChange: (e) => setBrowseLibId(e.target.value),
          }, (state.libraries || []).map((l) => h('option', { key: l.id, value: l.id }, libraryOptionLabel(l, state.libraries || []))))),
        browseSource === 'index'
          ? h('div', { style: { ...S.muted, marginTop: 6 } }, t('browserIndexOnly'))
          : null,
        h('div', { className: 'dshm-nav-list is-row', role: 'tablist', style: { marginTop: 10 } },
          [['active', t('browseActiveTab')], ['archived', t('browseArchivedTab')], ['review', t('poolReview')], ['inactive', t('poolInactive')], ['relations', t('relations')]].map((pair) => {
            const value = pair[0]
            const count = browseFiles.filter(file => browsePool(file) === value).length
            return h('button', {
              key: value,
              type: 'button',
              role: 'tab',
              'aria-selected': browseView === value,
              className: `dshm-nav-item${browseView === value ? ' on' : ''}`,
              onClick: () => { setBrowseView(value); setDeleteArmed('') },
            }, value === 'relations' ? pair[1] : pair[1] + ' (' + count + ')')
          })),
        browseView === 'archived' && archShown.length > 0
          ? h('div', { style: { ...S.muted, marginTop: 6 } }, t('browseArchivedHint'))
          : null,
        browseView === 'relations'
          ? h(GraphPanel, { key: browseLibId, call, libraryId: browseLibId, files: browseFiles, t })
          : archShown.length === 0
          ? h(Empty, null, browseView === 'archived' ? t('browseArchivedEmpty') : t('noMemoriesView'))
          : h('div', { style: { ...S.list, marginTop: 10 } },
            archShown.map(browseView === 'archived' ? renderArchivedMemory : renderBrowserItem))))

      const renderFolderItem = (folder) => {
        const disabled = folderBusy === folder.scopeKey
        const switchRow = (key, labelKey, hintKey) => h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 7 },
          title: t(hintKey),
        },
          h(Toggle, {
            checked: folder[key] !== false,
            disabled,
            label: `${folder.title} · ${t(labelKey)}`,
            onChange: (value) => setFolderPolicy(folder, key, value),
          }),
          h('span', { style: { ...S.muted, whiteSpace: 'nowrap' } }, t(labelKey)))
        const expanded = expandedFolders.has(folder.scopeKey)
        const rows = folderSessions[folder.scopeKey]
        return h('div', { key: folder.scopeKey },
          h('div', {
            title: folder.path || folder.title,
            style: { ...S.item, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('button', {
              type: 'button',
              'aria-expanded': expanded,
              title: t('folderExpand'),
              style: { ...S.ghost, border: 0, background: 'transparent', cursor: 'pointer', padding: '0 2px', color: 'inherit', fontSize: 12 },
              onClick: () => toggleFolder(folder),
            }, expanded ? '▾' : '▸'),
            h('strong', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, folder.title),
            folder.registered ? null : h(Tag, null, t('folderMissing'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 } },
            switchRow('useLibrary', 'folderPrivate', 'folderPrivateHint'),
            switchRow('useGlobal', 'folderGlobal', 'folderGlobalHint'))),
          expanded
            ? h('div', { style: { ...S.list, margin: '6px 0 10px 12px', paddingLeft: 10, borderLeft: `2px solid ${V.border}` } },
              !rows ? h('div', { style: S.muted }, t('loading'))
                : rows.length === 0
                  ? h('div', { style: S.muted }, t('folderNoSessions'))
                  : rows.map(renderFolderSession))
            : null)
      }

      const renderFolderSession = (s) => {
        const folder = folders.find((f) => f.scopeKey === s.effective?.folder?.scopeKey) || null
        const blockedPrivate = folder && folder.useLibrary === false
        const blockedGlobal = folder && folder.useGlobal === false
        return h('div', { key: s.sessionId, style: { ...S.item, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title || t('untitledSession')),
            h('div', { style: S.row },
              h(Tag, null, domainText(t, s.domain)),
              s.lastTurnAt ? h('span', { style: S.muted }, new Date(s.lastTurnAt).toLocaleDateString()) : null)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
            h(CheckRow, {
              label: t('folderPrivate'),
              checked: s.effective?.useLibrary ?? s.useLibrary,
              disabled: busy || blockedPrivate,
              title: blockedPrivate ? t('folderSwitchOff') : t('folderPrivateHint'),
              onChange: (value) => setSessionSwitch(s, 'useLibrary', value),
            }),
            h(CheckRow, {
              label: t('folderGlobal'),
              checked: s.effective?.useGlobal ?? s.useGlobal,
              disabled: busy || blockedGlobal,
              title: blockedGlobal ? t('folderSwitchOff') : t('folderGlobalHint'),
              onChange: (value) => setSessionSwitch(s, 'useGlobal', value),
            })))
      }

      const foldersBlock = h(Section, {
        title: t('pageFolders'),
        desc: t('descFolders'),
        right: h(Button, {
          onClick: () => { setFoldersLoaded(false); void loadFolders() },
          disabled: busy,
          style: S.ghost,
        }, t('refresh')),
      },
        !foldersLoaded
          ? h(Empty, null, t('loading'))
          : folders.length === 0
            ? h(Empty, null, t('folderEmpty'))
            : h('div', { style: S.list }, folders.map(renderFolderItem)))

      const archiveStale = async (id) => {
        if (!statsLibId) return
        setStatsBusy(true)
        try {
          await call('archiveMemory', { libraryId: statsLibId, id })
          notifyMemoryWrite('memory', statsLibId)
          await loadStatsFor(statsLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setStatsBusy(false) }
      }

      const statCell = (key, label, value, hint) => h('div', { key, className: 'dshm-stat' },
        h('div', { className: 'dshm-stat-v' }, String(value)),
        h('div', { className: 'dshm-stat-k' }, label),
        hint ? h('div', { className: 'dshm-stat-note' }, hint) : null)

      // Empty libraries must render zeros, not NaN or a blank chart: every number
      // below comes from the server's zero-filled series, and Math.max(...[]) is -Infinity.
      const statsBlock = h(React.Fragment, null,
        h(Section, {
          title: t('statsScope'),
          icon: GlyphChart,
          right: h(Button, {
            onClick: () => { if (statsLibId) void loadStatsFor(statsLibId) },
            disabled: statsBusy || !statsLibId,
            style: S.ghost,
          }, t('refresh')),
        },
        h('div', { style: S.row },
          h('span', { style: S.label }, t('currentLibrary')),
          h('select', {
            style: { ...S.input, flex: 1 },
            value: statsLibId,
            title: (state.libraries || []).find((lib) => lib.id === statsLibId)?.scopeKey || t('currentLibrary'),
            onChange: (e) => setStatsLibId(e.target.value),
          }, (state.libraries || []).map((l) => h('option', { key: l.id, value: l.id }, libraryOptionLabel(l, state.libraries || []))))),
        !statsLibId
          ? h(Empty, null, t('statsNoLibrary'))
          : !statsData
            ? h(Empty, null, statsBusy ? t('loading') : t('statsNoLibrary'))
            : statsData.available === false
              ? h(Empty, null, t('statsUnavailable'))
              : h(React.Fragment, null,
                h('div', { className: 'dshm-muted', style: { marginTop: 8 } },
                  t('statsWindow').split('{days}').join(String(statsData.windowDays))),
                h('div', { className: 'dshm-stats-row' },
                  statCell('written', t('statsWritten'), statsData.totals.written),
                  statCell('injected', t('statsInjected'), statsData.totals.injected),
                  statCell('recalled', t('statsRecalled'), statsData.totals.recalled),
                  statCell('archived', t('statsArchived'), statsData.totals.archived)))),

        h(Section, { title: t('statsActivity'), desc: t('statsActivityHint'), icon: GlyphChart },
          statsData && statsData.available !== false
            ? h(ActivityBars, { days: statsData.days, label: t('statsActivity'), emptyLabel: t('statsActivityEmpty') })
            : h(Empty, null, t('statsUnavailable'))),

        h(Section, { title: t('statsDistribution'), desc: t('statsDistributionHint'), icon: GlyphSearch },
          statsData && statsData.available !== false && statsData.distribution.length > 0
            ? (statsData.distribution.some((point) => point.injectCount > 0)
              ? h(React.Fragment, null,
                h(HitScatter, { points: statsData.distribution, label: t('statsDistribution') }),
                h('div', { className: 'dshm-muted', style: { marginTop: 6 } },
                  t('statsShown').split('{shown}').join(String(statsData.distribution.length))
                    .split('{total}').join(String(statsData.distributionTotal))))
              : h(Empty, null, t('statsScatterIdle')))
            : h(Empty, null, t('statsDistributionEmpty'))),

        h(Section, { title: t('statsHealth'), icon: GlyphLayers },
          statsData && statsData.available !== false
            ? h(React.Fragment, null,
              h('div', { className: 'dshm-stats-row' },
                statCell('active', t('statsActive'), statsData.health.active),
                statCell('marginalized', t('marginalizedTag'), statsData.health.marginalized),
                statCell('archived', t('stArchived'), statsData.health.archived),
                statCell('pending', t('stPendingReview'), statsData.health.pendingReview),
                statCell('strength', t('statsAvgStrength'), statsData.health.avgStrength)),
              h('div', { className: 'dshm-subhead' }, t('statsStale')),
              statsData.stale.length === 0
                ? h(Empty, null, t('statsStaleEmpty'))
                : h('div', { style: S.list }, statsData.stale.map((row) => h('div', {
                  key: row.id,
                  style: { ...S.item, display: 'flex', alignItems: 'center', gap: 10 },
                },
                h('div', { style: { minWidth: 0, flex: 1 } },
                  h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || row.id),
                  h('div', { style: S.muted },
                    row.daysSinceTouch === 0
                      ? t('statsStaleToday')
                      : t('statsStaleDays').split('{days}').join(String(row.daysSinceTouch)))),
                h(Button, { onClick: () => void archiveStale(row.id), disabled: statsBusy, style: S.ghost }, t('archive'))))))
            : h(Empty, null, t('statsUnavailable'))),

        h(Section, { title: t('statsRatio'), desc: t('statsRatioHint'), icon: GlyphGauge },
          statsData && statsData.available !== false
            ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              h('div', { className: 'dshm-stat-v', style: { fontSize: 26 } },
                `${statsData.ratio.written} : ${statsData.ratio.injected}`),
              statsData.ratio.written > statsData.ratio.injected
                ? h(Tag, { tone: 'warn' }, t('statsRatioBusy'))
                : null,
              h('span', { style: S.muted },
                t('statsWindow').split('{days}').join(String(statsData.ratio.windowDays))))
            : h(Empty, null, t('statsUnavailable'))))

      // Clipboard and download are the two things a person actually does with a
      // log: paste the row into an issue, or keep the file. execCommand is the
      // fallback because the standalone page can run without clipboard permission.
      const copyText = async (value) => {
        const text = String(value ?? '')
        try { await navigator.clipboard.writeText(text); return true } catch {}
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok
        } catch { return false }
      }
      const downloadLogs = () => {
        try {
          const blob = new Blob([logRows.map(row => JSON.stringify(row)).join('\n')], { type: 'application/x-ndjson' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `dsh-memu-activity-${new Date().toISOString().slice(0, 10)}.jsonl`
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (error) { setLogNotice(String(error?.message || error)) }
      }

      const pageDefs = [
        { label: t('pageOverview'), overline: 'ENGINE', desc: t('descOverview'), icon: GlyphGauge },
        { label: t('pageConnection'), overline: 'CONNECTION', desc: t('descConnection'), icon: GlyphGlobe },
        { label: t('pageSettings'), overline: 'BEHAVIOUR', desc: t('descSettings'), icon: GlyphSliders },
        { label: t('pageFolders'), overline: 'SCOPE', desc: t('descFolders'), icon: GlyphFolder },
        { label: t('pageLibraries'), overline: 'LIBRARIES', desc: t('descLibraries'), icon: GlyphStack },
        { label: t('pageBrowser'), overline: 'BROWSE', desc: t('descBrowser'), icon: GlyphSearch },
        { label: t('pageGlobal'), overline: 'GLOBAL', desc: t('descGlobal'), icon: GlyphGlobe },
        { label: t('pagePrompts'), overline: 'PROMPTS', desc: t('descPrompts'), icon: GlyphText },
        { label: t('pageStats'), overline: 'STATS', desc: t('descStats'), icon: GlyphChart },
      ]
      pageDefs.push({ label: t('pageMemories'), overline: 'MEMU', desc: t('descMemories'), icon: GlyphLayers })
      pageDefs.push({ label: t('pageLogs'), overline: 'ACTIVITY', desc: t('descLogs'), icon: GlyphText })
      pageDefs.push({ label: t('pageLexicon'), overline: 'LEXICON', desc: t('descLexicon'), icon: GlyphStack })
      pageDefs.push({ label: t('pageHelp'), overline: 'GUIDE', desc: t('descHelp'), icon: GlyphQuestion })
      // 首次安装引导（§6.5 包 E）：只在还没有任何库时出现——有了库，用户已经过了
      // 这一步，卡片只会碍事。不落 localStorage：关不掉是刻意的，等第一个库建好
      // 它自然消失；以后要记关闭状态必须走 settings，不许加本地存储。
      const firstRunCard = (state.libraries || []).length === 0
        ? h(Section, { title: t('firstRunTitle'), desc: t('firstRunDesc'), icon: GlyphLayers },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Button, { primary: true, onClick: () => setPage(PAGE.libraries) }, t('firstRunGoLibraries')),
            h(Button, { style: S.ghost, onClick: () => setPage(PAGE.help) }, t('firstRunGuide'))))
        : null
      const memoriesBlock = h(React.Fragment, null, firstRunCard,
        h(MemoryWallPanel, { call, libraries: state.libraries || [], revision: state.revision, stamp: state.stamp, t,
          indexed: localVector.vector?.indexed || null,
          focus: wallFocus,
          initialLibraryId: browseLibId,
          onNotice: setNotice,
          onOpen: item => {
            if (item.libraryId) { setBrowseLibId(item.libraryId); setPage(PAGE.browser); void openBrowser(item.libraryId) }
            else setPage(PAGE.global)
          } }))
      // 词典页：sourceMemoryId →「来源记忆 ↗」复用全局记忆页的 wallFocus 接力棒，
      // 跳到 MemU 记忆页并直接打开对应条目的抽屉。
      const lexiconBlock = h(LexiconPanel, {
        call,
        libraries: state.libraries || [],
        t,
        sessionId,
        onFocusMemory: (term) => {
          setWallFocus({ id: term.id, libraryId: term.libraryId || null, title: term.title || term.id, at: Date.now() })
          setPage(PAGE.memories)
        },
      })

      // 帮助页 v2（包 G4）：快速开始 5 步 + 七个详解区 + FAQ 10 条 + 反馈入口。
      // 所有跳转都走既有 setPage（不新增路由/RPC/localStorage），诊断复制只序列化
      // getSettingsState 已有快照（复用上方 copyText）；正文全部走 i18n，段落/列表/
      // 表格只由本地小助手拼装，样式复用 Section/Tag/Button 与 S 里的既有 token。
      const helpStepTargets = [
        { key: 'helpStep1', to: PAGE.libraries },
        { key: 'helpStep2', to: null }, // 绑定发生在会话侧，页面里只能给文案指引
        { key: 'helpStep3', to: PAGE.settings },
        { key: 'helpStep4', to: PAGE.memories },
        { key: 'helpStep5', to: PAGE.lexicon },
      ]
      const copyDiagnostics = async () => {
        try {
          const snapshot = state || await call('getSettingsState', {})
          const engine = snapshot.engine || {}
          const summary = JSON.stringify({
            version: engine.currentVersion || engine.recommendedVersion || '',
            engine: { status: engine.status, installed: engine.installed, versions: engine.versions || [] },
            settings: snapshot.settings || {},
            libraries: (snapshot.libraries || []).map(lib => ({ id: lib.id, name: lib.name, scopeKey: lib.scopeKey, privateCount: lib.privateCount })),
          }, null, 2)
          const ok = await copyText(summary)
          setNotice(ok ? t('copied') : t('copyFailed'))
        } catch (failure) { setError(String(failure?.message || failure)) }
      }
      // 帮助页的三种小节积木：段落、列表、两列表格。它们只读 i18n 文本，
      // 不持有状态，也不做交互——帮助页是说明书，不是教程。
      const helpPara = key => h('p', { style: { ...S.muted, margin: '0 0 6px', fontSize: 12.5, lineHeight: 1.7 } }, t(key))
      const helpBullets = keys => h('ul', {
        style: { margin: '0 0 6px', padding: '0 0 0 18px', fontSize: 12.5, lineHeight: 1.7 },
      }, keys.map(key => h('li', { key, style: { marginBottom: 3 } }, t(key))))
      const helpCell = { borderBottom: `1px solid ${V.borderSoft}`, padding: '6px 8px', textAlign: 'left', verticalAlign: 'top' }
      const helpTable = rows => h('table', {
        'data-help-table': 'labels',
        style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.6 },
      },
      h('thead', null, h('tr', null,
        h('th', { style: { ...helpCell, fontWeight: 600, whiteSpace: 'nowrap' } }, t('helpLabelColLabel')),
        h('th', { style: { ...helpCell, fontWeight: 600 } }, t('helpLabelColMeaning')))),
      h('tbody', null, rows.map(([label, meaning, rowKey]) => h('tr', { key: rowKey, 'data-help-row': rowKey },
        h('td', { style: { ...helpCell, overflowWrap: 'anywhere', fontFamily: 'var(--dshm-mono)' } }, label),
        h('td', { style: { ...helpCell, overflowWrap: 'anywhere' } }, meaning)))))
      const helpLabelRows = [
        [t('helpLabelSource'), t('helpLabelSourceMeaning'), 'helpLabelSource'],
        [t('helpLabelLayer'), t('helpLabelLayerMeaning'), 'helpLabelLayer'],
        [t('helpLabelOpenLoop'), t('helpLabelOpenLoopMeaning'), 'helpLabelOpenLoop'],
        [t('helpLabelMarginalized'), t('helpLabelMarginalizedMeaning'), 'helpLabelMarginalized'],
        [t('helpLabelDate'), t('helpLabelDateMeaning'), 'helpLabelDate'],
        [t('helpLabelAttachment'), t('helpLabelAttachmentMeaning'), 'helpLabelAttachment'],
        [t('helpLabelVector'), t('helpLabelVectorMeaning'), 'helpLabelVector'],
        [t('helpLabelReviewRisk'), t('helpLabelReviewRiskMeaning'), 'helpLabelReviewRisk'],
        [t('helpLabelLexicon'), t('helpLabelLexiconMeaning'), 'helpLabelLexicon'],
      ]
      const helpBlock = h(React.Fragment, null,
        h(Section, { title: t('helpQuickStart'), desc: t('descHelp'), icon: GlyphLayers },
          helpStepTargets.map((step, index) => h('div', { key: step.key, style: { ...S.row, alignItems: 'flex-start' } },
            h(Tag, { tone: 'info' }, String(index + 1)),
            h('span', { style: { flex: '1 1 320px', fontSize: 12.5, lineHeight: 1.6 } }, t(step.key)),
            step.to !== null
              ? h(Button, { style: { ...S.ghost, flexShrink: 0 }, onClick: () => setPage(step.to) }, t('helpGoTo'))
              : null))),
        h(Section, { title: t('helpScopes'), desc: t('helpScopesDesc'), icon: GlyphFolder },
          helpPara('helpScopesChain'),
          h('div', { style: S.row }, ['useLibrary', 'useGlobal', 'effectiveScope'].map(key => h(Tag, { key, tone: 'info' }, key))),
          helpPara('helpScopesPrivate'),
          helpPara('helpScopesGlobal'),
          helpPara('helpScopesWhere'),
          h('div', { style: { ...S.muted, margin: '8px 0 4px', fontWeight: 600 } }, t('helpScopesPitfallsTitle')),
          helpBullets(['helpScopesPitfall1', 'helpScopesPitfall2', 'helpScopesPitfall3'])),
        h(Section, { title: t('helpTitleCards'), icon: GlyphLayers },
          helpPara('helpTitleCardsBody'),
          helpPara('helpTitleCardsRecall'),
          helpPara('helpTitleCardsRule')),
        h(Section, { title: t('helpArchiveDelete'), icon: GlyphStack },
          helpBullets(['helpArchiveDeleteArchive', 'helpArchiveDeleteDelete', 'helpArchiveDeleteLexicon',
            'helpArchiveDeleteAbsorb', 'helpArchiveDeleteSessionGone'])),
        h(Section, { title: t('helpVector'), icon: GlyphGauge },
          helpPara('helpVectorSetup'),
          helpPara('helpVectorCount'),
          helpPara('helpVectorFallback'),
          helpPara('helpVectorRebuild')),
        h(Section, { title: t('helpAutoLink'), icon: GlyphGlobe },
          helpPara('helpAutoLinkRule'),
          h('div', { style: S.row }, h(Tag, { tone: 'info' }, 'source=auto'), h(Tag, null, 'memu_private_link_suggest')),
          helpPara('helpAutoLinkHub'),
          helpPara('helpAutoLinkWorker'),
          helpPara('helpAutoLinkSafety')),
        h(Section, { title: t('helpLabels'), desc: t('helpLabelsDesc'), icon: GlyphText },
          helpTable(helpLabelRows)),
        h(Section, { title: t('helpSidebar'), desc: t('helpSidebarDesc'), icon: GlyphSliders },
          helpBullets(['helpSidebarAlerts', 'helpSidebarReview', 'helpSidebarRunLog',
            'helpSidebarReviewMode', 'helpSidebarFirstRun', 'helpSidebarFallback', 'helpSidebarScope'])),
        h(Section, { title: t('helpFaq'), icon: GlyphQuestion },
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => h('details', { key: 'helpFaq' + n, style: { margin: '0 0 8px' } },
            h('summary', { style: { cursor: 'pointer', fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 } }, t('helpFaq' + n)),
            h('div', { style: { ...S.muted, marginTop: 5, fontSize: 12, lineHeight: 1.7 } }, t('helpFaq' + n + 'A'))))),
        h(Section, { title: t('helpFeedback'), icon: GlyphGlobe },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Button, {
              primary: true,
              title: t('helpOpenIssue'),
              onClick: () => { try { window.open('https://github.com/Tkingxiao/dsh-memu-memory/issues/new', '_blank') } catch {} },
            }, t('helpOpenIssue')),
            h(Button, { style: S.ghost, onClick: () => { void copyDiagnostics() } }, t('helpCopyDiagnostics')),
            h(Button, {
              style: S.ghost,
              title: t('helpDocs'),
              onClick: () => { try { window.open('https://github.com/Tkingxiao/dsh-memu-memory#readme', '_blank') } catch {} },
            }, t('helpDocs')))))

      const LOG_KIND_LABELS = {
        recall: t('logKindRecall'), write: t('logKindWrite'), consolidate: t('logKindConsolidate'),
        curate: t('logKindCurate'), vector: t('logKindVector'), error: t('logKindError'), system: t('logKindSystem'), check: t('logKindCheck'),
      }
      const logsBlock = h(React.Fragment, null,
        h(Section, {
          title: t('pageLogs'),
          desc: t('descLogs'),
          right: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h(Button, {
              style: S.ghost,
              onClick: async () => {
                const ok = await copyText(logRows.map(row => JSON.stringify(row)).join('\n'))
                setLogNotice(ok ? t('copied') : t('copyFailed'))
              },
            }, t('logCopyAll')),
            h(Button, { style: S.ghost, onClick: downloadLogs }, t('logDownload')),
            h(Button, {
              style: S.ghost,
              onClick: async () => {
                try {
                  await call('clearActivityLog')
                  // 跨面板即时生效：侧边栏的整理提醒不用等下一个 20s 轮询。
                  broadcastMemoryWrite('logs-cleared')
                  await loadLogs()
                } catch (error) { setLogNotice(String(error?.message || error)) }
              },
            }, t('logClear'))),
        },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
          h('select', {
            style: S.input,
            'aria-label': t('pageLogs'),
            value: logKind,
            onChange: (event) => setLogKind(event.target.value),
          },
          h('option', { value: '' }, t('logAllKinds')),
          ['recall', 'write', 'consolidate', 'curate', 'vector', 'error', 'check'].map(kind => h('option', { key: kind, value: kind }, LOG_KIND_LABELS[kind]))),
          h('input', {
            style: S.input,
            value: logQueryInput,
            placeholder: t('logSearch'),
            'aria-label': t('logSearch'),
            onChange: (event) => setLogQueryInput(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') setLogQuery(logQueryInput) },
          }),
          h(Button, { onClick: () => { setLogQuery(logQueryInput); void loadLogs() }, disabled: logBusy }, t('logRefresh'))),
        logStats
          ? h('div', { style: S.muted }, `${logStats.total} / ${logStats.capped} · ${Math.max(1, Math.round((logStats.bytes || 0) / 1024))} KB`)
          : null,
        logNotice ? h('div', { style: { ...S.muted, marginTop: 6, color: V.accent } }, logNotice) : null,
        logRows.length === 0
          ? h(Empty, null, t('logEmpty'))
          : h('div', { style: S.list }, logRows.map(row => h('div', { key: row.id, style: S.item },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' } },
                h(Tag, { tone: row.level === 'error' ? 'warn' : undefined }, LOG_KIND_LABELS[row.kind] || row.kind),
                h('span', { style: S.muted }, new Date(row.at).toLocaleString()),
                // 整理/提炼日志挂上会话标题与文件夹名，裸 id 只做回退：日志页要回答
                // "这是哪个对话、哪个库"，光靠 sessionId 后 10 位查不动。
                row.sessionTitle
                  ? h('span', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }, title: row.sessionId || '' }, row.sessionTitle)
                  : row.sessionId ? h('span', { style: S.muted }, row.sessionId.slice(-10)) : null,
                row.libraryName
                  ? h(Tag, null, row.libraryName)
                  : row.libraryId ? h('span', { style: S.muted }, row.libraryId) : null),
              h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                row.libraryId ? h(Button, {
                  style: S.ghost,
                  // 纠错入口：从日志直接回到这条记忆所在的库，按 id 搜到它再改。
                  onClick: () => { setBrowseLibId(row.libraryId); setPage(PAGE.browser); void openBrowser(row.libraryId) },
                }, t('logLocate')) : null,
                h(Button, {
                  style: S.ghost,
                  onClick: async () => {
                    const ok = await copyText(JSON.stringify(row, null, 2))
                    setLogNotice(ok ? t('copied') : t('copyFailed'))
                  },
                }, t('logCopyOne')))),
            h('div', { style: { marginTop: 4, whiteSpace: 'pre-wrap' } }, row.message),
            Array.isArray(row.refs) && row.refs.length
              ? h('div', { style: { ...S.muted, marginTop: 4 } }, row.refs.join(' · '))
              : null,
            row.detail
              ? h('pre', { style: { ...S.muted, margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, JSON.stringify(row.detail).slice(0, 600))
              : null)))))
      const pageBlocks = [engineBlock, connectionBlock, settingsBlock, foldersBlock, librariesBlock, browserBlock, globalBlock, promptsBlock, statsBlock, memoriesBlock, logsBlock, lexiconBlock, helpBlock]

      // Settings uses a left nav with a sliding indicator (the sidebar keeps its
      // top segments). The indicator is one absolutely-positioned element moved by
      // a transform, so the active item animates without per-item flicker.
      const active = pageDefs[page] || pageDefs[0]
      return h('div', {
        className: 'dshm-root',
        'data-dshm-surface': embedded ? 'sidebar' : 'dialog',
        style: { '--dshm-nav-h': `${NAV_ITEM_H}px`, '--dshm-nav-gap': `${NAV_GAP}px` },
      },
      h('div', { className: 'dshm-shell' },
        h('nav', { className: 'dshm-nav', role: 'tablist', 'aria-orientation': 'vertical' },
          h('div', { className: 'dshm-brand' },
            h('div', { className: 'dshm-brand-tile' }, h('img', { src: '/dsh-memu-memory/ui-assets/icon.png', alt: '', width: 32, height: 32 })),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'dshm-brand-name' }, t('nav')),
              h('div', { className: 'dshm-brand-tag' }, 'MEMORY'))),
          h('div', { className: `dshm-nav-list${embedded ? ' is-row' : ''}` },
            h('div', {
              className: 'dshm-nav-ind',
              style: { transform: `translateY(${page * (NAV_ITEM_H + NAV_GAP)}px)` },
              'aria-hidden': true,
            }),
            pageDefs.map((p, i) => h('button', {
              key: p.label,
              type: 'button',
              role: 'tab',
              'aria-selected': page === i,
              className: `dshm-nav-item${page === i ? ' on' : ''}`,
              onClick: () => setPage(i),
            }, h(p.icon, { size: 15 }), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, p.label))))),
        // Keying by page makes the host replace the node, which replays the
        // entrance animation; without it the body swaps instantly.
        h('div', { className: 'dshm-page', key: `dshm-page-${page}` },
          h('header', { className: 'dshm-head' },
            h('div', { className: 'dshm-overline' }, active.overline),
            h('h2', { className: 'dshm-h1' }, active.label),
            h('p', { className: 'dshm-desc' }, active.desc),
            h('div', { className: 'dshm-status', style: { marginTop: 8 } },
              h(Tag, null, engineStatusText),
              h('span', null, ` ${t('recommended')} ${engine.recommendedVersion || '?'}`),
              // Embedded in the sidebar the panel already carries this button in its
              // own header; a second one on every page is noise.
              embedded || standalone ? null : h(Button, {
                onClick: () => { openWebUiPage(SETTINGS_PAGES[page]) },
                style: { ...S.ghost, marginLeft: 'auto' },
                title: t('openWebUiHint'),
              }, t('openMemu')))),
          notice ? h('div', { style: { padding: '8px 12px 0', fontSize: 12, color: V.accent } }, notice) : null,
          error ? h('div', { className: 'dshm-error' }, error) : null,
          pageBlocks[page] || null)))
    }

    // better-sidebar renders tabs of its own, outside the host's slot system, so the
    // session id has to come from the live store rather than from props.
    function BetterSidebarMemoryTab({ ctx, t }) {
      const sessionId = useCurrentSession(ctx)
      return h(MemoryTab, { ctx, t, sessionId })
    }

    // 整理提醒：跨会话（不按当前对话过滤），放在记忆设置卡之下、整理记录之上。
    // 默认收起只显示最新一条（有失败优先失败），点头部展开成失败/成功两列（各最新 6 条）。
    // 失败列带"清除失败记录"：只删 consolidate 且 ok=false 的日志行，成功流水不动。
    function ConsolidationAlerts({ feed, t, onJump, onClear }) {
      const [open, setOpen] = React.useState(false)
      if (!feed) return null
      const failures = Array.isArray(feed.failures) ? feed.failures : []
      const successes = Array.isArray(feed.successes) ? feed.successes : []
      if (failures.length === 0 && successes.length === 0) return null
      const shortId = (id) => String(id || '').slice(-8)
      const label = (row) => row.sessionTitle || shortId(row.sessionId)
      const when = (row) => {
        try { return new Date(row.at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return row.at }
      }
      const rowEl = (row, tone) => h('div', { key: row.id, style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 } },
          h(Tag, { tone: tone === 'fail' ? 'warn' : undefined }, tone === 'fail' ? t('consolidateFailed') : t('consolidateDone')),
          h('span', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, title: row.message }, label(row)),
          h('span', { style: { ...S.muted, flexShrink: 0, fontSize: 11 } }, when(row)),
          tone === 'fail' ? h(Button, {
            style: { ...S.ghost, padding: '1px 7px', flexShrink: 0 },
            title: t('consolidateJumpHint'),
            onClick: () => onJump(row),
          }, '↗') : null),
        tone === 'fail' && row.message
          ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 1, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } }, row.message)
          : null)
      const column = (title, rows, tone) => h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 } },
          h('span', { style: { ...S.muted, fontWeight: 600, color: tone === 'fail' ? V.danger : undefined } }, title),
          tone === 'fail' && failures.length > 0 ? h(Button, {
            style: { ...S.ghost, padding: '1px 6px', fontSize: 11, flexShrink: 0 },
            title: t('consolidateClearHint'),
            onClick: onClear,
          }, t('consolidateClear')) : null),
        rows.length === 0
          ? h('div', { style: S.muted }, '—')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, rows.map(row => rowEl(row, tone))))
      const latest = failures.length > 0 ? failures[0] : successes[0]
      const latestTone = failures.length > 0 ? 'fail' : 'ok'
      const head = h('button', {
        type: 'button',
        'aria-expanded': open,
        title: open ? t('consolidateCollapse') : t('consolidateExpand'),
        onClick: () => setOpen(v => !v),
        style: { display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' },
      },
      h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, t('consolidateFeedTitle')),
      failures.length > 0 ? h(Tag, { tone: 'warn' }, t('consolidateFailedCount').replace('{n}', String(failures.length))) : null,
      h('span', { style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, open ? t('consolidateCollapse') : t('consolidateExpand')))
      return h('div', { style: { ...S.section, padding: '10px 12px', marginTop: 12 }, role: 'status' },
        head,
        open
          ? h('div', { style: { display: 'flex', gap: 14, marginTop: 7 } },
            column(t('consolidateFailedCol'), failures, 'fail'),
            column(t('consolidateOkCol'), successes, 'ok'))
          : h('div', { style: { marginTop: 7 } }, rowEl(latest, latestTone)))
    }

    function MemoryTab({ ctx, t, sessionId }) {
      const call = useRpc(ctx)
      const sessionsState = useSessionList(ctx)
      const [state, setState] = React.useState(null)
      const [privateFiles, setPrivateFiles] = React.useState([])
      const [globalFiles, setGlobalFiles] = React.useState([])
      const [sessions, setSessions] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [job, setJob] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [tabPage, setTabPage] = React.useState(0)
      // Distinguishes "not fetched yet" from "fetched, genuinely empty": showing
      // an empty state while the first request is in flight is what made a
      // full library look like it had nothing for a few seconds.
      // Which conversation the fetched data belongs to. A boolean let the previous
      // chat's memories show under the new chat until its own fetch landed.
      const [loadedFor, setLoadedFor] = React.useState(null)
      const loaded = loadedFor === sessionId
      const [sessionsLoaded, setSessionsLoaded] = React.useState(false)
      // Which snapshot the painted data belongs to, so the shared beat can tell
      // "nothing changed" from "refetch".
      const markerRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        if (!sessionId) return
        // One round trip for the whole first screen (T4). Previews are capped
        // server-side, so opening a 500-entry library no longer ships every body.
        try {
          const st = await call('getSidebarState', { sessionId })
          setState({
            ...st,
            pinnedCount: st.private?.pinned ?? 0,
            privateCount: st.private?.active ?? 0,
            globalCount: st.global?.active ?? 0,
          })
          setPrivateFiles(st.private?.items || [])
          setGlobalFiles(st.global?.items || [])
          markerRef.current = sidebarMarker(st)
          setError('')
        } catch (e) {
          setError(String(e?.message || e))
          return false
        } finally {
          setLoadedFor(sessionId)
        }
      }, [call, sessionId])

      const loadSidebarSessions = React.useCallback(async () => {
        setSessionsLoaded(true)
        try {
          const res = await call('listSessions', { limit: 80 })
          setSessions(res?.sessions || [])
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      // The conversation picker belongs to the Global tab only, so its (slow)
      // session listing is deferred until that tab is actually opened.
      React.useEffect(() => {
        // Below, a render without a session returns before `pages` is built; an
        // effect scheduled by that render still runs, and reading `pages` from it
        // is a temporal-dead-zone error ("Cannot access 'pages' before
        // initialization") shown inside the sidebar. No session, no panel — leave.
        if (!sessionId) return
        if (pages[tabPage]?.key !== 'global' || sessionsLoaded || !loaded) return
        void loadSidebarSessions()
      }, [sessionId, tabPage, sessionsLoaded, loaded, loadSidebarSessions])

      React.useEffect(() => { void refresh() }, [refresh])
      // Slow path: writes we cannot hear about — the model calling
      // memu_private_remember mid-turn, a curator job, a second window. The shared
      // beat polls the cheap marker and refetches only when it moved; a hidden
      // panel sends nothing and refetches once on return.
      useMemoryBeat({ call, markerRef, onBeat: refresh })
      React.useEffect(() => {
        if (job?.status !== 'running') return undefined
        const id = setInterval(async () => {
          try {
            const next = await call('jobStatus', { jobId: job.id })
            if (next) setJob(next)
            if (next && next.status !== 'running') await refresh()
          } catch {}
        }, 2000)
        return () => clearInterval(id)
      }, [job?.status, job?.id, call, refresh])
      // Old conversations were bound before folders existed, so their library still
      // says Default/__default__. Opening the sidebar is the moment we finally know
      // the cwd; repair the label in place once, without creating a new library.
      const repairedDefault = React.useRef(false)
      React.useEffect(() => {
        const binding = state?.binding
        const cwd = sessionsState.byId?.[sessionId]?.cwd
        const scopeKey = binding?.scopeKey
        if (repairedDefault.current || !binding?.libraryId || scopeKey !== '__default__' || !cwd) return
        repairedDefault.current = true
        void call('initSession', { sessionId, cwd, createLibrary: false })
          .then(() => refresh())
          .catch((e) => setError(String(e?.message || e)))
      }, [state?.binding?.scopeKey, sessionsState.byId, sessionId, call, refresh])

      // 整理记录：点击后显示在按钮下方，替代原来那行"已在后台子会话里整理"的提示。
      // 数据来自活动日志（getActivityLog），所以整理进行中能看到"已开始"，结束后能看到
      // 完成/超时/失败和写入的记录，刷新页面也不会丢。
      // Hook 必须在该组件的每个渲染路径上都执行：`if (!sessionId) return ...` 在其后，
      // 所以这三个 hook 只能放在那行提前 return 之前（否则就是 React #310）。
      const [runLog, setRunLog] = React.useState([])
      const loadRunLog = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const data = await call('getActivityLog', { sessionId, limit: 12 })
          setRunLog(Array.isArray(data?.events) ? data.events : [])
        } catch {}
      }, [call, sessionId])
      React.useEffect(() => { void loadRunLog() }, [loadRunLog])
      React.useEffect(() => {
        if (!busy || !sessionId) return undefined
        const timer = setInterval(() => { void loadRunLog() }, 1500)
        return () => clearInterval(timer)
      }, [busy, sessionId, loadRunLog])

      // 整理提醒（跨会话）：挂载即拉一次，之后慢轮询；手动整理结束/进行中时靠 loadRunLog
      // 的轮询节拍顺带刷新，不在这里叠加高频轮询。不依赖 sessionId —— 没选中对话也要显示。
      const [feed, setFeed] = React.useState(null)
      const loadFeed = React.useCallback(async () => {
        try { setFeed(await call('getConsolidationFeed', { limit: 6 })) } catch {}
      }, [call])
      React.useEffect(() => {
        void loadFeed()
        // unref：浏览器里没有这个方法（可选调用跳过），Node 测试环境里别让轮询拖住进程退出。
        const timer = setInterval(() => { void loadFeed() }, 20000)
        try { timer.unref?.() } catch {}
        return () => clearInterval(timer)
      }, [loadFeed])
      React.useEffect(() => {
        if (!busy) return undefined
        const timer = setInterval(() => { void loadFeed() }, 4000)
        try { timer.unref?.() } catch {}
        return () => clearInterval(timer)
      }, [busy, loadFeed])
      // Instant path: another pane wrote a memory — or the WebUI cleared the
      // activity log (kind: 'logs-cleared'): the consolidation feed must empty
      // the same instant instead of waiting for the next 20s poll.
      React.useEffect(() => {
        const onWrite = () => { void refresh(); void loadFeed() }
        memoryWriteListeners.add(onWrite)
        return () => { memoryWriteListeners.delete(onWrite) }
      }, [refresh, loadFeed])
      const jumpToLibrary = React.useCallback((row) => {
        // 对应记忆界面 = 这条记忆所在的库；没带 libraryId（全局/旧事件）就落到总览。
        openWebUiPage(row?.libraryId ? 'browser' : 'memories', { libraryId: row?.libraryId || null })
      }, [])
      const clearFailures = React.useCallback(async () => {
        // 只删 consolidate 且 ok=false 的行；成功流水与其余日志不动。结果直接回填 feed。
        try {
          const result = await call('clearConsolidationFailures')
          if (result?.cleared) setNotice(t('consolidateCleared').replace('{n}', String(result.cleared)))
          if (result?.feed) setFeed(result.feed)
        } catch (e) { setError(String(e?.message || e)) }
      }, [call, t])
      const alertBlock = h(ConsolidationAlerts, { feed, t, onJump: jumpToLibrary, onClear: clearFailures })

      // （保持单行提前 return：tests/hook-order.test.mjs 以这一行锚定 hook 顺序守卫。）
      if (!sessionId) return h('div', { style: S.tab }, h('div', { style: { ...S.tab, padding: '12px' } }, t('loading')))
      const binding = state?.binding
      const summary = sessionsState.byId?.[sessionId]
      const scopeKey = String(binding?.scopeKey || '')
      // Never fall back to scopeKey='__default__': that placeholder is the very
      // string the user should not see. Prefer the live conversation's cwd.
      const scopeLeaf = scopeKey && scopeKey !== '__default__' ? scopeKey : ''
      // The folder name is the scope; a full path is noise in a narrow panel.
      const folderLeaf = String(summary?.cwd || scopeLeaf).split(/[\\/]/).filter(Boolean).pop()
      const bindingLabel = summary ? sessionLabel(summary) : t('currentConversation')
      const effective = state?.effective || null
      const folderPolicy = state?.folder || null

      const init = async () => {
        setBusy(true)
        try {
          await call('initSession', { sessionId, cwd: summary?.cwd })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const setScope = async (key, value) => {
        setBusy(true)
        try {
          const res = await call('setSessionScope', { sessionId, [key]: value })
          // The server clamps against the folder policy; say so rather than
          // letting the checkbox appear to bounce back on its own.
          setNotice(res?.clamped?.length ? t('clampedNotice') : '')
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const setDomain = async (domain) => {
        setBusy(true)
        try {
          await call('setDomain', { sessionId, domain })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const organize = async () => {
        setBusy(true)
        setNotice('')
        try {
          const result = await call('generatePrivate', { sessionId })
          // 失败不再走顶部提示：活动日志里有完整原因和 fork id，面板就在下面。
          if (result?.ok !== true && result?.error) setError(result.error)
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false); void loadRunLog() }
      }
      const startCuration = async () => {
        if (selected.length === 0) return
        setBusy(true)
        try {
          const created = await call('generateGlobal', { sessionId, sessionIds: selected })
          setJob(created)
          setSelected([])
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const archive = async (id) => {
        try {
          await call('archiveMemory', { sessionId, id })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) }
      }

      const RUN_KIND_LABELS = {
        recall: t('logKindRecall'), write: t('logKindWrite'), consolidate: t('logKindConsolidate'),
        curate: t('logKindCurate'), vector: t('logKindVector'), error: t('logKindError'), system: t('logKindSystem'),
      }
      const renderRunRow = (row) => h('div', { key: row.id, style: S.item },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(Tag, { tone: row.level === 'error' ? 'warn' : undefined }, RUN_KIND_LABELS[row.kind] || row.kind),
          h('span', { style: S.muted }, new Date(row.at).toLocaleTimeString())),
        h('div', { style: { marginTop: 2, whiteSpace: 'pre-wrap', fontSize: 12 } }, row.message))

      const bindingBlock = !binding
        ? h(Section, { title: t('noBinding') },
          h(Button, { onClick: init, disabled: busy || !summary?.cwd, primary: true }, t('initMemory')),
          // A library is a folder, so an unset workspace is a real blocker, not a
          // detail to discover by clicking.
          !summary?.cwd ? h('div', { style: { ...S.muted, marginTop: 8 } }, t('needsWorkspaceFirst')) : null)
        : h(React.Fragment, null,
          h('div', { style: S.section },
          // Both layers off in the folder: say so, instead of showing two dead
          // checkboxes the user cannot explain.
          effective && !effective.enabled
            ? h('div', { style: { ...S.muted, marginBottom: 8, color: V.danger } }, t('folderNoMemory'))
            : null,
          h('div', { style: S.row },
            h(Tag, null, domainText(t, state?.domain || 'general')),
            h(Tag, null, `pinned ${state?.pinnedCount ?? 0}`)),
          h(Field, { label: t('usePrivate') },
            h('input', {
              type: 'checkbox',
              checked: effective ? effective.useLibrary : binding.useLibrary !== false,
              // The folder is the ceiling: a blocked switch is shown disabled with
              // the reason, not silently switched off.
              disabled: busy || (folderPolicy && folderPolicy.useLibrary === false),
              title: folderPolicy && folderPolicy.useLibrary === false ? t('folderSwitchOff') : '',
              onChange: (e) => setScope('useLibrary', e.target.checked),
            })),
          h(Field, { label: t('useGlobal') },
            h('input', {
              type: 'checkbox',
              checked: effective ? effective.useGlobal : binding.useGlobal !== false,
              disabled: busy || (folderPolicy && folderPolicy.useGlobal === false),
              title: folderPolicy && folderPolicy.useGlobal === false ? t('folderSwitchOff') : '',
              onChange: (e) => setScope('useGlobal', e.target.checked),
            })),
          h(Field, { label: t('domain') }, h('select', { style: S.input, value: state?.domain || 'general', onChange: (e) => setDomain(e.target.value) },
            ['general', ...(state?.domains || [])].filter((d, i, list) => list.indexOf(d) === i)
              .map((d) => h('option', { key: d, value: d }, domainText(t, d))))),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h(Button, { onClick: organize, disabled: busy, primary: true }, t('organize'))),
          // 整理提醒在记忆设置卡之下、整理记录之上：跨会话的失败提醒离整理入口最近，
          // 但不再压住页头。数据不按当前对话过滤，展开后失败/成功两列各看最新 6 条。
          alertBlock,
          h('div', { style: { marginTop: 12 } },
            h('button', {
              type: 'button',
              title: t('runLogOpen'),
              onClick: () => { openWebUiPage('logs') },
              style: {
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                marginBottom: 4, padding: 0, border: 0, background: 'transparent',
                color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
              },
            },
            h('span', { style: { ...S.muted, fontWeight: 600 } }, t('runLogTitle')),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: V.accent } }, t('runLogOpen') + ' ↗')),
            runLog.length === 0
              ? h('div', { style: S.muted }, t('runLogEmpty'))
              : h('div', { style: S.list }, runLog.slice(0, 5).map(renderRunRow)))),
        // 作用域放在控制卡之后：它是一组低频字段，先让用户看到记忆开关和整理入口。
        h(ContextScope, { binding, sessionId, call, t })
      )

      const renderPrivateItem = (f) => h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('strong', null, f.title || f.id),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Tag, null, enumText(t, LAYER_LABELS, f.layer || 'long_term')),
            f.marginalized ? h(Tag, null, t('marginalizedTag')) : null,
            f.openLoop ? h(Tag, null, t('openLoopTag')) : null,
            // The sidebar is narrow, so only the two values that change how a memory
            // must be handled get a tag: a quote may be repeated verbatim, an invented
            // one must not be presented as fact. `inferred` is the default here.
            f.source === 'user_said' ? h(Tag, { tone: 'info' }, enumText(t, SOURCE_LABELS, 'user_said')) : null,
            f.source === 'imagined' ? h(Tag, { tone: 'warn' }, enumText(t, SOURCE_LABELS, 'imagined')) : null)),
        typeof f.decay === 'number'
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 2px' } },
            h('span', { style: { ...S.muted, minWidth: 64 } }, t('decay')),
            h(Bar, { value: f.decay }))
          : null,
        h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } }, String(f.preview ?? f.content ?? '').slice(0, 500)),
        f.marginalReason ? h('div', { style: { ...S.muted, marginTop: 4, fontStyle: 'italic' } }, `“${f.marginalReason}”`) : null,
        h('div', { style: { marginTop: 6 } }, h(Button, { onClick: () => archive(f.id), style: S.ghost }, t('archive'))))

      const privateBlock = h(Section, { title: `${t('privateMemory')} (${loaded ? privateFiles.length : '…'})` },
        !loaded
          ? h(Empty, null, t('loading'))
          : privateFiles.length === 0
            ? h(Empty, null, t('noPrivate'))
            : h('div', { style: S.list }, privateFiles.map(renderPrivateItem)))

      const renderGlobalItem = (f) => h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('strong', null, f.title || f.id),
          h(Tag, null, domainText(t, f.domain))),
        h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } }, String(f.preview ?? f.content ?? '').slice(0, 400)))

      const renderSessionChoice = (s) => h('label', {
        key: s.id,
        style: { ...S.item, display: 'flex', gap: 8, alignItems: 'flex-start' },
      },
      h('input', {
        type: 'checkbox',
        checked: selected.includes(s.id),
        onChange: (e) => setSelected((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)),
      }),
      h('div', { style: { minWidth: 0 } },
        h('div', null, sessionLabel(s), s.live ? h('span', { style: S.muted }, ' · live') : null),
        h('div', { style: S.muted }, `${s.cwd || '—'} · ${s.agentPreset || 'general'}`)))

      const globalBlock = h(React.Fragment, null,
        h(Section, { title: `${t('globalMemory')} (${loaded ? globalFiles.length : '…'})` },
          !loaded
            ? h(Empty, null, t('loading'))
            : globalFiles.length === 0
              ? h('div', { style: S.muted }, t('noGlobal'))
              : h('div', { style: S.list }, globalFiles.map(renderGlobalItem))),
        h(Section, {
          title: t('curation'),
          right: h(Button, { onClick: startCuration, disabled: busy || selected.length === 0, primary: true }, `${t('startCuration')} (${selected.length})`),
        },
        !sessionsLoaded
          ? h('div', { style: S.muted }, t('loading'))
          : sessions.filter((s) => s.origin !== 'subagent').map(renderSessionChoice),
        job ? h('div', { style: { ...S.muted, marginTop: 8 } },
          `${job.status}${job.step ? ` · ${job.step}` : ''}`,
          job.error ? h('div', { style: { color: V.danger } }, job.error) : null) : null))

      const pages = [
        { key: 'binding', label: t('pageBinding'), node: bindingBlock },
        { key: 'private', label: t('pagePrivate'), node: privateBlock },
        { key: 'global', label: t('pageGlobal'), node: globalBlock },
        // The whole settings surface, embedded: the same component, so there is no
        // second set of rules to drift.
        ...(state?.sidebarSettings ? [{ key: 'config', label: t('pageConfig'), node: h(SettingsPage, { ctx, t, embedded: true }) }] : []),
      ]

      return h('div', { style: S.tab },
        h('div', { style: S.topBar },
          // Two layers, folder then conversation. The full path is deliberately
          // absent: the folder name is the scope, and a path is noise here.
          h('div', { style: S.topBarRow },
            h('div', { style: { minWidth: 0, overflow: 'hidden' } },
              h('div', { style: S.muted }, t('layerFolder')),
              h('strong', { style: { fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, folderLeaf || t('unnamedLibrary')),
              h('div', { style: { ...S.muted, marginTop: 6 } }, t('layerConversation')),
              h('div', { style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bindingLabel)),
            h('div', { style: { display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' } },
              // Straight to the standalone page: same data and RPC, but with room
              // for the full settings surface.
              h(Button, {
                onClick: () => { openWebUiPage() },
                style: S.ghost,
                title: t('openWebUiHint'),
              }, t('openMemu')),
              h(Button, { onClick: refresh, style: S.ghost }, t('refresh')))),
          h('div', { className: 'dshm-nav-list is-row', role: 'tablist' },
            pages.map((p, i) => h('button', {
              key: p.label,
              type: 'button',
              role: 'tab',
              'aria-selected': tabPage === i,
              className: `dshm-nav-item${tabPage === i ? ' on' : ''}`,
              onClick: () => setTabPage(i),
            }, p.label)))),
        error ? h('div', { style: { ...S.muted, padding: '8px 12px 0', color: V.danger } }, error) : null,
        notice ? h('div', { style: { ...S.muted, padding: '8px 12px 0' } }, notice) : null,
        h('div', { className: 'dshm-tab-body', style: S.tabBody }, pages[tabPage]?.node || null))
    }

    // One card = one pair of switches. The card the user clicks, the binding
    // written on confirm, and the two checkboxes the sidebar then shows are the
    // same three ideas, so the mapping lives in one place: any drift shows up as
    // a switch that says the opposite of the card that was picked.
    const LAYERS_OF = {
      none: { useLibrary: false, useGlobal: false },
      auto: { useLibrary: true, useGlobal: false },
      global: { useLibrary: false, useGlobal: true },
      both: { useLibrary: true, useGlobal: true },
    }
    // Only the layers survive "remember my choice"; a one-off pick does not.
    const PREFERENCE_OF = { none: 'off', auto: 'auto', global: 'global', both: 'both' }
    const CARD_OF = { off: 'none', auto: 'auto', global: 'global', both: 'both' }

    function NewSessionGate({ ctx, t }) {
      const current = useCurrentSession(ctx)
      const list = useSessionList(ctx)
      const call = useRpc(ctx)
      const decided = React.useRef(new Set())
      const checking = React.useRef(false)
      const [prompt, setPrompt] = React.useState(null)
      const [choice, setChoice] = React.useState('auto')
      // The card picks the layers; this only picks *which* library carries them.
      // Keeping the two apart is what stops an advanced pick from silently
      // meaning "and whatever the folder policy says about the other switch".
      const [pick, setPick] = React.useState('folder')
      const [libraryId, setLibraryId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [dontShow, setDontShow] = React.useState(false)
      // The domain decides both the prompt variant and the memory filter. It
      // used to live only in the sidebar, which is exactly the switch people
      // forget after starting a coding session in an RP workspace.
      const [domain, setDomain] = React.useState('rp')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const summary = current ? list.byId?.[current] : null
      const summaryCwd = summary?.cwd
      const summaryBlank = summary?.blank
      const summaryOrigin = summary?.origin

      React.useEffect(() => {
        if (!current || decided.current.has(current) || checking.current) return
        if (!summary) return
        if (summaryOrigin === 'subagent') { decided.current.add(current); return }
        if (summaryBlank === false) { decided.current.add(current); return }
        // No workspace folder chosen yet: there is no scope to bind a library to,
        // and initializing here would mint a placeholder library. Wait for the
        // summary to carry a cwd — a folder picked later still prompts normally.
        if (!summaryCwd) return
        checking.current = true
        let cancelled = false
        ;(async () => {
          try {
            const st = await call('getSessionPromptState', { sessionId: current, cwd: summaryCwd })
            if (cancelled) return
            if (st.binding) {
              // A binding left over from the pre-folder build still says
              // Default/__default__. The conversation summary now carries the real
              // cwd, so repair the name in place instead of leaving the wrong label.
              if (st.binding.scopeKey === '__default__' && summaryCwd) {
                await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: false })
              }
              decided.current.add(current)
              return
            }
            // The folder already said no to both layers, so there is nothing to
            // ask: bind silently with nothing enabled and no library created
            // (T5 — this is the bug where the prompt kept appearing for a folder
            // whose memory was switched off).
            if (st.shouldPrompt === false) {
              await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: false })
              await call('setSessionScope', { sessionId: current, useLibrary: false, useGlobal: false })
              decided.current.add(current)
              return
            }
            if (st.settings?.newSessionPromptDismissed) {
              // "Don't ask again" must actually honor the remembered choice.
              // Writing only one of the two layers (or, as this branch used to,
              // only the library) let the folder policy fill the missing switch,
              // so the remembered answer was not the answer the sidebar showed.
              const card = CARD_OF[String(st.settings?.newSessionDefault || 'both')] || 'both'
              const layers = LAYERS_OF[card]
              await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: layers.useLibrary })
              await call('setSessionScope', { sessionId: current, ...layers })
              decided.current.add(current)
              return
            }
            setPrompt({
              sessionId: current,
              cwd: summaryCwd || '',
              libraries: (st.libraries || []).filter((l) => l.scopeKey !== '__default__'),
              domains: Array.isArray(st.domains) && st.domains.length ? st.domains : ['rp', 'coding', 'general', 'mixed'],
              folder: st.folder || null,
              defaultChoice: CARD_OF[String(st.settings?.newSessionDefault || 'both')] || 'both',
            })
            setChoice(CARD_OF[String(st.settings?.newSessionDefault || 'both')] || 'both')
            setPick('folder')
            setDomain('rp')
            setLibraryId((st.libraries || []).find((l) => l.scopeKey !== '__default__')?.id || '')
          } catch (e) {
            if (!cancelled) setError(String(e?.message || e))
            decided.current.add(current)
          } finally {
            if (!cancelled) checking.current = false
          }
        })()
        return () => { cancelled = true; checking.current = false }
      }, [current, summary, summaryCwd, summaryBlank, summaryOrigin, call])

      const confirm = async () => {
        if (!prompt) return
        setBusy(true)
        setError('')
        try {
          if (dontShow) {
            // Persist only the layers the dismissed branch understands; a one-off
            // library pick must not become the default policy.
            const preference = PREFERENCE_OF[choice]
            await call('setSettings', {
              patch: preference
                ? { newSessionPromptDismissed: true, newSessionDefault: preference }
                : { newSessionPromptDismissed: true },
            })
          }
          // The card decides the two layers, and it decides them on *every*
          // branch. Leaving either one unwritten is what let ensureSession fill
          // it from the folder policy, so "private memory only" came back as
          // both switches checked in the sidebar.
          const layers = LAYERS_OF[choice] || LAYERS_OF.none
          // The advanced pick only says which library carries the private layer;
          // with no private layer there is nothing to point at.
          const target = layers.useLibrary ? pick : 'folder'
          if (target === 'existing' && libraryId) {
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, libraryId })
          } else if (target === 'new' && newName.trim()) {
            const lib = await call('createLibrary', { name: newName.trim(), cwd: prompt.cwd })
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, libraryId: lib.id })
          } else {
            // The folder's own library, created only when the private layer is
            // actually on: "no memory" and "global only" must not mint one.
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, createLibrary: layers.useLibrary })
          }
          // Always write both switches, so the sidebar reflects the card and not
          // a policy default.
          await call('setSessionScope', { sessionId: prompt.sessionId, ...layers })
          // The domain is written in the same confirm as the memory layers, so
          // the prompt cannot leave the new conversation on the old default.
          await call('setDomain', { sessionId: prompt.sessionId, domain })
          decided.current.add(prompt.sessionId)
          setPrompt(null)
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy(false)
        }
      }
      const later = async () => {
        if (!prompt) return
        // Dismissing the prompt must never create a library: record only the
        // "don't show again" preference and leave the session unbound.
        try {
          if (dontShow) await call('setSettings', { patch: { newSessionPromptDismissed: true } })
        } catch (e) {
          setError(String(e?.message || e))
        }
        decided.current.add(prompt.sessionId)
        setPrompt(null)
      }

      if (!prompt) return null
      const libraries = prompt.libraries || []
      const folder = prompt.folder || null
      const privateBlocked = folder ? folder.useLibrary === false : false
      const globalBlocked = folder ? folder.useGlobal === false : false
      const cards = [
        {
          id: 'none',
          title: t('memOffTitle'),
          desc: t('memOffDesc'),
          disabled: false,
        },
        {
          id: 'auto',
          title: t('memPrivateTitle'),
          desc: privateBlocked ? t('memBlockedByFolder') : t('memPrivateDesc'),
          disabled: privateBlocked,
        },
        {
          id: 'global',
          title: t('memGlobalTitle'),
          desc: globalBlocked ? t('memBlockedByFolder') : t('memGlobalDesc'),
          disabled: globalBlocked,
        },
        {
          id: 'both',
          title: t('memBothTitle'),
          desc: privateBlocked || globalBlocked ? t('memBlockedByFolder') : t('memBothDesc'),
          disabled: privateBlocked || globalBlocked,
        },
      ]
      return h(Modal, {
        title: t('memoryPromptTitle'),
        onClose: later,
        footer: [
          h(Button, { key: 'later', onClick: later, disabled: busy }, t('later')),
          h(Button, { key: 'ok', onClick: confirm, disabled: busy || (pick === 'existing' && !libraryId) || (pick === 'new' && !newName.trim()), primary: true }, t('confirm')),
        ],
      },
      h('div', { style: { ...S.muted, lineHeight: 1.6 } }, t('memoryPromptBody')),
      error ? h('div', { style: { color: V.danger, fontSize: 12, marginTop: 8 } }, error) : null,
      h('div', { style: { marginTop: 12 } },
        h(Field, { label: t('domain'), hint: t('domainPromptHint') },
          h('select', {
            style: { ...S.input, flex: 1 },
            value: domain,
            disabled: busy,
            onChange: (e) => setDomain(e.target.value),
          }, (prompt.domains || []).map((d) => h('option', { key: d, value: d }, domainText(t, d)))))),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 } },
        cards.map((card) => h('button', {
          key: card.id,
          type: 'button',
          role: 'radio',
          'aria-checked': choice === card.id,
          disabled: busy || card.disabled,
          onClick: () => setChoice(card.id),
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 3,
            textAlign: 'left',
            width: '100%',
            padding: '11px 14px 11px 34px',
            borderRadius: 10,
            border: `1px solid ${choice === card.id ? V.accent : V.border}`,
            background: choice === card.id ? V.accentSoft : 'transparent',
            color: 'inherit',
            cursor: card.disabled ? 'default' : 'pointer',
            opacity: card.disabled ? 0.5 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute', left: 12, top: 15, width: 14, height: 14,
            borderRadius: '50%', border: `1.5px solid ${choice === card.id ? V.accent : V.border}`,
          },
        }, choice === card.id ? h('span', { style: { position: 'absolute', inset: 3, borderRadius: '50%', background: V.accent } }) : null),
        h('strong', { style: { fontSize: 13 } }, card.title),
        h('span', { style: { ...S.muted, lineHeight: 1.55 } }, card.desc)))),
      // Existing/new library choice is a power feature; most people want the
      // folder's own library, so it stays collapsed.
      h('details', { style: { marginTop: 10 } },
        h('summary', { style: { ...S.muted, cursor: 'pointer' } }, t('advanced')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
          // A separate radio group from the cards above: choosing a library must
          // not overwrite which layers the card above already asked for. That
          // overwrite was the bug — clicking "existing library" sent the whole
          // choice to 'existing', which the confirm branch did not handle, so no
          // scope was written and the folder policy checked both switches.
          h('label', { style: S.row }, h('input', { type: 'radio', name: 'memu-library', checked: pick === 'folder', onChange: () => setPick('folder') }), t('folderLibrary')),
          h('label', { style: S.row }, h('input', { type: 'radio', name: 'memu-library', checked: pick === 'existing', onChange: () => setPick('existing') }), t('chooseLibrary')),
          pick === 'existing' ? h('select', {
            style: { ...S.input, marginLeft: 24 }, value: libraryId,
            title: libraries.find((lib) => lib.id === libraryId)?.scopeKey || t('currentLibrary'),
            onChange: (e) => setLibraryId(e.target.value),
          }, libraries.map((l) => h('option', { key: l.id, value: l.id }, libraryOptionLabel(l, libraries)))) : null,
          h('label', { style: S.row }, h('input', { type: 'radio', name: 'memu-library', checked: pick === 'new', onChange: () => setPick('new') }), t('createLibrary')),
          pick === 'new' ? h('input', { style: { ...S.input, marginLeft: 24 }, placeholder: t('name'), value: newName, onChange: (e) => setNewName(e.target.value) }) : null)),
      h('label', { style: { ...S.row, marginTop: 12 } }, h('input', { type: 'checkbox', checked: dontShow, onChange: (e) => setDontShow(e.target.checked) }), t('rememberChoice')))
    }

    exports.name = NS
    exports.mountStandalone = (container, options = {}) => {
      let sequence = 0
      const ctx = {
        standalone: true, get: () => undefined,
        connection: { rpc: { call: async (_path, endpoint, payload) => {
          const response = await fetch('/dsh-memu-memory/' + endpoint, {
            method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'standalone-' + (++sequence), method: endpoint, payload: payload || {} }),
          })
          const envelope = await response.json()
          if (!envelope.result) {
            // 服务端错误信封（如 403 forbidden）带可读 message：透传它而不是
            // 只报 HTTP 状态码，用户才能看到「为什么」。
            throw new Error(envelope.error?.message || ('Invalid RPC response: ' + response.status))
          }
          return envelope.result
        } } },
      }
      const dictionary = String(navigator.language || '').startsWith('zh') ? zh : en
      const t = key => dictionary[key] || key
      const style = document.createElement('style')
      style.textContent = UI_CSS
      document.head.appendChild(style)
      const root = ReactDOM.createRoot(container)
      root.render(options.sessionId ? h(MemoryTab, { ctx, t, sessionId: options.sessionId }) : h(SettingsPage, { ctx, t, embedded: false, standalone: true }))
      return () => { root.unmount(); style.remove() }
    }
    exports.inject = ['slots', 'locale', 'connection', 'sessions']

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memu-memory: locale')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-memu-memory', 'ui')
        style.textContent = UI_CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-memu-memory: settings stylesheet')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 45,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ ctx, t }),
      }, SettingsPage))

      // One tab, not two. When dsh-better-sidebar is installed it hosts the panel
      // itself, and its start list shows both registries — so keeping the native
      // tab as well produced two identical "MemU 记忆" entries.
      let nativeDispose = null
      let nativeScope = null

      const betterSidebarOf = (scope) => {
        try {
          const service = scope.get?.('betterSidebar') || scope.betterSidebar
          return service && typeof service.registerTab === 'function' ? service : null
        } catch {
          return null
        }
      }

      const mountNativeTab = () => {
        if (nativeDispose || !nativeScope) return
        if (betterSidebarOf(nativeScope)) return
        nativeDispose = nativeScope.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('nav'),
          guide: [{
            id: 'memory',
            order: 60,
            title: () => t('nav'),
            description: () => t('guideDesc'),
          }],
        })
      }

      const unmountNativeTab = () => {
        if (!nativeDispose) return
        try { nativeDispose() } catch {}
        nativeDispose = null
      }

      ctx.inject(['sidebarRightTabs'], (scope) => {
        nativeScope = scope
        scope.effect(() => {
          mountNativeTab()
          return unmountNativeTab
        }, 'dsh-memu-memory: sidebar tab')
        scope.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, (props) => h(MemoryTab, { ...props, ctx, t }))), 'dsh-memu-memory: sidebar tab body')
      })

      // Optional third-party panel: dsh-better-sidebar. If it is not installed the
      // inject callback simply never runs, and the native sidebar tab above is all
      // there is. Never import its package — the client bundle purity gate rejects
      // value imports from plugins we do not depend on.
      try {
        ctx.inject?.(['betterSidebar'], (scope) => {
          const service = betterSidebarOf(scope)
          if (!service) return
          // Registered after us? The native tab is already visible; drop it now so
          // the two never coexist.
          unmountNativeTab()
          scope.effect(() => service.registerTab({
            id: `${NS}:memory-better`,
            title: () => t('nav'),
            order: 55,
            single: true,
            component: () => h(BetterSidebarMemoryTab, { ctx, t }),
          }) ?? null, 'dsh-memu-memory: better-sidebar tab')
        })
      } catch (error) {
        void error
      }

      if (ReactDOM?.createRoot && typeof document !== 'undefined') {
        ctx.inject(['sessions'], (scope) => {
          const container = document.createElement('div')
          container.setAttribute('data-dsh-memu-memory-gate', '')
          document.body.append(container)
          const root = ReactDOM.createRoot(container)
          root.render(h(NewSessionGate, { ctx: scope, t }))
          scope.effect(() => () => {
            try { root.unmount() } catch {}
            container.remove()
          }, 'dsh-memu-memory: new session gate')
        })
      }
    }

    return module.exports
  },
})
