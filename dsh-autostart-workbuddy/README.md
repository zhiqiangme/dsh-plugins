# @zhiqiangme/dsh-autostart-workbuddy

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：DSH 启动时自动拉起
**WorkBuddy Panel**（[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) 的 `wb2api.exe`），
不用再手动启动它；还可以接管 DSH 里 workbuddy 的模型列表、在插件页管理后端版本。
后端网关也可以换成 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)（见[后端网关](#后端网关)），二选一。

| 服务 | 端点 | 作用 |
| --- | --- | --- |
| WorkBuddy Panel（`wb2api.exe`，默认） | `127.0.0.1:7863` | profile 里 `workbuddy` provider 的上游（`http://127.0.0.1:7863/v1/`） |
| WorkBuddy2API Hub（可选） | `127.0.0.1:7863` | 同上；与 wb2api 用同一个端口，同一时刻只跑其中一个 |

同一仓库里还有 Tavily 联网搜索插件 [@zhiqiangme/dsh-tavily-search](https://github.com/zhiqiangme/dsh-plugins/tree/main/dsh-tavily-search)：两个插件各自独立开关，任何一个出问题都不影响另一个。

## 行为

- **随 DSH 启动**：插件加载后在后台拉起服务，不阻塞 DSH 启动。
- **幂等**：启动前先探测端口，已在监听就跳过——重复启动只会端口冲突。
- **静默**：不打开 WorkBuddy 管理面板浏览器窗口（需要时自行访问 `http://127.0.0.1:7863/panel/`）。
- **失败不阻断**：起不来只写日志，DSH 本身照常可用；失败时会回收自己拉起的进程，不留僵尸进程。
- **退出即停，但只停自己拉起的**：DSH 退出时结束本插件 spawn 的进程；DSH 启动前就已在运行的服务（手动起的、另一个 DSH 实例留下的）不受影响。
- **崩溃自动恢复**：只恢复本插件成功启动后意外退出的进程，默认 5 分钟内最多尝试 3 次，按 1 / 2 / 4 秒退避；连续失败后暂停，可在卡片点「重试启动」。主动卸载、更新、关闭 DSH 不触发恢复，也不接管外部进程。`recovery.enabled: false` 可关闭；`maxAttempts`、`windowMs`、`delayMs`、`maxDelayMs` 可调整次数与间隔。
- **后端自动更新**（默认开）：运行中在后台下载新版本，下次启动 DSH 时先换上再拉起，不打断正在用的后端；见[自动更新](#自动更新)。
- **只依赖 Node 内置模块**：核心工作（拉起进程、改 profile）不注入任何 Host Service，因此不受插件加载顺序影响；
  Web 面板要用宿主 webserver 时是"用得上就用"——拿不到只少一个面板，其余功能照常。

## 后端网关

插件可以托管两种 OpenAI 兼容网关，在插件卡片「后端版本」区最上面的「后端网关」里切换（写本插件的 `config.gateway`）：

| | wb2api（默认） | workbuddy2api-hub |
| --- | --- | --- |
| 上游 | [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) |
| 程序 | 单个 `wb2api.exe`（Go） | 便携包整目录：脚本 + 自带的 CPython 运行时（约 33MB） |
| 目录 | `wb2api/backend/`、`wb2api/data/` | `hub/backend/`、`hub/data/`（账号与用量） |
| 版本身份 | exe 里的 Go `vcs.revision` | 包内 `release-manifest.json` 的 tag |
| 模型 id | `cn:xxx` / `global:xxx`，两个出口同时列出 | 不带前缀，一次只列一个出口；国内/国际跟随 hub 看板顶部的出口开关，切换后 DSH 的模型列表自动跟着换 |
| 管理面板 | `http://127.0.0.1:7863/panel`，用 `config.json` 的 `api_key` 进 | `http://127.0.0.1:7863/`，用面板密码进（默认 `admin`，登录后请改） |

hub 是 wb2api 停更时的备选。

### HUB：CN 与 GL 同时使用

默认仍跟随 HUB 看板的全局出口。要同时列出两组模型，先在 HUB 登录两种区域的账号，再在 HUB「设置」创建两把分别绑定国内、国际的 Key，填入插件卡片，勾选「CN / GL 同时使用」并应用。模型同步开关开启时，会生成 WorkBuddy CN 和 WorkBuddy GL 两个 provider，同名模型独立显示、请求按各自 Key 路由，不受全局出口切换影响。

Key 只保存在 DSH 凭据库的 `WORKBUDDY_PROXY_KEY_CN` / `WORKBUDDY_PROXY_KEY_GLOBAL`，profile 只记 `models.hubDual`。原 workbuddy 分组暂时清空模型并保留连接配置，关闭模式后恢复，自动创建的两个分组移除；其它 provider 不动。专用分组名为 `<provider>-hub-cn` / `<provider>-hub-global`，名称冲突时会拒绝覆盖。

HUB 配置多 Key 后，启动参数里的旧 Key 可能不再有效。可同时填写一把不绑定区域的「跟随出口 Key」，它单独写入原 provider 对应的 DSH 凭据，profile 只保存 `models.apiKeyRef`，供关闭双区域后使用。Key 留空沿用已保存的值。启用时验证区域绑定，关闭时验证跟随 Key；校验不通过不会切换模式。

- **切换**：宿主按"配置变更"重启本插件，停掉旧网关，再按新网关拉起（没装就提示去点「安装」）。卡片会等到新网关接管、模型区能答才刷新（最多 60 秒）。两种网关的程序和账号各存一份，切换不会覆盖对方的数据；但账号要在 hub 看板里另外登录或导入。
- **端口与 provider**：两者都监听 7863，DSH 里 workbuddy provider 的 `baseURL` 不用改。
- **网关密钥**：hub 的密钥按 插件配置 `models.apiKey` → 环境变量 `WORKBUDDY_PROXY_KEY` → wb2api `config.json` 的 `api_key` 的顺序沿用，所以凭据库里现有的 `WORKBUDDY_PROXY_KEY` 不用改。都没有时插件生成一个，存进 `hub/data/plugin-api-key`。密钥经环境变量 `API_KEY` 传给 hub，不出现在命令行里。
- **模型白名单按出口分开记**：hub 的模型 id 不带前缀，一次只列当前出口的模型。插件在白名单里给它们补上出口前缀（国内 `cn:xxx`、国际 `global:xxx`，与 wb2api 的 id 一致），所以 CN 和 GL 各有一组勾选，而且从 wb2api 切过来不用重新勾。写进 DSH 的模型 id 仍是 hub 认的裸 id，展示名中的区域标签（CN / GL）按当前出口补在模型名与倍率之间。
  - 不带前缀的老条目（改版前存下的）对两个出口都生效；在卡片里保存一次后会拆成两个出口各一条，之后取消一个出口的勾选不影响另一个。
  - 当前出口在白名单里一条都没有时按「全部模型」处理（与"白名单留空 = 全部"同一语义）：第一次切到一个从没勾过的出口，DSH 换成它的全部模型，再到卡片里删减即可。
- **跟随出口切换**：在 hub 看板顶部切换国内 / 国际后，插件约 5 秒内发现（每 5 秒探一次 hub 的 `/health`，它报当前出口，hub 不给这条请求记日志），立即按新出口的那组勾选重写 DSH 的模型列表，不用回卡片点「刷新」「保存」。这一轮跳过"移除要连续两轮确认"——模型变少是切出口的结果，不是上游抖动。与定时同步同一个开关：`models.enabled` 关着或 `resyncIntervalMs: 0` 时不跟。已经打开的卡片每 5 秒刷新后端状态，出口或同步状态改变时自动回读模型；保留未保存的勾选、开关和规则，页面隐藏时暂停。
- hub 账号池里还没有可用账号时，它的 `/v1/models` 仍会返回内置目录，卡片按 `/health` 的 `accounts_ready` 判断，为 0 就不列模型，提示先去看板登录。
- **Clash 全局模式**：hub 的国内版上游同样写死成 `copilot.tencent.com`，海外出口下 CN 账号的对话会 TLS 失败。插件启动 hub 时传 `WB_CN_CHAT_UPSTREAM`（取 `cnChatBase`），需要 hub 认这个变量（fork 分支 `fix/cn-chat-upstream`，待合入上游）；不认的版本照旧。背景与改法见 [docs/hub-cn-base.md](https://github.com/zhiqiangme/dsh-plugins/blob/main/dsh-autostart-workbuddy/docs/hub-cn-base.md)。
- **命令行**：`lib/backend-cli.js` 只管 wb2api；hub 的安装、更新与回滚在卡片里操作。

## 接管模型列表

除了拉服务，本插件还能接管 WorkBuddy 的**模型列表**（`config.models.enabled: true` 时）：

- 后端就绪后拉一次 `GET /v1/models`，把**后端真实提供的模型**写进
  `llm-pi-ai.providers.workbuddy.models`，llm-pi-ai 随即热重载，模型选择器马上就是新清单。
- 写入走 DSH 自己的 **configEditor**（设置页用的同一个入口）：持 profile 锁、按 llm-pi-ai 的 schema
  校验、原子写、只热重载被改的那一行，失败自动回滚。不再自己改 `cordis.patch.yml` 的文本，
  所以不会和设置页的保存互相覆盖。代价是 llm-pi-ai 那一行会按 DSH 的格式重新排版（行内注释不保留）。
- workbuddy provider 整段不在时会按原有形状补建（`apiKeyEnv: WORKBUDDY_PROXY_KEY`，密钥不落明文）。
- 同步后会检查 DSH 凭据库里有没有 provider 引用的密钥（`WORKBUDDY_PROXY_KEY`）：没有就写入拉模型用的那个
  网关密钥（插件配置 `apiKey`，否则面板 `config.json` 的 `api_key`）；`api_key` 为空（网关不鉴权）时写占位值
  `workbuddy-no-auth`，因为 llm-pi-ai 解析不到非空密钥会整轮报 `MISSING_CREDENTIAL`，而凭据库不收空串。
  凭据库里已存的或启动环境给的值一律不覆盖；只有现值是这个占位值、而面板后来设了密钥时才换成真密钥。
- 展示名统一成 `<上游名> <CN|GL> <倍率>`：`cn:` → `CN`、`global:` → `GL`；
  倍率取上游的 `credits`（`x0.11` → `0.11`，`x0.00` 或缺失 → `Free`）。例如 `DeepSeek V4.1 Flash CN Free`。
- 每个模型默认给**低/高/最大**三个思考档位（`efforts: auto` 则按上游声明的档位）。
- `models.only` 是白名单：留空 = 同步后端全部模型；填了就只保留列出的 id，并按列出顺序展示。
  hub 网关下按出口分开算（`cn:xxx` / `global:xxx`），见[后端网关](#后端网关)。
- 后端返回空列表（面板在上游故障时就是这么降级的）或请求失败时**不动现有配置**。
- 运行中默认每分钟（`resyncIntervalMs`）再同步一次，上游下架或新增、网络恢复后重新出现的模型不必重启 DSH 就能跟上。
  后端 `/healthz` 不通或账号池暂无可用账号时跳过；某个模型要连续两轮缺席才会移除，避免上游抖动误删。
  凭据库里已有的网关密钥不会被重写。
- 打开插件模型页或点击「刷新」时也会立即同步，沿用已保存的开关和白名单；CN 模型恢复后不用再点「保存并同步」。
  显式配置的 `resyncIntervalMs` 仍按原值执行，`0` 仅关闭后台定时同步。
- 宿主没有 configEditor（DSH 版本过旧）时只记一条日志、跳过同步，后端照常拉起。
- 模型同步默认关闭。在插件页勾选「同步到 DSH 模型列表」并点击「保存并同步」即可开启，
  不需要手动编辑 profile；关闭并保存后保留现有模型列表。在卡片上装好后端时会自动打开同步并同步一次（沿用已有勾选）。
- 后端还没装时，模型区提示去点「后端版本」里的「安装」，而不是只显示 fetch failed。

命令行只能**预览**（读 profile 里本插件那一行，打印将要写进去的 models 段，不改任何文件）：

```powershell
node lib/sync-cli.js
```

真正的写入只发生在 DSH 里：开启同步后，启动、定时检查及打开或刷新插件模型页都会对齐清单；保存选择时也立即同步。

⚠️ 一个上游行为要知道：`kimi-k3-1` 这类模型上游只支持 `medium` 档，默认的三档是对所有模型统一给的；
要严格对齐上游就配 `efforts: auto`。

## Web 面板：在这里勾选模型、看倍率

「一键诊断」只读检查程序路径、端口、后端身份、账号可用性、模型接口与 DSH 凭据是否匹配，并给出处理建议；不发送对话、不改配置。可复制脱敏报告，密钥、令牌、邮箱与用户目录会遮盖，原始环境和账号文件不会导出。

卡片自动显示可用 / 总账号数。HUB 还显示当前区域（双区域模式分别显示 CN 与 GL）的剩余积分、启用账号数、有积分快照的账号数和快照时间。只读取 `/v1/balance-summary` 的本地缓存，插件缓存 30 秒合并并发查询，不发起对话、不触发上游积分刷新；未知余额、旧版本不支持和鉴权失败分别显示状态，真实零余额显示 `0`。

模型区可按名称或 id 搜索、筛选 CN/GL、按名称或倍率排序；全选和清空仅作用于当前可见结果，隐藏的勾选保留。「只同步免费模型」「只同步视觉模型」「最高倍率」会作为 `models.rules` 保存，后续新增模型也按规则筛选（白名单为空时跟随全部）。未知价格不会当作免费。后端返回有效目录、白名单仍有匹配项但没有模型符合规则时，允许清空本插件管理的列表；网络失败、后端空目录或白名单模型暂时缺席仍保留原列表。

卡片可见时每 5 秒刷新后端状态；检测到模型同步、出口或恢复状态变化时重新读取模型，保留尚未保存的开关、规则及跨区域勾选草稿。保存或切换网关期间暂停刷新，隐藏页面及卸载卡片后停止轮询。

在 DSH 的**插件**页打开本插件（组合包页面，或本插件那一行的"配置"），卡片会列出后端
`/v1/models` 的**全部**模型，每行带倍率、上下文长度与是否支持视觉：

- 「同步到 DSH 模型列表」控制 `config.models.enabled`，与勾选结果 `config.models.only`
  一起经 configEditor 写入。开启后点击「保存并同步」会立即重新生成
  `llm-pi-ai.providers.workbuddy.models`，不用重启，也可以只开启同步、不更改已有勾选。
- 同步开启时，即使勾选没有变化也能再次「保存并同步」，用于重试同步失败或修复旧清单。
  同步关闭时，「保存」只更新开关和勾选结果，不改 DSH 中已有的模型列表。
- 后端暂时不列出的已选模型仍保留在白名单里；未改勾选时保存也会保留「同步全部」的空白名单语义，避免网络异常将选择固化为 GL 子集。
- 改白名单（以及 `models` 段的其它字段）**不会重启本插件**：插件拦下这类配置变更就地生效，
  托管的后端不会被停掉再拉起。端口、exe 等其它字段变了才按常规重启。
- 倍率就是拼进展示名的那个（`x0.11` → `x0.11`，`x0.00` / 缺失 → `Free`）。
- **一个都不勾**再保存 = 白名单留空 = 同步后端全部模型（既有语义），面板里有提示。
- 后端不可达时面板照常打开并显示原因，此时**不写任何配置**。
- 只有点「保存」才会修改同步开关和白名单；已开启同步时，打开或刷新列表也会更新 DSH 模型清单。
  保存或刷新后若同步失败，用错误色给出原因。
- 卡片顶部有一行 **后端面板：`127.0.0.1:7863/panel`** 的可点击外链，点了用**默认浏览器**打开。
  地址由宿主按服务规格给出（端口可配），不是写死的。链接用 `<a target="_blank" rel="noopener noreferrer">`，
  宿主主窗口的 `setWindowOpenHandler` 对 http(s) 会调 `shell.openExternal`——这也是 DSH 里外链的既有做法。
- 链接旁边有「复制访问密钥」：后端面板首次打开会要求输入 `config.json` 里的 `api_key`。
  面板只从浏览器自己的 `localStorage` 读密钥（按来源隔离），插件替它填不进去，所以改为一键复制、
  用户粘贴一次（之后浏览器会记住）。剪贴板不可用时退回显示原文供手动复制。
  密钥经 `POST /plugins/dsh-autostart-workbuddy/panel-key` 取（只接受 loopback 来源，GET 一律 405），
  不放进其它接口的应答里。
  切到 hub 后按钮改为「复制面板密码」：hub 的看板密码还是出厂的 `admin` 时直接复制它；改过之后 hub 只存哈希，
  插件读不到明文，只提示用自己设的密码登录。

数据通路：卡片向 `/plugins/dsh-autostart-workbuddy/models` 发 POST `{action: 'refresh'}` 刷新并同步，GET 只读取清单，普通 POST 保存选择；宿主半侧
（[lib/web.js](lib/web.js)）负责拉后端与读写 profile。必须过宿主是因为：页面够不到
`127.0.0.1:7863`（跨源，面板不发 CORS 头），也改不了 profile 里的白名单；而 DSH 的
`configForms` 通道要求宿主声明带 `.volatile()` 的 schemastery 配置，本插件刻意不引这个依赖。
路由只接受 loopback 来源（无 Origin 或 localhost/127.0.0.1/::1），其它一律 403。

### 插件更新（卡片最底部）

与上面管 wb2api 的「后端版本」是两回事：这一块管**本插件自己**。

- 显示当前运行版本与 npm 最新版本。版本检查走宿主半侧路由 `/plugins/dsh-autostart-workbuddy/version`
  （[lib/update.js](lib/update.js)）：同时问 npm 官方源与 npmmirror，取较高者，缓存 10 分钟，「检查更新」绕过缓存。
- 装了 [dshmarket](https://www.npmjs.com/package/dshmarket) 时出现「更新到 x」按钮，经它的公开更新 API v1 更新并显示进度；
  没装时只提示有新版本。本插件不自己跑 pnpm：DSH 自带的插件管理器不支持升级已安装的插件，
  profile 锁、文件占用、回滚与版本核对都交给 dshmarket。
- 桌面版更新完成后要**重启 DSH** 才会换上新代码（桌面版的重启归桌面壳管，卡片不提供重启按钮）。
  新版本刚发布时可能被 pnpm 的发布冷却期挡下，卡片会给出「强制更新」。
- 一键更新只对从 npm 安装的情况有效。从本地目录（`file:`）装时 dshmarket 把它当作本地拷贝（`linked`）并拒绝更新，
  卡片会先向 dshmarket 查询安装来源，这种情况下不显示更新按钮，改为提示；请用上文的 `install-plugins.cmd` 更新，或改为从 npm 安装。

⚠️ 改了 `lib/client.js` 要**重启 DSH** 才生效：客户端 bundle 的版本号由文件 mtime/size 派生，
宿主只在启动时扫描一次；`lib/*.js` 的改动同样不会热重载。

## 安装到 profile

从 npm 安装：先**完全退出** DSH 桌面版，然后在终端运行（`dsh` 命令随 DSH 桌面版一起安装），重新打开 DSH 生效：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-autostart-workbuddy
# 更新：dsh plugin --profile desktop update --latest @zhiqiangme/dsh-autostart-workbuddy
```

装到 Web / CLI 就把 `desktop` 换成 `web` / `headless`。更新要带 `--latest`：版本号按日期编排（`26.10.11`），
跨年时主版本号会变。更多说明见[仓库 README](https://github.com/zhiqiangme/dsh-plugins#从-npm-安装推荐)。

从源码安装：克隆[仓库](https://github.com/zhiqiangme/dsh-plugins)后双击根目录的 `install-plugins.cmd`，
按提示选择插件和 profile（说明见[仓库 README](https://github.com/zhiqiangme/dsh-plugins#从源码安装)），完成后重启 DSH 生效。
改了本插件的源码后再运行一次同样的"安装 / 更新"即可换上新代码。

手动安装等价于（先完全退出桌面版）：

```powershell
dsh plugin --profile desktop add "file:<仓库路径>\dsh-autostart-workbuddy"
```

⚠️ `file:` 依赖在 profile 里是**拷贝**，不是软链：改了本插件的源码后再 `add`（包括 `--force`）pnpm 都认为"已是最新"，
要先 `dsh plugin --profile desktop remove @zhiqiangme/dsh-autostart-workbuddy` 再 `add`，否则 DSH 跑的还是旧代码。
安装脚本会比对文件哈希自动做这一步。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-autostart-workbuddy
  name: '@zhiqiangme/dsh-autostart-workbuddy'   # 包名以 @ 开头，YAML 里必须加引号
  config:
    enabled: true
    readinessTimeoutMs: 30000
    stopTimeoutMs: 5000
    port: 7863
    # exe / cwd 默认指向插件自管的后端目录，通常不用写：
    #   $DSH_HOME/autostart-workbuddy/wb2api/backend/current/{wb2api.exe,config.json}
    args: ['-config', 'config.json']
    models:
      enabled: true
      only:                     # 留空 = 后端全部模型
        - cn:deepseek-v4.1-flash
        - global:deepseek-v4.1-flash
    backend:
      autoUpdate: true          # 自动更新后端（默认开）：后台下载，下次启动 DSH 时换上
      autoUpdateDelayHours: 24  # 发布满多少小时才自动装
      keepVersions: 3           # 保留几个历史版本供回滚
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；`false` 时完全不拉起（默认 true） |
| `title` | 日志里显示的服务名，默认 `WorkBuddy Panel` |
| `host` / `port` | 就绪探测目标，默认 `127.0.0.1:7863` |
| `exe` | 可执行文件，默认 `$DSH_HOME/autostart-workbuddy/wb2api/backend/current/wb2api.exe` |
| `args` | 附加参数，默认 `['-config', 'config.json']` |
| `cwd` | 子进程工作目录，默认 `$DSH_HOME/autostart-workbuddy/wb2api/backend/current` |
| `env` | 追加到子进程环境的键值对（不会改写 DSH 自己的环境） |
| `logDir` | 日志目录，默认 `$DSH_HOME/autostart-workbuddy/logs` |
| `logName` | 日志文件名前缀，默认 `wb2api` |
| `readinessTimeoutMs` | 等待端口就绪的上限，默认 30000 |
| `stopTimeoutMs` | 停止时等待退出的上限，默认 5000；超时后强制结束 |
| `gateway` | 托管哪种网关：`wb2api`（默认）或 `hub`；非法值按 `wb2api` 处理。`hub` 时 `exe` / `cwd` / `args` 不生效 |
| `cnChatBase` | 国内版上游 base，默认 `https://www.workbuddy.cn`；空串 = 不管这一项。wb2api：拉起前写进 `config.json` 的 `cn.chat_base`；hub：经环境变量 `WB_CN_CHAT_UPSTREAM` 传入 |

**为什么要写 `cn.chat_base`**：wb2api 内置的国内版上游 `copilot.tencent.com` 对海外出口（例如 Clash 全局模式 + TUN）
的 TLS 握手直接复位，CN 模型目录和对话全部 `EOF`，网关里只剩 `global:` 模型。官方 WorkBuddy 桌面端已改用
`www.workbuddy.cn`，该域海外出口可达、接口同构，所以插件默认把它写进去。

- 只在 `cn.chat_base` 缺失或为空串（wb2api 生成默认配置时就是空串）时写入；手动填过的非空值不覆盖，其余配置原样保留。
- wb2api 只在启动时读这一项：后端首次启动时 `config.json` 还不存在，插件会在它拉起后补写，**下次启动后端时**生效。
- 只有支持 `cn.chat_base` 的 wb2api 才会使用这一项；不认识它的版本直接忽略，写进去不影响启动。

`models` 段的字段：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否接管模型列表，默认 **false**（不开就不碰 profile） |
| `only` | 白名单，按列出顺序写；空 = 后端全部模型。hub 网关下写 `cn:xxx` / `global:xxx`，按当前出口生效 |
| `exclude` | 黑名单，优先级高于 `only` |
| `efforts` | 每个模型的思考档位，默认 `[low, high, max]`；填 `auto` 用上游声明的档位 |
| `panelConfig` | 读网关密钥的面板配置，默认 `<cwd>/config.json` |
| `apiKey` | 显式指定网关密钥，默认依次尝试 `WORKBUDDY_PROXY_KEY`、面板 `config.json` 的 `api_key` |
| `baseURL` | 模型接口地址，默认 `http://<host>:<port>` |
| `timeoutMs` | 拉取超时，默认 60000（面板的模型列表缓存 1h，冷缓存要等上游） |
| `resyncIntervalMs` | 运行中定时重同步的间隔，默认 / 最小 60000（1 分钟）；`0` = 关闭后台定时同步，仍可通过插件页刷新立即同步 |

`backend` 段的字段（后端版本管理）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否允许查更新 / 更新 / 回滚，默认 true |
| `autoUpdate` | 自动更新后端，默认 **true**；只有显式 `false` 才关。规则见[自动更新](#自动更新)，插件卡片上有同一个开关（改了就地生效，不重启插件） |
| `autoUpdateDelayHours` | 新版本发布满多少小时才自动装，默认 24；`0` = 不等 |
| `checkOnStart` | `autoUpdate` 关掉时，DSH 启动时查一次上游 release 并写日志（**只提示**），默认 true |
| `checkTtlMs` | 查询结果缓存时长，默认 6 小时（GitHub 匿名 API 只有 60 次/小时） |
| `keepVersions` | 保留几个历史版本供回滚，默认 3（hub 默认 2：每个版本是整目录） |
| `apiBase` | 覆盖 GitHub API 基址（镜像 / 测试用），默认官方 `api.github.com` |

## 后端版本管理

后端（`wb2api.exe`）由插件自己管理安装位置与更新，目录布局在 `$DSH_HOME/autostart-workbuddy/`：

```
wb2api/backend/current/   正在用的 wb2api.exe + config.json + installed.json（版本清单）
wb2api/backend/versions/  历史版本，回滚用（保留最近 keepVersions 个）
wb2api/data/              账号凭证与状态：auths/ · state.json · usage.json · request-logs/
wb2api/cache/             下载的 release 包与查询缓存
hub/                      hub 网关的同一套目录（见「后端网关」）
logs/                     两种网关共用的 stdout/stderr 日志
```

老版本插件把 `backend/`、`data/`、`cache/` 直接放在 `autostart-workbuddy/` 下。插件启动时（拉起 wb2api 之前）
会把它们挪进 `wb2api/`，并把 `config.json` 里指向老目录的绝对路径（通常是 `auth_dir`、`state_file`）改成新位置。
先挪进 `wb2api.migrating/`，全部挪完再改名，中途挪不动（例如旧的 wb2api.exe 还被别的进程占着）就全部放回原处，
本次照旧用老位置，日志里留一条警告，下次启动再试。

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

### 更新流程

1. 取最新 release → 选中 `*-windows-amd64.zip`
2. 下载到 `wb2api/cache/`，算 sha256 与 release 的 `checksums.txt` 比对——**没有校验和就拒绝安装**
3. 解压出 `wb2api.exe`，校验它自称的 `vcs.revision` 等于目标 tag 的 commit
4. 停后端（Windows 下运行中的 exe 被锁）→ 旧版本归档到 `wb2api/backend/versions/<旧版本>/` → 新 exe 落到 `current/`
5. 起后端 → 探 `/healthz`（必须返回 `service: workbuddy2api`）
6. 失败自动回滚到上一版本并重启

只停**本插件自己拉起**的进程：如果 7863 上是你手动启动的实例，会拒绝更新并提示先停掉它，绝不误杀。

面板上点「更新」是 1～6 一口气做完；自动更新把它拆成两半（见下）。

### 自动更新

用户多半不会自己去点「更新」，所以默认开着（`backend.autoUpdate`，卡片「后端版本」区也有开关）。两种网关都适用，
实现见 [lib/auto-update.js](lib/auto-update.js)：

1. **运行中，后台**：启动后约 1 分钟查第一次，之后每 `checkTtlMs`（默认 6 小时）查一次。有合格的新版本就做上面的 1～3，
   把校验过的新版本暂存在当前网关的 `cache/` 里，记进 `cache/auto-update.json`。这一步**不停后端、不碰 `current/`**。
2. **下次 DSH 启动，拉起后端之前**：有暂存的新版本就做 4～6 换上。这时后端还没在跑，不会掐断对话；
   新版本健康检查不过照样自动退回原版本。

不在运行中直接换，是因为换版本要停后端，正在输出的对话会断；不等启动时再下载，是因为 hub 的包 30MB+，启动会多等几十秒。
代价是新版本要等下一次重启 DSH 才生效。

什么样的版本会自动装（不满足的只写日志、卡片上说明原因；手动点「更新」不受这些限制）：

- GitHub 的 `releases/latest`（本来就不含预发布），而且版本号比当前的新——不会降级；
- 发布满 `autoUpdateDelayHours`（默认 24 小时）：上游有时一天连发几版，给它留出撤回或补丁的时间；
- 当前版本认得出（有安装记录、tag 是 `x.y.z`），而且没被手动换过：你自己换上的程序不会被覆盖；
- 你手动「回滚」过的那个版本不会再被自动装回去，更新的版本照常；
- 自动安装失败过的版本（包校验不过，或换上后健康检查不过已退回）不再自动重试。下载时的网络错误不算，下一轮重试。

另外：自配 `exe` 的后端、关掉了 `backend.enabled` 的、还没安装的，都不自动更新（首次安装永远由你点）。
端口上是别人起的后端时，暂存的版本这次不换，留到下次启动。面板的手动操作与自动更新共用一把锁，不会同时改同一批文件；
后台下载进行中点「更新」会提示稍候，但切换网关不受影响。

### 安装与卸载

面板那一行按钮按状态切换：**没装**时显示「安装」，**装了**时显示「更新 + 卸载（红色）+ 回滚」。

- **安装**：从最新 release 拉 `windows-amd64` 包装到 `wb2api/backend/current/`。已经装了会拒绝——
  那应该用「更新」（安装只认 release 的产物，不接受任意版本）。
- **卸载**：**二次确认弹窗**之后才执行——停后端，删掉 `wb2api.exe`、历史版本与下载缓存；
  **保留 `config.json` 与 `data/`（账号凭证与状态）**。要连数据一起清，用右侧的「彻底卸载」。
  宿主 Modal 拿不到时会退回卡片内的行内确认，同样是"再点一次才真的删"。
- **彻底卸载**：「卸载」右侧的红色按钮，二次确认后停掉本插件拉起的后端，再删除整个 `~/.dsh/autostart-workbuddy`
  （程序、`config.json`、`data/` 里的凭证、缓存与日志），不可撤销。DSH 卸载插件时不通知插件，插件也分不清卸载与停用、
  重启、更新，所以不会在卸载时自动删；想卸载干净，在「插件」页卸载前先点它。端口被别人的进程占用时拒绝。
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

# 预览模型列表同步会写什么（只读；真正写入在 DSH 里进行）
node lib/sync-cli.js
```

日志按时间戳分文件写在 `logDir`：`wb2api.<时间戳>.out.log` / `.err.log`。

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。

`fixtures/` 下是测试用的假服务；**不要**把它放进 `test/`，否则 Node 的测试运行器会把它当成用例执行，而一个正在 listen 的服务器会让整轮测试挂死。
