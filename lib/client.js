window.__ModuleLoader__.load({
  id: 'dsh-memu-memory',
  factory: (require) => {
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom/client') } catch {}
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'dsh-memu-memory'
    const SETTINGS_PAGES = ['engine', 'connection', 'settings', 'folders', 'libraries', 'browser', 'global', 'prompts', 'stats', 'memories', 'graph', 'logs', 'lexicon', 'help']
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
      settingsUnsaved: '有未保存的设置更改',
      settingsRetry: '重试保存',
      settingsDiscard: '丢弃更改',
      inboundToolNames: '外部消息工具白名单',
      reviewResolution: '复核方式',
      reviewReplace: '替代旧事实',
      reviewCoexist: '按条件并存',
      reviewConditions: '说明不同适用条件（至少 8 字）',
      pageMemories: 'MemU 记忆',
      descMemories: '跨库记忆、来源与状态',
      pageGraph: '关系图谱',
      descGraph: '力导向节点图：拖动即固定、弹簧链跟随',
      graphCenter: '向心力',
      graphPinned: '已固定',
      graphUnpinAll: '解除全部固定',
      graphRelayout: '重新布局',
      graphPinHint: '左键拖动节点 · 右键锁定 / 解除 · Shift 拖整簇',
      graphScopeHint: '拖动只影响所连的簇，其他簇保持不动',
      gsManage: '管理',
      gsSearch: '搜索节点 / 证据…',
      gsRules: '规则筛选',
      gsExport: '导出 PNG',
      gsLegend: '图例',
      gsForce: '力导向参数',
      gsReset: '恢复默认',
      gsCollapse: '折叠 / 展开检视面板',
      gsGrid: '显示网格',
      gsMinimap: '显示缩略图',
      gsHelp: '快捷键',
      gsFocusNode: '聚焦选中节点',
      gsInspector: '检视面板',
      gsInspectorHint: '面板独立滚动 · 不把整页撑成长列表',
      gsNodes: '节点',
      gsEdges: '边',
      gsVisible: '可见',
      gsAutoEdges: '自动边',
      gsPending: '待确认',
      gsRender: '渲染',
      gsEmpty: '当前筛选下没有可显示的边',
      gsAllLibraries: '全部记忆库',
      gsGlobalEmpty: '全部记忆库还没有关联；先在 MemU 记忆里建立关系',
      gsLocate: '图中定位',
      gsNoSelection: '未选中节点',
      gsLocalData: '插件数据',
      gsThemeHint: '跟随宿主主题',
      gsTitle: '标题',
      gsKind: '类型',
      gsStatus: '状态',
      gsLayer: '层级',
      gsConfirmed: '已确认',
      gsNoRules: '当前没有带规则（evidence.rule）的边',
      gsRuleAuto: '旧版自动',
      gsRuleMention: '提及',
      gsRuleConflict: '冲突',
      gsRuleSupersede: '取代',
      gsRuleFactKey: '同键',
      gsRuleWorkerQuote: '引文',
      gsAddNode: '新增节点',
      gsEditNode: '编辑节点',
      gsNodeMemory: '记忆',
      gsNodeEntity: '实体',
      gsRemoveNode: '删除节点',
      gsRemoveNodeHint: '永久删除选中节点：记忆先归档再删除，实体连同其关联边一起删除',
      gsNodeCreated: '已创建「{name}」',
      gsNodeDeleted: '节点已删除',
      gsAddLibrary: '目标记忆库',
      gsDegree: '关联',
      gsStrength: '强度',
      gsAction: '操作',
      gsAllKinds: '全部类型',
      gsAllStatus: '全部状态',
      gsSort: '排序方式',
      gsNoMatch: '没有匹配的节点',
      gsShortcuts: '＋/− 缩放 · F 适应 · / 搜索 · 左键拖动 · 右键锁定/解除 · Shift 整簇 · 双击聚焦',
      gsLegendMemory: '长期记忆',
      gsLegendMust: '永久记忆',
      gsLegendEntity: '已确认实体',
      gsLegendPending: '待确认实体',
      gsLegendGlobal: '全局记忆',
      gsLegendMissing: '已删除',
      gsLegendAuto: '自动边 · 实线',
      gsLegendManual: '手动边 · 虚线',
      gsHideNav: '收起左侧导航',
      gsShowNav: '显示左侧导航',
      gsBranch: '连接分支',
      gsBranchHint: '查看所选节点的邻域、边类型与图中定位',
      gsResize: '拖动调整面板宽度',
      gsTier1: '一级邻域',
      gsTier2: '二级邻域',
      gsViewBranch: '查看分支',
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
      logKindWake: '日期唤醒',
      logClear: '清空日志',
      runLogTitle: '整理记录',
      runLogEmpty: '还没有整理记录。',
      runLogOpen: '全部日志',
      logStateFailed: '失败',
      logStateFailedHint: '这一条是失败或超时：原因见正文。整理超时会自动退避重试，超时前已写入的记忆会保留。',
      logDegraded: '降级',
      logDegradedHint: '没有失败，但走了退路（例如向量未激活、自动关联跳过）。',
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
      entityMergeTitle: '合并候选',
      entityMergeHint: '写法相近的实体只是建议，不会自动合并。合并后来源实体的记忆链接改指主节点，别名并入，来源实体消失；记忆本身不删除。',
      entityMergeAction: '合并',
      entityMergeConfirm: '确认合并',
      entityMergeDone: '已把「{from}」并入「{to}」：{links} 条记忆链接改指，别名共 {aliases} 个',
      entityMergeDropped: '（{n} 个别名超出上限，未并入）',
      entityMergeConflict: '（{n} 条关系快照与主节点侧冲突，保留主节点侧）',
      mergeReasonContainment: '名称包含',
      mergeReasonDistance: '写法相近',
      openMemu: '打开 MemU WebUI',
      openGraphStudio: '打开关系图谱',
      openGraphStudioHint: '在 WebUI 中打开完整关系图谱（浏览器拦下新标签页时在应用内打开）',
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
      visionServiceHint: '独立于主记忆服务的可选图片描述接入，只有开启「允许发送图片到视觉描述服务」时才会调用；下面三项一起保存。',
      captionModel: '视觉模型',
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
      edgeFilterAll: '全部来源',
      edgeFilterAuto: '仅自动',
      edgeFilterManual: '仅手动',
      purgeAutoLinks: '删除全部自动边',
      purgeAutoConfirm: '确认删除自动边',
      purgeAutoDone: '已删除 {n} 条自动边',
      clearSuppression: '解除删除标记',
      clearSuppressionConfirm: '确认解除删除标记',
      clearSuppressionDone: '已解除 {n} 条删除标记',
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
      graphGlobalScope: '全局记忆',
      graphGlobalReadonly: '全局关联在这里是只读视图；要移除边请到全局记忆列表操作。',
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
      settingsTuning: '保存与恢复',
      settingsHeaderNote: '改动即时保存（约 0.25 秒后写盘）；「恢复默认」需两次点击确认。',
      settingsGroupRecall: '召回与注入',
      settingsGroupRecallDesc: '每轮注入什么、注入多少：注入模式、召回条数、token 预算与去重。',
      settingsGroupLifecycle: '记忆生命周期',
      settingsGroupLifecycleDesc: '永久上限、短期保留、未了之事复提与归档清理节奏。',
      settingsGroupCuration: '整理与唤醒',
      settingsGroupCurationDesc: '空闲整理与全局自动提炼的节奏，以及日期到点唤醒。',
      settingsGroupEngine: '引擎与后端',
      settingsGroupEngineDesc: 'MemU 存储模式与引擎自动安装。',
      settingsGroupSession: '会话与界面',
      settingsGroupSessionDesc: '新会话提示、侧边栏设置入口与图片描述。',
      settingsGroupIntegration: '集成',
      settingsGroupIntegrationDesc: '对外暴露的消息工具白名单与视觉描述服务。',
      autoInject: '注入模式',
      privateTopK: '私有 topK',
      globalTopK: '全局 topK',
      crossLibraryRecall: '跨库召回（仅同领域）',
      crossLibraryRecallHint: '开启后，这些读取会合并其它「同领域」私有库：自动召回、memu_private_recall、memu_private_list、侧栏私有列表，以及词典的锚点摘要、本回合匹配与 memu_lexicon_search。\n显式浏览某个库时，仍只显示该库。\n写入不受影响，仍只写当前库；全局词典只有你能写。\n跨库读取改变隔离边界，默认关闭。',
      crossLibraryRecallShort: '同领域私有库合并读取',
      mustRememberCap: '永久记忆软上限',
      shortTermTtlHours: '短期记忆保留（小时，0=关闭）',
      anchorTokens: '锚点 token',
      turnTokens: '召回 token',
      injectionTotalTokens: '注入总 token',
      dedupeTurns: '去重轮数',
      globalEveryNTurns: '全局每 N 轮',
      minUserChars: '最短用户消息',
      randomCueChance: '随机侧事件概率',
      openLoopRemindDays: '未了之事复提间隔（天）',
      freshnessHint: '时效提示',
      freshnessDays: '写够多久算过时（天）',
      freshnessHintHint: '召回里有条目带时间敏感信号时，在块尾提示模型先核实再回答「现在怎样」。',
      salientWake: '日期到点唤醒',
      salientWakeOff: '关闭（只被动注入）',
      salientWakeSchedule: '到点唤醒会话',
      salientWakeHour: '唤醒时间（HH:mm）',
      salientWakeTimeZone: '唤醒时区（留空跟随系统）',
      salientWakeHint: '实验特性，默认关闭：唤醒会替会话开一整轮，由宿主定时任务投递。\n只有宿主进程活着才会触发；任务在宿主的定时任务界面可见、可手动删除。\n还没做过真机验收，建议先在测试库里试开。',
      autoInstall: '自动安装引擎',
      sleepConsolidation: '空闲后整理记忆',
      sleepAfterIdleMinutes: '空闲多久后整理（分钟）',
      autoCurateEveryHours: '全局自动提炼间隔（小时，0=关闭）',
      autoCurateSessionLimit: '每次最多纳入的对话数',
      consolidationModelMode: '整理模型',
      consolidationReasoningEffort: '整理思考强度',
      consolidationReasoningInherit: '跟随当前会话',
      consolidationReasoningOff: '关闭',
      consolidationReasoningLow: '低',
      consolidationReasoningMedium: '中',
      consolidationReasoningHigh: '高',
      consolidationReasoningHint: '只影响后台整理 worker。抽测中 medium 的整理成本最低，通过数不低于 off/high；off 在该路由下仍会产生推理。',
      consolidationRunner: '整理执行器',
      consolidationRunnerFork: '每窗新 fork（默认）',
      consolidationRunnerWorker: '持久 worker（省上下文）',
      consolidationRunnerHint: 'fork 每窗新建一次整理会话，上下文最干净；worker 跨窗复用同一会话，按 200k 字符/16 窗换新，整理 token 约少一半，但会话内上下文会累积。切换从下一窗生效，无需重启。',
      consolidationRunnerExperimental: '实验功能',
      consolidationModeInherit: '继承当前会话',
      consolidationModeHost: '指定宿主模型',
      consolidationModeCustom: '自定义接入点',
      consolidationHostProvider: '宿主 Provider',
      consolidationHostModel: '宿主模型',
      consolidationProviderPick: '选择 provider',
      consolidationModelPick: '选择模型',
      consolidationCatalogLoading: '正在读取宿主模型目录…',
      consolidationCatalogDegraded: '拿不到宿主模型目录（或目录为空），直接按 provider/model 手填。',
      consolidationHostHint: '这里列出的是宿主已配置的 provider/route，整理 fork 直接指名它，不新建连接。',
      consolidationKeyKeep: '已配置，留空保持不变',
      consolidationKeyEmpty: '选填；本地网关可以没有 key',
      consolidationCustomModel: '模型 ID',
      consolidationCustomApiLabel: '线协议',
      consolidationDiscover: '拉取模型列表',
      consolidationDiscoverDone: '拉到 {n} 个模型',
      consolidationDiscoverFailed: '拉取失败',
      consolidationCustomHint: '每次整理前自动注册这个接入点（无需重启），失败自动降级回继承并在日志里说明；API key 只存本地，不进日志。',
      consolidationCustomUnavailable: '这台宿主缺少挂载自定义接入点的能力（llm.registerAdapter 或 PiAiAdapter 不在），改用「指定宿主模型」或「继承当前会话」。',
      curatorModel: '全局整理模型',
      curatorModelHint: '全局记忆提炼用的模型，格式 provider/model，留空跟随当前会话；与上面的私有整理模型是两条路。',
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
      arousalLabel: '激活',
      dominanceLabel: '掌控',
      emotionSourceLabel: '来源',
      emotionSourceModel: '模型标注',
      emotionSourceSession: '会话心情',
      emotionSourceContent: '正文识别',
      emotionSourceUnknown: '未知',
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
      managedVectorRuntimeSource: '运行时下载源',
      managedVectorRuntimeSourceHint: '下载中请先停止再切换源；已下载的字节会保留，并从新源续传。每个制品仍要过目录里 pin 住的 sha256。',
      managedVectorPause: '暂停',
      managedVectorStop: '停止',
      managedVectorResume: '继续下载',
      managedVectorPaused: '已暂停',
      managedVectorStopped: '已停止',
      managedVectorSpeed: '速度',
      managedVectorRuntimeTitle: '运行环境',
      managedVectorModelsTitle: '模型',
      managedVectorSource: '下载来源',
      managedVectorSourceHint: '同一个固定 commit 的同一批文件；换来源不改向量空间——每个文件都要过目录里 pin 住的 sha256。',
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
      browseSearch: '搜索本库',
      browseSearchPlaceholder: '按标题、正文、ID 或标签过滤当前记忆库…',
      browseSearchClear: '清空',
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
      consolidateNow: '手动整理',
      consolidateHint: '为本库绑定的对话发起整理（与侧边栏同一通道，每次最多 5 个，正在整理的会跳过）。整理会产生模型调用成本。',
      consolidateNone: '该库没有可整理的绑定对话',
      consolidateDone: '已发起整理 {started} 个对话（正在整理 {running}，失败 {failed}）{rest}',
      consolidateRest: '，还有 {n} 个可再点一次',
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
      descLexicon: '每个记忆库一本词典，另加一本全局词典：黑话、梗、触发词与术语的释义、归档与命中统计。',
      lexiconScope: '词条管理',
      lexiconNoLibrary: '还没有记忆库；词典随私有记忆库创建，全局词典现在就能用。',
      lexiconGlobalScope: '全局词典',
      lexiconGlobalHint: '全局词典与全局记忆同构：每个会话都读得到它（锚点摘要、本回合匹配、memu_lexicon_search），但只有你能写——模型与整理链路只写各自的私有记忆库。没写领域的词条不分领域都可见。',
      lexiconBrowseScopeHint: '这里选的是「正在看哪一本」：只列该库（或全局词典）自己的词条。注入与模型检索按召回作用域合并——当前库 + 全局词典，开了「跨库召回」再加上同领域的其它库（见记忆设置页）。',
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
      // —— 自动关联：待确认实体（DESIGN §9.2/§10）——
      anchorReviewTitle: '待确认实体',
      anchorReviewHint: '统计只用来排候选，不会自动写边。只有你确认过的名字，才会把已有记忆里的提及连到它。',
      anchorTier1: '有证据的候选',
      anchorTier2: '仅统计特征（需复核）',
      anchorConfirm: '确认',
      anchorConfirmSelected: '确认选中（{n}）',
      anchorPendingEntity: '待确认',
      anchorExistingEntity: '已有实体',
      anchorArchivedEntity: '已归档',
      anchorNoCandidates: '没有新的候选。',
      anchorCreateHint: '确认后会建成实体，并立即给已有记忆补挂提及边。',
      anchorKindHint: '类型随确认一起定下，之后不能修改。',
      anchorConfirmedDone: '已确认 {n} 个实体，提及边已补挂。',
      anchorSignalQuote: '引号',
      anchorSignalIntro: '引导语',
      anchorSignalMixed: '标识符',
      anchorStats: 'df {df} · 凝聚 {cohesion} · 边界 {freedom}',
      autoLinkMode: '自动关联',
      autoLinkSuggest: '只出候选（推荐）',
      autoLinkDeterministic: '确定性写边',
      autoLinkOff: '关闭',
      autoLinkHint: '“只出候选”不会写任何边；“确定性写边”只写两类边：已确认实体的提及，以及 conflicts_with / supersedes / 同 fact_key 的字段证据。词面相似度与向量永远不建边。',
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
      helpFaq11: '对话里为什么会主动提「那个日子已经过了」或「这条可能过时了」？',
      helpFaq11A: '三种情况都来自记忆本身，不是模型即兴：① 带 `YYYY-MM-DD` 的未了之事过期后，会按「未了之事复提间隔」（默认 7 天）重新提一次，同一天不重复，也没日期的承诺仍是提过一次就安静；② 召回里有时效信号的条目（日期已过、标题带「最新/价格/版本」这类词、或写得够久）会让注入块尾多一行提示，让模型在会话有搜索工具时先核实——它不声称工具一定存在；③「日期到点唤醒」是**实验特性**且默认关闭，打开后宿主会在日子当天用定时任务让会话开一轮，那种回合不跑常规召回，所以只带着那条日期说话。三者都只是提示：不自动写记忆、不自动关闭约定，也不自动删除任何东西。',
      helpFeedback: '反馈',
      helpOpenIssue: '提交 Issue',
      helpCopyDiagnostics: '复制诊断信息',
      helpDocs: '打开文档',
    }

    const en = {
      settingsUnsaved: 'Unsaved settings changes',
      settingsRetry: 'Retry save',
      settingsDiscard: 'Discard changes',
      inboundToolNames: 'External message tool allowlist',
      reviewResolution: 'Resolution',
      reviewReplace: 'Replace the old fact',
      reviewCoexist: 'Coexist under distinct conditions',
      reviewConditions: 'Explain distinct conditions (at least 8 characters)',
      pageMemories: 'MemU Memory',
      descMemories: 'Memories, provenance and status across libraries',
      pageGraph: 'Relationship graph',
      descGraph: 'Force graph: drag to pin, spring-chain follow',
      graphCenter: 'Center force',
      graphPinned: 'Pinned',
      graphUnpinAll: 'Unpin all',
      graphRelayout: 'Re-layout',
      graphPinHint: 'Left-drag a node · right-click locks / unlocks · Shift drags the cluster',
      graphScopeHint: 'Dragging only moves the connected cluster',
      gsManage: 'Manage',
      gsSearch: 'Search nodes / evidence…',
      gsRules: 'Rule filter',
      gsExport: 'Export PNG',
      gsLegend: 'Legend',
      gsForce: 'Force parameters',
      gsReset: 'Reset',
      gsCollapse: 'Toggle inspector',
      gsGrid: 'Show grid',
      gsMinimap: 'Show minimap',
      gsHelp: 'Shortcuts',
      gsFocusNode: 'Focus selected',
      gsInspector: 'Inspector',
      gsInspectorHint: 'Scrolls on its own · the page never becomes one long list',
      gsNodes: 'Nodes',
      gsEdges: 'Edges',
      gsVisible: 'Visible',
      gsAutoEdges: 'Auto edges',
      gsPending: 'Pending',
      gsRender: 'Render',
      gsEmpty: 'No edges match the current filter',
      gsAllLibraries: 'All libraries',
      gsGlobalEmpty: 'No links across all libraries yet; create relations in MemU memory first',
      gsLocate: 'Locate',
      gsNoSelection: 'No node selected',
      gsLocalData: 'Plugin data',
      gsThemeHint: 'Follows host theme',
      gsTitle: 'Title',
      gsKind: 'Kind',
      gsStatus: 'Status',
      gsLayer: 'Layer',
      gsConfirmed: 'Confirmed',
      gsNoRules: 'No edges carry evidence.rule yet',
      gsRuleAuto: 'Legacy auto',
      gsRuleMention: 'Mention',
      gsRuleConflict: 'Conflict',
      gsRuleSupersede: 'Superseded',
      gsRuleFactKey: 'Fact key',
      gsRuleWorkerQuote: 'Worker quote',
      gsAddNode: 'Add node',
      gsEditNode: 'Edit node',
      gsNodeMemory: 'Memory',
      gsNodeEntity: 'Entity',
      gsRemoveNode: 'Delete node',
      gsRemoveNodeHint: 'Permanently delete the selected node: memories are archived then deleted, entities are removed with their links',
      gsNodeCreated: 'Created "{name}"',
      gsNodeDeleted: 'Node deleted',
      gsAddLibrary: 'Target library',
      gsDegree: 'Links',
      gsStrength: 'Strength',
      gsAction: 'Action',
      gsAllKinds: 'All kinds',
      gsAllStatus: 'All statuses',
      gsSort: 'Sort by',
      gsNoMatch: 'No matching nodes',
      gsShortcuts: '+/- zoom · F fit · / search · left-drag moves · right-click locks/unlocks · Shift cluster · double-click focus',
      gsLegendMemory: 'Long-term memory',
      gsLegendMust: 'Must remember',
      gsLegendEntity: 'Confirmed entity',
      gsLegendPending: 'Provisional entity',
      gsLegendGlobal: 'Global memory',
      gsLegendMissing: 'Deleted',
      gsLegendAuto: 'Auto edge · solid',
      gsLegendManual: 'Manual edge · dashed',
      gsHideNav: 'Hide left nav',
      gsShowNav: 'Show left nav',
      gsBranch: 'Connected branch',
      gsBranchHint: 'Inspect neighbourhood, edge kinds and locate on canvas',
      gsResize: 'Drag to resize the panel',
      gsTier1: 'Direct neighbours',
      gsTier2: 'Second-degree neighbours',
      gsViewBranch: 'View branch',
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
      logKindWake: 'Date wake',
      logClear: 'Clear log',
      runLogTitle: 'Runs',
      runLogEmpty: 'No runs recorded yet.',
      runLogOpen: 'All logs',
      logStateFailed: 'Failed',
      logStateFailedHint: 'This row failed or timed out; the reason is in the message. Timed-out consolidation retries itself with backoff, and memories written before the timeout are kept.',
      logDegraded: 'Degraded',
      logDegradedHint: 'Not a failure — a fallback path was taken (e.g. no active vector generation, auto-link skipped).',
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
      entityMergeTitle: 'Merge candidates',
      entityMergeHint: 'Similar spellings are only suggestions and are never merged automatically. Merging redirects the source entity memory links to the main node, folds its aliases in, and drops the source entity; memories themselves are never deleted.',
      entityMergeAction: 'Merge',
      entityMergeConfirm: 'Confirm merge',
      entityMergeDone: 'Merged "{from}" into "{to}": {links} memory links redirected, {aliases} aliases in total',
      entityMergeDropped: '({n} aliases over the cap were not folded in)',
      entityMergeConflict: '({n} relationship snapshots clashed with the target side and were dropped)',
      mergeReasonContainment: 'Name contained',
      mergeReasonDistance: 'Similar spelling',
      openMemu: 'Open MemU WebUI',
      openGraphStudio: 'Open relationship graph',
      openGraphStudioHint: 'Open the full relationship graph in the WebUI (opens in-app when the browser blocks a new tab)',
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
      visionServiceHint: 'Optional caption endpoint, independent of the memory service. It is only called when "Allow sending images to the vision description service" is on; the three fields save together.',
      captionModel: 'Vision model',
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
      edgeFilterAll: 'All sources',
      edgeFilterAuto: 'Auto only',
      edgeFilterManual: 'Manual only',
      purgeAutoLinks: 'Remove all auto edges',
      purgeAutoConfirm: 'Confirm removing auto edges',
      purgeAutoDone: 'Removed {n} auto edge(s)',
      clearSuppression: 'Clear deletion markers',
      clearSuppressionConfirm: 'Confirm clearing deletion markers',
      clearSuppressionDone: 'Cleared {n} deletion marker(s)',
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
      graphGlobalScope: 'Global memory',
      graphGlobalReadonly: 'Global links are read-only here; remove an edge from the global memory list.',
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
      settingsTuning: 'Saving & reset',
      settingsHeaderNote: 'Edits save themselves about 0.25s after each change; Reset defaults asks for a second click.',
      settingsGroupRecall: 'Recall & injection',
      settingsGroupRecallDesc: 'What each turn injects and how much: injection mode, topK, token budgets, dedupe.',
      settingsGroupLifecycle: 'Memory lifecycle',
      settingsGroupLifecycleDesc: 'Permanent cap, short-term retention, open-loop reminders and archive cleanup.',
      settingsGroupCuration: 'Curation & wake',
      settingsGroupCurationDesc: 'Idle consolidation and global auto-curation cadence, plus salient-date wake.',
      settingsGroupEngine: 'Engine & backend',
      settingsGroupEngineDesc: 'MemU storage mode and engine auto-install.',
      settingsGroupSession: 'Session & interface',
      settingsGroupSessionDesc: 'New-session prompt, sidebar settings entry and image captioning.',
      settingsGroupIntegration: 'Integration',
      settingsGroupIntegrationDesc: 'External message tool allowlist and the vision caption service.',
      autoInject: 'Injection mode',
      privateTopK: 'Private topK',
      globalTopK: 'Global topK',
      crossLibraryRecall: 'Cross-library recall (same domain)',
      crossLibraryRecallHint: 'When on, these reads merge other same-domain private libraries: automatic recall, memu_private_recall, memu_private_list, the sidebar private list, plus the lexicon anchor summaries, this-turn matching and memu_lexicon_search.\nExplicitly browsing a library still shows that library only.\nWrites are unaffected and still go to the current library; the global lexicon stays yours alone to write.\nReading across libraries changes the isolation boundary, so this is off by default.',
      crossLibraryRecallShort: 'Merge same-domain reads',
      mustRememberCap: 'Permanent memory cap',
      shortTermTtlHours: 'Short-term TTL in hours (0=off)',
      anchorTokens: 'Anchor tokens',
      turnTokens: 'Recall tokens',
      injectionTotalTokens: 'Injection total tokens',
      dedupeTurns: 'Dedupe turns',
      globalEveryNTurns: 'Global every N turns',
      minUserChars: 'Min user chars',
      randomCueChance: 'Random cue chance',
      openLoopRemindDays: 'Re-remind open loops every N days',
      freshnessHint: 'Freshness hint',
      freshnessDays: 'Age treated as stale (days)',
      freshnessHintHint: 'When recalled entries carry time-sensitive signals, add one line telling the model to verify before answering about the present.',
      salientWake: 'Wake on salient dates',
      salientWakeOff: 'Off (passive injection only)',
      salientWakeSchedule: 'Wake the conversation',
      salientWakeHour: 'Wake time (HH:mm)',
      salientWakeTimeZone: 'Wake time zone (empty = system)',
      salientWakeHint: 'Experimental and off by default: a wake opens a full turn for the conversation, delivered by the host scheduler.\nIt only fires while the host process is alive; tasks stay visible (and deletable) in the host schedule UI.\nNot yet verified on a real install — try it on a test library first.',
      autoInstall: 'Auto-install engine',
      sleepConsolidation: 'Consolidate after idle',
      sleepAfterIdleMinutes: 'Idle minutes before consolidating',
      autoCurateEveryHours: 'Auto global curation every N hours (0=off)',
      autoCurateSessionLimit: 'Max conversations per auto run',
      consolidationModelMode: 'Consolidation model',
      consolidationReasoningEffort: 'Consolidation reasoning effort',
      consolidationReasoningInherit: 'Inherit the conversation',
      consolidationReasoningOff: 'Off',
      consolidationReasoningLow: 'Low',
      consolidationReasoningMedium: 'Medium',
      consolidationReasoningHigh: 'High',
      consolidationReasoningHint: 'Only affects the background consolidation worker. In the sampled run, medium had the lowest consolidation cost and no fewer passes than off/high; off still produced reasoning on this route.',
      consolidationRunner: 'Consolidation runner',
      consolidationRunnerFork: 'Fresh fork per window (default)',
      consolidationRunnerWorker: 'Persistent worker (less context)',
      consolidationRunnerHint: 'fork starts a new consolidation session every window (cleanest context); worker reuses one session across windows and rotates every 200k chars / 16 windows — roughly half the consolidation tokens, at the cost of accumulating context inside the session. Applies from the next window; no restart needed.',
      consolidationRunnerExperimental: 'Experimental',
      consolidationModeInherit: 'Inherit the conversation',
      consolidationModeHost: 'Pick a host model',
      consolidationModeCustom: 'Custom endpoint',
      consolidationHostProvider: 'Host provider',
      consolidationHostModel: 'Host model',
      consolidationProviderPick: 'Pick a provider',
      consolidationModelPick: 'Pick a model',
      consolidationCatalogLoading: 'Loading the host model catalog…',
      consolidationCatalogDegraded: 'Host catalog unavailable (or empty) — type provider/model directly.',
      consolidationHostHint: 'These are the providers/routes the host already configured; the consolidation fork names one of them directly, no new connection.',
      consolidationKeyKeep: 'Configured; leave blank to keep',
      consolidationKeyEmpty: 'Optional; local gateways may run without a key',
      consolidationCustomModel: 'Model ID',
      consolidationCustomApiLabel: 'Wire protocol',
      consolidationDiscover: 'Fetch model list',
      consolidationDiscoverDone: 'Found {n} models',
      consolidationDiscoverFailed: 'Fetch failed',
      consolidationCustomHint: 'The endpoint is re-registered before every consolidation (no restart needed); on failure the fork falls back to inherit with a log line. The API key stays on this machine and never enters logs.',
      consolidationCustomUnavailable: 'This host cannot mount a custom endpoint (llm.registerAdapter or PiAiAdapter missing); use "Pick a host model" or "Inherit the conversation".',
      curatorModel: 'Global curator model',
      curatorModelHint: 'Model for global memory curation, format provider/model; empty follows the current conversation — a separate path from the private consolidation model above.',
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
      arousalLabel: 'arousal',
      dominanceLabel: 'dominance',
      emotionSourceLabel: 'source',
      emotionSourceModel: 'model',
      emotionSourceSession: 'session',
      emotionSourceContent: 'content',
      emotionSourceUnknown: 'unknown',
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
      managedVectorRuntimeSource: 'Runtime download source',
      managedVectorRuntimeSourceHint: 'Stop the download before switching source; downloaded bytes are kept and resumed from the new source. Every artifact still has to match the pinned sha256.',
      managedVectorPause: 'Pause',
      managedVectorStop: 'Stop',
      managedVectorResume: 'Resume download',
      managedVectorPaused: 'Paused',
      managedVectorStopped: 'Stopped',
      managedVectorSpeed: 'Speed',
      managedVectorRuntimeTitle: 'Runtime',
      managedVectorSource: 'Download source',
      managedVectorSourceHint: 'The same files from one pinned commit. Switching source does not change the vector space: every file is verified against the sha256 pinned in the catalog.',
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
      browseSearch: 'Search this library',
      browseSearchPlaceholder: 'Filter the current library by title, body, id or tags…',
      browseSearchClear: 'Clear',
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
      consolidateNow: 'Consolidate now',
      consolidateHint: 'Start consolidation for conversations bound to this library (same channel as the sidebar; up to 5 per click, ones already running are skipped). Consolidation costs model calls.',
      consolidateNone: 'No bound conversations to consolidate in this library',
      consolidateDone: 'Started {started} conversations ({running} already running, {failed} failed){rest}',
      consolidateRest: ' — {n} more, click again',
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
      descLexicon: 'One lexicon per memory library plus a global one: slang, memes, triggers and terms with meanings, archive and hit counts.',
      lexiconScope: 'Terms',
      lexiconNoLibrary: 'No memory libraries yet; a lexicon comes with each private library. The global lexicon is already usable.',
      lexiconGlobalScope: 'Global lexicon',
      lexiconGlobalHint: 'The global lexicon mirrors global memory: every conversation reads it (anchor summary, this-turn match, memu_lexicon_search), but only you write it — the model and consolidation only ever write their own private library. Terms without a domain are visible in every domain.',
      lexiconBrowseScopeHint: 'This picker answers "which book am I reading": it lists only that library (or the global lexicon). Injection and the model search merge by recall scope — bound library + global lexicon, plus same-domain libraries when cross-library recall is on (see Memory settings).',
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
      // —— Auto-link: entities awaiting confirmation (DESIGN §9.2/§10) ——
      anchorReviewTitle: 'Entities to confirm',
      anchorReviewHint: 'Statistics only rank the queue and never write edges. Only a name you confirm gets its existing memories connected.',
      anchorTier1: 'Evidenced candidates',
      anchorTier2: 'Statistical only (needs review)',
      anchorConfirm: 'Confirm',
      anchorConfirmSelected: 'Confirm selected ({n})',
      anchorPendingEntity: 'Pending',
      anchorExistingEntity: 'Existing entity',
      anchorArchivedEntity: 'Archived',
      anchorNoCandidates: 'No new candidates.',
      anchorCreateHint: 'Confirming creates the entity and immediately attaches mention edges to existing memories.',
      anchorKindHint: 'The kind is fixed at confirmation time and cannot be changed later.',
      anchorConfirmedDone: 'Confirmed {n} entit(ies); mention edges are attached.',
      anchorSignalQuote: 'Quoted',
      anchorSignalIntro: 'Name intro',
      anchorSignalMixed: 'Identifier',
      anchorStats: 'df {df} · cohesion {cohesion} · boundary {freedom}',
      autoLinkMode: 'Auto-linking',
      autoLinkSuggest: 'Candidates only (recommended)',
      autoLinkDeterministic: 'Deterministic edges',
      autoLinkOff: 'Off',
      autoLinkHint: '"Candidates only" writes no edges. "Deterministic edges" writes exactly two kinds: mentions of confirmed entities, and field evidence from conflicts_with / supersedes / the same fact_key. Lexical similarity and vectors never create an edge.',
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
      helpFaq11: 'Why does the conversation bring up "that date already passed" or "this may be out of date"?',
      helpFaq11A: 'All three cases come from the memories themselves, not the model improvising: (1) an open loop whose `YYYY-MM-DD` has passed is raised again on the "re-remind every N days" cadence (default 7), never twice on one day, while undated promises stay quiet after their first mention; (2) recalled entries with time-sensitive signals (a past date, wording like "latest / price / version", or enough age) append one line to the recall block telling the model to verify first if the conversation has a search tool — it never claims the tool exists; (3) date wake-up is an experimental switch and off by default: with it enabled the host scheduler opens a turn on the day itself, and that turn runs no normal recall, so it only carries that date. All three are hints: nothing is written automatically, no commitment is closed automatically, nothing is deleted.',
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
      danger: 'var(--dsw-alias-state-error-primary, #c0392b)',
      warn: 'var(--dsw-alias-state-warn-label, #b7791f)',
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
.dshm-root .dshm-page .dshm-card{border-radius:16px}
.dshm-card-head,.dshm-card-actions{flex-wrap:wrap}
.dshm-card-head>div:not([class]){flex:1 1 180px!important;min-width:120px}
.dshm-card-actions{max-width:100%}
.dshm-card-actions>div{flex-wrap:wrap;max-width:100%}
.dshm-card-head{display:flex;flex-wrap:wrap}
.dshm-root .dshm-btn{white-space:normal;overflow-wrap:anywhere;border-radius:4px!important}
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
.dshm-drawer-backdrop{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:rgba(10,14,22,.38);animation:dshm-fade-in .2s ease both}
.dshm-drawer{width:min(480px,100%);height:100%;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:22px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);border-left:1px solid var(--dsw-alias-border-l1,#ddd);box-shadow:-24px 0 60px -34px rgba(0,0,0,.45);animation:dshm-drawer-in .3s cubic-bezier(.22,1,.36,1) backwards}
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
.dshm-root .dshm-brand-tile{background:transparent;box-shadow:none}
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
.dshm-graph-unlink:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b43e45) 10%,transparent);color:var(--dsw-alias-state-error-primary,#b43e45)}
.dshm-graph-unlink.is-armed{width:auto;padding:0 8px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#b43e45);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b43e45) 12%,transparent)}
@media (max-width:1100px){.dshm-graph-stage{grid-template-columns:minmax(0,1fr)}}
.dshm-graph-missing{opacity:.5}
/* Graph Studio 工作台：按 graph-studio/index.html 的界面逐块复刻，尺寸按 WebUI 收敛，
   颜色全部走 --dsw-alias-* token，自动跟随宿主明暗。画布本身仍由 graph-view.js 绘制。 */
.dshm-gs{--gs-panel:var(--dsw-alias-bg-layer-1,#fff);--gs-panel-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));--gs-border:var(--dsw-alias-border-l1,rgba(127,127,127,.20));--gs-border-soft:var(--dsw-alias-border-l2,rgba(127,127,127,.10));--gs-text:var(--dsw-alias-label-primary,#1a1e2b);--gs-dim:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));--gs-faint:var(--dsw-alias-label-secondary,rgba(127,127,127,.65));--gs-accent:var(--dsw-alias-brand-primary,#3b5bdb);--gs-on-accent:var(--dsw-alias-brand-text,#fff);--gs-accent-soft:color-mix(in srgb,var(--gs-accent) 12%,transparent);--gs-radius:12px;--gs-radius-sm:8px;--gs-shadow:0 12px 32px rgba(20,30,60,.16);--gs-shadow-sm:0 3px 12px rgba(20,30,60,.12);
  display:grid;grid-template-columns:46px minmax(0,1fr) 344px;grid-template-rows:50px minmax(0,1fr) 28px;
  height:clamp(520px,calc(100vh - 210px),860px);min-height:420px;position:relative;overflow:hidden;
  border:1px solid var(--gs-border);border-radius:var(--gs-radius);background:var(--dsw-alias-bg-base,transparent);
  color:var(--gs-text);font-size:12px;line-height:1.5}
.dshm-gs *{box-sizing:border-box;min-width:0}
.dshm-gs button,.dshm-gs input,.dshm-gs select{font:inherit;color:inherit}
.dshm-gs button{cursor:pointer}
.dshm-gs.is-collapsed{grid-template-columns:46px minmax(0,1fr) 0}
.dshm-gs.is-collapsed .dshm-gs-inspector{display:none}
.dshm-gs.is-manage{grid-template-columns:0 minmax(0,1fr) 0}
.dshm-gs.is-manage .dshm-gs-rail,.dshm-gs.is-manage .dshm-gs-stage,.dshm-gs.is-manage .dshm-gs-inspector,.dshm-gs.is-manage .dshm-gs-popwrap,.dshm-gs.is-manage .dshm-gs-themechip,.dshm-gs.is-manage .dshm-gs-icon{display:none!important}
.dshm-gs.is-manage .dshm-gs-manager{display:flex}
.dshm-gs-c-memory{background:#618fcd}.dshm-gs-c-must{background:#d97768}.dshm-gs-c-short{background:#8a93a6}
.dshm-gs-c-entity{background:#36a582}.dshm-gs-c-provisional{background:#b9963f}.dshm-gs-c-global{background:#8b7bd8}.dshm-gs-c-missing{background:#92959c}
/* topbar */
.dshm-gs-topbar{grid-column:1/-1;grid-row:1;display:flex;align-items:center;gap:9px;padding:0 12px;border-bottom:1px solid var(--gs-border);background:var(--gs-panel);z-index:20;min-width:0}
.dshm-gs-brand{display:flex;align-items:center;gap:9px;flex-shrink:0}
.dshm-gs-mark{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(140deg,var(--gs-accent),color-mix(in srgb,var(--gs-accent) 55%,#8b7bd8));color:var(--gs-on-accent);font-weight:750;font-size:14px;box-shadow:var(--gs-shadow-sm)}
.dshm-gs-brand-txt strong{display:block;font-size:12.5px;font-weight:680;line-height:1.15;white-space:nowrap}
.dshm-gs-brand-txt small{display:block;color:var(--gs-faint);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase}
.dshm-gs-divider{width:1px;height:20px;background:var(--gs-border);flex-shrink:0}
.dshm-gs-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--gs-border);border-radius:999px;background:var(--gs-panel-2);flex-shrink:0}
.dshm-gs-seg button{border:0;background:transparent;color:var(--gs-dim);font-size:11px;padding:3px 10px;border-radius:999px;white-space:nowrap;transition:.18s}
.dshm-gs-seg button[aria-pressed=true]{background:var(--gs-accent);color:var(--gs-on-accent);font-weight:600}
.dshm-gs-field{height:29px;padding:0 9px;border:1px solid var(--gs-border);background:var(--gs-panel-2);border-radius:var(--gs-radius-sm);outline:none;font-size:11.5px;max-width:100%}
.dshm-gs-field:focus{border-color:var(--gs-accent);box-shadow:0 0 0 3px var(--gs-accent-soft)}
.dshm-gs-search{position:relative;flex:1 1 160px;max-width:260px;min-width:90px}
/* standalone.css 会给外壳输入框统一 padding/height；工作台的紧凑控件必须用更高
   特异性拉回自己的尺寸，否则搜索图标会压住文字、顶栏控件高度也不齐。 */
.dshm-gs-search .dshm-gs-field{width:100%;padding-left:28px!important}
.dshm-gs-search-icon{position:absolute;left:9px;top:0;bottom:0;display:flex;align-items:center;font-size:14px;line-height:1;color:var(--gs-faint);pointer-events:none}
html[data-standalone] .dshm-root .dshm-gs .dshm-gs-topbar input.dshm-gs-field,
html[data-standalone] .dshm-root .dshm-gs .dshm-gs-topbar select.dshm-gs-field,
html[data-standalone] .dshm-root .dshm-gs .dshm-gs-mgr-head select.dshm-gs-field{height:29px!important;padding:0 9px!important;border-radius:var(--gs-radius-sm)!important;font-size:11.5px!important;background:var(--gs-panel-2)!important;border-color:var(--gs-border)!important}
html[data-standalone] .dshm-root .dshm-gs .dshm-gs-search input.dshm-gs-field{padding:0 9px 0 28px!important}
html[data-standalone] .dshm-root .dshm-gs .dshm-gs-forcepop input[type=range]{height:auto!important;padding:0!important;border:0!important;background:transparent!important}
.dshm-gs-spacer{flex:1 1 auto}
.dshm-gs-btn{height:29px;padding:0 11px;border:1px solid var(--gs-border);border-radius:var(--gs-radius-sm);background:var(--gs-panel-2);font-size:11.5px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:.18s}
.dshm-gs-btn:hover{border-color:var(--gs-accent);color:var(--gs-accent)}
.dshm-gs-btn.primary{background:var(--gs-accent);border-color:transparent;color:var(--gs-on-accent);font-weight:600}
.dshm-gs-btn.icon{width:29px;padding:0;justify-content:center;font-size:14px}
.dshm-gs-btn:disabled{opacity:.45;cursor:not-allowed}
.dshm-gs-count{font-size:10px;color:var(--gs-dim);font-variant-numeric:tabular-nums}
.dshm-gs-popwrap,.dshm-gs-legendwrap{position:relative;flex-shrink:0}
.dshm-gs-pop,.dshm-gs-legendpop{position:absolute;top:38px;right:0;width:230px;padding:11px;border:1px solid var(--gs-border);border-radius:var(--gs-radius);background:var(--gs-panel);box-shadow:var(--gs-shadow);z-index:60}
.dshm-gs-pop h4,.dshm-gs-legendpop h4{margin:0 0 8px;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--gs-faint);font-weight:650}
.dshm-gs-pop label{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:11.5px;color:var(--gs-dim);cursor:pointer}
.dshm-gs-pop input{accent-color:var(--gs-accent)}
.dshm-gs-themechip{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 10px;border:1px solid var(--gs-border);border-radius:999px;background:var(--gs-panel-2);font-size:11px;color:var(--gs-dim);white-space:nowrap}
.dshm-gs-dot{width:8px;height:8px;border-radius:50%;background:var(--gs-accent)}
/* rail */
.dshm-gs-rail{grid-column:1;grid-row:2;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;border-right:1px solid var(--gs-border);background:var(--gs-panel-2);z-index:10}
.dshm-gs-rail button{width:30px;height:30px;border:1px solid transparent;border-radius:var(--gs-radius-sm);background:transparent;color:var(--gs-dim);display:grid;place-items:center;font-size:14px;transition:.18s}
.dshm-gs-rail button:hover{background:var(--gs-accent-soft);color:var(--gs-accent);border-color:var(--gs-border)}
.dshm-gs-rail button[aria-pressed=true]{background:var(--gs-accent-soft);color:var(--gs-accent);border-color:var(--gs-accent)}
.dshm-gs-rail-sep{width:20px;height:1px;background:var(--gs-border);margin:2px 0}
.dshm-gs-rail-grow{flex:1}
/* stage */
.dshm-gs-stage{grid-column:2;grid-row:2;position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--gs-panel)}
.dshm-gs-stage .dshm-graph-viewport{position:absolute;inset:0;border:0;border-radius:0;background:transparent}
.dshm-gs-stage .dshm-graph-canvas{width:100%;height:100%;max-height:none;min-height:0}
.dshm-gs-canvas-tools{position:absolute;left:12px;bottom:12px;display:flex;align-items:flex-end;gap:8px;z-index:8}
.dshm-gs-zoombar{display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--gs-border);background:var(--gs-panel);border-radius:10px;box-shadow:var(--gs-shadow-sm);opacity:.72}
.dshm-gs-canvas-tools:hover .dshm-gs-zoombar,.dshm-gs-zoombar:focus-within{opacity:1}
.dshm-gs-zoombar button{width:24px;height:24px;border:0;background:transparent;color:var(--gs-dim);border-radius:7px;font-size:13px;display:grid;place-items:center}
.dshm-gs-zoombar button:hover{background:var(--gs-accent-soft);color:var(--gs-accent)}
.dshm-gs-zoomval{min-width:40px;text-align:center;font-size:10.5px;color:var(--gs-dim);font-variant-numeric:tabular-nums}
.dshm-gs-legendbtn{border:1px solid var(--gs-border);background:var(--gs-panel);color:var(--gs-dim);font-size:11px;padding:5px 9px;border-radius:9px;box-shadow:var(--gs-shadow-sm);opacity:.72}
.dshm-gs-legendbtn:hover,.dshm-gs-canvas-tools:hover .dshm-gs-legendbtn{opacity:1;color:var(--gs-accent)}
.dshm-gs-legendpop{bottom:calc(100% + 8px);left:0;top:auto;right:auto;width:210px;padding:10px 12px}
.dshm-gs-legend-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--gs-dim);padding:2px 0}
.dshm-gs-swatch{width:9px;height:9px;border-radius:50%;flex-shrink:0;display:inline-block}
.dshm-gs-line{width:16px;height:0;border-top:2px solid var(--gs-accent);flex-shrink:0}
.dshm-gs-line.dashed{border-top-style:dashed;border-color:var(--gs-faint)}
.dshm-gs-minimap{position:absolute;right:12px;bottom:12px;padding:7px;border:1px solid var(--gs-border);background:var(--gs-panel);border-radius:var(--gs-radius);box-shadow:var(--gs-shadow-sm);z-index:6}
.dshm-gs-minimap h4{margin:0 0 5px;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gs-faint)}
.dshm-gs-minimap canvas{display:block;width:158px;height:104px;border-radius:6px}
.dshm-gs-rail-slot{position:relative;display:flex;flex:none}
.dshm-gs-forcepop{position:absolute;left:calc(100% + 8px);top:-6px;width:226px;padding:11px;border:1px solid var(--gs-border);border-radius:var(--gs-radius);background:var(--gs-panel);box-shadow:var(--gs-shadow);z-index:40}
.dshm-gs-forcepop h4{margin:0 0 6px;font-size:11px;font-weight:650}
.dshm-gs-forcepop label{display:grid;grid-template-columns:56px 1fr 36px;align-items:center;gap:7px;padding:5px 0;font-size:11px;color:var(--gs-dim)}
.dshm-gs-forcepop input[type=range]{width:100%;accent-color:var(--gs-accent);margin:0}
.dshm-gs-forcepop output{font-size:10px;text-align:right;color:var(--gs-dim);font-variant-numeric:tabular-nums}
.dshm-gs-forcepop-toggles{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;padding-top:8px;border-top:1px solid var(--gs-border-soft)}
.dshm-gs-mini{height:26px;padding:0 10px;font-size:11.5px;border-radius:7px;border:1px solid var(--gs-border);background:var(--gs-panel);white-space:nowrap;margin-top:8px}
.dshm-gs-mini:hover{border-color:var(--gs-accent);color:var(--gs-accent)}
.dshm-gs-forcepop .dshm-gs-mini{margin-top:9px}
.dshm-gs-toast{position:absolute;left:50%;bottom:22px;transform:translate(-50%,10px);z-index:40;padding:8px 14px;border-radius:999px;background:var(--gs-text);color:var(--gs-panel);font-size:11.5px;box-shadow:var(--gs-shadow);opacity:0;transition:.25s;pointer-events:none;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-gs-toast.show{opacity:1;transform:translate(-50%,0)}
.dshm-gs-empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--gs-dim);font-size:12px;pointer-events:none}
/* inspector */
.dshm-gs-inspector{grid-column:3;grid-row:2;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--gs-border);background:var(--gs-panel);z-index:10}
.dshm-gs-ins-head{flex-shrink:0;padding:12px 14px 9px;border-bottom:1px solid var(--gs-border-soft)}
.dshm-gs-ins-title{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshm-gs-ins-title h2{margin:0;font-size:12.5px;font-weight:680}
.dshm-gs-ins-head p{margin:3px 0 0;font-size:10.5px;color:var(--gs-dim)}
.dshm-gs-ins-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 20px;display:flex;flex-direction:column;gap:12px}
.dshm-gs-sec{border:1px solid var(--gs-border-soft);border-radius:var(--gs-radius);padding:11px;background:var(--gs-panel-2)}
.dshm-gs-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
.dshm-gs-sec-head h3{margin:0;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--gs-faint);font-weight:680}
.dshm-gs-hero{display:flex;gap:10px;align-items:flex-start}
.dshm-gs-glyph{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;font-size:15px;flex-shrink:0;font-weight:700}
.dshm-gs-hero-t h3{margin:1px 0 5px;font-size:13px;font-weight:670;line-height:1.35;overflow-wrap:anywhere}
.dshm-gs-tags{display:flex;flex-wrap:wrap;gap:5px}
.dshm-gs-tag{display:inline-flex;align-items:center;font-size:10px;padding:2px 8px;border-radius:999px;background:var(--gs-accent-soft);color:var(--gs-accent);white-space:nowrap;font-weight:600}
.dshm-gs-tag.neutral{background:var(--gs-panel);border:1px solid var(--gs-border);color:var(--gs-dim);font-weight:500}
.dshm-gs-tag.auto{background:var(--gs-accent-soft);color:var(--gs-accent)}
.dshm-gs-tag.manual{background:transparent;border:1px dashed var(--gs-border);color:var(--gs-dim)}
.dshm-gs-tag.warn{background:color-mix(in srgb,#b9963f 16%,transparent);color:#b9963f}
.dshm-gs-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:11px 0 0;font-size:11px}
.dshm-gs-kv dt{color:var(--gs-dim)}
.dshm-gs-kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dshm-gs-edge-list{display:flex;flex-direction:column;gap:7px}
.dshm-gs-edge{border:1px solid var(--gs-border-soft);border-radius:var(--gs-radius-sm);padding:8px 9px;background:var(--gs-panel);cursor:pointer;transition:.18s}
.dshm-gs-edge:hover{border-color:var(--gs-accent);transform:translateY(-1px)}
.dshm-gs-edge-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dshm-gs-edge-arrow{font-size:11.5px;font-weight:600;overflow-wrap:anywhere;line-height:1.45}
.dshm-gs-conf{font-size:10px;color:var(--gs-dim);font-variant-numeric:tabular-nums}
.dshm-gs-why{margin:5px 0 0;font-size:10.5px;color:var(--gs-dim);line-height:1.5}
.dshm-gs-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;align-items:center}
.dshm-gs-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.dshm-gs-stat{border:1px solid var(--gs-border-soft);border-radius:var(--gs-radius-sm);padding:9px 10px;background:var(--gs-panel)}
.dshm-gs-stat b{display:block;font-size:17px;font-weight:680;line-height:1.2;font-variant-numeric:tabular-nums}
.dshm-gs-stat span{font-size:10.5px;color:var(--gs-dim)}
.dshm-gs-hintbox{font-size:11px;color:var(--gs-dim);line-height:1.65;padding:10px;border:1px dashed var(--gs-border);border-radius:var(--gs-radius-sm);background:var(--gs-panel-2)}
.dshm-gs-fold>summary{cursor:pointer;font-size:11px;color:var(--gs-dim);list-style:none}
.dshm-gs-fold>summary::-webkit-details-marker{display:none}
.dshm-gs-fold>summary::before{content:'▸';font-size:10px;margin-right:6px}
.dshm-gs-fold[open]>summary::before{content:'▾'}
/* manager */
.dshm-gs-manager{grid-column:2/-1;grid-row:2;display:none;flex-direction:column;min-width:0;min-height:0;background:var(--gs-panel);z-index:12}
.dshm-gs-mgr-head{flex-shrink:0;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--gs-border);background:var(--gs-panel-2);flex-wrap:wrap}
.dshm-gs-mgr-add{display:grid;grid-template-columns:170px auto minmax(220px,1fr) 150px max-content;gap:8px;padding:10px 12px;border-bottom:1px solid var(--gs-border);background:var(--gs-panel-2);align-items:center}
.dshm-gs-mgr-add .dshm-gs-field,.dshm-gs-mgr-add .dshm-gs-btn{height:32px;min-width:0}
.dshm-gs-mgr-add .dshm-gs-seg{height:32px;align-items:center}
.dshm-gs-mgr-add .dshm-gs-seg button{height:26px}
.dshm-gs-mgr-add textarea.dshm-gs-field{grid-column:3 / 5;height:66px;padding:7px 9px;line-height:1.45;font-family:inherit;resize:vertical}
.dshm-gs-add-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.dshm-gs-mgr-add .dshm-gs-seg button:disabled{opacity:1;cursor:default}
.dshm-gs-mgr-add .dshm-gs-field:disabled{opacity:.75;cursor:default}
.dshm-gs-btn:disabled{opacity:.5;cursor:not-allowed}
.dshm-gs-btn.is-danger{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 55%,transparent)}
.dshm-gs-mgr-scroll{flex:1;min-height:0;overflow:auto}
.dshm-gs-mgr-thead,.dshm-gs-mgr-row{display:grid;grid-template-columns:26px 92px minmax(140px,1fr) 88px 88px 92px 58px 70px 156px;align-items:center;gap:8px;padding:0 14px;min-width:900px}
.dshm-gs-mgr-ops{display:flex;gap:4px;flex-wrap:nowrap}
.dshm-gs-mgr-thead{position:sticky;top:0;z-index:2;height:36px;background:var(--gs-panel-2);border-bottom:1px solid var(--gs-border);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--gs-faint);font-weight:650}
/* 表头必须与数据行同一种列内对齐，否则看起来整列错位 */
.dshm-gs-mgr-thead>span{text-align:left}
.dshm-gs-mgr-thead>span.num{text-align:right}
.dshm-gs-mgr-row>span{text-align:left}
.dshm-gs-mgr-row{height:42px;border-bottom:1px solid var(--gs-border-soft);font-size:12.5px;cursor:pointer}
.dshm-gs-mgr-row:hover{background:var(--gs-accent-soft)}
.dshm-gs-mgr-row.sel{background:var(--gs-accent-soft);box-shadow:inset 2px 0 0 var(--gs-accent)}
.dshm-gs-mgr-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--gs-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-gs-mgr-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-gs-mgr-row .num{text-align:right;font-variant-numeric:tabular-nums;color:var(--gs-dim)}
.dshm-gs-mgr-row .dshm-gs-mini{margin:0}
.dshm-gs-mgr-empty{padding:28px 16px;text-align:center;color:var(--gs-dim)}
.dshm-gs-mgr-foot{flex-shrink:0;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--gs-border);background:var(--gs-panel-2);font-size:11px;color:var(--gs-dim)}
/* status */
.dshm-gs-status{grid-column:1/-1;grid-row:3;display:flex;align-items:center;gap:12px;padding:0 12px;border-top:1px solid var(--gs-border);background:var(--gs-panel);font-size:10px;color:var(--gs-dim);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dshm-gs-status b{color:var(--gs-text);font-weight:650}
.dshm-gs-status-sep{width:1px;height:11px;background:var(--gs-border)}
.dshm-gs-status-right{margin-left:auto;overflow:hidden;text-overflow:ellipsis}
.dshm-gs-live{display:inline-flex;align-items:center;gap:5px}
.dshm-gs-live i{width:6px;height:6px;border-radius:50%;background:#36a582;box-shadow:0 0 0 3px color-mix(in srgb,#36a582 20%,transparent)}
@media (max-width:1100px){
  .dshm-gs{grid-template-columns:46px minmax(0,1fr) 0}
  .dshm-gs-inspector{position:absolute;top:50px;right:0;bottom:28px;width:340px;box-shadow:var(--gs-shadow);z-index:25}
  .dshm-gs.is-collapsed .dshm-gs-inspector{display:none}
  .dshm-gs-search{max-width:160px}
  .dshm-gs-brand-txt small,.dshm-gs-themechip{display:none}
}
@media (max-width:760px){
  .dshm-gs,.dshm-gs.is-collapsed,.dshm-gs.is-manage{grid-template-columns:minmax(0,1fr);grid-template-rows:50px 38px minmax(0,1fr) 28px}
  .dshm-gs-topbar{grid-column:1;grid-row:1}
  .dshm-gs-rail{grid-column:1;grid-row:2;flex-direction:row;justify-content:flex-start;padding:4px 8px;gap:4px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--gs-border)}
  .dshm-gs-rail-sep{width:1px;height:20px;margin:0 2px}
  .dshm-gs-rail-grow{display:none}
  .dshm-gs-stage,.dshm-gs-manager{grid-column:1;grid-row:3}
  .dshm-gs-status{grid-column:1;grid-row:4}
  .dshm-gs-inspector{top:88px;width:min(300px,92vw)}
  .dshm-gs-search,.dshm-gs-divider,.dshm-gs-popwrap{display:none}
  .dshm-gs-mgr-thead,.dshm-gs-mgr-row{grid-template-columns:20px 58px minmax(90px,1fr) 70px 64px 130px;min-width:500px}
  .dshm-gs-mgr-thead span:nth-child(6),.dshm-gs-mgr-row>span:nth-child(6),.dshm-gs-mgr-thead span:nth-child(7),.dshm-gs-mgr-row>span:nth-child(7),.dshm-gs-mgr-thead span:nth-child(8),.dshm-gs-mgr-row>span:nth-child(8){display:none}
}
/* 管理视图的可调「连接分支」侧栏 */
.dshm-gs-mgr-body{flex:1;min-height:0;display:flex;position:relative}
.dshm-gs-mgr-body .dshm-gs-mgr-scroll{flex:1;min-width:0}
.dshm-gs-br-resizer{width:5px;flex:0 0 5px;cursor:col-resize;background:var(--gs-border);border:0;padding:0}
.dshm-gs-br-resizer:hover{background:var(--gs-accent)}
.dshm-gs-branch{width:var(--gs-br-w,360px);flex:0 0 var(--gs-br-w,360px);background:var(--gs-panel);overflow:hidden;display:flex;flex-direction:column;border-left:1px solid var(--gs-border)}
.dshm-gs-br-head{flex-shrink:0;padding:11px 13px 9px;border-bottom:1px solid var(--gs-border-soft)}
.dshm-gs-br-head h3{margin:0 0 2px;font-size:12px;font-weight:680}
.dshm-gs-br-head p{margin:0;font-size:10.5px;color:var(--gs-faint);line-height:1.5}
.dshm-gs-br-body{flex:1;min-height:0;overflow-y:auto}
.dshm-gs-br-hero{display:flex;gap:9px;align-items:flex-start;padding:11px 13px;border-bottom:1px solid var(--gs-border-soft)}
.dshm-gs-br-hero .dshm-gs-glyph{width:28px;height:28px;font-size:13px;flex-shrink:0}
.dshm-gs-br-hero .dshm-gs-hero-t{min-width:0;flex:1}
.dshm-gs-br-hero .dshm-gs-hero-t b{display:block;font-size:12px;line-height:1.4;overflow-wrap:anywhere}
.dshm-gs-br-hero .dshm-gs-hero-t span{display:block;margin-top:3px;font-size:10px;color:var(--gs-dim)}
.dshm-gs-br-sec{padding:9px 13px}
.dshm-gs-br-sec h4{margin:0 0 7px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--gs-faint)}
.dshm-gs-br-item{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--gs-border-soft)}
.dshm-gs-br-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
.dshm-gs-br-col{min-width:0;flex:1}
.dshm-gs-br-nm{font-size:11.5px;line-height:1.45;overflow-wrap:anywhere;cursor:pointer}
.dshm-gs-br-nm:hover{color:var(--gs-accent);text-decoration:underline}
.dshm-gs-br-meta{font-size:10px;color:var(--gs-faint);line-height:1.45;overflow-wrap:anywhere}
.dshm-gs-br-item .dshm-gs-mini{flex-shrink:0;margin-top:0}
.dshm-gs-br-empty{padding:26px 16px;text-align:center;color:var(--gs-dim);font-size:11.5px}
@media (max-width:760px){.dshm-gs-branch,.dshm-gs-br-resizer{display:none}}
/* 关系图谱是沉浸式页面：解除 980px/1180px 宽度锁，可一键收起 WebUI 左导航腾满宽度 */
.dshm-root.is-graph-wide{padding:0}
.dshm-root.is-graph-wide .dshm-head{display:none}
.dshm-root.is-graph-wide .dshm-page{gap:0;min-height:0}
.dshm-root.is-graph-wide .dshm-gs{border:1px solid var(--gs-border);border-radius:var(--gs-radius);height:calc(100dvh - 96px);min-height:560px;box-shadow:var(--gs-shadow-sm)}
/* 贴在左导航右边缘的收起小块；收起后导航缩成 20px 窄条，把手本身始终可见 */
.dshm-root.is-graph-wide .dshm-nav-handle{position:absolute;right:0;top:50%;transform:translateY(-50%);width:20px;height:56px;display:grid;place-items:center;border:1px solid var(--gs-border);border-right:0;border-radius:8px 0 0 8px;background:var(--gs-panel);color:var(--gs-dim);font-size:15px;z-index:30;box-shadow:var(--gs-shadow-sm)}
.dshm-root.is-graph-wide .dshm-nav-handle:hover{color:var(--gs-accent);border-color:var(--gs-accent)}
/* 收起/展开要有过渡；窄条状态下隐藏外壳的“记忆工作室”竖排小字 */
.dshm-root.is-graph-wide .dshm-nav{transition:width .22s ease,min-width .22s ease,padding .22s ease}
.dshm-root.is-graph-wide .dshm-shell{transition:grid-template-columns .22s ease}
html[data-standalone] .stage{transition:padding-left .22s ease,padding-right .22s ease}
/* 关系图谱独占一屏：内容区只留 8px 呼吸，隐藏外壳 footer，工作台整体上移并加高 */
html[data-standalone]:has(.dshm-root.is-graph-wide) .stage{padding-top:8px;padding-bottom:8px}
html[data-standalone]:has(.dshm-root.is-graph-wide) .foot{display:none}
.dshm-root.is-graph-navless .dshm-nav::before{display:none}
/* 宿主内嵌：左导航是 grid 的一列，收起后只剩窄条 */
.dshm-root.is-graph-wide .dshm-shell{display:grid;max-width:none;gap:0;grid-template-columns:158px minmax(0,1fr);align-items:stretch;width:100%}
.dshm-root.is-graph-navless .dshm-shell{grid-template-columns:20px minmax(0,1fr)}
.dshm-root.is-graph-navless .dshm-nav{display:flex;width:20px;min-width:20px;padding:0;overflow:visible}
.dshm-root.is-graph-navless .dshm-nav>*:not(.dshm-nav-handle){display:none}
.dshm-root.is-graph-navless .dshm-nav-handle{border-right:1px solid var(--gs-border);border-radius:0}
/* 独立 WebUI：外壳本来是 block + 固定左栏，只需解除内容列上限 */
html[data-standalone] .dshm-root.is-graph-wide .dshm-shell{display:block;max-width:none}
html[data-standalone] .dshm-root.is-graph-wide .dshm-page{max-width:none;margin:0}
html[data-standalone] .dshm-root.is-graph-navless .dshm-nav{width:20px;min-width:20px;padding:0;overflow:visible}
html[data-standalone]:has(.dshm-root.is-graph-navless) .stage{padding-left:28px;padding-right:16px}
.dshm-root.is-graph-wide[data-dshm-surface="sidebar"] .dshm-shell{display:flex;flex-direction:column;height:100%;min-height:0;max-width:none}
.dshm-root.is-graph-wide[data-dshm-surface="sidebar"] .dshm-page{flex:1;min-height:0;overflow:hidden}
.dshm-root.is-graph-wide[data-dshm-surface="sidebar"] .dshm-gs{height:100%;min-height:0}
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
.dshm-x:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-state-error-primary,#e5484d)}
.dshm-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}

/* 入场动画用 backwards 而非 both：both 会在动画结束后仍保留末帧的 transform
   （哪怕是单位矩阵），Chromium 据此给元素建立 containing block，把内部
   position:fixed 的抽屉遮罩困在页面列里——遮罩盖不住顶栏/侧栏、抽屉整体偏移。 */
.dshm-page{min-width:0;display:flex;flex-direction:column;gap:13px;animation:dshm-page-in .26s cubic-bezier(.22,1,.36,1) backwards}
.dshm-head{margin:2px 0 5px}
.dshm-overline{font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--dsw-alias-brand-primary,#2563eb);opacity:.9}
.dshm-h1{margin:4px 0 0;font-size:21px;font-weight:700;letter-spacing:-.01em}
.dshm-desc{margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8));max-width:56ch}

/* Cards. The inline style object still carries the colours; these add the motion
   and hover that inline styles cannot express. */
.dshm-card{transition:transform .28s ease,box-shadow .28s ease,border-color .28s ease}
.dshm-card:hover{transform:translateY(-2px);box-shadow:0 10px 28px -12px rgba(0,0,0,.28)}
.dshm-rise{animation:dshm-rise-in .34s cubic-bezier(.22,1,.36,1) backwards;animation-delay:calc(var(--d,0) * 38ms)}
.dshm-card-head{display:flex;align-items:flex-start;gap:11px}
.dshm-logrow.is-failed{border-left:2px solid var(--dsw-alias-state-error-primary,#c0392b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 7%,transparent)}
.dshm-logrow.is-failed .dshm-logmsg{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dshm-logrow.is-degraded{border-left:2px solid var(--dsw-alias-state-warn-label,#b7791f)}
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
.dshm-error{color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:1.6}
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
/* 单一响应式通道：@container 同时覆盖宿主侧栏与独立页，不再与 @media 双轨重复。
   窄屏规则只作用于容器后代——容器自身不可自查询（原 .dshm-root 规则已删除）。 */
@container (max-width:900px){
  .dshm-prompt-layout{grid-template-columns:minmax(0,1fr)}
  .dshm-prompt-pages{flex-direction:row;flex-wrap:wrap;gap:2px}
  .dshm-prompt-pages>div{flex:none}
  .dshm-prompt-new{max-width:240px}
  .dshm-graph-stage{grid-template-columns:minmax(0,1fr)}
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
  .dshm-prompt-meta{flex-basis:100%}
  .dshm-prompt-actions{width:100%;justify-content:flex-end;margin-left:0}
  .dshm-page{gap:10px}
  .dshm-overline{font-size:10px}
  .dshm-h1{font-size:17px}
  .dshm-desc{font-size:12px}
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
      // 宿主主题随 URL 带过去，独立壳首帧就按当前深浅色绘制，避免 dark 下闪白。
      const params = new URLSearchParams()
      if (libraryId) params.set('libraryId', libraryId)
      let dark = false
      try { dark = document.body?.hasAttribute('data-ds-dark-theme') || document.documentElement?.dataset?.theme === 'dark' } catch {}
      params.set('theme', dark ? 'dark' : 'light')
      const query = '?' + params.toString()
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
        // No backdrop-filter on this full-viewport wrapper. Behind it sits the
        // whole host app; with a maximized window every repaint inside the
        // iframe made WebView2 re-blur that backdrop and the panel flickered or
        // lost tiles. A plain dim is cheap and looks the same at 55% black.
        'background:rgba(6,8,12,.6)',
      ].join(';')

      const frame = document.createElement('iframe')
      frame.src = url
      frame.title = 'MemU WebUI'
      // No max-width: the page should fill the overlay's content box. The old
      // 1600px cap left a dark band on wide windows.
      frame.style.cssText = [
        'width:100%', 'height:100%', 'border:0',
        // Opaque, theme-aware: a transparent frame let the host show through
        // while the embedded page painted, which read as flashing at fullscreen.
        'border-radius:16px', 'background:var(--dsw-alias-bg-base, #f4f5f9)',
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
    // label reserves a 132px column, so side-by-side Fields push each control
    // away from its own text and it reads as the neighbour's switch. Keep the
    // switch and the words in one pill so the pairing cannot be misread.
    function CheckRow({ label, checked, disabled, title, onChange }) {
      return h('span', {
        title: title || '',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '3px 10px 3px 6px', borderRadius: 999,
          border: `1px solid ${V.borderSoft}`,
          fontSize: 12, color: V.textDim, whiteSpace: 'nowrap',
          opacity: disabled ? 0.55 : 1,
        },
      },
      h(Toggle, { checked: checked === true, disabled: disabled === true, label, title, onChange }),
      h('span', null, label))
    }

    // Accessible switch used by the folder list. Native checkbox input is avoided
    // because the settings pane's dark theme makes an unstyled checkbox vanish.
    function Toggle({ checked, onChange, disabled, label, title }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: title || label,
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
          background: checked ? 'var(--dsw-alias-brand-text, #fff)' : V.textDim,
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

    // 情绪构成：四轴按固定顺序完整输出（喜/怒/哀/惧），不截断、不重排。
    // 只显示 top-2 会让“喜0.6/哀0.4”看起来像只有两种情绪，而构成本来就是四维；
    // 同理，阈值过滤会把小分量的轴吞掉，看不出“四轴各是多少”。
    // 四轴固定且术语极短，就地映射，不为四个轴各加一个 i18n key。
    const EMOTION_TAG_LABELS = { joy: '喜', anger: '怒', sorrow: '哀', fear: '惧' }
    function emotionTagText(emotion) {
      if (!emotion || typeof emotion !== 'object') return ''
      const axes = Object.entries(EMOTION_TAG_LABELS)
        .map(([axis, label]) => ({ label, share: Number(emotion[axis]) || 0 }))
      if (!axes.some((item) => item.share > 0)) return ''
      return axes.map((item) => `${item.label}${item.share.toFixed(2)}`).join('/')
    }

    const EMOTION_SOURCE_LABELS = {
      model: 'emotionSourceModel',
      session: 'emotionSourceSession',
      content: 'emotionSourceContent',
      unknown: 'emotionSourceUnknown',
    }
    // Read-only affect metadata. Old entries have no arousal/dominance at all; do
    // not infer them from valence, and do not show a lone source line.
    function emotionMetaText(entry, t) {
      const arousal = typeof entry?.arousal === 'number' && Number.isFinite(entry.arousal) ? entry.arousal : null
      const dominance = typeof entry?.dominance === 'number' && Number.isFinite(entry.dominance) ? entry.dominance : null
      if (arousal === null && dominance === null) return ''
      const parts = []
      if (arousal !== null) parts.push(`${t('arousalLabel')} ${arousal.toFixed(1)}`)
      if (dominance !== null) parts.push(`${t('dominanceLabel')} ${dominance > 0 ? '+' : ''}${dominance.toFixed(1)}`)
      if (entry?.emotionSource) {
        parts.push(`${t('emotionSourceLabel')} ${t(EMOTION_SOURCE_LABELS[entry.emotionSource] || 'emotionSourceUnknown')}`)
      }
      return parts.join(' · ')
    }

    // Tags are labels, not decoration — except when the label is a warning. A memory
    // marked "never say out loud" has to look different from one that can be said,
    // otherwise the badge is just more grey text to skim past.
    const TAG_TONES = {
      warn: { color: V.warn, background: 'color-mix(in srgb, currentColor 12%, transparent)' },
      danger: { color: V.danger, background: 'color-mix(in srgb, currentColor 12%, transparent)' },
      info: { color: V.accent, background: V.accentSoft },
    }

    function Tag({ children, tone, title }) {
      const style = tone && TAG_TONES[tone] ? { ...S.tag, ...TAG_TONES[tone] } : S.tag
      return h('span', { style, title }, children)
    }

    // 活动日志行的三档状态。失败 = ok=false 或 level=error；level=warn 而 ok 不为 false
    // 是「降级」（向量未激活、自动关联跳过），不能跟失败同色——真失败会被降级噪声淹没。
    // 只看 level==='error' 会漏：整理超时记的是 warn + ok=false（lib/private.js 的超时路径）。
    function logRowState(row) {
      if (!row || typeof row !== 'object') return null
      if (row.ok === false || row.level === 'error') return 'failed'
      if (row.level === 'warn') return 'degraded'
      return null
    }
    function logRowClass(row) {
      const state = logRowState(row)
      return state ? `dshm-logrow is-${state}` : 'dshm-logrow'
    }
    function logMessageClass(row) {
      return logRowState(row) === 'failed' ? 'dshm-logmsg' : undefined
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
      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 2600)
        return () => clearTimeout(timer)
      }, [notice])
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
      React.useEffect(() => {
        if (!message) return undefined
        const timer = setTimeout(() => setMessage(''), 2600)
        return () => clearTimeout(timer)
      }, [message])
      // Same Field/row rhythm as every other settings card: labels above inputs,
      // one action row at the bottom. The previous bare row of three inputs made
      // this card read like a different product.
      return h('form', { style: { display: 'flex', flexDirection: 'column', gap: 10 }, onSubmit: async event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        setBusy(true)
        try {
          await call('saveMemuConfig', { visionBaseUrl: data.get('url'), visionModel: data.get('model'), visionApiKey: data.get('key') || undefined })
          setMessage(t('saved'))
          notifyMemoryWrite('settings')
        } catch (error) { setMessage(String(error.message || error)) } finally { setBusy(false) }
      } },
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, lineHeight: 1.55 } }, t('visionServiceHint')),
        h(Field, { label: t('baseUrl') },
          h('input', { name: 'url', type: 'url', style: S.input, defaultValue: config?.baseUrl || '', placeholder: 'https://host/v1', 'aria-label': t('baseUrl') })),
        h(Field, { label: t('captionModel') },
          h('input', { name: 'model', style: S.input, defaultValue: config?.model || '', placeholder: t('captionModel'), 'aria-label': t('captionModel') })),
        h(Field, { label: t('apiKey') },
          h('input', { name: 'key', type: 'password', style: S.input, autoComplete: 'new-password', placeholder: config?.hasKey ? '********' : 'API key', 'aria-label': t('apiKey') })),
        h('div', { style: S.row },
          h('button', { className: 'dshm-btn', type: 'submit', disabled: busy }, t('save')),
          message ? h('span', { role: 'status', style: S.muted }, message) : null))
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

    // chrome=false 时外壳（rail / 参数弹层 / 状态栏）由 Graph Studio 工作台自己画，
    // 画布与引擎保持同一份实现：拖动、pin、弹簧链、簇作用域都不变。
    function GraphCanvas({ graph, focus, onFocus, t, chrome = true, options: controlledOptions = null,
      apiRef = null, onZoom = null, onPaint = null }) {
      const ref = React.useRef(null)
      const tooltipRef = React.useRef(null)
      const viewRef = React.useRef(null)
      const latest = React.useRef({ graph, focus, onFocus, t })
      latest.current = { graph, focus, onFocus, t }
      const zoomNotify = React.useRef(onZoom)
      zoomNotify.current = onZoom
      const [zoom, setZoom] = React.useState(1)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [options, setOptions] = React.useState({ repulsion: 120, distance: 100, center: 0, labels: true, motion: true })
      const effectiveOptions = controlledOptions || options
      const optionsRef = React.useRef(effectiveOptions)
      optionsRef.current = effectiveOptions
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
            onZoom: value => { setZoom(value); zoomNotify.current?.(value) },
            // 主画布每重绘一次通知一次：缩略图由它直接驱动，不自己轮询。
            onPaint: () => { onPaint?.() },
            tooltip: tooltipRef.current,
            reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
            emptyLabel: latest.current.t('graphEmpty'),
          })
          viewRef.current = view
          // 只读句柄：浏览器验收与状态栏需要问「现在有几个节点被右键锁定」。
          canvas.__dshmGraphView = view
          view.configure(optionsRef.current)
          view.update(latest.current.graph, latest.current.focus)
        }).catch(() => { if (!disposed) setLoadError(true) })
        return () => {
          disposed = true
          viewRef.current?.dispose(); viewRef.current = null
          try { delete canvas.__dshmGraphView } catch {}
        }
      }, [attempt])
      React.useEffect(() => { viewRef.current?.update(graph, focus) }, [graph, focus])
      React.useEffect(() => { viewRef.current?.configure(effectiveOptions) }, [effectiveOptions])
      React.useEffect(() => {
        if (!apiRef) return undefined
        apiRef.current = {
          zoom: factor => viewRef.current?.zoom(factor),
          fit: () => viewRef.current?.fit(),
          unpinAll: () => viewRef.current?.unpinAll?.(),
          relayout: () => viewRef.current?.relayout?.(),
          exportPng: () => ref.current?.toDataURL?.('image/png') || '',
        }
        return () => { apiRef.current = null }
      }, [apiRef])
      const icon = (label, text, action, extra = {}) => h('button', {
        type: 'button', className: 'dshm-graph-icon', title: t(label), 'aria-label': t(label), onClick: action, ...extra,
      }, text)
      return h('div', { className: 'dshm-graph-viewport' },
        chrome ? h('div', { className: 'dshm-graph-toolbar' },
          icon('graphZoomOut', '-', () => viewRef.current?.zoom(.8)),
          h('output', { className: 'dshm-graph-scale', 'aria-label': t('graphView') }, Math.round(zoom * 100) + '%'),
          icon('graphZoomIn', '+', () => viewRef.current?.zoom(1.25)),
          icon('graphFit', '⛶', () => viewRef.current?.fit()),
          icon('graphUnpinAll', '⊙', () => viewRef.current?.unpinAll?.()),
          icon('graphRelayout', '↻', () => viewRef.current?.relayout?.()),
          icon('graphOptions', h(GlyphSliders), () => setSettingsOpen(value => !value), { 'aria-expanded': settingsOpen })) : null,
        chrome && settingsOpen ? h('div', { className: 'dshm-graph-options' },
          [['repulsion', 'graphRepulsion', 30, 350, 5], ['distance', 'graphDistance', 40, 220, 5],
            ['center', 'graphCenter', 0, 3, .05]].map(([key, label, min, max, step]) =>
            h('label', { key }, t(label), h('input', { type: 'range', min, max, step, value: options[key],
              'aria-label': t(label), title: t(label),
              onChange: event => setOptions(value => ({ ...value, [key]: Number(event.target.value) })) }))),
          [['labels', 'graphLabels'], ['motion', 'graphMotion']].map(([key, label]) =>
            h('div', { key, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
              h('span', null, t(label)),
              h(Toggle, { checked: options[key] === true, label: t(label),
                onChange: value => setOptions(current => ({ ...current, [key]: value })) }))),
          h('div', { className: 'dshm-graph-actions' },
            h(Button, { title: t('graphUnpinAll'), onClick: () => viewRef.current?.unpinAll?.() }, t('graphUnpinAll')),
            h(Button, { title: t('graphRelayout'), onClick: () => viewRef.current?.relayout?.() }, t('graphRelayout')))) : null,
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
        if (!message) return undefined
        const timer = setTimeout(() => setMessage(''), 2600)
        return () => clearTimeout(timer)
      }, [message])
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

    // 关系图的库选择器里，全局记忆不是一个私有库；用一个不可能与库 id 冲突的
    // 占位值走同一套选择控件，避免再加一排 scope 按钮。
    const GLOBAL_GRAPH_ID = '__global__'
    // Graph Studio 工作台：界面按 graph-studio/index.html 逐块复刻（顶栏 / 竖排工具 /
    // 画布浮动控件 / 检视面板 / 管理表格 / 状态栏），尺寸按 WebUI 收敛、颜色走 DSH
    // token 跟随宿主明暗。数据仍走插件 getGraph/listEntities，画布仍是 GraphCanvas +
    // 自研引擎，所以节点连接、拖动即固定、弹簧链、簇作用域这些手感一个都没改。
    const GS_NODE_COLORS = Object.freeze({
      memory: '#618fcd', must: '#d97768', short: '#8a93a6', entity: '#36a582',
      provisional: '#b9963f', global: '#8b7bd8', missing: '#92959c',
    })
    const gsKind = node => node.missing ? 'missing'
      : node.kind === 'global' ? 'global'
        : node.kind !== 'memory' ? (node.status === 'provisional' ? 'provisional' : 'entity') : 'memory'
    const gsColor = node => GS_NODE_COLORS[gsKind(node)]

    function GraphStudioMinimap({ active, t, notifyRef = null }) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!active || typeof document === 'undefined') return undefined
        const paint = () => {
          const target = ref.current
          if (!target?.getContext) return
          const source = document.querySelector('.dshm-gs-stage canvas.dshm-graph-canvas')
          const context = target.getContext('2d')
          if (!source || !context) return
          context.clearRect(0, 0, target.width, target.height)
          try { context.drawImage(source, 0, 0, target.width, target.height) } catch {}
        }
        // 只由主画布的 onPaint 驱动：空闲期主画布不重绘，缩略图就一帧不画。
        // 曾经这里是 setInterval(paint, 600)，即使加了计数闸门也仍是一个常开定时器。
        if (notifyRef) notifyRef.current = paint
        paint()
        return () => { if (notifyRef) notifyRef.current = null }
      }, [active])
      return h('div', { className: 'dshm-gs-minimap' },
        h('h4', null, t('gsMinimap')),
        h('canvas', { ref, width: 158, height: 104, 'aria-label': t('gsMinimap') }))
    }

    // 规则筛选读显示层 rule。老版本插件的自动边没有 evidence.rule（handoff: 旧
    // suppression 键就是 'auto'），这里按 source==='auto' 兜底成 'auto' 桶——
    // 这样新客户端配旧后端/旧数据也不会出现「一条规则都没有」；新写入带真实规则。
    const GS_RULE_LABEL_KEYS = Object.freeze({
      'entity-mention': 'gsRuleMention', conflict: 'gsRuleConflict', supersede: 'gsRuleSupersede',
      'fact-key': 'gsRuleFactKey', 'worker-quote': 'gsRuleWorkerQuote', auto: 'gsRuleAuto',
    })
    const graphRuleOf = edge => edge.rule || (edge.source === 'auto' ? 'auto' : null)
    const graphRuleText = (rule, t) => GS_RULE_LABEL_KEYS[rule] ? t(GS_RULE_LABEL_KEYS[rule]) : String(rule)

    function GraphStudioPanel({ call, libraries, revision, stamp, t, navHidden = false, onToggleNav = null }) {
      const [graphLib, setGraphLib] = React.useState('')
      // 默认落在有数据的私有库：全局图常常是空的，一进页面就空白会让人以为图坏了。
      const firstPrivate = libraries[0]?.id || ''
      const graphLibrary = graphLib === GLOBAL_GRAPH_ID ? GLOBAL_GRAPH_ID
        : (graphLib && libraries.some(lib => lib.id === graphLib) ? graphLib : (firstPrivate || GLOBAL_GRAPH_ID))
      const showGlobal = graphLibrary === GLOBAL_GRAPH_ID
      const [graph, setGraph] = React.useState({ nodes: [], edges: [] })
      const [entities, setEntities] = React.useState([])
      const [focus, setFocus] = React.useState('')
      const [error, setError] = React.useState('')
      const [view, setView] = React.useState('graph')
      const [query, setQuery] = React.useState('')
      const [source, setSource] = React.useState('all')
      const [rulesOff, setRulesOff] = React.useState(() => new Set())
      const [ruleOpen, setRuleOpen] = React.useState(false)
      const [legendOpen, setLegendOpen] = React.useState(false)
      const [forceOpen, setForceOpen] = React.useState(false)
      const [minimap, setMinimap] = React.useState(false)
      const [grid, setGrid] = React.useState(true)
      const [labels, setLabels] = React.useState(true)
      const [motion, setMotion] = React.useState(true)
      const [forces, setForces] = React.useState({ repulsion: 120, distance: 100, center: 0 })
      // 窄屏下检视面板是覆盖层，会挡住画布；默认收起，画布优先。
      const [inspectorOpen, setInspectorOpen] = React.useState(() =>
        typeof window === 'undefined' || typeof window.matchMedia !== 'function'
          ? true : !window.matchMedia('(max-width: 1100px)').matches)
      const [zoom, setZoom] = React.useState(1)
      const [toast, setToast] = React.useState('')
      const [mgrKind, setMgrKind] = React.useState('')
      const [mgrStatus, setMgrStatus] = React.useState('')
      const [mgrSort, setMgrSort] = React.useState('degree')
      const [mgrSelected, setMgrSelected] = React.useState('')
      const [branchWidth, setBranchWidth] = React.useState(360)
      // 管理视图的增删节点：新增走 addMemory / createEntity，删除两段确认。
      const [mgrBusy, setMgrBusy] = React.useState(false)
      const [mgrArmed, setMgrArmed] = React.useState('')
      const [mgrDeleteRefused, setMgrDeleteRefused] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [addOpen, setAddOpen] = React.useState(false)
      const [addLib, setAddLib] = React.useState('')
      const [draft, setDraft] = React.useState({ type: 'memory', title: '', content: '', layer: 'long_term', name: '', kind: 'person' })
      // 编辑已有节点：记忆读 getMemory 取完整正文，实体读 listEntities 取别名；
      // 两者都与新增表单互斥，共用同一套网格样式。
      const [editBusy, setEditBusy] = React.useState(false)
      const [editOpen, setEditOpen] = React.useState(false)
      const [editDraft, setEditDraft] = React.useState(null)
      // 「全部记忆库」合并的是各私有库，新增必须选目标库；没有私有库时落到全局索引，只读。
      const mergedScope = showGlobal && libraries.length > 0
      const writable = !showGlobal || mergedScope
      const addTargetLib = mergedScope ? (addLib || libraries[0]?.id || '') : (showGlobal ? '' : graphLibrary)
      const apiRef = React.useRef(null)
      const searchRef = React.useRef(null)
      // 缩略图的画笔登记处：主画布 onPaint 直接叫它，空闲期零定时器。
      const minimapPaint = React.useRef(null)
      const beat = `${revision ?? ''}:${stamp ?? ''}`
      const notify = message => setToast(message)

      // 一切轮询仍走 SettingsPage 的心跳：revision/stamp 变动才重新取数。
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            if (showGlobal && libraries.length) {
              // 「全部记忆库」= 合并每个私有库的图，和 MemU 记忆页的「全部记忆库」口径一致。
              const results = await Promise.all(libraries.map(lib =>
                call('getGraph', { libraryId: lib.id, focusId: null, depth: 2, limit: 200 }).catch(() => null)))
              const nodes = new Map(), edges = new Map()
              for (let i = 0; i < results.length; i++) {
                const value = results[i], lib = libraries[i]
                // 合并视图下节点要记住来源库：管理视图的删除必须有 libraryId。
                for (const node of value?.nodes || []) if (!nodes.has(node.id)) nodes.set(node.id, { ...node, libraryId: lib.id })
                for (const edge of value?.edges || []) edges.set(`${edge.from}|${edge.to}|${edge.kind || ''}`, edge)
              }
              if (!alive) return
              setGraph({ nodes: [...nodes.values()], edges: [...edges.values()] })
            } else {
              const payload = showGlobal
                ? { scope: 'global', focusId: focus || null, depth: 2, limit: 200 }
                : { libraryId: graphLibrary, focusId: focus || null, depth: 2, limit: 200 }
              const value = await call('getGraph', payload)
              if (!alive) return
              setGraph(value && Array.isArray(value.nodes)
                ? { nodes: value.nodes, edges: value.edges || [] } : { nodes: [], edges: [] })
            }
            setError('')
          } catch (failure) { if (alive) setError(String(failure?.message || failure)) }
        }
        void load()
        return () => { alive = false }
      }, [call, graphLibrary, showGlobal, focus, beat, reloadKey, libraries.length, libraries.map(lib => lib.id).join(',')])
      React.useEffect(() => {
        if (showGlobal) { setEntities([]); return undefined }
        let alive = true
        void call('listEntities', { libraryId: graphLibrary })
          .then(value => { if (alive) setEntities(value?.items || []) })
          .catch(() => { if (alive) setEntities([]) })
        return () => { alive = false }
      }, [call, graphLibrary, showGlobal, beat, reloadKey])
      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(''), 2200)
        return () => clearTimeout(timer)
      }, [toast])
      // 破坏性操作 = 二次点击，2.5s 未确认自动复原（§7.3）。
      React.useEffect(() => {
        if (!mgrArmed) return undefined
        const timer = setTimeout(() => { setMgrArmed(''); setMgrDeleteRefused('') }, 2500)
        return () => clearTimeout(timer)
      }, [mgrArmed])
      React.useEffect(() => {
        if (typeof document === 'undefined' || !document.addEventListener) return undefined
        const onKey = event => {
          const tag = event.target?.tagName
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
          if (event.key === '/') { event.preventDefault(); searchRef.current?.focus?.() }
          else if (event.key === 'f' || event.key === 'F') apiRef.current?.fit?.()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const nodes = graph.nodes || [], edges = graph.edges || []
      const nodeIds = React.useMemo(() => new Set(nodes.map(node => node.id)), [graph])
      const degree = React.useMemo(() => {
        const map = new Map()
        for (const edge of edges) {
          map.set(edge.from, (map.get(edge.from) || 0) + 1)
          map.set(edge.to, (map.get(edge.to) || 0) + 1)
        }
        return map
      }, [graph])
      const rules = React.useMemo(() => [...new Set(edges.map(graphRuleOf).filter(Boolean))].sort(), [graph])
      const q = query.trim().toLowerCase()
      const visibleEdges = React.useMemo(() => {
        const matched = new Set(q ? nodes.filter(node => String(node.title || node.id).toLowerCase().includes(q))
          .map(node => node.id) : [])
        return edges.filter(edge => {
          if (edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return false
          if (source === 'auto' && edge.source !== 'auto') return false
          if (source === 'manual' && edge.source === 'auto') return false
          const rule = graphRuleOf(edge)
          if (rule && rulesOff.has(rule)) return false
          if (q && !matched.has(edge.from) && !matched.has(edge.to)) return false
          return true
        })
      }, [graph, q, source, rulesOff, nodeIds])
      const canvasGraph = React.useMemo(() => ({ nodes, edges: visibleEdges }), [graph, visibleEdges])
      // 搜索词透传给画布：匹配节点会被高亮，边筛选仍在工作台侧完成。
      const canvasOptions = React.useMemo(() => ({ ...forces, labels, motion, grid, query: q }),
        [forces, labels, motion, grid, q])
      const titles = React.useMemo(() => new Map(nodes.map(node => [node.id, node.title || node.id])), [graph])
      const panelFiles = React.useMemo(() => nodes.map(node => ({ id: node.id, title: node.title || node.id })), [graph])
      const selected = nodes.find(node => node.id === focus) || null
      const focusEdges = edges.filter(edge => edge.from === focus || edge.to === focus)
      const autoCount = edges.filter(edge => edge.source === 'auto').length
      const pendingCount = nodes.filter(node => node.status === 'provisional').length
      const manageRows = React.useMemo(() => nodes.filter(node => {
        if (q && !String(node.title || node.id).toLowerCase().includes(q)) return false
        if (mgrKind && node.kind !== mgrKind) return false
        if (mgrStatus && (node.status || 'confirmed') !== mgrStatus) return false
        return true
      }).sort((a, b) => mgrSort === 'degree' ? (degree.get(b.id) || 0) - (degree.get(a.id) || 0)
        : mgrSort === 'strength' ? (Number(b.strength) || 0) - (Number(a.strength) || 0)
          : String(mgrSort === 'id' ? a.id : a.title || a.id).localeCompare(String(mgrSort === 'id' ? b.id : b.title || b.id))),
      [graph, q, mgrKind, mgrStatus, mgrSort, degree])

      const railBtn = (label, text, action, pressed) => h('button', {
        type: 'button', title: t(label), 'aria-label': t(label),
        'aria-pressed': pressed === undefined ? undefined : String(pressed), onClick: action,
      }, text)
      const segBtn = (label, value, current, action) => h('button', {
        type: 'button', 'aria-pressed': String(current === value), onClick: () => action(value),
      }, t(label))
      const toggleRule = rule => setRulesOff(current => {
        const next = new Set(current)
        if (next.has(rule)) next.delete(rule); else next.add(rule)
        return next
      })
      const exportPng = () => {
        const url = apiRef.current?.exportPng?.()
        if (!url || typeof document === 'undefined') return
        const link = document.createElement('a')
        link.href = url; link.download = 'relationship-graph.png'
        document.body?.appendChild?.(link); link.click?.(); link.remove?.()
        notify(t('gsExport'))
      }
      const fit = () => apiRef.current?.fit?.()
      const zoomBy = factor => apiRef.current?.zoom?.(factor)
      // 增删节点：记忆走 addMemory（事实级去重会返回 deduped），实体走 createEntity
      // （RPC 层强制 confirmed 并补提及边）。写入后立即重取图，不等心跳。
      const removeKey = mgrSelected ? 'remove:' + mgrSelected : ''
      const canAdd = writable && Boolean(addTargetLib) && !mgrBusy
        && (draft.type === 'memory' ? Boolean(draft.content.trim()) : Boolean(draft.name.trim()))
      const canSave = Boolean(editDraft) && !editBusy
        && (editDraft.kind === 'memory' ? Boolean(editDraft.content.trim()) : Boolean(editDraft.name.trim()))
      // updateMemory 只支持 short_term→long_term 升级与 must_remember 降级；
      // 提升到 must_remember 必须走带 pin 理由的写入口，这里不提供。
      const editLayers = !editDraft || editDraft.kind !== 'memory' ? []
        : editDraft.layer === 'must_remember' ? ['must_remember', 'long_term']
          : editDraft.layer === 'short_term' ? ['short_term', 'long_term'] : ['long_term']
      const addNode = async () => {
        if (!canAdd) return
        setMgrBusy(true)
        try {
          if (draft.type === 'entity') {
            const name = draft.name.trim()
            const entity = await call('createEntity', { libraryId: addTargetLib, name, kind: draft.kind })
            notifyMemoryWrite('relation', addTargetLib)
            setMgrSelected(entity?.id || '')
            setDraft(value => ({ ...value, name: '' }))
            notify(t('gsNodeCreated').replace('{name}', name))
          } else {
            const payload = { libraryId: addTargetLib, content: draft.content.trim(), title: draft.title.trim() || undefined, layer: draft.layer }
            if (draft.layer === 'must_remember') { payload.pinReason = 'user_explicit_note'; payload.pinSource = 'user_explicit' }
            const created = await call('addMemory', payload)
            if (created?.deduped === true) {
              notify(t('dedupedNotice').replace('{id}', created.existingId || '?'))
              return
            }
            notifyMemoryWrite('memory', addTargetLib)
            setMgrSelected(created?.id || '')
            setDraft(value => ({ ...value, title: '', content: '' }))
            notify(t('memorySaved'))
          }
          setReloadKey(value => value + 1)
        } catch (failure) { notify(String(failure?.message || failure)) } finally { setMgrBusy(false) }
      }
      const removeSelected = async () => {
        const node = mgrSelected ? nodes.find(item => item.id === mgrSelected) : null
        const libraryId = node?.libraryId || (showGlobal ? '' : graphLibrary)
        if (!node || !libraryId || !writable || mgrBusy) return
        if (mgrArmed !== removeKey) { setMgrArmed(removeKey); return }
        setMgrBusy(true)
        try {
          if (node.kind === 'memory') {
            // 永久删除只接受已归档条目：先归档再删；两段确认已由按钮承担。
            await call('archiveMemory', { libraryId, id: node.id })
            await call('deleteMemory', { libraryId, id: node.id, confirmed: true })
            notifyMemoryWrite('memory', libraryId)
            notify(t('memoryDeleted'))
          } else {
            await call('deleteEntity', { libraryId, entityId: node.id, force: mgrDeleteRefused === node.id })
            notifyMemoryWrite('relation', libraryId)
            notify(t('gsNodeDeleted'))
          }
          setMgrArmed(''); setMgrDeleteRefused(''); setMgrSelected('')
          setEditOpen(false); setEditDraft(null)
          if (focus === node.id) setFocus('')
          setReloadKey(value => value + 1)
        } catch (failure) {
          const message = String(failure?.message || failure)
          // 实体仍被引用：保留 armed，再点一次升级为 force（连同引用一起删）。
          if (/referenced|引用/.test(message)) setMgrDeleteRefused(node.id)
          notify(message)
        } finally { setMgrBusy(false) }
      }
      // 编辑已有节点：先读完整数据再开表单，避免拿节点摘要当正文保存。
      const editNode = async () => {
        const node = mgrSelected ? nodes.find(item => item.id === mgrSelected) : null
        const libraryId = node?.libraryId || (showGlobal ? '' : graphLibrary)
        if (!node || !libraryId || !writable || editBusy) return
        setEditBusy(true)
        try {
          if (node.kind === 'memory') {
            const loaded = await call('getMemory', { libraryId, id: node.id })
            const entry = loaded?.entry || {}
            setEditDraft({ id: node.id, kind: 'memory', libraryId,
              title: entry.title || '', content: entry.content || '', layer: entry.layer || 'long_term' })
          } else {
            const list = await call('listEntities', { libraryId })
            const found = (list?.items || []).find(item => item.id === node.id) || {}
            setEditDraft({ id: node.id, kind: 'entity', libraryId,
              name: found.name || node.title || '', aliases: (found.aliases || []).join(', ') })
          }
          setAddOpen(false)
          setEditOpen(true)
        } catch (failure) { notify(String(failure?.message || failure)) } finally { setEditBusy(false) }
      }
      const saveEdit = async () => {
        if (!canSave) return
        setEditBusy(true)
        try {
          if (editDraft.kind === 'memory') {
            const patch = { content: editDraft.content.trim(), layer: editDraft.layer }
            const title = editDraft.title.trim()
            if (title) patch.title = title
            await call('updateMemory', { libraryId: editDraft.libraryId, id: editDraft.id, patch })
            notifyMemoryWrite('memory', editDraft.libraryId)
          } else {
            // renameEntity 的 aliases 是整体替换：必须带上当前列表，否则会被清空。
            const aliases = String(editDraft.aliases || '').split(',').map(value => value.trim()).filter(Boolean)
            await call('renameEntity', { libraryId: editDraft.libraryId, entityId: editDraft.id,
              name: editDraft.name.trim(), aliases })
            notifyMemoryWrite('relation', editDraft.libraryId)
          }
          notify(t('saved'))
          setEditOpen(false); setEditDraft(null)
          setReloadKey(value => value + 1)
        } catch (failure) { notify(String(failure?.message || failure)) } finally { setEditBusy(false) }
      }

      const topbar = h('header', { className: 'dshm-gs-topbar' },
        h('div', { className: 'dshm-gs-brand' },
          h('div', { className: 'dshm-gs-mark', 'aria-hidden': 'true' }, 'M'),
          h('div', { className: 'dshm-gs-brand-txt' },
            h('strong', null, t('pageGraph')), h('small', null, 'GRAPH STUDIO'))),
        h('div', { className: 'dshm-gs-divider' }),
        h('div', { className: 'dshm-gs-seg', role: 'group', 'aria-label': t('pageGraph') },
          segBtn('graphView', 'graph', view, setView), segBtn('gsManage', 'manage', view, setView)),
        h('select', {
          className: 'dshm-gs-field', value: graphLibrary,
          title: showGlobal ? t('gsAllLibraries') : (libraries.find(lib => lib.id === graphLibrary)?.scopeKey || t('currentLibrary')),
          'aria-label': t('currentLibrary'), onChange: event => setGraphLib(event.target.value),
        },
        h('option', { value: GLOBAL_GRAPH_ID }, t('gsAllLibraries')),
        libraries.map(lib => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries)))),
        h('label', { className: 'dshm-gs-search' },
          h('span', { className: 'dshm-gs-search-icon', 'aria-hidden': 'true' }, '⌕'),
          h('input', { ref: searchRef, className: 'dshm-gs-field', type: 'search', value: query,
            placeholder: t('gsSearch'), 'aria-label': t('gsSearch'),
            onChange: event => setQuery(event.target.value) })),
        h('div', { className: 'dshm-gs-seg', role: 'group', 'aria-label': t('gsRules') },
          segBtn('edgeFilterAll', 'all', source, setSource),
          segBtn('edgeFilterAuto', 'auto', source, setSource),
          segBtn('edgeFilterManual', 'manual', source, setSource)),
        h('div', { className: 'dshm-gs-popwrap' },
          h('button', { type: 'button', className: 'dshm-gs-btn', title: t('gsRules'), 'aria-label': t('gsRules'),
            'aria-expanded': String(ruleOpen), onClick: () => setRuleOpen(value => !value) },
          t('gsRules'), h('span', { className: 'dshm-gs-count' }, `${rules.length - rulesOff.size}/${rules.length}`)),
          ruleOpen ? h('div', { className: 'dshm-gs-pop is-open' }, h('h4', null, t('gsRules')),
            rules.length ? rules.map(rule => h('label', { key: rule },
              h('input', { type: 'checkbox', checked: !rulesOff.has(rule), onChange: () => toggleRule(rule) }), graphRuleText(rule, t)))
              : h('p', { className: 'dshm-gs-pop-empty' }, t('gsNoRules'))) : null),
        h('div', { className: 'dshm-gs-spacer' }),
        h('span', { className: 'dshm-gs-themechip', 'aria-pressed': 'true' },
          h('i', { className: 'dshm-gs-dot' }), t('gsLocalData')),
        h('button', { type: 'button', className: 'dshm-gs-btn', title: t('gsExport'), onClick: exportPng }, t('gsExport')),
        h('button', { type: 'button', className: 'dshm-gs-btn dshm-gs-icon', title: t('gsCollapse'),
          'aria-label': t('gsCollapse'), onClick: () => setInspectorOpen(value => !value) }, '⇥'))

      // 力参数弹层贴在 rail 的「图谱设置」按钮正右边，而不是画布右下角。
      const forcePop = h('div', { className: 'dshm-gs-forcepop is-open' },
        h('h4', null, t('gsForce')),
        [['repulsion', 'graphRepulsion', 30, 350, 5], ['distance', 'graphDistance', 40, 220, 5],
          ['center', 'graphCenter', 0, 3, .05]].map(([key, label, min, max, step]) =>
          h('label', { key }, t(label),
            h('input', { type: 'range', min, max, step, value: forces[key], title: t(label), 'aria-label': t(label),
              onChange: event => setForces(value => ({ ...value, [key]: Number(event.target.value) })) }),
            h('output', null, Number(forces[key]).toFixed(2)))),
        h('div', { className: 'dshm-gs-forcepop-toggles' },
          h(Toggle, { checked: labels, label: t('graphLabels'), onChange: setLabels }),
          h(Toggle, { checked: motion, label: t('graphMotion'), onChange: setMotion })),
        h('button', { type: 'button', className: 'dshm-gs-mini', title: t('gsReset'),
          onClick: () => { setForces({ repulsion: 120, distance: 100, center: 0 }); notify(t('gsReset')) } }, t('gsReset')))

      const rail = h('nav', { className: 'dshm-gs-rail', 'aria-label': t('graphView') },
        railBtn('graphZoomIn', '＋', () => zoomBy(1.25)),
        railBtn('graphZoomOut', '−', () => zoomBy(.8)),
        railBtn('graphFit', '⛶', fit),
        h('div', { className: 'dshm-gs-rail-sep' }),
        railBtn('graphLabels', 'Aa', () => setLabels(value => !value), labels),
        railBtn('gsGrid', '#', () => setGrid(value => !value), grid),
        railBtn('gsMinimap', '▭', () => setMinimap(value => !value), minimap),
        railBtn('graphRelayout', '↻', () => { apiRef.current?.relayout?.(); notify(t('graphRelayout')) }),
        h('div', { className: 'dshm-gs-rail-slot' },
          railBtn('graphOptions', '⚙', () => setForceOpen(value => !value), forceOpen),
          forceOpen ? forcePop : null),
        railBtn('graphUnpinAll', '⊘', () => { apiRef.current?.unpinAll?.(); notify(t('graphUnpinAll')) }),
        h('div', { className: 'dshm-gs-rail-sep' }),
        railBtn('gsFocusNode', '◎', () => { if (focus) notify(t('gsFocusNode')); else fit() }),
        h('div', { className: 'dshm-gs-rail-grow' }),
        railBtn('gsHelp', '?', () => notify(t('gsShortcuts'))))

      const legendItems = [
        ['memory', t('gsLegendMemory')], ['must', t('gsLegendMust')],
        ['entity', t('gsLegendEntity')], ['provisional', t('gsLegendPending')],
        ['global', t('gsLegendGlobal')], ['missing', t('gsLegendMissing')],
      ]
      const canvasTools = h('div', { className: 'dshm-gs-canvas-tools' },
        h('div', { className: 'dshm-gs-zoombar' },
          h('button', { type: 'button', title: t('graphZoomOut'), 'aria-label': t('graphZoomOut'), onClick: () => zoomBy(.8) }, '−'),
          h('output', { className: 'dshm-gs-zoomval' }, `${Math.round(zoom * 100)}%`),
          h('button', { type: 'button', title: t('graphZoomIn'), 'aria-label': t('graphZoomIn'), onClick: () => zoomBy(1.25) }, '＋'),
          h('button', { type: 'button', title: t('graphFit'), 'aria-label': t('graphFit'), onClick: fit }, '⛶')),
        h('div', { className: 'dshm-gs-legendwrap' },
          h('button', { type: 'button', className: 'dshm-gs-legendbtn', title: t('gsLegend'),
            'aria-expanded': String(legendOpen), onClick: () => setLegendOpen(value => !value) }, t('gsLegend')),
          legendOpen ? h('div', { className: 'dshm-gs-legendpop is-open' },
            h('h4', null, t('gsNodes')),
            legendItems.map(([kind, label]) => h('div', { key: kind, className: 'dshm-gs-legend-row' },
              h('i', { className: `dshm-gs-swatch dshm-gs-c-${kind}` }), label)),
            h('h4', null, t('gsEdges')),
            h('div', { className: 'dshm-gs-legend-row' }, h('i', { className: 'dshm-gs-line' }), t('gsLegendAuto')),
            h('div', { className: 'dshm-gs-legend-row' }, h('i', { className: 'dshm-gs-line dashed' }), t('gsLegendManual'))) : null))

      const stage = h('main', { className: 'dshm-gs-stage' },
        h(GraphCanvas, { graph: canvasGraph, focus, onFocus: setFocus, t, chrome: false,
          options: canvasOptions, apiRef, onZoom: setZoom, onPaint: () => minimapPaint.current?.() }),
        canvasTools,
        minimap ? h(GraphStudioMinimap, { active: true, t, notifyRef: minimapPaint }) : null,
        h('div', { className: `dshm-gs-toast${toast ? ' show' : ''}`, role: 'status' }, toast),
        error ? h('div', { className: 'dshm-gs-toast show', role: 'alert' }, error) : null,
        !visibleEdges.length && nodes.length
          ? h('div', { className: 'dshm-gs-empty' }, showGlobal ? t('gsGlobalEmpty') : t('gsEmpty')) : null)

      const inspectorBody = selected
        ? h(React.Fragment, null,
          h('div', { className: 'dshm-gs-sec' },
            h('div', { className: 'dshm-gs-hero' },
              h('div', { className: `dshm-gs-glyph dshm-gs-c-${gsKind(selected)}`, 'aria-hidden': 'true' },
                selected.kind === 'memory' ? '●' : '◆'),
              h('div', { className: 'dshm-gs-hero-t' },
                h('h3', null, String(selected.title || selected.id)),
                h('div', { className: 'dshm-gs-tags' },
                  h('span', { className: 'dshm-gs-tag' }, String(selected.kind || 'memory')),
                  selected.layer ? h('span', { className: 'dshm-gs-tag neutral' }, String(selected.layer)) : null,
                  selected.status === 'provisional' ? h('span', { className: 'dshm-gs-tag warn' }, t('gsPending')) : null))),
            h('dl', { className: 'dshm-gs-kv' },
              h('dt', null, 'ID'), h('dd', null, String(selected.id)),
              h('dt', null, t('gsDegree')), h('dd', null, String(degree.get(selected.id) || 0)),
              h('dt', null, t('gsStrength')), h('dd', null, Number(selected.strength || 0).toFixed(2)))),
          h('div', { className: 'dshm-gs-sec' },
            h('div', { className: 'dshm-gs-sec-head' }, h('h3', null, t('relations')),
              h('span', { className: 'dshm-gs-count' }, String(focusEdges.length))),
            h('div', { className: 'dshm-gs-edge-list' }, focusEdges.slice(0, 20).map(edge => {
              const other = edge.from === focus ? edge.to : edge.from
              return h('div', { key: `${edge.from}:${edge.to}:${edge.kind || ''}`, className: 'dshm-gs-edge',
                onClick: () => setFocus(other) },
              h('div', { className: 'dshm-gs-edge-top' },
                h('span', { className: 'dshm-gs-edge-arrow' },
                  `${titles.get(edge.from) || edge.from} → ${titles.get(edge.to) || edge.to}`),
                h('span', { className: 'dshm-gs-conf' }, Number(edge.confidence || 0).toFixed(2))),
              edge.note ? h('p', { className: 'dshm-gs-why' }, String(edge.note)) : null,
              h('div', { className: 'dshm-gs-meta' },
                h('span', { className: `dshm-gs-tag ${edge.source === 'auto' ? 'auto' : 'manual'}` },
                  edge.source === 'auto' ? t('graphAutoLink') : t('edgeFilterManual')),
                edge.rule ? h('span', { className: 'dshm-gs-tag neutral' }, graphRuleText(edge.rule, t)) : null))
            }))),
          showGlobal ? null : h('details', { className: 'dshm-gs-fold' },
            h('summary', null, t('relations')),
            h(RelationshipPanel, { call, libraryId: graphLibrary, entities, files: panelFiles, t })))
        : h(React.Fragment, null,
          h('div', { className: 'dshm-gs-stats' },
            [[t('gsNodes'), nodes.length], [t('gsEdges'), edges.length],
              [t('gsVisible'), visibleEdges.length], [t('gsAutoEdges'), autoCount],
              [t('gsPending'), pendingCount]].map(([label, value]) =>
              h('div', { key: label, className: 'dshm-gs-stat' }, h('b', null, String(value)), h('span', null, label)))),
          h('div', { className: 'dshm-gs-hintbox' }, t('gsShortcuts')),
          h('div', { className: 'dshm-gs-hintbox' }, t('graphPinHint'), ' · ', t('graphScopeHint')))
      const inspector = h('aside', { className: 'dshm-gs-inspector' },
        h('div', { className: 'dshm-gs-ins-head' },
          h('div', { className: 'dshm-gs-ins-title' },
            h('h2', null, t('gsInspector')),
            h('span', { className: 'dshm-gs-count' }, selected ? String(selected.title || selected.id) : t('gsNoSelection'))),
          h('p', null, t('gsInspectorHint'))),
        h('div', { className: 'dshm-gs-ins-body' }, inspectorBody))

      // 管理视图的「连接分支」侧栏：可拖动分隔条调宽度，复刻 HTML 的 br-resizer。
      const startBranchResize = event => {
        event.preventDefault?.()
        const startX = event.clientX || 0, startWidth = branchWidth
        const onMove = moveEvent => setBranchWidth(Math.max(240, Math.min(620, startWidth + startX - (moveEvent.clientX || 0))))
        const onUp = () => {
          window.removeEventListener?.('pointermove', onMove)
          window.removeEventListener?.('pointerup', onUp)
        }
        window.addEventListener?.('pointermove', onMove)
        window.addEventListener?.('pointerup', onUp)
      }
      const branchId = mgrSelected || focus
      const branchNode = nodes.find(node => node.id === branchId) || null
      const tier1 = branchId ? edges.filter(edge => edge.from === branchId || edge.to === branchId)
        .map(edge => ({ id: edge.from === branchId ? edge.to : edge.from, edge })) : []
      const tier1Ids = new Set(tier1.map(item => item.id))
      const tier2 = branchId ? edges.filter(edge => tier1Ids.has(edge.from) || tier1Ids.has(edge.to))
        .map(edge => ({ id: tier1Ids.has(edge.from) ? edge.to : edge.from, edge }))
        .filter(item => item.id !== branchId && !tier1Ids.has(item.id)) : []
      const branchRow = item => {
        const other = nodes.find(node => node.id === item.id) || { kind: 'memory' }
        return h('div', { key: `${item.id}:${item.edge.from}:${item.edge.to}`, className: 'dshm-gs-br-item' },
          h('i', { className: `dshm-gs-br-dot dshm-gs-c-${gsKind(other)}` }),
          h('div', { className: 'dshm-gs-br-col' },
            h('div', { className: 'dshm-gs-br-nm', onClick: () => { setFocus(item.id); setView('graph') } },
              titles.get(item.id) || item.id),
            h('div', { className: 'dshm-gs-br-meta' },
              `${item.edge.kind || 'link'} · ${item.edge.source === 'auto' ? t('graphAutoLink') : t('edgeFilterManual')}`)),
          h('button', { type: 'button', className: 'dshm-gs-mini', title: t('gsLocate'),
            onClick: () => { setFocus(item.id); setView('graph'); setInspectorOpen(true) } }, t('gsLocate')))
      }
      const branchPanel = h('aside', { className: 'dshm-gs-branch' },
        h('div', { className: 'dshm-gs-br-head' },
          h('h3', null, t('gsBranch')), h('p', null, t('gsBranchHint'))),
        h('div', { className: 'dshm-gs-br-body' },
          branchNode ? h(React.Fragment, null,
            h('div', { className: 'dshm-gs-br-hero' },
              h('div', { className: `dshm-gs-glyph dshm-gs-c-${gsKind(branchNode)}` }, '◆'),
              h('div', { className: 'dshm-gs-hero-t' },
                h('b', null, String(branchNode.title || branchNode.id)),
                h('span', null, `${t('gsDegree')} ${degree.get(branchId) || 0}`))),
            h('div', { className: 'dshm-gs-br-sec' },
              h('h4', null, `${t('gsTier1')} (${tier1.length})`),
              tier1.slice(0, 30).map(branchRow)),
            tier2.length ? h('details', { className: 'dshm-gs-fold' },
              h('summary', null, `${t('gsTier2')} (${tier2.length})`),
              tier2.slice(0, 30).map(branchRow)) : null)
            : h('div', { className: 'dshm-gs-br-empty' }, t('gsNoSelection'))))

      const manager = h('section', { className: 'dshm-gs-manager' },
        h('div', { className: 'dshm-gs-mgr-head' },
          h('span', { className: 'dshm-gs-count' }, `${manageRows.length} · ${t('gsNodes')}`),
          h('select', { className: 'dshm-gs-field', value: mgrKind, 'aria-label': t('gsAllKinds'),
            onChange: event => setMgrKind(event.target.value) },
          h('option', { value: '' }, t('gsAllKinds')),
          ['memory', 'person', 'place', 'thing', 'global'].map(kind =>
            h('option', { key: kind, value: kind }, kind))),
          h('select', { className: 'dshm-gs-field', value: mgrStatus, 'aria-label': t('gsAllStatus'),
            onChange: event => setMgrStatus(event.target.value) },
          h('option', { value: '' }, t('gsAllStatus')),
          [['confirmed', 'entityConfirmed'], ['provisional', 'gsPending']].map(([value, label]) =>
            h('option', { key: value, value }, t(label)))),
          h('select', { className: 'dshm-gs-field', value: mgrSort, 'aria-label': t('gsSort'),
            onChange: event => setMgrSort(event.target.value) },
          [['degree', 'gsDegree'], ['strength', 'gsStrength'], ['title', 'gsTitle'], ['id', 'gsNodes']].map(([value, label]) =>
            h('option', { key: value, value }, t(label)))),
          writable ? h('button', { type: 'button', className: `dshm-gs-btn${mgrArmed === removeKey ? ' is-danger' : ''}`,
            title: t('gsRemoveNodeHint'), 'aria-label': t('gsRemoveNode'), disabled: !mgrSelected || mgrBusy,
            onClick: () => { void removeSelected() } },
          mgrArmed === removeKey ? (mgrDeleteRefused === mgrSelected ? t('relationConfirm') + '!' : t('confirmDelete')) : t('gsRemoveNode')) : null,
          writable ? h('button', { type: 'button', className: 'dshm-gs-btn', title: t('gsEditNode'),
            'aria-label': t('gsEditNode'), disabled: !mgrSelected || mgrBusy || editBusy,
            onClick: () => { void editNode() } }, t('gsEditNode')) : null,
          writable ? h('button', { type: 'button', className: 'dshm-gs-btn', title: t('gsAddNode'),
            'aria-expanded': String(addOpen), onClick: () => { setEditOpen(false); setEditDraft(null); setAddOpen(value => !value) } }, t('gsAddNode')) : null,
          h('button', { type: 'button', className: 'dshm-gs-btn', title: t('gsExport'), onClick: exportPng }, t('gsExport'))),
        addOpen && writable ? h('div', { className: 'dshm-gs-mgr-add' },
          h('select', { className: 'dshm-gs-field', value: addTargetLib, title: t('gsAddLibrary'), 'aria-label': t('gsAddLibrary'),
            onChange: event => setAddLib(event.target.value) },
          (mergedScope ? libraries : libraries.filter(lib => lib.id === addTargetLib))
            .map(lib => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries)))),
          h('div', { className: 'dshm-gs-seg', role: 'group', 'aria-label': t('gsAddNode') },
            h('button', { type: 'button', 'aria-pressed': String(draft.type === 'memory'),
              onClick: () => setDraft(value => ({ ...value, type: 'memory' })) }, t('gsNodeMemory')),
            h('button', { type: 'button', 'aria-pressed': String(draft.type === 'entity'),
              onClick: () => setDraft(value => ({ ...value, type: 'entity' })) }, t('gsNodeEntity'))),
          draft.type === 'memory'
            ? h('input', { className: 'dshm-gs-field', value: draft.title, placeholder: t('memoryTitle'), 'aria-label': t('memoryTitle'),
              onChange: event => setDraft(value => ({ ...value, title: event.target.value })) })
            : h('input', { className: 'dshm-gs-field', value: draft.name, placeholder: t('entityName'), 'aria-label': t('entityName'),
              onChange: event => setDraft(value => ({ ...value, name: event.target.value })) }),
          draft.type === 'memory'
            ? h('select', { className: 'dshm-gs-field', value: draft.layer, 'aria-label': t('gsLayer'),
              onChange: event => setDraft(value => ({ ...value, layer: event.target.value })) },
            ['long_term', 'short_term', 'must_remember'].map(layer => h('option', { key: layer, value: layer }, enumText(t, LAYER_LABELS, layer))))
            : h('select', { className: 'dshm-gs-field', value: draft.kind, 'aria-label': t('gsKind'),
              onChange: event => setDraft(value => ({ ...value, kind: event.target.value })) },
            ['person', 'place', 'thing', 'org'].map(kind => h('option', { key: kind, value: kind }, kind))),
          h('div', { className: 'dshm-gs-add-actions' },
            h('button', { type: 'button', className: 'dshm-gs-btn', disabled: !canAdd, onClick: () => { void addNode() } }, t('add')),
            h('button', { type: 'button', className: 'dshm-gs-btn', onClick: () => setAddOpen(false) }, t('cancelDelete'))),
          draft.type === 'memory'
            ? h('textarea', { className: 'dshm-gs-field', value: draft.content, placeholder: t('memoryContent'), 'aria-label': t('memoryContent'),
              onChange: event => setDraft(value => ({ ...value, content: event.target.value })) })
            : null) : null,
        editOpen && editDraft ? h('div', { className: 'dshm-gs-mgr-add' },
          h('select', { className: 'dshm-gs-field', value: editDraft.libraryId, disabled: true, title: t('gsAddLibrary'), 'aria-label': t('gsAddLibrary') },
            h('option', { value: editDraft.libraryId },
              libraryOptionLabel(libraries.find(lib => lib.id === editDraft.libraryId) || { id: editDraft.libraryId }, libraries))),
          h('div', { className: 'dshm-gs-seg', role: 'group', 'aria-label': t('gsEditNode') },
            h('button', { type: 'button', 'aria-pressed': 'true', disabled: true },
              editDraft.kind === 'memory' ? t('gsNodeMemory') : t('gsNodeEntity'))),
          editDraft.kind === 'memory'
            ? h('input', { className: 'dshm-gs-field', value: editDraft.title, placeholder: t('memoryTitle'), 'aria-label': t('memoryTitle'),
              onChange: event => setEditDraft(value => ({ ...value, title: event.target.value })) })
            : h('input', { className: 'dshm-gs-field', value: editDraft.name, placeholder: t('entityName'), 'aria-label': t('entityName'),
              onChange: event => setEditDraft(value => ({ ...value, name: event.target.value })) }),
          editDraft.kind === 'memory'
            ? h('select', { className: 'dshm-gs-field', value: editDraft.layer, 'aria-label': t('gsLayer'),
              onChange: event => setEditDraft(value => ({ ...value, layer: event.target.value })) },
            editLayers.map(layer => h('option', { key: layer, value: layer }, enumText(t, LAYER_LABELS, layer))))
            : h('input', { className: 'dshm-gs-field', value: editDraft.aliases, placeholder: t('entityAliases'), 'aria-label': t('entityAliases'),
              onChange: event => setEditDraft(value => ({ ...value, aliases: event.target.value })) }),
          h('div', { className: 'dshm-gs-add-actions' },
            h('button', { type: 'button', className: 'dshm-gs-btn', disabled: !canSave, onClick: () => { void saveEdit() } }, t('save')),
            h('button', { type: 'button', className: 'dshm-gs-btn', onClick: () => { setEditOpen(false); setEditDraft(null) } }, t('cancelDelete'))),
          editDraft.kind === 'memory'
            ? h('textarea', { className: 'dshm-gs-field', value: editDraft.content, placeholder: t('memoryContent'), 'aria-label': t('memoryContent'),
              onChange: event => setEditDraft(value => ({ ...value, content: event.target.value })) })
            : null) : null,
        h('div', { className: 'dshm-gs-mgr-body', style: { '--gs-br-w': `${branchWidth}px` } },
          h('div', { className: 'dshm-gs-mgr-scroll' },
            h('div', { className: 'dshm-gs-mgr-thead' },
            h('span', null, ''), h('span', null, 'ID'), h('span', null, t('gsTitle')),
            h('span', null, t('gsKind')), h('span', null, t('gsStatus')), h('span', null, t('gsLayer')),
            h('span', { className: 'num' }, t('gsDegree')), h('span', { className: 'num' }, t('gsStrength')),
            h('span', null, t('gsAction'))),
          manageRows.length ? manageRows.slice(0, 300).map(node => h('div', {
            key: node.id, className: `dshm-gs-mgr-row${mgrSelected === node.id ? ' sel' : ''}`,
            onClick: () => { setMgrSelected(node.id); setEditOpen(false); setEditDraft(null) },
          },
          h('span', { className: 'dshm-gs-mgr-dot' }, h('i', { className: `dshm-gs-swatch dshm-gs-c-${gsKind(node)}` })),
          h('span', { className: 'dshm-gs-mgr-id' }, String(node.id).slice(0, 8)),
          h('span', { className: 'dshm-gs-mgr-title' }, String(node.title || node.id)),
          h('span', null, String(node.kind || 'memory')),
          // 记忆条目写入即生效，没有「待确认」概念；只有实体才会是 provisional。
          h('span', null, node.status === 'provisional' ? t('gsPending')
            : node.kind === 'memory' || node.status === 'confirmed' ? t('gsConfirmed') : '—'),
          h('span', null, node.layer ? enumText(t, LAYER_LABELS, node.layer) : '—'),
          h('span', { className: 'num' }, String(degree.get(node.id) || 0)),
          h('span', { className: 'num' }, Number(node.strength || 0).toFixed(2)),
          h('span', { className: 'dshm-gs-mgr-ops' },
            h('button', { type: 'button', className: 'dshm-gs-mini', title: t('gsViewBranch'),
              onClick: event => { event.stopPropagation(); setMgrSelected(node.id); setView('manage') } }, t('gsViewBranch')),
            h('button', { type: 'button', className: 'dshm-gs-mini', title: t('gsLocate'),
              onClick: event => { event.stopPropagation(); setFocus(node.id); setView('graph'); setInspectorOpen(true) } }, t('gsLocate')))))
            : h('div', { className: 'dshm-gs-mgr-empty' }, t('gsNoMatch'))),
          h('button', { type: 'button', className: 'dshm-gs-br-resizer', title: t('gsResize'),
            'aria-label': t('gsResize'), onPointerDown: startBranchResize }),
          branchPanel),
        h('div', { className: 'dshm-gs-mgr-foot' },
          h('span', null, mgrSelected || '—'),
          h('div', { className: 'dshm-gs-spacer' }),
          h('button', { type: 'button', className: 'dshm-gs-btn', disabled: !mgrSelected,
            onClick: () => { setFocus(mgrSelected); setView('graph'); setInspectorOpen(true) } }, t('gsLocate')),
          h('button', { type: 'button', className: 'dshm-gs-btn primary', onClick: () => setView('graph') }, t('graphView'))))

      const status = h('footer', { className: 'dshm-gs-status' },
        h('span', { className: 'dshm-gs-live' }, h('i'), t('gsLocalData')),
        h('span', { className: 'dshm-gs-status-sep' }),
        h('span', null, t('gsNodes'), ' ', h('b', null, String(nodes.length))),
        h('span', null, t('gsEdges'), ' ', h('b', null, String(edges.length))),
        h('span', null, t('gsVisible'), ' ', h('b', null, String(visibleEdges.length))),
        h('span', null, t('gsAutoEdges'), ' ', h('b', null, String(autoCount))),
        h('span', null, t('gsPending'), ' ', h('b', null, String(pendingCount))),
        h('span', { className: 'dshm-gs-status-right' }, t('gsRender'), ' ', h('b', null, '—'),
          ' · ', t('graphPinHint')))

      return h('div', { className: `dshm-gs${inspectorOpen ? '' : ' is-collapsed'}${view === 'manage' ? ' is-manage' : ''}${minimap ? ' show-minimap' : ''}` },
        topbar, rail, stage, inspector, manager, status)
    }
    function GraphPanel({ call, libraryId, files, t, global = false }) {
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
      // 工单 F：实体合并候选。后端只出建议，合并必须由用户逐条确认；候选读失败不影响
      // 图谱其余部分，所以单独 catch 成空列表。
      const [merges, setMerges] = React.useState([])
      const [mergeNotice, setMergeNotice] = React.useState('')
      // 待确认实体（DESIGN §9.2）：候选只排队列；确认动作才会补挂提及边。
      const [anchor, setAnchor] = React.useState(null)
      const [anchorKinds, setAnchorKinds] = React.useState({})
      const [anchorPicked, setAnchorPicked] = React.useState(() => new Set())
      const [anchorBusy, setAnchorBusy] = React.useState(false)
      // 边来源筛选 + “删除全部自动边”的二次确认（§10）。
      const [edgeFilter, setEdgeFilter] = React.useState('all')
      const [purgeArmed, setPurgeArmed] = React.useState(false)
      const [clearArmed, setClearArmed] = React.useState(false)
      const [error, setError] = React.useState('')
      const requestId = React.useRef(0)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; requestId.current++ }
      }, [])
      const refresh = React.useCallback(async () => {
        const id = ++requestId.current
        // Global edges live inside the global index and have no entities or merge
        // candidates, so the whole read is one call and the panel stays read-only.
        if (global) {
          try {
            const next = await call('getGraph', { scope: 'global', focusId: focus || null, depth: 2, limit: 200 })
            if (mounted.current && id === requestId.current) {
              setGraph(next); setEntities([]); setMerges([]); setError('')
            }
          } catch (error) {
            if (mounted.current && id === requestId.current) setError(String(error?.message || error))
          }
          return
        }
        const [next, list, suggested, queue] = await Promise.all([
          call('getGraph', { libraryId, focusId: focus || null, depth: 2, limit: 200 }),
          call('listEntities', { libraryId }),
          call('suggestEntityMerges', { libraryId }).catch(() => null),
          call('getAnchorCandidates', { libraryId }).catch(() => null),
        ])
        if (mounted.current && id === requestId.current) {
          setGraph(next); setEntities(list.items || []); setMerges(suggested?.items || []); setAnchor(queue || null); setError('')
        }
      }, [call, libraryId, focus, global])
      React.useEffect(() => {
        let active = true
        if (libraryId || global) refresh().catch(error => { if (active) setError(String(error.message || error)) })
        return () => { active = false; requestId.current++ }
      }, [refresh, files, global])
      // Switching libraries must not keep a selection that belongs to another one.
      React.useEffect(() => { setAnchorPicked(new Set()) }, [libraryId])
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
      // 合并影响面要说清"多少条链接改了指向"，比普通错误停留更久。
      React.useEffect(() => {
        if (!mergeNotice) return undefined
        const timer = setTimeout(() => setMergeNotice(''), 9000)
        return () => clearTimeout(timer)
      }, [mergeNotice])
      React.useEffect(() => {
        if (!purgeArmed) return undefined
        const timer = setTimeout(() => setPurgeArmed(false), 2500)
        return () => clearTimeout(timer)
      }, [purgeArmed])
      React.useEffect(() => {
        if (!clearArmed) return undefined
        const timer = setTimeout(() => setClearArmed(false), 2500)
        return () => clearTimeout(timer)
      }, [clearArmed])
      const act = async (method, payload) => {
        try {
          await call(method, { libraryId, ...payload })
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) await refresh()
        } catch (error) { if (mounted.current) setError(String(error.message || error)) }
      }
      const entityLabel = (id) => {
        const found = entities.find(item => item.id === id)
        return found ? (found.name || found.id) : id
      }
      const doMerge = async (item) => {
        try {
          const result = await call('mergeEntities', { libraryId, targetId: item.targetId, sourceIds: [item.sourceId] })
          let message = t('entityMergeDone')
            .replace('{from}', entityLabel(item.sourceId))
            .replace('{to}', entityLabel(item.targetId))
            .replace('{links}', String(result?.remappedLinks ?? 0))
            .replace('{aliases}', String((result?.aliases || []).length))
          const dropped = (result?.droppedAliases || []).length
          if (dropped) message += ' ' + t('entityMergeDropped').replace('{n}', String(dropped))
          const conflicts = (result?.relationships?.conflicts || []).length
          if (conflicts) message += ' ' + t('entityMergeConflict').replace('{n}', String(conflicts))
          setArmed('')
          setMergeNotice(message)
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) await refresh()
        } catch (failure) { if (mounted.current) setError(String(failure.message || failure)) }
      }
      // Confirm is the only action that changes an entity's status. It also runs
      // the incremental mention pass on the server, so the graph below updates
      // with the new edges in the same round trip.
      const confirmEntityIds = async (ids) => {
        const wanted = (Array.isArray(ids) ? ids : []).filter(Boolean)
        if (!wanted.length || anchorBusy) return
        setAnchorBusy(true)
        try {
          const result = await call('confirmEntities', { libraryId, entityIds: wanted })
          notifyMemoryWrite('relation', libraryId)
          setAnchorPicked(new Set())
          if (mounted.current) {
            await refresh()
            if (result?.confirmed?.length) setMergeNotice(t('anchorConfirmedDone').replace('{n}', String(result.confirmed.length)))
          }
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message || failure))
        } finally {
          if (mounted.current) setAnchorBusy(false)
        }
      }
      const confirmCandidate = async (row) => {
        if (!row || anchorBusy) return
        if (row.entityId) { if (row.entityStatus === 'provisional') await confirmEntityIds([row.entityId]); return }
        setAnchorBusy(true)
        try {
          await call('createEntity', { libraryId, name: row.term, kind: anchorKinds[row.term] || 'person' })
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) { await refresh(); setMergeNotice(t('anchorConfirmedDone').replace('{n}', '1')) }
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message || failure))
        } finally {
          if (mounted.current) setAnchorBusy(false)
        }
      }
      const purgeAuto = async () => {
        if (!purgeArmed) { setPurgeArmed(true); return }
        setPurgeArmed(false)
        try {
          const result = await call('purgeAutoLinks', { libraryId })
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) {
            await refresh()
            setMergeNotice(t('purgeAutoDone').replace('{n}', String(result?.removed ?? 0)))
          }
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message || failure))
        }
      }
      const clearSuppressionNow = async () => {
        if (!clearArmed) { setClearArmed(true); return }
        setClearArmed(false)
        try {
          const result = await call('clearLinkSuppression', { libraryId })
          notifyMemoryWrite('relation', libraryId)
          if (mounted.current) {
            await refresh()
            setMergeNotice(t('clearSuppressionDone').replace('{n}', String(result?.cleared ?? 0)))
          }
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message || failure))
        }
      }
      const titles = new Map(graph.nodes.map(node => [node.id, node.missing ? t('deletedNode') : node.title]))
      const focusEdges = graph.edges.filter(edge => !focus || edge.from === focus || edge.to === focus).sort((a, b) => b.confidence - a.confidence)
      const edges = focusEdges.filter(edge => edgeFilter === 'all'
        || (edgeFilter === 'auto' ? edge.source === 'auto' : edge.source !== 'auto'))
      const canvasGraph = { ...graph, edges }
      if (global) {
        return h('div', null,
          error ? h('div', { className: 'dshm-toast', role: 'status' }, error) : null,
          h('div', { className: 'dshm-graph-tools' },
            h('select', { value: focus, title: t('focusMemory'), onChange: event => setFocus(event.target.value) },
              h('option', { value: '' }, t('focusMemory')),
              files.map(file => h('option', { key: file.id, value: file.id }, file.title || file.id)))),
          graph.truncated ? h('p', null, t('graphLimited')) : null,
          h('div', { className: 'dshm-graph-stage' },
            h(GraphCanvas, { key: 'global', graph: canvasGraph, focus, onFocus: setFocus, t }),
            h('div', { className: 'dshm-graph-list' }, edges.length ? edges.map(edge => h('div', { key: edge.from + edge.to + edge.kind, className: 'dshm-graph-edge' },
              h('div', null,
                h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.from) }, titles.get(edge.from) || edge.from),
                ' → ',
                h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.to) }, titles.get(edge.to) || edge.to),
                h('small', null, edge.kind + ' · ' + Math.round(edge.confidence * 100) + '% · ' + edge.note)))
            ) : h(Empty, null, t('graphEmpty')))),
          h('p', { style: S.muted }, t('graphGlobalReadonly')))
      }
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
              h('option', { key: file.id, value: file.id }, file.title || file.id))),
          h('select', { value: edgeFilter, title: t('edgeFilterAll'), onChange: event => setEdgeFilter(event.target.value) },
            h('option', { value: 'all' }, t('edgeFilterAll')),
            h('option', { value: 'auto' }, t('edgeFilterAuto')),
            h('option', { value: 'manual' }, t('edgeFilterManual'))),
          h(Button, {
            disabled: anchorBusy || !graph.edges.some(edge => edge.source === 'auto'),
            style: purgeArmed ? { ...S.btn, color: V.danger, borderColor: V.danger } : S.ghost,
            onClick: () => void purgeAuto(),
          }, purgeArmed ? t('purgeAutoConfirm') : t('purgeAutoLinks')),
          h(Button, {
            disabled: anchorBusy,
            style: clearArmed ? { ...S.btn, color: V.danger, borderColor: V.danger } : S.ghost,
            onClick: () => void clearSuppressionNow(),
          }, clearArmed ? t('clearSuppressionConfirm') : t('clearSuppression'))),
        graph.truncated ? h('p', null, t('graphLimited')) : null,
        // The canvas and the adjacency list are one view: the picture shows the
        // shape, the list keeps the reasons readable and clickable. Neither is an
        // alternate mode, so there is no toggle to forget.
        h('div', { className: 'dshm-graph-stage' },
          h(GraphCanvas, { key: libraryId, graph: canvasGraph, focus, onFocus: setFocus, t }),
          h('div', { className: 'dshm-graph-list' }, edges.length ? edges.map(edge => h('div', { key: edge.from + edge.to + edge.kind, className: 'dshm-graph-edge' },
            h('div', null, h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.from) }, titles.get(edge.from) || edge.from),
              ' → ', h('button', { type: 'button', className: 'dshm-graph-node', onClick: () => setFocus(edge.to) }, titles.get(edge.to) || edge.to),
              // 私有自动关联（§5.7）：source:'auto' 的边来自算法/实体枢纽，不是用户手连。
              // 只多一个可点读的小 Tag；kind/confidence/note 与移除按钮保持原样。
              edge.source === 'auto' ? h('span', { style: { margin: '0 5px', verticalAlign: 'middle' } }, h(Tag, { tone: 'info' }, t('graphAutoLink'))) : null,
              // §10：自动边要能说清“为什么”——规则 + 命中的表面/字段。
              // 老自动边没有 evidence.rule，用 edge.rule 的 'auto' 兜底标签。
              edge.rule ? h('span', { style: { margin: '0 5px', verticalAlign: 'middle' } }, h(Tag, null, graphRuleText(edge.rule, t))) : null,
              edge.evidence?.surface ? h('span', { style: { ...S.muted, fontSize: 11, marginRight: 5 } },
                `「${edge.evidence.surface}」${edge.evidence.field || ''}${Number.isInteger(edge.evidence.offset) ? ' @' + edge.evidence.offset : ''}`) : null,
              edge.evidence?.field && !edge.evidence?.surface ? h('span', { style: { ...S.muted, fontSize: 11, marginRight: 5 } }, edge.evidence.field) : null,
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
        // 工单 F：合并候选只列出来，永不自动合并。两次点击确认沿用删除的 armed 模式，
        // 合并后的影响面（改指多少条链接、并入多少别名）用一行回执说清。
        mergeNotice ? h('div', { style: { ...S.muted, marginTop: 6, color: V.accent }, role: 'status' }, mergeNotice) : null,
        merges.length ? h('div', { style: { margin: '10px 0' } },
          h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('entityMergeTitle')),
          h('div', { style: { ...S.muted, margin: '4px 0 6px', lineHeight: 1.5 } }, t('entityMergeHint')),
          merges.map(item => {
            const key = 'merge:' + item.sourceId + '>' + item.targetId
            return h('div', { key, className: 'dshm-graph-tools' },
              h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, entityLabel(item.sourceId) + ' → ' + entityLabel(item.targetId)),
              h(Tag, { tone: 'info' }, item.reason === 'containment' ? t('mergeReasonContainment') : t('mergeReasonDistance')),
              h(Button, {
                style: armed === key ? { ...S.btn, color: V.danger, borderColor: V.danger } : S.btn,
                title: t('entityMergeHint'),
                onClick: () => { if (armed !== key) { setArmed(key); return } void doMerge(item) },
              }, armed === key ? t('entityMergeConfirm') : t('entityMergeAction')))
          })) : null,
        // 待确认实体（DESIGN §9.2）：候选只排队列、不改状态；确认后才补挂提及边。
        (() => {
          const provisional = entities.filter(entity => entity.status === 'provisional')
          const tiers = anchor?.tiers || { tier1: [], tier2: [] }
          const visible = (list) => (Array.isArray(list) ? list : []).filter(row => row.entityStatus !== 'confirmed')
          const tier1 = visible(tiers.tier1)
          const tier2 = visible(tiers.tier2)
          if (!provisional.length && !tier1.length && !tier2.length) {
            return h('div', { style: { margin: '10px 0' } },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('anchorReviewTitle')),
              h('div', { style: { ...S.muted, margin: '4px 0 0' } }, t('anchorNoCandidates')))
          }
          const kindOptions = ['person', 'place', 'thing', 'org']
          const candidateRow = (row) => {
            const archived = row.entityStatus === 'archived'
            return h('div', { key: 'cand:' + row.term, className: 'dshm-graph-tools', style: { alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { minWidth: 0, overflowWrap: 'anywhere', fontWeight: 600 } }, row.term),
              row.quoted ? h(Tag, { tone: 'info' }, t('anchorSignalQuote')) : null,
              row.intro ? h(Tag, { tone: 'info' }, t('anchorSignalIntro')) : null,
              row.mixed ? h(Tag, { tone: 'info' }, t('anchorSignalMixed')) : null,
              archived ? h(Tag, { tone: 'warn' }, t('anchorArchivedEntity')) : null,
              row.entityId && !archived ? h(Tag, null, t('anchorExistingEntity')) : null,
              h('span', { style: { ...S.muted, fontSize: 11, whiteSpace: 'nowrap' } },
                t('anchorStats').replace('{df}', String(row.df)).replace('{cohesion}', String(row.cohesion)).replace('{freedom}', String(row.freedom))),
              archived ? null : (row.entityId
                ? (row.entityStatus === 'provisional'
                  ? h(Button, { disabled: anchorBusy, onClick: () => void confirmEntityIds([row.entityId]) }, t('anchorConfirm'))
                  : null)
                : h(React.Fragment, null,
                    h('select', {
                      value: anchorKinds[row.term] || 'person', title: t('entityKind'),
                      onChange: event => setAnchorKinds(prev => ({ ...prev, [row.term]: event.target.value })),
                      style: { ...S.input, width: 'auto' },
                    }, kindOptions.map(kind => h('option', { key: kind, value: kind }, kind))),
                    h(Button, { disabled: anchorBusy, onClick: () => void confirmCandidate(row) }, t('anchorConfirm')))))
          }
          return h('div', { style: { margin: '10px 0' } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('anchorReviewTitle') + (provisional.length ? ` (${provisional.length})` : '')),
            h('div', { style: { ...S.muted, margin: '4px 0 6px', lineHeight: 1.5 } }, t('anchorReviewHint')),
            provisional.length
              ? h('div', null,
                  provisional.map(entity => {
                    const picked = anchorPicked.has(entity.id)
                    return h('label', { key: 'pending:' + entity.id, className: 'dshm-graph-tools', style: { alignItems: 'center', cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox', checked: picked,
                        // .dshm-graph-tools input stretches text fields; a checkbox must not.
                        style: { flex: 'none', width: 16, height: 16, margin: 0, padding: 0 },
                        onChange: () => setAnchorPicked(prev => {
                          const next = new Set(prev)
                          if (picked) next.delete(entity.id); else next.add(entity.id)
                          return next
                        }),
                      }),
                      h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, entity.name),
                      h(Tag, null, entity.kind || 'person'),
                      h(Tag, { tone: 'info' }, t('anchorPendingEntity')))
                  }),
                  h(Button, {
                    disabled: anchorBusy || anchorPicked.size === 0,
                    onClick: () => void confirmEntityIds([...anchorPicked]),
                  }, t('anchorConfirmSelected').replace('{n}', String(anchorPicked.size))))
              : null,
            tier1.length ? h('div', { style: { marginTop: 8 } },
              h('div', { style: { ...S.muted, fontSize: 11 } }, t('anchorTier1')),
              tier1.map(candidateRow)) : null,
            tier2.length ? h('details', { style: { marginTop: 6 } },
              h('summary', { style: { cursor: 'pointer', fontSize: 12, color: V.textDim } }, t('anchorTier2') + ` (${tier2.length})`),
              tier2.map(candidateRow)) : null,
            h('div', { style: { ...S.muted, marginTop: 6, lineHeight: 1.5, fontSize: 11 } }, t('anchorCreateHint') + ' ' + t('anchorKindHint')))
        })(),
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
      // Library switches can overlap: the host does not order RPC replies, so a
      // slow answer for the previous library must not repaint the wall after the
      // reader already picked another one.
      const browseRequest = React.useRef(0)
      // 二次确认不能无限期挂着：照 LexiconPanel / SettingsPage 的口径 2.5s 自动复原，
      // 切池/层级/查询时立即失效，避免回来一次点击就批量删除。
      React.useEffect(() => {
        if (!deleteArmedMulti) return undefined
        const timer = setTimeout(() => setDeleteArmedMulti(false), 2500)
        return () => clearTimeout(timer)
      }, [deleteArmedMulti])
      React.useEffect(() => { setDeleteArmedMulti(false) }, [pool, layer, query])
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
        const requestId = ++browseRequest.current
        const current = () => alive && requestId === browseRequest.current
        const load = async () => {
          try {
            const value = await call('browseWall', { libraryId: libraryId || null, limit: 300 })
            if (!current()) return
            setData(value)
            setError('')
          } catch (failure) {
            if (!current()) return
            const message = String(failure?.message || failure)
            // 宿主对“全部记忆库”多库读取返回 403（browseWall 无法表达为单库授权）时，
            // 退到第一个库并明确告知；单库 + 全局（browseWall 总会带全局）仍能出数据，
            // 不再整页空。用户可手动切换库；多库选项保留为禁用。
            if (!libraryId && firstLibraryId && /forbidden|403/i.test(message)) {
              try {
                const value = await call('browseWall', { libraryId: firstLibraryId, limit: 300 })
                // A newer selection owns the wall now; do not force the reader
                // back to the first library from a fallback they did not ask for.
                if (!current()) return
                setData(value)
                setError('')
                setMultiBlocked(true)
                setLibraryId(firstLibraryId)
                return
              } catch (fallbackFailure) {
                if (current()) setError(String(fallbackFailure?.message || fallbackFailure))
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
      const keyOf = item => (item.libraryId || 'global') + ':' + item.id
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
          await call('deleteMemory', { libraryId: current.item.libraryId, id: current.item.id, confirmed: true })
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
            if (action === 'delete') await call('deleteMemory', { libraryId: item.libraryId, id: item.id, confirmed: true })
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
      // 详情抽屉与卡片共用同一份情绪行：四轴构成 + 激活/掌控/来源，缺哪段就少哪段。
      const affectText = shown
        ? [emotionTagText(shown.emotion) ? `${t('moodTag')} ${emotionTagText(shown.emotion)}` : '', emotionMetaText(shown, t)]
          .filter(Boolean).join(' · ')
        : ''
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
            h('div', { className: 'dshm-drawer-switch' },
              h(Toggle, {
                checked: detail.draft.openLoop === true,
                label: t('openLoopTag'),
                onChange: (value) => patchDraft({ openLoop: value }),
              }),
              h('span', null, t('openLoopTag')))),
          h('div', { className: 'dshm-drawer-note' },
            t('decay') + ' ' + Math.round((Number(shown.decay) || 0) * 100) + '% · ' +
            (shown.updatedAt ? String(shown.updatedAt).slice(0, 16).replace('T', ' ') : '')),
          affectText ? h('div', { className: 'dshm-drawer-note' }, affectText) : null)
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
        error || data.errors?.length ? h('p', { className: 'dshm-error', role: 'alert' }, error || t('wallReadError')) : null,
        h(React.Fragment, null,
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
    // 全局词典的保留存储名，与服务端 lib/lexicon.js 的 GLOBAL_LEXICON_ID 同一个值：
    // 私有库 id 恒为 `lib_<hex>`，所以它不可能撞上某本私有库。
    const GLOBAL_LEXICON_ID = 'global'
    const EMPTY_LEXICON_DRAFT = { term: '', kind: 'term', meaning: '', usage: '', aliases: '', examples: '' }

    // 词典页（§2.4）：公开生命周期只有 active / archived，卡片流对齐记忆墙的
    // 交互约定（筛选/分页都在 RPC 侧完成，每页 50 条，客户端不缓存全量），但没有审核
    // ——模型写入直接生效，用户只做编辑 / 归档 / 恢复 / 删除。归档与恢复可逆、一击
    // 生效；删除是管理面独有的永久动作，两段确认。带 sourceMemoryId 的词条可跳回
    // 记忆墙对应条目（wallFocus 接力棒，见 SettingsPage）。
    // 作用域选择器与记忆墙节点图同一个做法：「全局词典」是选择器里的第一项，不是一个
    // 私有库，所以没有库时这一页照样可用（全局词典由用户手写，不依赖任何库）。
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

      const activeLib = libraryId || libraries[0]?.id || GLOBAL_LEXICON_ID
      const isGlobalLib = activeLib === GLOBAL_LEXICON_ID
      const emptyView = { items: [], total: 0, page: 1, pages: 1, counts: {}, statusCounts: { active: 0, archived: 0 } }
      const loadSeq = React.useRef(0)
      const load = React.useCallback(async () => {
        if (!activeLib) { setData(emptyView); return }
        const seq = ++loadSeq.current
        setBusy(true)
        try {
          // 只取当前页、当前页签：状态页签、kind、搜索、分页全在 RPC 侧收窄，
          // 客户端不缓存任何全量词条列表。翻页/新建后并发的旧请求用代次抑制。
          const res = await call('lexiconList', {
            libraryId: activeLib, sessionId: sessionId || undefined, page, pageSize: 50,
            status, kind: kind || undefined, q: query || undefined,
          })
          if (seq !== loadSeq.current) return
          setData(res || emptyView)
          setError('')
        } catch (e) {
          if (seq !== loadSeq.current) return
          setError(String(e?.message || e))
        } finally {
          if (seq === loadSeq.current) setBusy(false)
        }
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
            onClick: () => onFocusMemory?.({ id: e.sourceMemoryId, libraryId: isGlobalLib ? null : activeLib, title: e.term || e.id, at: Date.now() }),
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
            // value 用 activeLib 而不是 libraryId：没选过也要显示真正在看的这一本
            // （没有私有库时就是全局词典），否则选择器和数据会各说各话。
            style: { ...S.input, flex: 1 }, value: activeLib,
            title: isGlobalLib ? t('lexiconGlobalScope') : (libraries.find((lib) => lib.id === activeLib)?.scopeKey || t('currentLibrary')),
            onChange: (e) => changeLibrary(e.target.value),
          },
          h('option', { value: GLOBAL_LEXICON_ID }, t('lexiconGlobalScope')),
          libraries.map((lib) => h('option', { key: lib.id, value: lib.id }, libraryOptionLabel(lib, libraries))))),
        // 口径说明（样式与记忆设置页的开关说明同一款）：浏览只看一本，注入与模型检索
        // 按召回作用域合并——不解释清楚，用户会以为「跨库了却没看见别的库的词」。
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } },
          isGlobalLib ? t('lexiconGlobalHint') : t('lexiconBrowseScopeHint')),
        libraries.length === 0 ? h('div', { style: { ...S.muted, marginTop: 4 } }, t('lexiconNoLibrary')) : null,
        h(React.Fragment, null, statusTabs, countsRow, filterRow, multiBar, newForm,
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
        // graph:10 插在 memories 之后；后续页顺延，三处清单（SETTINGS_PAGES /
        // PAGE_NAMES / PAGE）必须同序，否则导航会整片错位。
        graph: 10,
        logs: 11,
        lexicon: 12,
        help: 13,
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
      // 每张卡片各自记下载来源；没选过就用目录的默认顺序（第一个已固定的 provider）。
      const [vectorProvider, setVectorProvider] = React.useState({})
      const [runtimeSource, setRuntimeSource] = React.useState('')
      // Polling gives us bytes every 2.5s; this turns consecutive samples into a
      // client-side MB/s fallback when the backend has not produced one yet.
      const progressSpeedRef = React.useRef(new Map())
      // 全局记忆页"查看此记忆"的接力棒：带着 id 切到 MemU 记忆页，墙直接开对应抽屉。
      const [wallFocus, setWallFocus] = React.useState(null)
      // 关系图谱是沉浸式页面：默认解除 980px 宽度锁，用户还能收起左导航腾满宽度。
      const [graphNavHidden, setGraphNavHidden] = React.useState(false)
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
      // 保存失败的 patch 单独存放：绝不放回 pending（否则 adoptState 每次心跳把
      // 失败值盖到服务端返回值上，永远回滚不了），并驱动一个不自动消失的标记。
      const [failedPatch, setFailedPatch] = React.useState(null)
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
      // Same stale-reply guard as the wall: the browser page can be pointed at a
      // different library while its previous request is still in flight.
      const browseLibraryRequest = React.useRef(0)
      const reviewsRequest = React.useRef(0)
      const statsRequest = React.useRef(0)
      const [browseDraft, setBrowseDraft] = React.useState({})
      const [browseBusy, setBrowseBusy] = React.useState(false)
      // 'active' | 'archived'. Archiving used to be a one-way door in the UI: the entry
      // stayed in the same list with a different tag, so the mess you were trying to
      // tidy up never actually left. Two lists, and only the archived one offers delete.
      const [browseView, setBrowseView] = React.useState('active')
      // 当前库内的即时过滤：列表本来就已取回（browseLibrary），不再加一次 RPC。
      const [browseQuery, setBrowseQuery] = React.useState('')
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
      // 整理 fork 的宿主模型目录（listForkModelOptions）：切到 host/custom 时懒加载一次并
      // 缓存。失败只置 error 状态，相关行降级为手填输入——用户不被卡死。
      const [forkCatalog, setForkCatalog] = React.useState(null)
      const [forkCatalogState, setForkCatalogState] = React.useState('idle')
      // custom 模式的 key 草稿：密码框只养草稿，留空或删光都不覆盖已存的 key
      //（后端 updateSettings 对空串的语义是「清空」，所以 UI 只在有输入时才写）。
      const [forkKeyDraft, setForkKeyDraft] = React.useState('')
      const [forkDiscoverBusy, setForkDiscoverBusy] = React.useState(false)
      const [forkDiscoverNote, setForkDiscoverNote] = React.useState('')
      React.useEffect(() => {
        if (!forkDiscoverNote) return undefined
        const timer = setTimeout(() => setForkDiscoverNote(''), 2600)
        return () => clearTimeout(timer)
      }, [forkDiscoverNote])
      const [forkDiscoverModels, setForkDiscoverModels] = React.useState(null)
      const forkCatalogLoadingRef = React.useRef(false)

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
          setFailedPatch(prev => ({ ...(prev || {}), ...patch }))
          console.warn('dsh-memu-memory: settings save failed after retry')
          setError(String(error?.message || error))
          void refresh()
        })
        return saveChain.current
      }, [call, refresh])
      React.useEffect(() => {
        const flush = () => { void flushSettings() }
        window.addEventListener?.('pagehide', flush)
        return () => { window.removeEventListener?.('pagehide', flush); clearTimeout(settingsTimer.current); flush() }
      }, [flushSettings])
      // 宿主模型目录懒加载：切到 host/custom 时拉一次，缓存在组件状态里，之后不再重复
      // 拉。失败不抛——目录拿不到只是降级成手填，设置页不该为一个目录炸掉。
      const loadForkCatalog = React.useCallback(async () => {
        if (forkCatalogLoadingRef.current) return
        forkCatalogLoadingRef.current = true
        setForkCatalogState('loading')
        try {
          setForkCatalog(await call('listForkModelOptions', {}))
          setForkCatalogState('loaded')
        } catch {
          setForkCatalog(null)
          setForkCatalogState('error')
        } finally {
          forkCatalogLoadingRef.current = false
        }
      }, [call])
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
        const requestId = ++reviewsRequest.current
        try {
          const [globalQueue, privateQueue] = await Promise.all([
            call('listReviews', sessionId ? { sessionId } : {}),
            browseLibId
              ? call('listReviews', { libraryId: browseLibId, sessionId: sessionId || undefined }).catch(() => ({ items: [] }))
              : Promise.resolve({ items: [] }),
          ])
          if (requestId !== reviewsRequest.current) return
          setReviews([...(privateQueue?.items || []), ...(globalQueue?.items || [])])
        } catch (e) { if (requestId === reviewsRequest.current) setError(String(e?.message || e)) }
      }, [call, browseLibId])

      const loadFolders = React.useCallback(async () => {
        try {
          const res = await call('listFolders', {})
          setFolders(res?.folders || [])
          setFoldersLoaded(true)
        } catch (e) { setError(String(e?.message || e)) }
      }, [call])

      const loadStatsFor = React.useCallback(async (libraryId) => {
        const requestId = ++statsRequest.current
        if (!libraryId) { setStatsData(null); return }
        setStatsBusy(true)
        try {
          const next = await call('getStats', { libraryId, days: 30 })
          if (requestId === statsRequest.current) setStatsData(next)
        } catch (e) {
          if (requestId === statsRequest.current) {
            setError(String(e?.message || e))
            setStatsData(null)
          }
        } finally { if (requestId === statsRequest.current) setStatsBusy(false) }
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
      // host 需要 provider/model 枚举，custom 需要 customAvailable/discoveryAvailable
      // 能力位——三态不在 inherit 时目录才值得拉（一次，之后吃缓存）。
      React.useEffect(() => {
        const mode = state?.settings?.consolidationModelMode || 'inherit'
        if (mode !== 'host' && mode !== 'custom') return
        if (forkCatalogState === 'idle') void loadForkCatalog()
      }, [state?.settings?.consolidationModelMode, forkCatalogState, loadForkCatalog])
      React.useEffect(() => {
        if (page !== PAGE.browser || !browseLibId) return undefined
        let alive = true
        const requestId = ++browseLibraryRequest.current
        const current = () => alive && requestId === browseLibraryRequest.current
        void call('browseLibrary', { libraryId: browseLibId, sessionId: sessionId || undefined }).then(result => {
          if (!current()) return
          setBrowseFiles(result.files || [])
          setBrowseSource(result.source || '')
        }).catch(error => { if (current()) setError(String(error.message || error)) })
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
      // 「拉取模型列表」：把草稿端点转给 discoverForkModels。apiKey 是一次性草稿凭据——
      // 密码框里有输入就带草稿，留空就声明复用已存 key（useStoredKey），两者都不回显、
      // 不进日志。结果只填下拉，失败给一行自清状态。
      const discoverConsolidationModels = async () => {
        setForkDiscoverBusy(true)
        setForkDiscoverNote('')
        try {
          const res = await call('discoverForkModels', {
            baseURL: state?.settings?.consolidationCustomBaseURL || '',
            api: state?.settings?.consolidationCustomApi || 'openai-completions',
            apiKey: forkKeyDraft,
            useStoredKey: !forkKeyDraft,
          })
          if (res?.ok === true) {
            const models = Array.isArray(res.models) ? res.models : []
            setForkDiscoverModels(models)
            setForkDiscoverNote(t('consolidationDiscoverDone').replace('{n}', String(models.length)))
          } else {
            setForkDiscoverNote(res?.reason ? `${t('consolidationDiscoverFailed')} · ${res.reason}` : t('consolidationDiscoverFailed'))
          }
        } catch (e) {
          setForkDiscoverNote(`${t('consolidationDiscoverFailed')} · ${String(e?.message || e)}`)
        } finally {
          setForkDiscoverBusy(false)
        }
      }
      // 只经 setSetting 一条写入口：它已排定 250ms flushSettings（内含 setSettings
      // 与 broadcastMemoryWrite），再直接 call 会造成双写双广播。
      const setBackend = (backend) => {
        setSetting('memoryBackend', backend)
        setConfigNotice('')
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
        // Counts as the newest browse request, so the page effect (which bumps the
        // same counter when browseLibId changes) cannot be overwritten by this one.
        const requestId = ++browseLibraryRequest.current
        try {
          const res = await call('browseLibrary', { libraryId: id })
          if (requestId !== browseLibraryRequest.current) return
          setBrowseFiles(res?.files || [])
          setBrowseSource(res?.source || 'engine')
          setBrowseDraft({})
          setDeleteArmed('')
        } catch (e) { if (requestId === browseLibraryRequest.current) setError(String(e?.message || e)) } finally { if (requestId === browseLibraryRequest.current) setBrowseBusy(false) }
      }
      const openBrowserFromLibrary = (libraryId) => {
        setPage(PAGE.browser)
        void openBrowser(libraryId)
      }
      // 手动整理复用侧边栏同一条通道：generatePrivate（会话维度、force 语义一致），
      // 不新增端点。一次点击最多发起 5 个对话——整理是真金白银的模型调用，
      // 不能一键把整库几十个会话全点着；剩下的再按一次即可。
      // 计数全部取每个调用的返回值（ok / running / error），不估算。
      const consolidateLibrary = async (libraryId) => {
        if (!libraryId || !confirmAction('consolidate:' + libraryId)) return
        setBusy(true)
        try {
          const res = await call('listSessions', { limit: 200 })
          const targets = (res?.sessions || []).filter(row => row.libraryId === libraryId)
          if (!targets.length) { setError(t('consolidateNone')); return }
          let started = 0, running = 0, failed = 0
          for (const row of targets.slice(0, 5)) {
            try {
              const one = await call('generatePrivate', { sessionId: row.id })
              if (one?.ok === true) started++
              else if (one?.running) running++
              else failed++
            } catch { failed++ }
          }
          const rest = Math.max(0, targets.length - 5)
          setNotice(t('consolidateDone')
            .replace('{started}', String(started))
            .replace('{running}', String(running))
            .replace('{failed}', String(failed))
            .replace('{rest}', rest > 0 ? t('consolidateRest').replace('{n}', String(rest)) : ''))
        } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
      }
      const consolidateButton = (libraryId, style = S.ghost) => h(Button, {
        style, disabled: busy || !libraryId, title: t('consolidateHint'),
        onClick: () => { void consolidateLibrary(libraryId) },
      }, actionLabel('consolidate:' + libraryId, t('consolidateNow')))
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
          await call('deleteMemory', { libraryId: browseLibId, id, confirmed: true })
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
      const runtimeState = localVector.runtime || {}
      const runtimeSources = Array.isArray(runtimeState.sources) ? runtimeState.sources : []
      const chosenRuntimeSource = runtimeSource || runtimeState.downloadSource || runtimeSources[0]?.id || ''
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
          const result = await call(endpoint, payload)
          if (endpoint === 'installLocalVectorRuntime' && result?.paused) {
            setNotice(`${t('managedVectorStatus')}: ${t('managedVectorPaused')}`)
          } else if (endpoint === 'installLocalVectorRuntime' && result?.stopped) {
            setNotice(`${t('managedVectorStatus')}: ${t('managedVectorStopped')}`)
          } else {
            setNotice(`${t('managedVectorStatus')}: ${t(labels[endpoint] || 'managedVectorStatus')}`)
          }
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
      const managedVectorDownload = async (id, provider) => {
        if (!confirmAction(`download:${id}`)) return
        await managedVectorAction('downloadLocalVectorModel', { id, confirmed: true, ...(provider ? { provider } : {}) })
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
        await managedVectorAction('installLocalVectorRuntime', {
          confirmed: true,
          ...(chosenRuntimeSource ? { source: chosenRuntimeSource } : {}),
        })
      }
      const controlRuntime = async (action) => {
        try {
          await call('installLocalVectorRuntime', { action })
          await refresh()
        } catch (e) {
          setVectorError(String(e?.message || e))
          setError(String(e?.message || e))
        }
      }

      const formatVectorAmount = (bytes) => {
        const value = Number(bytes) || 0
        if (value >= 1048576) return `${(value / 1048576).toFixed(value >= 10485760 ? 0 : 1)} MB`
        if (value >= 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
        return `${value} B`
      }
      const formatVectorSpeed = (bytesPerSecond) => {
        const value = Number(bytesPerSecond) || 0
        if (value <= 0) return ''
        return `${(value / 1048576).toFixed(value >= 1048576 ? 1 : 2)} MB/s`
      }
      const progressSpeed = (key, bytes, provided) => {
        const fromBackend = Number(provided) || 0
        if (!key) return fromBackend
        const now = Date.now()
        const previous = progressSpeedRef.current.get(key)
        let sampled = 0
        if (previous && now > previous.at && bytes >= previous.bytes) {
          const elapsed = (now - previous.at) / 1000
          if (elapsed >= 0.5) sampled = (bytes - previous.bytes) / elapsed
        }
        progressSpeedRef.current.set(key, { bytes, at: now })
        return fromBackend > 0 ? fromBackend : sampled
      }

      const renderVectorProgress = (progress, migration = false, key = '') => {
        if (!progress) return null
        const total = Number(migration ? progress.total : progress.totalBytes) || 0
        const done = Number(migration ? progress.completed : progress.bytes) || 0
        const label = t(migration ? 'managedVectorRebuilding' : 'managedVectorProgress')
        const current = migration ? progress.current?.itemId : progress.current
        const percent = !migration && total > 0 ? Math.min(100, Math.floor(done / total * 100)) : null
        const speed = migration ? 0 : progressSpeed(key, done, progress.speedBps)
        const amount = migration
          ? `${done} / ${total}`
          : `${percent == null ? '' : percent + '% · '}${formatVectorAmount(done)} / ${total > 0 ? formatVectorAmount(total) : '?'}${speed > 0 ? ' · ' + formatVectorSpeed(speed) : ''}`
        return h('div', { className: 'dshm-vector-progress' },
          h('div', { role: 'status', 'aria-live': 'polite' }, `${label}: ${amount}${migration ? ` · ${t('managedVectorGeneration')} ${progress.generation} · ${progress.stage}` : ''}`),
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
            const runtime = runtimeState
            const busyRuntime = ['downloading', 'verifying', 'installing'].includes(runtime.status)
            const downloading = runtime.status === 'downloading'
            const paused = runtime.status === 'paused'
            const stopped = runtime.status === 'stopped'
            const ready = runtime.ready === true
            const label = ready
              ? (runtime.source === 'env' ? t('managedVectorRuntimeConfigured') : t('managedVectorRuntimeInstalled'))
              : runtime.status === 'unsupported' ? t('managedVectorRuntimeUnsupported')
                : runtime.status === 'failed' ? t('managedVectorRuntimeFailed')
                  : paused ? t('managedVectorPaused')
                    : stopped ? t('managedVectorStopped')
                      : busyRuntime ? t('managedVectorRuntimeInstalling') : t('managedVectorRuntimeMissing')
            const announce = busyRuntime || paused || stopped || Boolean(runtime.error?.message)
            return h('div', { className: 'dshm-step', ...(announce ? { role: 'status', 'aria-live': 'polite' } : {}) },
              h('div', { className: 'dshm-step-head' },
                h('span', { className: 'dshm-step-title' }, '1 · ' + t('managedVectorRuntimeTitle')),
                h(Tag, ready ? { tone: 'info' } : { tone: 'warn' }, label)),
              ready
                ? h('div', { style: S.muted }, runtime.version ? `v${runtime.version}` : t('managedVectorReady'))
                : h('div', { style: S.muted }, t('managedVectorRuntimeHint')),
              !ready && runtime.status !== 'unsupported' && runtimeSources.length > 1
                ? h(React.Fragment, null,
                  h('div', { className: 'dshm-nav-list is-row', role: 'tablist', 'aria-label': t('managedVectorRuntimeSource') },
                    runtimeSources.map(item => h('button', {
                      key: item.id,
                      type: 'button',
                      role: 'tab',
                      title: t('managedVectorRuntimeSourceHint'),
                      'aria-selected': chosenRuntimeSource === item.id,
                      disabled: busy || downloading,
                      className: `dshm-nav-item${chosenRuntimeSource === item.id ? ' on' : ''}`,
                      onClick: () => setRuntimeSource(item.id),
                    }, item.label))),
                  h('div', { style: { ...S.muted, marginTop: 4, lineHeight: 1.5 } }, t('managedVectorRuntimeSourceHint')))
                : null,
              downloading
                ? h('div', { className: 'dshm-step-actions' },
                  h(Button, { onClick: () => controlRuntime('pause'), style: S.ghost, title: t('managedVectorPause') }, t('managedVectorPause')),
                  h(Button, { onClick: () => controlRuntime('stop'), style: S.ghost, title: t('managedVectorStop') }, t('managedVectorStop')))
                : !ready && runtime.status !== 'unsupported'
                  ? h('div', { className: 'dshm-step-actions' },
                    h(Button, {
                      onClick: managedVectorRuntimeInstall,
                      disabled: busy,
                      primary: true,
                      title: paused || stopped ? t('managedVectorResume') : t('managedVectorRuntimeInstall'),
                    }, actionLabel('runtime', paused || stopped ? t('managedVectorResume') : t('managedVectorRuntimeInstall'))))
                  : null,
              runtime.error?.message ? h('div', { style: { ...S.muted, color: V.danger } }, runtime.error.message) : null,
              renderVectorProgress(runtime.progress, false, 'runtime'))
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
                const providers = entry.providers || []
                const chosenSource = vectorProvider[entry.id] || providers[0]?.id || ''
                const bytes = Number(entry.totalBytes)
                const sizeText = bytes > 0
                  ? (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
                  : t('managedVectorSizePending')
                const statusText = install.installed ? t('managedVectorInstalled') : pendingArtifact ? t('managedVectorPending') : (install.status || entry.availability || t('managedVectorUnavailable'))
                return h('div', { key: entry.id, className: 'dshm-model' },
                  h('div', null,
                    h('div', { className: 'dshm-step-title' }, entry.displayName || entry.id),
                    h('div', { className: 'dshm-model-meta' },
                      h(Tag, null, `${entry.dimension || '?'}d`),
                      (entry.languages || []).length ? h(Tag, null, (entry.languages || []).join(' · ')) : null,
                      h(Tag, null, sizeText),
                      h(Tag, install.installed ? { tone: 'info' } : pendingArtifact ? { tone: 'warn' } : null, statusText),
                      isActive ? h(Tag, { tone: 'info' }, t('managedVectorActive')) : null,
                      isRequested ? h(Tag, { tone: 'warn' }, t('managedVectorRequested')) : null)),
                  // 多个已固定来源才能选（只有一个就没有「选」这件事）。默认是目录顺序的
                  // 第一个，也就是 Qwen3 卡片上的 hf-mirror；换源不改向量空间——每个文件
                  // 都要过同一个 pin 住的 sha256。
                  providers.length > 1 ? h('div', { className: 'dshm-nav-list is-row', role: 'tablist', 'aria-label': t('managedVectorSource') },
                    providers.map(item => h('button', {
                      key: item.id,
                      type: 'button',
                      role: 'tab',
                      title: t('managedVectorSourceHint'),
                      'aria-selected': chosenSource === item.id,
                      disabled: busy || install.installed,
                      className: `dshm-nav-item${chosenSource === item.id ? ' on' : ''}`,
                      onClick: () => setVectorProvider(current => ({ ...current, [entry.id]: item.id })),
                    }, item.label))) : null,
                  h('div', { className: 'dshm-step-actions' },
                    !install.installed && entry.availability === 'available'
                      ? h(Button, { onClick: () => managedVectorDownload(entry.id, providers.length > 1 ? chosenSource : ''), disabled: busy, primary: true, title: t('managedVectorDownload') }, actionLabel(`download:${entry.id}`, t('managedVectorDownload')))
                      : null,
                    canSelect && !isActive
                      ? h(Button, { onClick: () => managedVectorSelect(entry.id), disabled: busy, title: t('managedVectorSelect'), style: S.ghost }, t('managedVectorSelect'))
                      : null),
                  install.error?.message || (entry.pendingReasons || []).length
                    ? h('div', { style: S.muted, role: 'status' }, install.error?.message || (entry.pendingReasons || []).join('；'))
                    : null,
                  renderVectorProgress(install.progress, false, 'model:' + entry.id))
              })))
        ) : null,

      )

      // 每组一个 Section（title + desc 走 i18n），组内沿用同一个 dshm-settings-grid。
      // 这里只是重排 + 分组：行与取值逻辑（含 ?? 回落、反向语义开关）一行不增不减。
      const settingsGroup = (title, desc, ...rows) => h(Section, { title, desc },
        h('div', { className: 'dshm-settings-grid' }, rows))

      // —— 整理 fork 的模型选择（三模式）行 ——————————————————————————————
      // 行随 consolidationModelMode 条件渲染：inherit 只露模式选择；host 露宿主目录的
      // provider/model 两行（目录拿不到就降级成 provider/model 手填，同样写
      // consolidationModel，用户不被卡死）；custom 露接入点四件套（这台宿主确认挂不了
      // custom 时整组降级为一行说明）。curatorModel 是全局提炼的模型，与这里的私有
      // 整理模型是两条路，恒常显示。
      const consolidationMode = settings.consolidationModelMode || 'inherit'
      const consolidationModelValue = String(settings.consolidationModel || '')
      const consolidationSlash = consolidationModelValue.indexOf('/')
      const consolidationProvider = consolidationSlash > 0 ? consolidationModelValue.slice(0, consolidationSlash) : ''
      const consolidationModelId = consolidationSlash > 0 ? consolidationModelValue.slice(consolidationSlash + 1) : ''
      const forkProviders = Array.isArray(forkCatalog?.providers) ? forkCatalog.providers : []
      const forkCatalogReady = forkCatalogState === 'loaded' && forkProviders.length > 0
      const forkProviderIds = forkCatalogReady ? forkProviders.map((p) => String(p?.id || '')).filter(Boolean) : []
      const forkModelEntries = forkCatalogReady ? (forkProviders.find((p) => p?.id === consolidationProvider)?.models || []) : []
      const forkOptionLabel = (item) => (item?.name && item.name !== item.id ? `${item.name} (${item.id})` : String(item?.id || ''))
      // 下拉要能显示当前值：已有 consolidationModel 但不在目录里（宿主 route 下线）时
      // 把当前值补成一个选项，显示与状态不脱节。
      const providerChoices = []
      if (!consolidationProvider) providerChoices.push({ id: '', label: t('consolidationProviderPick') })
      if (consolidationProvider && !forkProviderIds.includes(consolidationProvider)) providerChoices.push({ id: consolidationProvider, label: consolidationProvider })
      for (const id of forkProviderIds) providerChoices.push({ id, label: forkOptionLabel(forkProviders.find((p) => p?.id === id)) })
      const modelChoices = []
      if (!consolidationModelId) modelChoices.push({ id: '', label: t('consolidationModelPick') })
      if (consolidationModelId && !forkModelEntries.some((m) => m?.id === consolidationModelId)) modelChoices.push({ id: consolidationModelId, label: consolidationModelId })
      for (const m of forkModelEntries) modelChoices.push({ id: m.id, label: forkOptionLabel(m) })
      const consolidationModelRows = []
      if (consolidationMode === 'host') {
        if (forkCatalogReady) {
          consolidationModelRows.push(
            h(Field, { label: t('consolidationHostProvider') },
              h('select', { style: S.input, value: consolidationProvider, onChange: (e) => {
                const provider = e.target.value
                if (!provider) { setSetting('consolidationModel', null); return }
                // 换 provider 顺手选它的第一个模型，避免留下 "<provider>/" 这种
                // 解析不过的中间态；该 provider 没目录时才留半截让用户接着选。
                const first = forkProviders.find((p) => p?.id === provider)?.models?.[0]?.id || ''
                setSetting('consolidationModel', first ? `${provider}/${first}` : `${provider}/`)
              } },
                providerChoices.map((choice) => h('option', { key: choice.id, value: choice.id }, choice.label)))),
            h(Field, { label: t('consolidationHostModel') },
              h('select', { style: S.input, value: consolidationModelId, onChange: (e) => {
                if (!e.target.value || !consolidationProvider) return
                setSetting('consolidationModel', `${consolidationProvider}/${e.target.value}`)
              } },
                modelChoices.map((choice) => h('option', { key: choice.id, value: choice.id }, choice.label)))),
            h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('consolidationHostHint')))
        } else {
          consolidationModelRows.push(
            h(Field, { label: t('consolidationHostModel') },
              h('input', { type: 'text', style: S.input, placeholder: 'provider/model', value: consolidationModelValue,
                onChange: (e) => setSetting('consolidationModel', e.target.value || null) })),
            h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } },
              forkCatalogState === 'loading' ? t('consolidationCatalogLoading') : t('consolidationCatalogDegraded')))
        }
      }
      if (consolidationMode === 'custom') {
        if (forkCatalog && forkCatalog.customAvailable === false) {
          consolidationModelRows.push(h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('consolidationCustomUnavailable')))
        } else {
          const customModelId = String(settings.consolidationCustomModel || '')
          // key 永不回显明文：占位只给「已配置」+ 服务端打码尾 4 位；草稿有输入才写
          // setSetting（留空/删光 = 保留原值，因为后端对空串的语义是清空）。
          const keyConfigured = settings.hasConsolidationCustomApiKey === true || Boolean(String(settings.consolidationCustomApiKey || ''))
          const keyTail = String(settings.consolidationCustomApiKeyTail || '')
          const keyPlaceholder = keyConfigured
            ? t('consolidationKeyKeep') + (keyTail && keyTail !== '****' ? ` ····${keyTail}` : '')
            : t('consolidationKeyEmpty')
          const discovered = Array.isArray(forkDiscoverModels) ? forkDiscoverModels : []
          const customModelChoices = []
          if (!customModelId) customModelChoices.push({ id: '', label: t('consolidationModelPick') })
          if (customModelId && !discovered.some((m) => m?.id === customModelId)) customModelChoices.push({ id: customModelId, label: customModelId })
          for (const m of discovered) customModelChoices.push({ id: m.id, label: forkOptionLabel(m) })
          consolidationModelRows.push(
            h(Field, { label: t('baseUrl') },
              h('input', { type: 'text', style: S.input, placeholder: 'http://127.0.0.1:8899', value: settings.consolidationCustomBaseURL || '',
                onChange: (e) => setSetting('consolidationCustomBaseURL', e.target.value) })),
            h(Field, { label: t('apiKey') },
              h('input', { type: 'password', style: S.input, autoComplete: 'new-password', placeholder: keyPlaceholder, value: forkKeyDraft,
                onChange: (e) => { const next = e.target.value; setForkKeyDraft(next); if (next) setSetting('consolidationCustomApiKey', next) } })),
            h(Field, { label: t('consolidationCustomModel') },
              discovered.length
                ? h('select', { style: S.input, value: customModelId, onChange: (e) => { if (e.target.value) setSetting('consolidationCustomModel', e.target.value) } },
                    customModelChoices.map((choice) => h('option', { key: choice.id, value: choice.id }, choice.label)))
                : h('input', { type: 'text', style: S.input, placeholder: 'GLM-5.3-Flash', value: customModelId,
                    onChange: (e) => setSetting('consolidationCustomModel', e.target.value) })),
            h(Field, { label: t('consolidationCustomApiLabel') },
              h('select', { style: S.input, value: settings.consolidationCustomApi || 'openai-completions', onChange: (e) => setSetting('consolidationCustomApi', e.target.value) },
                ['openai-completions', 'openai-responses', 'anthropic-messages'].map((v) => h('option', { key: v, value: v }, v)))),
            forkCatalog?.discoveryAvailable === true
              ? h('div', { style: S.row },
                  h(Button, { onClick: discoverConsolidationModels, disabled: forkDiscoverBusy, title: t('consolidationDiscover') },
                    forkDiscoverBusy ? t('loading') : t('consolidationDiscover')),
                  forkDiscoverNote ? h('span', { style: S.muted, role: 'status' }, forkDiscoverNote) : null)
              : null,
            h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('consolidationCustomHint')))
        }
      }

      // 页首精简头部：标题 + 一句话说明 + 恢复默认。保存机制保持原样：设置项即时保存
      //（250ms trailing debounce + pagehide flush），页首不放「保存」按钮——改动落盘
      // 由 debounce 兜底；「恢复默认」仍是两段确认后调 resetSettings RPC。
      const settingsBlock = h(React.Fragment, null, h(Section, {
        title: t('settingsTuning'),
        right: h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
          h(Button, { onClick: resetSettingsNow, disabled: busy, style: S.ghost, title: resetArmed ? t('settingsResetConfirm') : t('settingsReset') }, resetArmed ? t('settingsResetConfirm') : t('settingsReset'))),
      },
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, lineHeight: 1.55 } }, t('settingsHeaderNote'))),
      settingsGroup(t('settingsGroupRecall'), t('settingsGroupRecallDesc'),
        h(Field, { label: t('autoInject') },
          h('select', { style: S.input, value: settings.autoInject || 'smart', onChange: (e) => setSetting('autoInject', e.target.value) },
            ['smart', 'anchor-only', 'per-turn', 'off'].map((v) => h('option', { key: v, value: v }, enumText(t, INJECT_LABELS, v))))),
        // 下面这些 ?? 回落值必须与 lib/state.js 的 DEFAULT_SETTINGS 一致：浏览器 bundle 不能
        // import 服务端模块，这里是客户端唯一的一份副本。它只在首次 getState 回来之前显示，
        // 但用户恰好在这段窗口里点「保存」就会把回落值持久化，等于悄悄改掉默认值。
        // 一致性由 tests/ui-defaults.test.mjs 守着。
        h(Field, { label: t('privateTopK') }, h('input', { type: 'number', style: S.input, value: settings.privateTopK ?? 5, onChange: (e) => setSetting('privateTopK', Number(e.target.value)) })),
        h(Field, { label: t('globalTopK') }, h('input', { type: 'number', style: S.input, value: settings.globalTopK ?? 5, onChange: (e) => setSetting('globalTopK', Number(e.target.value)) })),
        // Keep the explanation beside the switch, not on its own grid row: the
        // short text stays visible and the full four-line detail lives in the
        // tooltip, so the numeric fields start immediately after this row.
        h(Field, { label: t('crossLibraryRecall') },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
            h(Toggle, { checked: settings.crossLibraryRecall === true, label: t('crossLibraryRecall'), onChange: value => setSetting('crossLibraryRecall', value) }),
            h('span', {
              title: t('crossLibraryRecallHint'),
              style: { ...S.muted, fontSize: 11, lineHeight: 1.35, whiteSpace: 'nowrap' },
            }, t('crossLibraryRecallShort')))),
        h(Field, { label: t('anchorTokens') }, h('input', { type: 'number', style: S.input, value: settings.anchorTokens ?? 800, onChange: (e) => setSetting('anchorTokens', Number(e.target.value)) })),
        h(Field, { label: t('turnTokens') }, h('input', { type: 'number', style: S.input, value: settings.turnTokens ?? 800, onChange: (e) => setSetting('turnTokens', Number(e.target.value)) })),
        h(Field, { label: t('injectionTotalTokens') }, h('input', { type: 'number', style: S.input, value: settings.injectionTotalTokens ?? 2000, onChange: (e) => setSetting('injectionTotalTokens', Number(e.target.value)) })),
        h(Field, { label: t('dedupeTurns') }, h('input', { type: 'number', style: S.input, value: settings.dedupeTurns ?? 16, onChange: (e) => setSetting('dedupeTurns', Number(e.target.value)) })),
        h(Field, { label: t('globalEveryNTurns') }, h('input', { type: 'number', style: S.input, value: settings.globalEveryNTurns ?? 6, onChange: (e) => setSetting('globalEveryNTurns', Number(e.target.value)) })),
        h(Field, { label: t('minUserChars') }, h('input', { type: 'number', style: S.input, value: settings.minUserChars ?? 6, onChange: (e) => setSetting('minUserChars', Number(e.target.value)) })),
        h(Field, { label: t('relevanceThreshold') }, h('input', { type: 'number', step: '0.05', min: 0, max: 1, style: S.input, value: settings.relevanceThreshold ?? 0.4, onChange: (e) => setSetting('relevanceThreshold', Number(e.target.value)) })),
        h(Field, { label: t('randomCueChance') }, h('input', { type: 'number', step: '0.01', min: 0, max: 1, style: S.input, value: settings.randomCueChance ?? 0.02, onChange: (e) => setSetting('randomCueChance', Number(e.target.value)) })),
        h(Field, { label: t('freshnessHint') }, h(Toggle, { checked: settings.freshnessHint !== false, label: t('freshnessHint'), onChange: value => setSetting('freshnessHint', value) })),
        h(Field, { label: t('freshnessDays') }, h('input', { type: 'number', min: 1, max: 3650, style: S.input, value: settings.freshnessDays ?? 30, onChange: (e) => setSetting('freshnessDays', Number(e.target.value)) })),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('freshnessHintHint')),
        h(Field, { label: t('habitsInjection') }, h(Toggle, { checked: settings.habitsInjection !== false, label: t('habitsInjection'), onChange: value => setSetting('habitsInjection', value) }))),
      settingsGroup(t('settingsGroupLifecycle'), t('settingsGroupLifecycleDesc'),
        h(Field, { label: t('mustRememberCap') }, h('input', { type: 'number', style: S.input, value: settings.mustRememberCap ?? 12, onChange: (e) => setSetting('mustRememberCap', Number(e.target.value)) })),
        h(Field, { label: t('shortTermTtlHours') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.shortTermTtlHours ?? 72, onChange: (e) => setSetting('shortTermTtlHours', Number(e.target.value)) })),
        h(Field, { label: t('openLoopRemindDays') }, h('input', { type: 'number', min: 1, max: 365, style: S.input, value: settings.openLoopRemindDays ?? 7, onChange: (e) => setSetting('openLoopRemindDays', Number(e.target.value)) })),
        h(Field, { label: t('purgeArchivedAfterDays') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.purgeArchivedAfterDays ?? 0, onChange: (e) => setSetting('purgeArchivedAfterDays', Number(e.target.value)) }))),
      settingsGroup(t('settingsGroupCuration'), t('settingsGroupCurationDesc'),
        h(Field, { label: t('sleepConsolidation') }, h(Toggle, { checked: settings.sleepConsolidation === true, label: t('sleepConsolidation'), onChange: value => setSetting('sleepConsolidation', value) })),
        h(Field, { label: t('sleepAfterIdleMinutes') }, h('input', { type: 'number', min: 1, style: S.input, value: settings.sleepAfterIdleMinutes ?? 2, onChange: (e) => setSetting('sleepAfterIdleMinutes', Number(e.target.value)) })),
        h(Field, { label: t('autoCurateEveryHours') }, h('input', { type: 'number', min: 0, style: S.input, value: settings.autoCurateEveryHours ?? 0, onChange: (e) => setSetting('autoCurateEveryHours', Number(e.target.value)) })),
        h(Field, { label: t('autoCurateSessionLimit') }, h('input', { type: 'number', min: 1, max: 10, style: S.input, value: settings.autoCurateSessionLimit ?? 8, onChange: (e) => setSetting('autoCurateSessionLimit', Number(e.target.value)) })),
        h(Field, { label: t('autoLinkMode') },
          h('select', { style: S.input, value: settings.autoLinkMode || 'suggest', onChange: (e) => setSetting('autoLinkMode', e.target.value) },
            h('option', { value: 'suggest' }, t('autoLinkSuggest')),
            h('option', { value: 'deterministic' }, t('autoLinkDeterministic')),
            h('option', { value: 'off' }, t('autoLinkOff')))),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('autoLinkHint')),
        h(Field, { label: h('span', { style: { color: V.danger } }, t('consolidationRunner'), h('span', { style: { marginLeft: 6, fontWeight: 600 } }, t('consolidationRunnerExperimental'))) },
          h('select', { style: S.input, value: settings.consolidationRunner || 'fork', onChange: (e) => setSetting('consolidationRunner', e.target.value) },
            h('option', { value: 'fork' }, t('consolidationRunnerFork')),
            h('option', { value: 'worker' }, t('consolidationRunnerWorker')))),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('consolidationRunnerHint')),
        h(Field, { label: t('consolidationModelMode') },
          h('select', { style: S.input, value: consolidationMode, onChange: (e) => setSetting('consolidationModelMode', e.target.value) },
            h('option', { value: 'inherit' }, t('consolidationModeInherit')),
            h('option', { value: 'host' }, t('consolidationModeHost')),
            h('option', { value: 'custom' }, t('consolidationModeCustom')))),
        h(Field, { label: t('consolidationReasoningEffort') },
          h('select', { style: S.input, value: settings.consolidationReasoningEffort || 'inherit', onChange: (e) => setSetting('consolidationReasoningEffort', e.target.value) },
            h('option', { value: 'inherit' }, t('consolidationReasoningInherit')),
            h('option', { value: 'off' }, t('consolidationReasoningOff')),
            h('option', { value: 'low' }, t('consolidationReasoningLow')),
            h('option', { value: 'medium' }, t('consolidationReasoningMedium')),
            h('option', { value: 'high' }, t('consolidationReasoningHigh')))),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('consolidationReasoningHint')),
        ...consolidationModelRows,
        h(Field, { label: t('curatorModel') }, h('input', { type: 'text', style: S.input, placeholder: 'provider/model', value: settings.curatorModel || '', onChange: (e) => setSetting('curatorModel', e.target.value || null) })),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('curatorModelHint')),
        h(Field, { label: t('salientWake') },
          h('select', { style: S.input, value: settings.salientWake || 'off', onChange: (e) => setSetting('salientWake', e.target.value) },
            h('option', { value: 'off' }, t('salientWakeOff')),
            h('option', { value: 'schedule' }, t('salientWakeSchedule')))),
        h(Field, { label: t('salientWakeHour') }, h('input', { type: 'time', style: S.input, value: settings.salientWakeHour || '09:00', onChange: (e) => setSetting('salientWakeHour', e.target.value) })),
        h(Field, { label: t('salientWakeTimeZone') }, h('input', { type: 'text', style: S.input, placeholder: 'Asia/Shanghai', value: settings.salientWakeTimeZone || '', onChange: (e) => setSetting('salientWakeTimeZone', e.target.value) })),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('salientWakeHint'))),
      settingsGroup(t('settingsGroupEngine'), t('settingsGroupEngineDesc'),
        h(Field, { label: t('memoryMode') },
          h('select', { style: S.input, value: settings.memoryMode || 'local', onChange: (e) => setSetting('memoryMode', e.target.value) },
            ['local', 'cloud'].map((v) => h('option', { key: v, value: v }, v)))),
        h('div', { className: 'dshm-settings-note', style: { ...S.muted, marginTop: 6, lineHeight: 1.55 } }, t('memoryModeHint')),
        h(Field, { label: t('autoInstall') }, h(Toggle, { checked: settings.autoInstallEngine !== false, label: t('autoInstall'), onChange: value => setSetting('autoInstallEngine', value) }))),
      settingsGroup(t('settingsGroupSession'), t('settingsGroupSessionDesc'),
        h(Field, { label: t('newSessionPrompt') }, h(Toggle, { checked: settings.newSessionPromptDismissed !== true, label: t('newSessionPrompt'), onChange: value => setSetting('newSessionPromptDismissed', !value) })),
        h(Field, { label: t('sidebarSettings') }, h(Toggle, { checked: settings.sidebarSettings === true, label: t('sidebarSettings'), onChange: value => setSetting('sidebarSettings', value) })),
        h(Field, { label: t('visionCaptionEnabled') }, h(Toggle, { checked: settings.visionCaptionEnabled === true, label: t('visionCaptionEnabled'), onChange: value => setSetting('visionCaptionEnabled', value) }))),
      settingsGroup(t('settingsGroupIntegration'), t('settingsGroupIntegrationDesc'),
        h(Field, { label: t('inboundToolNames') }, h(InboundToolsInput, {
          names: settings.inboundToolNames || [], onChange: values => setSetting('inboundToolNames', values),
        }))),
      h(Section, { title: t('visionService') }, h(VisionConfigPanel, { call, config: state.visionConfig, t })))

      const renderLibraryItem = (lib) => h('div', { key: lib.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
          h('div', { style: { minWidth: 0 } },
            h('strong', null, lib.name || lib.id),
            h('div', { style: S.muted }, lib.id)),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            consolidateButton(lib.id),
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
              // 四轴构成放在 Tag 里；激活/掌控/来源直接可见，不再只藏在悬停提示里。
              moodText ? h(Tag, null, `${t('moodTag')} ${moodText}`) : null,
              emotionMetaText(f, t) ? h('span', { style: S.muted }, emotionMetaText(f, t)) : null,
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
      const browseQueryText = browseQuery.trim().toLowerCase()
      const browseMatched = file => !browseQueryText
        || [file.title, file.content, file.id, ...(Array.isArray(file.tags) ? file.tags : [])]
          .some(value => String(value || '').toLowerCase().includes(browseQueryText))
      const archShown = browseFiles.filter(file => browsePool(file) === browseView && browseMatched(file))
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
            consolidateButton(browseLibId),
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
            onChange: (e) => { setBrowseLibId(e.target.value); setBrowseQuery('') },
          }, (state.libraries || []).map((l) => h('option', { key: l.id, value: l.id }, libraryOptionLabel(l, state.libraries || []))))),
        browseView === 'relations' ? null : h('div', { style: S.row },
          h('span', { style: S.label }, t('browseSearch')),
          h('input', {
            style: { ...S.input, flex: 1 }, type: 'search', value: browseQuery,
            placeholder: t('browseSearchPlaceholder'), 'aria-label': t('browseSearch'),
            onChange: (e) => setBrowseQuery(e.target.value),
          }),
          browseQuery
            ? h('span', { style: S.muted, role: 'status' },
              `${archShown.length} / ${browseFiles.filter(file => browsePool(file) === browseView).length}`)
            : null,
          browseQuery
            ? h(Button, { style: S.ghost, onClick: () => setBrowseQuery(''), title: t('browseSearchClear') }, t('browseSearchClear'))
            : null),
        browseSource === 'index'
          ? h('div', { style: { ...S.muted, marginTop: 6 } }, t('browserIndexOnly'))
          : null,
        h('div', { className: 'dshm-nav-list is-row', role: 'tablist', style: { marginTop: 10 } },
          [['active', t('browseActiveTab')], ['archived', t('browseArchivedTab')], ['review', t('poolReview')], ['inactive', t('poolInactive')], ['relations', t('relations')]].map((pair) => {
            const value = pair[0]
            const count = browseFiles.filter(file => browsePool(file) === value && browseMatched(file)).length
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
      // 关系图谱是独立页，放在「MemU 记忆」下面一页；复用现有 glyph，不新增资产。
      pageDefs.push({ label: t('pageGraph'), overline: 'GRAPH', desc: t('descGraph'), icon: GlyphChart })
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
      // 关系图谱独立成页：库/全局选择器由 GraphStudioPanel 自持，刷新随 SettingsPage
      // 已有的心跳（revision/stamp）走 beat，页内不再开第二套轮询。
      // §7.1「两个壳一份实现」：完整工作室只在独立 WebUI 里渲染。宿主设置页/侧栏
      // 里这一页只给一个按钮，点了直接打开 WebUI 的关系图谱页，不再嵌第二份画布。
      const graphBlock = standalone
        ? h(GraphStudioPanel, {
          call, libraries: state.libraries || [], revision: state.revision, stamp: state.stamp, t,
          navHidden: graphNavHidden, onToggleNav: () => setGraphNavHidden(value => !value),
        })
        : h(Section, { title: t('pageGraph'), desc: t('descGraph'), icon: GlyphChart },
          h('div', { style: S.row },
            h(Button, { primary: true, title: t('openGraphStudioHint'),
              onClick: () => openWebUiPage('graph') }, t('openGraphStudio'))))
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

      // 帮助页 v2（包 G4）：快速开始 5 步 + 七个详解区 + FAQ 11 条 + 反馈入口。
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
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => h('details', { key: 'helpFaq' + n, style: { margin: '0 0 8px' } },
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
        wake: t('logKindWake'),
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
                  await call('clearActivityLog', { confirmed: true })
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
          ['recall', 'write', 'consolidate', 'curate', 'vector', 'error', 'check', 'wake'].map(kind => h('option', { key: kind, value: kind }, LOG_KIND_LABELS[kind]))),
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
          : h('div', { style: S.list }, logRows.map(row => h('div', { key: row.id, style: S.item, className: logRowClass(row) },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' } },
                h(Tag, null, LOG_KIND_LABELS[row.kind] || row.kind),
                logRowState(row) === 'failed' ? h(Tag, { tone: 'danger', title: t('logStateFailedHint') }, t('logStateFailed')) : null,
                logRowState(row) === 'degraded' ? h(Tag, { tone: 'warn', title: t('logDegradedHint') }, t('logDegraded')) : null,
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
            h('div', { className: logMessageClass(row), style: { marginTop: 4, whiteSpace: 'pre-wrap' } }, row.message),
            Array.isArray(row.refs) && row.refs.length
              ? h('div', { style: { ...S.muted, marginTop: 4 } }, row.refs.join(' · '))
              : null,
            row.detail
              ? h('pre', { style: { ...S.muted, margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, JSON.stringify(row.detail).slice(0, 600))
              : null)))))
      const pageBlocks = [engineBlock, connectionBlock, settingsBlock, foldersBlock, librariesBlock, browserBlock, globalBlock, promptsBlock, statsBlock, memoriesBlock, graphBlock, logsBlock, lexiconBlock, helpBlock]

      // Settings uses a left nav with a sliding indicator (the sidebar keeps its
      // top segments). The indicator is one absolutely-positioned element moved by
      // a transform, so the active item animates without per-item flicker.
      const active = pageDefs[page] || pageDefs[0]
      // 沉浸式只给独立 WebUI 的完整工作室用。宿主设置页里这一页现在只是一个按钮，
      // 不能再套 is-graph-wide：那会把本来横排的导航强制成 158px 竖排。
      const graphWide = standalone && page === PAGE.graph
      return h('div', {
        className: `dshm-root${graphWide ? ' is-graph-wide' : ''}${graphWide && graphNavHidden ? ' is-graph-navless' : ''}`,
        'data-dshm-surface': embedded ? 'sidebar' : 'dialog',
        style: { '--dshm-nav-h': `${NAV_ITEM_H}px`, '--dshm-nav-gap': `${NAV_GAP}px` },
      },
      h('div', { className: 'dshm-shell' },
        h('nav', { className: 'dshm-nav', role: 'tablist', 'aria-orientation': 'vertical' },
          // 贴在左导航右边缘的收起小块：收起后本身仍留一条窄边，可随时展开。
          graphWide ? h('button', {
            type: 'button', className: 'dshm-nav-handle',
            title: graphNavHidden ? t('gsShowNav') : t('gsHideNav'),
            'aria-label': graphNavHidden ? t('gsShowNav') : t('gsHideNav'),
            'aria-expanded': String(!graphNavHidden),
            onClick: () => setGraphNavHidden(value => !value),
          }, graphNavHidden ? '›' : '‹') : null,
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
              key: p.overline,
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
          failedPatch ? h('div', { className: 'dshm-error', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, t('settingsUnsaved')),
            h(Button, { style: S.ghost, onClick: () => {
              if (!failedPatch) return
              pendingSettings.current = { ...failedPatch, ...pendingSettings.current }
              setFailedPatch(null)
              void flushSettings()
            } }, t('settingsRetry')),
            h(Button, { style: S.ghost, onClick: () => setFailedPatch(null) }, t('settingsDiscard'))) : null,
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
      const hasConfigPage = !!state?.sidebarSettings
      // pages 从 4 变 3 时把 tabPage 钳回有效范围，避免停留空内容且无高亮。
      React.useEffect(() => { setTabPage(p => Math.min(p, hasConfigPage ? 3 : 2)) }, [hasConfigPage])
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
      // 宿主 call 不保序、会话切换不卸载面板：用单调代次只让最后一次 refresh 落地，
      // finally 也不再把旧 sessionId 写回 loadedFor。
      const refreshRequest = React.useRef(0)

      const refresh = React.useCallback(async () => {
        if (!sessionId) return
        const requestId = ++refreshRequest.current
        // One round trip for the whole first screen (T4). Previews are capped
        // server-side, so opening a 500-entry library no longer ships every body.
        try {
          const st = await call('getSidebarState', { sessionId })
          let files = st.private?.items || []
          // Older servers painted a bound-library-only preview. Ask `listPrivate`
          // for the cross-library list only in that case; a current server says
          // crossLibrary:true and already returned the same rows in one trip.
          if (st.private && st.private.crossLibrary !== true) {
            const privateList = await call('listPrivate', { sessionId, limit: 120, previewChars: 160 }).catch(() => null)
            if (privateList?.files) files = privateList.files
          }
          if (requestId !== refreshRequest.current) return
          setState({
            ...st,
            pinnedCount: st.private?.pinned ?? 0,
            privateCount: files.length,
            globalCount: st.global?.active ?? 0,
          })
          setPrivateFiles(files)
          setGlobalFiles(st.global?.items || [])
          markerRef.current = sidebarMarker(st)
          setError('')
        } catch (e) {
          if (requestId !== refreshRequest.current) return
          setError(String(e?.message || e))
          return false
        } finally {
          if (requestId === refreshRequest.current) setLoadedFor(sessionId)
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

      // 整理提醒（跨会话）：挂载即拉一次，之后单一慢轮询；busy 时提高频率但
      // 绝不叠加第二个定时器（约定 §7.4）。不依赖 sessionId —— 没选中对话也要显示。
      const [feed, setFeed] = React.useState(null)
      const loadFeed = React.useCallback(async () => {
        try { setFeed(await call('getConsolidationFeed', { limit: 6 })) } catch {}
      }, [call])
      React.useEffect(() => {
        void loadFeed()
        // unref：浏览器里没有这个方法（可选调用跳过），Node 测试环境里别让轮询拖住进程退出。
        const timer = setInterval(() => { void loadFeed() }, busy ? 4000 : 20000)
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
        check: t('logKindCheck'), wake: t('logKindWake'),
      }
      // 侧栏的「整理记录」只放正常流水：失败已经由上方「整理提醒」负责（跨会话、可清除、
      // 可跳转），在这里再重复一遍只会让 5 行里挤满红字。红色与「失败/降级」标签只在
      // WebUI › 全部日志 里出现——那里才是按时间翻全部事件的地方。
      const sidebarRuns = runLog.filter((row) => logRowState(row) !== 'failed')
      const renderRunRow = (row) => h('div', { key: row.id, style: S.item },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h(Tag, null, RUN_KIND_LABELS[row.kind] || row.kind),
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
            h(Toggle, {
              checked: effective ? effective.useLibrary : binding.useLibrary !== false,
              // The folder is the ceiling: a blocked switch is shown disabled with
              // the reason, not silently switched off.
              disabled: busy || (folderPolicy && folderPolicy.useLibrary === false),
              label: t('usePrivate'),
              title: folderPolicy && folderPolicy.useLibrary === false ? t('folderSwitchOff') : t('usePrivate'),
              onChange: (value) => setScope('useLibrary', value),
            })),
          h(Field, { label: t('useGlobal') },
            h(Toggle, {
              checked: effective ? effective.useGlobal : binding.useGlobal !== false,
              disabled: busy || (folderPolicy && folderPolicy.useGlobal === false),
              label: t('useGlobal'),
              title: folderPolicy && folderPolicy.useGlobal === false ? t('folderSwitchOff') : t('useGlobal'),
              onChange: (value) => setScope('useGlobal', value),
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
            sidebarRuns.length === 0
              ? h('div', { style: S.muted }, t('runLogEmpty'))
              : h('div', { style: S.list }, sidebarRuns.slice(0, 5).map(renderRunRow)))),
        // 作用域放在控制卡之后：它是一组低频字段，先让用户看到记忆开关和整理入口。
        h(ContextScope, { binding, sessionId, call, t })
      )

      const renderPrivateItem = (f) => h('div', { key: f.id, style: S.item },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('strong', null, f.title || f.id),
          h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
            h(Tag, null, enumText(t, LAYER_LABELS, f.layer || 'long_term')),
            // Cross-library rows carry the owning library; the sidebar is narrow,
            // so only rows that do not belong to the bound library get the tag.
            f.libraryName && f.libraryId && f.libraryId !== state?.binding?.libraryId
              ? h(Tag, { tone: 'info' }, f.libraryName)
              : null,
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
        ...(hasConfigPage ? [{ key: 'config', label: t('pageConfig'), node: h(SettingsPage, { ctx, t, embedded: true }) }] : []),
      ]
      const tabIndex = Math.min(tabPage, pages.length - 1)

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
              key: p.key,
              type: 'button',
              role: 'tab',
              'aria-selected': tabIndex === i,
              className: `dshm-nav-item${tabIndex === i ? ' on' : ''}`,
              onClick: () => setTabPage(i),
            }, p.label)))),
        error ? h('div', { style: { ...S.muted, padding: '8px 12px 0', color: V.danger } }, error) : null,
        notice ? h('div', { style: { ...S.muted, padding: '8px 12px 0' } }, notice) : null,
        h('div', { className: 'dshm-tab-body', style: S.tabBody }, pages[tabIndex]?.node || null))
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
      h('div', { style: { ...S.row, marginTop: 12 } },
        h(Toggle, { checked: dontShow === true, label: t('rememberChoice'), onChange: setDontShow }),
        h('span', null, t('rememberChoice'))))
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
