# Yukari 插件合集

DeepSeek Harness（dsh）自用插件合集。装好后侧边栏多一个「Yukari插件合集」面板，各组件可在「插件」页单独开关，关掉的组件会从面板里隐藏。

| 组件 | 作用 |
|---|---|
| 会话 | 按工作区浏览、归档、批量删除会话；可连带删除会话新建的文件或整个工作区目录 |
| 站点 | 静态网页一键发布到 `/p/<名字>/`，可在面板里设置自己的访问域名前缀 |
| 代理 | Shadowsocks 出站代理，支持一次导入多个节点（ss:// / 订阅 / Clash），选一个使用并测速 |
| 无限制模式 | 额外注册一个对话模式，选中时注入自定义提示词；标准模式不受影响 |
| 无头浏览器 | 给智能体用的 Chromium 浏览器工具（`browser_*`） |
| 状态 | dsh 版本检查、更新与重启 |

## 安装

在 dsh 的「插件」页安装：

```
git+https://github.com/Yukari-Lily/Yukari-dsh-plugin.git
```

之后在面板右上角「检查更新」即可更新插件本身，更新后点「立即重启」生效。

> v1.5.0 及更早版本的面板更新在 pnpm 10 以上会「假成功」（文件没变，重启后仍是旧版）。从这些版本升级请执行一次：
>
> ```
> docker exec -u 1000 dsh dsh plugin --profile web update yukari-dsh-plugin
> ```
>
> 然后重启 dsh。之后的版本会自己校验，不会再出现这种情况。

## 说明

- 「删除会话新建的文件」只删除由 `write` / `str_replace_editor` 新建、仍在工作区内、且在会话开始后才出现的文件；命令行生成的文件不会被追踪。
- 站点访问前缀填你对外可访问的地址，例如 `https://pages.example.com` 或 `https://dsh.example.com/p`，链接 = 前缀 + `/名字/`。
- 代理节点和密码保存在 `DSH_HOME/ss-proxy.json`（权限 0600），重启后自动恢复。
- 无限制模式的提示词可在面板里修改，保存在 `DSH_HOME/yukari-purge-prompt.md`。

## 开发

```
node --test test/*.test.mjs
```
