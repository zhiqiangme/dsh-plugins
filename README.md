# DeepSeek Harness 本地插件仓库

本仓库存放 DSH 的两个 autostart 插件，以及把它们接入 desktop profile 的一次性接线脚本。

## 目录

| 路径 | 说明 |
| --- | --- |
| [dsh-autostart-workbuddy/](dsh-autostart-workbuddy/) | DSH 启动时自动拉起 WorkBuddy Panel（`wb2api.exe`, 127.0.0.1:7863），可选接管 profile 里的 workbuddy 模型列表 |
| [dsh-autostart-websearch/](dsh-autostart-websearch/) | DSH 启动时自动拉起 tavily-anthropic-search（联网搜索上游, 127.0.0.1:8787） |
| [scripts/wire-autostart-plugins.mjs](scripts/wire-autostart-plugins.mjs) | 一次性脚本：把上面两个插件写入 profile 的 `package.json`（dependencies + bundles，结构化读写 + 时间戳备份） |

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
| `002a7a3fbb0adc39b03be6f62215819b3c2d5a08` | `89ad10830ec586e7d3db3a8d9e0aa05f8f01ec18` | 新增：拆分 autostart 插件为 WorkBuddy 与联网搜索两个独立插件 |
| `3e3dcb27e01900898b73b0fca8304288d4210bbc` | `90f3c19c5838e3a8941321a9f7c5986994a2e2b2` | 新增：WorkBuddy 插件接管模型列表 |
| `e1ebda70ea4b4aad8ce96c581399dbb3bc1cf265` | `d2126e6a0e98cdcfec25ab01d0e8c896fc0e6719` | 文档：补充 file: 依赖是拷贝、改代码后需强制刷新的注意事项 |

迁出后在本仓库新增的提交只做两件事：修正随迁移失效的本地绝对路径引用、补这份来源说明。

## 仍然指向 Test 仓库的依赖

`dsh-autostart-websearch` 托管的搜索上游 `tavily-anthropic-search` **没有**迁出，仍在 `D:\Project\Test\tavily-anthropic-search`。
插件的默认 `cwd` / `script` / `envFile` 与 README 示例都按这个绝对路径写，因此保持不变。
