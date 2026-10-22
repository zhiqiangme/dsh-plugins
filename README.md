# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，每个插件是一个独立的 npm 包：

| 插件 | npm 包 | 作用 |
| --- | --- | --- |
| [dsh-autostart-workbuddy](dsh-autostart-workbuddy/) | `@zhiqiangme/dsh-autostart-workbuddy` | DSH 启动时默认拉起 WorkBuddy2API Hub（127.0.0.1:7863），可切换 wb2api，可选接管 profile 里的 workbuddy 模型列表 |
| [dsh-magpie](dsh-magpie/) | `@zhiqiangme/dsh-magpie` | 管理 Magpie 模型清单：手工编辑、勾选、拖动排序，或从 Magpie 全量覆盖并立即同步到 DSH |
| [dsh-opencode2api](dsh-opencode2api/) | `@zhiqiangme/dsh-opencode2api` | **停止维护**，保留源码及单独安装入口；“全部”安装不再包含它 |
| [dsh-tavily-search](dsh-tavily-search/) | `@zhiqiangme/dsh-tavily-search` | 用 Tavily 给 DSH 的网页搜索供数：在 DSH 进程内同时提供旧版 Messages 与新版 Search API 的搜索接口（`127.0.0.1:8787`），插件页卡片里配 API Key、一键接入网页搜索 |

插件自身的行为与配置见各自目录下的 README。

## 从 npm 安装（推荐）

先**完全退出** DSH 桌面版（托盘图标里也要退出），然后在终端运行（`dsh` 命令随 DSH 桌面版一起安装）：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-autostart-workbuddy
dsh plugin --profile desktop add @zhiqiangme/dsh-magpie
dsh plugin --profile desktop add @zhiqiangme/dsh-tavily-search
```

重新打开 DSH 即生效，插件出现在「插件」页。可按需单独安装；装到 Web / CLI 就把 `desktop` 换成 `web` / `headless`。

更新与卸载：

```powershell
dsh plugin --profile desktop update --latest @zhiqiangme/dsh-autostart-workbuddy @zhiqiangme/dsh-magpie @zhiqiangme/dsh-tavily-search
dsh plugin --profile desktop remove @zhiqiangme/dsh-tavily-search
```

- 更新要带 `--latest`：版本号按日期编排，跨年时主版本号会变（`26.x` → `27.x`），不带它不会升过去。
- DSH 自带的 pnpm 对刚发布的版本有观察期（`minimumReleaseAge`）：首次 `add` 会自动把该版本列入例外，
  `update --latest` 或 `add 包名@latest` 可能暂时选到旧版。要安装刚发布的最新版，先用
  `npm view @zhiqiangme/dsh-tavily-search version` 查询，再使用明确版本，例如
  `dsh plugin --profile desktop add @zhiqiangme/dsh-tavily-search@26.10.18`（版本号换成查询结果）。
  Tavily 卡片的「按指定版本安装」也会生成可复制的完整规格，供 DSH「插件」页卸载后重新添加。
- 卸载不删 `cordis.patch.yml` 里的插件配置，重新安装后沿用。

## 从源码安装

双击仓库根目录的 `install-plugins.cmd`（Windows），按提示选（直接回车都是默认项）：

1. 操作：**安装 / 更新**（默认）、卸载、查看安装状态
2. 插件：**全部**（默认安装维护中的 WorkBuddy、Tavily Search、Magpie）、或单独选择；OpenCode API 已停止维护，仍可单独安装，卸载和查看状态时“全部”仍包含它
3. 装到哪个 DSH：**Desktop**（默认）、Web（`dsh web`）、CLI（`dsh headless`）、全部三个

完成后重启对应的 DSH 生效。也可以在终端里带参数一行跑完（参数都可省略，省略的会询问）：

```powershell
.\install-plugins.cmd --action install --plugins all --profiles desktop --yes
.\install-plugins.cmd --action install --plugins magpie --profiles desktop --yes
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
- Magpie 使用已运行的网关，不托管其进程。可离线手工编辑；点击「从 Magpie 同步」会全量覆盖当前清单，移除上游已关闭或删除的条目，并立即保存、更新 DSH。模型写入独立的 `dsh-magpie` provider。卸载前需要移除该分组时，先在卡片关闭同步并保存。
- Magpie 是新增包，npm 首次发布前请使用上述源码安装命令。

## 版本号

各插件独立发版，版本号用发布流水线的 UTC 日期 `年.月.日`（年取后两位，不补零）：2026-10-11 发布即 `26.10.11`。
git tag 带插件前缀，例如 `workbuddy-v26.10.11`、`tavily-search-v26.10.11`、`opencode2api-v26.10.15`。

同一插件每天最多发布一个正式版；npm 已发布的版本不能覆盖。版本必须严格递增，不能用
`26.10.16.1`（不是合法 SemVer）或 `26.10.16-1`（低于同号正式版）补发当天的正式版。

## CI 与自动发布

发布时修改对应插件目录下 `package.json` 的 `version`，连同代码提交到 `main`（或通过 PR 合入）。
[release.yml](.github/workflows/release.yml) 比较整个 push 前后的版本号，测试通过后仅发布版本增加的插件：

1. 在原始提交上打包，核对包名、版本、入口、图标、补丁、LICENSE 与文件清单。
2. 创建 `<插件前缀>-v<版本>` tag，固定源码提交。
3. 用 npm Trusted Publishing（OIDC）发布该 `.tgz` 为公开包，更新 npm 的 `latest`。
4. 核对 npm 包完整性后创建对应的正式 GitHub Release，记录提交、变更及安装 / 更新命令。

普通代码或文档提交不发布；添加本工作流也不会自动补发现有的 `26.10.16`。
PR 和 `main` 都会执行 [ci.yml](.github/workflows/ci.yml)：Node 22 / 24，Windows 测全部插件，
Linux 测 Tavily Search 和 Magpie，两种系统均测试仓库脚本。测试使用内置 runner 和宿主替身，不需要安装依赖、
DSH 桌面版或真实后端。opencode2api 的真实 exe 测试仍需 `OPENCODE2API_TEST_EXE`，默认跳过。

### 首次启用

先把工作流推送到 GitHub，再到以下维护中的 npm 包的 **Settings → Trusted publishing** 分别添加 GitHub Actions（新包需先完成 npm 包初始化）：

- `@zhiqiangme/dsh-autostart-workbuddy`
- `@zhiqiangme/dsh-magpie`
- `@zhiqiangme/dsh-tavily-search`

三个包填写相同信息：用户 `zhiqiangme`，仓库 `dsh-plugins`，工作流文件名 **`release.yml`**
（只填文件名），允许直接执行 **`npm publish`**。本工作流未使用 GitHub Environment，环境名称留空。
只授权 `npm stage publish` 会要求人工批准，不能完成这里的全自动发布。

CI 使用 GitHub 托管 runner、Node 24、npm ≥11.5.1，以及 `id-token: write` 和 `contents: write`。
**无需配置 `NPM_TOKEN` 或关闭 npm 二次验证**；包启用 “Require two-factor authentication and disallow tokens”
也支持 OIDC。新建的 Trusted Publisher 当前需在两天内完成首次发布，建议准备好新版本后再配置。
详见 [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)。

### 失败重跑与补发

优先在原 Actions 运行里选择 **Re-run failed jobs**。也可在 Actions → **CI and release** → **Run workflow**，
选择 `main`，填写插件和原始发布提交的完整 40 位 SHA；该提交必须属于 `main` 历史。
测试、打包和 tag 均使用原始 SHA，后续 main 上的改动不会混入旧版本。

- 已有 tag 必须指向同一个提交，不会自动移动或覆盖。
- npm 已有同版本时，只有 `.tgz` 完整性相同才跳过；内容冲突则停止。
- 发布确认及重跑防重发使用 npm 精确版本端点；发布后可累计等待约 10 分钟，每次核对显示进度，期间只读核对。
- npm 发布日志实时显示，命令最多等待 5 分钟；发布后精确版本仍未可见时，可按原始 SHA 重跑补齐 Release。
- npm 成功但 GitHub Release 失败，重跑会只补齐 Release，不重复发布或调整 npm `latest`。
- npm 查询、鉴权、限流或网络失败都会报错，只有 404 视为包尚不存在。
- 同一插件的发布串行执行，不取消已经开始的任务；若多次发版排队，GitHub 可能以新任务替换旧的待运行任务。
  需要每个中间版本都发布时，等上一版完成再提交下一版；补发尚未发布的旧版本会拒绝降低 npm 版本。

发布脚本位于 [scripts/release.mjs](scripts/release.mjs)，只依赖 Node、Git、npm；使用仓库自带测试验证发布决策与失败恢复，
测试过程不调用真实 npm / GitHub 发布接口。自动 tag 和 npm 发布在同一次工作流内完成，避免 `GITHUB_TOKEN`
创建 tag 后不会再触发 tag push 工作流的问题。每个包独立生成正式 Release，重跑保留已有 Release 的草案或正式状态，不设置整个仓库的 “Latest release”。

## 参与开发

各插件目录下 `node --test test/*.test.mjs` 跑测试（别写 `node --test test/`）。

各插件共用一个仓库，提交信息带范围前缀，`git log --oneline` 里一眼分得清是哪个插件在动：

```
新增(workbuddy)：插件页的模型勾选面板
修复(tavily-search)：…
文档(repo)：…
```

- **范围 = 改动涉及的插件**：`workbuddy` / `magpie` / `tavily-search`（旧 OpenCode 源码保留，停止维护）
- 只涉及仓库级文件（根 `README.md`、`install-plugins.cmd`、`scripts/`），或**同时**涉及多个插件时，用 `repo`
- 格式为 `类型(范围)：描述`，类型用 `新增 / 修复 / 文档 / 移除 / 调整 / 改进 / 测试`

## 许可

[MIT](LICENSE)
