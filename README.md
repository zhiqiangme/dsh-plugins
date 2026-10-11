# DeepSeek Harness 本地插件仓库

本仓库存放两个 DSH 插件，以及把它们安装进 DSH profile 的脚本。

## 目录

| 路径 | 说明 |
| --- | --- |
| [dsh-autostart-workbuddy/](dsh-autostart-workbuddy/) | DSH 启动时自动拉起 WorkBuddy Panel（`wb2api.exe`, 127.0.0.1:7863），可选接管 profile 里的 workbuddy 模型列表 |
| [dsh-tavily-search/](dsh-tavily-search/) | 用 Tavily 给 DSH 的网页搜索供数：在 DSH 进程内提供 `127.0.0.1:8787/v1` 搜索接口，插件页卡片里配 API Key、一键接入网页搜索（原名 `dsh-autostart-websearch`） |
| [install-plugins.cmd](install-plugins.cmd) | 双击运行的安装入口，调用下面的 PowerShell 脚本 |
| [scripts/install-plugins.ps1](scripts/install-plugins.ps1) | 把上面两个插件安装 / 更新 / 卸载到 DSH 的 profile，或查看安装状态 |

## 安装插件

双击仓库根目录的 `install-plugins.cmd`，按提示选（直接回车都是默认项）：

1. 操作：**安装 / 更新**（默认）、卸载、查看安装状态
2. 插件：**全部**（默认）、`dsh-autostart-workbuddy`、`dsh-tavily-search`
3. 装到哪个 DSH：**Desktop**（默认）、Web（`dsh web`）、CLI（`dsh headless`）、全部三个

完成后重启对应的 DSH 生效。也可以在终端里带参数一行跑完（参数都可省略，省略的会询问）：

```powershell
.\install-plugins.cmd -Action install -Plugins all -Profiles desktop -Yes
.\install-plugins.cmd -Action status -Profiles desktop,web,cli
```

要点：

- 实际执行的是 DSH 自带的 `dsh plugin --profile <名> add|remove`：它在 profile 锁内用 DSH 自带的 pnpm 安装，
  同时维护 `package.json` 的 dependencies 和 `dsh.profile.bundles`，还会做插件兼容性检查。
  所以脚本不手改 `package.json`，也**不需要系统装 Node**；`dsh.cmd` 从 PATH 或默认安装位置找，
  也可以用环境变量 `DSH_CLI` 指定。profile 目录跟 DSH 一致：`DSH_HOME`（默认 `~/.dsh`）下的 `profiles\<名>`。
- **更新**：插件以 `file:` 依赖拷贝进 profile，改了源码后再 `add`（包括 `--force`）pnpm 都认为"已是最新"。
  所以脚本先比对 profile 里那份拷贝和仓库的文件哈希，不一致才"先移除再添加"，一致就不动。
  移除只动 `package.json`，插件在 `cordis.patch.yml` 里的配置行（如模型白名单）原样保留；
  重新添加后插件排到 bundles 末尾（两个插件都只插入自己的配置行，顺序不影响行为）。
- 在 DSH 插件管理里**停用**过的插件，再选"安装"会重新启用（`pnpm add` 本身不会把它放回 bundles）。
- 改 desktop profile 前要**完全退出桌面版**（DSH 自己的要求）；脚本检测到对应 profile 的 DSH 进程在跑会停下等你关掉，
  也可以跳过这个 profile。desktop profile 需要先打开过一次桌面版才存在；web / CLI 的 profile 第一次安装时自动创建。
- 改名前的旧包名 `dsh-autostart-websearch` 若还留在 profile 里，安装时会一并移除。
- 卸载不删 `cordis.patch.yml` 里的配置行，也不删 WorkBuddy 后端（`~/.dsh/autostart-workbuddy`）。

插件自身的配置方式见两个插件各自的 README。

## 来源与历史

本仓库的内容原本位于 `D:\Project\Test`（remote `git@github.com:zhiqiangme/Test.git`），2026-10-09 迁出：

- 只保留与这两个插件相关的 3 个提交，用 `git filter-repo` 按路径过滤得到，Test 仓库的其余历史不在本仓库。
- 过滤会重写提交对象，所以下面的 SHA 与原仓库不同；**作者、提交时间、提交信息以及全部文件的 blob SHA 保持不变**（已逐条比对 26 个 tree entry，完全一致）。
- 同一批提交里与这两个插件无关的文件（Test 仓库其它目录）没有带过来。

| 原 SHA（Test 仓库） | 本仓库 SHA | 提交信息 |
| --- | --- | --- |
| `002a7a3fbb0adc39b03be6f62215819b3c2d5a08` | `ad45994a22ca38f616479aff5e12fee2775f43ad` | 新增(workbuddy)：从 autostart 插件拆出 WorkBuddy 独立插件 |
| ↑ 同一个提交拆成两条 | `f3028acf87f6338045664124163bbc2c5fad6555` | 新增(websearch)：从 autostart 插件拆出联网搜索独立插件，并加入接线脚本 |
| `3e3dcb27e01900898b73b0fca8304288d4210bbc` | `8a1ac0244330e9c1671bb28aaa07598c5c3b37b2` | 新增(workbuddy)：WorkBuddy 插件接管模型列表 |
| `e1ebda70ea4b4aad8ce96c581399dbb3bc1cf265` | `7727a8202ee646a6bfe116aeb54ffb15d043a9a2` | 文档(workbuddy)：补充 file: 依赖是拷贝、改代码后需强制刷新的注意事项 |

> ⚠️ 2026-10-10 对历史做过两次重写，所以本仓库的 SHA 与最初导入时不同：
> 1. 给全部提交信息加范围前缀（见下节）；
> 2. 把首个提交（同时创建了两个插件 + 接线脚本）**拆成两条**：workbuddy 一条、websearch + 脚本一条。
>    两条都**保留了原作者与原始提交时间**（`zhiqiangme`，`2026-10-09T06:39:46-07:00`）。
>
> 两次重写都只动提交对象，**所有文件的 blob 与最终 tree 逐字节未变**（已比对 tree SHA 一致）。
> 重写前的完整历史保存在 `D:\Project\DeepSeek-Harness-backup-<时间戳>.bundle`（`git bundle create --all`），需要时可从中恢复。

迁出后在本仓库新增的提交只做两件事：修正随迁移失效的本地绝对路径引用、补这份来源说明。

## 提交信息约定

两条插件线共用一个仓库，提交信息统一带范围前缀，`git log --oneline` 里一眼分得清是哪条线在动：

```
新增(workbuddy)：插件页的模型勾选面板
修复(tavily-search)：…
文档(repo)：更新提交映射表
```

- **范围 = 改动涉及的插件目录名**：`workbuddy` / `tavily-search`（2026-10-10 改名前的历史里是 `websearch`）
- 只涉及仓库级文件（根 `README.md`、`install-plugins.cmd`、`scripts/`），或**同时**涉及两个插件时，用 `repo`
- 格式为 `类型(范围)：描述`，类型沿用既有的 `新增 / 修复 / 文档 / 移除 / 调整 / 改进 / 测试 / 修正`

约定是靠 `git filter-repo --commit-callback` 按"改动路径"自动套用的（脚本逻辑：取该提交改动路径的顶层目录，
若恰好命中一个插件目录就用它，否则用 `repo`），所以历史里没有漏网的提交。

## 已并入的 Test 仓库代码

联网搜索的上游适配服务原先在 `D:\Project\Test\tavily-anthropic-search`，由插件 spawn 一个 node 子进程跑 `server.js`。
2026-10-10 起它被移植进 [dsh-tavily-search/lib/shim.js](dsh-tavily-search/lib/shim.js)（Test 仓库提交 `242449c`），
在 DSH 进程内监听，本仓库不再引用 Test 仓库的任何路径。旧目录可以保留作参考，也可以删除。
