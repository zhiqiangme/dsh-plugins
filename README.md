# DeepSeek Harness 本地插件仓库

本仓库存放两个 DSH 插件，以及把它们接入 desktop profile 的一次性接线脚本。

## 目录

| 路径 | 说明 |
| --- | --- |
| [dsh-autostart-workbuddy/](dsh-autostart-workbuddy/) | DSH 启动时自动拉起 WorkBuddy Panel（`wb2api.exe`, 127.0.0.1:7863），可选接管 profile 里的 workbuddy 模型列表 |
| [dsh-tavily-search/](dsh-tavily-search/) | 用 Tavily 给 DSH 的网页搜索供数：在 DSH 进程内提供 `127.0.0.1:8787/v1` 搜索接口，插件页卡片里配 API Key、一键接入网页搜索（原名 `dsh-autostart-websearch`） |
| [scripts/wire-plugins.mjs](scripts/wire-plugins.mjs) | 一次性脚本：把上面两个插件写入 profile 的 `package.json`（dependencies + bundles，结构化读写 + 时间戳备份；改过名的插件会原位替换旧名） |

脚本不写死任何绝对路径：插件目录由**脚本自身位置**推导（与 cwd 无关），目标 profile 依次按
命令行参数 → `DSH_PROFILE_DIR` → `DSH_HOME`/`DSH_PROFILE` → `~/.dsh/profiles/desktop` 解析
（`os.homedir()` 在 Windows 上读的就是 `USERPROFILE`）。动文件前还会确认两个插件目录确实存在。

安装、配置与刷新方式见两个插件各自的 README。

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
- 只涉及仓库级文件（根 `README.md`、`scripts/`），或**同时**涉及两个插件时，用 `repo`
- 格式为 `类型(范围)：描述`，类型沿用既有的 `新增 / 修复 / 文档 / 移除 / 调整 / 改进 / 测试 / 修正`

约定是靠 `git filter-repo --commit-callback` 按"改动路径"自动套用的（脚本逻辑：取该提交改动路径的顶层目录，
若恰好命中一个插件目录就用它，否则用 `repo`），所以历史里没有漏网的提交。

## 已并入的 Test 仓库代码

联网搜索的上游适配服务原先在 `D:\Project\Test\tavily-anthropic-search`，由插件 spawn 一个 node 子进程跑 `server.js`。
2026-10-10 起它被移植进 [dsh-tavily-search/lib/shim.js](dsh-tavily-search/lib/shim.js)（Test 仓库提交 `242449c`），
在 DSH 进程内监听，本仓库不再引用 Test 仓库的任何路径。旧目录可以保留作参考，也可以删除。
