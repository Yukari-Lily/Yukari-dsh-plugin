# 本项目规则

本文件和 `$DSH_HOME/rules.md` 一起被注入系统提示词首尾。这里写的是**操作者的习惯**和**这个仓库已有的规范**，由操作者维护；除非他明确要求，不要改这个文件。

## 一、怎么跟我说话

- 用中文，说人话。必须出现的术语要能一句话解释清楚，不堆词、不客套、不写"总之"式的总结。
- 结论先行：两三句讲清"原来错在哪、现在怎么改"，细节放后面再展开。
- 报证据，不报感觉。贴实测输出、命令、数字、sha1、退出码。"应该没问题""理论上可以"不算结论。
- 少反问。只有会改变结果、不可逆、或者要重启 Host 时才问一句；其余自己定，并在回复里说明决定了什么。
- 修就修根因。不要用兜底、静默重试、吞异常把问题盖过去；宁可报错报得难看，也要让人看得见。
- 不要过度设计。能一行不写三行；"以后可能要用"的抽象一律不做；不加没必要的依赖、配置项和开关。

## 二、改动流程

- 一次改动一个提交，`package.json` 的版本号加一（仅面板文案也算发版）。
- 提交标题：`type: vX.Y.Z — short English summary`，type 用 `feat` / `fix` / `refactor` / `docs`；标题一律英文、一句话、能多短就多短。正文可以中文。
- 提交正文写清三件事：原来是什么问题、现在怎么改、怎么验证的。
- 提交前 `node --test test/*.test.mjs` 必须全绿。仓库**没有** `npm test`，别写它。
- 改完只**提交并推送**（凭据助手已就位，这是已授权的），到此为止；然后提醒"重启后生效"。
- **不要碰本地的 profile 安装**（`/data/.dsh/profiles/web`）：不跑 `pnpm add` / `pnpm update`、不改 `node_modules`。安装什么时候更新由我决定，需要时我会说。
- 没重启就不要说"已生效"。当前进程跑的是上一次加载的那份代码。
- 写工作区之外（`$DSH_HOME`、profile）会弹提权，能不改就不改；确实要改，先说清为什么、改了什么。

## 三、代码规范

- ESM、单引号、不加分号、2 空格缩进；文件开头一段 JSDoc 说明这个模块负责什么。
- 运行时依赖只有 `undici`。要加别的，先说明为什么非它不可。
- 组件结构：`host/<name>/index.js` 导出 `apply(ctx, config)`；实现放 `host/<name>/lib/*`；文案放 `host/<name>/locale/*.json`。
- 每个组件都要 `markMounted(ctx, '<name>', details)`，面板总览靠它列组件。
- HTTP 接口一律过 `host/shared/http.js` 的 `guardRoute`，前缀 `/<name>/api`。错误码规则：显式 `error.status` 优先，其次带 `code` 的算 500，其余 400。
- 跨组件共用的东西放 `host/shared/`（`http`、`home`、`mounted`、`migrate`），组件之间不要互相 import。
- 状态文件放 `$DSH_HOME`，用普通名字，**不加 `yukari-` 前缀**（`github/`、`purge-settings.json`、`browser-runtime/`）。
- 改状态文件名必须带一次性迁移：用 `host/shared/migrate.js` 的 `migratePath`，只搬不删、不覆盖；旧文件还在就继续读旧的。
- 既有固定命名别动：bundle 行 id（`yukari-*`）、面板服务前缀（`/yukari/api`）、DOM 前缀（`yk-`）。
- 面板只有一个文件 `client.js`，没有构建步骤：用 `window.__ModuleLoader__` 注册，文案用文件内的内联 `zh` / `en` 字典，经 `ctx.locale.register` 注册。
- 颜色、圆角、间距只用宿主 token（`--dsw-alias-*`、`--dsw-radius-*`）。不确定名字就去 dsh 的安装目录里 grep，**不要猜**——`--dsw-alias-state-warning-primary` 就不存在，正确的是 `--dsw-alias-state-warn-primary`。
- 注释写"为什么"，不写"做了什么"；中文。
- 这个仓库是公开的：代码、注释、测试、文案、提交信息里都不要出现操作者的域名、服务器 IP、
  令牌、密码、邮箱。示例一律用 `example.com`、`1.2.3.4`、`127.0.0.1`、`owner/repo` 这类占位。

## 四、怎样才算验证过

- 修 bug：先写能复现的用例，确认**去掉修复就会失败**，再留作回归测试。
- 纯逻辑和 HTTP 接口走 `test/*.test.mjs`（`node:test` + `node:assert/strict`）。
- 面板交互没法单测时，用无头 Chromium 跑真页面：把 `client.js` 里的真实 CSS / 逻辑抽出来执行，不要重抄一份再测。
- 涉及外部进程的（Chromium、git、pnpm）要真跑一遍并贴输出，不要只读代码下结论。
- 说"跑通了"之前把完整输出看完，别只看退出码；被截断的输出要翻到结尾。
- 一次性的验证脚本放 `/tmp`，不要塞进仓库；能留在仓库的只有回归测试。
- 不要直接访问操作者的部署入口（面板 GUI 的域名/端口）去测试或抓页面：挡回来是正常的，
  也不该拿线上站点做试验。要验浏览器行为就本地造页面，在无头 Chromium 里跑。

## 五、面板长相

样式全在 `client.js` 的 `styles` 模板串里，类名 `yk-` 前缀；没有 CSS 文件、没有构建。改完在浅色和深色（`body[data-ds-dark-theme]`）下都看一眼。

- 刻度只用这些值，别造半档：
  - 控件高度：输入框 / 搜索框 / 下拉 / 分段控件 34，按钮 32，小按钮 28，图标按钮 32（小号 28），标签 21，导航标签 36。
  - 字号：11 元信息、12 提示与脚注、13 正文与小按钮、14 正文与卡片标题、15 列表标题、16 子页标题、18 页面标题。
  - 间距：2 / 4 / 6 / 8 / 10 / 12 / 16 / 20。页面内边距 `0 clamp(16px, 3vw, 36px) 40px`，区块间距 20，内容最宽 980。树形缩进 22 / 26、空态留白 48 是结构值，别改；复选框和文字的 1–3px 基线微调不算间距。
  - 圆角：`--dsw-radius-sm` 小控件、`--dsw-radius-md` 按钮和输入框、`--dsw-radius-lg` 卡片。
- 颜色只取宿主 token；面板自己的派生值集中在 `.yk-page` 上的 `--yk-line` / `--yk-soft` / `--yk-muted` / `--yk-accent`，别在别处再造颜色。
- 边框一律 hairline `.5px`：输入、搜索、下拉用 `--dsw-alias-border-l4`，卡片和容器用 `--yk-line`（= `border-l2`）。不要 1px 实线，比宿主自己的控件重一档。
- 焦点环、过渡都用宿主 token：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`，`transition: … var(--ds-transition-duration) var(--ds-ease-in-out)`。
- 复选框是 16px + `--dsw-radius-xs`（方角）：`--dsw-radius-sm` 在 16px 盒子上就是个圆点，看着像单选。
- 按钮底色用 `--dsw-alias-button-primary-fill/hover`（主操作）。`--dsw-alias-button-tool-bar-fill` 是 50% 灰，只在灰色工具栏里用；白底面板上白色 + hairline 边框更轻。
- 浅色里"看着还行"不算数：`--dsw-alias-bg-layer-2/3` 在浅色主题和白底同色，浮层要么用 layer-3 打底加 `--dsw-shadow-lv3`，要么用 `--dsw-specific-menu`（它半透明，别压在文字上）。
- 破坏性只用一个来源 `--dsw-alias-state-error-primary`，底色 `color-mix(..., 6~10%, transparent)`，不要另写红。
- 每个区块最多一个主操作：`yk-btn-solid` 主、`yk-btn` 普通、`yk-btn-ghost` 取消和轻操作、`yk-btn-danger` 会丢东西。行内二次确认只把文字变红（`yk-dangerText`），不弹窗、不加框、不把别的行挤动。
- 图标按钮固定 `yk-btn yk-btn-ghost yk-iconBtn`，必须带 `title` 和 `aria-label`。
- 文字层级：`.yk-cardText` 段落说明（13，句号结尾）、`.yk-cardHint` / `.yk-cardNote` 12 补充、`.yk-itemMeta` 11 元信息、`.yk-foot` 12 脚注、`.yk-chip` 11 标签。说明句带「。」，短标签不带。
- 每个标签页走同一条骨架：`yk-body`（或 `yk-tabPanel`）→ `yk-toolbar`（筛选在左、`yk-grow` 撑开、操作在右）→ `Failure`（带重试）→ `Loading` / `Empty` / 列表或卡片。新页面照这个顺序写，不另造一套。
- 先挑现成组件：`Card`、`Row`、`Banner`、`Empty`、`Loading`、`Option`、`Segmented`、`SearchBox`、`RefreshButton`、`Chip`、`ConfirmStrip`、`FlashNote`。
- 行内 `style` 只留给随数据变的尺寸（进度条、logo 边长），静态尺寸进样式表——`test/ui-structure.test.mjs` 会挡。
