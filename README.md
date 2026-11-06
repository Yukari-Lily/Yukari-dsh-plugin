# Yukari 插件合集

DeepSeek Harness（dsh）自用插件合集。装好后侧边栏多一个「Yukari插件合集」面板，各组件可在「插件」页单独开关，关掉的组件会从面板里隐藏。代理、无限制模式、无头浏览器三行默认关闭：浏览器行没打开之前不会下载 Chrome 与运行库，代理行没打开之前不会起本地端口。

| 组件 | 默认 | 作用 |
|---|---|---|
| 主行 | 开 | 面板本体、插件自更新、重启 |
| 会话 | 开 | 按工作区浏览、归档、删除会话；子智能体会话默认折叠在主对话下，勾选主会话会连带勾选子会话；单条删除在行内确认，可连带删除该会话新建的文件 |
| 站点 | 开 | 静态网页一键发布到 `/p/<名字>/`，可在面板里设置自己的访问域名前缀 |
| 文件 | 开 | 浏览工作区全部文件；单文件下载、任意勾选文件夹打包下载；预览直接交给 DSH 自己的文件预览 |
| 约束 | 开 | 全局与工作区的强约束：`$DSH_HOME/rules.md` 与 `<工作区>/rules.md`，写进系统提示词首尾，面板内随时编辑、下一轮即生效；可从 AGENTS.md / CLAUDE.md 导入 |
| 预设 | 开 | 自定义智能体预设：新建时先选一个内置或自定义预设当模板，再改元数据、人格提示词与能力行；可改可删。内置预设只读，复制一份就能改 |
| 代理 | 关 | Shadowsocks 出站代理，支持一次导入多个节点（ss:// / 订阅 / Clash），选一个使用并测速 |
| Github | 开 | 持久化 GitHub 推送令牌：面板验证、检查仓库写权限、清除；写入 `~/.gitconfig` 的凭据助手后，任意会话里直接 `git push` |
| 无限制模式 | 关 | 额外注册一个对话模式：首段契约 + 尾部锚点 + 改写宿主劝退句 + 拒绝自动重试；标准模式不受影响 |
| 无头浏览器 | 关 | 给智能体用的 Chromium 浏览器工具（`browser_*`）；这一行打开后才开始准备 Chrome 与缺失的运行库 |
| 状态 | 开 | dsh 版本检查、更新与重启 |

## 安装

在 dsh 的「插件」页安装：

```
git+https://github.com/Yukari-Lily/Yukari-dsh-plugin.git
```

装好以后，要用的组件在「插件」页把对应行打开即可：代理、无限制模式、无头浏览器默认是关的，打开后面板里的标签页会出现，浏览器那行才会开始下载 Chrome 与运行库。

之后在面板右上角「检查更新」即可更新插件本身。插件更新装好后一律自动重启：宿主自己安排重启，页面显示「重启中」并在服务回来后自动刷新，不需要再点一次，也不会把你拽回插件页。

> v1.5.0 及更早版本的面板更新在 pnpm 10 以上会「假成功」（文件没变，重启后仍是旧版）。从这些版本升级请执行一次：
>
> ```
> docker exec -u 1000 dsh dsh plugin --profile web update yukari-dsh-plugin
> ```
>
> 然后重启 dsh。之后的版本会自己校验，不会再出现这种情况。

## 浏览器：装好即用

不需要预先安装 Chrome，也不需要 `unzip`：

- 插件挂载后会在后台解析官方 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 元数据，取**最新稳定版**中对应平台的归档，下载并解压到 `DSH_HOME/browser-runtime/`。
- 解压使用 Node 内置 `zlib` 实现，不依赖系统的 `unzip` / PowerShell，因此在精简容器里同样可用。
- 启动后若发现缺少系统运行库（精简镜像常见），会自动从 Debian 索引解析依赖、下载对应的 `.deb` 并解压到 `DSH_HOME/browser-runtime/sysroot`，通过 `LD_LIBRARY_PATH` 生效——**不需要 root**，也不改动宿主机文件。中文页面需要的 Noto CJK 字体会一并装上，否则截图里的中文是方框。
- 下载有 512 MB 与超时上限，先解压到临时目录、校验可执行文件后再原子改名，失败不会留下半个浏览器。
- 所有 `browser_*` 工具与面板「浏览器」页共用同一个安装 Promise：并发调用只会下载一次，失败后可在面板里重试。
- 装好会做一次 `--version` 启动自检。自动补齐失败时，面板会列出**全部**缺失的库，并给出一条可直接粘贴的 `apt-get install` 命令作为兜底（在容器内以 root 执行一次）。已经装过库、只想用系统里的库时，把目录填进 `libraryPath` 并设 `autoLibraries: false` 即可。
- 想用系统自己的浏览器：设置行配置 `executablePath`，或导出 `DSH_BROWSER_EXECUTABLE`。

安全默认值：

- `sandbox` 默认 `auto`：普通主机保持 Chromium 沙箱；仅在 root 或容器（无用户命名空间）环境自动加 `--no-sandbox`，并在面板标明原因。需要强制开启/关闭时填 `true` / `false`。
- `file:` / `data:` 页面默认禁止，需要时设置 `allowLocalUrls: true`。
- 截图只能写进 `screenshotDir`；需要任意路径时设置 `allowAnyScreenshotPath: true`。

## 文件与下载

面板「文件」页按工作区浏览，目录可逐层进入：

- 下载方式跟着选择走：只勾文件时逐个直接下载；勾到任何文件夹（或文件超过 10 个）时，在服务端现做一份 ZIP（流式写入，不落临时文件）。
- 路径只能落在注册的工作区根目录内：绝对路径、`..`、指向外部的符号链接都会被拒绝；符号链接不会被打进压缩包。
- 点文件名（或「预览」）调用的是 DSH 自己的预览：`sidebarRight.openResourceIn()` 打开 `dsh-resource://file/session/<会话>/<路径>`，文本、Markdown、代码、图片、PDF、Office 都由 DSH 按类型选择渲染器。预览需要一个属于该工作区的会话作为锚点；没有会话时只保留下载。

## 智能体预设（自定义）

面板「预设」页管理 DSH 设置 →「智能体预设」里那个**自定义**分组。新建的预设由本插件注册并保存在 `$DSH_HOME/yukari-presets.json`，重启后仍在；不需要改 profile 的 patch。

新建的流程是「先选模板，再改」：

1. 点「新建预设」，从列表里挑一个**内置或自定义预设**当模板（内置的四个、`cordis.patch.yml` 里声明的、以及别的插件在运行时注册的都在里面），也可以选「空白组合」。
2. 新预设立刻复制模板的完整组合——工具、人格提示词、分组结构全在里面；名称预填「xx 副本」，标识预填 `<id>-copy`。
3. 改名称、描述、排序；改人格提示词（`@deepseek-ai/dsh-persona` 的 prefix / suffix）；逐行启用、停用、移除；「从预设导入」可以把另一个预设的行追加进来；「自定义行」加任意插件行。
4. 分组、`isolate` 这类结构在「高级：组合 JSON」里整段改。
5. 保存后马上出现在设置页与新建会话的预设选择器里，不用刷新页面；新会话用新组合，正在运行的会话保留旧组合。

来源不同，能做的事也不同：

| 来源 | 在哪 | 改动 | 删除 |
|---|---|---|---|
| 我的 | `$DSH_HOME/yukari-presets.json` | 面板内重新注册 | 可以（是当前默认预设时先切默认） |
| 声明式 | profile 的 `cordis.patch.yml` 里 `@deepseek-ai/dsh-agent-preset` 行 | 通过 configEditor 写入一条覆盖，原声明保留 | 不行，面板只显示它的行 id |
| 内置 | standard / ptc / minimal / cordis | 只读 | 不行 |
| 运行时 | 别的插件 `register()` 的（如「无限制模式」） | 只读 | 不行 |

- 「无限制模式」这类运行时预设能被当模板，是因为它的属主把定义写成了 `$DSH_HOME/.agent-presets/<id>/preset.json`；没有这份文件的运行时预设只能看 YAML 组合。
- 模板里的 `platform: win32 / non-win32` 标记会在复制时按当前平台固化成 `disabled`，`!!js` 表达式原样保留。
- 保存**不**校验组合能不能跑起来：组合里的包名写错时，预设照常出现，但选中它会加载失败（面板会标「注册冲突」并在 DSH 设置页显示原因）。
- **停用这个组件行之前，先到 DSH 设置 →「智能体预设」把默认预设切回内置模式**，否则新会话会解析不到默认预设。

## 强约束（全局 / 工作区）

面板「约束」页把两份文件写进系统提示词的首段（order -950）和尾部重申（order 10400）。所以它比工具说明、工作区指引、角色设定和风格要求更优先，也不会在长对话或压缩之后漂移。

| 范围 | 文件 | 生效对象 |
|---|---|---|
| 全局 | `$DSH_HOME/rules.md` | 所有会话，含子智能体 |
| 工作区 | `<工作区>/rules.md` | cwd 落在该工作区内的会话 |

- 保存后**下一轮对话立即生效**：每次装配按 `mtime:size` 对账，不需要重启或重开会话；用外部编辑器改同一个文件也一样。
- 工作区文件就是普通文件，可以提交进仓库。分会话按注册工作区的 `sessionIds` 匹配，其次按 cwd 最长祖先；未注册的目录按 `.git` 上溯，再退回 cwd。
- 面板只列出注册过的工作区；未注册的目录照样会注入，直接把 `rules.md` 放在那个目录根下用编辑器改也会生效。
- 两份都为空时完全不注入。单份默认上限 16 KB（行配置 `maxBytes`，最大 120 KB），超出部分按 UTF-8 边界截断并在提示词里标注。
- 「尾部重申」会把同一份正文在最后再放一遍，长上下文里更稳，代价是约多一倍 token；面板上的 chip 可以随时关掉。全局 / 工作区两个开关同理。
- 「导入 AGENTS.md」只读取、不写入：工作区按 `AGENTS.md → CLAUDE.md → AGENTS.local.md → CLAUDE.local.md`，全局按 `$DSH_HOME/AGENTS.md → $DSH_AGENTS_HOME/AGENTS.md`。导入后还要点保存。
- 它和 DSH 自带的 `AGENTS.md` 指引不是一回事：后者是 `<system-reminder>` 用户消息、只作 guidance、按预设挂载、全局链和项目链各 64 KiB；本组件用独立文件，避免同一份内容进两次上下文。要迁移旧文件就用「导入」。
- 「自检注入」现场装配一次当前会话，回报首段 / 尾部是否命中、解析到的工作区与字节数，并且不改动统计。
- 三个开关存在 `$DSH_HOME/rules-settings.json`（原子写、0600）。约束不改变审批与沙箱权限，也不覆盖 plan mode 等模式设置；`rules.md` 是符号链接或指向工作区外时拒绝写入。

## Github

面板「Github」页粘贴一枚 fine-grained PAT，之后在任何会话里直接 `git push` / `git fetch`：

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。
2. Repository access 选 **Only select repositories**，勾选要推送的仓库；Repository permissions → **Contents: Read and write**（Metadata 保持 Read）。
3. 复制 `github_pat_…`，粘贴到面板「Github」页，点「保存并验证」。面板会显示账号、令牌类型和有效期，还可以填 `owner/repo` 检查这枚令牌有没有写权限。

插件把令牌保存到 `$DSH_HOME/yukari-github/token`（0600，目录 0700），在 `~/.gitconfig` 里加一条 include，安装一个只对 `https://github.com` 生效的 credential helper。Host 重启、插件更新、容器重建后都会自动重新挂上，**不需要重输**；helper 只把凭据交给 `github.com`，不会碰其他 host。

测试：保存后先跑 `git push --dry-run`；通过后再真正 push。清除令牌后 include 和令牌文件会一起删掉，智能体不能再推送。关闭组件行只会移除 include，令牌文件仍留在 DSH_HOME；要彻底撤销请用「清除令牌」。

安全边界（重要）：

- 为了实现「重启免重输 + 裸 git push」，令牌必须落盘并对 git 可用；**同一容器的进程（包括智能体的 bash 和 DSH 的文件读取）可以读取这个 0600 文件**。这是本方案的固有限制，不是插件遗漏。
- 插件不会把令牌放进面板/API 返回、日志、错误消息、remote URL、helper 脚本或 git 配置；helper 会校验请求的 `protocol=https` 和 `host=github.com`，其他 host 一律拒绝。插件也不记录请求头；如果你的反向代理会记录请求头，请把 `X-Yukari-Github-Token` 排除。
- 请使用 fine-grained PAT、只勾必要仓库、Contents: Read and write、较短有效期；不用时在面板点「清除令牌」。Classic PAT 的 `repo` 权限覆盖整个账号，面板会提示。
- 不要把令牌发到对话里；对话内容会进入模型上下文。
- 令牌文件也会进入 `DSH_HOME` 的备份；备份、其他挂载该卷的容器同样能读。需要更强隔离时，不要在这个容器里放长期令牌。
- 只处理 HTTPS remote；`git@github.com:...` 仍走 SSH key。插件不修改 git 提交身份。

## 说明

- 「删除会话新建的文件」只删除由 `write` / `str_replace_editor` 新建、仍在工作区内、且在会话开始后才出现的文件；命令行生成的文件不会被追踪。
- 正在使用中的会话不能删除（内存里还有实例，删掉磁盘文件只会让它下一轮写入失败）。切到别的会话或重启 Host 后再删即可。
- 站点发布拒绝任何符号链接，并限制单站点文件数与体积（`maxFiles` / `maxMb`），失败会回滚到上一个版本。
- 站点访问前缀填你对外可访问的地址，例如 `https://pages.example.com` 或 `https://dsh.example.com/p`，链接 = 前缀 + `/名字/`。
- 代理节点和密码保存在 `DSH_HOME/ss-proxy.json`（权限 0600），重启后自动恢复。
- 无限制模式分四层：首段写契约（优先级、R1–R6 拒绝形态、格式契约、占位符归一、工具拒绝的处理），尾部锚点（order 10250，排在宿主所有段落之后）负责长上下文里不漂移，`system-prompt/assemble` 与 `assemble()` 两条缝改写宿主的劝退句（含 `bash`/`pwsh` 工具描述），`llm/stream` 在模型仍然拒绝时丢弃这次输出、追加收尾指令重发一次。
- 锚点、拒绝重试、劝退句改写各有一个开关，默认全开；可在面板「无限制模式」页点 chip 切换，存在 `DSH_HOME/yukari-purge-settings.json`（原子写、0600）。提示词本身保存在 `DSH_HOME/yukari-purge-prompt.md`。
- 面板上的「自检注入」会现场调用一次 `assemble()`，返回这次装配是否真的带上了注入与锚点——不用靠猜；下面的统计（注入次数 / 改写条数 / 重试次数）随运行累计，重启清零。
- 不改宿主安装目录里的任何文件，也不改会话权限：写到工作区之外或需要审批的操作仍会弹审批卡，模式只要求模型带着 `sandbox_permissions` 重试一次、再换路径，而不是掉头说"我不能"。
- 预设定义以 `preset.json` 为唯一来源，`agent.cordis.yml` 的工具集由测试保证一致。

## 开发

```
node --test test/*.test.mjs
```
