window.__ModuleLoader__.load({
  id: 'dsh-memu-memory',
  factory: (require) => {
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom/client') } catch {}
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'dsh-memu-memory'
    const SETTINGS_PAGES = ['engine', 'settings', 'folders', 'libraries', 'browser', 'global', 'prompts', 'stats', 'memories']
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
    function useMemoryBeat({ call, markerRef, onBeat }) {
      React.useEffect(() => {
        const id = setInterval(async () => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return
          try {
            const res = await call("getSidebarState", { revisionOnly: true })
            // null means nothing has been painted yet; the mount fetch owns that case.
            if (markerRef.current === null) return
            const next = sidebarMarker(res)
            if (next === markerRef.current) return
            const previous = markerRef.current
            const result = await onBeat()
            if (result !== false && markerRef.current === previous) markerRef.current = next
          } catch {}
        }, BEAT_MS)
        // Never hold the host process open for a poll (matters in tests too).
        if (id && typeof id.unref === "function") id.unref()
        return () => clearInterval(id)
      }, [call, markerRef, onBeat])
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
      allLibraries: '全部记忆库',
      searchMemories: '搜索标题、内容或标签',
      poolReview: '待复核',
      poolInactive: '已失效',
      wallReadError: '部分记忆库读取失败',
      wallLimit: '仅展示最近 300 条',
      openMemu: '打开 MemU WebUI',
      saved: '已保存',
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
      exportImages: '导出含图片',
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
      viewRelations: '关系',
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
      turnTokens: '回合 token',
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
      backendApi: '远程（API）',
      backendAgentHint: '由当前对话的 Agent 自己总结并写入记忆索引；不需要 MemU、Ollama 或 API Key。',
      backendApiHint: '把记忆写入与检索交给配置好的远程 MemU API；需要可用的服务地址和密钥。',
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
      moodTag: '情绪',
      reviews: '待复核',
      reviewsEmpty: '没有等待复核的记忆。',
      reviewScopePrivate: '私有库',
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
      descOverview: 'MemU 引擎状态、安装修复与 embedding 服务连接。',
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
      pageOverview: '引擎与连接',
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
      importHint: '选择导出的 JSON 或图片 ZIP。按正文去重；已归档与失效条目跳过；session 私有范围保持限制，不自动改为共享。',
      importDone: '导入完成（新增 / 跳过）',
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
      visSession: '本会话',
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
      loading: '加载中…',
    }

    const en = {
      inboundToolNames: 'External message tool allowlist',
      reviewResolution: 'Resolution',
      reviewReplace: 'Replace the old fact',
      reviewCoexist: 'Coexist under distinct conditions',
      reviewConditions: 'Explain distinct conditions (at least 8 characters)',
      pageMemories: 'MemU Memory',
      descMemories: 'Memories, provenance and status across libraries',
      allLibraries: 'All libraries',
      searchMemories: 'Search titles, content or tags',
      poolReview: 'Review',
      poolInactive: 'Inactive',
      wallReadError: 'Some libraries could not be read',
      wallLimit: 'Showing the latest 300 entries',
      openMemu: 'Open MemU WebUI',
      saved: 'Saved',
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
      exportImages: 'Export with images',
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
      viewRelations: 'Relations',
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
      turnTokens: 'Turn tokens',
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
      backendApi: 'Remote (API)',
      backendAgentHint: 'The conversation agent summarizes and writes memories into the local index; no MemU, Ollama, or API key is needed.',
      backendApiHint: 'Memory writes and retrieval go through the configured remote MemU API; it needs a reachable endpoint and key.',
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
      moodTag: 'mood',
      reviews: 'Awaiting review',
      reviewsEmpty: 'No memories are waiting for review.',
      reviewScopePrivate: 'private library',
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
      descOverview: 'MemU engine status, install/repair, and the embedding service connection.',
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
      pageOverview: 'Engine & connection',
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
      importHint: 'Import exported JSON or an image ZIP. Duplicate and inactive entries are skipped; session-scoped entries remain restricted and are never widened to shared.',
      importDone: 'Imported (added / skipped)',
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
      visSession: 'session',
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
      loading: 'Loading…',
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
.dshm-scope{margin:0 12px 10px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));overflow:hidden}
.dshm-scope>summary{display:flex;align-items:center;gap:7px;padding:9px 12px;list-style:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));transition:color .18s ease}
.dshm-scope>summary::-webkit-details-marker{display:none}
.dshm-scope>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .2s ease;margin-right:1px}
.dshm-scope[open]>summary::before{transform:rotate(45deg)}
.dshm-scope>summary:hover{color:var(--dsw-alias-label-primary,inherit)}
.dshm-scope>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-2px}
.dshm-scope-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;padding:0 12px 12px}
.dshm-scope-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}
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
    function openWebUiPage(page = null) {
      let url = '/dsh-memu-memory/ui#/settings/' + (page || 'memories')
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

    function Button({ children, onClick, disabled, primary, style, title, type = 'button' }) {
      return h('button', {
        type,
        className: 'dshm-btn',
        // Without this the prop never reaches the node, and every hover hint on
        // the surface silently stops working.
        title,
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
    const VISIBILITY_LABELS = { shared: 'visShared', session: 'visSession', secret: 'visSecret' }
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
          return { subscribe: cur.subscribe.bind(cur), get: () => cur.getSnapshot()?.key }
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
        entities.map(entity => h('form', { key: entity.id, className: 'dshm-graph-tools', onSubmit: event => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          void act('renameEntity', { entityId: entity.id, name: String(data.get('name')), aliases: String(data.get('aliases')).split(',').map(value => value.trim()).filter(Boolean) })
        } },
          h('input', { name: 'name', defaultValue: entity.name, 'aria-label': t('entityName') }),
          h('input', { name: 'aliases', defaultValue: (entity.aliases || []).join(', '), placeholder: t('entityAliases'), 'aria-label': t('entityAliases') }),
          h('button', { type: 'submit', className: 'dshm-btn', style: S.btn }, t('save')))))
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

    function MemoryWallPanel({ call, libraries, revision, stamp, onOpen, t }) {
      const [data, setData] = React.useState({ items: [], total: 0, errors: [] })
      const [libraryId, setLibraryId] = React.useState('')
      const [view, setView] = React.useState('memories')
      const [graphLib, setGraphLib] = React.useState('')
      const [pool, setPool] = React.useState('active')
      const [layer, setLayer] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState('')
      const [version, setVersion] = React.useState(0)
      // Opens in place instead of jumping to the browser: one card, one request, and
      // the wall stays where the reader left it. `null` means the drawer is closed.
      const [detail, setDetail] = React.useState(null)
      const [deleteArmed, setDeleteArmed] = React.useState(false)
      const reload = () => setVersion(value => value + 1)
      React.useEffect(() => {
        let alive = true
        void call('browseWall', { libraryId: libraryId || null, limit: 300 }).then(value => { if (alive) { setData(value); setError('') } })
          .catch(error => { if (alive) setError(String(error.message || error)) })
        return () => { alive = false }
      }, [call, libraryId, revision, stamp, version])
      React.useEffect(() => {
        if (graphLib) return
        const first = libraryId || libraries[0]?.id || ''
        if (first) setGraphLib(first)
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
      const rows = items.filter(item => poolOf(item) === pool)
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
          }
          const confidence = draft.confidence === '' ? NaN : Number(draft.confidence)
          if (Number.isFinite(confidence)) patch.confidence = Math.max(0, Math.min(1, confidence))
          await call('updateMemory', { libraryId: current.item.libraryId, id: current.item.id, patch })
          await refreshDetail(current)
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
          reload()
        } catch (failure) {
          setDetail(prev => prev ? { ...prev, busy: false, error: String(failure?.message || failure) } : prev)
        }
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
          ? h(React.Fragment, null,
            h('p', { className: 'dshm-drawer-copy' }, detail.file.content || shown.preview),
            h('p', { className: 'dshm-drawer-note' }, t('globalReadOnly')))
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

      const graphLibrary = graphLib || libraryId || libraries[0]?.id || ''
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
                title: t('currentLibrary'),
                // One library drives both views, otherwise the graph's focus list can
                // be empty when the wall is filtered to a different library.
                onChange: (event) => { setGraphLib(event.target.value); setLibraryId(event.target.value) },
              },
              libraries.map(lib => h('option', { key: lib.id, value: lib.id }, lib.name || lib.id)))),
            h(GraphPanel, { key: graphLibrary, call, libraryId: graphLibrary, files: graphFiles, t })))

      return h('div', { className: 'dshm-wall' },
        h('div', { className: 'dshm-nav-list is-row dshm-wall-views', role: 'tablist' },
          [['memories', 'viewMemories'], ['relations', 'viewRelations']].map(([value, key]) =>
            h('button', {
              key: value, type: 'button', role: 'tab', 'aria-selected': view === value,
              className: `dshm-nav-item${view === value ? ' on' : ''}`,
              onClick: () => setView(value),
            }, t(key)))),
        error || data.errors?.length ? h('p', { className: 'dshm-error', role: 'alert' }, error || t('wallReadError')) : null,
        view === 'relations'
          ? graphView
          : h(React.Fragment, null,
            data?.total > items.length ? h('p', null, t('wallLimit') + ` (${items.length}/${data.total})`) : null,
            h('div', { className: 'dshm-graph-tools' },
              h('input', { type: 'search', value: query, placeholder: t('searchMemories'), 'aria-label': t('searchMemories'), onChange: event => setQuery(event.target.value) }),
              h('select', { value: libraryId, title: t('currentLibrary'), onChange: event => setLibraryId(event.target.value) },
                h('option', { value: '' }, t('allLibraries')), libraries.map(lib => h('option', { key: lib.id, value: lib.id }, lib.name || lib.id)))),
            h('div', { className: 'dshm-nav-list is-row', role: 'tablist' }, [['active', 'browseActiveTab'], ['archived', 'browseArchivedTab'], ['review', 'poolReview'], ['inactive', 'poolInactive']].map(([value, key]) =>
              h('button', { key: value, type: 'button', role: 'tab', 'aria-selected': pool === value, className: `dshm-nav-item${pool === value ? ' on' : ''}`, onClick: () => setPool(value) },
                t(key) + ' (' + items.filter(item => poolOf(item) === value).length + ')'))),
            h('div', { className: 'dshm-nav-list is-row', role: 'tablist' }, ['all', 'must_remember', 'long_term', 'short_term', 'anchor'].map(value =>
              h('button', { key: value, type: 'button', role: 'tab', 'aria-selected': layer === value, className: `dshm-nav-item${layer === value ? ' on' : ''}`, onClick: () => setLayer(value) },
                (value === 'all' ? t('allLibraries') : enumText(t, LAYER_LABELS, value)) + ' (' + rows.filter(item => layerMatch(item, value)).length + ')'))),
            visible.length ? h('div', { className: 'dshm-wall-grid' }, visible.map(item =>
              h('button', { key: (item.libraryId || 'global') + item.id, type: 'button', className: 'dshm-wall-item', onClick: () => { void openDetail(item) } },
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

    function SettingsPage({ ctx, t, embedded, standalone = false }) {
      const PAGE = {
        overview: 0,
        settings: 1,
        folders: 2,
        libraries: 3,
        browser: 4,
        global: 5,
        prompts: 6,
        stats: 7,
        memories: 8,
      }
      const call = useRpc(ctx)
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
      // Success messages need their own slot: reusing `error` would paint a good
      // outcome in red and make the next real failure easy to miss.
      const [notice, setNotice] = React.useState('')
      const [configDraft, setConfigDraft] = React.useState(null)
      const [configBusy, setConfigBusy] = React.useState(false)
      const [configNotice, setConfigNotice] = React.useState('')
      const [page, setPage] = React.useState(() => standalone
        ? (SETTINGS_PAGES.includes(String(window.location.hash || '').replace(/^#\/settings\//, ''))
          ? SETTINGS_PAGES.indexOf(String(window.location.hash || '').replace(/^#\/settings\//, '')) : 8)
        : 0)
      const pendingSettings = React.useRef({})
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
      const [newMem, setNewMem] = React.useState({ title: '', content: '', layer: 'long_term' })
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
            call('listReviews', {}),
            browseLibId
              ? call('listReviews', { libraryId: browseLibId }).catch(() => ({ items: [] }))
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
      useMemoryBeat({ call, markerRef, onBeat: refresh })
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
        void call('browseLibrary', { libraryId: browseLibId }).then(result => {
          if (!alive) return
          setBrowseFiles(result.files || [])
          setBrowseSource(result.source || '')
        }).catch(error => { if (alive) setError(String(error.message || error)) })
        return () => { alive = false }
      }, [call, page, browseLibId, state?.revision, state?.stamp])
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
          if (payload.layer === 'must_remember') {
            payload.pinReason = 'user_explicit_note'
            payload.pinSource = 'user_explicit'
          }
          await call('addMemory', payload)
          notifyMemoryWrite('memory', browseLibId)
          setNewMem({ title: '', content: '', layer: 'long_term' })
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
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const archiveMemory = async (id) => {
        setBrowseBusy(true)
        try {
          await call('archiveMemory', { libraryId: browseLibId, id })
          notifyMemoryWrite('memory', browseLibId)
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const restoreMemory = async (id) => {
        setBrowseBusy(true)
        try {
          await call('updateMemory', { libraryId: browseLibId, id, patch: { status: 'active' } })
          notifyMemoryWrite('memory', browseLibId)
          await openBrowser(browseLibId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }
      const deleteMemoryForever = async (id) => {
        setBrowseBusy(true)
        setError('')
        try {
          await call('deleteMemory', { libraryId: browseLibId, id })
          notifyMemoryWrite('memory', browseLibId)
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
            ...(item.libraryId ? { libraryId: item.libraryId } : {}),
          })
          notifyMemoryWrite('review', item.libraryId || null)
          await loadReviews()
          await refresh()
          // A private review lives in the browser's list, so that view is stale now.
          if (item.libraryId && browseLibId === item.libraryId) await openBrowser(item.libraryId)
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const exportLibraryNow = async (includeAttachments = false) => {
        if (!browseLibId) return
        setBrowseBusy(true)
        try {
          const data = await call('exportLibrary', { libraryId: browseLibId, includeAttachments, delivery: includeAttachments ? 'download' : undefined })
          if (data.downloadUrl) {
            const link = document.createElement('a')
            link.href = data.downloadUrl; link.download = data.filename; link.click()
            return
          }
          const blob = data.base64
            ? new Blob([Uint8Array.from(atob(data.base64), char => char.charCodeAt(0))], { type: 'application/zip' })
            : new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = data.filename || `dsh-memu-memory-${browseLibId}.json`
          a.click()
          URL.revokeObjectURL(url)
        } catch (e) { setError(String(e?.message || e)) } finally { setBrowseBusy(false) }
      }

      // Import reads the file in the browser and hands the text to the server: the
      // host already owns the state directory, so no path guessing is needed.
      const importLibraryNow = () => {
        if (!browseLibId) return
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
            const payload = { libraryId: browseLibId }
            let res
            if (file.name.toLowerCase().endsWith('.zip')) {
              const response = await fetch('/dsh-memu-memory/import/' + encodeURIComponent(browseLibId) + '.zip', {
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
            const skipped = (c.duplicate || 0) + (c.invalid || 0) + (c.dead || 0) + (c.expired || 0) + (c.downgraded || 0) + (c.sessionReset || 0)
            setNotice(`${t('importDone')}: +${res.imported || 0} / −${skipped}`)
            if (res.engineWarning) setError(`${t('importEngineWarning')}: ${res.engineWarning}`)
            notifyMemoryWrite('import', browseLibId)
            await openBrowser(browseLibId)
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
      const isLocalEmbed = memuConfig.source === 'local'
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
        if (source === memuConfig.source) return
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

        h(Section, {
          title: t('memoryBackend'),
          desc: memoryBackend === 'api' ? t('backendApiHint') : t('backendAgentHint'),
          right: memoryBackend === 'api'
            ? h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { onClick: saveConfig, disabled: configBusy, primary: true }, t('saveConfig')),
              h(Button, { onClick: testConfig, disabled: configBusy }, t('testConfig')),
              h(Button, { onClick: clearKey, disabled: configBusy }, t('clearKey')))
            : null,
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
        memoryBackend === 'api'
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
        configNotice ? h('div', { style: { ...S.muted, marginTop: 6 } }, configNotice) : null)
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
        h(Field, { label: t('privateTopK') }, h('input', { type: 'number', style: S.input, value: settings.privateTopK ?? 4, onChange: (e) => setSetting('privateTopK', Number(e.target.value)) })),
        h(Field, { label: t('globalTopK') }, h('input', { type: 'number', style: S.input, value: settings.globalTopK ?? 3, onChange: (e) => setSetting('globalTopK', Number(e.target.value)) })),
        h(Field, { label: t('mustRememberCap') }, h('input', { type: 'number', style: S.input, value: settings.mustRememberCap ?? 16, onChange: (e) => setSetting('mustRememberCap', Number(e.target.value)) })),
        h(Field, { label: t('shortTermTtlHours') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.shortTermTtlHours ?? 72, onChange: (e) => setSetting('shortTermTtlHours', Number(e.target.value)) })),
        h(Field, { label: t('anchorTokens') }, h('input', { type: 'number', style: S.input, value: settings.anchorTokens ?? 700, onChange: (e) => setSetting('anchorTokens', Number(e.target.value)) })),
        h(Field, { label: t('turnTokens') }, h('input', { type: 'number', style: S.input, value: settings.turnTokens ?? 1200, onChange: (e) => setSetting('turnTokens', Number(e.target.value)) })),
        h(Field, { label: t('dedupeTurns') }, h('input', { type: 'number', style: S.input, value: settings.dedupeTurns ?? 8, onChange: (e) => setSetting('dedupeTurns', Number(e.target.value)) })),
        h(Field, { label: t('globalEveryNTurns') }, h('input', { type: 'number', style: S.input, value: settings.globalEveryNTurns ?? 3, onChange: (e) => setSetting('globalEveryNTurns', Number(e.target.value)) })),
        h(Field, { label: t('minUserChars') }, h('input', { type: 'number', style: S.input, value: settings.minUserChars ?? 6, onChange: (e) => setSetting('minUserChars', Number(e.target.value)) })),
        h(Field, { label: t('relevanceThreshold') }, h('input', { type: 'number', step: '0.05', min: 0, max: 1, style: S.input, value: settings.relevanceThreshold ?? 0.4, onChange: (e) => setSetting('relevanceThreshold', Number(e.target.value)) })),
        h(Field, { label: t('randomCueChance') }, h('input', { type: 'number', step: '0.01', min: 0, max: 1, style: S.input, value: settings.randomCueChance ?? 0.05, onChange: (e) => setSetting('randomCueChance', Number(e.target.value)) })),
        h(Field, { label: t('autoInstall') }, h('input', { type: 'checkbox', checked: settings.autoInstallEngine !== false, onChange: (e) => setSetting('autoInstallEngine', e.target.checked) })),
        h(Field, { label: t('newSessionPrompt') }, h('input', { type: 'checkbox', checked: settings.newSessionPromptDismissed !== true, onChange: (e) => setSetting('newSessionPromptDismissed', !e.target.checked) })),
        h(Field, { label: t('habitsInjection') }, h('input', { type: 'checkbox', checked: settings.habitsInjection !== false, onChange: (e) => setSetting('habitsInjection', e.target.checked) })),
        h(Field, { label: t('sidebarSettings') }, h(Toggle, { checked: settings.sidebarSettings === true, label: t('sidebarSettings'), onChange: value => setSetting('sidebarSettings', value) })),
        h(Field, { label: t('visionCaptionEnabled') }, h(Toggle, { checked: settings.visionCaptionEnabled === true, label: t('visionCaptionEnabled'), onChange: value => setSetting('visionCaptionEnabled', value) })),
        h(Field, { label: t('inboundToolNames') }, h(InboundToolsInput, {
          names: settings.inboundToolNames || [], onChange: values => setSetting('inboundToolNames', values),
        })),
        h(Field, { label: t('sleepConsolidation') }, h('input', { type: 'checkbox', checked: settings.sleepConsolidation === true, onChange: (e) => setSetting('sleepConsolidation', e.target.checked) })),
        h(Field, { label: t('sleepAfterIdleMinutes') }, h('input', { type: 'number', min: 1, style: S.input, value: settings.sleepAfterIdleMinutes ?? 20, onChange: (e) => setSetting('sleepAfterIdleMinutes', Number(e.target.value)) })),
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

      const renderGlobalItem = (f) => h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('strong', null, f.title || f.id),
          h('div', { style: { display: 'flex', gap: 6 } },
            h(Tag, null, domainText(t, f.domain)),
            h(Tag, null, `conf ${f.confidence ?? '?'}`))),
        h('div', { style: { ...S.muted, marginTop: 4, whiteSpace: 'pre-wrap' } },
          String(f.content || '').slice(0, 400))
      )

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

      const renderReviewItem = (r) => h('div', { key: r.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('strong', null, r.title || r.id),
            h('div', { style: S.row },
              h(Tag, { tone: r.libraryId ? 'info' : undefined }, r.libraryId ? t('reviewScopePrivate') : (r.domain || 'unknown')),
              r.reviewReason ? h(Tag, null, `${t('reviewReason')}: ${r.reviewReason}`) : null,
              typeof r.confidence === 'number' ? h(Tag, null, `conf ${r.confidence}`) : null)),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Button, { onClick: () => resolveReview(r, 'accept'), disabled: busy, primary: true }, t('accept')),
            h(Button, { onClick: () => resolveReview(r, 'reject'), disabled: busy, style: S.ghost }, t('reject')))),
        h('div', { style: { ...S.muted, marginTop: 6, whiteSpace: 'pre-wrap' } }, String(r.content || '').slice(0, 800)),
        h('div', { className: 'dshm-graph-tools' },
          h('select', { title: t('reviewResolution'), value: reviewDrafts[r.id]?.resolution || 'replace',
            onChange: event => setReviewDrafts(previous => ({ ...previous, [r.id]: { ...previous[r.id], resolution: event.target.value } })) },
            h('option', { value: 'replace' }, t('reviewReplace')), h('option', { value: 'coexist' }, t('reviewCoexist'))),
          reviewDrafts[r.id]?.resolution === 'coexist' ? h('input', { placeholder: t('reviewConditions'), value: reviewDrafts[r.id]?.reason || '',
            onChange: event => setReviewDrafts(previous => ({ ...previous, [r.id]: { ...previous[r.id], reason: event.target.value } })) }) : null),
        (r.evidence || []).length > 0
          ? h('div', { style: { ...S.muted, marginTop: 6, lineHeight: 1.6 } },
            r.evidence.map((e, i) => h('div', { key: `${r.id}-ev-${i}` }, `· ${e.sessionId}：${String(e.quote || '').slice(0, 160)}`)))
          : null)

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
        )
      )

      const renderPromptItem = (p) => h('div', { key: p.key, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } },
          h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
            h('strong', null, p.title || p.key),
            h('div', { style: S.muted }, p.description || ''),
            h('div', { style: S.row },
              h(Tag, null, p.domain ? domainText(t, p.domain) : t('promptGroupGeneral')),
              h(Tag, null, p.source === 'user' ? t('promptCustom') : t('promptDefault')),
              p.inheritedFrom ? h(Tag, null, t('promptInherited')) : null,
              p.defaultUpdated ? h(Tag, null, t('promptUpdated')) : null,
              h('span', { style: S.muted }, `${t('variables')}: ${(p.variables || []).join(', ') || '—'}`))),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
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
      const promptPageList = h('div', { className: 'dshm-nav-list', role: 'tablist', style: { minWidth: 138 } },
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

      const promptPageBody = h('div', { style: { flex: 1, minWidth: 0 } },
        pagePrompts.length === 0
          ? h(Empty, null, t('promptPageEmpty'))
          : h('div', { style: { ...S.list, gap: 14 } }, pagePrompts.map(renderPromptItem)))

      const promptsBlock = h(Section, { title: t('prompts'), desc: t('descPrompts'), right: h(Button, { onClick: resetAllPrompts, disabled: busy, style: S.ghost }, t('promptResetAll')) },
        promptScopeTabs,
        h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' } },
            promptPageList,
            promptScope === 'private'
              ? h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
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
              f.expiresAt ? h(Tag, null, `${t('shortTermExpires')} ${String(f.expiresAt).slice(5, 16).replace('T', ' ')}`) : null,
              f.peak ? h(Tag, null, t('peakTag')) : null,
              f.salientDate ? h(Tag, null, `${t('anniversaryTag')} ${f.salientDate}`) : null,
              typeof f.moodValence === 'number' && f.moodValence !== 0
                ? h(Tag, null, `${t('moodTag')} ${f.moodValence.toFixed(2)}`) : null,
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
            }, ['shared', 'session', 'secret'].map((v) => h('option', { key: v, value: v }, enumText(t, VISIBILITY_LABELS, v)))),
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
            h(Button, { onClick: () => exportLibraryNow(true), disabled: !browseLibId, title: t('exportImages') }, t('exportImages')),
            h(Button, { onClick: () => openBrowser(browseLibId), disabled: busy || !browseLibId, primary: true }, t('reload'))),
        },
        h('div', { style: S.row },
          h('span', { style: S.label }, t('currentLibrary')),
          h('select', {
            style: { ...S.input, flex: 1 }, value: browseLibId,
            onChange: (e) => setBrowseLibId(e.target.value),
          }, (state.libraries || []).map((l) => h('option', { key: l.id, value: l.id }, `${l.name || l.id} (${l.scopeKey || '—'})`)))),
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
            onChange: (e) => setStatsLibId(e.target.value),
          }, (state.libraries || []).map((l) => h('option', { key: l.id, value: l.id }, `${l.name || l.id} (${l.scopeKey || '—'})`)))),
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

      const pageDefs = [
        { label: t('pageOverview'), overline: 'ENGINE', desc: t('descOverview'), icon: GlyphGauge },
        { label: t('pageSettings'), overline: 'BEHAVIOUR', desc: t('descSettings'), icon: GlyphSliders },
        { label: t('pageFolders'), overline: 'SCOPE', desc: t('descFolders'), icon: GlyphFolder },
        { label: t('pageLibraries'), overline: 'LIBRARIES', desc: t('descLibraries'), icon: GlyphStack },
        { label: t('pageBrowser'), overline: 'BROWSE', desc: t('descBrowser'), icon: GlyphSearch },
        { label: t('pageGlobal'), overline: 'GLOBAL', desc: t('descGlobal'), icon: GlyphGlobe },
        { label: t('pagePrompts'), overline: 'PROMPTS', desc: t('descPrompts'), icon: GlyphText },
        { label: t('pageStats'), overline: 'STATS', desc: t('descStats'), icon: GlyphChart },
      ]
      pageDefs.push({ label: t('pageMemories'), overline: 'MEMU', desc: t('descMemories'), icon: GlyphLayers })
      const memoriesBlock = h(MemoryWallPanel, { call, libraries: state.libraries || [], revision: state.revision, stamp: state.stamp, t,
        onOpen: item => {
          if (item.libraryId) { setBrowseLibId(item.libraryId); setPage(PAGE.browser); void openBrowser(item.libraryId) }
          else setPage(PAGE.global)
        } })
      const pageBlocks = [engineBlock, settingsBlock, foldersBlock, librariesBlock, browserBlock, globalBlock, promptsBlock, statsBlock, memoriesBlock]

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
        if (pages[tabPage]?.key !== 'global' || sessionsLoaded || !loaded) return
        void loadSidebarSessions()
      }, [tabPage, sessionsLoaded, loaded, loadSidebarSessions])

      React.useEffect(() => { void refresh() }, [refresh])
      // Instant path: another pane of this window wrote a memory (browser add /
      // save / archive / import, review resolution). Measured in milliseconds,
      // not in "reopen the tab".
      React.useEffect(() => {
        const onWrite = () => { void refresh() }
        memoryWriteListeners.add(onWrite)
        return () => { memoryWriteListeners.delete(onWrite) }
      }, [refresh])
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

      if (!sessionId) return h('div', { style: S.tab }, t('loading'))
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
          await call('setDomain', { sessionId, domain: domain === 'general' ? null : domain })
          await refresh()
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const organize = async () => {
        setBusy(true)
        setNotice('')
        try {
          const result = await call('generatePrivate', { sessionId })
          setNotice(result?.ok
            ? (result.backend === 'api'
              ? t('organizedRemote').split('{count}').join(String(result.count ?? 0))
              : t('organizedAgent'))
            : (result?.error || ''))
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
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

      const bindingBlock = !binding
        ? h(Section, { title: t('noBinding') },
          h(Button, { onClick: init, disabled: busy || !summary?.cwd, primary: true }, t('initMemory')),
          // A library is a folder, so an unset workspace is a real blocker, not a
          // detail to discover by clicking.
          !summary?.cwd ? h('div', { style: { ...S.muted, marginTop: 8 } }, t('needsWorkspaceFirst')) : null)
        : h('div', { style: S.section },
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
            h(Button, { onClick: organize, disabled: busy, primary: true }, t('organize'))))

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
        h(ContextScope, { binding, sessionId, call, t }),
        h('div', { style: S.tabBody }, pages[tabPage]?.node || null))
    }

    function NewSessionGate({ ctx, t }) {
      const current = useCurrentSession(ctx)
      const list = useSessionList(ctx)
      const call = useRpc(ctx)
      const decided = React.useRef(new Set())
      const checking = React.useRef(false)
      const [prompt, setPrompt] = React.useState(null)
      const [choice, setChoice] = React.useState('auto')
      const [libraryId, setLibraryId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [dontShow, setDontShow] = React.useState(false)
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
              // "Don't ask again" must actually honor the remembered choice —
              // always creating a library here made the preference a no-op.
              const pref = st.settings?.newSessionDefault || 'both'
              if (pref === 'off') {
                await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: false })
                await call('setSessionScope', { sessionId: current, useLibrary: false, useGlobal: false })
              } else if (pref === 'auto') {
                await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: true })
              } else {
                // 'both' (and any legacy value): folder library plus both layers;
                // the server still clamps against the folder policy.
                await call('initSession', { sessionId: current, cwd: summaryCwd, createLibrary: true })
                await call('setSessionScope', { sessionId: current, useLibrary: true, useGlobal: true })
              }
              decided.current.add(current)
              return
            }
            setPrompt({
              sessionId: current,
              cwd: summaryCwd || '',
              libraries: (st.libraries || []).filter((l) => l.scopeKey !== '__default__'),
              folder: st.folder || null,
              defaultChoice: st.settings?.newSessionDefault || 'both',
            })
            setChoice(st.settings?.newSessionDefault || 'both')
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
            // Persist only choices the dismissed-branch understands; one-off
            // picks like 'existing'/'new' must not become the default policy.
            const preference = { none: 'off', auto: 'auto', both: 'both' }[choice]
            await call('setSettings', {
              patch: preference
                ? { newSessionPromptDismissed: true, newSessionDefault: preference }
                : { newSessionPromptDismissed: true },
            })
          }
          if (choice === 'existing' && libraryId) {
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, libraryId })
          } else if (choice === 'new' && newName.trim()) {
            const lib = await call('createLibrary', { name: newName.trim(), cwd: prompt.cwd })
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, libraryId: lib.id })
          } else if (choice === 'none') {
            // Explicit "no memory": do not create a private library for this
            // conversation, and silence both sources for the session.
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, createLibrary: false })
            await call('setSessionScope', { sessionId: prompt.sessionId, useLibrary: false, useGlobal: false })
          } else if (choice === 'both') {
            // Private and global together: the folder's own library plus the
            // shared layer. The server still clamps against the folder policy.
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, createLibrary: true })
            await call('setSessionScope', { sessionId: prompt.sessionId, useLibrary: true, useGlobal: true })
          } else if (choice === 'global') {
            // Global only: no private library for this conversation at all.
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, createLibrary: false })
            await call('setSessionScope', { sessionId: prompt.sessionId, useLibrary: false, useGlobal: true })
          } else {
            // "auto": create and bind a private library for this folder.
            await call('initSession', { sessionId: prompt.sessionId, cwd: prompt.cwd, createLibrary: true })
          }
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
          h(Button, { key: 'ok', onClick: confirm, disabled: busy || (choice === 'existing' && !libraryId) || (choice === 'new' && !newName.trim()), primary: true }, t('confirm')),
        ],
      },
      h('div', { style: { ...S.muted, lineHeight: 1.6 } }, t('memoryPromptBody')),
      error ? h('div', { style: { color: V.danger, fontSize: 12, marginTop: 8 } }, error) : null,
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
          h('label', { style: S.row }, h('input', { type: 'radio', name: 'memu-choice', checked: choice === 'existing', onChange: () => setChoice('existing') }), t('chooseLibrary')),
          choice === 'existing' ? h('select', { style: { ...S.input, marginLeft: 24 }, value: libraryId, onChange: (e) => setLibraryId(e.target.value) },
            libraries.map((l) => h('option', { key: l.id, value: l.id }, l.name || l.id))) : null,
          h('label', { style: S.row }, h('input', { type: 'radio', name: 'memu-choice', checked: choice === 'new', onChange: () => setChoice('new') }), t('createLibrary')),
          choice === 'new' ? h('input', { style: { ...S.input, marginLeft: 24 }, placeholder: t('name'), value: newName, onChange: (e) => setNewName(e.target.value) }) : null)),
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
          if (!envelope.result) throw new Error('Invalid RPC response: ' + response.status)
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
