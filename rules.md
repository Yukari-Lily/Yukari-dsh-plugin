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
- 提交标题：`type: vX.Y.Z — 一句中文说明`，type 用 `feat` / `fix` / `refactor` / `docs`。
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

## 四、怎样才算验证过

- 修 bug：先写能复现的用例，确认**去掉修复就会失败**，再留作回归测试。
- 纯逻辑和 HTTP 接口走 `test/*.test.mjs`（`node:test` + `node:assert/strict`）。
- 面板交互没法单测时，用无头 Chromium 跑真页面：把 `client.js` 里的真实 CSS / 逻辑抽出来执行，不要重抄一份再测。
- 涉及外部进程的（Chromium、git、pnpm）要真跑一遍并贴输出，不要只读代码下结论。
- 说"跑通了"之前把完整输出看完，别只看退出码；被截断的输出要翻到结尾。
- 一次性的验证脚本放 `/tmp`，不要塞进仓库；能留在仓库的只有回归测试。
