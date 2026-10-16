# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，每个插件是一个独立的 npm 包：

| 插件 | npm 包 | 作用 |
| --- | --- | --- |
| [dsh-autostart-workbuddy](dsh-autostart-workbuddy/) | `@zhiqiangme/dsh-autostart-workbuddy` | DSH 启动时自动拉起 WorkBuddy Panel（`wb2api.exe`, 127.0.0.1:7863），可选接管 profile 里的 workbuddy 模型列表 |
| [dsh-opencode2api](dsh-opencode2api/) | `@zhiqiangme/dsh-opencode2api` | 自动启动 opencode2api，管理后端安装更新、模型同步与 WebUI |
| [dsh-tavily-search](dsh-tavily-search/) | `@zhiqiangme/dsh-tavily-search` | 用 Tavily 给 DSH 的网页搜索供数：在 DSH 进程内提供 `127.0.0.1:8787/v1` 搜索接口，插件页卡片里配 API Key、一键接入网页搜索 |

插件自身的行为与配置见各自目录下的 README。

## 从 npm 安装（推荐）

先**完全退出** DSH 桌面版（托盘图标里也要退出），然后在终端运行（`dsh` 命令随 DSH 桌面版一起安装）：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-autostart-workbuddy
dsh plugin --profile desktop add @zhiqiangme/dsh-opencode2api
dsh plugin --profile desktop add @zhiqiangme/dsh-tavily-search
```

重新打开 DSH 即生效，插件出现在「插件」页。可按需单独安装；装到 Web / CLI 就把 `desktop` 换成 `web` / `headless`。

更新与卸载：

```powershell
dsh plugin --profile desktop update --latest @zhiqiangme/dsh-autostart-workbuddy @zhiqiangme/dsh-opencode2api @zhiqiangme/dsh-tavily-search
dsh plugin --profile desktop remove @zhiqiangme/dsh-tavily-search
```

- 更新要带 `--latest`：版本号按日期编排，跨年时主版本号会变（`26.x` → `27.x`），不带它不会升过去。
- DSH 自带的 pnpm 对刚发布的版本有观察期（`minimumReleaseAge`）：首次 `add` 会自动把该版本列入例外，
  `update` 可能要等新版本发布一段时间后才拿得到。
- 卸载不删 `cordis.patch.yml` 里的插件配置，重新安装后沿用。

## 从源码安装

双击仓库根目录的 `install-plugins.cmd`（Windows），按提示选（直接回车都是默认项）：

1. 操作：**安装 / 更新**（默认）、卸载、查看安装状态
2. 插件：**全部**（默认）、`dsh-autostart-workbuddy`、`dsh-opencode2api`、`dsh-tavily-search`
3. 装到哪个 DSH：**Desktop**（默认）、Web（`dsh web`）、CLI（`dsh headless`）、全部三个

完成后重启对应的 DSH 生效。也可以在终端里带参数一行跑完（参数都可省略，省略的会询问）：

```powershell
.\install-plugins.cmd --action install --plugins all --profiles desktop --yes
.\install-plugins.cmd --action install --plugins opencode2api --profiles desktop --yes
.\install-plugins.cmd --action status --profiles desktop,web,cli
.\install-plugins.cmd --help
```

要点：

- 实际执行的是 DSH 自带的 `dsh plugin --profile <名> add|remove`：它在 profile 锁内用 DSH 自带的 pnpm 安装，
  同时维护 profile `package.json` 的 dependencies 和 `dsh.profile.bundles`，还会做插件兼容性检查。
  `dsh.cmd` 从 PATH 或默认安装位置找，也可以用环境变量 `DSH_CLI` 指定；profile 目录跟 DSH 一致：
  `DSH_HOME`（默认 `~/.dsh`）下的 `profiles\<名>`。
- **不需要另装 Node.js**：`install-plugins.cmd` 用 DSH 安装包自带的 `node.exe` 执行
  [scripts/install-plugins.mjs](scripts/install-plugins.mjs)；找不到时依次退回 `%DSH_HOME%\dsh-runtimes` 下的副本、系统 `node`。
- **更新**：源码以 `file:` 依赖**拷贝**进 profile，改了源码后再 `add`（包括 `--force`）pnpm 都认为"已是最新"。
  脚本先比对 profile 里那份拷贝和仓库的文件哈希，不一致才"先移除再添加"，一致就不动。
  移除只动 profile 的 `package.json`，插件在 `cordis.patch.yml` 里的配置（如模型白名单）原样保留。
- 在 DSH 插件管理里**停用**过的插件，再选"安装"会重新启用。
- 改 desktop profile 前要**完全退出桌面版**（DSH 自己的要求）；脚本检测到对应 profile 的 DSH 进程在跑会停下等你关掉，
  也可以跳过这个 profile。desktop profile 需要先打开过一次桌面版才存在；web / CLI 的 profile 第一次安装时自动创建。
- 卸载不删 `cordis.patch.yml` 里的配置，也不删各插件自管的后端数据（如 `~/.dsh/autostart-workbuddy`、`~/.dsh/autostart-opencode2api`）。
  workbuddy 与 opencode2api 的卡片有「清除后端数据」按钮，卸载前点一下即可删掉各自的数据目录；
  tavily-search 的卡片有「清除插件数据」，删掉保存的 API Key 并把网页搜索接口恢复默认。

## 版本号

各插件独立发版，版本号用发布日期 `年.月.日`（年取后两位，不补零）：2026-10-11 发布即 `26.10.11`。
git tag 带插件前缀，例如 `workbuddy-v26.10.11`、`tavily-search-v26.10.11`、`opencode2api-v26.10.15`。

## 参与开发

各插件目录下 `node --test test/*.test.mjs` 跑测试（别写 `node --test test/`）。

各插件共用一个仓库，提交信息带范围前缀，`git log --oneline` 里一眼分得清是哪个插件在动：

```
新增(workbuddy)：插件页的模型勾选面板
修复(tavily-search)：…
文档(repo)：…
```

- **范围 = 改动涉及的插件**：`workbuddy` / `opencode2api` / `tavily-search`
- 只涉及仓库级文件（根 `README.md`、`install-plugins.cmd`、`scripts/`），或**同时**涉及多个插件时，用 `repo`
- 格式为 `类型(范围)：描述`，类型用 `新增 / 修复 / 文档 / 移除 / 调整 / 改进 / 测试`

## 许可

[MIT](LICENSE)
