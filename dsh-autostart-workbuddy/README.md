# dsh-autostart-workbuddy

DSH 启动时自动拉起 **WorkBuddy Panel**（`wb2api.exe`），替代手动运行 `scripts/WorkBuddy Panel.ps1` 或 `scripts/Start All.ps1`。

| 服务 | 端点 | 作用 |
| --- | --- | --- |
| WorkBuddy Panel（`wb2api.exe`） | `127.0.0.1:7863` | profile 里 `workbuddy` provider 的上游（`http://127.0.0.1:7863/v1/`） |

联网搜索那个上游（Tavily 适配服务, 8787）由同级插件 [dsh-tavily-search](../dsh-tavily-search/) 负责：两个插件各自独立开关，任何一个出问题都不影响另一个。

## 行为

- **随 DSH 启动**：插件加载后在后台拉起服务，不阻塞 DSH 启动。
- **幂等**：启动前先探测端口，已在监听就跳过——重复启动只会端口冲突。
- **静默**：不打开 WorkBuddy 管理面板浏览器窗口（需要时自行访问 `http://127.0.0.1:7863/panel/`）。
- **失败不阻断**：起不来只写日志，DSH 本身照常可用；失败时会回收自己拉起的进程，不留僵尸进程。
- **退出即停，但只停自己拉起的**：DSH 退出时结束本插件 spawn 的进程；DSH 启动前就已在运行的服务（手动起的、另一个 DSH 实例留下的）不受影响。
- **只依赖 Node 内置模块**：核心工作（拉起进程、改 profile）不注入任何 Host Service，因此不受插件加载顺序影响；
  Web 面板要用宿主 webserver 时是"用得上就用"——拿不到只少一个面板，其余功能照常。

与手动运行 `WorkBuddy Panel.ps1` 的差异：不再经过那层 pwsh 编排（也就没有临时日志目录），并去掉了自动弹浏览器这一步。

## 接管模型列表

除了拉服务，本插件还能接管 WorkBuddy 的**模型列表**（`config.models.enabled: true` 时）：

- 后端就绪后拉一次 `GET /v1/models`，把**后端真实提供的模型**写回 profile 的
  `cordis.patch.yml` → `llm-pi-ai.providers.workbuddy.models`，下次启动（或配置热加载）生效。
- 展示名统一成 `<CN|GL> <上游名> <倍率>`：`cn:` → `CN`、`global:` → `GL`；
  倍率取上游的 `credits`（`x0.11` → `0.11`，`x0.00` 或缺失 → `Free`）。
- 每个模型默认给**低/高/最大**三个思考档位（`efforts: auto` 则按上游声明的档位）。
- `models.only` 是白名单：留空 = 同步后端全部模型；填了就只保留列出的 id，并按列出顺序展示。
- 后端返回空列表（面板在上游故障时就是这么降级的）或请求失败时**不动现有配置**；
  结构认不出来也拒绝写入——宁可不同步，也不能改坏 profile。
- 写入前会备份成 `<配置>.bak-before-model-sync-<时间戳>`，只保留最近 `keepBackups`（默认 3）份。
- 不想让它改文件就别开 `models.enabled`（默认关闭）。

手动同步一次（配置来源与自动同步完全相同，都读 profile 里本插件那一行）：

```powershell
node lib/sync-cli.js --dry-run   # 只看将要写入什么
node lib/sync-cli.js             # 真写入（带备份）
```

⚠️ 一个上游行为要知道：`kimi-k3-1` 这类模型上游只支持 `medium` 档，默认三档是照你的要求统一给的；
要严格对齐上游就配 `efforts: auto`。

## Web 面板：在这里勾选模型、看倍率

在 DSH 的**插件**页打开本插件（组合包页面，或本插件那一行的"配置"），卡片会列出后端
`/v1/models` 的**全部**模型，每行带倍率、上下文长度与是否支持视觉：

- 勾选结果写进本插件的 `config.models.only` 白名单；**保存**时顺手重新生成
  `llm-pi-ai.providers.workbuddy.models`，不用等下次启动（配置热加载即生效）。
- 倍率就是拼进展示名的那个（`x0.11` → `x0.11`，`x0.00` / 缺失 → `Free`）。
- **一个都不勾**再保存 = 白名单留空 = 同步后端全部模型（既有语义），面板里有提示。
- 后端不可达时面板照常打开并显示原因，此时**不写任何文件**。
- 只有勾选/保存/全选这些动作会写 profile，且写前照例备份（同一套 `.bak-before-model-sync-<时间戳>`）。
- 卡片顶部有一行 **后端面板：`127.0.0.1:7863/panel`** 的可点击外链，点了用**默认浏览器**打开。
  地址由宿主按服务规格给出（端口可配），不是写死的。链接用 `<a target="_blank" rel="noopener noreferrer">`，
  宿主主窗口的 `setWindowOpenHandler` 对 http(s) 会调 `shell.openExternal`——这也是 DSH 里外链的既有做法。

数据通路：卡片 `fetch('/plugins/dsh-autostart-workbuddy/models')`，宿主半侧
（[lib/web.js](lib/web.js)）负责拉后端与读写 profile。必须过宿主是因为：页面够不到
`127.0.0.1:7863`（跨源，面板不发 CORS 头），也改不了 profile 里的白名单；而 DSH 的
`configForms` 通道要求宿主声明带 `.volatile()` 的 schemastery 配置，本插件刻意不引这个依赖。
路由只接受 loopback 来源（无 Origin 或 localhost/127.0.0.1/::1），其它一律 403。

⚠️ 改了 `lib/client.js` 要**重启 DSH** 才生效：客户端 bundle 的版本号由文件 mtime/size 派生，
宿主只在启动时扫描一次；`lib/*.js` 的改动同样不会热重载。

## 安装到 profile

在 `~/.dsh/profiles/desktop/package.json` 里加一条依赖和一个 bundle：

```jsonc
{
  "dependencies": {
    "dsh-autostart-workbuddy": "file:D:\\Project\\DeepSeek Harness\\dsh-autostart-workbuddy"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-autostart-workbuddy"
      ]
    }
  }
}
```

然后在该目录执行 `pnpm install`（用 DSH 自带的 pnpm），重启 DSH 生效。

⚠️ `file:` 依赖在 profile 里是**拷贝**，不是软链：改了本插件的源码后 `pnpm install` 会认为"已是最新"而不重新拷贝，
需要先把 `node_modules/dsh-autostart-workbuddy` 挪走再 `pnpm add "dsh-autostart-workbuddy@file:<目录>"`，
否则 DSH 跑的还是旧代码。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-autostart-workbuddy
  name: dsh-autostart-workbuddy
  config:
    enabled: true
    readinessTimeoutMs: 30000
    stopTimeoutMs: 5000
    port: 7863
    # exe / cwd 默认指向插件自管的后端目录，通常不用写：
    #   $DSH_HOME/autostart-workbuddy/backend/current/{wb2api.exe,config.json}
    args: ['-config', 'config.json']
    models:
      enabled: true
      only:                     # 留空 = 后端全部模型
        - cn:deepseek-v4.1-flash
        - global:deepseek-v4.1-flash
    backend:
      checkOnStart: true        # 启动时查一次上游 release（只提示，不自动安装）
      keepVersions: 3           # 保留几个历史版本供回滚
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；`false` 时完全不拉起（默认 true） |
| `title` | 日志里显示的服务名，默认 `WorkBuddy Panel` |
| `host` / `port` | 就绪探测目标，默认 `127.0.0.1:7863` |
| `exe` | 可执行文件，默认 `$DSH_HOME/autostart-workbuddy/backend/current/wb2api.exe` |
| `args` | 附加参数，默认 `['-config', 'config.json']` |
| `cwd` | 子进程工作目录，默认 `$DSH_HOME/autostart-workbuddy/backend/current` |
| `env` | 追加到子进程环境的键值对（不会改写 DSH 自己的环境） |
| `logDir` | 日志目录，默认 `$DSH_HOME/autostart-workbuddy/logs` |
| `logName` | 日志文件名前缀，默认 `wb2api` |
| `readinessTimeoutMs` | 等待端口就绪的上限，默认 30000 |
| `stopTimeoutMs` | 停止时等待退出的上限，默认 5000；超时后强制结束 |

`models` 段的字段：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否接管模型列表，默认 **false**（不开就不碰 profile） |
| `only` | 白名单，按列出顺序写；空 = 后端全部模型 |
| `exclude` | 黑名单，优先级高于 `only` |
| `efforts` | 每个模型的思考档位，默认 `[low, high, max]`；填 `auto` 用上游声明的档位 |
| `profilePatch` | 目标配置路径，默认由 `DSH_PROFILE_DIR`（或 `DSH_HOME` + `DSH_PROFILE`）推导 |
| `panelConfig` | 读网关密钥的面板配置，默认 `<cwd>/config.json` |
| `apiKey` | 显式指定网关密钥，默认依次尝试 `WORKBUDDY_PROXY_KEY`、面板 `config.json` 的 `api_key` |
| `baseURL` | 模型接口地址，默认 `http://<host>:<port>` |
| `timeoutMs` | 拉取超时，默认 60000（面板的模型列表缓存 1h，冷缓存要等上游） |
| `keepBackups` | 保留的备份份数，默认 3 |

`backend` 段的字段（后端版本管理）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否允许查更新 / 更新 / 回滚，默认 true |
| `checkOnStart` | DSH 启动时查一次上游 release 并写日志，默认 true（**只提示**） |
| `checkTtlMs` | 查询结果缓存时长，默认 6 小时（GitHub 匿名 API 只有 60 次/小时） |
| `keepVersions` | 保留几个历史版本供回滚，默认 3 |
| `apiBase` | 覆盖 GitHub API 基址（镜像 / 测试用），默认官方 `api.github.com` |

## 后端版本管理

后端（`wb2api.exe`）由插件自己管理安装位置与更新，目录布局在 `$DSH_HOME/autostart-workbuddy/`：

```
backend/current/     正在用的 wb2api.exe + config.json + installed.json（版本清单）
backend/versions/    历史版本，回滚用（保留最近 keepVersions 个）
data/                账号凭证与状态：auths/ · state.json · usage.json · request-logs/
cache/               下载的 release 包与查询缓存
logs/                后端 stdout/stderr
```

**程序与数据分离**是刻意的：`config.json` 里的 `auth_dir` / `state_file` 指向 `data/` 的绝对路径，
所以切换版本时凭证与状态原地不动，更新永远不碰账号。

### 版本怎么认

后端没有 PE 版本号，`/healthz` 也不报版本；但 exe 里嵌了 Go buildinfo：

```
vcs.revision=d66384d9e3d69655f799d7d8f2e5fba1946e00ab
vcs.time=2026-10-08T00:49:09Z
```

所以"本地版本" = 从 exe 里读 `vcs.revision`，"上游最新" = GitHub **Releases** 最新 tag 对应的 commit
（不看 main 分支：release 才有打包产物与校验和）。两者不等即提示可更新。

### 更新流程（只在面板里点，不自动装）

1. 取最新 release → 选中 `*-windows-amd64.zip`
2. 下载到 `cache/`，算 sha256 与 release 的 `checksums.txt` 比对——**没有校验和就拒绝安装**
3. 解压出 `wb2api.exe`，校验它自称的 `vcs.revision` 等于目标 tag 的 commit
4. 停后端（Windows 下运行中的 exe 被锁）→ 旧版本归档到 `backend/versions/<旧版本>/` → 新 exe 落到 `current/`
5. 起后端 → 探 `/healthz`（必须返回 `service: workbuddy2api`）
6. 失败自动回滚到上一版本并重启

只停**本插件自己拉起**的进程：如果 7863 上是你手动启动的实例，会拒绝更新并提示先停掉它，绝不误杀。

### 安装与卸载

面板那一行按钮按状态切换：**没装**时显示「安装」，**装了**时显示「更新 + 卸载（红色）+ 回滚」。

- **安装**：从最新 release 拉 `windows-amd64` 包装到 `backend/current/`。已经装了会拒绝——
  那应该用「更新」（安装只认 release 的产物，不接受任意版本）。
- **卸载**：**二次确认弹窗**之后才执行——停后端，删掉 `wb2api.exe`、历史版本与下载缓存；
  **保留 `config.json` 与 `data/`（账号凭证与状态）**。要连数据一起清就自己删 `data/`。
  宿主 Modal 拿不到时会退回卡片内的行内确认，同样是"再点一次才真的删"。
- 卸载后插件不再尝试启动后端（启动日志会说明"未安装"），直到你再点「安装」。
  例外：在 profile 里**显式配了 `exe`** 时，路径不存在仍按老行为尝试启动——
  否则一个拼错的路径会被误报成"未安装"，把配置错误藏起来。

### CLI

```powershell
node lib/backend-cli.js                  # 看本地布局与版本（不联网）
node lib/backend-cli.js --check          # 再查一次上游最新 release
node lib/backend-cli.js --update         # 下载并安装最新版
node lib/backend-cli.js --rollback       # 回滚到上一版本
node lib/backend-cli.js --adopt v1.13.0  # 把现场已有的 exe 纳管（写 installed.json）
```

`--update` / `--rollback` 用的 ManagedService 是 CLI 自己创建的，因此只能停它自己拉起的进程；
后端由 DSH 拉起时请改用面板里的按钮。

任何非法值都会退回默认值，不会让插件加载失败。

## 排障

```powershell
# 看插件解析出的实际规格与模型同步配置（只读，不启动任何东西、不联网）
node lib/cli.js

# 额外校验可执行文件 / profile 配置是否存在、端口当前状态
node lib/cli.js --check

# 手动同步一次模型列表（唯一会写文件的入口）
node lib/sync-cli.js --dry-run
node lib/sync-cli.js
```

日志按时间戳分文件写在 `logDir`：`wb2api.<时间戳>.out.log` / `.err.log`。

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。

`fixtures/` 下是测试用的假服务；**不要**把它放进 `test/`，否则 Node 的测试运行器会把它当成用例执行，而一个正在 listen 的服务器会让整轮测试挂死。
