window.__ModuleLoader__.load({
  id: 'yukari-dsh-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of the merged panel. */
    const NS = 'yukari'
    /** Sidebar list id, and the key of the matching main panel. */
    const PANEL_ID = 'yukari'

    /** Host endpoints, one per merged subsystem. */
    const API = {
      overview: '/yukari/api/overview',
      update: '/yukari/api/update',
      restart: '/yukari/api/restart',
      icon: '/yukari/api/icon',
      chats: '/chat-manager/api',
      runtime: '/dshctl/api',
      sites: '/publish/api',
      proxy: '/ssproxy/api',
      purge: '/purge/api',
      files: '/files/api',
      rules: '/rules/api',
      presets: '/presets/api',
      github: '/github/api',
      browser: '/browser/api',
    }

    /* ------------------------------------------------------------------ i18n */

    const zh = {
      title: 'Yukari插件合集',
      tabOverview: '概览',
      tabChats: '会话',
      tabSites: '站点',
      tabProxy: '代理',
      tabPurge: '无限制模式',
      tabRules: '约束',
      tabRuntime: '状态',

      compChats: '会话管理',
      compSites: '站点发布',
      compFiles: '工作区文件',
      compProxy: '出站代理',
      compPurge: '无限制模式',
      compRules: '强约束',
      compBrowser: '无头浏览器',
      compRuntime: '运行状态',

      upCheck: '检查更新',
      upChecking: '正在检查…',
      upLatest: '已是最新版本',
      upAvailable: '发现新版本 {version}',
      upNow: '立即更新',
      upUpdating: '正在更新…',
      upDone: '已装好 {version}，重启后生效',
      upPending: '已装好 {version}，重启后生效',
      upRestart: '立即重启',
      upFailed: '检查更新失败：{error}',
      upUpdateFailed: '更新失败：{error}',

      /* presets */
      tabPresets: '预设',
      compPresets: '智能体预设',
      ovPresets: '{n} 个自定义',
      ovPresetsHow: '以已有预设为模板新建',
      pIntro: '管理「自定义」分组里的智能体预设：新建时先选一个内置或自定义预设当模板，再改组合；内置预设只读，复制一份就能改。',
      pTrust: '组合会加载宿主插件：只添加你信任的包。',
      pMine: '我的预设',
      pMineHint: '由这个插件注册并保存，可以改也可以删。',
      pDeclared: '其他自定义预设',
      pDeclaredHint: '由 profile 的 patch 声明；保存会写入一条覆盖，不能在这里删除。',
      pBuiltin: '内置预设',
      pBuiltinHint: '只读，复制一份再改。',
      pRuntimeGroup: '运行时注册',
      pRuntimeHint: '由其他插件在运行时注册。',
      pSourceStore: '我的',
      pSourceDeclared: '声明式',
      pSourceBuiltin: '内置',
      pSourceRuntime: '运行时',
      pEmptyList: '这里还没有预设。',
      pRowsCount: '{n} 行',
      pRowsTitle: '能力行（{n}）',
      pRowsUnknown: '结构未知',
      pNew: '新建预设',
      pNewTitle: '新建预设',
      pEditTitle: '编辑预设',
      pChooseTemplate: '选一个模板',
      pChooseTemplateHint: '新预设立刻复制它的完整组合：工具、人格提示词、分组都在里面，之后随便改。',
      pBlankTitle: '空白组合',
      pBlankHint: '不含任何工具，只有对话。',
      pUseTemplate: '用这个',
      pImportChoose: '选它',
      pImportFrom: '从「{name}」导入',
      pImportHint: '选中的行会深拷贝追加到当前组合末尾。',
      pImportAdd: '加入 {n} 行',
      pImportPick: '先选一个预设，再从它的组合里挑行。',
      pTemplateTag: '模板：{name}',
      pCopyName: '{name} 副本',
      pName: '名称',
      pNamePlaceholder: '例如：代码审查',
      pId: '标识',
      pIdPlaceholder: 'code-review',
      pIdHint: '小写字母、数字、- 和 _；创建后不可改，会话按它记录预设。',
      pIdLocked: '标识创建后不可修改。',
      pDescription: '描述',
      pDescriptionPlaceholder: '一句话说明这个模式做什么',
      pOrder: '排序',
      pOrderHint: '数字小的排前面；留空排最后',
      pPersona: '人格提示词',
      pPersonaHint: '写进 @deepseek-ai/dsh-persona 的 prefix，是这个模式的「性格」。',
      pPersonaPlaceholder: '你在这个模式下工作……',
      pPersonaSuffix: '后缀（可留空）',
      pPersonaMissing: '这个组合里没有人格行。',
      pPersonaAdd: '添加人格行',
      pRowsHint: '每行是一个插件；停用不挂载，带 !!js 条件的行由表达式决定。',
      pRowGroup: '分组',
      pRowCondition: '条件',
      pRowDisable: '停用',
      pRowEnable: '启用',
      pRowDisabled: '已停用',
      pRemoveRow: '移除这一行',
      pAddRow: '自定义行',
      pImportRows: '从预设导入',
      pRowName: '插件包名，例如 @deepseek-ai/dsh-tool-fs',
      pRowId: '行 id（可留空）',
      pRowConfig: 'config（JSON，可留空）',
      pRowNameRequired: '插件包名不能为空',
      pAdd: '添加',
      pAdvanced: '高级：组合 JSON',
      pAdvancedHint: '在这里整段替换能力行；分组、isolate 这类结构也在这里改。',
      pAdvancedOpen: '展开 JSON',
      pApply: '应用',
      pJsonInvalid: 'JSON 有问题：{error}',
      pJsonShape: '组合必须是插件行数组，每行要有 name。',
      pSave: '保存',
      pBack: '返回',
      pCancel: '取消',
      pEdit: '编辑',
      pCopy: '复制一份',
      pDelete: '删除',
      pView: '查看组合',
      pDeleted: '已删除',
      pDeleteTitle: '删除「{name}」？',
      pDeleteHint: '删除后新会话不能再选它；已经在用它的会话不受影响。',
      pConflict: '注册冲突',
      pDefault: '当前默认',
      pSaved: '已保存；新会话生效，正在运行的会话保留旧组合',
      pNoStructure: '这个预设的组合只能看 YAML，读不到逐行结构。',
      pYaml: 'YAML 组合',
      pYamlHint: '只读；DSH 自带的查看器渲染的同一份声明。',
      pStoreBroken: '预设存档有问题：{error}',
      pEmptyComposition: '这个组合是空的：会话只能用对话，没有任何工具。',
      pSelectAll: '全选',
      upManual: '这份安装无法自动更新，请在「插件」页重新安装',

      refresh: '刷新',
      retry: '重试',
      cancel: '取消',
      save: '保存',
      saved: '已保存',
      close: '关闭',
      loading: '加载中…',
      none: '—',
      open: '打开',
      copy: '复制',
      copied: '已复制',
      clearSearch: '清空',
      expand: '展开',
      collapse: '收起',

      offTitle: '「{name}」已关闭',
      offHint: '在侧边栏「插件」页启用 Yukari 的「{name}」组件后刷新即可使用。',

      ovArchived: '已归档',
      ovReady: '已就绪',
      ovPurgeHow: '在对话输入框下方的模式菜单里选「无限制模式」',
      ovFiles: '{n} 个工作区',
      ovPurgeUsed: '已注入 {n} 次',
      ovOff: '未启用 · 在「插件」页打开',
      ovCount: '运行中的组件 {n} 个',

      cSearch: '搜索标题、ID 或路径',
      cFilter: '会话范围',
      cAll: '全部',
      cActive: '在用',
      cArchived: '已归档',
      cGroupByWorkspace: '按工作区',
      cFlatList: '按时间',
      cWorkspaceUnassigned: '未归属工作区',
      cSelectWorkspace: '全选',
      cDeleteWorkspace: '删除工作区',
      cDelete: '删除',
      cDeleteN: '删除 {n} 个',
      cConfirm: '删除这 {n} 个会话？',
      cConfirmWorkspace: '删除工作区「{name}」和里面的 {n} 个会话？',
      cConfirmHint: '聊天记录会从磁盘删掉，归档和置顶也一起清掉，删了不能恢复。',
      cLiveBlocked: '其中 {n} 个还开着，删不掉。先切到别的会话；不行就到「状态」页重启 dsh。',
      cMissingRecord: '记录缺失',
      cLiveBlockedOne: '这个会话还开着，删不掉。先切到别的会话；不行就到「状态」页重启 dsh。',
      cDeleteFiles: '连会话生成的文件一起删',
      cDeleteFilesHint: '只删会话里用 write / str_replace_editor 新建、且还在工作区内的文件。命令行生成的文件、会话开始前就有的文件，都不动。',
      cDeleteWorkspaceDir: '连工作区文件夹一起删',
      cDeleteWorkspaceDirHint: '文件夹 {path} 和里面的所有东西都会删掉。不勾选就只移除工作区，文件夹留着。',
      cArchive: '归档',
      cUnarchive: '取消归档',
      cSelected: '已选 {n}',
      cTotal: '共 {n} 个会话',
      cTotalOne: '共 1 个会话',
      cNoMatch: '没有匹配的会话',
      cNoMatchHint: '换一个关键词，或切换范围。',
      cNoChats: '还没有会话',
      cDeleted: '已删除 {n} 个会话',
      cFilesDeleted: '清理了 {n} 个文件',
      cDirDeleted: '工作区及目录已删除',
      cWorkspaceRemoved: '工作区已移除（目录保留）',
      cLive: '已加载',
      cRunning: '运行中',
      cDeleteOne: '删除这个会话？',
      cDeleteOneSub: '删除这个会话和它的 {n} 个子会话？',
      cSubagentTag: '子会话',
      cSubSessions: '{n} 个子会话',
      cLockedByParent: '随主会话一起选中，不能单独取消',
      cArchivedTag: '已归档',
      cEvents: '{n} 条事件',
      cReason_live: '还开着，删不掉（先切走或重启 dsh）',
      cReason_unknown: '找不到这个会话',
      'cReason_io-error': '文件删不掉',
      'cReason_no-artifact': '没有落盘记录',
      'cReason_in-memory': '只存在于内存中',
      'cReason_unsafe-path': '路径不安全，已跳过',

      sSearch: '搜索站点名称或路径',
      sPrefix: '访问前缀',
      sSettings: '高级设置',
      sPrefixUnsetTag: '未设置访问前缀',
      sPrefixHint: '站点链接 = 前缀 + /站点名/。填你自己的对外地址，例如 https://pages.example.com 或 https://dsh.example.com/p',
      sPrefixDefault: '恢复默认',
      sPrefixUnset: '还在用默认前缀（dsh 本身不提供 /p 页面）。发布目录需要由你自己的静态服务对外提供，把那个地址填在这里，链接才能打开。',
      sCount: '共 {n} 个站点',
      sCountOne: '共 1 个站点',
      sEmpty: '还没有发布过站点',
      sEmptyHint: '让智能体调用 publish_site，或把构建产物放进发布目录。',
      confirmUnpublish: '下线「{name}」？',
      confirmUnpublishHint: '发布目录会被删除，链接立即失效。',
      sUnpublish: '下线',
      sPublished: '{time} 发布',
      sFiles: '{n} 个文件',
      sVersion: 'v{version}',
      sNoMatch: '没有匹配的站点',

      tabFiles: '文件',
      fWorkspace: '工作区',
      fRoot: '根目录',
      fName: '名称',
      fSize: '大小',
      fPreview: '预览',
      fDownload: '下载',
      fDownloadFilesN: '下载 {n} 个文件',
      fZipN: '打包下载 {n} 项',
      fZipReason: '超过 {n} 个文件时自动改用打包，避免连续弹出下载框',
      fSelectAll: '全选',
      fSymlink: '符号链接',
      fEmpty: '这个目录是空的',
      fEmptyHint: '换一个工作区或返回上级目录。',
      fHint: '已选 {n} 项；只选文件时逐个下载，含文件夹或超过 10 个文件时打包。',
      fNoSession: '这个工作区还没有会话，无法预览（下载不受影响）',
      fNoPreview: '当前界面没有文件预览服务，只能下载',

      pEnable: '启用代理',
      pDisable: '停用代理',
      pEnabled: '已接管出站流量',
      pDisabled: '直连',
      pPending: '已启用，等待连接',
      pNodes: '节点',
      pNoNodes: '还没有节点',
      pNoNodesHint: '把 ss:// 链接、订阅内容或 Clash 配置粘贴到下面导入。',
      pUse: '使用',
      pInUse: '使用中',
      pTest: '测速',
      pTestAll: '全部测速',
      pTesting: '测速中…',
      pRemove: '删除',
      confirmRemoveNode: '删除节点「{name}」？',
      confirmRemoveNodeHint: '从列表里移除，节点密码一起删掉，可以重新导入。',
      pImport: '导入',
      pImportTitle: '导入节点',
      pImportPlaceholder: '粘贴一个或多个 ss:// 链接、Base64 订阅内容或 Clash 配置（proxies 列表）',
      pImported: '导入 {added} 个节点',
      pImportedUpdated: '，更新 {updated} 个',
      pImportedSkipped: '，跳过 {skipped} 个不支持的节点',
      pSettings: '高级设置',
      pLocalPort: '本地端口',
      pBypass: '直连名单',
      pInvalidPort: '本地端口需在 1024–65535 之间',
      pReset: '清空全部节点',
      pConfirmReset: '确认清空全部节点？',
      pActive: '在途连接',
      pFailures: '失败',
      pLastError: '上次错误',
      pStateFile: '节点和密码保存在本地状态文件（权限 0600），重启后自动恢复。',

      gTitle: '无限制模式',
      gPresetUnrestricted: '无限制模式',
      gDesc: '插件注册了一个独立的对话模式「无限制模式」：选中后注入首段契约与尾部锚点、改写宿主的劝退句，模型仍然拒绝时自动重发一次；标准模式和其他模式完全不受影响。',
      gPrompt: '系统提示词',
      gChars: '{n} 字',
      gCustom: '自定义',
      gDefault: '内置默认',
      gSave: '保存并生效',
      gReset: '恢复默认',
      gConfirmReset: '确认恢复默认',
      gResetDone: '已恢复内置提示词',
      gPlaceholder: '输入要在无限制模式下注入的系统提示词…',
      gUnsaved: '有未保存的修改',
      gAnchor: '尾部锚点',
      gRetry: '拒绝重试',
      gScrub: '劝退句改写',
      gOn: '开',
      gOff: '关',
      gProbe: '自检注入',
      gProbeOk: '命中：注入与锚点都在',
      gProbeMiss: '未命中：这次装配没有带上注入',
      gProbeFail: '自检不可用：{reason}',
      gStats: '注入 {a} 次 · 改写 {b} 条 · 重试 {c} 次',
      gStatsNone: '本进程还没有无限制模式的装配记录',

      kTitle: '强约束',
      kDesc: '把硬性规则写进系统提示词首尾：优先级高于工具说明和工作区指引，保存后下一轮对话立即生效，不用重启。',
      kGlobalTitle: '全局约束',
      kGlobalNote: '对所有会话生效，包括子智能体',
      kProjectTitle: '工作区约束',
      kProjectNote: '只对工作区内的会话生效',
      kPath: '文件',
      kExists: '已存在',
      kMissing: '未创建',
      kPlaceholder: '一行一条，写清楚「必须做 / 禁止做 / 冲突时怎么办」。\n例：\n- 回复一律用简体中文。\n- 改代码前先读现有实现，不另起一套。',
      kChars: '{n} 字符',
      kLimit: '单份上限 {n}',
      kUnsaved: '未保存',
      kSavedNext: '已保存 · 下一轮对话生效',
      kClear: '清空',
      kConfirmClear: '清空这份约束？',
      kConfirmClearHint: '文件 {path} 会被删除；下一轮对话起不再注入它。',
      kClearDone: '已清空',
      kImport: '导入 AGENTS.md',
      kImportNone: '这个范围里没有可导入的 AGENTS.md / CLAUDE.md',
      kImported: '已载入 {file}，保存后生效',
      kToggleGlobal: '全局',
      kToggleProject: '工作区',
      kToggleAnchor: '尾部重申',
      kProbe: '自检注入',
      kProbeOk: '注入正常',
      kProbeMiss: '没有注入',
      kProbeNone: '没有可自检的会话',
      kProbeFail: '自检失败：{reason}',
      kStats: '已注入 {a} 次 · 全局 {b} · 工作区 {c}',
      kStatsNone: '还没有会话带上约束',
      kPrecedence: '约束与操作者的直接指令同级，高于工具说明、工作区指引、角色设定与风格要求；不改变审批与沙箱权限。',
      kAgentsNote: '工作区里的 AGENTS.md / CLAUDE.md 由 dsh 自己作为「工作区指引」加载（用户消息、不是强约束），同一内容会重复进上下文，所以这里用独立文件；要迁移就用「导入」。',
      kSwitchDirty: '切换工作区会丢掉未保存的修改',
      kDiscard: '放弃修改',
      kNoWorkspaces: '没有注册的工作区',
      kDirMissing: '工作区目录不存在',
      kTruncated: '已截断',
      ovRulesActive: '{n} 份约束已写好',
      ovRulesHow: '保存后下一轮生效',

      tabGithub: 'Github',
      compGithub: 'Github',
      ghIntro: '连接 Github',
      ghCreate: '在 GitHub 创建 fine-grained token',
      ghStepAccess: 'Repository access 选 Only select repositories，勾选要推送的仓库。',
      ghStepPerm: 'Repository permissions → Contents 设为 Read and write；Metadata 保持 Read。',
      ghStepPaste: '生成后复制令牌，粘贴到下面；令牌只显示一次。',
      ghTokenLabel: 'GitHub 令牌',
      ghTokenPlaceholder: 'github_pat_… 或 ghp_…',
      ghShow: '显示',
      ghHide: '隐藏',
      ghSave: '保存并验证',
      ghSaving: '验证中…',
      ghStorage: '保存到 $DSH_HOME/yukari-github/token（0600）；重启、更新、容器重建后都不需要重输。',
      ghSecurityHint: '令牌不会出现在面板、API、日志、remote 或 helper 脚本里；但同一容器的进程（包括智能体的 bash 和文件读取）能读取这个 0600 文件。请用 fine-grained PAT，只选必要仓库、Contents: Read and write、较短有效期；不用时点“清除令牌”。',
      ghAccount: '账号',
      ghLogin: '登录名',
      ghTokenType: '令牌类型',
      ghScopes: '权限范围',
      ghExpiry: '有效期',
      ghExpired: '已过期',
      ghNeverExpires: '不过期',
      ghFineGrained: 'Fine-grained',
      ghClassic: 'Classic',
      ghUnknown: '未知',
      ghGit: 'Git 凭据助手',
      ghHelperOn: '已安装',
      ghRepaired: '凭据助手已重新安装',
      ghHelperOff: '未安装',
      ghGitVersion: 'git 版本',
      ghRepair: '修复',
      ghRepairing: '修复中…',
      ghTokenFile: '令牌文件',
      ghRepoCheck: '检查仓库权限',
      ghRepoPlaceholder: 'owner/repo',
      ghCheck: '检查',
      ghChecking: '检查中…',
      ghCanPush: '可推送',
      ghCannotPush: '无写权限',
      ghRepoPrivate: '私有',
      ghRepoPublic: '公开',
      ghRepoCheckHint: '只代表这枚令牌对该仓库有 write 权限；分支保护仍可能拒绝 push。',
      ghRepo: '仓库',
      ghVisibility: '可见性',
      ghDefaultBranch: '默认分支',
      ghClear: '清除令牌',
      ghClearTitle: '清除 GitHub 令牌？',
      ghClearHint: '令牌文件和 git 凭据助手会被删除；之后智能体不能再 push，重新粘贴令牌才能恢复。',
      ghClearConfirm: '清除',
      ghDanger: '撤销',
      ghUnconfigured: '未配置',
      ghConfigured: '已连接',
      ghConnected: '已连接',
      ghDisconnected: '未连接',
      ghVerify: '重新验证',
      ghVerifying: '验证中…',
      ghVerified: '已验证',
      ghClassicWarning: 'Classic PAT 的 repo 权限覆盖整个账号，建议改用 fine-grained。',
      ghExpiryWarning: '这枚令牌没有设置有效期，建议设置一个较短的有效期。',
      ghExpiringSoon: '令牌将在 {time} 过期。',
      ghTokenSaved: '令牌已保存，可以直接 git push。',
      ghSavedNoHelper: '令牌已保存，但 git 凭据助手没有装好；先点修复。',
      ghReplace: '更换令牌',

      rCheck: '检查更新',
      rLatestShort: '已是最新',
      rChecking: '正在查询 npm…',
      rUpdateTo: '更新到 {version}',
      rUpdating: '正在安装…',
      rRestart: '重启 DSH',
      confirmRestart: '现在重启 dsh？',
      confirmRestartHint: '页面会断开几秒，服务回来后自动刷新。',
      rPickVersionClose: '收起',
      rPickVersion: '指定版本',
      rVersionInput: '例如 0.2.1-rc.5',
      rInstall: '安装',
      rUpToDate: '已是 {channel} 通道最新',
      rUpdateReady: '可更新到 {version}',
      rNotChecked: '还没检查',
      rNeedsRestart: '新版本已安装，重启后生效',
      rUpdated: '已安装 {version}',
      rUpdatedSame: '已经是 {version}',
      rCardVersion: '版本',
      rOnDisk: '已安装',
      rLatest: '通道最新',
      rCardProcess: '进程',
      rNode: 'Node',
      rUptime: '已运行',
      rChannel: '通道',
      rStrategy: '重启方式',
      rExecve: '原地重新执行',
      rExit: '退出后由容器拉起',
      rCommand: '执行自定义命令',
      rCardActivity: '最近操作',
      rFail: '失败',
      rRestarting: '正在重启 DSH',
      rRestartingHint: '等待服务重新响应，页面会自动刷新。',
      rRestartSlow: '一直没有响应。可用 docker compose logs -f dsh 查看日志。',
      rBack: '已恢复，正在刷新…',
      rHint: '重启时页面会断开几秒，会话不受影响。',

      bDesc: '首次使用时自动准备官方 Chrome for Testing，无需手动配置。浏览器仅供智能体工具调用。',
      bLaunchOk: '启动正常',
      bLibraries: '已自动补齐 {n} 个运行库包（解压到 DSH_HOME，无需 root）',
      bMissingLibs: '缺少 {n} 个系统库',
      bFixHint: '在容器内以 root 执行一次（只需一次，重启容器后仍在镜像里才持久）：',
      bLaunchFail: '无法启动',
      bLaunchFailHint: '浏览器已下载，但当前系统缺少运行库，使用时才会失败。按提示安装依赖或设置 browser libraryPath。',
      bAutomatic: '自动准备',
      bInstalling: '正在准备浏览器…',
      bInstall: '安装或重试',
      bVerify: '检查安装',

      relativeJustNow: '刚刚',
      relativeMinutes: ' 分钟前',
      relativeHours: ' 小时前',
      relativeDays: ' 天前',
    }

    const en = {
      title: 'Yukari Plugins',
      tabOverview: 'Overview',
      tabChats: 'Chats',
      tabSites: 'Sites',
      tabProxy: 'Proxy',
      tabPurge: 'Unrestricted',
      tabRules: 'Rules',
      tabRuntime: 'Status',

      compChats: 'Chats',
      compSites: 'Sites',
      compFiles: 'Workspace files',
      compProxy: 'Proxy',
      compPurge: 'Unrestricted mode',
      compRules: 'Hard rules',
      compBrowser: 'Headless browser',
      compRuntime: 'Status',

      upCheck: 'Check for updates',
      upChecking: 'Checking…',
      upLatest: 'You are on the latest version',
      upAvailable: 'Version {version} is available',
      upNow: 'Update now',
      upUpdating: 'Updating…',
      upDone: '{version} installed — restart to load it',
      upPending: '{version} installed — restart to load it',
      upRestart: 'Restart now',
      upFailed: 'Update check failed: {error}',
      upUpdateFailed: 'Update failed: {error}',

      /* presets */
      tabPresets: 'Presets',
      compPresets: 'Agent presets',
      ovPresets: '{n} custom',
      ovPresetsHow: 'Start from an existing preset',
      pIntro: 'Manage the Custom agent presets. Creating one starts from a built-in or custom preset as a template; built-ins stay read-only, duplicate one to edit.',
      pTrust: 'A composition runs Host plugins: only add packages you trust.',
      pMine: 'My presets',
      pMineHint: 'Registered and stored by this plugin; editable and removable.',
      pDeclared: 'Other custom presets',
      pDeclaredHint: 'Declared by the profile patch; saving writes an override, and deleting is not offered here.',
      pBuiltin: 'Built-in presets',
      pBuiltinHint: 'Read-only; duplicate one to change it.',
      pRuntimeGroup: 'Registered at runtime',
      pRuntimeHint: 'Registered by another plugin at runtime.',
      pSourceStore: 'Mine',
      pSourceDeclared: 'Declared',
      pSourceBuiltin: 'Built-in',
      pSourceRuntime: 'Runtime',
      pEmptyList: 'No presets here yet.',
      pRowsCount: '{n} rows',
      pRowsTitle: 'Capability rows ({n})',
      pRowsUnknown: 'Structure unavailable',
      pNew: 'New preset',
      pNewTitle: 'New preset',
      pEditTitle: 'Edit preset',
      pChooseTemplate: 'Pick a template',
      pChooseTemplateHint: 'The new preset copies its whole composition — tools, persona prompt and groups — and you change it from there.',
      pBlankTitle: 'Empty composition',
      pBlankHint: 'No tools at all; conversation only.',
      pUseTemplate: 'Use this',
      pImportChoose: 'Choose',
      pImportFrom: 'Import from “{name}”',
      pImportHint: 'Selected rows are deep-copied onto the end of this composition.',
      pImportAdd: 'Add {n} rows',
      pImportPick: 'Pick a preset, then choose rows from its composition.',
      pTemplateTag: 'Template: {name}',
      pCopyName: '{name} copy',
      pName: 'Name',
      pNamePlaceholder: 'For example: Code review',
      pId: 'ID',
      pIdPlaceholder: 'code-review',
      pIdHint: 'Lowercase letters, digits, - and _; immutable after creation, because sessions record it.',
      pIdLocked: 'The ID cannot change after creation.',
      pDescription: 'Description',
      pDescriptionPlaceholder: 'One sentence on what this mode is for',
      pOrder: 'Order',
      pOrderHint: 'Lower numbers sort first; leave empty to sort last',
      pPersona: 'Persona prompt',
      pPersonaHint: 'Written into the prefix of @deepseek-ai/dsh-persona: this mode’s character.',
      pPersonaPlaceholder: 'You work in this mode…',
      pPersonaSuffix: 'Suffix (optional)',
      pPersonaMissing: 'This composition has no persona row.',
      pPersonaAdd: 'Add persona row',
      pRowsHint: 'One plugin per row; a disabled row does not mount, and a !!js condition decides for itself.',
      pRowGroup: 'Group',
      pRowCondition: 'Condition',
      pRowDisable: 'Disable',
      pRowEnable: 'Enable',
      pRowDisabled: 'Disabled',
      pRemoveRow: 'Remove this row',
      pAddRow: 'Custom row',
      pImportRows: 'Import rows',
      pRowName: 'Plugin package, e.g. @deepseek-ai/dsh-tool-fs',
      pRowId: 'Row id (optional)',
      pRowConfig: 'config (JSON, optional)',
      pRowNameRequired: 'The plugin package is required',
      pAdd: 'Add',
      pAdvanced: 'Advanced: composition JSON',
      pAdvancedHint: 'Replace the whole row list here; groups and isolate settings live here too.',
      pAdvancedOpen: 'Show JSON',
      pApply: 'Apply',
      pJsonInvalid: 'The JSON is invalid: {error}',
      pJsonShape: 'The composition must be a list of plugin rows, each with a name.',
      pSave: 'Save',
      pBack: 'Back',
      pCancel: 'Cancel',
      pEdit: 'Edit',
      pCopy: 'Duplicate',
      pDelete: 'Delete',
      pView: 'View composition',
      pDeleted: 'Deleted',
      pDeleteTitle: 'Delete “{name}”?',
      pDeleteHint: 'New sessions can no longer select it; sessions already using it are unaffected.',
      pConflict: 'Registration conflict',
      pDefault: 'Default',
      pSaved: 'Saved; new sessions pick it up, running sessions keep their composition',
      pNoStructure: 'Only the YAML of this composition is readable; its rows cannot be listed.',
      pYaml: 'Composition YAML',
      pYamlHint: 'Read-only; the same declaration the shipped viewer renders.',
      pStoreBroken: 'The preset store is unusable: {error}',
      pEmptyComposition: 'This composition is empty: the session can only talk, with no tools.',
      pSelectAll: 'Select all',
      upManual: 'This install cannot update itself; reinstall it from the Plugins page',

      refresh: 'Refresh',
      retry: 'Retry',
      cancel: 'Cancel',
      save: 'Save',
      saved: 'Saved',
      close: 'Close',
      loading: 'Loading…',
      none: '—',
      open: 'Open',
      copy: 'Copy',
      copied: 'Copied',
      clearSearch: 'Clear',
      expand: 'Expand',
      collapse: 'Collapse',

      offTitle: '“{name}” is turned off',
      offHint: 'Enable the Yukari “{name}” component on the Plugins page, then refresh.',

      ovArchived: 'Archived',
      ovReady: 'Ready',
      ovPurgeHow: 'Pick “Unrestricted” in the mode menu under the chat input',
      ovFiles: '{n} workspaces',
      ovPurgeUsed: 'injected {n}×',
      ovOff: 'Off · enable it on the Plugins page',
      ovCount: '{n} components running',

      cSearch: 'Search title, id or path',
      cFilter: 'Scope',
      cAll: 'All',
      cActive: 'Active',
      cArchived: 'Archived',
      cGroupByWorkspace: 'By workspace',
      cFlatList: 'By time',
      cWorkspaceUnassigned: 'No workspace',
      cSelectWorkspace: 'Select all',
      cDeleteWorkspace: 'Delete workspace',
      cDelete: 'Delete',
      cDeleteN: 'Delete {n}',
      cConfirm: 'Delete these {n} chats?',
      cConfirmWorkspace: 'Delete workspace “{name}” and the {n} chats inside it?',
      cConfirmHint: 'The chat log is deleted from disk, and its archive and pin marks are cleared. This cannot be undone.',
      cLiveBlocked: '{n} of them are still open and cannot be deleted. Switch to another chat first; if that is not enough, restart dsh from the Status tab.',
      cMissingRecord: 'Record missing',
      cLiveBlockedOne: 'This chat is still open and cannot be deleted. Switch to another chat first; if that is not enough, restart dsh from the Status tab.',
      cDeleteFiles: 'Also delete the files this chat created',
      cDeleteFilesHint: 'Only files created with write / str_replace_editor that are still inside the workspace. Files made by shell commands, and files that existed before the chat, are left alone.',
      cDeleteWorkspaceDir: 'Also delete the workspace folder',
      cDeleteWorkspaceDirHint: 'The folder {path} and everything inside it is deleted. Untick to remove only the workspace and keep the folder.',
      cArchive: 'Archive',
      cUnarchive: 'Unarchive',
      cSelected: '{n} selected',
      cTotal: '{n} chats',
      cTotalOne: '1 chat',
      cNoMatch: 'No chat matches',
      cNoMatchHint: 'Try another keyword or scope.',
      cNoChats: 'No chats yet',
      cDeleted: 'Deleted {n} chats',
      cFilesDeleted: 'removed {n} files',
      cDirDeleted: 'workspace and its directory deleted',
      cWorkspaceRemoved: 'workspace removed (directory kept)',
      cLive: 'Loaded',
      cRunning: 'Running',
      cDeleteOne: 'Delete this chat?',
      cDeleteOneSub: 'Delete this chat and its {n} subagent chats?',
      cSubagentTag: 'Subagent',
      cSubSessions: '{n} subagent chats',
      cLockedByParent: 'Selected with its parent chat and cannot be unticked alone',
      cArchivedTag: 'Archived',
      cEvents: '{n} events',
      cReason_live: 'still open, so it cannot be deleted (switch away or restart dsh)',
      cReason_unknown: 'not found',
      'cReason_io-error': 'the files could not be removed',
      'cReason_no-artifact': 'nothing stored on disk',
      'cReason_in-memory': 'exists only in memory',
      'cReason_unsafe-path': 'unsafe path, skipped',

      sSearch: 'Search sites',
      sPrefix: 'URL prefix',
      sSettings: 'Advanced',
      sPrefixUnsetTag: 'prefix not set',
      sPrefixHint: 'Site link = prefix + /name/. Use your public address, e.g. https://pages.example.com or https://dsh.example.com/p',
      sPrefixDefault: 'Reset',
      sPrefixUnset: 'Still on the default prefix (dsh itself does not serve /p). Serve the publish root with your own static host and enter its address here so links open.',
      sCount: '{n} sites',
      sCountOne: '1 site',
      sEmpty: 'No site published yet',
      sEmptyHint: 'Ask the agent to call publish_site, or drop a build into the publish root.',
      confirmUnpublish: 'Take down “{name}”?',
      confirmUnpublishHint: 'The published folder is deleted and the link stops working immediately.',
      sUnpublish: 'Unpublish',
      sPublished: 'published {time}',
      sFiles: '{n} files',
      sVersion: 'v{version}',
      sNoMatch: 'No site matches',

      tabFiles: 'Files',
      fWorkspace: 'Workspace',
      fRoot: 'root',
      fName: 'Name',
      fSize: 'Size',
      fPreview: 'Preview',
      fDownload: 'Download',
      fDownloadFilesN: 'Download {n} files',
      fZipN: 'Download {n} as ZIP',
      fZipReason: 'More than {n} files are packed into one ZIP to avoid a download prompt per file',
      fSelectAll: 'Select all',
      fSymlink: 'symlink',
      fEmpty: 'This folder is empty',
      fEmptyHint: 'Pick another workspace or go up a level.',
      fHint: '{n} selected; files download one by one, folders or more than ten files are zipped.',
      fNoSession: 'This workspace has no chat yet, so preview is unavailable (download still works)',
      fNoPreview: 'No file preview service in this surface; download only',

      pEnable: 'Enable proxy',
      pDisable: 'Disable proxy',
      pEnabled: 'Routing outbound traffic',
      pDisabled: 'Direct',
      pPending: 'Enabled, connecting',
      pNodes: 'Nodes',
      pNoNodes: 'No nodes yet',
      pNoNodesHint: 'Paste ss:// links, a subscription or a Clash config below.',
      pUse: 'Use',
      pInUse: 'In use',
      pTest: 'Test',
      pTestAll: 'Test all',
      pTesting: 'Testing…',
      pRemove: 'Remove',
      confirmRemoveNode: 'Delete node “{name}”?',
      confirmRemoveNodeHint: 'It is removed from the list together with its password; you can import it again.',
      pImport: 'Import',
      pImportTitle: 'Import nodes',
      pImportPlaceholder: 'Paste one or more ss:// links, a base64 subscription, or a Clash config (proxies list)',
      pImported: 'Imported {added} nodes',
      pImportedUpdated: ', updated {updated}',
      pImportedSkipped: ', skipped {skipped} unsupported',
      pSettings: 'Advanced',
      pLocalPort: 'Local port',
      pBypass: 'Direct list',
      pInvalidPort: 'Local port must be 1024–65535',
      pReset: 'Remove all nodes',
      pConfirmReset: 'Remove all nodes?',
      pActive: 'Active',
      pFailures: 'Failures',
      pLastError: 'Last error',
      pStateFile: 'Nodes and passwords are kept in a local state file (mode 0600) and restored after a restart.',

      gTitle: 'Unrestricted mode',
      gPresetUnrestricted: 'Unrestricted',
      gDesc: 'The plugin registers a separate chat mode, “Unrestricted”: picking it injects a head contract and a tail anchor, rewrites the host sentences that teach the model to give up, and retries once if it still refuses. Standard mode is untouched.',
      gPrompt: 'System prompt',
      gChars: '{n} chars',
      gCustom: 'Custom',
      gDefault: 'Built-in',
      gSave: 'Save',
      gReset: 'Restore default',
      gConfirmReset: 'Confirm restore',
      gResetDone: 'Built-in prompt restored',
      gPlaceholder: 'System prompt injected in unrestricted mode…',
      gUnsaved: 'Unsaved changes',
      gAnchor: 'Tail anchor',
      gRetry: 'Retry refusals',
      gScrub: 'Host-sentence rewrite',
      gOn: 'on',
      gOff: 'off',
      gProbe: 'Self-check',
      gProbeOk: 'Hit: injection and anchor are both present',
      gProbeMiss: 'Miss: this assembly carried no injection',
      gProbeFail: 'Self-check unavailable: {reason}',
      gStats: 'injected {a}× · rewritten {b} · retried {c}×',
      gStatsNone: 'No unrestricted assembly recorded in this process yet',

      kTitle: 'Hard rules',
      kDesc: 'Write binding rules into the head and tail of the system prompt: they outrank tool guidance and workspace instructions, and a save applies to the next turn without a restart.',
      kGlobalTitle: 'Global rules',
      kGlobalNote: 'Applies to every chat, subagents included',
      kProjectTitle: 'Workspace rules',
      kProjectNote: 'Applies only to chats inside this workspace',
      kPath: 'File',
      kExists: 'present',
      kMissing: 'not created',
      kPlaceholder: 'One rule per line. Say what must happen, what must not, and what wins on conflict.\nExample:\n- Always answer in Simplified Chinese.\n- Read the existing implementation before adding a new one.',
      kChars: '{n} chars',
      kLimit: 'Limit {n} per file',
      kUnsaved: 'Unsaved',
      kSavedNext: 'Saved · applies to the next turn',
      kClear: 'Clear',
      kConfirmClear: 'Clear these rules?',
      kConfirmClearHint: 'The file {path} is deleted; the next turn stops receiving it.',
      kClearDone: 'Cleared',
      kImport: 'Import AGENTS.md',
      kImportNone: 'No AGENTS.md / CLAUDE.md found in this scope',
      kImported: 'Loaded {file}; save to apply',
      kToggleGlobal: 'Global',
      kToggleProject: 'Workspace',
      kToggleAnchor: 'Tail repeat',
      kProbe: 'Verify injection',
      kProbeOk: 'injected',
      kProbeMiss: 'not injected',
      kProbeNone: 'No live chat to check',
      kProbeFail: 'Check failed: {reason}',
      kStats: 'injected {a}× · global {b} · workspace {c}',
      kStatsNone: 'No chat has carried the rules yet',
      kPrecedence: 'Rules rank with a direct operator instruction, above tool guidance, workspace instructions, persona and style requests; they do not change approval or sandbox permissions.',
      kAgentsNote: 'AGENTS.md / CLAUDE.md in the workspace are loaded by dsh itself as workspace guidance (a user message, not a hard rule). Writing the same text there would duplicate it in context, so this component uses its own files; use Import to migrate.',
      kSwitchDirty: 'Switching workspaces discards unsaved edits',
      kDiscard: 'Discard',
      kNoWorkspaces: 'No workspace registered',
      kDirMissing: 'Workspace directory is missing',
      kTruncated: 'truncated',
      ovRulesActive: '{n} rule file(s) written',
      ovRulesHow: 'applies to the next turn',

      tabGithub: 'Github',
      compGithub: 'Github',
      ghIntro: 'Connect Github',
      ghCreate: 'Create a fine-grained token on GitHub',
      ghStepAccess: 'Repository access: choose Only select repositories and pick the repos you push to.',
      ghStepPerm: 'Repository permissions → Contents: Read and write; keep Metadata: Read.',
      ghStepPaste: 'Copy the token after creating it and paste it below; GitHub shows it only once.',
      ghTokenLabel: 'GitHub token',
      ghTokenPlaceholder: 'github_pat_… or ghp_…',
      ghShow: 'Show',
      ghHide: 'Hide',
      ghSave: 'Save and verify',
      ghSaving: 'Verifying…',
      ghStorage: 'Saved to $DSH_HOME/yukari-github/token (0600); no re-entry after restarts, updates, or container rebuilds.',
      ghSecurityHint: 'The token never appears in the panel, API, logs, remotes, or the helper script; but any process in this container, including the agent bash and file reads, can read the 0600 file. Use a fine-grained PAT limited to the repos you need, Contents: Read and write, and a short expiry; clear it when unused.',
      ghAccount: 'Account',
      ghLogin: 'Login',
      ghTokenType: 'Token type',
      ghScopes: 'Scopes',
      ghExpiry: 'Expiry',
      ghExpired: 'Expired',
      ghNeverExpires: 'No expiry',
      ghFineGrained: 'Fine-grained',
      ghClassic: 'Classic',
      ghUnknown: 'Unknown',
      ghGit: 'Git credential helper',
      ghHelperOn: 'Installed',
      ghRepaired: 'The credential helper is installed again',
      ghHelperOff: 'Not installed',
      ghGitVersion: 'git version',
      ghRepair: 'Repair',
      ghRepairing: 'Repairing…',
      ghTokenFile: 'Token file',
      ghRepoCheck: 'Check repository access',
      ghRepoPlaceholder: 'owner/repo',
      ghCheck: 'Check',
      ghChecking: 'Checking…',
      ghCanPush: 'Can push',
      ghCannotPush: 'No write access',
      ghRepoPrivate: 'Private',
      ghRepoPublic: 'Public',
      ghRepoCheckHint: 'This only means the token has write permission on that repository; branch protection may still reject the push.',
      ghRepo: 'Repository',
      ghVisibility: 'Visibility',
      ghDefaultBranch: 'Default branch',
      ghClear: 'Clear token',
      ghClearTitle: 'Clear the GitHub token?',
      ghClearHint: 'The token file and git credential helper are deleted; the agent cannot push again until you paste a token.',
      ghClearConfirm: 'Clear',
      ghDanger: 'Revoke',
      ghUnconfigured: 'Not configured',
      ghConfigured: 'Connected',
      ghConnected: 'Connected',
      ghDisconnected: 'Not connected',
      ghVerify: 'Verify again',
      ghVerifying: 'Verifying…',
      ghVerified: 'Verified',
      ghClassicWarning: 'A classic PAT repo scope covers the whole account; a fine-grained token is safer.',
      ghExpiryWarning: 'This token has no expiry; consider setting a short one.',
      ghExpiringSoon: 'The token expires at {time}.',
      ghTokenSaved: 'Token saved; git push works now.',
      ghSavedNoHelper: 'Token saved, but the git credential helper is not installed; use Repair.',
      ghReplace: 'Replace token',

      rCheck: 'Check for updates',
      rLatestShort: 'Up to date',
      rChecking: 'Asking npm…',
      rUpdateTo: 'Update to {version}',
      rUpdating: 'Installing…',
      rRestart: 'Restart DSH',
      confirmRestart: 'Restart dsh now?',
      confirmRestartHint: 'The page drops for a few seconds and reloads once the host is back.',
      rPickVersionClose: 'Close',
      rPickVersion: 'Pick version',
      rVersionInput: 'e.g. 0.2.1-rc.5',
      rInstall: 'Install',
      rUpToDate: 'Newest on {channel}',
      rUpdateReady: '{version} available',
      rNotChecked: 'not checked yet',
      rNeedsRestart: 'Installed — restart to load it',
      rUpdated: 'Installed {version}',
      rUpdatedSame: 'Already on {version}',
      rCardVersion: 'Version',
      rOnDisk: 'Installed',
      rLatest: 'Newest',
      rCardProcess: 'Process',
      rNode: 'Node',
      rUptime: 'Uptime',
      rChannel: 'Channel',
      rStrategy: 'Restart method',
      rExecve: 're-exec in place',
      rExit: 'exit, container restarts it',
      rCommand: 'custom command',
      rCardActivity: 'Recent activity',
      rFail: 'failed',
      rRestarting: 'Restarting DSH',
      rRestartingHint: 'Waiting for the server to answer; the page reloads by itself.',
      rRestartSlow: 'Still no answer. Check docker compose logs -f dsh.',
      rBack: 'Back online — reloading…',
      rHint: 'A restart drops this page for a few seconds; chats are not affected.',

      bDesc: 'Official Chrome for Testing is prepared automatically on first use. The browser is available to agent tools; no manual setup is needed.',
      bLaunchOk: 'Launch OK',
      bLibraries: '{n} runtime packages unpacked into DSH_HOME (no root needed)',
      bMissingLibs: '{n} system libraries missing',
      bFixHint: 'Run once as root inside the container (persists only if baked into the image):',
      bLaunchFail: 'Cannot launch',
      bLaunchFailHint: 'The browser downloaded but this host lacks its runtime libraries; it will fail on first use. Install them or set browser libraryPath.',
      bAutomatic: 'Automatic setup',
      bInstalling: 'Preparing browser…',
      bInstall: 'Install or retry',
      bVerify: 'Verify installation',

      relativeJustNow: 'just now',
      relativeMinutes: 'm ago',
      relativeHours: 'h ago',
      relativeDays: 'd ago',
    }

    /* ---------------------------------------------------------------- design */

    const styles = `
.yk-page {
  --yk-line: var(--dsw-alias-border-l2);
  --yk-soft: var(--dsw-alias-bg-layer-2);
  --yk-muted: var(--dsw-alias-label-tertiary);
  --yk-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-state-business-primary));
  box-sizing: border-box;
  width: 100%; height: 100%; min-height: 0;
  display: flex; flex-direction: column; align-items: center; gap: 20px;
  padding: 0 clamp(16px, 3vw, 36px) 40px;
  overflow-y: auto; overflow-x: hidden;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
  font-size: 14px; line-height: 1.5; scrollbar-gutter: stable;
  -webkit-font-smoothing: antialiased;
}
.yk-page *, .yk-page *::before, .yk-page *::after { box-sizing: border-box; }
.yk-page > * { width: 100%; max-width: 980px; flex: none; }
.yk-page > style { display: none; }
.yk-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 24px 0 2px; }
.yk-headBrand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.yk-headLogo { width: 32px; height: 32px; flex: none; display: grid; place-items: center; }
.yk-title { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
.yk-logoFallback { display: grid; place-items: center; border-radius: var(--dsw-radius-md); font-weight: 650; background: var(--yk-soft); color: var(--yk-accent); }
.yk-navBar { display: flex; align-items: center; gap: 2px; padding: 3px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--yk-line); }
.yk-navBar::-webkit-scrollbar { display: none; }
.yk-navTab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; font-weight: 500; height: 36px; padding: 0 13px; border-radius: var(--dsw-radius-md); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; white-space: nowrap; flex: 0 0 auto; transition: color .15s, background .15s; }
.yk-navTab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.yk-navTab[aria-selected="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-active); }
.yk-navTab:focus-visible, .yk-btn:focus-visible, .yk-cardAction:focus-visible { outline: 2px solid var(--yk-accent); outline-offset: 2px; }
.yk-tabPanel, .yk-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.yk-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yk-search { display: flex; align-items: center; gap: 8px; flex: 1 1 220px; height: 34px; padding: 0 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--yk-line); background: var(--dsw-alias-bg-base); color: var(--yk-muted); }
.yk-search:focus-within, .yk-input:focus { border-color: var(--yk-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--yk-accent) 12%, transparent); }
.yk-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.yk-searchClear, .yk-copyBtn, .yk-updateDismiss { appearance: none; border: 0; background: transparent; color: var(--yk-muted); cursor: pointer; display: inline-grid; place-items: center; padding: 3px; border-radius: var(--dsw-radius-sm); }
.yk-searchClear:hover, .yk-copyBtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.yk-btn { appearance: none; min-height: 32px; padding: 0 12px; border-radius: var(--dsw-radius-md); border: 1px solid var(--yk-line); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; text-decoration: none; transition: background .15s, border-color .15s; }
.yk-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.yk-btn:disabled { opacity: .45; cursor: default; }
.yk-btn-solid { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-inverted); }
.yk-btn-solid:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: transparent; }
.yk-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.yk-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.yk-btn-sm { min-height: 28px; padding: 0 9px; font-size: 12px; }
.yk-iconBtn { width: 32px; padding: 0; flex: none; }
.yk-iconBtn.yk-btn-sm { width: 28px; }
.yk-dangerHover:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.yk-chip { display: inline-flex; align-items: center; gap: 5px; min-height: 21px; padding: 1px 7px; border-radius: var(--dsw-radius-sm); font-size: 11px; font-weight: 500; line-height: 17px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.yk-chip-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.yk-chip-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.yk-chip-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.yk-chip-accent { color: var(--yk-accent); background: color-mix(in srgb, var(--yk-accent) 10%, transparent); }
.yk-chip-danger { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.yk-toggleRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 0 6px; }
.yk-chip-toggle { appearance: none; font: inherit; cursor: pointer; border: 1px solid var(--yk-line); background: transparent; color: var(--dsw-alias-label-secondary); }
.yk-chip-toggle:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.yk-chip-toggle[aria-pressed="true"] { border-color: color-mix(in srgb, var(--yk-accent) 45%, transparent); background: color-mix(in srgb, var(--yk-accent) 9%, transparent); color: var(--dsw-alias-label-primary); }
.yk-chip-toggle[aria-pressed="true"] .yk-chip-dot { background: var(--yk-accent); }
.yk-chip-toggle[aria-pressed="false"] .yk-chip-dot { background: transparent; box-shadow: inset 0 0 0 1px currentColor; }
.yk-chip-toggle:disabled { opacity: .5; cursor: default; }
.yk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.yk-card { background: var(--dsw-alias-bg-base); border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-lg); padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.yk-card-wide { grid-column: 1 / -1; }
.yk-cardHead, .yk-cardTitleWrap, .yk-cardTools { display: flex; align-items: center; gap: 8px; min-width: 0; }
.yk-cardHead { justify-content: space-between; }
.yk-cardTitleWrap { color: var(--dsw-alias-label-secondary); }
.yk-cardTitle { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yk-cardNote { margin: 0; font-size: 12px; color: var(--yk-muted); }
.yk-cardAction { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; padding: 3px 0; }
.yk-cardAction:hover { color: var(--yk-accent); }
.yk-cardText { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.65; }
.yk-cardHint, .yk-foot { color: var(--yk-muted); font-size: 12px; }
.yk-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yk-steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }
.yk-steps li::marker { color: var(--yk-accent); }
.yk-footDot { opacity: .45; }
.yk-rows { display: flex; flex-direction: column; }
.yk-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
.yk-row:last-child { border-bottom: 0; }
.yk-key { color: var(--dsw-alias-label-secondary); }
.yk-val { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 7px; text-align: right; overflow-wrap: anywhere; }
.yk-val-clamp { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yk-rows-2col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
.yk-hero { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-radius: var(--dsw-radius-lg); border: 1px solid var(--yk-line); }
.yk-heroDot { width: 7px; height: 7px; border-radius: 50%; background: var(--yk-muted); flex: none; }
.yk-hero-on .yk-heroDot { background: var(--dsw-alias-state-success-primary); }
.yk-hero-warn .yk-heroDot { background: var(--dsw-alias-state-warn-primary); }
.yk-heroMain { flex: 1 1 220px; min-width: 0; }
.yk-heroTitle { font-size: 14px; font-weight: 600; }
.yk-heroSub { font-size: 12px; color: var(--yk-muted); overflow-wrap: anywhere; }
.yk-heroActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.yk-serviceGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.yk-service { appearance: none; text-align: left; font: inherit; color: inherit; background: var(--dsw-alias-bg-base); border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-lg); padding: 15px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 10px; min-width: 0; transition: border-color .15s, background .15s; }
.yk-service:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); }
.yk-service-off { cursor: default; border-style: dashed; background: transparent; }
.yk-service-off:hover { border-color: var(--yk-line); background: transparent; }
.yk-service-off .yk-serviceTitle { color: var(--yk-muted); }
.yk-serviceHead { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); }
.yk-serviceTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.yk-serviceArrow { margin-left: auto; color: var(--yk-muted); }
.yk-serviceValue { font-size: 15px; font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
.yk-serviceHint { color: var(--yk-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yk-list, .yk-groups, .yk-nodeList { display: flex; flex-direction: column; gap: 6px; }
.yk-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); transition: background .15s; }
.yk-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.yk-item-selected { background: color-mix(in srgb, var(--yk-accent) 7%, transparent); }
.yk-itemMain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.yk-itemTitleRow { display: flex; align-items: center; gap: 7px; min-width: 0; }
.yk-itemTitle { appearance: none; border: 0; background: transparent; padding: 0; margin: 0; text-align: left; font: inherit; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; cursor: pointer; text-decoration: none; }
.yk-itemTitle:hover { color: var(--yk-accent); }
.yk-itemMeta { display: flex; align-items: center; gap: 5px 9px; flex-wrap: wrap; font-size: 11px; color: var(--yk-muted); }
.yk-itemMeta span + span::before { content: '·'; margin-right: 9px; opacity: .5; }
.yk-itemActions { display: flex; align-items: center; gap: 4px; flex: none; }
.yk-iconBtnOn { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.yk-itemWrap { display: flex; flex-direction: column; min-width: 0; }
.yk-children { display: flex; flex-direction: column; gap: 2px; margin: 0 0 4px 22px; padding-left: 12px; border-left: 1px solid var(--yk-line); }
.yk-childWrap .yk-item { padding: 5px 8px; gap: 8px; border-radius: var(--dsw-radius-sm); }
.yk-childWrap .yk-itemTitle { font-size: 12px; }
.yk-childWrap .yk-itemMeta { font-size: 10.5px; gap: 4px 7px; }
.yk-childWrap .yk-check { width: 13px; height: 13px; }
.yk-childWrap .yk-chip { font-size: 10px; min-height: 18px; padding: 0 5px; }
.yk-childWrap .yk-btn.yk-iconBtn { width: 26px; min-height: 26px; }
.yk-childWrap .yk-itemActions { opacity: .6; transition: opacity .15s; }
.yk-childWrap .yk-item:hover .yk-itemActions, .yk-childWrap .yk-itemActions:focus-within { opacity: 1; }
.yk-check-locked { opacity: .45; cursor: default; }
.yk-check-locked::after { content: ''; }
.yk-subToggle { appearance: none; border: 0; background: transparent; color: var(--yk-muted); font: inherit; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px; border-radius: var(--dsw-radius-sm); flex: none; }
.yk-subToggle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.yk-confirmInline { margin: 2px 0 8px 26px; padding: 10px 12px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent); }
.yk-confirmInline .yk-confirmTitle { font-size: 13px; }
.yk-libs { color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.yk-cmdRow { display: flex; align-items: flex-start; gap: 6px; }
.yk-cmdRow .yk-out { flex: 1; }
.yk-select { width: auto; min-width: 140px; max-width: 240px; height: 32px; padding: 0 8px; }
.yk-crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; flex: 1 1 240px; overflow-x: auto; scrollbar-width: none; }
.yk-crumbs::-webkit-scrollbar { display: none; }
.yk-crumbWrap { display: inline-flex; align-items: center; gap: 2px; color: var(--yk-muted); flex: none; }
.yk-crumb { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: var(--dsw-radius-sm); white-space: nowrap; }
.yk-crumb:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.yk-itemHead { padding-block: 4px; border-bottom: 1px solid var(--yk-line); border-radius: 0; font-size: 11px; color: var(--yk-muted); }
.yk-itemHead:hover { background: transparent; }
.yk-metaRight { margin-left: auto; flex: none; justify-content: flex-end; }
.yk-itemIcon { display: inline-flex; color: var(--yk-muted); flex: none; }
.yk-link { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.yk-check { flex: none; width: 16px; height: 16px; border-radius: var(--dsw-radius-sm); border: 1px solid var(--dsw-alias-border-l3); background: transparent; display: inline-grid; place-items: center; cursor: pointer; padding: 0; appearance: none; color: transparent; }
.yk-check[aria-checked="true"], .yk-check[aria-checked="mixed"] { background: var(--yk-accent); border-color: var(--yk-accent); color: var(--dsw-alias-label-primary-inverted); }
.yk-check[aria-checked="mixed"]::after { content: ''; width: 8px; height: 2px; background: currentColor; }
.yk-wsGroup { display: flex; flex-direction: column; gap: 3px; margin-bottom: 5px; }
.yk-wsHeader { display: flex; align-items: center; gap: 10px; padding: 7px 10px; }
.yk-wsToggleBtn { appearance: none; background: transparent; border: 0; padding: 0; display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; cursor: pointer; text-align: left; color: var(--dsw-alias-label-secondary); }
.yk-wsTitle { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.yk-wsPath { font-size: 11px; color: var(--yk-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
.yk-wsCount { font-size: 11px; color: var(--yk-muted); }
.yk-batchBar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-md); font-size: 13px; }
.yk-batchActions { display: flex; gap: 8px; }
.yk-seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-md); }
.yk-segItem { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; height: 27px; padding: 0 9px; border-radius: calc(var(--dsw-radius-md) - 2px); cursor: pointer; white-space: nowrap; }
.yk-segItem[aria-checked="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.yk-segBadge { font-size: 10px; margin-left: 4px; opacity: .7; }
.yk-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.yk-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.yk-fieldLabel { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.yk-input { height: 34px; width: 100%; min-width: 0; border-radius: var(--dsw-radius-md); border: 1px solid var(--yk-line); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 0 10px; font: inherit; font-size: 13px; outline: none; }
.yk-textarea { height: auto; min-height: 76px; padding: 9px 10px; resize: vertical; line-height: 1.55; }
.yk-textareaTall { min-height: 140px; }
.yk-textareaCode { min-height: 200px; font: 12px/1.5 var(--dsw-font-mono, monospace); }
.yk-stack { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.yk-presetGroup { display: flex; flex-direction: column; gap: 6px; }
.yk-presetGroupHead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.yk-presetId { font-family: var(--dsw-font-mono, monospace); font-size: 11px; }
.yk-presetRows { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.yk-presetRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-md); }
.yk-presetRowHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1; min-width: 0; }
.yk-presetRowName { font-family: var(--dsw-font-mono, monospace); font-size: 12px; overflow-wrap: anywhere; }
.yk-customRow { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px dashed var(--yk-line); border-radius: var(--dsw-radius-md); }
.yk-confirmWrap { padding-left: 12px; }
.yk-footError { color: var(--dsw-alias-state-error-primary); }
.yk-outTall { max-height: 46vh; }
.yk-editor { min-height: 300px; font-family: var(--ds-font-family-code, monospace); font-size: 12px; }
.yk-editorHead { display: flex; align-items: center; justify-content: space-between; }
.yk-importBox { display: flex; align-items: flex-end; gap: 8px; }
.yk-importBox .yk-textarea { flex: 1; }
.yk-settingRow { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px 10px; }
.yk-settingLabel { font-size: 13px; font-weight: 500; white-space: nowrap; }
.yk-settingHint { grid-column: 1 / -1; font-size: 12px; color: var(--yk-muted); }
.yk-settingWarn { color: var(--dsw-alias-state-warn-primary); }
.yk-disclosure { display: flex; flex-direction: column; gap: 10px; }
.yk-disclosureBtn { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 3px 0; align-self: flex-start; }
.yk-disclosureBody { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-lg); }
.yk-banner { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-md); font-size: 12px; }
.yk-bannerInfo { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.yk-bannerWarn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); color: var(--dsw-alias-state-warn-primary); }
.yk-bannerError { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
.yk-confirm { display: flex; flex-direction: column; gap: 9px; padding: 14px; border-radius: var(--dsw-radius-lg); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
.yk-confirmTitle { font-size: 14px; font-weight: 600; }
.yk-confirmHint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.yk-confirmActions { display: flex; gap: 8px; }
.yk-options { display: flex; flex-direction: column; gap: 8px; }
.yk-option { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 13px; }
.yk-option input { margin: 3px 0 0; accent-color: var(--yk-accent); }
.yk-option-danger { color: var(--dsw-alias-state-error-primary); }
.yk-optionText { display: flex; flex-direction: column; gap: 2px; }
.yk-optionHint { font-size: 12px; color: var(--yk-muted); }
.yk-empty, .yk-overlay { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 20px; color: var(--yk-muted); text-align: center; }
.yk-emptyTitle, .yk-overlayTitle { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.yk-emptyHint, .yk-overlayHint { font-size: 12px; max-width: 46ch; }
.yk-node { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--yk-line); border-radius: var(--dsw-radius-md); }
.yk-node-active { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); }
.yk-nodeName { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yk-radio { appearance: none; flex: none; width: 16px; height: 16px; border-radius: 50%; padding: 0; cursor: pointer; border: 1px solid var(--dsw-alias-border-l3); background: transparent; display: grid; place-items: center; }
.yk-radio[aria-checked="true"] { border-color: var(--dsw-alias-state-success-primary); box-shadow: inset 0 0 0 4px var(--dsw-alias-state-success-primary); cursor: default; }
.yk-mono { font-family: var(--ds-font-family-code, var(--dsw-font-mono, monospace)); }
.yk-out { margin: 0; padding: 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); font: 11px/1.5 var(--dsw-font-mono, monospace); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; }
.yk-update, .yk-updatePill { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.yk-updatePill { appearance: none; font: inherit; min-height: 30px; padding: 0 10px; border-radius: var(--dsw-radius-md); font-size: 12px; border: 1px solid var(--yk-line); background: transparent; color: var(--dsw-alias-label-secondary); }
.yk-updatePill-click { cursor: pointer; }
.yk-updatePill-click:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.yk-updateText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
.yk-updateStatus-ok { color: var(--dsw-alias-state-success-primary); }
.yk-updateStatus-warn { color: var(--dsw-alias-state-warn-primary); }
.yk-updateStatus-error { color: var(--dsw-alias-state-error-primary); }
.yk-flash, .yk-flashNote { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-state-success-primary); }
.yk-flashNote-error { color: var(--dsw-alias-state-error-primary); }
.yk-flashNote { font-size: 12px; }
.yk-grow { flex: 1; }
.yk-progress { width: 100%; height: 4px; overflow: hidden; border-radius: 2px; background: var(--dsw-alias-interactive-bg-hover); }
.yk-progressBar { height: 100%; border-radius: inherit; background: var(--yk-accent); transition: width .2s; }
.yk-spin { animation: yk-spin 1s linear infinite; }
@keyframes yk-spin { to { transform: rotate(360deg); } }
@media(max-width: 720px) { .yk-page { padding-inline: 14px; } .yk-serviceGrid, .yk-grid { grid-template-columns: 1fr; } .yk-settingRow { grid-template-columns: 1fr auto; } .yk-settingLabel { grid-column: 1 / -1; } .yk-rows-2col { grid-template-columns: 1fr; } .yk-updateText { max-width: 200px; } }
@media(max-width: 480px) { .yk-form { grid-template-columns: 1fr; } .yk-navTab { padding-inline: 10px; } .yk-navTab svg { display: none; } .yk-btnLabel, .yk-wsPath { display: none; } .yk-importBox { flex-direction: column; align-items: stretch; } .yk-itemActions { flex-wrap: wrap; justify-content: flex-end; } .yk-head { align-items: flex-start; } .yk-updateText { max-width: 150px; } }
@media(prefers-reduced-motion: reduce) { .yk-page * { animation: none !important; transition: none !important; } }
`

    /* --------------------------------------------------------------- helpers */

    function fill(template, values) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
        values !== undefined && key in values ? String(values[key]) : whole,
      )
    }

    function counted(t, singular, plural, count) {
      return count === 1 ? t(singular) : fill(t(plural), { n: count })
    }

    function formatTime(value) {
      const when = new Date(typeof value === 'number' ? value : String(value ?? ''))
      if (Number.isNaN(when.getTime())) return '—'
      const pad = (part) => String(part).padStart(2, '0')
      return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
    }

    function relativeTime(value, t) {
      const when = new Date(typeof value === 'number' ? value : String(value ?? ''))
      if (Number.isNaN(when.getTime())) return '—'
      const seconds = Math.round((Date.now() - when.getTime()) / 1000)
      if (seconds < 60) return t('relativeJustNow')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}${t('relativeMinutes')}`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}${t('relativeHours')}`
      const days = Math.floor(hours / 24)
      return `${days}${t('relativeDays')}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let unitIndex = 0
      let current = value
      while (current >= 1024 && unitIndex < units.length - 1) {
        current /= 1024
        unitIndex += 1
      }
      return `${current.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
    }

    /**
     * One JSON request. A route that is not registered (its component row is
     * turned off) answers 404 or the SPA page instead of JSON: that becomes an
     * error with `off: true`, so tabs can show a hint instead of "HTTP 404".
     */
    async function request(url, init) {
      const response = await fetch(url, { ...init, cache: 'no-store' })
      const type = response.headers.get('content-type') ?? ''
      let payload = null
      if (type.includes('json')) {
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
      }
      if (payload === null) {
        const error = new Error(`HTTP ${response.status}`)
        error.status = response.status
        error.off = response.status === 404 || (response.ok && !type.includes('json'))
        throw error
      }
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error ? String(payload.error) : `HTTP ${response.status}`)
        Object.assign(error, payload)
        error.status = response.status
        error.off = false
        throw error
      }
      return payload
    }

    const getJson = (url, signal) => request(url, { headers: { accept: 'application/json' }, signal })

    const postJson = (url, body, signal) =>
      request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })

    const messageOf = (error) => (error instanceof Error ? error.message : String(error))

    function useAbortOnUnmount() {
      const controllerRef = React.useRef(null)
      if (controllerRef.current === null) controllerRef.current = new AbortController()
      const aliveRef = React.useRef(true)
      React.useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          controllerRef.current.abort()
        }
      }, [])
      return { signal: controllerRef.current.signal, alive: aliveRef }
    }

    function Loading({ text }) {
      return h('div', { className: 'yk-foot', role: 'status' }, h(Spinner), text)
    }

    /* ----------------------------------------------------------------- icons */

    const glyph = (children, props) =>
      h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          ...(props ?? {}),
        },
        children,
      )

    const stroke = (d, extra) =>
      h('path', {
        d,
        stroke: 'currentColor',
        strokeWidth: 1.75,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...(extra ?? {}),
      })

    const RefreshIcon = (props) =>
      glyph(
        [
          stroke('M19.5 12a7.5 7.5 0 1 1-2.2-5.3', { key: 'a' }),
          stroke('M19.8 4.6v4.6h-4.6', { key: 'b' }),
        ],
        props,
      )
    const SearchIcon = (props) =>
      glyph(
        [
          h('circle', { key: 'c', cx: 11, cy: 11, r: 6.6, stroke: 'currentColor', strokeWidth: 1.75 }),
          stroke('M16.2 16.2 20.5 20.5', { key: 'l' }),
        ],
        props,
      )
    const CheckIcon = (props) => glyph(stroke('M5.2 12.6 9.6 17 19 7.4'), props)
    const TrashIcon = (props) =>
      glyph(
        [
          stroke('M4.5 7h15', { key: 'a' }),
          stroke('M9.6 7V5.3h4.8V7', { key: 'b' }),
          stroke('M6.8 7 7.7 19.2h8.6L17.2 7', { key: 'c' }),
        ],
        props,
      )
    const PowerIcon = (props) => glyph([stroke('M12 3.6v8', { key: 'a' }), stroke('M7.4 6.6a7.4 7.4 0 1 0 9.2 0', { key: 'b' })], props)
    const DownloadIcon = (props) =>
      glyph(
        [
          stroke('M12 4v9.6', { key: 'a' }),
          stroke('M8.4 10.4 12 13.9l3.6-3.5', { key: 'b' }),
          stroke('M4.9 17.6v1.1a1.5 1.5 0 0 0 1.5 1.5h11.2a1.5 1.5 0 0 0 1.5-1.5v-1.1', { key: 'c' }),
        ],
        props,
      )
    const LinkIcon = (props) =>
      glyph(
        [
          stroke('M8.6 15.4 15.4 8.6', { key: 'a' }),
          stroke('M10 8.6h5.4V14', { key: 'b' }),
        ],
        props,
      )
    const ChatIcon = (props) =>
      glyph(
        [
          stroke('M20 12.2c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4.4 19.8l1.2-3.3A6.1 6.1 0 0 1 4 12.2C4 8.6 7.6 5.7 12 5.7s8 2.9 8 6.5Z', { key: 'a' }),
        ],
        props,
      )
    /** A published page: a frame with a title bar, distinct from the globe used by the browser. */
    const SitesIcon = (props) =>
      glyph(
        [
          h('rect', { key: 'r', x: 3.6, y: 4.8, width: 16.8, height: 14.4, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.75 }),
          stroke('M3.6 9.2h16.8', { key: 'a' }),
          stroke('M7.4 15.4h5.2', { key: 'b' }),
        ],
        props,
      )

    const GlobeIcon = (props) =>
      glyph(
        [
          h('circle', { key: 'c', cx: 12, cy: 12, r: 7.4, stroke: 'currentColor', strokeWidth: 1.75 }),
          stroke('M4.8 12h14.4', { key: 'a' }),
          stroke('M12 4.6c2 2.2 3 4.6 3 7.4s-1 5.2-3 7.4c-2-2.2-3-4.6-3-7.4s1-5.2 3-7.4Z', { key: 'b' }),
        ],
        props,
      )
    const RouteIcon = (props) =>
      glyph(
        [
          h('circle', { key: 'a', cx: 6.4, cy: 7.2, r: 2.4, stroke: 'currentColor', strokeWidth: 1.75 }),
          h('circle', { key: 'b', cx: 17.6, cy: 16.8, r: 2.4, stroke: 'currentColor', strokeWidth: 1.75 }),
          stroke('M8.8 7.2h4.1a3.4 3.4 0 0 1 3.4 3.4v.6a3.2 3.2 0 0 1-3.2 3.2H8.6', { key: 'c' }),
        ],
        props,
      )
    const OpenIcon = (props) =>
      glyph(
        [
          stroke('M13.4 5.6h5v5', { key: 'a' }),
          stroke('M18.4 5.6 11 13', { key: 'b' }),
          stroke('M16.4 13.6v3.8a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 17.4V9.2a1.6 1.6 0 0 1 1.6-1.6h3.8', { key: 'c' }),
        ],
        props,
      )
    const ArchiveIcon = (props) =>
      glyph(
        [
          stroke('M3.8 5.2h16.4v3.6H3.8z', { key: 'a' }),
          stroke('M5.4 8.8v9a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6v-9', { key: 'b' }),
          stroke('M12 11.6v4.8', { key: 'c' }),
          stroke('M9.8 14.4 12 16.6l2.2-2.2', { key: 'd' }),
        ],
        props,
      )
    const OverviewIcon = (props) =>
      glyph(
        [
          stroke('M4 5h6v6H4z', { key: 'a' }),
          stroke('M14 5h6v4H14z', { key: 'b' }),
          stroke('M14 13h6v6H14z', { key: 'c' }),
          stroke('M4 15h6v4H4z', { key: 'd' }),
        ],
        props,
      )
    const ClearIcon = (props) =>
      glyph(
        [
          stroke('M18 6 6 18', { key: 'a' }),
          stroke('M6 6 18 18', { key: 'b' }),
        ],
        props,
      )
    const EyeIcon = (props) =>
      glyph(
        [
          stroke('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z', { key: 'a' }),
          h('circle', { key: 'b', cx: 12, cy: 12, r: 3, stroke: 'currentColor', strokeWidth: 1.75 }),
        ],
        props,
      )
    const EyeOffIcon = (props) =>
      glyph(
        [
          stroke('M9.88 9.88a3 3 0 1 0 4.24 4.24', { key: 'a' }),
          stroke('M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68', { key: 'b' }),
          stroke('M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61', { key: 'c' }),
          stroke('M2 2 22 22', { key: 'd' }),
        ],
        props,
      )
    const CopyIcon = (props) =>
      glyph(
        [
          stroke('M16 4H8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z', { key: 'a' }),
          stroke('M4 8v10a2 2 0 0 0 2 2h10', { key: 'b' }),
        ],
        props,
      )
    const PurgeIcon = (props) =>
      glyph(
        [
          stroke('M12 3.2 4.8 6.4v5.4c0 4.8 3.1 9.2 7.2 10.2 4.1-1 7.2-5.4 7.2-10.2V6.4L12 3.2Z', { key: 'a' }),
          stroke('M12 8.4v7.2', { key: 'b' }),
          stroke('M9.6 12h4.8', { key: 'c' }),
        ],
        props,
      )
    const FolderIcon = (props) =>
      glyph(
        [
          stroke('M3.8 6.4h4.4l2 2.2h8a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V7.8a1.4 1.4 0 0 1 1.4-1.4Z', { key: 'a' }),
        ],
        props,
      )
    /** Rules: a document whose body carries a check, distinct from the purge shield. */
    const RulesIcon = (props) =>
      glyph(
        [
          stroke('M6 3.8h8.4L19 8.4v11.8H6V3.8Z', { key: 'a' }),
          stroke('M14.4 3.8v4.6H19', { key: 'b' }),
          stroke('M9.2 12.8l1.9 1.9 3.7-4.1', { key: 'c' }),
          stroke('M9.2 17.6h5.6', { key: 'd' }),
        ],
        props,
      )
    /** Github: a branch with a commit, distinct from the proxy route. */
    const GithubIcon = (props) =>
      glyph(
        [
          h('circle', { key: 'a', cx: 6.4, cy: 5.8, r: 2.2, stroke: 'currentColor', strokeWidth: 1.75 }),
          h('circle', { key: 'b', cx: 6.4, cy: 18.2, r: 2.2, stroke: 'currentColor', strokeWidth: 1.75 }),
          h('circle', { key: 'c', cx: 17.6, cy: 8.2, r: 2.2, stroke: 'currentColor', strokeWidth: 1.75 }),
          stroke('M6.4 8v8', { key: 'd' }),
          stroke('M17.6 10.4c0 4.4-3.4 6.6-8 6.8', { key: 'e' }),
        ],
        props,
      )
    /** Presets: stacked layers, one composition over another. */
    const PresetsIcon = (props) =>
      glyph(
        [
          stroke('M4 8.4 12 4.2l8 4.2-8 4.2-8-4.2Z', { key: 'a' }),
          stroke('M4 12.4l8 4.2 8-4.2', { key: 'b' }),
          stroke('M4 16.2l8 4.2 8-4.2', { key: 'c' }),
        ],
        props,
      )
    const ChevronDownIcon = (props) => glyph(stroke('M6 9l6 6 6-6'), props)
    const ChevronRightIcon = (props) => glyph(stroke('M9 6l6 6-6 6'), props)

    const Spinner = ({ size }) => h(RefreshIcon, { className: 'yk-spin', width: size ?? 15, height: size ?? 15 })

    /* ----------------------------------------------------------- primitives */

    function Chip({ kind, dot, children }) {
      return h(
        'span',
        { className: kind === undefined ? 'yk-chip' : `yk-chip yk-chip-${kind}` },
        dot === true ? h('span', { className: 'yk-chip-dot', 'aria-hidden': true }) : null,
        children,
      )
    }

    function Row({ label, value, mono, chips, clamp, action }) {
      return h(
        'div',
        { className: 'yk-row' },
        h('span', { className: 'yk-key' }, label),
        h(
          'span',
          { className: ['yk-val', mono === true ? 'yk-mono' : '', clamp === true ? 'yk-val-clamp' : ''].filter(Boolean).join(' ') },
          value,
          action ?? null,
          (chips ?? []).map((chip, index) =>
            h(Chip, { key: index, kind: chip.kind, dot: chip.dot }, chip.text),
          ),
        ),
      )
    }

    function Card({ title, icon, note, action, span, children }) {
      return h(
        'section',
        { className: span === true ? 'yk-card yk-card-wide' : 'yk-card' },
        h(
          'div',
          { className: 'yk-cardHead' },
          h(
            'div',
            { className: 'yk-cardTitleWrap' },
            icon ?? null,
            h('h2', { className: 'yk-cardTitle' }, title),
            note !== undefined ? h('span', { className: 'yk-cardNote' }, note) : null,
          ),
          action ?? null,
        ),
        children,
      )
    }

    function Banner({ kind, text, action }) {
      return h(
        'div',
        { className: `yk-banner yk-banner${kind === undefined ? 'Info' : kind === 'error' ? 'Error' : kind === 'warn' ? 'Warn' : 'Info'}` },
        h('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, text),
        action ?? null,
      )
    }

    function Empty({ icon, title, hint }) {
      return h(
        'div',
        { className: 'yk-empty' },
        icon !== undefined ? icon : null,
        h('div', { className: 'yk-emptyTitle' }, title),
        hint !== undefined ? h('div', { className: 'yk-emptyHint' }, hint) : null,
      )
    }

    function Segmented({ value, items, onChange, label }) {
      return h(
        'div',
        { className: 'yk-seg', role: 'radiogroup', 'aria-label': label },
        items.map((item) =>
          h(
            'button',
            {
              key: item.key,
              type: 'button',
              role: 'radio',
              className: 'yk-segItem',
              'aria-checked': item.key === value ? 'true' : 'false',
              tabIndex: item.key === value ? 0 : -1,
              onClick: () => onChange(item.key),
            },
            item.label,
            item.count !== undefined ? h('span', { className: 'yk-segBadge' }, String(item.count)) : null,
          ),
        ),
      )
    }

    function CopyButton({ text, label, t }) {
      const [copied, setCopied] = React.useState(false)
      const onCopy = async (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
          }
        } catch {
          /* ignore */
        }
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'yk-copyBtn',
          title: copied ? t('copied') : label ?? t('copy'),
          'aria-label': copied ? t('copied') : label ?? t('copy'),
          onClick: onCopy,
        },
        copied ? h(CheckIcon, { width: 13, height: 13 }) : h(CopyIcon, { width: 13, height: 13 }),
      )
    }

    /* ------------------------------------------------------- shared pieces */

    /** Component key → its label key, in tab order. */
    const COMPONENT_LABEL = {
      chats: 'compChats',
      sites: 'compSites',
      files: 'compFiles',
      rules: 'compRules',
      presets: 'compPresets',
      proxy: 'compProxy',
      github: 'compGithub',
      purge: 'compPurge',
      browser: 'compBrowser',
      runtime: 'compRuntime',
    }

    /**
     * The panel's one destructive confirmation: a title, one line of
     * consequence, cancel, and the danger action. Rendered under the row it
     * belongs to, so the trigger stays where the user found it.
     */
    function ConfirmStrip({ t, title, hint, confirmLabel, onCancel, onConfirm, busy }) {
      return h(
        'div',
        { className: 'yk-confirm yk-confirmInline', role: 'alertdialog', 'aria-label': title },
        h('div', { className: 'yk-confirmTitle' }, title),
        hint ? h('div', { className: 'yk-confirmHint' }, hint) : null,
        h(
          'div',
          { className: 'yk-confirmActions' },
          h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: onCancel, disabled: busy === true }, t('cancel')),
          h(
            'button',
            { type: 'button', className: 'yk-btn yk-btn-danger yk-btn-sm', onClick: onConfirm, disabled: busy === true },
            busy === true ? h(Spinner, { size: 13 }) : null,
            confirmLabel,
          ),
        ),
      )
    }

    /** Placeholder shown instead of an error when a component row is turned off. */
    function OffState({ t, name }) {
      const label = t(COMPONENT_LABEL[name] ?? name)
      return h(Empty, {
        icon: h(PowerIcon, { width: 22, height: 22 }),
        title: fill(t('offTitle'), { name: label }),
        hint: fill(t('offHint'), { name: label }),
      })
    }

    /** Error banner, or the off placeholder when the component is gone. */
    function Failure({ t, name, error, onRetry }) {
      if (error === null || error === undefined) return null
      if (error.off === true) return h(OffState, { t, name })
      return h(Banner, {
        kind: 'error',
        text: error.message,
        action: onRetry ? h('button', { type: 'button', className: 'yk-btn', onClick: onRetry }, t('retry')) : undefined,
      })
    }

    /** Normalise a thrown value into `{ message, off }`. */
    const failureOf = (error) => ({ message: messageOf(error), off: error?.off === true })

    /** Checkbox row with an optional hint underneath. */
    function Option({ checked, onChange, label, hint, danger, disabled }) {
      return h(
        'label',
        { className: danger ? 'yk-option yk-option-danger' : 'yk-option' },
        h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) }),
        h('span', { className: 'yk-optionText' }, h('span', null, label), hint ? h('span', { className: 'yk-optionHint' }, hint) : null),
      )
    }

    /**
     * Short-lived confirmation shown where the action happened (on the button
     * or next to it) instead of a banner row that pushes the page around.
     * @returns `[flash, show]`; `show(key, text)` clears itself after `ms`.
     */
    function useFlash(ms = 3200) {
      const [flash, setFlash] = React.useState(null)
      const timer = React.useRef(null)
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const show = React.useCallback(
        (key, text = '') => {
          clearTimeout(timer.current)
          setFlash({ key, text })
          timer.current = setTimeout(() => setFlash(null), ms)
        },
        [ms],
      )
      return [flash, show]
    }

    /** Button content that briefly turns into "✓ text" after its action. */
    const flashed = (flash, key, content) =>
      flash?.key === key ? h('span', { className: 'yk-flash' }, h(CheckIcon, { width: 13, height: 13 }), flash.text) : content

    /** Inline result text next to an action: a check for success, plain red for a problem. */
    const FlashNote = ({ flash, keys, kind }) =>
      flash !== null && keys.includes(flash.key) && flash.text
        ? h(
            'span',
            { className: kind === 'error' ? 'yk-flashNote yk-flashNote-error' : 'yk-flashNote', role: 'status' },
            kind === 'error' ? null : h(CheckIcon, { width: 13, height: 13 }),
            flash.text,
          )
        : null

    /** Collapsible "advanced settings" section at the bottom of a tab. */
    function Disclosure({ title, badge, children, defaultOpen }) {
      const [open, setOpen] = React.useState(defaultOpen === true)
      return h(
        'div',
        { className: 'yk-disclosure' },
        h(
          'button',
          { type: 'button', className: 'yk-disclosureBtn', 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen((value) => !value) },
          h(open ? ChevronDownIcon : ChevronRightIcon, { width: 14, height: 14 }),
          title,
          badge ?? null,
        ),
        open ? h('div', { className: 'yk-disclosureBody' }, children) : null,
      )
    }

    /** Wait for the server to come back after a restart, then reload. */
    function RestartWatch({ t }) {
      const [phase, setPhase] = React.useState('waiting')
      React.useEffect(() => {
        let count = 0
        let stopped = false
        // Give the old process time to go away before the first probe.
        const timer = setInterval(async () => {
          count += 1
          if (count > 60) {
            clearInterval(timer)
            setPhase('slow')
            return
          }
          if (count < 3) return
          try {
            const response = await fetch(API.overview, { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (response.ok && !stopped) {
              clearInterval(timer)
              setPhase('back')
              setTimeout(() => window.location.reload(), 800)
            }
          } catch {
            /* still down */
          }
        }, 1000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [])
      return h(
        'div',
        { className: 'yk-overlay', role: 'status' },
        phase === 'back' ? h(CheckIcon, { width: 26, height: 26 }) : h(Spinner, { size: 26 }),
        h('div', { className: 'yk-overlayTitle' }, phase === 'back' ? t('rBack') : t('rRestarting')),
        h('div', { className: 'yk-overlayHint' }, phase === 'slow' ? t('rRestartSlow') : t('rRestartingHint')),
      )
    }

    /** Ask whichever restart endpoint is available. */
    async function requestRestart(components) {
      if (components?.runtime) {
        await postJson(`${API.runtime}/restart`, { delayMs: 600 })
      } else {
        await postJson(API.restart, {})
      }
    }

    /** Search box with a clear button. */
    function SearchBox({ value, onChange, placeholder, t }) {
      return h(
        'label',
        { className: 'yk-search' },
        h(SearchIcon),
        h('input', { value, placeholder, 'aria-label': placeholder, onChange: (event) => onChange(event.target.value) }),
        value !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'yk-searchClear',
                title: t('clearSearch'),
                'aria-label': t('clearSearch'),
                onClick: (event) => {
                  event.preventDefault()
                  onChange('')
                },
              },
              h(ClearIcon, { width: 12, height: 12 }),
            )
          : null,
      )
    }

    const RefreshButton = ({ t, onClick, spinning }) =>
      h(
        'button',
        { type: 'button', className: 'yk-btn yk-iconBtn yk-btn-ghost', onClick, disabled: spinning, title: t('refresh'), 'aria-label': t('refresh') },
        h(RefreshIcon, { className: spinning ? 'yk-spin' : undefined }),
      )

    /* ---------------------------------------------------------------- overview */

    /** Panel order for the overview grid: mounted components are buttons, the rest are greyed. */
    const OVERVIEW_ORDER = ['chats', 'files', 'rules', 'presets', 'sites', 'proxy', 'github', 'browser', 'purge', 'runtime']

    function OverviewTab({ t, components, onGo }) {
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const { signal, alive } = useAbortOnUnmount()
      const on = (name) => components === null || Boolean(components[name])

      const load = React.useCallback(async () => {
        setBusy(true)
        const want = (name, url) => (on(name) ? getJson(url, signal) : Promise.resolve(null))
        const settled = await Promise.allSettled([
          want('chats', `${API.chats}/state`),
          want('runtime', `${API.runtime}/state`),
          want('sites', `${API.sites}/list`),
          want('proxy', `${API.proxy}/state`),
          want('browser', `${API.browser}/state`),
          want('files', `${API.files}/roots`),
          want('purge', `${API.purge}/config`),
          want('rules', `${API.rules}/config`),
          want('github', `${API.github}/state`),
          want('presets', `${API.presets}/state`),
        ])
        if (!alive.current) return
        const pick = (index) => (settled[index].status === 'fulfilled' ? settled[index].value : null)
        const broken = settled.find((item) => item.status === 'rejected' && item.reason?.name !== 'AbortError')
        setState({
          chats: pick(0)?.state ?? null,
          runtime: pick(1)?.state ?? null,
          sites: pick(2),
          proxy: pick(3)?.state ?? null,
          browser: pick(4)?.state ?? null,
          files: pick(5),
          purge: pick(6),
          rules: pick(7),
          github: pick(8)?.state ?? null,
          presets: pick(9)?.items ?? null,
        })
        setFailure(broken === undefined ? null : failureOf(broken.reason))
        setBusy(false)
      }, [components])

      React.useEffect(() => { load() }, [load])

      const { chats, runtime, sites, proxy, browser, files, purge, rules, github, presets } = state ?? {}
      const activeNode = proxy?.nodes?.find((node) => node.active)
      const browserBusy = browser?.status === 'installing' || browser?.status === 'checking'
      const pending = busy ? t('loading') : ''

      const detail = {
        chats: [chats ? fill(t('cTotal'), { n: chats.totals.all }) : '—', chats ? `${chats.totals.archived} ${t('ovArchived')} · ${formatBytes(chats.totals.bytes)}` : pending],
        files: [files?.roots ? fill(t('ovFiles'), { n: files.roots.length }) : '—', files?.roots?.[0]?.title ?? pending],
        sites: [sites ? counted(t, 'sCountOne', 'sCount', sites.sites.length) : '—', sites?.sites?.[0]?.title ?? t('sEmpty')],
        proxy: [proxy ? (proxy.enabled ? t('pEnabled') : t('pDisabled')) : '—', activeNode?.name ?? t('pNoNodes')],
        github: [
          github ? (github.configured ? t('ghConnected') : t('ghDisconnected')) : '—',
          github?.account?.login ?? (github?.git?.helperInstalled ? t('ghHelperOn') : t('ghHelperOff')),
        ],
        browser: [
          browser?.status === 'ready' ? t('ovReady') : browserBusy ? t('bInstalling') : t('bAutomatic'),
          browser?.version ?? `${components?.browser?.viewportWidth ?? 1280}×${components?.browser?.viewportHeight ?? 900}`,
        ],
        purge: [
          purge?.stats?.assembled > 0 ? fill(t('ovPurgeUsed'), { n: purge.stats.assembled }) : t('ovReady'),
          t('ovPurgeHow'),
        ],
        rules: [
          rules
            ? fill(t('ovRulesActive'), {
                n:
                  (rules.global?.exists && rules.global.bytes > 0 ? 1 : 0) +
                  (rules.workspaces ?? []).filter((workspace) => workspace.exists && workspace.bytes > 0).length,
              })
            : '—',
          rules?.stats?.assembled > 0 ? fill(t('ovPurgeUsed'), { n: rules.stats.assembled }) : t('ovRulesHow'),
        ],
        presets: [
          presets ? fill(t('ovPresets'), { n: presets.length }) : '—',
          presets?.find((item) => item.isDefault)?.name ?? t('ovPresetsHow'),
        ],
        runtime: [`DSH ${runtime?.runtime?.version ?? '—'}`, runtime?.disk?.stale ? t('rNeedsRestart') : runtime?.runtime?.uptime ?? t('rCheck')],
      }
      const icons = { chats: ChatIcon, files: FolderIcon, rules: RulesIcon, presets: PresetsIcon, sites: SitesIcon, proxy: RouteIcon, github: GithubIcon, browser: GlobeIcon, purge: PurgeIcon, runtime: PowerIcon }

      return h(
        'div',
        { className: 'yk-body' },
        h(Failure, { t, name: 'overview', error: failure, onRetry: load }),
        h(
          'div',
          { className: 'yk-toolbar' },
          h('span', { className: 'yk-foot' }, fill(t('ovCount'), { n: OVERVIEW_ORDER.filter(on).length })),
          h('span', { className: 'yk-grow' }),
          h(RefreshButton, { t, onClick: load, spinning: busy }),
        ),
        state === null && busy
          ? h(Loading, { text: t('loading') })
          : h(
              'div',
              { className: 'yk-serviceGrid' },
              OVERVIEW_ORDER.map((key) => {
                const [value, hint] = detail[key]
                const Icon = icons[key]
                return on(key)
                  ? h(
                      'button',
                      { type: 'button', className: 'yk-service', key, onClick: () => onGo(key) },
                      h('div', { className: 'yk-serviceHead' }, h(Icon, { width: 16, height: 16 }), h('span', { className: 'yk-serviceTitle' }, t(COMPONENT_LABEL[key])), h('span', { className: 'yk-serviceArrow' }, '→')),
                      h('div', { className: 'yk-serviceValue' }, value),
                      h('div', { className: 'yk-serviceHint' }, hint),
                    )
                  : h(
                      'div',
                      { className: 'yk-service yk-service-off', key, 'aria-disabled': 'true' },
                      h('div', { className: 'yk-serviceHead' }, h(Icon, { width: 16, height: 16 }), h('span', { className: 'yk-serviceTitle' }, t(COMPONENT_LABEL[key]))),
                      h('div', { className: 'yk-serviceHint' }, t('ovOff')),
                    )
              }),
            ),
      )
    }

    function BrowserTab({ t }) {
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const { signal, alive } = useAbortOnUnmount()
      const load = React.useCallback(async (quiet = false) => {
        try { const payload = await getJson(`${API.browser}/state`, signal); if (alive.current) { setState(payload.state); setFailure(null) } }
        catch (error) { if (!quiet && alive.current && error?.name !== 'AbortError') setFailure(failureOf(error)) }
      }, [])
      React.useEffect(() => { load() }, [load])
      const status = state?.status
      React.useEffect(() => {
        if (status !== 'installing' && status !== 'checking') return undefined
        const timer = setInterval(() => load(true), 1500)
        return () => clearInterval(timer)
      }, [status, load])
      const retry = async () => { try { setFailure(null); setState((await postJson(`${API.browser}/install/retry`, {})).state) } catch (error) { setFailure(failureOf(error)) } }
      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'browser' }))
      const busy = status === 'installing' || status === 'checking'
      return h('div', { className: 'yk-body' },
        h(Failure, { t, name: 'browser', error: failure, onRetry: load }),
        h(Card, { title: t('compBrowser'), icon: h(GlobeIcon, { width: 16, height: 16 }), action: h(RefreshButton, { t, onClick: load, spinning: busy }) },
          h('p', { className: 'yk-cardText' }, t('bDesc')),
          state === null ? h(Loading, { text: t('loading') }) : h(React.Fragment, null,
            h('div', { className: 'yk-heroTitle' }, busy ? t('bInstalling') : status === 'ready' ? t('ovReady') : t('bInstall')),
            state?.version ? h('div', { className: 'yk-cardHint' }, `Chrome for Testing ${state.version}`) : null,
            state?.libraries
              ? h('div', { className: 'yk-cardHint' }, fill(t('bLibraries'), { n: state.libraries.packages }))
              : null,
            status === 'ready' && state?.launch
              ? state.launch.ok
                ? h(Chip, { kind: 'ok', dot: true }, t('bLaunchOk'))
                : h(React.Fragment, null,
                    h('div', { className: 'yk-toolbar' },
                      h(Chip, { kind: 'danger', dot: true }, t('bLaunchFail')),
                      state.launch.missing?.length > 0
                        ? h(Chip, { kind: 'warn' }, fill(t('bMissingLibs'), { n: state.launch.missing.length }))
                        : null,
                    ),
                    h(Banner, { kind: 'warn', text: t('bLaunchFailHint') }),
                    state.launch.missing?.length > 0
                      ? h('div', { className: 'yk-mono yk-libs' }, state.launch.missing.slice(0, 8).join(', ') + (state.launch.missing.length > 8 ? ` +${state.launch.missing.length - 8}` : ''))
                      : null,
                    state.launch.command
                      ? h(React.Fragment, null,
                          h('div', { className: 'yk-cardHint' }, t('bFixHint')),
                          h('div', { className: 'yk-cmdRow' },
                            h('pre', { className: 'yk-out' }, state.launch.command),
                            h(CopyButton, { text: state.launch.command, label: t('copy'), t }),
                          ),
                        )
                      : null,
                  )
              : null,
            busy ? h('div', { className: 'yk-progress', role: 'progressbar', 'aria-valuenow': state?.percent ?? 0 }, h('div', { className: 'yk-progressBar', style: { width: `${state?.percent ?? 5}%` } })) : null,
            status === 'error' ? h(Banner, { kind: 'error', text: state.error }) : null,
            !busy ? h('div', null, h('button', { type: 'button', className: 'yk-btn', onClick: retry }, h(DownloadIcon), status === 'ready' ? t('bVerify') : t('bInstall'))) : null,
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- chats */

    const CHATS_GROUP_KEY = 'yukari-dsh-plugin:chats-group'

    function ChatsTab({ t, ui }) {
      const [data, setData] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [flash, show] = useFlash()
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [groupBy, setGroupByState] = React.useState(() => {
        try {
          return window.localStorage.getItem(CHATS_GROUP_KEY) === 'flat' ? 'flat' : 'workspace'
        } catch {
          return 'workspace'
        }
      })
      const [collapsed, setCollapsed] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [confirming, setConfirming] = React.useState(null)
      const [rowConfirm, setRowConfirm] = React.useState(null)
      const [expandedKids, setExpandedKids] = React.useState([])
      const [deleteFiles, setDeleteFiles] = React.useState(false)
      const [deleteDir, setDeleteDir] = React.useState(false)
      const { signal, alive } = useAbortOnUnmount()

      const setGroupBy = (value) => {
        setGroupByState(value)
        try {
          window.localStorage.setItem(CHATS_GROUP_KEY, value)
        } catch {
          /* memory only */
        }
      }

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.chats}/state`, signal)
          if (!alive.current) return
          setData(payload.state)
          setFailure(null)
          setSelected((current) => current.filter((id) => payload.state.sessions.some((row) => row.id === id)))
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      React.useEffect(() => {
        if (confirming === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setConfirming(null)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [confirming])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'chats' }))

      const rows = data === null ? [] : data.sessions
      const needle = query.trim().toLowerCase()
      const visible = rows.filter((row) => {
        if (filter === 'active' && row.archived) return false
        if (filter === 'archived' && !row.archived) return false
        if (needle === '') return true
        return [row.title ?? '', row.id, row.cwd ?? '', row.workspaceTitle ?? ''].join('\n').toLowerCase().includes(needle)
      })

      const groups = (() => {
        if (groupBy !== 'workspace') return null
        const map = new Map()
        for (const ws of data?.workspaces ?? []) {
          map.set(ws.id, { id: ws.id, registered: true, title: ws.title || ws.path || ws.id, path: ws.path || '', rows: [] })
        }
        const loose = { id: '__none__', registered: false, title: t('cWorkspaceUnassigned'), path: '', rows: [] }
        for (const row of visible) {
          if (row.workspaceId && map.has(row.workspaceId)) {
            map.get(row.workspaceId).rows.push(row)
          } else if (row.cwd) {
            const key = `cwd:${row.cwd}`
            if (!map.has(key)) {
              const base = row.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || row.cwd
              map.set(key, { id: key, registered: false, title: base, path: row.cwd, rows: [] })
            }
            map.get(key).rows.push(row)
          } else {
            loose.rows.push(row)
          }
        }
        // Registered workspaces without chats stay listed (unfiltered view) so they can be deleted too.
        const showEmpty = needle === '' && filter === 'all'
        const list = [...map.values()].filter((group) => group.rows.length > 0 || (showEmpty && group.registered))
        if (loose.rows.length > 0) list.push(loose)
        return list
      })()


      const ask = (target) => {
        setRowConfirm(null)
        setDeleteFiles(false)
        setDeleteDir(target.workspace !== undefined)
        setConfirming(target)
      }

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          return await operation()
        } catch (error) {
          setFailure(failureOf(error))
          return null
        } finally {
          setBusy('')
        }
      }

      /**
       * One delete request, shared by the inline row confirm and the batch or
       * workspace panel at the top of the list.
       */
      const performDelete = ({ ids, deleteFiles: withFiles, workspace, deleteWorkspaceDir }) =>
        run('delete', async () => {
          const payload = await postJson(`${API.chats}/delete`, {
            ids,
            deleteFiles: withFiles === true,
            deleteWorkspace: workspace !== undefined,
            deleteWorkspaceDir: workspace !== undefined && deleteWorkspaceDir === true,
            workspaceId: workspace?.registered ? workspace.id : undefined,
            workspacePath: workspace?.path || undefined,
          })
          setData(payload.state)
          setSelected((current) => current.filter((id) => !payload.ids.includes(id)))
          setConfirming(null)
          setRowConfirm(null)
          const parts = [fill(t('cDeleted'), { n: payload.deleted ?? 0 })]
          if (payload.filesDeleted > 0) parts.push(fill(t('cFilesDeleted'), { n: payload.filesDeleted }))
          if (payload.workspaceDirDeleted) parts.push(t('cDirDeleted'))
          else if (payload.workspaceRemoved) parts.push(t('cWorkspaceRemoved'))
          show('delete', parts.join(' · '))
          const problems = [
            // A reason with no translation is a raw message from the host: show
            // it rather than the key that would have named it.
            ...(payload.failed ?? []).map((item) => {
              const row = rows.find((candidate) => candidate.id === item.id)
              const label = t(`cReason_${item.reason}`)
              const text = label.startsWith('cReason_')
                ? item.detail ?? item.reason
                : item.detail
                  ? `${label}（${item.detail}）`
                  : label
              return `${row?.title ?? item.id} · ${text}`
            }),
            ...(payload.notes ?? []),
          ]
          if (problems.length > 0) setFailure({ message: problems.slice(0, 6).join('；'), off: false })
        })

      const remove = () => {
        const target = confirming
        if (target === null) return
        return performDelete({
          ids: target.ids,
          deleteFiles,
          workspace: target.workspace,
          deleteWorkspaceDir: deleteDir,
        })
      }

      const archive = (row) =>
        run('archive', async () => {
          const payload = await postJson(`${API.chats}/archive`, { id: row.id, archived: !row.archived })
          setData(payload.state)
        })

      const openSession = (id) => {
        try {
          ui.openSession(id)
        } catch (error) {
          setFailure(failureOf(error))
        }
      }

      const confirmRows = confirming === null ? [] : rows.filter((row) => confirming.ids.includes(row.id))
      const hasLive = confirmRows.some((row) => row.live)
      const confirmTitle =
        confirming === null
          ? ''
          : confirming.workspace !== undefined
            ? fill(t('cConfirmWorkspace'), { name: confirming.workspace.title, n: confirming.ids.length })
            : fill(t('cConfirm'), { n: confirming.ids.length })

      /** Children of one chat inside the current (already filtered) group. */
      const childrenOf = (group, id) => group.rows.filter((row) => row.parentSession === id)

      /** Every descendant id of one chat, depth first. */
      const descendantsOf = (group, id) => {
        const found = []
        for (const child of childrenOf(group, id)) {
          found.push(child.id, ...descendantsOf(group, child.id))
        }
        return found
      }

      /**
       * Selecting a chat selects its subagent chats too and deselecting clears
       * them: deleting a parent must never leave its children behind, so a
       * child cannot be unticked while an ancestor is selected.
       */
      const toggleRow = (row, group) => {
        const family = descendantsOf(group, row.id)
        setSelected((current) => {
          if (current.includes(row.id)) return current.filter((id) => id !== row.id && !family.includes(id))
          return [...new Set([...current, row.id, ...family])]
        })
      }

      /**
       * One chat row. A single delete confirms in place, under that row; only
       * batch and whole-workspace deletes use the panel at the top.
       */
      const renderRow = (row, group, depth = 0, locked = false) => {
        const checked = selected.includes(row.id)
        const pending = rowConfirm !== null && rowConfirm.id === row.id ? rowConfirm : null
        const kids = depth < 3 ? childrenOf(group, row.id) : []
        const kidsOpen = depth === 0 ? expandedKids.includes(row.id) : true
        const meta = [
          groupBy === 'flat' ? row.workspaceTitle ?? null : null,
          relativeTime(row.updatedAt, t),
          row.bytes === null ? null : formatBytes(row.bytes),
          row.events === null ? null : fill(t('cEvents'), { n: row.events }),
        ].filter((item) => item !== null && item !== '')

        // Deleting a parent takes its subagent chats with it; otherwise they
        // would be left behind as orphans.
        const family = descendantsOf(group, row.id)
        const confirmTitle = family.length > 0 ? fill(t('cDeleteOneSub'), { n: family.length }) : t('cDeleteOne')
        const confirmStrip = pending === null ? null : h(
          'div',
          { className: 'yk-confirm yk-confirmInline', role: 'alertdialog', 'aria-label': confirmTitle },
          h('div', { className: 'yk-confirmTitle' }, confirmTitle),
          h('div', { className: 'yk-confirmHint' }, row.live ? t('cLiveBlockedOne') : t('cConfirmHint')),
          h(
            'div',
            { className: 'yk-options' },
            h(Option, {
              checked: pending.deleteFiles === true,
              onChange: (value) => setRowConfirm({ ...pending, deleteFiles: value }),
              label: t('cDeleteFiles'),
              hint: t('cDeleteFilesHint'),
            }),
          ),
          h(
            'div',
            { className: 'yk-confirmActions' },
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setRowConfirm(null), disabled: busy !== '' }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'yk-btn yk-btn-danger yk-btn-sm',
                disabled: busy !== '' || row.live,
                onClick: () => performDelete({ ids: [row.id, ...family], deleteFiles: pending.deleteFiles === true }),
              },
              busy === 'delete' ? h(Spinner, { size: 13 }) : h(TrashIcon, { width: 13, height: 13 }),
              t('cDelete'),
            ),
          ),
        )

        return h(
          'div',
          { className: depth === 0 ? 'yk-itemWrap' : 'yk-itemWrap yk-childWrap', key: row.id },
          h(
            'div',
            { className: checked ? 'yk-item yk-item-selected' : 'yk-item' },
            h(
              'button',
              {
                type: 'button',
                className: locked ? 'yk-check yk-check-locked' : 'yk-check',
                role: 'checkbox',
                'aria-checked': checked ? 'true' : 'false',
                'aria-disabled': locked ? 'true' : undefined,
                title: locked ? t('cLockedByParent') : undefined,
                'aria-label': row.title ?? row.id,
                disabled: locked,
                onClick: () => toggleRow(row, group),
              },
              checked ? h(CheckIcon, { width: 11, height: 11 }) : null,
            ),
            h(
              'div',
              { className: 'yk-itemMain' },
              h(
                'div',
                { className: 'yk-itemTitleRow' },
                h('button', { type: 'button', className: 'yk-itemTitle', onClick: () => openSession(row.id), title: row.title ?? row.id }, row.title ?? row.id),
                row.origin === 'subagent' ? h(Chip, null, t('cSubagentTag')) : null,
                row.stored === false ? h(Chip, { kind: 'danger', dot: true }, t('cMissingRecord')) : null,
                row.archived ? h(Chip, null, t('cArchivedTag')) : null,
                row.running ? h(Chip, { kind: 'warn', dot: true }, t('cRunning')) : row.live ? h(Chip, { kind: 'ok', dot: true }, t('cLive')) : null,
                kids.length > 0
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'yk-subToggle',
                        'aria-expanded': kidsOpen ? 'true' : 'false',
                        title: kidsOpen ? t('collapse') : t('expand'),
                        onClick: () => setExpandedKids((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id]),
                      },
                      h(kidsOpen ? ChevronDownIcon : ChevronRightIcon, { width: 12, height: 12 }),
                      fill(t('cSubSessions'), { n: kids.length }),
                    )
                  : null,
              ),
              h('div', { className: 'yk-itemMeta' }, meta.map((part, index) => h('span', { key: index }, part))),
            ),
            h(
              'div',
              { className: 'yk-itemActions' },
              h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-iconBtn', onClick: () => openSession(row.id), title: t('open'), 'aria-label': t('open') }, h(OpenIcon)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'yk-btn yk-btn-ghost yk-iconBtn',
                  onClick: () => archive(row),
                  disabled: busy !== '',
                  title: row.archived ? t('cUnarchive') : t('cArchive'),
                  'aria-label': row.archived ? t('cUnarchive') : t('cArchive'),
                },
                h(ArchiveIcon),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: pending === null ? 'yk-btn yk-btn-ghost yk-iconBtn yk-dangerHover' : 'yk-btn yk-btn-ghost yk-iconBtn yk-dangerHover yk-iconBtnOn',
                  title: t('cDelete'),
                  'aria-label': t('cDelete'),
                  'aria-expanded': pending === null ? 'false' : 'true',
                  disabled: busy !== '',
                  onClick: () => setRowConfirm(pending === null ? { id: row.id, deleteFiles: false } : null),
                },
                h(TrashIcon),
              ),
            ),
          ),
          confirmStrip,
          kids.length > 0 && kidsOpen
            ? h('div', { className: 'yk-children' }, kids.map((kid) => renderRow(kid, group, depth + 1, locked || checked)))
            : null,
        )
      }

      const renderGroup = (group) => {
        const isCollapsed = collapsed.includes(group.id)
        const ids = group.rows.map((row) => row.id)
        const picked = ids.filter((id) => selected.includes(id)).length
        const allPicked = ids.length > 0 && picked === ids.length
        const roots = group.rows.filter((row) => !row.parentSession || !group.rows.some((candidate) => candidate.id === row.parentSession))
        return h(
          'section',
          { className: 'yk-wsGroup', key: group.id },
          h(
            'div',
            { className: 'yk-wsHeader' },
            h(
              'button',
              {
                type: 'button',
                className: 'yk-check',
                role: 'checkbox',
                'aria-checked': allPicked ? 'true' : picked > 0 ? 'mixed' : 'false',
                'aria-label': `${t('cSelectWorkspace')} ${group.title}`,
                onClick: () => setSelected((current) => (allPicked ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])])),
              },
              allPicked ? h(CheckIcon, { width: 11, height: 11 }) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'yk-wsToggleBtn',
                'aria-expanded': isCollapsed ? 'false' : 'true',
                title: isCollapsed ? t('expand') : t('collapse'),
                onClick: () => setCollapsed((current) => (current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])),
              },
              h(isCollapsed ? ChevronRightIcon : ChevronDownIcon, { width: 14, height: 14 }),
              h(FolderIcon, { width: 15, height: 15 }),
              h('span', { className: 'yk-wsTitle' }, group.title),
              h('span', { className: 'yk-wsCount' }, String(group.rows.length)),
              group.path ? h('span', { className: 'yk-wsPath', title: group.path }, group.path) : null,
            ),
            group.path
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-btn yk-btn-ghost yk-btn-sm yk-dangerHover',
                    disabled: busy !== '',
                    title: t('cDeleteWorkspace'),
                    onClick: () => ask({ ids, workspace: group }),
                  },
                  h(TrashIcon, { width: 13, height: 13 }),
                  h('span', { className: 'yk-btnLabel' }, t('cDeleteWorkspace')),
                )
              : null,
          ),
          isCollapsed ? null : h('div', { className: 'yk-list' }, roots.map((row) => renderRow(row, group))),
        )
      }

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(SearchBox, { value: query, onChange: setQuery, placeholder: t('cSearch'), t }),
          h(Segmented, {
            value: filter,
            onChange: setFilter,
            label: t('cFilter'),
            items: [
              { key: 'all', label: t('cAll'), count: data?.totals?.all },
              { key: 'active', label: t('cActive'), count: data?.totals?.active },
              { key: 'archived', label: t('cArchived'), count: data?.totals?.archived },
            ],
          }),
          h(Segmented, {
            value: groupBy,
            onChange: setGroupBy,
            label: t('cGroupByWorkspace'),
            items: [
              { key: 'workspace', label: t('cGroupByWorkspace') },
              { key: 'flat', label: t('cFlatList') },
            ],
          }),
          h(RefreshButton, { t, onClick: load, spinning: busy === 'load' }),
          h(FlashNote, { flash, keys: ['delete'] }),
        ),

        selected.length > 0
          ? h(
              'div',
              { className: 'yk-batchBar' },
              h('span', null, fill(t('cSelected'), { n: selected.length })),
              h(
                'div',
                { className: 'yk-batchActions' },
                h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setSelected([]) }, t('cancel')),
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-danger', disabled: busy !== '', onClick: () => ask({ ids: [...selected] }) },
                  h(TrashIcon),
                  fill(t('cDeleteN'), { n: selected.length }),
                ),
              ),
            )
          : null,

        h(Failure, { t, name: 'chats', error: failure, onRetry: load }),

        confirming !== null
          ? h(
              'div',
              { className: 'yk-confirm', role: 'alertdialog', 'aria-label': confirmTitle },
              h('div', { className: 'yk-confirmTitle' }, confirmTitle),
              h(
                'div',
                { className: 'yk-confirmHint' },
                hasLive
                  ? fill(t('cLiveBlocked'), { n: confirmRows.filter((row) => row.live).length })
                  : t('cConfirmHint'),
              ),
              h(
                'div',
                { className: 'yk-options' },
                h(Option, {
                  checked: deleteFiles || deleteDir,
                  disabled: deleteDir,
                  onChange: setDeleteFiles,
                  label: t('cDeleteFiles'),
                  hint: t('cDeleteFilesHint'),
                }),
                confirming.workspace?.path
                  ? h(Option, {
                      checked: deleteDir,
                      onChange: setDeleteDir,
                      danger: true,
                      label: t('cDeleteWorkspaceDir'),
                      hint: fill(t('cDeleteWorkspaceDirHint'), { path: confirming.workspace.path }),
                    })
                  : null,
              ),
              h(
                'div',
                { className: 'yk-confirmActions' },
                h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirming(null), disabled: busy !== '' }, t('cancel')),
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-danger', onClick: remove, disabled: busy !== '' || hasLive },
                  busy === 'delete' ? h(Spinner) : h(TrashIcon),
                  t('cDelete'),
                ),
              ),
            )
          : null,

        data === null && busy === 'load'
          ? h(Loading, { text: t('loading') })
          : visible.length === 0 && (groups === null || groups.length === 0)
            ? data === null
              ? null
              : h(Empty, {
                  icon: h(needle !== '' ? SearchIcon : ChatIcon, { width: 22, height: 22 }),
                  title: rows.length === 0 ? t('cNoChats') : t('cNoMatch'),
                  hint: rows.length === 0 ? undefined : t('cNoMatchHint'),
                })
            : groups !== null
              ? h('div', { className: 'yk-groups' }, groups.map(renderGroup))
              : h('div', { className: 'yk-list' }, (() => {
                  const flat = { id: '__flat__', rows: visible }
                  const roots = visible.filter((row) => !row.parentSession || !visible.some((candidate) => candidate.id === row.parentSession))
                  return roots.map((row) => renderRow(row, flat))
                })()),

        data !== null ? h('div', { className: 'yk-foot' }, counted(t, 'cTotalOne', 'cTotal', rows.length)) : null,
      )
    }

    /* ---------------------------------------------------------------- sites */

    function SitesTab({ t }) {
      const [payload, setPayload] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [flash, show] = useFlash()
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [confirming, setConfirming] = React.useState('')
      const [prefix, setPrefix] = React.useState('')
      const [prefixTouched, setPrefixTouched] = React.useState(false)
      const { signal, alive } = useAbortOnUnmount()

      const adopt = (next) => {
        setPayload(next)
        setPrefix(next.publicBase ?? '')
        setPrefixTouched(false)
      }

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const next = await getJson(`${API.sites}/list`, signal)
          if (!alive.current) return
          adopt(next)
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'sites' }))

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          setFailure(failureOf(error))
        } finally {
          setBusy('')
        }
      }

      const savePrefix = (value) =>
        run('prefix', async () => {
          adopt(await postJson(`${API.sites}/settings`, { publicBase: value }))
          show('prefix', t('saved'))
        })

      const remove = (slug) =>
        run('delete', async () => {
          const result = await postJson(`${API.sites}/delete`, { slug })
          setPayload((current) => ({ ...(current ?? {}), sites: result.sites }))
          setConfirming('')
        })

      const sites = payload?.sites ?? null
      const needle = query.trim().toLowerCase()
      const visible = (sites ?? []).filter(
        (site) => needle === '' || String(site.title).toLowerCase().includes(needle) || String(site.slug).toLowerCase().includes(needle),
      )
      const linkOf = (site) => (/^https?:\/\//i.test(site.url) ? site.url : `${window.location.origin}${site.url}`)

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(SearchBox, { value: query, onChange: setQuery, placeholder: t('sSearch'), t }),
          h(RefreshButton, { t, onClick: load, spinning: busy === 'load' }),
        ),
        h(Failure, { t, name: 'sites', error: failure, onRetry: load }),

        sites === null
          ? busy === 'load'
            ? h(Loading, { text: t('loading') })
            : null
          : sites.length === 0
            ? h(Empty, { icon: h(SitesIcon, { width: 22, height: 22 }), title: t('sEmpty'), hint: t('sEmptyHint') })
            : visible.length === 0
              ? h(Empty, { icon: h(SearchIcon, { width: 22, height: 22 }), title: t('sNoMatch') })
              : h(
                  'div',
                  { className: 'yk-list' },
                  visible.map((site) => {
                    const href = linkOf(site)
                    const asking = confirming === site.slug
                    return h(
                      'div',
                      { className: 'yk-itemWrap', key: site.slug },
                      h(
                        'div',
                        { className: 'yk-item' },
                        h('span', { className: 'yk-itemIcon' }, h(GlobeIcon, { width: 18, height: 18 })),
                        h(
                          'div',
                          { className: 'yk-itemMain' },
                          h(
                            'div',
                            { className: 'yk-itemTitleRow' },
                            h('a', { className: 'yk-itemTitle', href, target: '_blank', rel: 'noreferrer noopener', title: href }, site.title),
                            h(Chip, null, fill(t('sVersion'), { version: site.version })),
                          ),
                          h(
                            'div',
                            { className: 'yk-itemMeta' },
                            h('span', { className: 'yk-mono yk-link' }, href),
                            h('span', null, fill(t('sPublished'), { time: relativeTime(site.publishedAt, t) })),
                            h('span', null, `${fill(t('sFiles'), { n: site.files })} · ${formatBytes(site.bytes)}`),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'yk-itemActions' },
                          h(CopyButton, { text: href, label: t('copy'), t }),
                          h('a', { className: 'yk-btn yk-btn-ghost yk-iconBtn', href, target: '_blank', rel: 'noreferrer noopener', title: t('open'), 'aria-label': t('open') }, h(OpenIcon)),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'yk-btn yk-btn-ghost yk-dangerHover',
                              'aria-expanded': asking ? 'true' : 'false',
                              onClick: () => setConfirming(asking ? '' : site.slug),
                              disabled: busy !== '',
                            },
                            t('sUnpublish'),
                          ),
                        ),
                      ),
                      asking
                        ? h(ConfirmStrip, {
                            t,
                            title: fill(t('confirmUnpublish'), { name: site.title }),
                            hint: t('confirmUnpublishHint'),
                            confirmLabel: t('sUnpublish'),
                            busy: busy === 'delete',
                            onCancel: () => setConfirming(''),
                            onConfirm: () => remove(site.slug),
                          })
                        : null,
                    )
                  }),
                ),

        payload !== null
          ? h(
              Disclosure,
              { title: t('sSettings'), badge: payload.customPublicBase ? null : h(Chip, { kind: 'warn' }, t('sPrefixUnsetTag')) },
              h(
                'div',
                { className: 'yk-settingRow' },
              h('span', { className: 'yk-settingLabel' }, h(LinkIcon, { width: 14, height: 14 }), t('sPrefix')),
              h('input', {
                className: 'yk-input yk-mono',
                value: prefix,
                placeholder: payload.defaultPublicBase,
                'aria-label': t('sPrefix'),
                onChange: (event) => {
                  setPrefix(event.target.value)
                  setPrefixTouched(true)
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && prefixTouched) savePrefix(prefix)
                },
              }),
              h(
                'button',
                { type: 'button', className: 'yk-btn yk-btn-solid', disabled: busy !== '' || !prefixTouched, onClick: () => savePrefix(prefix) },
                busy === 'prefix' ? h(Spinner) : null,
                flashed(flash, 'prefix', t('save')),
              ),
              payload.customPublicBase
                ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', disabled: busy !== '', onClick: () => savePrefix('') }, t('sPrefixDefault'))
                : null,
              h('div', { className: 'yk-settingHint' }, payload.customPublicBase ? t('sPrefixHint') : h('span', { className: 'yk-settingWarn' }, t('sPrefixUnset'))),
            ),
            )
          : null,

        payload !== null
          ? h(
              'div',
              { className: 'yk-foot' },
              h('span', null, counted(t, 'sCountOne', 'sCount', (sites ?? []).length)),
              h('span', { className: 'yk-footDot' }, '·'),
              h('span', null, payload.publicBase),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- files */

    /** Build the resource address DSH's own preview understands. */
    function resourceAddress(sessionId, relative) {
      const encoded = String(relative).split('/').map((part) => encodeURIComponent(part)).join('/')
      return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`
    }

    /** Breadcrumb + listing of one workspace, with download and preview. */
    function FilesTab({ t, ui }) {
      const [roots, setRoots] = React.useState(null)
      const [rootId, setRootId] = React.useState('')
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState(null)
      const [flash, show] = useFlash()
      const { signal, alive } = useAbortOnUnmount()

      const root = roots === null ? null : roots.find((item) => item.id === rootId) ?? null

      React.useEffect(() => {
        (async () => {
          try {
            const payload = await getJson(`${API.files}/roots`, signal)
            if (!alive.current) return
            setRoots(payload.roots ?? [])
            setRootId((current) => (current !== '' ? current : payload.roots?.[0]?.id ?? ''))
          } catch (error) {
            if (alive.current) setFailure(failureOf(error))
          }
        })()
      }, [])

      const load = React.useCallback(async () => {
        if (rootId === '') return
        setBusy('load')
        try {
          const query = `?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`
          const payload = await getJson(`${API.files}/list${query}`, signal)
          if (!alive.current) return
          setEntries(payload.entries ?? [])
          setSelected([])
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [rootId, path])

      React.useEffect(() => { load() }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'files' }))

      const crumbs = path === '' ? [] : path.split('/')
      const go = (next) => { setPath(next); setSelected([]) }
      const toggle = (entry) => setSelected((current) =>
        current.includes(entry.path) ? current.filter((item) => item !== entry.path) : [...current, entry.path])

      /** Preview needs a session in this workspace as the resource anchor; resolve it on demand. */
      const preview = async (entry) => {
        if (root === null || entry.type !== 'file') return
        try {
          const payload = await getJson(`${API.files}/anchor?root=${encodeURIComponent(root.id)}`, signal)
          if (payload.sessionId === null || payload.sessionId === undefined) {
            show('preview', t('fNoSession'))
            return
          }
          try {
            ui.openResource(payload.sessionId, entry.path)
          } catch {
            // Nothing is mounted for that session yet: switch to it, then open.
            ui.openSession(payload.sessionId)
            await new Promise((resolve) => setTimeout(resolve, 400))
            ui.openResource(payload.sessionId, entry.path)
          }
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') show('preview', messageOf(error))
        }
      }

      const downloadOne = (entry) => {
        if (root === null) return
        const query = `?root=${encodeURIComponent(root.id)}&path=${encodeURIComponent(entry.path)}`
        const anchor = document.createElement('a')
        anchor.href = `${API.files}/download${query}`
        anchor.download = entry.name
        anchor.click()
      }

      /** Files alone go straight to the browser; a folder (or a large batch) becomes one ZIP. */
      const entryOf = (target) => entries.find((entry) => entry.path === target) ?? null
      const hasDirectory = selected.some((target) => entryOf(target)?.type === 'dir')
      const packAsZip = hasDirectory || selected.length > 10

      const downloadSelected = async () => {
        if (root === null || selected.length === 0) return
        if (!packAsZip) {
          for (const target of selected) {
            const entry = entryOf(target)
            if (entry !== null) downloadOne(entry)
          }
          return
        }
        setBusy('archive')
        setFailure(null)
        try {
          const response = await fetch(`${API.files}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ root: root.id, paths: selected }),
          })
          if (!response.ok) {
            const type = response.headers.get('content-type') ?? ''
            const payload = type.includes('json') ? await response.json() : null
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `${root.title || 'workspace'}.zip`
          anchor.click()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
        } catch (error) {
          if (alive.current) setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const allPicked = entries.length > 0 && entries.every((entry) => selected.includes(entry.path))

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          roots === null
            ? null
            : h(
                'select',
                {
                  className: 'yk-input yk-select',
                  value: rootId,
                  'aria-label': t('fWorkspace'),
                  onChange: (event) => { setRootId(event.target.value); setPath(''); setSelected([]) },
                },
                roots.map((item) => h('option', { key: item.id, value: item.id }, item.title)),
              ),
          h(
            'div',
            { className: 'yk-crumbs' },
            h('button', { type: 'button', className: 'yk-crumb', onClick: () => go('') }, root?.title ?? t('fRoot')),
            crumbs.map((name, index) =>
              h(
                'span',
                { key: `${name}-${index}`, className: 'yk-crumbWrap' },
                h(ChevronRightIcon, { width: 12, height: 12 }),
                h('button', { type: 'button', className: 'yk-crumb', onClick: () => go(crumbs.slice(0, index + 1).join('/')) }, name),
              ),
            ),
          ),
          h(RefreshButton, { t, onClick: load, spinning: busy === 'load' }),
          h(
            'button',
            {
              type: 'button',
              className: 'yk-btn yk-btn-solid',
              onClick: downloadSelected,
              disabled: busy !== '' || selected.length === 0,
              title: !packAsZip || hasDirectory ? undefined : fill(t('fZipReason'), { n: 10 }),
            },
            busy === 'archive' ? h(Spinner) : h(DownloadIcon),
            fill(packAsZip ? t('fZipN') : t('fDownloadFilesN'), { n: selected.length }),
          ),
        ),
        h(FlashNote, { flash, keys: ['preview'], kind: 'error' }),
        h(Failure, { t, name: 'files', error: failure, onRetry: load }),

        entries.length === 0
          ? busy === 'load'
            ? h(Loading, { text: t('loading') })
            : h(Empty, { icon: h(FolderIcon, { width: 22, height: 22 }), title: t('fEmpty'), hint: t('fEmptyHint') })
          : h(
              'div',
              { className: 'yk-list' },
              h(
                'div',
                { className: 'yk-item yk-itemHead' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-check',
                    role: 'checkbox',
                    'aria-checked': allPicked ? 'true' : selected.length > 0 ? 'mixed' : 'false',
                    'aria-label': t('fSelectAll'),
                    onClick: () => setSelected(allPicked ? [] : entries.map((entry) => entry.path)),
                  },
                  allPicked ? h(CheckIcon, { width: 11, height: 11 }) : null,
                ),
                h('span', { className: 'yk-itemTitle' }, t('fName')),
                h('span', { className: 'yk-itemMeta yk-metaRight' }, t('fSize')),
              ),
              entries.map((entry) => {
                const checked = selected.includes(entry.path)
                const isDir = entry.type === 'dir'
                return h(
                  'div',
                  { className: checked ? 'yk-item yk-item-selected' : 'yk-item', key: entry.path },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yk-check',
                      role: 'checkbox',
                      'aria-checked': checked ? 'true' : 'false',
                      'aria-label': entry.name,
                      onClick: () => toggle(entry),
                    },
                    checked ? h(CheckIcon, { width: 11, height: 11 }) : null,
                  ),
                  h(
                    'div',
                    { className: 'yk-itemMain' },
                    h(
                      'div',
                      { className: 'yk-itemTitleRow' },
                      isDir
                        ? h('button', { type: 'button', className: 'yk-itemTitle', onClick: () => go(entry.path) }, `${entry.name}/`)
                        : h('button', { type: 'button', className: 'yk-itemTitle', onClick: () => preview(entry), title: t('fPreview') }, entry.name),
                      entry.type === 'symlink' ? h(Chip, { kind: 'warn' }, t('fSymlink')) : null,
                    ),
                  ),
                  h('span', { className: 'yk-itemMeta yk-metaRight yk-mono' }, isDir ? '' : entry.size > 0 ? formatBytes(entry.size) : '—'),
                  h(
                    'div',
                    { className: 'yk-itemActions' },
                    isDir
                      ? null
                      : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-iconBtn yk-btn-sm', title: t('fPreview'), 'aria-label': t('fPreview'), onClick: () => preview(entry) }, h(OpenIcon, { width: 14, height: 14 })),
                    isDir
                      ? null
                      : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-iconBtn yk-btn-sm', title: t('fDownload'), 'aria-label': t('fDownload'), onClick: () => downloadOne(entry) }, h(DownloadIcon, { width: 14, height: 14 })),
                  ),
                )
              }),
            ),

        h('div', { className: 'yk-foot' }, fill(t('fHint'), { n: selected.length })),
      )
    }

    /* ---------------------------------------------------------------- proxy */

    function ProxyTab({ t }) {
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [flash, show] = useFlash()
      const [busy, setBusy] = React.useState('')
      const [importText, setImportText] = React.useState('')
      const [removing, setRemoving] = React.useState('')
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [showSettings, setShowSettings] = React.useState(false)
      const [settings, setSettings] = React.useState({ localPort: '', bypass: '' })
      const { signal, alive } = useAbortOnUnmount()

      const adopt = (next) => {
        if (next === null || next === undefined) return
        setState(next)
        setSettings({ localPort: String(next.localPort ?? ''), bypass: next.bypass ?? '' })
      }

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.proxy}/state`, signal)
          if (!alive.current) return
          adopt(payload.state)
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'proxy' }))

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          if (error?.state !== undefined) adopt(error.state)
          setFailure(failureOf(error))
        } finally {
          setBusy('')
          setRemoving('')
          setConfirmReset(false)
        }
      }

      const nodes = state?.nodes ?? []
      const nameOf = (id) => nodes.find((node) => node.id === id)?.name ?? id

      const toggle = () =>
        run('toggle', async () => {
          const wasOn = state?.enabled === true
          const payload = await postJson(`${API.proxy}/${wasOn ? 'disable' : 'enable'}`, {})
          adopt(payload.state)
        })

      const importNodes = () =>
        run('import', async () => {
          const payload = await postJson(`${API.proxy}/import`, { text: importText })
          adopt(payload.state)
          setImportText('')
          let text = fill(t('pImported'), { added: payload.added ?? 0 })
          if (payload.updated > 0) text += fill(t('pImportedUpdated'), { updated: payload.updated })
          if (payload.skipped > 0) text += fill(t('pImportedSkipped'), { skipped: payload.skipped })
          show('import', text)
        })

      const select = (id) =>
        run(`select:${id}`, async () => {
          const payload = await postJson(`${API.proxy}/select`, { id })
          adopt(payload.state)
        })

      const test = (id) =>
        run(`test:${id}`, async () => {
          // The result lands on the node's latency chip; a failed probe is a result too, not an error banner.
          try {
            adopt((await postJson(`${API.proxy}/test`, { id })).state)
          } catch (error) {
            if (error?.state === undefined) throw error
            adopt(error.state)
          }
        })

      const testAll = () =>
        run('test-all', async () => {
          adopt((await postJson(`${API.proxy}/test-all`, {})).state)
        })

      const removeNode = (id) =>
        run(`remove:${id}`, async () => {
          adopt((await postJson(`${API.proxy}/remove`, { id })).state)
          setRemoving('')
        })

      const reset = () =>
        run('reset', async () => {
          adopt((await postJson(`${API.proxy}/reset`, {})).state)
        })

      const saveSettings = () => {
        const localPort = Number(settings.localPort)
        if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
          setFailure({ message: t('pInvalidPort'), off: false })
          return
        }
        run('settings', async () => {
          adopt((await postJson(`${API.proxy}/configure`, { localPort, bypass: settings.bypass.trim() })).state)
          show('settings', t('saved'))
        })
      }

      const latency = (node) => {
        const result = node.lastTest
        if (result === null || result === undefined) return null
        if (result.ok === false) return h(Chip, { kind: 'danger' }, result.error ? String(result.error).slice(0, 40) : t('rFail'))
        const ms = Number(result.ms)
        return h(Chip, { kind: ms < 400 ? 'ok' : 'warn' }, `${ms}ms`)
      }

      const stats = state?.stats
      const statusText = state === null ? '' : state.enabled ? (state.running ? t('pEnabled') : t('pPending')) : t('pDisabled')

      return h(
        'div',
        { className: 'yk-body' },
        state !== null
          ? h(
              'div',
              { className: state.enabled ? 'yk-hero yk-hero-on' : 'yk-hero' },
              h('span', { className: 'yk-heroDot', 'aria-hidden': true }),
              h(
                'div',
                { className: 'yk-heroMain' },
                h('div', { className: 'yk-heroTitle' }, statusText),
                h(
                  'div',
                  { className: 'yk-heroSub' },
                  state.node?.server ? `${nodes.find((node) => node.active)?.name ?? state.node.server} · 127.0.0.1:${state.localPort}` : t('pNoNodes'),
                  stats && state.enabled && stats.active > 0 ? ` · ${stats.active} ${t('pActive')}` : '',
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: state.enabled ? 'yk-btn yk-btn-danger' : 'yk-btn yk-btn-solid',
                  onClick: toggle,
                  disabled: busy !== '' || nodes.length === 0,
                },
                busy === 'toggle' ? h(Spinner) : h(PowerIcon),
                state.enabled ? t('pDisable') : t('pEnable'),
              ),
            )
          : null,

        h(Failure, { t, name: 'proxy', error: failure, onRetry: load }),
        state?.lastError ? h(Banner, { kind: 'warn', text: `${t('pLastError')} · ${state.lastError}` }) : null,
        state === null && busy === 'load' ? h(Loading, { text: t('loading') }) : null,

        state !== null
          ? h(
              Card,
              {
                title: t('pNodes'),
                span: true,
                icon: h(RouteIcon, { width: 16, height: 16 }),
                note: nodes.length > 0 ? String(nodes.length) : undefined,
                action: h(
                  'div',
                  { className: 'yk-cardTools' },
                  nodes.length > 1
                    ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: testAll, disabled: busy !== '' }, busy === 'test-all' ? h(Spinner, { size: 13 }) : null, busy === 'test-all' ? t('pTesting') : t('pTestAll'))
                    : null,
                  h(RefreshButton, { t, onClick: load, spinning: busy === 'load' }),
                ),
              },
              nodes.length === 0
                ? h(Empty, { icon: h(RouteIcon, { width: 22, height: 22 }), title: t('pNoNodes'), hint: t('pNoNodesHint') })
                : h(
                    'div',
                    { className: 'yk-nodeList', role: 'radiogroup', 'aria-label': t('pNodes') },
                    nodes.map((node) => {
                      const asking = removing === node.id
                      return h(
                        'div',
                        { key: node.id, className: 'yk-itemWrap' },
                        h(
                          'div',
                          { className: node.active ? 'yk-node yk-node-active' : 'yk-node' },
                          h(
                            'button',
                            {
                              type: 'button',
                              role: 'radio',
                              className: 'yk-radio',
                              'aria-checked': node.active ? 'true' : 'false',
                              'aria-label': `${t('pUse')} ${node.name}`,
                              disabled: busy !== '' || node.active,
                              onClick: () => select(node.id),
                            },
                            busy === `select:${node.id}` ? h(Spinner, { size: 12 }) : null,
                          ),
                          h(
                            'div',
                            { className: 'yk-itemMain' },
                            h(
                              'div',
                              { className: 'yk-itemTitleRow' },
                              h('span', { className: 'yk-nodeName', title: node.name }, node.name),
                              node.active ? h(Chip, { kind: 'ok', dot: true }, t('pInUse')) : null,
                              latency(node),
                            ),
                            h('div', { className: 'yk-itemMeta' }, h('span', { className: 'yk-mono' }, `${node.server}:${node.port}`), h('span', { className: 'yk-mono' }, node.method)),
                          ),
                          h(
                            'div',
                            { className: 'yk-itemActions' },
                            h(
                              'button',
                              { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => test(node.id), disabled: busy !== '' },
                              busy === `test:${node.id}` || (busy === 'test-all') ? h(Spinner, { size: 13 }) : null,
                              t('pTest'),
                            ),
                            node.active
                              ? null
                              : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => select(node.id), disabled: busy !== '' }, t('pUse')),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'yk-btn yk-btn-ghost yk-iconBtn yk-btn-sm yk-dangerHover',
                                title: t('pRemove'),
                                'aria-label': t('pRemove'),
                                'aria-expanded': asking ? 'true' : 'false',
                                onClick: () => setRemoving(asking ? '' : node.id),
                                disabled: busy !== '',
                              },
                              h(TrashIcon, { width: 14, height: 14 }),
                            ),
                          ),
                        ),
                        asking
                          ? h(ConfirmStrip, {
                              t,
                              title: fill(t('confirmRemoveNode'), { name: node.name }),
                              hint: t('confirmRemoveNodeHint'),
                              confirmLabel: t('pRemove'),
                              busy: busy === `remove:${node.id}`,
                              onCancel: () => setRemoving(''),
                              onConfirm: () => removeNode(node.id),
                            })
                          : null,
                      )
                    }),
                  ),
              h(
                'div',
                { className: 'yk-importBox' },
                h('textarea', {
                  className: 'yk-input yk-textarea',
                  rows: 3,
                  value: importText,
                  placeholder: t('pImportPlaceholder'),
                  'aria-label': t('pImportTitle'),
                  spellCheck: false,
                  onChange: (event) => setImportText(event.target.value),
                }),
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-solid', onClick: importNodes, disabled: busy !== '' || importText.trim() === '' },
                  busy === 'import' ? h(Spinner) : h(DownloadIcon),
                  t('pImport'),
                ),
              ),
              h(FlashNote, { flash, keys: ['import'] }),
            )
          : null,

        state !== null
          ? h(
              'div',
              { className: 'yk-disclosure' },
              h(
                'button',
                { type: 'button', className: 'yk-disclosureBtn', 'aria-expanded': showSettings ? 'true' : 'false', onClick: () => setShowSettings((value) => !value) },
                h(showSettings ? ChevronDownIcon : ChevronRightIcon, { width: 14, height: 14 }),
                t('pSettings'),
              ),
              showSettings
                ? h(
                    'div',
                    { className: 'yk-disclosureBody' },
                    h(
                      'div',
                      { className: 'yk-form' },
                      h(
                        'label',
                        { className: 'yk-field' },
                        h('span', { className: 'yk-fieldLabel' }, t('pLocalPort')),
                        h('input', { className: 'yk-input', value: settings.localPort, inputMode: 'numeric', onChange: (event) => setSettings((s) => ({ ...s, localPort: event.target.value })) }),
                      ),
                      h(
                        'label',
                        { className: 'yk-field' },
                        h('span', { className: 'yk-fieldLabel' }, t('pBypass')),
                        h('input', { className: 'yk-input', value: settings.bypass, placeholder: 'localhost,127.0.0.1,::1', onChange: (event) => setSettings((s) => ({ ...s, bypass: event.target.value })) }),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'yk-toolbar' },
                      h('button', { type: 'button', className: 'yk-btn', onClick: saveSettings, disabled: busy !== '' }, busy === 'settings' ? h(Spinner) : null, flashed(flash, 'settings', t('save'))),
                      h('span', { className: 'yk-grow' }),
                      confirmReset
                        ? h(
                            React.Fragment,
                            null,
                            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmReset(false) }, t('cancel')),
                            h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: reset, disabled: busy !== '' }, t('pConfirmReset')),
                          )
                        : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-dangerHover', onClick: () => setConfirmReset(true), disabled: busy !== '' || nodes.length === 0 }, t('pReset')),
                    ),
                    stats && (stats.active > 0 || stats.failures > 0)
                      ? h('div', { className: 'yk-rows yk-rows-2col' },
                          h(Row, { label: t('pActive'), value: String(stats.active ?? 0) }),
                          h(Row, { label: t('pFailures'), value: String(stats.failures ?? 0) }),
                        )
                      : null,
                    h('div', { className: 'yk-foot' }, t('pStateFile')),
                  )
                : null,
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- github */

    function GithubTab({ t }) {
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [token, setToken] = React.useState('')
      const [reveal, setReveal] = React.useState(false)
      const [repo, setRepo] = React.useState('')
      const [repoResult, setRepoResult] = React.useState(null)
      const [repoFailure, setRepoFailure] = React.useState(null)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const [flash, show] = useFlash()
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.github}/state`, signal)
          if (!alive.current) return
          setState(payload.state)
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const save = async () => {
        const value = token.trim()
        if (value === '' || busy !== '') return
        setBusy('save')
        setFailure(null)
        try {
          const response = await fetch(`${API.github}/token`, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-yukari-github-token': value,
            },
            body: '{}',
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            const error = new Error(payload.error ?? `HTTP ${response.status}`)
            error.status = response.status
            throw error
          }
          if (!payload?.state) throw new Error('服务器没有返回 Github 状态')
          if (!alive.current) return
          setState(payload.state)
          setToken('')
          setReveal(false)
          setRepoResult(null)
          setRepoFailure(null)
          show('save', payload.state.git?.helperInstalled ? t('ghTokenSaved') : t('ghSavedNoHelper'))
        } catch (error) {
          if (alive.current) setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const verify = async () => {
        setBusy('verify')
        setFailure(null)
        try {
          const payload = await postJson(`${API.github}/verify`, {})
          if (!payload?.state) throw new Error('服务器没有返回 Github 状态')
          if (!alive.current) return
          setState(payload.state)
          show('verify', t('ghVerified'))
        } catch (error) {
          if (alive.current) setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const repair = async () => {
        setBusy('repair')
        setFailure(null)
        try {
          const payload = await postJson(`${API.github}/install`, {})
          if (!payload?.state) throw new Error('服务器没有返回 Github 状态')
          if (!alive.current) return
          setState(payload.state)
          show('repair', t('ghRepaired'))
        } catch (error) {
          if (alive.current) setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const clear = async () => {
        setBusy('clear')
        setFailure(null)
        try {
          const payload = await postJson(`${API.github}/clear`, {})
          if (!payload?.state) throw new Error('服务器没有返回 Github 状态')
          if (!alive.current) return
          setState(payload.state)
          setConfirmClear(false)
          setToken('')
          setReveal(false)
          setRepoResult(null)
          setRepoFailure(null)
        } catch (error) {
          if (alive.current) setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const checkRepo = async () => {
        const value = repo.trim()
        if (value === '' || busy !== '') return
        setBusy('repo')
        setRepoFailure(null)
        try {
          const payload = await postJson(`${API.github}/repo`, { repo: value })
          if (!payload?.repo) throw new Error('服务器没有返回仓库信息')
          if (!alive.current) return
          setRepoResult(payload.repo)
        } catch (error) {
          if (alive.current) {
            setRepoResult(null)
            setRepoFailure(failureOf(error))
          }
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const tokenFields = (withSteps) =>
        h(
          React.Fragment,
          null,
          withSteps
            ? h(
                'ol',
                { className: 'yk-steps' },
                h('li', null, t('ghStepAccess')),
                h('li', null, t('ghStepPerm')),
                h('li', null, t('ghStepPaste')),
              )
            : null,
          h(
            'div',
            { className: 'yk-toolbar' },
            h('input', {
              className: 'yk-input yk-mono',
              style: { flex: '1 1 240px' },
              type: reveal ? 'text' : 'password',
              value: token,
              placeholder: t('ghTokenPlaceholder'),
              'aria-label': t('ghTokenLabel'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => setToken(event.target.value),
            }),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setReveal((value) => !value) },
              h(reveal ? EyeOffIcon : EyeIcon, { width: 14, height: 14 }),
              t(reveal ? 'ghHide' : 'ghShow'),
            ),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-solid', onClick: save, disabled: busy !== '' || token.trim() === '' },
              busy === 'save' ? h(Spinner) : null,
              t('ghSave'),
            ),
          ),
          h(
            'div',
            { className: 'yk-toolbar' },
            h(
              'a',
              { className: 'yk-link', href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noreferrer noopener' },
              t('ghCreate'),
            ),
          ),
          h('div', { className: 'yk-foot' }, t('ghStorage')),
        )

      if (state === null) {
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'github', error: failure, onRetry: load }),
          failure === null ? h(Loading, { text: t('loading') }) : null,
        )
      }

      const account = state.account
      const typeLabel =
        account?.tokenType === 'fine-grained' ? t('ghFineGrained')
          : account?.tokenType === 'classic' ? t('ghClassic')
            : t('ghUnknown')
      const expiry = account?.expiresAt === null || account?.expiresAt === undefined ? t('ghNeverExpires') : formatTime(account.expiresAt)
      const expiresAt = account?.expiresAt === null || account?.expiresAt === undefined ? NaN : Date.parse(account.expiresAt)
      const expiresSoon = Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt - Date.now() < 7 * 86400000
      const warnings = [
        account?.expired ? h(Banner, { key: 'expired', kind: 'error', text: t('ghExpired') }) : null,
        account?.tokenType === 'classic' ? h(Banner, { key: 'classic', kind: 'warn', text: t('ghClassicWarning') }) : null,
        account !== null && account?.expiresAt === null ? h(Banner, { key: 'expiry', kind: 'warn', text: t('ghExpiryWarning') }) : null,
        expiresSoon ? h(Banner, { key: 'soon', kind: 'warn', text: fill(t('ghExpiringSoon'), { time: formatTime(account.expiresAt) }) }) : null,
      ].filter(Boolean)

      return h(
        'div',
        { className: 'yk-body' },
        h(Failure, { t, name: 'github', error: failure, onRetry: load }),
        h(Banner, { kind: 'warn', text: t('ghSecurityHint') }),
        h(FlashNote, { flash, keys: ['save', 'verify', 'repair'] }),

        state.configured
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'yk-grid' },
                h(
                  Card,
                  {
                    title: t('ghAccount'),
                    icon: h(GithubIcon, { width: 16, height: 16 }),
                    action: h(Chip, { kind: 'ok', dot: true }, t('ghConfigured')),
                  },
                  h(
                    'div',
                    { className: 'yk-rows' },
                    h(Row, { label: t('ghLogin'), value: account?.login ?? '—', mono: true }),
                    h(Row, { label: t('ghTokenType'), value: typeLabel }),
                    h(Row, { label: t('ghScopes'), value: account?.scopes?.length ? account.scopes.join(', ') : '—' }),
                    h(Row, {
                      label: t('ghExpiry'),
                      value: expiry,
                      chips: account?.expired ? [{ kind: 'danger', text: t('ghExpired') }] : [],
                    }),
                  ),
                  h(
                    'div',
                    { className: 'yk-toolbar' },
                    h(
                      'button',
                      { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: verify, disabled: busy !== '' },
                      busy === 'verify' ? h(Spinner) : null,
                      t('ghVerify'),
                    ),
                  ),
                ),
                h(
                  Card,
                  {
                    title: t('ghGit'),
                    icon: h(GithubIcon, { width: 16, height: 16 }),
                    action: h(
                      Chip,
                      { kind: state.git.helperInstalled ? 'ok' : 'danger', dot: true },
                      state.git.helperInstalled ? t('ghHelperOn') : t('ghHelperOff'),
                    ),
                  },
                  h(
                    'div',
                    { className: 'yk-rows' },
                    h(Row, { label: t('ghGitVersion'), value: state.git.version ?? '—', mono: true }),
                    h(Row, { label: t('ghTokenFile'), value: state.git.tokenFile ?? '—', mono: true, clamp: true }),
                    h(Row, { label: 'include.path', value: state.git.includePath ?? '—', mono: true, clamp: true }),
                  ),
                  state.git.error ? h(Banner, { kind: 'error', text: state.git.error }) : null,
                  !state.git.helperInstalled
                    ? h(
                        'div',
                        { className: 'yk-toolbar' },
                        h(
                          'button',
                          { type: 'button', className: 'yk-btn', onClick: repair, disabled: busy !== '' },
                          busy === 'repair' ? h(Spinner) : null,
                          t('ghRepair'),
                        ),
                      )
                    : null,
                ),
              ),
              warnings.length > 0 ? warnings : null,
              h(
                Card,
                {
                  title: t('ghRepoCheck'),
                  icon: h(SearchIcon),
                },
                h(
                  'div',
                  { className: 'yk-toolbar' },
                  h('input', {
                    className: 'yk-input yk-mono',
                    style: { flex: '1 1 220px' },
                    value: repo,
                    placeholder: t('ghRepoPlaceholder'),
                    'aria-label': t('ghRepoPlaceholder'),
                    spellCheck: false,
                    onChange: (event) => {
                      setRepo(event.target.value)
                      setRepoResult(null)
                      setRepoFailure(null)
                    },
                  }),
                  h(
                    'button',
                    { type: 'button', className: 'yk-btn', onClick: checkRepo, disabled: busy !== '' || repo.trim() === '' },
                    busy === 'repo' ? h(Spinner) : null,
                    t('ghCheck'),
                  ),
                ),
                repoFailure ? h(Banner, { kind: 'error', text: repoFailure.message }) : null,
                repoResult
                  ? h(
                      'div',
                      { className: 'yk-rows' },
                      h(Row, { label: t('ghRepo'), value: repoResult.fullName, mono: true }),
                      h(Row, {
                        label: t('ghVisibility'),
                        value: repoResult.private ? t('ghRepoPrivate') : t('ghRepoPublic'),
                        chips: [{ kind: repoResult.canPush ? 'ok' : 'danger', text: repoResult.canPush ? t('ghCanPush') : t('ghCannotPush') }],
                      }),
                      h(Row, { label: t('ghDefaultBranch'), value: repoResult.defaultBranch || '—', mono: true }),
                    )
                  : null,
                h('div', { className: 'yk-foot' }, t('ghRepoCheckHint')),
              ),
              h(Disclosure, { title: t('ghReplace') }, h('div', { className: 'yk-form' }, tokenFields(false))),
              h(
                Card,
                {
                  title: t('ghDanger'),
                  icon: h(TrashIcon, { width: 16, height: 16 }),
                },
                h('div', { className: 'yk-foot' }, t('ghClearHint')),
                h(
                  'div',
                  { className: 'yk-toolbar' },
                  h('span', { className: 'yk-grow' }),
                  confirmClear
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'yk-btn yk-btn-ghost yk-dangerHover', onClick: () => setConfirmClear(true), disabled: busy !== '' },
                        t('ghClear'),
                      ),
                ),
                confirmClear
                  ? h(ConfirmStrip, {
                      t,
                      title: t('ghClearTitle'),
                      hint: t('ghClearHint'),
                      confirmLabel: t('ghClearConfirm'),
                      busy: busy === 'clear',
                      onCancel: () => setConfirmClear(false),
                      onConfirm: clear,
                    })
                  : null,
              ),
            )
          : h(
              Card,
              {
                title: t('ghIntro'),
                icon: h(GithubIcon, { width: 16, height: 16 }),
                action: h(Chip, { kind: 'warn', dot: true }, t('ghUnconfigured')),
              },
              tokenFields(true),
            ),
      )
    }

    /* ----------------------------------------------------------------- rules */

    function RulesTab({ t }) {
      const [config, setConfig] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [flash, show] = useFlash()
      const [probe, setProbe] = React.useState(null)
      const [globalDoc, setGlobalDoc] = React.useState(null)
      const [workspaceId, setWorkspaceId] = React.useState('')
      const [projectDoc, setProjectDoc] = React.useState(null)
      const [pendingSwitch, setPendingSwitch] = React.useState(null)
      const [confirmClear, setConfirmClear] = React.useState('')
      const { signal, alive } = useAbortOnUnmount()

      const withDoc = (doc) => ({ ...doc, draft: doc.text })

      const load = React.useCallback(async (targetId) => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.rules}/config`, signal)
          if (!alive.current) return
          const ids = (payload.workspaces ?? []).map((workspace) => workspace.id)
          const id = typeof targetId === 'string' && ids.includes(targetId) ? targetId : ids[0] ?? ''
          const [globalPayload, projectPayload] = await Promise.all([
            getJson(`${API.rules}/doc?scope=global`, signal),
            id === '' ? Promise.resolve(null) : getJson(`${API.rules}/doc?scope=workspace&id=${encodeURIComponent(id)}`, signal),
          ])
          if (!alive.current) return
          setWorkspaceId(id)
          setConfig(payload)
          setGlobalDoc(withDoc(globalPayload.doc))
          setProjectDoc(projectPayload === null ? null : withDoc(projectPayload.doc))
          setFailure(null)
          setPendingSwitch(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'rules' }))
      if (config === null) {
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'rules', error: failure, onRetry: () => load() }),
          failure === null ? h(Loading, { text: t('loading') }) : null,
        )
      }

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          setFailure(failureOf(error))
        } finally {
          setBusy('')
          setConfirmClear('')
        }
      }

      const refreshConfig = async () => {
        const next = await getJson(`${API.rules}/config`, signal)
        if (alive.current) setConfig(next)
      }

      const saveDoc = (scope) => {
        const state = scope === 'global' ? globalDoc : projectDoc
        if (state === null) return undefined
        return run(`save-${scope}`, async () => {
          const body =
            scope === 'global'
              ? { scope: 'global', text: state.draft }
              : { scope: 'workspace', id: workspaceId, text: state.draft }
          const payload = await postJson(`${API.rules}/doc`, body)
          if (!alive.current) return
          if (scope === 'global') setGlobalDoc(withDoc(payload.doc))
          else setProjectDoc(withDoc(payload.doc))
          setProbe(null)
          show(`save-${scope}`, t('kSavedNext'))
          await refreshConfig()
        })
      }

      const clearDoc = (scope) =>
        run(`clear-${scope}`, async () => {
          const body = scope === 'global' ? { scope: 'global' } : { scope: 'workspace', id: workspaceId }
          const payload = await postJson(`${API.rules}/reset`, body)
          if (!alive.current) return
          if (scope === 'global') setGlobalDoc(withDoc(payload.doc))
          else setProjectDoc(withDoc(payload.doc))
          setProbe(null)
          show(`clear-${scope}`, t('kClearDone'))
          await refreshConfig()
        })

      const importDoc = (scope) =>
        run(`import-${scope}`, async () => {
          const query = scope === 'global' ? '?scope=global' : `?scope=workspace&id=${encodeURIComponent(workspaceId)}`
          const payload = await getJson(`${API.rules}/import${query}`, signal)
          if (!alive.current) return
          if (payload.source === null || payload.source === undefined) {
            show(`import-${scope}`, t('kImportNone'))
            return
          }
          const file = String(payload.source).split(/[\\/]/).pop()
          if (scope === 'global') setGlobalDoc((current) => ({ ...current, draft: payload.text }))
          else setProjectDoc((current) => ({ ...current, draft: payload.text }))
          show(`import-${scope}`, fill(t('kImported'), { file }))
        })

      const flip = (key) =>
        run(key, async () => {
          const payload = await postJson(`${API.rules}/settings`, { [key]: !(config.settings?.[key] ?? true) })
          if (!alive.current) return
          setConfig((current) => ({ ...current, settings: payload.settings }))
          setProbe(null)
        })

      const runProbe = () =>
        run('probe', async () => {
          const payload = await getJson(`${API.rules}/probe`, signal)
          if (alive.current) setProbe(payload)
        })

      const openWorkspace = async (id) => {
        setPendingSwitch(null)
        setBusy('doc')
        try {
          const payload = await getJson(`${API.rules}/doc?scope=workspace&id=${encodeURIComponent(id)}`, signal)
          if (!alive.current) return
          setWorkspaceId(id)
          setProjectDoc(withDoc(payload.doc))
          setProbe(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const switchWorkspace = (id) => {
        if (id === workspaceId || busy !== '') return
        const dirty = projectDoc !== null && projectDoc.draft !== projectDoc.text
        if (dirty) {
          setPendingSwitch(id)
          return
        }
        openWorkspace(id)
      }

      const settings = config.settings ?? {}
      const stats = config.stats
      const workspaces = config.workspaces ?? []
      const selected = workspaces.find((workspace) => workspace.id === workspaceId) ?? null
      const disabled = busy !== ''

      const pathRow = (doc) =>
        h(
          'div',
          { className: 'yk-foot' },
          h('span', { className: 'yk-fieldLabel' }, t('kPath')),
          h('span', { className: 'yk-mono yk-link', title: doc?.path ?? '' }, doc?.path ?? '—'),
          h(CopyButton, { text: doc?.path ?? '', label: t('copy'), t }),
          doc !== null && doc.exists ? h(Chip, { kind: 'ok' }, t('kExists')) : h(Chip, { kind: 'warn' }, t('kMissing')),
          doc?.truncated === true ? h(Chip, { kind: 'warn' }, t('kTruncated')) : null,
        )

      const editorNodes = (scope, doc) => {
        if (doc === null) return []
        const dirty = doc.draft !== doc.text
        return [
          h('textarea', {
            key: 'editor',
            className: 'yk-input yk-textarea yk-editor',
            value: doc.draft,
            placeholder: t('kPlaceholder'),
            spellCheck: false,
            disabled: busy === 'load',
            onChange: (event) => {
              const value = event.target.value
              if (scope === 'global') setGlobalDoc((current) => ({ ...current, draft: value }))
              else setProjectDoc((current) => ({ ...current, draft: value }))
            },
          }),
          h(
            'div',
            { key: 'bar', className: 'yk-toolbar' },
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-solid', onClick: () => saveDoc(scope), disabled: disabled || !dirty },
              busy === `save-${scope}` ? h(Spinner) : null,
              flashed(flash, `save-${scope}`, t('save')),
            ),
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => importDoc(scope), disabled }, t('kImport')),
            h('span', { className: 'yk-grow' }),
            confirmClear === scope
              ? h(
                  React.Fragment,
                  null,
                  h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmClear('') }, t('cancel')),
                  h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => clearDoc(scope), disabled }, t('kClear')),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-btn yk-btn-ghost yk-dangerHover',
                    onClick: () => setConfirmClear(scope),
                    disabled: disabled || !doc.exists,
                  },
                  t('kClear'),
                ),
          ),
          confirmClear === scope
            ? h(
                'div',
                { key: 'confirm', className: 'yk-foot' },
                h('span', { className: 'yk-fieldLabel' }, t('kConfirmClear')),
                fill(t('kConfirmClearHint'), { path: doc.path }),
              )
            : null,
          h(
            'div',
            { key: 'note', className: 'yk-foot' },
            h(FlashNote, { flash, keys: [`import-${scope}`, `clear-${scope}`] }),
            h('span', { className: 'yk-cardNote' }, dirty ? t('kUnsaved') : fill(t('kChars'), { n: doc.draft.length })),
          ),
        ]
      }

      const actionChip = (doc) => {
        const dirty = doc !== null && doc.draft !== doc.text
        return h(
          Chip,
          { kind: dirty ? 'warn' : undefined },
          dirty ? t('kUnsaved') : fill(t('kChars'), { n: (doc?.draft ?? '').length }),
        )
      }

      const probeNote =
        probe === null
          ? null
          : h(
              'div',
              { className: 'yk-foot' },
              probe.ok === true
                ? `${probe.hasHead && probe.hasAnchor ? t('kProbeOk') : t('kProbeMiss')} · ${probe.sessionId ?? '?'} · ${formatBytes(
                    (probe.bytes?.head ?? 0) + (probe.bytes?.anchor ?? 0),
                  )}`
                : probe.reason === 'no-session' || probe.reason === 'not-live'
                  ? t('kProbeNone')
                  : fill(t('kProbeFail'), { reason: probe.reason ?? 'unknown' }),
            )

      const statsNote = h(
        'div',
        { className: 'yk-foot' },
        stats && stats.assembled > 0
          ? fill(t('kStats'), { a: stats.assembled, b: stats.globalHits ?? 0, c: stats.projectHits ?? 0 })
          : t('kStatsNone'),
      )

      const settingsChips = [
        ['global', t('kToggleGlobal')],
        ['project', t('kToggleProject')],
        ['tailAnchor', t('kToggleAnchor')],
      ].map(([key, label]) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'yk-chip yk-chip-toggle',
            'aria-pressed': settings[key] ? 'true' : 'false',
            title: `${label}：${settings[key] ? t('gOn') : t('gOff')}`,
            disabled,
            onClick: () => flip(key),
          },
          h('span', { className: 'yk-chip-dot', 'aria-hidden': true }),
          label,
        ),
      )

      const workspaceHeader = h(
        'div',
        { key: 'workspace', className: 'yk-toolbar' },
        h(
          'select',
          {
            className: 'yk-input yk-select',
            value: workspaceId,
            'aria-label': t('fWorkspace'),
            disabled,
            onChange: (event) => switchWorkspace(event.target.value),
          },
          workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.title || workspace.path)),
        ),
        selected !== null && selected.dirExists === false ? h(Chip, { kind: 'danger' }, t('kDirMissing')) : null,
      )

      const workspaceChildren =
        projectDoc === null
          ? [workspaceHeader, h('div', { key: 'empty', className: 'yk-foot' }, workspaces.length === 0 ? t('kNoWorkspaces') : t('loading'))]
          : [workspaceHeader, pathRow(projectDoc), ...editorNodes('workspace', projectDoc)]

      return h(
        'div',
        { className: 'yk-body' },
        h(Failure, { t, name: 'rules', error: failure, onRetry: () => load(workspaceId) }),
        h(
          Card,
          {
            title: t('kTitle'),
            span: true,
            icon: h(RulesIcon, { width: 16, height: 16 }),
            action: h(
              'div',
              { className: 'yk-cardTools' },
              h(Chip, { kind: 'accent' }, fill(t('kLimit'), { n: formatBytes(config.limits?.maxBytes ?? 0) })),
            ),
          },
          h('p', { className: 'yk-cardText' }, t('kDesc')),
          h(
            'div',
            { className: 'yk-toggleRow' },
            settingsChips,
            h('span', { className: 'yk-grow' }),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: runProbe, disabled },
              busy === 'probe' ? h(Spinner, { size: 13 }) : t('kProbe'),
            ),
          ),
          probeNote,
          statsNote,
          h('div', { className: 'yk-foot' }, t('kPrecedence')),
          h('div', { className: 'yk-foot' }, t('kAgentsNote')),
        ),
        h(
          'div',
          { className: 'yk-grid' },
          h(
            Card,
            {
              key: 'global',
              title: t('kGlobalTitle'),
              icon: h(RulesIcon, { width: 16, height: 16 }),
              action: actionChip(globalDoc),
            },
            h('div', { className: 'yk-cardNote' }, t('kGlobalNote')),
            pathRow(globalDoc),
            ...editorNodes('global', globalDoc),
          ),
          h(
            Card,
            {
              key: 'workspace',
              title: t('kProjectTitle'),
              icon: h(RulesIcon, { width: 16, height: 16 }),
              action: actionChip(projectDoc),
            },
            h('div', { className: 'yk-cardNote' }, t('kProjectNote')),
            ...workspaceChildren,
          ),
        ),
        pendingSwitch !== null
          ? h(ConfirmStrip, {
              t,
              title: t('kSwitchDirty'),
              confirmLabel: t('kDiscard'),
              busy: false,
              onCancel: () => setPendingSwitch(null),
              onConfirm: () => openWorkspace(pendingSwitch),
            })
          : null,
      )
    }

    /* ---------------------------------------------------------------- purge */

    function PurgeTab({ t }) {
      const [config, setConfig] = React.useState(null)
      const [prompt, setPrompt] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [flash, show] = useFlash()
      const [failure, setFailure] = React.useState(null)
      const [confirmReset, setConfirmReset] = React.useState(false)
      const [probe, setProbe] = React.useState(null)
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.purge}/config`, signal)
          if (!alive.current) return
          setConfig(payload)
          setPrompt(payload.prompt ?? '')
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'purge' }))

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          setFailure(failureOf(error))
        } finally {
          setBusy('')
          setConfirmReset(false)
        }
      }

      const save = () =>
        run('save', async () => {
          await postJson(`${API.purge}/config`, { prompt })
          setConfig((current) => ({ ...current, prompt, isCustom: true }))
          show('save', t('saved'))
        })

      const reset = () =>
        run('reset', async () => {
          const payload = await postJson(`${API.purge}/reset`, {})
          setConfig(payload)
          setPrompt(payload.prompt ?? '')
          show('reset', t('gResetDone'))
        })

      const flip = (key) =>
        run(key, async () => {
          const payload = await postJson(`${API.purge}/config`, { [key]: !(config.settings?.[key] ?? true) })
          setConfig((current) => ({ ...current, settings: payload.settings, stats: payload.stats }))
          setProbe(null)
        })

      const runProbe = () =>
        run('probe', async () => {
          setProbe(await getJson(`${API.purge}/probe`, signal))
        })

      const dirty = config !== null && prompt !== (config.prompt ?? '')

      const switches = config?.settings ?? {}
      const stats = config?.stats
      const capabilityRow = h(
        'div',
        { className: 'yk-toggleRow' },
        [
          ['anchor', t('gAnchor')],
          ['refusalRetry', t('gRetry')],
          ['stripHostLimits', t('gScrub')],
        ].map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'yk-chip yk-chip-toggle',
              'aria-pressed': switches[key] ? 'true' : 'false',
              title: `${label}：${switches[key] ? t('gOn') : t('gOff')}`,
              disabled: busy !== '',
              onClick: () => flip(key),
            },
            h('span', { className: 'yk-chip-dot', 'aria-hidden': true }),
            label,
          ),
        ),
        h('span', { className: 'yk-grow' }),
        h(
          'button',
          { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: runProbe, disabled: busy !== '' },
          busy === 'probe' ? h(Spinner, { size: 13 }) : t('gProbe'),
        ),
      )
      const probeNote =
        probe === null
          ? null
          : h(
              'div',
              { className: 'yk-foot' },
              probe.ok === true
                ? `${probe.hasInject && probe.hasAnchor ? t('gProbeOk') : t('gProbeMiss')} · ${probe.sessionId ?? '?'}`
                : fill(t('gProbeFail'), { reason: probe.reason ?? 'unknown' }),
            )
      const statsNote = h(
        'div',
        { className: 'yk-foot' },
        stats && stats.assembled > 0
          ? `${fill(t('gStats'), { a: stats.assembled, b: (stats.scrubbed ?? 0) + (stats.tools ?? 0), c: stats.retried ?? 0 })}${
              stats.lastAt ? ` · ${String(stats.lastAt).slice(11, 19)}` : ''
            }`
          : t('gStatsNone'),
      )

      return h(
        'div',
        { className: 'yk-body' },
        h(Failure, { t, name: 'purge', error: failure, onRetry: load }),
        config === null && busy === 'load' ? h(Loading, { text: t('loading') }) : null,
        config !== null
          ? h(
              Card,
              {
                title: t('gTitle'),
                span: true,
                icon: h(PurgeIcon, { width: 16, height: 16 }),
                action: h(
                  'div',
                  { className: 'yk-cardTools' },
                  h(Chip, { kind: 'accent', dot: true }, t('gPresetUnrestricted')),
                  h(Chip, { kind: config.isCustom ? 'warn' : undefined }, config.isCustom ? t('gCustom') : t('gDefault')),
                ),
              },
              h('p', { className: 'yk-cardText' }, t('gDesc')),
              capabilityRow,
              probeNote,
              statsNote,
              h(
                'div',
                { className: 'yk-editorHead' },
                h('span', { className: 'yk-fieldLabel' }, t('gPrompt')),
                h('span', { className: 'yk-cardNote' }, dirty ? t('gUnsaved') : fill(t('gChars'), { n: prompt.length })),
              ),
              h('textarea', {
                className: 'yk-input yk-textarea yk-editor',
                value: prompt,
                placeholder: t('gPlaceholder'),
                spellCheck: false,
                disabled: busy === 'load',
                onChange: (event) => setPrompt(event.target.value),
              }),
              h(
                'div',
                { className: 'yk-toolbar' },
                h('button', { type: 'button', className: 'yk-btn yk-btn-solid', onClick: save, disabled: busy !== '' || (!dirty && flash?.key !== 'save') }, busy === 'save' ? h(Spinner) : null, flashed(flash, 'save', t('gSave'))),
                h(CopyButton, { text: prompt, label: t('copy'), t }),
                h(FlashNote, { flash, keys: ['reset'] }),
                h('span', { className: 'yk-grow' }),
                confirmReset
                  ? h(
                      React.Fragment,
                      null,
                      h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmReset(false) }, t('cancel')),
                      h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: reset, disabled: busy !== '' }, t('gConfirmReset')),
                    )
                  : config.isCustom
                    ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmReset(true), disabled: busy !== '' }, t('gReset'))
                    : null,
              ),
            )
          : null,
      )
    }

    /* --------------------------------------------------------------- runtime */

    function RuntimeTab({ t, onRestart }) {
      const [snap, setSnap] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [flash, show] = useFlash()
      const [busy, setBusy] = React.useState('')
      const [confirmRestart, setConfirmRestart] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [version, setVersion] = React.useState('')
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        try {
          const payload = await getJson(`${API.runtime}/state`, signal)
          if (!alive.current) return
          setSnap(payload.state)
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (failure?.off) return h('div', { className: 'yk-body' }, h(OffState, { t, name: 'runtime' }))

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          setFailure(failureOf(error))
        } finally {
          setBusy('')
          setConfirmRestart(false)
        }
      }

      const check = () =>
        run('check', async () => {
          const payload = await postJson(`${API.runtime}/check`, {})
          if (payload.state !== undefined) setSnap(payload.state)
          if (payload.state?.update?.available !== true) show('check', t('rLatestShort'))
        })

      const update = (target) =>
        run('update', async () => {
          const payload = await postJson(`${API.runtime}/update`, { version: target, restart: true })
          if (payload.state !== undefined) setSnap(payload.state)
          show('update', payload.changed ? fill(t('rUpdated'), { version: payload.installed ?? '?' }) : fill(t('rUpdatedSame'), { version: payload.installed ?? '?' }))
          if (payload.restarted === true) onRestart()
        })

      const restart = () =>
        run('restart', async () => {
          await postJson(`${API.runtime}/restart`, { delayMs: 600 })
          onRestart()
        })

      const runtime = snap?.runtime
      const disk = snap?.disk
      const feed = snap?.update
      const strategy = snap?.restart?.strategy === 'execve' ? t('rExecve') : snap?.restart?.strategy === 'command' ? t('rCommand') : t('rExit')
      const disabled = busy !== ''

      return h(
        'div',
        { className: 'yk-body' },
        snap !== null
          ? h(
              'div',
              { className: 'yk-hero' + (feed?.available ? ' yk-hero-warn' : '') },
              h('span', { className: 'yk-heroDot', 'aria-hidden': true }),
              h(
                'div',
                { className: 'yk-heroMain' },
                h('div', { className: 'yk-heroTitle yk-mono' }, `DSH ${runtime?.version ?? '?'}`),
                h(
                  'div',
                  { className: 'yk-heroSub' },
                  disk?.stale
                    ? t('rNeedsRestart')
                    : feed?.available
                      ? fill(t('rUpdateReady'), { version: feed.latest })
                      : feed?.checkedAt
                        ? fill(t('rUpToDate'), { channel: runtime?.channel ?? '' })
                        : t('rNotChecked'),
                ),
              ),
              h(
                'div',
                { className: 'yk-heroActions' },
                h(FlashNote, { flash, keys: ['update'] }),
                feed?.available
                  ? h('button', { type: 'button', className: 'yk-btn yk-btn-solid', onClick: () => update(undefined), disabled }, busy === 'update' ? h(Spinner) : h(DownloadIcon), busy === 'update' ? t('rUpdating') : fill(t('rUpdateTo'), { version: feed.latest }))
                  : h('button', { type: 'button', className: 'yk-btn', onClick: check, disabled }, busy === 'check' ? h(Spinner) : flash?.key === 'check' ? null : h(RefreshIcon), busy === 'check' ? t('rChecking') : flashed(flash, 'check', t('rCheck'))),
                h(
                  'button',
                  {
                    type: 'button',
                    className: disk?.stale || confirmRestart ? 'yk-btn yk-btn-solid' : 'yk-btn yk-btn-ghost',
                    'aria-expanded': confirmRestart ? 'true' : 'false',
                    onClick: () => setConfirmRestart((value) => !value),
                    disabled,
                  },
                  h(PowerIcon),
                  t('rRestart'),
                ),
              ),
            )
          : null,

        snap !== null && confirmRestart
          ? h(ConfirmStrip, {
              t,
              title: t('confirmRestart'),
              hint: t('confirmRestartHint'),
              confirmLabel: t('rRestart'),
              busy: busy === 'restart',
              onCancel: () => setConfirmRestart(false),
              onConfirm: restart,
            })
          : null,

        h(Failure, { t, name: 'runtime', error: failure, onRetry: load }),
        snap === null && failure === null ? h(Loading, { text: t('loading') }) : null,

        snap !== null ? h('div', { className: 'yk-grid' },
          h(Card, { title: t('rCardVersion'), icon: h(DownloadIcon, { width: 16, height: 16 }), action: h('button', { type: 'button', className: 'yk-cardAction', 'aria-expanded': picking ? 'true' : 'false', onClick: () => setPicking((value) => !value) }, picking ? t('rPickVersionClose') : t('rPickVersion')) },
            h('div', { className: 'yk-rows' },
              disk?.stale ? h(Row, { label: t('rOnDisk'), value: disk?.version ?? '—', mono: true }) : null,
              h(Row, { label: t('rChannel'), value: runtime?.channel ?? '—', mono: true }),
              feed?.latest ? h(Row, { label: t('rLatest'), value: feed.latest, mono: true }) : null,
            ),
            picking ? h('div', { className: 'yk-toolbar' },
              h('input', { className: 'yk-input yk-mono', style: { flex: '1 1 160px' }, value: version, placeholder: t('rVersionInput'), onChange: (event) => setVersion(event.target.value) }),
              h('button', { type: 'button', className: 'yk-btn', onClick: () => update(version.trim()), disabled: disabled || version.trim() === '' }, t('rInstall')),
            ) : null,
          ),
          h(Card, { title: t('rCardProcess'), icon: h(PowerIcon, { width: 16, height: 16 }) },
            h('div', { className: 'yk-rows' },
              h(Row, { label: t('rNode'), value: runtime?.node ?? '—', mono: true }),
              h(Row, { label: t('rUptime'), value: runtime?.uptime ?? '—' }),
              h(Row, { label: t('rStrategy'), value: strategy }),
            ),
          ),
          snap.lastAction?.output ? h(Card, { title: t('rCardActivity'), span: true }, h('pre', { className: 'yk-out' }, snap.lastAction.output)) : null,
        ) : null,
        h('div', { className: 'yk-foot' }, t('rHint')),
      )
    }

    /* ----------------------------------------------------------------- presets */

    /** One preset row's source tag. */
    const PRESET_SOURCE_LABEL = {
      store: 'pSourceStore',
      declared: 'pSourceDeclared',
      builtin: 'pSourceBuiltin',
      runtime: 'pSourceRuntime',
    }

    /** Group heading and hint for each source, in reading order. */
    const PRESET_GROUPS = [
      ['store', 'pMine', 'pMineHint'],
      ['declared', 'pDeclared', 'pDeclaredHint'],
      ['builtin', 'pBuiltin', 'pBuiltinHint'],
      ['runtime', 'pRuntimeGroup', 'pRuntimeHint'],
    ]

    /** A copy id that is both valid and unused. */
    function copyPresetId(from, taken) {
      const base = `${from === '' || from === undefined ? 'preset' : from}-copy`
      if (!taken.has(base)) return base
      for (let index = 2; index < 100; index += 1) {
        const candidate = `${base}-${index}`
        if (!taken.has(candidate)) return candidate
      }
      return `${base}-${Date.now().toString(36)}`
    }

    /** Whether a row's disable flag is a `!!js` condition the panel must not flip. */
    const rowCondition = (row) =>
      row !== null && typeof row === 'object' && row.disabled !== null && typeof row.disabled === 'object' && typeof row.disabled.__jsExpr === 'string'
        ? row.disabled.__jsExpr
        : null

    /** Rows an import picker can offer: the top level of one composition. */
    function importableRows(plugins) {
      return (plugins ?? []).filter((row) => row !== null && typeof row === 'object' && typeof row.name === 'string')
    }

    function PresetsTab({ t }) {
      const [state, setState] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [flash, show] = useFlash(4200)
      const [view, setView] = React.useState('list')
      const [draft, setDraft] = React.useState(null)
      const [composition, setComposition] = React.useState(null)
      const [confirmId, setConfirmId] = React.useState('')
      const [pickPurpose, setPickPurpose] = React.useState('template')
      const [importFrom, setImportFrom] = React.useState(null)
      const [chosen, setChosen] = React.useState([])
      const [advanced, setAdvanced] = React.useState(null)
      const [jsonError, setJsonError] = React.useState('')
      const [customRow, setCustomRow] = React.useState(null)
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.presets}/state`, signal)
          if (!alive.current) return
          setState(payload)
          setFailure(null)
        } catch (error) {
          if (alive.current && error?.name !== 'AbortError') setFailure(failureOf(error))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const items = state?.items ?? []
      const busyNow = busy !== ''

      const run = async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          await operation()
        } catch (error) {
          setFailure(failureOf(error))
        } finally {
          setBusy('')
          setCustomRow(null)
        }
      }

      const readTemplate = async (id) => {
        const payload = await getJson(`${API.presets}/template?id=${encodeURIComponent(id)}`, signal)
        return payload
      }

      /** Start a new preset from `item`'s composition, or from nothing. */
      const startCreate = (item) =>
        run('template', async () => {
          const taken = new Set(items.map((row) => row.id))
          let plugins = []
          let source = 'blank'
          let notes = []
          if (item !== null && item !== undefined) {
            const payload = await readTemplate(item.id)
            plugins = payload.plugins ?? []
            source = payload.source ?? item.source
            notes = payload.notes ?? []
          }
          if (!alive.current) return
          setComposition(null)
          setAdvanced(null)
          setJsonError('')
          setDraft({
            mode: 'create',
            declared: false,
            id: item === null || item === undefined ? '' : copyPresetId(item.id, taken),
            name: item === null || item === undefined ? '' : fill(t('pCopyName'), { name: item.name ?? item.id }),
            description: item?.description ?? '',
            order: '',
            plugins,
            template: item === null || item === undefined ? null : { id: item.id, name: item.name ?? item.id, source, notes },
          })
          setView('edit')
        })

      const startEdit = (item) =>
        run('get', async () => {
          const payload = await getJson(`${API.presets}/get?id=${encodeURIComponent(item.id)}`, signal)
          if (!alive.current) return
          setComposition(null)
          setAdvanced(null)
          setJsonError('')
          setDraft({
            mode: 'edit',
            declared: item.source !== 'store',
            id: item.id,
            name: item.name ?? '',
            description: item.description ?? '',
            order: item.order === null || item.order === undefined ? '' : String(item.order),
            plugins: payload.plugins ?? [],
            template: null,
          })
          setView('edit')
        })

      const showComposition = (item) =>
        run('get', async () => {
          const payload = await getJson(`${API.presets}/get?id=${encodeURIComponent(item.id)}`, signal)
          if (!alive.current) return
          setComposition({ item, plugins: payload.plugins, yaml: payload.yaml })
          setView('composition')
        })

      const save = () =>
        run('save', async () => {
          if (draft === null) return
          const body = {
            id: draft.id.trim(),
            name: draft.name.trim(),
            description: draft.description.trim(),
            plugins: draft.plugins,
          }
          if (String(draft.order).trim() !== '') body.order = Number(draft.order)
          const action = draft.mode === 'create' ? 'create' : 'update'
          await postJson(`${API.presets}/${action}`, body, signal)
          if (!alive.current) return
          setDraft(null)
          setView('list')
          show('save', t('pSaved'))
          await load()
        })

      const removeItem = (id) =>
        run('delete', async () => {
          await postJson(`${API.presets}/delete`, { id }, signal)
          if (!alive.current) return
          setConfirmId('')
          show('delete', t('pDeleted'))
          await load()
        })

      const startImport = () => {
        setPickPurpose('import')
        setImportFrom(null)
        setChosen([])
        setView('template')
      }

      const chooseImport = (item) =>
        run('template', async () => {
          const payload = await readTemplate(item.id)
          if (!alive.current) return
          const rows = importableRows(payload.plugins)
          setImportFrom({ id: item.id, name: item.name ?? item.id, rows })
          setChosen(rows.map(() => false))
          setPickPurpose('import')
          setView('import')
        })

      const confirmImport = () => {
        if (importFrom === null) return
        const picked = importFrom.rows.filter((row, index) => chosen[index] === true)
        setDraft((current) =>
          current === null ? current : { ...current, plugins: [...current.plugins, ...structuredClone(picked)] },
        )
        setView('edit')
        setImportFrom(null)
        setChosen([])
      }

      /* ------------------------------------------------------------- editor ops */

      const patchRow = (index, change) =>
        setDraft((current) =>
          current === null
            ? current
            : { ...current, plugins: current.plugins.map((row, position) => (position === index ? change(structuredClone(row)) : row)) },
        )

      const removeRow = (index) =>
        setDraft((current) =>
          current === null ? current : { ...current, plugins: current.plugins.filter((row, position) => position !== index) },
        )

      const addRow = (row) => setDraft((current) => (current === null ? current : { ...current, plugins: [...current.plugins, row] }))

      const personaIndex =
        draft === null ? -1 : draft.plugins.findIndex((row) => row !== null && typeof row === 'object' && row.name === '@deepseek-ai/dsh-persona')
      const persona = personaIndex === -1 ? null : draft.plugins[personaIndex]

      const setPersona = (field, value) =>
        patchRow(personaIndex, (row) => ({
          ...row,
          config: { ...(row.config && typeof row.config === 'object' ? row.config : {}), [field]: value },
        }))

      const openAdvanced = () => {
        setAdvanced(JSON.stringify(draft?.plugins ?? [], null, 2))
        setJsonError('')
      }

      const applyAdvanced = () => {
        let parsed
        try {
          parsed = JSON.parse(advanced ?? '')
        } catch (error) {
          setJsonError(fill(t('pJsonInvalid'), { error: messageOf(error) }))
          return
        }
        if (!Array.isArray(parsed)) {
          setJsonError(t('pJsonShape'))
          return
        }
        const bad = parsed.findIndex((row) => row === null || typeof row !== 'object' || typeof row.name !== 'string' || row.name === '')
        if (bad !== -1) {
          setJsonError(`${t('pJsonShape')}（第 ${bad + 1} 行）`)
          return
        }
        setJsonError('')
        setDraft((current) => (current === null ? current : { ...current, plugins: parsed }))
        setAdvanced(null)
      }

      /* ------------------------------------------------------------------ views */

      const closeEditor = () => {
        setDraft(null)
        setAdvanced(null)
        setJsonError('')
        setView('list')
      }

      const editorHeader = () =>
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'div',
            { className: 'yk-grow', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
            h('div', { className: 'yk-cardTitle', style: { fontSize: '15px' } }, draft.mode === 'create' ? t('pNewTitle') : t('pEditTitle')),
            draft.template === null
              ? h(
                  'div',
                  { className: 'yk-itemMeta' },
                  draft.mode === 'create' ? t('pBlankTitle') : draft.declared ? t('pDeclaredHint') : t('pMine'),
                )
              : h(
                  'div',
                  { className: 'yk-itemMeta' },
                  h(
                    'span',
                    null,
                    fill(t('pTemplateTag'), {
                      name: `${draft.template.name} · ${t(PRESET_SOURCE_LABEL[draft.template.source] ?? 'pSourceDeclared')}`,
                    }),
                  ),
                  draft.template.notes.map((note, index) => h('span', { key: index }, note)),
                ),
          ),
          h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: closeEditor, disabled: busyNow }, t('pBack')),
        )

      const field = (labelKey, control, hint) =>
        h(
          'label',
          { className: 'yk-field' },
          h('span', { className: 'yk-fieldLabel' }, t(labelKey)),
          control,
          hint === undefined ? null : h('span', { className: 'yk-itemMeta' }, hint),
        )

      const renderRow = (row, index) => {
        const condition = rowCondition(row)
        const group = row.group === true && Array.isArray(row.config)
        return h(
          'li',
          { className: 'yk-presetRow', key: `${row.id ?? row.name}-${index}` },
          h(
            'div',
            { className: 'yk-presetRowHead' },
            h('code', { className: 'yk-presetRowName' }, row.name),
            row.id === undefined ? null : h('span', { className: 'yk-itemMeta' }, row.id),
            group ? h(Chip, { kind: 'accent' }, `${t('pRowGroup')} ${row.config.length}`) : null,
            condition !== null ? h(Chip, { kind: 'warn' }, `${t('pRowCondition')}: ${condition}`) : null,
            row.disabled === true && condition === null ? h(Chip, { kind: 'danger' }, t('pRowDisabled')) : null,
          ),
          h(
            'div',
            { className: 'yk-itemActions' },
            condition !== null
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-btn yk-btn-ghost yk-btn-sm',
                    'aria-pressed': row.disabled !== true,
                    onClick: () => patchRow(index, (next) => ({ ...next, disabled: next.disabled === true ? false : true })),
                  },
                  row.disabled === true ? t('pRowEnable') : t('pRowDisable'),
                ),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm yk-iconBtn', title: t('pRemoveRow'), 'aria-label': t('pRemoveRow'), onClick: () => removeRow(index) },
              h(TrashIcon, { width: 13, height: 13 }),
            ),
          ),
        )
      }

      if (view === 'composition') {
        return h(
          'div',
          { className: 'yk-body' },
          h(
            'div',
            { className: 'yk-toolbar' },
            h(
              'div',
              { className: 'yk-grow', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
              h('div', { className: 'yk-cardTitle', style: { fontSize: '15px' } }, composition?.item?.name ?? composition?.item?.id ?? ''),
              h('div', { className: 'yk-itemMeta' }, composition?.item?.id ?? ''),
            ),
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setView('list') }, t('pBack')),
          ),
          composition?.plugins === null || composition?.plugins === undefined
            ? h('p', { className: 'yk-foot' }, t('pNoStructure'))
            : h('pre', { className: 'yk-out yk-outTall' }, JSON.stringify(composition.plugins, null, 2)),
          composition?.yaml === null || composition?.yaml === undefined
            ? null
            : h(Card, { title: t('pYaml'), note: t('pYamlHint'), span: true }, h('pre', { className: 'yk-out yk-outTall' }, composition.yaml)),
        )
      }

      if (view === 'template' && pickPurpose === 'import') {
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'presets', error: failure, onRetry: () => load() }),
          h(
            'div',
            { className: 'yk-toolbar' },
            h('div', { className: 'yk-itemTitle' }, t('pImportRows')),
            h('span', { className: 'yk-grow' }),
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setView('edit') }, t('pBack')),
          ),
          h('p', { className: 'yk-foot' }, t('pImportPick')),
          h(
            'ul',
            { className: 'yk-list' },
            items.filter((item) => item.canTemplate).map((item) =>
              h(
                'li',
                { className: 'yk-item', key: item.id },
                h(
                  'div',
                  { className: 'yk-itemMain' },
                  h('div', { className: 'yk-itemTitleRow' }, h('span', { className: 'yk-itemTitle' }, item.name ?? item.id)),
                  h(
                    'div',
                    { className: 'yk-itemMeta' },
                    h('span', null, item.id),
                    h('span', null, item.rows === null ? t('pRowsUnknown') : fill(t('pRowsCount'), { n: item.rows })),
                  ),
                ),
                h(
                  'div',
                  { className: 'yk-itemActions' },
                  h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: () => chooseImport(item), disabled: busyNow }, t('pImportChoose')),
                ),
              ),
            ),
          ),
        )
      }

      if (view === 'import' && importFrom !== null) {
        const pickedCount = chosen.filter(Boolean).length
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'presets', error: failure, onRetry: () => load() }),
          h(
            'div',
            { className: 'yk-toolbar' },
            h(
              'div',
              { className: 'yk-grow', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
              h('div', { className: 'yk-itemTitle' }, fill(t('pImportFrom'), { name: importFrom.name })),
              h('div', { className: 'yk-itemMeta' }, t('pImportHint')),
            ),
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setView('edit') }, t('pBack')),
          ),
          h(
            'ul',
            { className: 'yk-list' },
            importFrom.rows.map((row, index) =>
              h(
                'li',
                { className: 'yk-item', key: `${row.id ?? row.name}-${index}` },
                h(
                  'label',
                  { className: 'yk-itemMain', style: { flexDirection: 'row', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: chosen[index] === true,
                    onChange: (event) =>
                      setChosen((current) => current.map((value, position) => (position === index ? event.target.checked : value))),
                  }),
                  h('code', { className: 'yk-presetRowName' }, row.name),
                  row.group === true ? h(Chip, { kind: 'accent' }, t('pRowGroup')) : null,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'yk-toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'yk-btn yk-btn-sm',
                onClick: () => setChosen((current) => current.map(() => true)),
              },
              t('pSelectAll'),
            ),
            h('span', { className: 'yk-grow' }),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-solid yk-btn-sm', onClick: confirmImport, disabled: pickedCount === 0 },
              fill(t('pImportAdd'), { n: pickedCount }),
            ),
          ),
        )
      }

      if (view === 'template') {
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'presets', error: failure, onRetry: () => load() }),
          h(
            'div',
            { className: 'yk-toolbar' },
            h(
              'div',
              { className: 'yk-grow', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
              h('div', { className: 'yk-cardTitle', style: { fontSize: '15px' } }, t('pChooseTemplate')),
              h('div', { className: 'yk-itemMeta' }, t('pChooseTemplateHint')),
            ),
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => (draft === null ? setView('list') : setView('edit')) },
              t('pBack'),
            ),
          ),
          h(
            'ul',
            { className: 'yk-list' },
            h(
              'li',
              { className: 'yk-item', key: '__blank' },
              h(
                'div',
                { className: 'yk-itemMain' },
                h('div', { className: 'yk-itemTitleRow' }, h('span', { className: 'yk-itemTitle' }, t('pBlankTitle'))),
                h('div', { className: 'yk-itemMeta' }, h('span', null, t('pBlankHint'))),
              ),
              h(
                'div',
                { className: 'yk-itemActions' },
                h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: () => startCreate(null), disabled: busyNow }, t('pUseTemplate')),
              ),
            ),
            items
              .filter((item) => item.canTemplate)
              .map((item) =>
                h(
                  'li',
                  { className: 'yk-item', key: item.id },
                  h(
                    'div',
                    { className: 'yk-itemMain' },
                    h(
                      'div',
                      { className: 'yk-itemTitleRow' },
                      h('span', { className: 'yk-itemTitle' }, item.name ?? item.id),
                      h(Chip, { kind: item.source === 'store' ? 'accent' : undefined }, t(PRESET_SOURCE_LABEL[item.source])),
                      item.isDefault ? h(Chip, { kind: 'ok' }, t('pDefault')) : null,
                    ),
                    h(
                      'div',
                      { className: 'yk-itemMeta' },
                      h('span', null, item.id),
                      h('span', null, item.rows === null ? t('pRowsUnknown') : fill(t('pRowsCount'), { n: item.rows })),
                      item.description ? h('span', null, item.description) : null,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'yk-itemActions' },
                    h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: () => showComposition(item), disabled: busyNow }, t('pView')),
                    h('button', { type: 'button', className: 'yk-btn yk-btn-solid yk-btn-sm', onClick: () => startCreate(item), disabled: busyNow }, t('pUseTemplate')),
                  ),
                ),
              ),
          ),
          busy === 'template' ? h(Loading, { text: t('loading') }) : null,
        )
      }

      if (view === 'edit' && draft !== null) {
        return h(
          'div',
          { className: 'yk-body' },
          h(Failure, { t, name: 'presets', error: failure, onRetry: () => load() }),
          editorHeader(),
          h(
            'div',
            { className: 'yk-form' },
            field(
              'pName',
              h('input', {
                className: 'yk-input',
                value: draft.name,
                placeholder: t('pNamePlaceholder'),
                maxLength: state?.limits?.nameMax ?? 80,
                onChange: (event) => setDraft({ ...draft, name: event.target.value }),
              }),
            ),
            field(
              'pId',
              h('input', {
                className: 'yk-input',
                value: draft.id,
                placeholder: t('pIdPlaceholder'),
                spellCheck: false,
                disabled: draft.mode === 'edit',
                onChange: (event) => setDraft({ ...draft, id: event.target.value }),
              }),
              draft.mode === 'edit' ? t('pIdLocked') : t('pIdHint'),
            ),
            field(
              'pOrder',
              h('input', {
                className: 'yk-input',
                value: draft.order,
                inputMode: 'numeric',
                placeholder: t('pOrderHint'),
                onChange: (event) => setDraft({ ...draft, order: event.target.value }),
              }),
            ),
          ),
          field(
            'pDescription',
            h('input', {
              className: 'yk-input',
              value: draft.description,
              maxLength: state?.limits?.descMax ?? 500,
              placeholder: t('pDescriptionPlaceholder'),
              onChange: (event) => setDraft({ ...draft, description: event.target.value }),
            }),
          ),
          h(
            Card,
            { title: t('pPersona'), note: t('pPersonaHint'), span: true },
            persona === null
              ? h(
                  'div',
                  { className: 'yk-toolbar' },
                  h('span', { className: 'yk-foot' }, t('pPersonaMissing')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yk-btn yk-btn-sm',
                      onClick: () => addRow({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '' } }),
                    },
                    t('pPersonaAdd'),
                  ),
                )
              : h(
                  'div',
                  { className: 'yk-stack' },
                  h('textarea', {
                    className: 'yk-input yk-textarea yk-textareaTall',
                    value: typeof persona.config?.prefix === 'string' ? persona.config.prefix : '',
                    placeholder: t('pPersonaPlaceholder'),
                    onChange: (event) => setPersona('prefix', event.target.value),
                  }),
                  h('input', {
                    className: 'yk-input',
                    value: typeof persona.config?.suffix === 'string' ? persona.config.suffix : '',
                    placeholder: t('pPersonaSuffix'),
                    onChange: (event) => setPersona('suffix', event.target.value),
                  }),
                ),
          ),
          h(
            Card,
            {
              title: fill(t('pRowsTitle'), { n: draft.plugins.length }),
              note: t('pRowsHint'),
              span: true,
              action: h(
                'div',
                { className: 'yk-itemActions' },
                h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: startImport, disabled: busyNow }, t('pImportRows')),
                h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: () => setCustomRow({ name: '', id: '', config: '' }) }, t('pAddRow')),
              ),
            },
            draft.plugins.length === 0
              ? h('p', { className: 'yk-foot' }, t('pEmptyComposition'))
              : h('ul', { className: 'yk-presetRows' }, draft.plugins.map((row, index) => renderRow(row, index))),
            customRow === null
              ? null
              : h(
                  'div',
                  { className: 'yk-customRow' },
                  h('input', {
                    className: 'yk-input',
                    value: customRow.name,
                    placeholder: t('pRowName'),
                    onChange: (event) => setCustomRow({ ...customRow, name: event.target.value }),
                  }),
                  h('input', {
                    className: 'yk-input',
                    value: customRow.id,
                    placeholder: t('pRowId'),
                    onChange: (event) => setCustomRow({ ...customRow, id: event.target.value }),
                  }),
                  h('textarea', {
                    className: 'yk-input yk-textarea',
                    value: customRow.config,
                    placeholder: t('pRowConfig'),
                    onChange: (event) => setCustomRow({ ...customRow, config: event.target.value }),
                  }),
                  h(
                    'div',
                    { className: 'yk-toolbar' },
                    h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setCustomRow(null) }, t('pCancel')),
                    h('span', { className: 'yk-grow' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yk-btn yk-btn-solid yk-btn-sm',
                        onClick: () =>
                          run('row', async () => {
                            const name = customRow.name.trim()
                            if (name === '') throw new Error(t('pRowNameRequired'))
                            let config
                            if (customRow.config.trim() !== '') {
                              try {
                                config = JSON.parse(customRow.config)
                              } catch (error) {
                                throw new Error(fill(t('pJsonInvalid'), { error: messageOf(error) }))
                              }
                            }
                            const row = { name }
                            if (customRow.id.trim() !== '') row.id = customRow.id.trim()
                            if (config !== undefined) row.config = config
                            addRow(row)
                          }),
                      },
                      t('pAdd'),
                    ),
                  ),
                ),
          ),
          h(
            Card,
            {
              title: t('pAdvanced'),
              note: t('pAdvancedHint'),
              span: true,
              action:
                advanced === null
                  ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: openAdvanced }, t('pAdvancedOpen'))
                  : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => setAdvanced(null) }, t('pCancel')),
            },
            advanced === null
              ? null
              : h(
                  'div',
                  { className: 'yk-stack' },
                  h('textarea', {
                    className: 'yk-input yk-textarea yk-textareaCode',
                    value: advanced,
                    spellCheck: false,
                    onChange: (event) => setAdvanced(event.target.value),
                  }),
                  jsonError === '' ? null : h('p', { className: 'yk-foot yk-footError', role: 'alert' }, jsonError),
                  h(
                    'div',
                    { className: 'yk-toolbar' },
                    h('span', { className: 'yk-grow' }),
                    h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: applyAdvanced }, t('pApply')),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'yk-toolbar' },
            h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: closeEditor, disabled: busyNow }, t('pCancel')),
            h('span', { className: 'yk-grow' }),
            flash?.key === 'save' ? h('span', { className: 'yk-flash' }, flash.text) : null,
            h(
              'button',
              { type: 'button', className: 'yk-btn yk-btn-solid', onClick: save, disabled: busyNow },
              busy === 'save' ? h(Spinner, { size: 13 }) : null,
              t('pSave'),
            ),
          ),
        )
      }

      /* ------------------------------------------------------------------- list */

      return h(
        'div',
        { className: 'yk-body' },
        h(Failure, { t, name: 'presets', error: failure, onRetry: () => load() }),
        h(Banner, { kind: 'info', text: t('pTrust') }),
        state?.storeError ? h(Banner, { kind: 'error', text: fill(t('pStoreBroken'), { error: state.storeError }) }) : null,
        state?.declaredError ? h(Banner, { kind: 'warn', text: state.declaredError }) : null,
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'div',
            { className: 'yk-grow', style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
            h('div', { className: 'yk-cardTitle', style: { fontSize: '15px' } }, t('tabPresets')),
            h('div', { className: 'yk-itemMeta' }, t('pIntro')),
          ),
          flash?.key === 'save' ? h('span', { className: 'yk-flash' }, flash.text) : null,
          flash?.key === 'delete' ? h('span', { className: 'yk-flash' }, flash.text) : null,
          h(RefreshButton, { t, onClick: load, spinning: busy === 'load' }),
          h(
            'button',
            {
              type: 'button',
              className: 'yk-btn yk-btn-solid yk-btn-sm',
              onClick: () => {
                setPickPurpose('template')
                setView('template')
              },
              disabled: busyNow,
            },
            t('pNew'),
          ),
        ),
        state === null && busy === 'load' ? h(Loading, { text: t('loading') }) : null,
        PRESET_GROUPS.map(([source, titleKey, hintKey]) => {
          const rows = items.filter((item) => item.source === source)
          if (rows.length === 0 && source !== 'store') return null
          return h(
            'section',
            { className: 'yk-presetGroup', key: source },
            h('div', { className: 'yk-presetGroupHead' }, h('span', null, t(titleKey)), h('span', { className: 'yk-itemMeta' }, t(hintKey))),
            rows.length === 0
              ? h('p', { className: 'yk-foot' }, t('pEmptyList'))
              : h(
                  'ul',
                  { className: 'yk-list' },
                  rows.map((item) => [
                    h(
                      'li',
                      { className: 'yk-item', key: item.id },
                      h(
                        'div',
                        { className: 'yk-itemMain' },
                        h(
                          'div',
                          { className: 'yk-itemTitleRow' },
                          h('span', { className: 'yk-itemTitle' }, item.name ?? item.id),
                          item.isDefault ? h(Chip, { kind: 'accent' }, t('pDefault')) : null,
                          item.broken ? h(Chip, { kind: 'danger' }, t('pConflict')) : null,
                        ),
                        h(
                          'div',
                          { className: 'yk-itemMeta' },
                          h('code', { className: 'yk-presetId' }, item.id),
                          h('span', null, item.rows === null ? t('pRowsUnknown') : fill(t('pRowsCount'), { n: item.rows })),
                          item.description ? h('span', null, item.description) : null,
                          item.reason ? h('span', null, item.reason) : null,
                          item.broken ? h('span', null, item.broken) : null,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'yk-itemActions' },
                        h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => showComposition(item), disabled: busyNow }, t('pView')),
                        item.canTemplate
                          ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost yk-btn-sm', onClick: () => startCreate(item), disabled: busyNow }, t('pCopy'))
                          : null,
                        item.canEdit
                          ? h('button', { type: 'button', className: 'yk-btn yk-btn-sm', onClick: () => startEdit(item), disabled: busyNow }, t('pEdit'))
                          : null,
                        item.canDelete
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'yk-btn yk-btn-ghost yk-btn-sm yk-btn-danger',
                                onClick: () => setConfirmId(confirmId === item.id ? '' : item.id),
                                disabled: busyNow,
                              },
                              t('pDelete'),
                            )
                          : null,
                      ),
                    ),
                    confirmId === item.id
                      ? h(
                          'div',
                          { key: `${item.id}-confirm`, className: 'yk-confirmWrap' },
                          h(ConfirmStrip, {
                            t,
                            title: fill(t('pDeleteTitle'), { name: item.name ?? item.id }),
                            hint: t('pDeleteHint'),
                            confirmLabel: t('pDelete'),
                            busy: busy === 'delete',
                            onCancel: () => setConfirmId(''),
                            onConfirm: () => removeItem(item.id),
                          }),
                        )
                      : null,
                  ]),
                ),
          )
        }),
      )
    }

    /* ----------------------------------------------------------------- shell */

    const TABS = ['overview', 'chats', 'sites', 'files', 'rules', 'presets', 'proxy', 'github', 'browser', 'purge', 'runtime']
    const TAB_STORAGE_KEY = 'yukari-dsh-plugin:tab'
    const TAB_LABEL = { overview: 'tabOverview', chats: 'tabChats', sites: 'tabSites', files: 'tabFiles', rules: 'tabRules', presets: 'tabPresets', proxy: 'tabProxy', github: 'tabGithub', browser: 'compBrowser', purge: 'tabPurge', runtime: 'tabRuntime' }
    const TAB_ICON = { overview: OverviewIcon, chats: ChatIcon, sites: GlobeIcon, files: FolderIcon, rules: RulesIcon, presets: PresetsIcon, proxy: RouteIcon, github: GithubIcon, browser: GlobeIcon, purge: PurgeIcon, runtime: PowerIcon }

    function readStoredTab() {
      try {
        const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
        return stored !== null && TABS.includes(stored) ? stored : 'overview'
      } catch {
        return 'overview'
      }
    }

    /** Header update control: check first, then offer the update, then the restart. */
    function UpdateControl({ t, components, onRestart }) {
      const [phase, setPhase] = React.useState('idle')
      const [info, setInfo] = React.useState(null)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        if (phase !== 'latest') return undefined
        const timer = setTimeout(() => setPhase('idle'), 4000)
        return () => clearTimeout(timer)
      }, [phase])

      const check = async () => {
        setPhase('checking')
        try {
          const payload = await getJson(API.update)
          setInfo(payload.update)
          setPhase(payload.update.pendingRestart ? 'pending' : payload.update.available ? (payload.update.updatable ? 'available' : 'manual') : 'latest')
        } catch (error) {
          setMessage(fill(t('upFailed'), { error: messageOf(error) }))
          setPhase('error')
        }
      }

      const update = async () => {
        setPhase('updating')
        try {
          const payload = await postJson(API.update, { restart: true })
          setInfo({ ...payload.update, installed: payload.installed ?? payload.update?.installed })
          if (payload.restarted === true) {
            onRestart()
            return
          }
          setPhase(payload.updated ? 'done' : 'latest')
        } catch (error) {
          setMessage(fill(t('upUpdateFailed'), { error: messageOf(error) }))
          setPhase('error')
        }
      }

      const restart = async () => {
        try {
          await requestRestart(components)
          onRestart()
        } catch (error) {
          setMessage(fill(t('upUpdateFailed'), { error: messageOf(error) }))
          setPhase('error')
        }
      }

      const status =
        phase === 'checking' ? { kind: 'busy', text: t('upChecking') }
          : phase === 'updating' ? { kind: 'busy', text: t('upUpdating') }
            : phase === 'latest' ? { kind: 'ok', text: t('upLatest') }
              : phase === 'available' ? { kind: 'warn', text: fill(t('upAvailable'), { version: `v${info?.latest ?? ''}${info?.latestCommit ? ` (${info.latestCommit})` : ''}` }), action: h('button', { type: 'button', className: 'yk-btn yk-btn-solid yk-btn-sm', onClick: update }, t('upNow')) }
                : phase === 'manual' ? { kind: 'warn', text: t('upManual') }
                  : phase === 'done' || phase === 'pending' ? { kind: 'ok', text: fill(phase === 'done' ? t('upDone') : t('upPending'), { version: `v${info?.installed ?? info?.latest ?? ''}` }), action: h('button', { type: 'button', className: 'yk-btn yk-btn-solid yk-btn-sm', onClick: restart }, h(PowerIcon, { width: 13, height: 13 }), t('upRestart')) }
                    : phase === 'error' ? { kind: 'error', text: message }
                      : null

      // One pill that changes in place: idle → checking → result (→ updating → restart).
      const idleLike = status === null
      const clickable = idleLike || phase === 'latest' || phase === 'error'
      return h(
        'div',
        { className: 'yk-update', role: 'status', 'aria-live': 'polite' },
        h(
          clickable ? 'button' : 'div',
          {
            ...(clickable ? { type: 'button', onClick: check, title: t('upCheck') } : {}),
            className: `yk-updatePill${status === null ? '' : ` yk-updateStatus-${status.kind}`}${clickable ? ' yk-updatePill-click' : ''}`,
          },
          idleLike
            ? h(React.Fragment, null, h(RefreshIcon, { width: 13, height: 13 }), h('span', null, t('upCheck')))
            : h(
                React.Fragment,
                null,
                status.kind === 'busy' ? h(Spinner, { size: 13 }) : status.kind === 'ok' ? h(CheckIcon, { width: 13, height: 13 }) : null,
                h('span', { className: 'yk-updateText', title: status.text }, status.text),
              ),
          !clickable && status?.action ? status.action : null,
          phase === 'manual'
            ? h('button', { type: 'button', className: 'yk-updateDismiss', 'aria-label': t('close'), onClick: () => setPhase('idle') }, h(ClearIcon, { width: 11, height: 11 }))
            : null,
        ),
      )
    }

    function YukariPanel({ t, ui }) {
      const [tab, setTab] = React.useState(readStoredTab)
      const [overview, setOverview] = React.useState(null)
      const [restarting, setRestarting] = React.useState(false)
      const tabsRef = React.useRef(null)

      const loadOverview = React.useCallback(async () => {
        try {
          const payload = await getJson(API.overview)
          setOverview(payload.overview)
        } catch {
          setOverview(null)
        }
      }, [])

      React.useEffect(() => {
        loadOverview()
      }, [loadOverview])

      const components = overview?.components ?? null
      const tabs = TABS.filter((key) => key === 'overview' || components === null || Boolean(components[key]))
      const current = tabs.includes(tab) ? tab : 'overview'

      const select = React.useCallback((next) => {
        setTab(next)
        try {
          window.localStorage.setItem(TAB_STORAGE_KEY, next)
        } catch {
          /* memory only */
        }
      }, [])

      const onTabKeyDown = (event) => {
        const index = tabs.indexOf(current)
        const next =
          event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
              : event.key === 'Home' ? 0
                : event.key === 'End' ? tabs.length - 1
                  : null
        if (next === null) return
        event.preventDefault()
        select(tabs[next])
        tabsRef.current?.querySelectorAll('[role="tab"]')?.[next]?.focus()
      }

      const onRestart = () => setRestarting(true)

      return h(
        'div',
        { className: 'yk-page', 'data-yukari-panel': PANEL_ID },
        h('style', { key: 'styles' }, styles),
        h(
          'header',
          { className: 'yk-head' },
          h(
            'div',
            { className: 'yk-headBrand' },
            h('div', { className: 'yk-headLogo' }, h(PanelIcon, { size: 40, active: true })),
            h('h1', { className: 'yk-title' }, t('title')),
            overview !== null ? h(Chip, { kind: 'accent' }, `v${overview.version}`) : null,
          ),
          h(UpdateControl, { t, components, onRestart }),
        ),
        h(
          'div',
          { className: 'yk-navBar', role: 'tablist', 'aria-label': t('title'), ref: tabsRef, onKeyDown: onTabKeyDown },
          tabs.map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                className: 'yk-navTab',
                id: `yukari-tab-${key}`,
                'aria-selected': key === current ? 'true' : 'false',
                'aria-controls': `yukari-panel-${key}`,
                tabIndex: key === current ? 0 : -1,
                onClick: () => select(key),
              },
              h(TAB_ICON[key], { width: 14, height: 14 }),
              t(TAB_LABEL[key]),
            ),
          ),
        ),
        h(
          'div',
          { className: 'yk-tabPanel', role: 'tabpanel', id: `yukari-panel-${current}`, 'aria-labelledby': `yukari-tab-${current}` },
          restarting
            ? h(RestartWatch, { t })
            : current === 'overview'
              ? h(OverviewTab, { key: 'overview', t, components, onGo: select })
              : current === 'chats'
                ? h(ChatsTab, { key: 'chats', t, ui })
                : current === 'sites'
                  ? h(SitesTab, { key: 'sites', t })
                  : current === 'files'
                    ? h(FilesTab, { key: 'files', t, ui })
                  : current === 'rules'
                    ? h(RulesTab, { key: 'rules', t })
                  : current === 'presets'
                    ? h(PresetsTab, { key: 'presets', t })
                  : current === 'proxy'
                    ? h(ProxyTab, { key: 'proxy', t })
                  : current === 'github'
                    ? h(GithubTab, { key: 'github', t })
                    : current === 'browser'
                      ? h(BrowserTab, { key: 'browser', t })
                      : current === 'purge'
                        ? h(PurgeTab, { key: 'purge', t })
                        : h(RuntimeTab, { key: 'runtime', t, onRestart }),
        ),
      )
    }

    /** Sidebar rail and header logo. */
    function PanelIcon({ size, active }) {
      const edge = size ?? 20
      const [failed, setFailed] = React.useState(false)
      if (failed) {
        return h(
          'span',
          { className: 'yk-logoFallback', style: { width: `${edge}px`, height: `${edge}px`, fontSize: `${Math.round(edge * 0.5)}px` }, 'aria-hidden': true },
          'Y',
        )
      }
      return h('img', {
        src: API.icon,
        alt: '',
        width: edge,
        height: edge,
        'aria-hidden': true,
        draggable: false,
        onError: () => setFailed(true),
        style: {
          width: `${edge}px`,
          height: `${edge}px`,
          objectFit: 'contain',
          display: 'block',
          opacity: active === false ? 0.8 : 1,
          transition: 'opacity .15s ease',
        },
      })
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', en))
        ctx.effect(() => ctx.locale.register(NS, 'zh-CN', zh))
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh))
        const t = ctx.locale.bind(NS)
        const ui = {
          /** Open a file in DSH's own preview by its resource address. */
          /**
           * Open a file in DSH's own preview.
           *
           * `openResourceIn` is a no-op for a session whose right sidebar is not
           * mounted, and the panel usually shows another session — so try the
           * mounted surface first and let the caller fall back to switching.
           */
          openResource: (sessionId, relative) => {
            const right = (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined) ?? ctx.sidebarRight
            if (right === undefined || right === null) throw new Error(t('fNoPreview'))
            const address = resourceAddress(sessionId, relative)
            if (typeof right.openResource === 'function') {
              try {
                right.openResource(address)
                return
              } catch {
                /* no session surface is mounted: try the named session below */
              }
            }
            if (typeof right.openResourceIn !== 'function') throw new Error(t('fNoPreview'))
            right.openResourceIn(sessionId, address)
          },
          openSession: (id) => {
            if (ctx.uiWorkspace === undefined || typeof ctx.uiWorkspace.openSession !== 'function') {
              throw new Error('uiWorkspace is unavailable')
            }
            ctx.uiWorkspace.openSession(id)
          },
        }
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => h(YukariPanel, { ...props, t, ui })),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('title') }, PanelIcon),
          ),
        )
      },
    }
  },
})
