# Yukari 插件合集

DeepSeek Harness（dsh）自用插件合集。装好后侧边栏多一个「Yukari插件合集」面板，各组件可在「插件」页单独开关，关掉的组件会从面板里隐藏。

| 组件 | 作用 |
|---|---|
| 会话 | 按工作区浏览、归档、删除会话；子智能体会话默认折叠在主对话下，勾选主会话会连带勾选子会话；单条删除在行内确认，可连带删除该会话新建的文件 |
| 站点 | 静态网页一键发布到 `/p/<名字>/`，可在面板里设置自己的访问域名前缀 |
| 文件 | 浏览工作区全部文件；单文件下载、任意勾选文件夹打包下载；预览直接交给 DSH 自己的文件预览 |
| 代理 | Shadowsocks 出站代理，支持一次导入多个节点（ss:// / 订阅 / Clash），选一个使用并测速 |
| 无限制模式 | 额外注册一个对话模式，选中时注入自定义提示词；标准模式不受影响 |
| 无头浏览器 | 给智能体用的 Chromium 浏览器工具（`browser_*`），首次使用时自动准备 |
| 状态 | dsh 版本检查、更新与重启 |

## 安装

在 dsh 的「插件」页安装：

```
git+https://github.com/Yukari-Lily/Yukari-dsh-plugin.git
```

之后在面板右上角「检查更新」即可更新插件本身。默认勾选「装好自动重启」：更新装好后由宿主直接安排重启，页面会停在插件页并自动回到原标签，不用再手动点一次。

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

## 说明

- 「删除会话新建的文件」只删除由 `write` / `str_replace_editor` 新建、仍在工作区内、且在会话开始后才出现的文件；命令行生成的文件不会被追踪。
- 正在使用中的会话不能删除（内存里还有实例，删掉磁盘文件只会让它下一轮写入失败）。切到别的会话或重启 Host 后再删即可。
- 站点发布拒绝任何符号链接，并限制单站点文件数与体积（`maxFiles` / `maxMb`），失败会回滚到上一个版本。
- 站点访问前缀填你对外可访问的地址，例如 `https://pages.example.com` 或 `https://dsh.example.com/p`，链接 = 前缀 + `/名字/`。
- 代理节点和密码保存在 `DSH_HOME/ss-proxy.json`（权限 0600），重启后自动恢复。
- 无限制模式的提示词可在面板里修改，保存在 `DSH_HOME/yukari-purge-prompt.md`；预设定义以 `preset.json` 为唯一来源，`agent.cordis.yml` 的工具集由测试保证一致。

## 开发

```
node --test test/*.test.mjs
```
