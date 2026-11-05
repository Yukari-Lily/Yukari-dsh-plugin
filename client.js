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
      chats: '/chat-manager/api',
      runtime: '/dshctl/api',
      sites: '/publish/api',
      proxy: '/ssproxy/api',
    }

    /* ------------------------------------------------------------------ i18n */

    const zh = {
      title: 'Yukari',
      subtitle: 'Harness 全系统控制中心',
      tabOverview: '概览',
      tabChats: '会话',
      tabRuntime: '运行时',
      tabSites: '站点',
      tabProxy: '代理',

      updatePlugin: '更新 Yukari',
      updatingPlugin: '正在更新…',
      updateSuccess: 'Yukari 插件更新成功！',
      updateRestartConfirm: '插件已拉取最新代码，需要重启 DSH 服务使修改生效。是否立即重启？',
      updateRestartNow: '立即重启 DSH',
      updateRestartLater: '稍后手动重启',
      updateFailed: '更新失败：{error}',
      cConfirmInline: '确认删除',
      cConfirmDeleteOnce: '再次点击确认删除',

      refresh: '刷新',
      retry: '重试',
      cancel: '取消',
      confirm: '确认',
      loading: '加载中…',
      never: '从未',
      none: '—',
      open: '打开',
      copy: '复制',
      copied: '已复制',
      clearSearch: '清空',
      showPassword: '显示密码',
      hidePassword: '隐藏密码',

      ovChats: '会话管理',
      ovRuntime: '运行时环境',
      ovSites: '静态站点',
      ovProxy: '出站代理',
      ovBrowser: '无头浏览器',
      ovTotal: '总数',
      ovArchived: '已归档',
      ovLive: '打开中',
      ovStored: '占用',
      ovVersion: '版本',
      ovChannel: '通道',
      ovUptime: '已运行',
      ovSitesCount: '已发布',
      ovRoot: '发布路径',
      ovLatest: '最近',
      ovState: '状态',
      ovNode: '节点',
      ovViewport: '视口',
      ovSettle: '等待',
      ovTools: '工具数',
      ovGo: '管理',
      ovOn: '已启用',
      ovOff: '未启用',
      ovRecent: '最近站点',
      ovUpdateReady: '有新版本',
      ovUpToDate: '最新',
      ovReady: '已就绪',
      ovNotReady: '未就绪',
      ovChromiumMissing: '容器或宿主未检测到 Chromium 可执行文件',

      cSearch: '搜索标题、ID、工作区或路径',
      cFilter: '会话范围',
      cAll: '全部',
      cVisible: '显示 {shown} / {total}',
      cNoMatchHint: '换一个关键词，或切换到其他范围。',
      cActive: '在用',
      cArchived: '已归档',
      cDelete: '删除',
      cDeleteN: '删除 {n} 个',
      cConfirm: '永久删除 {n} 个会话？',
      cConfirmHint: '会话产物、归档标记和固定标记会一起移除，无法恢复。',
      cForce: '连正在使用的会话一起删除',
      cArchive: '归档',
      cUnarchive: '取消归档',
      cSelected: '已选 {n}',
      cTotal: '共 {n} 个会话',
      cTotalOne: '共 1 个会话',
      cNoMatch: '没有匹配的会话',
      cNoChats: '这个 Host 上还没有会话',
      cDeleted: '已删除 {n} 个会话',
      cKept: '{n} 个会话被保留',
      cLive: '打开中',
      cRunning: '运行中',
      cArchivedTag: '归档',
      cEvents: '{n} 次事件',

      rCheck: '检查更新',
      rChecking: '正在查询 npm…',
      rUpdate: '更新并重启',
      rUpdateOnly: '仅更新',
      rRestart: '重启 dsh',
      rConfirmUpdate: '确认更新并重启？',
      rConfirmRestart: '确认重启？',
      rVersionInput: '指定版本（可选）',
      rCardVersion: '版本',
      rRunning: '运行中',
      rOnDisk: '磁盘上',
      rLatest: '最新',
      rUnknown: '未知',
      rNotChecked: '还没检查',
      rCheckedAt: '上次检查',
      rUpToDate: '已是本通道最新',
      rUpdateReady: '有新版本',
      rNeedsRestart: '已装好但未生效，重启后加载',
      rCardProcess: '进程状态',
      rContainer: '容器环境',
      rPid: 'PID',
      rNode: 'Node',
      rUptime: '已运行',
      rChannel: '通道',
      rProfile: '配置档',
      rCardFeed: '更新源与重启',
      rRegistry: 'npm 源',
      rCache: 'npm 缓存',
      rStrategy: '重启方式',
      rExecve: '原地 re-exec 同一进程',
      rExit: '退出，由守护进程拉起',
      rCommand: '执行配置的命令',
      rLastRestart: '上次重启',
      rCardActivity: '最近操作记录',
      rNoActivity: '这个进程里还没跑过操作。',
      rOkLabel: '成功',
      rFailLabel: '失败',
      rActionKind: '操作类型',
      rActionAt: '执行时间',
      rActionResult: '结果',
      rRestarting: '正在重启 dsh',
      rRestartingHint: '等待进程重新应答，页面会自己刷新。',
      rRestartWait: '第 {n} 次探测',
      rRestartSlow: '一直没回应。用 `docker compose logs -f dsh` 看容器日志；重启记录写在 DSH_HOME/.dsh-control 下。',
      rBack: '已恢复，正在刷新…',
      rUpdated: '已安装 {version}',
      rUpdatedSame: '已经是 {version}',
      rCheckedNew: '{channel} 通道最新：{version}',
      rCheckedSame: '已经是 {channel} 通道最新（{version}）',
      rQueued: '重启已排队（{strategy}）',
      rDocker: 'Docker 容器',
      rBare: '裸机运行',
      rHint: '重启期间页面会断几秒，会话本身不受影响。',

      sSearch: '搜索站点名称或 slug',
      sCount: '共 {n} 个站点',
      sCountOne: '共 1 个站点',
      sEmpty: '还没有发布过站点',
      sEmptyHint: '让智能体调用 publish_site，或把构建产物放进发布目录。',
      sUnpublish: '下线',
      sConfirm: '下线 /{slug}/？',
      sPublished: '发布于 {time}',
      sFiles: '{n} 个文件',
      sVersion: 'v{version}',
      sNoMatch: '没有匹配的站点',
      sGone: '已下线 /{slug}/',
      sKept: '没有找到 /{slug}/',

      pStatus: '出口接管状态',
      pEnable: '启用接管',
      pDisable: '停用代理',
      pEnabled: '已接管全部出站流量',
      pDisabled: '直连模式',
      pRunning: '本地代理运行中',
      pStopped: '本地代理未启动',
      pNode: '节点配置',
      pServer: '服务器地址',
      pPort: '远程端口',
      pMethod: '加密方式',
      pPassword: '节点密码',
      pPasswordKeep: '留空则保留原密码',
      pLocalPort: '本地 SOCKS 端口',
      pBypass: '直连白名单',
      pSave: '保存配置',
      pImport: '导入节点',
      pImportPlaceholder: '粘贴 ss:// 链接或 Clash 配置 JSON',
      pTest: '测试节点',
      pTesting: '正在测试…',
      pTestTarget: '测试目标 URL',
      pReset: '清除节点',
      pConfirmReset: '确认清除已保存的节点？',
      pCardStats: '流量统计',
      pActive: '在途连接',
      pTotal: '累计连接',
      pUp: '上行流量',
      pDown: '下行流量',
      pFailures: '失败连接',
      pFailuresTag: '有失败',
      pEgress: '接管范围',
      pLastError: '上次错误',
      pLastTest: '上次测试',
      pOk: '可达',
      pFail: '不可达',
      pStored: '已存密码',
      pNoPassword: '无密码',
      pSaved: '配置已保存',
      pImported: '已导入节点 {node}',
      pTested: '节点可达，延迟 {ms}ms',
      pEnabledNotice: '已启用代理接管',
      pDisabledNotice: '已停用代理',
      pResetDone: '已清除节点配置',
      pNoNode: '未配置节点',
      pInvalid: '请填写有效的服务器、远程端口（1–65535）和本地端口（1024–65535）。',
      pPending: '已启用，等待重连',
      pRetrying: '正在重连',
      pPasswordLocal: '密码加密存在本地 state 文件（0600），重启后自动恢复接管',
      pUnsaved: '有未保存的修改',
      relativeJustNow: '刚刚',
      relativeMinutes: ' 分钟前',
      relativeHours: ' 小时前',
      relativeDays: ' 天前',
    }

    const en = {
      title: 'Yukari',
      subtitle: 'Harness Unified Control Surface',
      tabOverview: 'Overview',
      tabChats: 'Chats',
      tabRuntime: 'Runtime',
      tabSites: 'Sites',
      tabProxy: 'Proxy',

      updatePlugin: 'Update Yukari',
      updatingPlugin: 'Updating…',
      updateSuccess: 'Yukari updated successfully!',
      updateRestartConfirm: 'The plugin has been updated. A restart of DSH is required for changes to take effect. Restart now?',
      updateRestartNow: 'Restart DSH Now',
      updateRestartLater: 'Restart Later',
      updateFailed: 'Update failed: {error}',
      cConfirmInline: 'Confirm',
      cConfirmDeleteOnce: 'Click again to confirm delete',

      refresh: 'Refresh',
      retry: 'Retry',
      cancel: 'Cancel',
      confirm: 'Confirm',
      loading: 'Loading…',
      never: 'never',
      none: '—',
      open: 'Open',
      copy: 'Copy',
      copied: 'Copied',
      clearSearch: 'Clear',
      showPassword: 'Show password',
      hidePassword: 'Hide password',

      ovChats: 'Chats',
      ovRuntime: 'Runtime',
      ovSites: 'Sites',
      ovProxy: 'Proxy',
      ovBrowser: 'Browser',
      ovTotal: 'Total',
      ovArchived: 'Archived',
      ovLive: 'Open',
      ovStored: 'On disk',
      ovVersion: 'Version',
      ovChannel: 'Channel',
      ovUptime: 'Uptime',
      ovSitesCount: 'Published',
      ovRoot: 'Publish Path',
      ovLatest: 'Latest',
      ovState: 'State',
      ovNode: 'Node',
      ovViewport: 'Viewport',
      ovSettle: 'Settle',
      ovTools: 'Tools',
      ovGo: 'Manage',
      ovOn: 'Enabled',
      ovOff: 'Off',
      ovRecent: 'Recent',
      ovUpdateReady: 'Update available',
      ovUpToDate: 'Up to date',
      ovReady: 'Ready',
      ovNotReady: 'Not Ready',
      ovChromiumMissing: 'Chromium binary was not detected on host/container',

      cSearch: 'Search title, id, workspace, or path',
      cFilter: 'Chat scope',
      cAll: 'All',
      cVisible: '{shown} of {total}',
      cNoMatchHint: 'Try another keyword, or switch the scope.',
      cActive: 'Active',
      cArchived: 'Archived',
      cDelete: 'Delete',
      cDeleteN: 'Delete {n}',
      cConfirm: 'Permanently delete {n} chats?',
      cConfirmHint: 'Artifacts, the archive flag, and the pin are removed with them. This cannot be undone.',
      cForce: 'Also delete chats still in use',
      cArchive: 'Archive',
      cUnarchive: 'Unarchive',
      cSelected: '{n} selected',
      cTotal: '{n} chats',
      cTotalOne: '1 chat',
      cNoMatch: 'No chat matches this filter',
      cNoChats: 'This Host stores no chats yet',
      cDeleted: 'Deleted {n} chats',
      cKept: '{n} chats kept',
      cLive: 'Open',
      cRunning: 'Running',
      cArchivedTag: 'Archived',
      cEvents: '{n} events',

      rCheck: 'Check for updates',
      rChecking: 'Checking npm…',
      rUpdate: 'Update and restart',
      rUpdateOnly: 'Update only',
      rRestart: 'Restart dsh',
      rConfirmUpdate: 'Update and restart?',
      rConfirmRestart: 'Restart now?',
      rVersionInput: 'exact version (optional)',
      rCardVersion: 'Version',
      rRunning: 'Running',
      rOnDisk: 'On disk',
      rLatest: 'Newest',
      rUnknown: 'unknown',
      rNotChecked: 'not checked yet',
      rCheckedAt: 'Last checked',
      rUpToDate: 'newest on this channel',
      rUpdateReady: 'update available',
      rNeedsRestart: 'installed but not running — restart to load it',
      rCardProcess: 'Process',
      rContainer: 'Container',
      rPid: 'PID',
      rNode: 'Node',
      rUptime: 'Uptime',
      rChannel: 'Channel',
      rProfile: 'Profile',
      rCardFeed: 'Source and restart',
      rRegistry: 'npm registry',
      rCache: 'npm cache',
      rStrategy: 'Restart method',
      rExecve: 're-exec the process in place',
      rExit: 'exit, supervisor restarts it',
      rCommand: 'run the configured command',
      rLastRestart: 'Last restart',
      rCardActivity: 'Recent activity',
      rNoActivity: 'Nothing run yet in this process.',
      rOkLabel: 'ok',
      rFailLabel: 'failed',
      rActionKind: 'Action',
      rActionAt: 'Time',
      rActionResult: 'Result',
      rRestarting: 'Restarting dsh',
      rRestartingHint: 'Waiting for the process to answer again. The page reloads by itself.',
      rRestartWait: 'attempt {n}',
      rRestartSlow: 'Still no answer. Check the container log with `docker compose logs -f dsh`; the restart journal sits under DSH_HOME/.dsh-control.',
      rBack: 'Back online — reloading…',
      rUpdated: 'Installed {version}',
      rUpdatedSame: 'Already on {version}',
      rCheckedNew: 'Newest on {channel}: {version}',
      rCheckedSame: 'Already on the newest {channel} release ({version})',
      rQueued: 'Restart queued ({strategy})',
      rDocker: 'Docker',
      rBare: 'bare host',
      rHint: 'A restart drops this page for a few seconds; the session survives it.',

      sSearch: 'Search site title or slug',
      sCount: '{n} sites',
      sCountOne: '1 site',
      sEmpty: 'No site published yet',
      sEmptyHint: 'Ask the agent to call publish_site, or drop a build into the publish root.',
      sUnpublish: 'Unpublish',
      sConfirm: 'Unpublish /{slug}/?',
      sPublished: 'published {time}',
      sFiles: '{n} files',
      sVersion: 'v{version}',
      sNoMatch: 'No site matches this search',
      sGone: 'Unpublished /{slug}/',
      sKept: 'No site at /{slug}/',

      pStatus: 'Egress',
      pEnable: 'Enable',
      pDisable: 'Disable',
      pEnabled: 'All outbound traffic routed',
      pDisabled: 'Direct',
      pRunning: 'local proxy running',
      pStopped: 'local proxy stopped',
      pNode: 'Node',
      pServer: 'Server',
      pPort: 'Port',
      pMethod: 'Cipher',
      pPassword: 'Password',
      pPasswordKeep: 'Keep the stored one',
      pLocalPort: 'Local port',
      pBypass: 'Direct allowlist',
      pSave: 'Save',
      pImport: 'Import node',
      pImportPlaceholder: 'Paste ss:// link or Clash config JSON',
      pTest: 'Test node',
      pTesting: 'Testing…',
      pTestTarget: 'Test target URL',
      pReset: 'Forget node',
      pConfirmReset: 'Forget the stored node?',
      pCardStats: 'Traffic',
      pActive: 'Active',
      pTotal: 'Total',
      pUp: 'Up',
      pDown: 'Down',
      pFailures: 'Failures',
      pFailuresTag: 'some failed',
      pEgress: 'Scope',
      pLastError: 'Last error',
      pLastTest: 'Last test',
      pOk: 'reachable',
      pFail: 'unreachable',
      pStored: 'password stored',
      pNoPassword: 'no password',
      pSaved: 'Saved',
      pImported: 'Imported {node}',
      pTested: 'Node reachable in {ms}ms',
      pEnabledNotice: 'Proxy enabled',
      pDisabledNotice: 'Proxy disabled',
      pResetDone: 'Node forgotten',
      pNoNode: 'No node configured yet',
      pInvalid: 'Enter a server, a remote port from 1–65535, and a local port from 1024–65535.',
      pPending: 'Enabled — reconnecting',
      pRetrying: 'Reconnecting',
      pPasswordLocal: 'Password stored in the local state file (0600); the route resumes after a restart',
      pUnsaved: 'Unsaved changes',
      relativeJustNow: 'just now',
      relativeMinutes: 'm ago',
      relativeHours: 'h ago',
      relativeDays: 'd ago',
    }

    /* ---------------------------------------------------------------- design */

    const styles = `
.yk-page {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 0 clamp(20px, 3.5vw, 44px) 48px;
  overflow-y: auto;
  overflow-x: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.5;
  scrollbar-gutter: stable;
  -webkit-font-smoothing: antialiased;
}
.yk-page * { box-sizing: border-box; }
.yk-page > * { width: 100%; max-width: 960px; flex: none; }
.yk-page > style { display: none; }

/* Header Brand Area */
.yk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 24px;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
  padding-bottom: 18px;
}
.yk-headBrand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.yk-headLogo {
  width: 38px;
  height: 38px;
  border-radius: var(--dsw-radius-md, 10px);
  overflow: hidden;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}
.yk-headInfo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.yk-titleRow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.yk-title {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  line-height: 26px;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.yk-subtitle {
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.yk-headBadges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
}

/* Capsule Segmented Tabs */
.yk-navBar {
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 960px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: 999px;
  padding: 3px;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.yk-navBar::-webkit-scrollbar { display: none; }
.yk-navTab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  height: 32px;
  padding: 0 14px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
  flex: 1 1 0;
  min-width: 80px;
  transition: all .16s ease;
}
.yk-navTab:hover:not([aria-selected="true"]) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.05));
}
.yk-navTab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary-inverted, #fff);
  background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #6366f1));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
}
.yk-navTab:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #6366f1);
  outline-offset: 1px;
}

/* Tab Panels */
.yk-tabPanel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  min-width: 0;
}
.yk-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}

/* Metric Stats Hero Strip */
.yk-statsGrid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
}
.yk-statCard {
  appearance: none;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-lg, 12px);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease, transform .12s ease;
}
.yk-statCard:hover {
  border-color: var(--dsw-alias-state-business-primary, #6366f1);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base));
  transform: translateY(-1px);
}
.yk-statHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}
.yk-statValue {
  font-size: 19px;
  font-weight: 600;
  line-height: 24px;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.yk-statSub {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Modern Card / Groups */
.yk-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.yk-card {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 12px);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  transition: border-color .15s;
}
.yk-card:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l1));
}
.yk-card-wide {
  grid-column: 1 / -1;
}
.yk-cardHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.yk-cardTitleWrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.yk-cardTitle {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.yk-cardNote {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.yk-cardAction {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 6px;
  transition: background .12s;
}
.yk-cardAction:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}

/* Rows List inside Card */
.yk-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.yk-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.05));
  min-width: 0;
  font-size: 13px;
}
.yk-row:last-child {
  border-bottom: 0;
  padding-bottom: 2px;
}
.yk-key {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}
.yk-val {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-primary);
  text-align: right;
  overflow-wrap: anywhere;
}
.yk-val-clamp {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.yk-rows-2col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 24px;
}
.yk-rows-2col .yk-row {
  justify-content: space-between;
}

/* Toolbar & Filter Bar */
.yk-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
}
.yk-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 260px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-md, 10px);
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-tertiary);
  transition: border-color .15s, box-shadow .15s;
}
.yk-search:focus-within {
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
.yk-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.yk-searchClear {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  transition: color .15s, background .15s;
}
.yk-searchClear:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.1));
}

/* Segmented Pill Group */
.yk-seg {
  display: inline-flex;
  align-items: center;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
}
.yk-segItem {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  transition: background .12s, color .12s;
}
.yk-segItem:hover:not([aria-selected="true"]) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06));
}
.yk-segItem[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.12));
}
.yk-segBadge {
  font-size: 11px;
  opacity: .75;
  font-variant-numeric: tabular-nums;
}

/* Buttons */
.yk-btn {
  appearance: none;
  height: 34px;
  padding: 0 13px;
  border-radius: var(--dsw-radius-md, 10px);
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  text-decoration: none;
  transition: all .15s ease;
}
.yk-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));
  border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
}
.yk-btn:disabled {
  opacity: .45;
  cursor: default;
}
.yk-btn-solid {
  background: var(--dsw-alias-button-primary-fill, #fff);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-inverted, #000);
  font-weight: 600;
}
.yk-btn-solid:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, rgba(255,255,255,0.9));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-inverted, #000);
}
.yk-btn-danger {
  color: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.08);
}
.yk-btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.16);
  border-color: var(--dsw-alias-state-error-primary, #ef4444);
}
.yk-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.yk-btn-ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));
  color: var(--dsw-alias-label-primary);
}
.yk-iconBtn {
  width: 34px;
  height: 34px;
  padding: 0;
  flex: none;
}

/* Badges / Chips */
.yk-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 18px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.yk-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.yk-chip-ok {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
  border: .5px solid rgba(16, 185, 129, 0.25);
}
.yk-chip-warn {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
  border: .5px solid rgba(245, 158, 11, 0.25);
}
.yk-chip-danger {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
  border: .5px solid rgba(239, 68, 68, 0.25);
}
.yk-chip-purple {
  color: #c084fc;
  background: rgba(168, 85, 247, 0.14);
  border: .5px solid rgba(168, 85, 247, 0.3);
}
.yk-chip-brand {
  color: var(--dsw-alias-label-secondary);
  background: rgba(255, 255, 255, 0.08);
}

/* Modern List Items (Chats / Sites) */
.yk-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.yk-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 14px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  border: .5px solid var(--dsw-alias-border-l1, transparent);
  border-radius: var(--dsw-radius-md, 10px);
  transition: all .15s ease;
}
.yk-item:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.04));
  border-color: var(--dsw-alias-border-l2);
}
.yk-itemMain {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.yk-itemTitleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.yk-itemTitle {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  text-align: left;
  font: inherit;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  cursor: pointer;
}
button.yk-itemTitle:hover {
  color: var(--dsw-alias-state-business-primary, #8b5cf6);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.yk-itemMeta {
  display: flex;
  align-items: center;
  gap: 6px 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.yk-itemMeta span + span::before {
  content: '·';
  margin-right: 10px;
  opacity: .5;
}
.yk-itemActions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* Checkbox */
.yk-check {
  flex: none;
  width: 17px;
  height: 17px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25));
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  appearance: none;
  color: transparent;
  transition: all .15s;
}
.yk-check:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-secondary);
}
.yk-check[aria-checked="true"], .yk-check[aria-checked="mixed"] {
  background: var(--dsw-alias-state-business-primary, #6366f1);
  border-color: var(--dsw-alias-state-business-primary, #6366f1);
  color: #fff;
}
.yk-check[aria-checked="mixed"]::after {
  content: "";
  width: 8px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
}

/* Floating Batch Action Bar */
.yk-batchBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  background: rgba(99, 102, 241, 0.1);
  border: .5px solid rgba(99, 102, 241, 0.35);
  border-radius: var(--dsw-radius-md, 10px);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
}

/* Copy & Password Utility */
.yk-copyBtn {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 3px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all .15s;
}
.yk-copyBtn:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));
}
.yk-pwWrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}
.yk-pwWrap input {
  padding-right: 34px;
}
.yk-pwToggle {
  position: absolute;
  right: 6px;
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 4px;
  padding: 0;
  transition: color .15s;
}
.yk-pwToggle:hover {
  color: var(--dsw-alias-label-primary);
}

/* Form Grid */
.yk-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 12px;
}
.yk-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.yk-fieldLabel {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.yk-input {
  height: 36px;
  min-width: 0;
  width: 100%;
  border-radius: var(--dsw-radius-md, 10px);
  border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.yk-input:focus {
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
.yk-input:disabled { opacity: .5; }

/* Banners & Dialogs */
.yk-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-md, 10px);
  font-size: 13px;
  line-height: 19px;
}
.yk-bannerInfo {
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-label-secondary);
}
.yk-bannerWarn {
  background: rgba(245, 158, 11, 0.12);
  border: .5px solid rgba(245, 158, 11, 0.3);
  color: #fbbf24;
}
.yk-bannerError {
  background: rgba(239, 68, 68, 0.12);
  border: .5px solid rgba(239, 68, 68, 0.3);
  color: #f87171;
}
.yk-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: var(--dsw-radius-lg, 12px);
  border: .5px solid rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
}
.yk-confirmTitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.yk-confirmHint {
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.yk-confirmActions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/* Empty & Overlay */
.yk-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
}
.yk-emptyTitle {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.yk-emptyHint {
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
  max-width: 44ch;
}
.yk-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  padding: 64px 20px;
}
.yk-overlayTitle {
  font-size: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.yk-overlayHint {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  max-width: 42ch;
}

/* Footer & Mono */
.yk-mono {
  font-family: var(--ds-font-family-code, var(--dsw-font-mono, monospace));
  font-size: 12px;
}
.yk-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  padding: 4px 2px;
}
.yk-footDot { opacity: .4; }
.yk-out {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.2));
  border: .5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
.yk-spin { animation: yk-spin 1s linear infinite; }
@keyframes yk-spin { to { transform: rotate(360deg); } }

/* Media Breakpoints */
@media(max-width: 768px) {
  .yk-page { padding: 0 16px 36px; }
  .yk-statsGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .yk-grid { grid-template-columns: minmax(0, 1fr); }
  .yk-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .yk-rows-2col { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .yk-head { flex-direction: column; align-items: flex-start; gap: 12px; }
  .yk-headBadges { width: 100%; }
}
@media(max-width: 520px) {
  .yk-statsGrid { grid-template-columns: minmax(0, 1fr); }
  .yk-form { grid-template-columns: minmax(0, 1fr); }
  .yk-navTab span:not(.yk-navTabLabel) { display: none; }
  .yk-btnLabel { display: none; }
}
.yk-modalBackdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.yk-modalCard {
  width: 100%;
  max-width: 440px;
  background: var(--dsw-alias-bg-layer-2, #18181b);
  border: .5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
  border-radius: var(--dsw-radius-xl, 16px);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.yk-modalTitle {
  font-size: 17px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.yk-modalDesc {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  margin: 0;
}
.yk-modalActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
@media(prefers-reduced-motion: reduce) {
  .yk-page * { animation: none !important; transition: none !important; }
}
`;

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

    async function getJson(url, signal) {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || (payload !== null && payload.ok === false)) {
        const message = payload !== null && payload.error ? payload.error : `HTTP ${response.status}`
        const error = new Error(message)
        if (payload !== null && typeof payload === 'object') Object.assign(error, payload)
        throw error
      }
      return payload
    }

    async function postJson(url, body, signal) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || (payload !== null && payload.ok === false)) {
        const message = payload !== null && payload.error ? payload.error : `HTTP ${response.status}`
        const error = new Error(message)
        if (payload !== null && typeof payload === 'object') Object.assign(error, payload)
        throw error
      }
      return payload
    }

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
          stroke('M4.6 7.4h14.8', { key: 'a' }),
          stroke('M6.2 7.4v10.2a1.4 1.4 0 0 0 1.4 1.4h8.8a1.4 1.4 0 0 0 1.4-1.4V7.4', { key: 'b' }),
          stroke('M9.4 5h5.2v2.4', { key: 'c' }),
          stroke('M9.8 11.6h4.4', { key: 'd' }),
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

    /* ---------------------------------------------------------------- overview */

    function OverviewTab({ t, onGo }) {
      const [state, setState] = React.useState({ overview: null, chats: null, runtime: null, sites: null, proxy: null })
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy(true)
        const settled = await Promise.allSettled([
          getJson(API.overview, signal),
          getJson(`${API.chats}/state`, signal),
          getJson(`${API.runtime}/state`, signal),
          getJson(`${API.sites}/list`, signal),
          getJson(`${API.proxy}/state`, signal),
        ])
        const pick = (index) => (settled[index].status === 'fulfilled' ? settled[index].value : null)
        const failures = settled.filter((entry) => entry.status === 'rejected' && entry.reason?.name !== 'AbortError')
        if (!alive.current) return
        setState({
          overview: pick(0)?.overview ?? null,
          chats: pick(1)?.state ?? null,
          runtime: pick(2)?.state ?? null,
          sites: pick(3)?.sites ?? null,
          proxy: pick(4)?.state ?? null,
        })
        setError(failures.length === 0 ? null : messageOf(failures[0].reason))
        setBusy(false)
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const chats = state.chats
      const runtime = state.runtime
      const sites = state.sites
      const proxy = state.proxy
      const browser = state.overview?.parts?.browser ?? null

      const go = (key) =>
        h(
          'button',
          { type: 'button', className: 'yk-cardAction', onClick: () => onGo(key), title: t('ovGo') },
          t('ovGo'),
          ' →',
        )

      return h(
        'div',
        { className: 'yk-body' },
        error !== null ? h(Banner, { kind: 'error', text: error, action: h('button', { type: 'button', className: 'yk-btn', onClick: load, disabled: busy }, t('retry')) }) : null,

        /* Metric Stats Strip */
        h(
          'div',
          { className: 'yk-statsGrid' },
          h(
            'div',
            { className: 'yk-statCard', onClick: () => onGo('chats'), title: t('ovChats') },
            h('div', { className: 'yk-statHead' }, h('span', null, t('ovChats')), h(ChatIcon, { width: 14, height: 14 })),
            h('div', { className: 'yk-statValue' }, chats === null ? '—' : String(chats.totals.all)),
            h('div', { className: 'yk-statSub' }, chats === null ? '—' : `${formatBytes(chats.totals.bytes)} 占用 · ${chats.totals.archived} 归档`),
          ),
          h(
            'div',
            { className: 'yk-statCard', onClick: () => onGo('runtime'), title: t('ovRuntime') },
            h('div', { className: 'yk-statHead' }, h('span', null, t('ovRuntime')), h(PowerIcon, { width: 14, height: 14 })),
            h('div', { className: 'yk-statValue' }, runtime?.runtime?.version ?? '—'),
            h('div', { className: 'yk-statSub' }, runtime?.runtime?.uptime ? `已运行 ${runtime.runtime.uptime}` : (runtime?.update?.available ? t('ovUpdateReady') : t('ovUpToDate'))),
          ),
          h(
            'div',
            { className: 'yk-statCard', onClick: () => onGo('sites'), title: t('ovSites') },
            h('div', { className: 'yk-statHead' }, h('span', null, t('ovSites')), h(GlobeIcon, { width: 14, height: 14 })),
            h('div', { className: 'yk-statValue' }, sites === null ? '—' : String(sites.length)),
            h('div', { className: 'yk-statSub' }, sites !== null && sites.length > 0 ? `/${sites[0].slug}/` : t('none')),
          ),
          h(
            'div',
            { className: 'yk-statCard', onClick: () => onGo('proxy'), title: t('ovProxy') },
            h('div', { className: 'yk-statHead' }, h('span', null, t('ovProxy')), h(RouteIcon, { width: 14, height: 14 })),
            h('div', { className: 'yk-statValue' }, proxy === null ? '—' : (proxy.enabled ? (proxy.running ? t('ovOn') : t('pPending')) : t('ovOff'))),
            h('div', { className: 'yk-statSub' }, proxy?.stats ? `${formatBytes(proxy.stats.bytesDown)} 下行 · ${proxy.stats.active} 连接` : t('pDisabled')),
          ),
        ),

        /* Subsystem 2-column Grid */
        h(
          'div',
          { className: 'yk-grid' },
          h(
            Card,
            { title: t('ovChats'), icon: h(ChatIcon, { width: 16, height: 16 }), action: go('chats') },
            h(
              'div',
              { className: 'yk-rows' },
              h(Row, { label: t('ovTotal'), value: chats === null ? '—' : String(chats.totals.all) }),
              h(Row, { label: t('ovLive'), value: chats === null ? '—' : String(chats.totals.live), chips: chats?.totals?.live ? [{ text: t('cLive'), kind: 'ok', dot: true }] : [] }),
              h(Row, { label: t('ovArchived'), value: chats === null ? '—' : String(chats.totals.archived) }),
              h(Row, { label: t('ovStored'), value: chats === null ? '—' : formatBytes(chats.totals.bytes), mono: true }),
            ),
          ),
          h(
            Card,
            {
              title: t('ovRuntime'),
              icon: h(PowerIcon, { width: 16, height: 16 }),
              action: go('runtime'),
              note: runtime?.update?.available === true ? t('ovUpdateReady') : (runtime?.update?.checkedAt ? t('ovUpToDate') : undefined),
            },
            h(
              'div',
              { className: 'yk-rows' },
              h(Row, {
                label: t('ovVersion'),
                value: runtime?.runtime?.version ?? '—',
                mono: true,
                chips: [
                  ...(runtime?.update?.available === true ? [{ text: t('ovUpdateReady'), kind: 'warn' }] : []),
                  ...(runtime?.disk?.stale === true ? [{ text: t('rNeedsRestart'), kind: 'warn' }] : []),
                ],
              }),
              h(Row, { label: t('ovChannel'), value: runtime?.runtime?.channel ?? '—', mono: true }),
              h(Row, { label: t('ovUptime'), value: runtime?.runtime?.uptime ?? '—' }),
              h(Row, { label: t('rNode'), value: runtime?.runtime?.node ?? '—', mono: true }),
            ),
          ),
          h(
            Card,
            { title: t('ovSites'), icon: h(GlobeIcon, { width: 16, height: 16 }), action: go('sites') },
            h(
              'div',
              { className: 'yk-rows' },
              h(Row, { label: t('ovSitesCount'), value: sites === null ? '—' : String(sites.length) }),
              h(Row, { label: t('ovLatest'), value: sites !== null && sites.length > 0 ? sites[0].title : t('none') }),
              h(Row, { label: t('ovRecent'), value: sites !== null && sites.length > 0 ? `/${sites[0].slug}/` : '—', mono: true }),
              h(Row, { label: t('ovRoot'), value: state.overview?.parts?.sites?.root ?? '/workspace/publish', mono: true, clamp: true }),
            ),
          ),
          h(
            Card,
            {
              title: t('ovProxy'),
              icon: h(RouteIcon, { width: 16, height: 16 }),
              action: go('proxy'),
              note: proxy === null ? undefined : (proxy.enabled ? t('ovOn') : t('ovOff')),
            },
            h(
              'div',
              { className: 'yk-rows' },
              h(Row, {
                label: t('ovState'),
                value: proxy === null ? '—' : (proxy.enabled ? (proxy.running ? t('pEnabled') : t('pPending')) : t('pDisabled')),
                chips: proxy === null ? [] : [{ text: proxy.running ? t('pRunning') : t('pStopped'), kind: proxy.running ? 'ok' : undefined, dot: true }],
              }),
              h(Row, {
                label: t('ovNode'),
                value: proxy === null || !proxy.node?.server ? t('pNoNode') : `${proxy.node.server}:${proxy.node.port}`,
                mono: true,
                clamp: true,
              }),
              h(Row, { label: t('pTotal'), value: proxy === null ? '—' : String(proxy.stats?.total ?? 0) }),
              h(Row, { label: t('pDown'), value: proxy === null ? '—' : formatBytes(proxy.stats?.bytesDown ?? 0), mono: true }),
            ),
          ),

          /* Full-width Browser Subsystem with Real Host Detection */
          h(
            Card,
            {
              title: t('ovBrowser'),
              span: true,
              icon: h(OverviewIcon, { width: 16, height: 16 }),
              note: browser === null ? undefined : `${browser.viewportWidth}×${browser.viewportHeight}`,
            },
            h(
              'div',
              { className: 'yk-rows yk-rows-2col' },
              h(Row, {
                label: t('ovState'),
                value: browser?.ready === true ? t('ovReady') : t('ovNotReady'),
                chips: [
                  browser?.ready === true
                    ? { text: 'Chromium', kind: 'ok', dot: true }
                    : { text: t('ovNotReady'), kind: 'warn', dot: true },
                ],
              }),
              h(Row, {
                label: 'Chromium Bin',
                value: browser?.executable ?? t('ovChromiumMissing'),
                mono: true,
                clamp: true,
              }),
              h(Row, { label: t('ovViewport'), value: browser === null ? '—' : `${browser.viewportWidth}×${browser.viewportHeight}`, mono: true }),
              h(Row, { label: t('ovSettle'), value: browser === null ? '—' : `${browser.settleMs}ms` }),
              h(Row, { label: t('ovTools'), value: state.overview === null ? '—' : `${state.overview.tools.filter((name) => name.startsWith('browser_')).length} 个工具` }),
              h(Row, { label: 'CDP Protocol', value: 'Chrome DevTools', mono: true }),
            ),
          ),
        ),

        /* Footer Info */
        h(
          'div',
          { className: 'yk-foot' },
          h('span', null, 'Yukari v1.3.0'),
          h('span', { className: 'yk-footDot' }, '·'),
          h('span', null, state.overview === null ? '—' : `${state.overview.hostname} (pid ${state.overview.pid})`),
          h('span', { className: 'yk-footDot' }, '·'),
          h('span', { className: 'yk-mono' }, state.overview?.parts?.sites?.publicBase || 'http://127.0.0.1:3080/p'),
        ),
      )
    }

    /* ---------------------------------------------------------------- chats */

    function ChatsTab({ t, ui }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [selected, setSelected] = React.useState([])
      const [confirming, setConfirming] = React.useState(null)
      const [inlineDeleteId, setInlineDeleteId] = React.useState(null)
      const inlineDeleteTimer = React.useRef(null)
      const [force, setForce] = React.useState(false)
      const [kept, setKept] = React.useState(null)
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.chats}/state`, signal)
          if (!alive.current) return
          setData(payload.state)
          setError(null)
          setSelected((current) => current.filter((id) => payload.state.sessions.some((row) => row.id === id)))
        } catch (failure) {
          if (alive.current && failure?.name !== 'AbortError') setError(messageOf(failure))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const rows = data === null ? [] : data.sessions
      const needle = query.trim().toLowerCase()
      const visible = rows.filter((row) => {
        if (filter === 'active' && row.archived) return false
        if (filter === 'archived' && !row.archived) return false
        if (needle === '') return true
        const haystack = [row.title ?? '', row.id, row.cwd ?? '', row.workspaceTitle ?? ''].join('\n').toLowerCase()
        return haystack.includes(needle)
      })

      const toggle = (id) =>
        setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

      const run = async (name, operation) => {
        setBusy(name)
        setError(null)
        setNotice(null)
        setKept(null)
        try {
          const result = await operation()
          return result
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy('')
          setConfirming(null)
          setForce(false)
        }
      }

      const remove = (ids, useForce) =>
        run('delete', async () => {
          const payload = await postJson(`${API.chats}/delete`, { ids, force: useForce === true })
          setData(payload.state)
          setSelected((current) => current.filter((id) => !payload.ids.includes(id)))
          const count = payload.deleted ?? 0
          setNotice(fill(t('cDeleted'), { n: count }))
          if (payload.failed && payload.failed.length > 0) {
            setKept(payload.failed)
            setError(payload.failed.map((item) => `${item.id}: ${item.reason}`).join('; '))
          }
        })

      React.useEffect(() => {
        if (confirming === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setConfirming(null)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [confirming])

      const archive = (row) =>
        run('archive', async () => {
          const payload = await postJson(`${API.chats}/archive`, { id: row.id, archived: !row.archived })
          setData(payload.state)
        })

      const openSession = (id) => {
        try {
          ui.openSession(id)
        } catch (failure) {
          setError(messageOf(failure))
        }
      }

      const selectedRows = rows.filter((row) => selected.includes(row.id))
      const confirmIds = selectedRows.length > 0 ? selectedRows.map((row) => row.id) : []
      const deleteIds = confirming === 'bulk' ? confirmIds : confirming === null ? [] : [confirming]
      const deleteRows = rows.filter((row) => deleteIds.includes(row.id))
      const hasLive = deleteRows.some((row) => row.live)
      const visibleSelected = visible.filter((row) => selected.includes(row.id)).length
      const toggleAll = () => {
        const ids = visible.map((row) => row.id)
        setSelected((current) => (visibleSelected === ids.length ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]))
      }

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'label',
            { className: 'yk-search' },
            h(SearchIcon),
            h('input', {
              value: query,
              placeholder: t('cSearch'),
              'aria-label': t('cSearch'),
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== ''
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-searchClear',
                    title: t('clearSearch'),
                    'aria-label': t('clearSearch'),
                    onClick: (e) => {
                      e.preventDefault()
                      setQuery('')
                    },
                  },
                  h(ClearIcon, { width: 12, height: 12 }),
                )
              : null,
          ),
          h(Segmented, {
            value: filter,
            onChange: setFilter,
            label: t('cFilter'),
            items: [
              { key: 'all', label: t('cAll'), count: data === null ? undefined : data.totals.all },
              { key: 'active', label: t('cActive'), count: data === null ? undefined : data.totals.active },
              { key: 'archived', label: t('cArchived'), count: data === null ? undefined : data.totals.archived },
            ],
          }),
          h(
            'button',
            { type: 'button', className: 'yk-btn yk-iconBtn yk-btn-ghost', onClick: load, disabled: busy === 'load', title: t('refresh'), 'aria-label': t('refresh') },
            h(RefreshIcon, { className: busy === 'load' ? 'yk-spin' : undefined }),
          ),
        ),

        /* Floating Batch Bar */
        confirmIds.length > 0
          ? h(
              'div',
              { className: 'yk-batchBar' },
              h('span', null, fill(t('cSelected'), { n: confirmIds.length })),
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setSelected([]) },
                  t('cancel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => { setForce(false); setConfirming('bulk') }, disabled: busy !== '' },
                  h(TrashIcon),
                  fill(t('cDeleteN'), { n: confirmIds.length }),
                ),
              ),
            )
          : null,

        error !== null ? h(Banner, { kind: 'error', text: `${error}`, action: kept !== null ? h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => remove(kept.map((item) => item.id), true), disabled: busy !== '' }, t('cForce')) : h('button', { type: 'button', className: 'yk-btn', onClick: load }, t('retry')) }) : null,
        notice !== null ? h(Banner, { kind: 'info', text: notice }) : null,

        confirming !== null && deleteIds.length > 0
          ? h(
              'div',
              { className: 'yk-confirm', role: 'alertdialog', 'aria-label': fill(t('cConfirm'), { n: deleteIds.length }) },
              h('div', { className: 'yk-confirmTitle' }, fill(t('cConfirm'), { n: deleteIds.length })),
              h('div', { className: 'yk-confirmHint' }, t('cConfirmHint')),
              hasLive ? h('label', { className: 'yk-confirmHint', style: { cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }), ` ${t('cForce')}`) : null,
              h(
                'div',
                { className: 'yk-confirmActions' },
                h(
                  'button',
                  { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => remove(deleteIds, force), disabled: busy !== '' || (hasLive && !force) },
                  busy === 'delete' ? h(Spinner) : h(TrashIcon),
                  t('confirm'),
                ),
                h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirming(null), disabled: busy !== '' }, t('cancel')),
              ),
            )
          : null,

        data === null && busy === 'load'
          ? h(Loading, { key: 'loading', text: t('loading') })
          : visible.length === 0
            ? h(Empty, {
                icon: h(needle !== '' ? SearchIcon : ChatIcon, { width: 22, height: 22 }),
                title: rows.length === 0 ? t('cNoChats') : t('cNoMatch'),
                hint: rows.length === 0 ? undefined : t('cNoMatchHint'),
              })
            : h(
                React.Fragment,
                null,
                h('div', { className: 'yk-list' },
                  visible.map((row) => {
                    const meta = [
                      row.workspaceTitle ?? null,
                      relativeTime(row.updatedAt, t),
                      row.bytes === null ? null : formatBytes(row.bytes),
                      row.events === null ? null : fill(t('cEvents'), { n: row.events }),
                    ].filter((item) => item !== null && item !== '')
                    return h(
                      'div',
                      { className: 'yk-item', key: row.id },
                      h('button', {
                        type: 'button',
                        className: 'yk-check',
                        role: 'checkbox',
                        'aria-checked': selected.includes(row.id) ? 'true' : 'false',
                        'aria-label': row.title ?? row.id,
                        onClick: () => toggle(row.id),
                      }, selected.includes(row.id) ? h(CheckIcon, { width: 11, height: 11 }) : null),
                      h(
                        'div',
                        { className: 'yk-itemMain' },
                        h(
                          'div',
                          { className: 'yk-itemTitleRow' },
                          h('button', { type: 'button', className: 'yk-itemTitle', onClick: () => openSession(row.id), title: row.title ?? row.id }, row.title ?? row.id),
                          row.archived === true ? h(Chip, { kind: undefined }, t('cArchivedTag')) : null,
                          row.running === true ? h(Chip, { kind: 'warn', dot: true }, t('cRunning')) : null,
                          row.live === true ? h(Chip, { kind: 'ok', dot: true }, t('cLive')) : null,
                        ),
                        h(
                          'div',
                          { className: 'yk-itemMeta' },
                          meta.map((part, index) => h('span', { key: index }, part)),
                          h('span', { className: 'yk-mono' }, row.id.replace(/^session-/, '').slice(0, 8)),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'yk-itemActions' },
                        h(
                          'button',
                          { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => openSession(row.id), title: t('open'), 'aria-label': t('open') },
                          h(OpenIcon),
                          h('span', { className: 'yk-btnLabel' }, t('open')),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'yk-btn yk-btn-ghost',
                            onClick: () => archive(row),
                            disabled: busy !== '',
                            title: row.archived === true ? t('cUnarchive') : t('cArchive'),
                            'aria-label': row.archived === true ? t('cUnarchive') : t('cArchive'),
                          },
                          h(ArchiveIcon),
                          h('span', { className: 'yk-btnLabel' }, row.archived === true ? t('cUnarchive') : t('cArchive')),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: inlineDeleteId === row.id ? 'yk-btn yk-btn-danger yk-btn-sm' : 'yk-btn yk-btn-ghost yk-iconBtn',
                            title: inlineDeleteId === row.id ? t('cConfirmDeleteOnce') : t('cDelete'),
                            'aria-label': inlineDeleteId === row.id ? t('cConfirmDeleteOnce') : t('cDelete'),
                            disabled: busy !== '',
                            onClick: (e) => {
                              e.stopPropagation()
                              if (inlineDeleteId === row.id) {
                                if (inlineDeleteTimer.current) clearTimeout(inlineDeleteTimer.current)
                                setInlineDeleteId(null)
                                remove([row.id], true)
                              } else {
                                if (inlineDeleteTimer.current) clearTimeout(inlineDeleteTimer.current)
                                setInlineDeleteId(row.id)
                                inlineDeleteTimer.current = setTimeout(() => {
                                  setInlineDeleteId(null)
                                }, 3500)
                              }
                            },
                          },
                          inlineDeleteId === row.id
                            ? [h(TrashIcon, { key: 'i' }), h('span', { key: 't', className: 'yk-btnLabel' }, t('cConfirmInline'))]
                            : h(TrashIcon),
                        ),
                      ),
                    )
                  }),
                ),
              ),

        h(
          'div',
          { className: 'yk-foot' },
          h('span', null, counted(t, 'cTotalOne', 'cTotal', rows.length)),
          confirmIds.length > 0 ? h('span', { className: 'yk-footDot' }, '·') : null,
          confirmIds.length > 0 ? h('span', null, fill(t('cSelected'), { n: confirmIds.length })) : null,
          data !== null ? h('span', { className: 'yk-footDot' }, '·') : null,
          data !== null ? h('span', { className: 'yk-mono' }, data.root) : null,
        ),
      )
    }

    /* -------------------------------------------------------------- runtime */

    function RuntimeTab({ t }) {
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [version, setVersion] = React.useState('')
      const [confirm, setConfirm] = React.useState('')
      const [phase, setPhase] = React.useState('idle')
      const [attempts, setAttempts] = React.useState(0)
      const busyRef = React.useRef(false)
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        try {
          const payload = await getJson(`${API.runtime}/state`, signal)
          if (!alive.current) return
          setSnap(payload.state)
          setError(null)
        } catch (failure) {
          if (alive.current && failure?.name !== 'AbortError' && !busyRef.current) setError(messageOf(failure))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      React.useEffect(() => {
        if (phase !== 'restarting') return undefined
        setAttempts(0)
        let count = 0
        const timer = setInterval(() => {
          count += 1
          setAttempts(count)
          if (count > 45) {
            clearInterval(timer)
            setPhase('failed')
          }
        }, 800)
        return () => clearInterval(timer)
      }, [phase])

      React.useEffect(() => {
        if (phase !== 'restarting') return undefined
        let cancelled = false
        const tick = async () => {
          try {
            const response = await fetch(`${API.runtime}/state`, { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const payload = await response.json()
            if (payload !== null && payload.ok === true && !cancelled) {
              setPhase('back')
            }
          } catch {
            /* waiting */
          }
        }
        const poller = setInterval(tick, 900)
        return () => {
          cancelled = true
          clearInterval(poller)
        }
      }, [phase])

      React.useEffect(() => {
        if (phase !== 'back') return undefined
        const timer = setTimeout(() => window.location.reload(), 900)
        return () => clearTimeout(timer)
      }, [phase])

      const run = async (name, operation) => {
        setBusy(name)
        busyRef.current = true
        setError(null)
        setNotice(null)
        try {
          return await operation()
        } catch (failure) {
          setError(messageOf(failure))
          return null
        } finally {
          busyRef.current = false
          setBusy('')
          setConfirm('')
        }
      }

      const check = () =>
        run('check', async () => {
          const payload = await postJson(`${API.runtime}/check`, {})
          if (payload.state !== undefined) setSnap(payload.state)
          const channel = payload.state?.runtime?.channel ?? '—'
          const target = payload.latest ?? payload.state?.runtime?.version ?? '—'
          setNotice(
            payload.state?.update?.available === true
              ? fill(t('rCheckedNew'), { channel, version: target })
              : fill(t('rCheckedSame'), { channel, version: target }),
          )
        })

      const update = (withRestart) =>
        run('update', async () => {
          const payload = await postJson(`${API.runtime}/update`, {
            version: version.trim() === '' ? undefined : version.trim(),
            restart: withRestart,
          })
          if (payload.state !== undefined) setSnap(payload.state)
          setNotice(payload.changed ? fill(t('rUpdated'), { version: payload.installed ?? '?' }) : fill(t('rUpdatedSame'), { version: payload.installed ?? '?' }))
          if (payload.restarted === true) setPhase('restarting')
        })

      const restart = () =>
        run('restart', async () => {
          const payload = await postJson(`${API.runtime}/restart`, { delayMs: 600 })
          setNotice(fill(t('rQueued'), { strategy: payload.strategy ?? '' }))
          setPhase('restarting')
        })

      if (phase === 'restarting' || phase === 'back' || phase === 'failed') {
        return h(
          'div',
          { className: 'yk-body' },
          phase === 'restarting'
            ? h(
                'div',
                { className: 'yk-overlay' },
                h(Spinner, { size: 28 }),
                h('div', { className: 'yk-overlayTitle' }, t('rRestarting')),
                h('div', { className: 'yk-overlayHint' }, t('rRestartingHint')),
                h('div', { className: 'yk-statSub' }, fill(t('rRestartWait'), { n: attempts })),
              )
            : null,
          phase === 'back' ? h('div', { className: 'yk-overlay' }, h('div', { className: 'yk-overlayTitle' }, t('rBack'))) : null,
          phase === 'failed'
            ? h(
                'div',
                { className: 'yk-overlay' },
                h('div', { className: 'yk-overlayTitle' }, t('rRestarting')),
                h('div', { className: 'yk-overlayHint' }, t('rRestartSlow')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-btn',
                    onClick: () => {
                      setPhase('idle')
                      load()
                    },
                  },
                  t('retry'),
                ),
              )
            : null,
        )
      }

      const runtime = snap?.runtime
      const disk = snap?.disk
      const feed = snap?.update
      const strategy =
        snap?.restart?.strategy === 'execve' ? t('rExecve') : snap?.restart?.strategy === 'command' ? t('rCommand') : t('rExit')
      const disabled = busy !== ''

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'button',
            { type: 'button', className: 'yk-btn', onClick: check, disabled },
            busy === 'check' ? h(Spinner) : h(RefreshIcon),
            busy === 'check' ? t('rChecking') : t('rCheck'),
          ),
          h('input', {
            className: 'yk-input',
            style: { flex: '0 1 240px' },
            value: version,
            placeholder: t('rVersionInput'),
            'aria-label': t('rVersionInput'),
            disabled,
            onChange: (event) => setVersion(event.target.value),
          }),
          confirm === 'update'
            ? h(
                'button',
                { type: 'button', className: 'yk-btn yk-btn-solid', onClick: () => update(true), disabled },
                busy === 'update' ? h(Spinner) : h(DownloadIcon),
                t('rConfirmUpdate'),
              )
            : h(
                'button',
                { type: 'button', className: 'yk-btn yk-btn-solid', onClick: () => setConfirm('update'), disabled },
                h(DownloadIcon),
                t('rUpdate'),
              ),
          h('button', { type: 'button', className: 'yk-btn', onClick: () => update(false), disabled }, t('rUpdateOnly')),
          confirm !== '' ? h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirm(''), disabled }, t('cancel')) : null,
          confirm === 'restart'
            ? h(
                'button',
                { type: 'button', className: 'yk-btn yk-btn-danger', onClick: restart, disabled },
                busy === 'restart' ? h(Spinner) : h(PowerIcon),
                t('rConfirmRestart'),
              )
            : h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => setConfirm('restart'), disabled }, h(PowerIcon), t('rRestart')),
        ),

        error !== null ? h(Banner, { kind: 'error', text: error, action: h('button', { type: 'button', className: 'yk-btn', onClick: load }, t('retry')) }) : null,
        notice !== null ? h(Banner, { kind: 'info', text: notice }) : null,
        snap === null ? h(Loading, { key: 'loading', text: t('loading') }) : null,

        snap !== null
          ? h(
              'div',
              { className: 'yk-grid' },
              h(
                Card,
                {
                  title: t('rCardVersion'),
                  icon: h(DownloadIcon, { width: 16, height: 16 }),
                  note: feed?.available === true ? t('rUpdateReady') : feed?.checkedAt === null ? t('rNotChecked') : t('rUpToDate'),
                },
                h(
                  'div',
                  { className: 'yk-rows' },
                  h(Row, {
                    label: t('rRunning'),
                    value: runtime?.version ?? t('rUnknown'),
                    mono: true,
                    chips: disk?.stale === true ? [{ text: t('rNeedsRestart'), kind: 'warn' }] : [],
                  }),
                  h(Row, {
                    label: t('rOnDisk'),
                    value: disk?.version ?? t('rUnknown'),
                    mono: true,
                    chips: disk?.error ? [{ text: disk.error, kind: 'warn' }] : [],
                  }),
                  h(Row, {
                    label: t('rLatest'),
                    value: feed?.latest ?? (feed?.error ? feed.error : t('rNotChecked')),
                    mono: feed?.latest !== null && feed?.latest !== undefined,
                    chips: feed?.available === true ? [{ text: t('rUpdateReady'), kind: 'warn' }] : [],
                  }),
                  h(Row, {
                    label: t('rCheckedAt'),
                    value: feed?.checkedAt === null || feed?.checkedAt === undefined ? t('rNotChecked') : formatTime(feed.checkedAt),
                    mono: true,
                  }),
                ),
              ),
              h(
                Card,
                { title: t('rCardProcess'), icon: h(PowerIcon, { width: 16, height: 16 }) },
                h(
                  'div',
                  { className: 'yk-rows' },
                  h(Row, {
                    label: t('rContainer'),
                    value: runtime?.hostname ?? '—',
                    mono: true,
                    chips: [{ text: runtime?.docker === true ? t('rDocker') : t('rBare'), kind: runtime?.docker === true ? 'ok' : undefined }],
                  }),
                  h(Row, { label: t('rPid'), value: String(runtime?.pid ?? '—'), mono: true }),
                  h(Row, { label: t('rNode'), value: runtime?.node ?? '—', mono: true }),
                  h(Row, { label: t('rUptime'), value: runtime?.uptime ?? '—' }),
                  h(Row, { label: t('rChannel'), value: runtime?.channel ?? '—', mono: true }),
                  h(Row, { label: t('rProfile'), value: runtime?.profile ?? '—', mono: true }),
                ),
              ),
              h(
                Card,
                { title: t('rCardFeed'), icon: h(RefreshIcon, { width: 16, height: 16 }) },
                h(
                  'div',
                  { className: 'yk-rows' },
                  h(Row, { label: t('rRegistry'), value: snap.npm.registry, mono: true, clamp: true }),
                  h(Row, { label: t('rCache'), value: snap.npm.cacheDir, mono: true, clamp: true }),
                  h(Row, {
                    label: t('rStrategy'),
                    value: strategy,
                    chips: snap.restart.strategy === 'command' ? [{ text: snap.restart.command ?? '', kind: 'warn' }] : [],
                  }),
                  h(Row, {
                    label: t('rLastRestart'),
                    value: snap.restart.last === null ? t('never') : `${formatTime(snap.restart.last.at)} · ${snap.restart.last.strategy ?? ''}`,
                    mono: true,
                  }),
                ),
              ),
              h(
                Card,
                { title: t('rCardActivity'), icon: h(OverviewIcon, { width: 16, height: 16 }) },
                snap.lastAction === null || snap.lastAction === undefined
                  ? h('div', { className: 'yk-foot' }, t('rNoActivity'))
                  : h(
                      'div',
                      { className: 'yk-rows' },
                      h(Row, { label: t('rActionKind'), value: snap.lastAction.kind ?? '—', mono: true }),
                      h(Row, { label: t('rActionAt'), value: formatTime(snap.lastAction.at), mono: true }),
                      h(Row, {
                        label: t('rActionResult'),
                        value: snap.lastAction.detail ?? '—',
                        chips: [{ text: snap.lastAction.ok ? t('rOkLabel') : t('rFailLabel'), kind: snap.lastAction.ok ? 'ok' : 'danger', dot: true }],
                      }),
                      snap.lastAction.output !== undefined && snap.lastAction.output !== ''
                        ? h('pre', { key: 'out', className: 'yk-out' }, snap.lastAction.output)
                        : null,
                    ),
              ),
            )
          : null,

        h('div', { className: 'yk-foot' }, t('rHint')),
      )
    }

    /* ---------------------------------------------------------------- sites */

    function SitesTab({ t }) {
      const [sites, setSites] = React.useState(null)
      const [root, setRoot] = React.useState('')
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [confirming, setConfirming] = React.useState('')
      const { signal, alive } = useAbortOnUnmount()

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.sites}/list`, signal)
          if (!alive.current) return
          setSites(payload.sites)
          setRoot(payload.root ?? '')
          setError(null)
        } catch (failure) {
          if (alive.current && failure?.name !== 'AbortError') setError(messageOf(failure))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const remove = (slug) =>
        (async () => {
          setBusy('delete')
          setError(null)
          setNotice(null)
          try {
            const payload = await postJson(`${API.sites}/delete`, { slug })
            setSites(payload.sites)
            setNotice(payload.deleted ? fill(t('sGone'), { slug }) : fill(t('sKept'), { slug }))
          } catch (failure) {
            setError(messageOf(failure))
          } finally {
            setBusy('')
            setConfirming('')
          }
        })()

      const needle = query.trim().toLowerCase()
      const visible = (sites ?? []).filter(
        (site) => needle === '' || String(site.title).toLowerCase().includes(needle) || String(site.slug).toLowerCase().includes(needle),
      )

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'label',
            { className: 'yk-search' },
            h(SearchIcon),
            h('input', {
              value: query,
              placeholder: t('sSearch'),
              'aria-label': t('sSearch'),
              onChange: (event) => setQuery(event.target.value),
            }),
            query !== ''
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'yk-searchClear',
                    title: t('clearSearch'),
                    'aria-label': t('clearSearch'),
                    onClick: (e) => {
                      e.preventDefault()
                      setQuery('')
                    },
                  },
                  h(ClearIcon, { width: 12, height: 12 }),
                )
              : null,
          ),
          h(
            'button',
            { type: 'button', className: 'yk-btn yk-iconBtn yk-btn-ghost', onClick: load, disabled: busy === 'load', title: t('refresh'), 'aria-label': t('refresh') },
            h(RefreshIcon, { className: busy === 'load' ? 'yk-spin' : undefined }),
          ),
        ),
        error !== null ? h(Banner, { kind: 'error', text: error, action: h('button', { type: 'button', className: 'yk-btn', onClick: load }, t('retry')) }) : null,
        notice !== null ? h(Banner, { kind: 'info', text: notice }) : null,

        sites === null && busy === 'load'
          ? h(Loading, { key: 'loading', text: t('loading') })
          : (sites ?? []).length === 0
            ? h(Empty, { icon: h(GlobeIcon, { width: 24, height: 24 }), title: t('sEmpty'), hint: t('sEmptyHint') })
            : visible.length === 0
              ? h(Empty, { icon: h(SearchIcon, { width: 24, height: 24 }), title: t('sNoMatch') })
              : h(
                  'div',
                  { className: 'yk-list' },
                  visible.map((site) => {
                    const targetUrl = site.url.startsWith('http') ? site.url : `${window.location.origin}${site.url}`
                    return h(
                      'div',
                      { className: 'yk-item', key: site.slug },
                      h(GlobeIcon, { width: 20, height: 20, style: { opacity: .7, flex: 'none' } }),
                      h(
                        'div',
                        { className: 'yk-itemMain' },
                        h(
                          'div',
                          { className: 'yk-itemTitleRow' },
                          h('button', { type: 'button', className: 'yk-itemTitle', onClick: () => window.open(targetUrl, '_blank', 'noopener'), title: targetUrl }, site.title),
                          h(Chip, { kind: undefined }, fill(t('sVersion'), { version: site.version })),
                          h(Chip, { kind: undefined }, fill(t('sFiles'), { n: site.files })),
                        ),
                        h(
                          'div',
                          { className: 'yk-itemMeta' },
                          h('span', { className: 'yk-mono' }, `/${site.slug}/`),
                          h(CopyButton, { text: targetUrl, label: t('copy'), t }),
                          h('span', null, fill(t('sPublished'), { time: formatTime(site.publishedAt) })),
                          h('span', null, formatBytes(site.bytes)),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'yk-itemActions' },
                        h(
                          'a',
                          { className: 'yk-btn yk-btn-ghost', href: targetUrl, target: '_blank', rel: 'noreferrer noopener', title: t('open'), 'aria-label': t('open') },
                          h(LinkIcon),
                          h('span', { className: 'yk-btnLabel' }, t('open')),
                        ),
                        confirming === site.slug
                          ? h(
                              'span',
                              { className: 'yk-itemActions' },
                              h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: () => remove(site.slug), disabled: busy !== '' }, busy === 'delete' ? h(Spinner) : t('confirm')),
                              h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirming('') }, t('cancel')),
                            )
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'yk-btn yk-btn-ghost',
                                title: fill(t('sConfirm'), { slug: site.slug }),
                                onClick: () => setConfirming(site.slug),
                              },
                              t('sUnpublish'),
                            ),
                      ),
                    )
                  }),
                ),

        h(
          'div',
          { className: 'yk-foot' },
          h('span', null, counted(t, 'sCountOne', 'sCount', (sites ?? []).length)),
          root === '' ? null : h('span', { className: 'yk-footDot' }, '·'),
          root === '' ? null : h('span', { className: 'yk-mono' }, root),
        ),
      )
    }

    /* ---------------------------------------------------------------- proxy */

    function ProxyTab({ t }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState({ server: '', port: '', method: '', password: '', localPort: '', bypass: '' })
      const [link, setLink] = React.useState('')
      const [target, setTarget] = React.useState('')
      const [showPassword, setShowPassword] = React.useState(false)
      const [confirmReset, setConfirmReset] = React.useState(false)
      const { signal, alive } = useAbortOnUnmount()
      const touchedRef = React.useRef(false)
      const editForm = (key, value) => {
        touchedRef.current = true
        setForm((current) => ({ ...current, [key]: value }))
      }

      const adopt = (next) => {
        setState(next)
        if (!touchedRef.current && next !== null) {
          setForm((current) => ({
            server: next.node?.server ?? '',
            port: String(next.node?.port ?? ''),
            method: next.node?.method ?? '',
            password: '',
            localPort: String(next.localPort ?? ''),
            bypass: next.bypass ?? '',
          }))
        }
      }

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await getJson(`${API.proxy}/state`, signal)
          if (!alive.current) return
          adopt(payload.state)
          setError(null)
        } catch (failure) {
          if (alive.current && failure?.name !== 'AbortError') setError(messageOf(failure))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const run = async (name, operation) => {
        setBusy(name)
        setError(null)
        setNotice(null)
        try {
          return await operation()
        } catch (failure) {
          if (failure !== null && typeof failure === 'object' && failure.state !== undefined) adopt(failure.state)
          setError(messageOf(failure))
          return null
        } finally {
          setBusy('')
          setConfirmReset(false)
        }
      }

      React.useEffect(() => {
        if (!confirmReset) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setConfirmReset(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [confirmReset])

      const save = () => {
        const port = Number(form.port)
        const localPort = Number(form.localPort)
        if (!form.server.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
          setError(t('pInvalid'))
          return
        }
        run('save', async () => {
          const patch = { server: form.server.trim(), bypass: form.bypass.trim(), port, localPort }
          if (form.method.trim() !== '') patch.method = form.method.trim()
          if (form.password !== '') patch.password = form.password
          const payload = await postJson(`${API.proxy}/configure`, patch)
          touchedRef.current = false
          adopt(payload.state)
          setForm((current) => ({ ...current, password: '' }))
          setNotice(t('pSaved'))
        })
      }

      const toggle = () =>
        run('toggle', async () => {
          const payload = state?.enabled === true ? await postJson(`${API.proxy}/disable`, {}) : await postJson(`${API.proxy}/enable`, {})
          adopt(payload.state)
          setNotice(state?.enabled === true ? t('pDisabledNotice') : t('pEnabledNotice'))
        })

      const test = () =>
        run('test', async () => {
          const payload = await postJson(`${API.proxy}/test`, { target: target.trim() === '' ? undefined : target.trim() })
          adopt(payload.state)
          setNotice(fill(t('pTested'), { ms: payload.test?.ms ?? payload.test?.durationMs ?? '?' }))
        })

      const importLink = () =>
        run('import', async () => {
          const payload = await postJson(`${API.proxy}/import`, { uri: link.trim(), apply: true })
          adopt(payload.state)
          touchedRef.current = false
          setLink('')
          setNotice(fill(t('pImported'), { node: `${payload.node.server}:${payload.node.port}` }))
        })

      const reset = () =>
        run('reset', async () => {
          const payload = await postJson(`${API.proxy}/reset`, {})
          touchedRef.current = false
          adopt(payload.state)
          setNotice(t('pResetDone'))
        })

      const node = state?.node
      const stats = state?.stats
      const methods = state?.methods ?? []
      const field = (key, label, extra) =>
        h(
          'label',
          { className: 'yk-field', key },
          h('span', { className: 'yk-fieldLabel' }, label),
          extra,
        )

      return h(
        'div',
        { className: 'yk-body' },
        h(
          'div',
          { className: 'yk-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: state?.enabled === true ? 'yk-btn yk-btn-danger' : 'yk-btn yk-btn-solid',
              onClick: toggle,
              disabled: busy !== '' || state === null || !state.node?.server,
            },
            busy === 'toggle' ? h(Spinner) : h(PowerIcon),
            state?.enabled === true ? t('pDisable') : t('pEnable'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'yk-btn',
              onClick: test,
              disabled: busy !== '' || state === null || !state.node?.server,
            },
            busy === 'test' ? h(Spinner) : h(RouteIcon),
            busy === 'test' ? t('pTesting') : t('pTest'),
          ),
          h('input', {
            className: 'yk-input',
            style: { flex: '1 1 200px' },
            value: target,
            placeholder: t('pTestTarget'),
            'aria-label': t('pTestTarget'),
            onChange: (event) => setTarget(event.target.value),
          }),
          h(
            'button',
            { type: 'button', className: 'yk-btn yk-iconBtn yk-btn-ghost', onClick: load, disabled: busy === 'load', title: t('refresh'), 'aria-label': t('refresh') },
            h(RefreshIcon, { className: busy === 'load' ? 'yk-spin' : undefined }),
          ),
        ),

        error !== null ? h(Banner, { kind: 'error', text: error, action: h('button', { type: 'button', className: 'yk-btn', onClick: load }, t('retry')) }) : null,
        notice !== null ? h(Banner, { kind: 'info', text: notice }) : null,
        state?.lastError ? h(Banner, { kind: 'warn', text: `${t('pLastError')}: ${state.lastError}` }) : null,

        state === null
          ? h(Loading, { key: 'loading', text: t('loading') })
          : h(
              'div',
              { className: 'yk-grid' },
              h(
                Card,
                {
                  title: t('pStatus'),
                  icon: h(RouteIcon, { width: 16, height: 16 }),
                  note: state.enabled ? (state.running ? t('pEnabled') : t('pPending')) : t('pDisabled'),
                },
                h(
                  'div',
                  { className: 'yk-rows' },
                  h(Row, {
                    label: t('ovState'),
                    value: state.enabled ? (state.running ? t('pEnabled') : t('pPending')) : t('pDisabled'),
                    chips: [
                      state.running
                        ? { text: t('pRunning'), kind: 'ok', dot: true }
                        : state.enabled
                          ? { text: t('pRetrying'), kind: 'warn', dot: true }
                          : { text: t('pStopped'), dot: true },
                    ],
                  }),
                  h(Row, {
                    label: t('pNode'),
                    value: node === undefined || !node.server ? t('pNoNode') : `${node.server}:${node.port}`,
                    mono: true,
                    clamp: true,
                    action: node !== undefined && node.server ? h(CopyButton, { text: `${node.server}:${node.port}`, label: t('copy'), t }) : null,
                    chips: node === undefined ? [] : node.hasPassword ? [{ text: t('pStored'), kind: 'ok' }] : [{ text: t('pNoPassword') }],
                  }),
                  h(Row, { label: t('pMethod'), value: node?.method ?? '—', mono: true }),
                  h(Row, { label: t('pLocalPort'), value: String(state.localPort), mono: true }),
                  h(Row, { label: t('pEgress'), value: state.egress?.proxyUrl ?? '—', mono: true, clamp: true }),
                ),
              ),
              h(
                Card,
                { title: t('pCardStats'), icon: h(OverviewIcon, { width: 16, height: 16 }) },
                h(
                  'div',
                  { className: 'yk-rows' },
                  h(Row, { label: t('pActive'), value: String(stats?.active ?? 0) }),
                  h(Row, { label: t('pTotal'), value: String(stats?.total ?? 0) }),
                  h(Row, { label: t('pUp'), value: formatBytes(stats?.bytesUp ?? 0), mono: true }),
                  h(Row, { label: t('pDown'), value: formatBytes(stats?.bytesDown ?? 0), mono: true }),
                  h(Row, {
                    label: t('pFailures'),
                    value: String(stats?.failures ?? 0),
                    chips: (stats?.failures ?? 0) > 0 ? [{ text: t('pFailuresTag'), kind: 'warn' }] : [],
                  }),
                  h(Row, {
                    label: t('pLastTest'),
                    value:
                      state.lastTest === null || state.lastTest === undefined
                        ? t('never')
                        : `${state.lastTest.ok === false ? t('pFail') : t('pOk')} · ${state.lastTest.target ?? ''}`,
                    chips: state.lastTest === null || state.lastTest === undefined ? [] : [{ text: state.lastTest.ok === false ? t('pFail') : t('pOk'), kind: state.lastTest.ok === false ? 'danger' : 'ok', dot: true }],
                  }),
                ),
              ),
              h(
                Card,
                {
                  title: t('pNode'),
                  span: true,
                  icon: h(RouteIcon, { width: 16, height: 16 }),
                  note: touchedRef.current ? t('pUnsaved') : undefined,
                  action: h(
                    'button',
                    { type: 'button', className: 'yk-btn yk-btn-solid', onClick: save, disabled: busy !== '' || !touchedRef.current },
                    busy === 'save' ? h(Spinner) : null,
                    t('pSave'),
                  ),
                },
                h(
                  'div',
                  { className: 'yk-form' },
                  field('server', t('pServer'), h('input', {
                    className: 'yk-input',
                    value: form.server,
                    placeholder: '203.0.113.10',
                    onChange: (event) => editForm('server', event.target.value),
                  })),
                  field('port', t('pPort'), h('input', {
                    className: 'yk-input',
                    value: form.port,
                    placeholder: '8388',
                    inputMode: 'numeric',
                    onChange: (event) => editForm('port', event.target.value),
                  })),
                  field('method', t('pMethod'), h(
                    'select',
                    {
                      className: 'yk-input',
                      value: form.method,
                      onChange: (event) => editForm('method', event.target.value),
                    },
                    methods.length === 0 ? h('option', { value: form.method }, form.method || '—') : null,
                    methods.map((name) => h('option', { key: name, value: name }, name)),
                  )),
                  field('password', t('pPassword'), h(
                    'div',
                    { className: 'yk-pwWrap' },
                    h('input', {
                      className: 'yk-input',
                      type: showPassword ? 'text' : 'password',
                      autoComplete: 'new-password',
                      value: form.password,
                      placeholder: t('pPasswordKeep'),
                      onChange: (event) => editForm('password', event.target.value),
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'yk-pwToggle',
                        title: showPassword ? t('hidePassword') : t('showPassword'),
                        'aria-label': showPassword ? t('hidePassword') : t('showPassword'),
                        onClick: () => setShowPassword((v) => !v),
                      },
                      h(showPassword ? EyeOffIcon : EyeIcon, { width: 14, height: 14 }),
                    ),
                  )),
                  field('localPort', t('pLocalPort'), h('input', {
                    className: 'yk-input',
                    value: form.localPort,
                    placeholder: '17890',
                    inputMode: 'numeric',
                    onChange: (event) => editForm('localPort', event.target.value),
                  })),
                  field('bypass', t('pBypass'), h('input', {
                    className: 'yk-input',
                    value: form.bypass,
                    placeholder: 'localhost,127.0.0.1,::1',
                    onChange: (event) => editForm('bypass', event.target.value),
                  })),
                ),
                h(
                  'div',
                  { className: 'yk-toolbar', style: { marginTop: '8px' } },
                  h('input', {
                    className: 'yk-input',
                    style: { flex: '1 1 240px' },
                    value: link,
                    placeholder: t('pImportPlaceholder'),
                    'aria-label': t('pImport'),
                    onChange: (event) => setLink(event.target.value),
                  }),
                  h('button', { type: 'button', className: 'yk-btn', onClick: importLink, disabled: busy !== '' || link.trim() === '' }, busy === 'import' ? h(Spinner) : null, t('pImport')),
                  h('span', { style: { marginLeft: 'auto' } },
                    confirmReset
                      ? h(
                          React.Fragment,
                          null,
                          h('button', { type: 'button', className: 'yk-btn yk-btn-danger', onClick: reset, disabled: busy !== '' }, t('pConfirmReset')),
                          h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmReset(false) }, t('cancel')),
                        )
                      : h('button', { type: 'button', className: 'yk-btn yk-btn-ghost', onClick: () => setConfirmReset(true), disabled: busy !== '' }, t('pReset')),
                  ),
                ),
                h('div', { className: 'yk-foot' }, h('span', null, t('pPasswordLocal')), h('span', { className: 'yk-footDot' }, '·'), h('span', { className: 'yk-mono' }, state.stateFile ?? '')),
              ),
            ),
      )
    }

    /* ----------------------------------------------------------------- shell */

    const TABS = ['overview', 'chats', 'runtime', 'sites', 'proxy']
    const TAB_STORAGE_KEY = 'yukari-dsh-plugin:tab'

    function readStoredTab() {
      try {
        const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
        return stored !== null && TABS.includes(stored) ? stored : 'overview'
      } catch {
        return 'overview'
      }
    }

    function YukariPanel({ t, ui }) {
      const [tab, setTab] = React.useState(readStoredTab)
      const [version, setVersion] = React.useState(null)
      const [updating, setUpdating] = React.useState(false)
      const [updateModal, setUpdateModal] = React.useState(null)
      const [restartingAfterUpdate, setRestartingAfterUpdate] = React.useState(false)
      const tabsRef = React.useRef(null)

      const onUpdatePlugin = async () => {
        if (updating) return
        setUpdating(true)
        try {
          const res = await postJson(API.update, {})
          if (res && res.ok) {
            setUpdateModal(res)
          } else {
            alert(fill(t('updateFailed'), { error: res?.error || res?.message || 'Unknown error' }))
          }
        } catch (err) {
          alert(fill(t('updateFailed'), { error: err.message }))
        } finally {
          setUpdating(false)
        }
      }

      const onConfirmRestartAfterUpdate = async () => {
        setRestartingAfterUpdate(true)
        try {
          await postJson(`${API.runtime}/restart`, {})
          setTimeout(() => {
            window.location.reload()
          }, 3000)
        } catch {
          setTimeout(() => {
            window.location.reload()
          }, 3500)
        }
      }

      React.useEffect(() => {
        const controller = new AbortController()
        getJson(`${API.runtime}/state`, controller.signal)
          .then((payload) => {
            const running = payload.state?.runtime?.version
            if (typeof running === 'string' && running !== '') setVersion(running)
          })
          .catch(() => {})
        return () => controller.abort()
      }, [])

      const select = React.useCallback((next) => {
        setTab(next)
        try {
          window.localStorage.setItem(TAB_STORAGE_KEY, next)
        } catch {
          /* memory only */
        }
      }, [])

      const onTabKeyDown = (event) => {
        const index = TABS.indexOf(tab)
        const next =
          event.key === 'ArrowRight' ? (index + 1) % TABS.length
            : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
              : event.key === 'Home' ? 0
                : event.key === 'End' ? TABS.length - 1
                  : null
        if (next === null) return
        event.preventDefault()
        select(TABS[next])
        const buttons = tabsRef.current?.querySelectorAll('[role="tab"]')
        buttons?.[next]?.focus()
      }

      const tabIcon = (key) =>
        key === 'overview'
          ? h(OverviewIcon, { width: 14, height: 14 })
          : key === 'chats'
            ? h(ChatIcon, { width: 14, height: 14 })
            : key === 'runtime'
              ? h(PowerIcon, { width: 14, height: 14 })
              : key === 'sites'
                ? h(GlobeIcon, { width: 14, height: 14 })
                : h(RouteIcon, { width: 14, height: 14 })

      const label = (key) =>
        key === 'overview'
          ? t('tabOverview')
          : key === 'chats'
            ? t('tabChats')
            : key === 'runtime'
              ? t('tabRuntime')
              : key === 'sites'
                ? t('tabSites')
                : t('tabProxy')

      return h(
        'div',
        { className: 'yk-page', 'data-yukari-panel': PANEL_ID },
        h('style', { key: 'styles' }, styles),

        /* Top Brand Header */
        h(
          'header',
          { className: 'yk-head' },
          h(
            'div',
            { className: 'yk-headBrand' },
            h(
              'div',
              { className: 'yk-headLogo' },
              h(PanelIcon, { size: 38, active: true }),
            ),
            h(
              'div',
              { className: 'yk-headInfo' },
              h(
                'div',
                { className: 'yk-titleRow' },
                h('h1', { className: 'yk-title' }, t('title')),
              ),
              h('span', { className: 'yk-subtitle' }, t('subtitle')),
            ),
          ),
          h(
            'div',
            { className: 'yk-headBadges' },
            h(Chip, { kind: 'purple', dot: true }, 'Yukari v1.3.0'),
            version === null ? null : h(Chip, { kind: 'brand', dot: true }, `dsh ${version}`),
            h(
              'button',
              {
                type: 'button',
                className: 'yk-btn yk-btn-primary yk-btn-sm',
                disabled: updating,
                onClick: onUpdatePlugin,
                title: t('updatePlugin'),
                style: { borderRadius: '999px', fontSize: '12px', padding: '4px 12px', gap: '6px' },
              },
              updating ? h(Spinner) : h(DownloadIcon, { width: 13, height: 13 }),
              h('span', null, updating ? t('updatingPlugin') : t('updatePlugin')),
            ),
          ),
        ),

        /* Navigation Rail */
        h(
          'div',
          { className: 'yk-navBar', role: 'tablist', 'aria-label': t('title'), ref: tabsRef, onKeyDown: onTabKeyDown },
          TABS.map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                className: 'yk-navTab',
                id: `yukari-tab-${key}`,
                'aria-selected': key === tab ? 'true' : 'false',
                'aria-controls': `yukari-panel-${key}`,
                tabIndex: key === tab ? 0 : -1,
                onClick: () => select(key),
              },
              tabIcon(key),
              h('span', { className: 'yk-navTabLabel' }, label(key)),
            ),
          ),
        ),

        /* Active Tab Panel */
        h(
          'div',
          { className: 'yk-tabPanel', role: 'tabpanel', id: `yukari-panel-${tab}`, 'aria-labelledby': `yukari-tab-${tab}` },
          tab === 'overview'
            ? h(OverviewTab, { key: 'overview', t, onGo: select })
            : tab === 'chats'
              ? h(ChatsTab, { key: 'chats', t, ui })
              : tab === 'runtime'
                ? h(RuntimeTab, { key: 'runtime', t })
                : tab === 'sites'
                  ? h(SitesTab, { key: 'sites', t })
                  : h(ProxyTab, { key: 'proxy', t }),
        ),

        /* Secondary Confirmation Modal for Restart After Update */
        updateModal !== null
          ? h(
              'div',
              { className: 'yk-modalBackdrop', role: 'presentation' },
              h(
                'div',
                { className: 'yk-modalCard', role: 'alertdialog', 'aria-modal': 'true' },
                h(
                  'div',
                  { className: 'yk-modalTitle' },
                  h(CheckIcon, { width: 20, height: 20, style: { color: 'var(--dsw-alias-color-success, #22c55e)' } }),
                  t('updateSuccess'),
                ),
                h('p', { className: 'yk-modalDesc' }, t('updateRestartConfirm')),
                updateModal.message ? h('div', { className: 'yk-mono', style: { fontSize: '11px', opacity: 0.7, padding: '6px 10px', background: 'var(--dsw-alias-bg-layer-1, #111)', borderRadius: '6px', whiteSpace: 'pre-wrap' } }, updateModal.message) : null,
                h(
                  'div',
                  { className: 'yk-modalActions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yk-btn yk-btn-ghost',
                      disabled: restartingAfterUpdate,
                      onClick: () => setUpdateModal(null),
                    },
                    t('updateRestartLater'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'yk-btn yk-btn-primary',
                      disabled: restartingAfterUpdate,
                      onClick: onConfirmRestartAfterUpdate,
                    },
                    restartingAfterUpdate ? h(Spinner) : h(PowerIcon, { width: 14, height: 14 }),
                    h('span', null, restartingAfterUpdate ? t('rRestarting') : t('updateRestartNow')),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    const AVATAR_URL = 'https://s2.loli.net/2025/02/11/BPbRw7eNFh6AMuW.webp'

    /** Sidebar rail and brand avatar: webp image. */
    function PanelIcon({ size, active }) {
      const edge = size ?? 20
      return h('img', {
        src: AVATAR_URL,
        alt: 'Yukari',
        width: edge,
        height: edge,
        'aria-hidden': true,
        style: {
          width: `${edge}px`,
          height: `${edge}px`,
          borderRadius: edge > 24 ? 'var(--dsw-radius-md, 10px)' : '5px',
          objectFit: 'cover',
          display: 'block',
          opacity: active === false ? 0.78 : 1,
          transition: 'opacity 0.15s ease',
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
          openSession: (id) => {
            if (ctx.uiWorkspace === undefined || typeof ctx.uiWorkspace.openSession !== 'function') {
              throw new Error('uiWorkspace is unavailable')
            }
            ctx.uiWorkspace.openSession(id)
          },
        }
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) =>
              h(YukariPanel, { ...props, t, ui }),
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('title') },
              PanelIcon,
            ),
          ),
        )
      },
    }
  },
})
