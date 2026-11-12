# @zhiqiangme/dsh-tavily-search

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：用 **Tavily** 给 DSH 的「网页搜索」供数。

## DSH 0.2.2-rc.2

1. 首次安装并加载后，使用 DSH 默认搜索配置的 profile 会自动选择 **Tavily**。已有搜索提供方选择或旧版接入配置的用户，可在 Tavily 卡片里点「接入网页搜索」，或到「网页搜索与获取」手动选择。
2. 在「插件 → Tavily 联网搜索 → API Key」添加密钥。升级时可沿用 DSH 凭据库中已保存的 Tavily 密钥。
3. 在 Tavily 卡片的「搜索接口」页签点「测试搜索」，确认 Tavily 能返回结果。

DSH 直接调用 Tavily 提供方（`dsh-tavily-search`）。「恢复默认」会恢复 profile 的默认搜索提供方，之后重启也会沿用该选择。网页获取在内置页面独立配置。原生搜索使用插件的 `maxResults` 及 DSH `web_search` 的结果上限。

## 旧版 DSH

插件在 DSH 进程内监听 `127.0.0.1:8787`，给旧宿主提供两套兼容接口：

- 旧版 `@deepseek-ai/dsh-web-search-deepseek`：向「接口地址」发 Anthropic Messages 请求，
  只解析响应里的 `web_search_tool_result` 结构化块；
- DSH 0.2.1-rc.2 的 `@deepseek-ai/dsh-web-deepseek-api`：向「基础地址」发 Search API 请求，
  解析 `{results:[{url,title,snippet,date}]}`。

```
DSH 网页搜索 ─ 旧版 POST /v1/messages ─────┐
             ─ 新版 POST /v1/tools/search ┴─▶ 本插件（DSH 进程内） ── POST /search ──▶ Tavily
             ◀── 对应协议的搜索结果 ──
```

在插件页卡片里点「接入网页搜索」即可：新版开关关着时把网页搜索的**接口地址**设为 `http://127.0.0.1:8787/v1`；
开关打开时把 **Search API 基础地址**设为 `http://127.0.0.1:8787/v1/tools`。两种情况都会让网页搜索改读
本插件的占位凭据（原因见下文）。

## 插件页卡片

在 DSH「插件 → Tavily 联网搜索」里有一张配置卡片。头部汇总 API Key、接入、接口与版本的状态，点击可跳到对应页签；内容分「API Key」「网页搜索」「搜索接口」「插件」四个页签，其中「插件」页签放插件更新与清除插件数据。各区块如下：

| 区块 | 做什么 | 走哪条通道 |
| --- | --- | --- |
| **API Key** | 可添加多个 Tavily API Key（最多 10 个），逐个列出、各自单独删除（删除前二次确认）；列表只显示末 4 位用于辨认，从不回显完整值 | 写入 / 删除走 DSH 凭据库（`remote.credentials`），与内置「网页搜索」页同一条路；列表走宿主半侧路由 `/plugins/dsh-tavily-search/keys` |
| **网页搜索接入** | 接入 Tavily 或恢复默认搜索。旧宿主通过兼容接口接入 | 新宿主写入 `web.searchProvider`；旧宿主用搜索接口地址与占位凭据 |
| **插件更新** | 显示当前运行版本与 npm 最新版本，可通过 DSH 官方插件管理器一键更新到兼容正式版 | `/plugins/dsh-tavily-search/version` 查询 npm 官方源与 npmmirror，取较高版本并缓存 10 分钟。`pluginManager.listBundles/listVersions` 确定更新资格、目标版本和注册表，`updateBundle` 执行安装 |
| **搜索接口** | 「测试搜索」调用 Tavily。旧宿主会显示本地兼容接口状态，并通过该接口测试 | 宿主半侧路由 `/plugins/dsh-tavily-search/status`、`/test` |
| **清除插件数据** | 卸载前可删除卡片里保存的 Tavily API Key，并撤销网页搜索接入。环境变量等只读来源需要在外部清理 | 凭据库与网页搜索设置 |

旧版接入和插件更新说明：

- **为什么要改凭据引用**：DSH 的网页搜索在它那栏 API Key（`apiKeyEnv` 指向的凭据，默认 `DEEPSEEK_API_KEY`）为空时
  直接报错、不发请求（DeepSeek 账号模型除外），而 `DEEPSEEK_API_KEY` 同时是 DeepSeek 聊天的 key——
  在网页搜索页随便填一个值会覆盖聊天 key，借用聊天 key 又会把真 key 发给本机接口。
  所以接入时卡片先写入占位凭据 `DSH_TAVILY_SEARCH_PLACEHOLDER`（值 `dsh-tavily-search`，本插件默认不校验），
  再把 `apiKeyEnv` 与接口地址一次改指向本插件。之后内置网页搜索页那栏显示的就是这个占位凭据，不用再填。
- 恢复默认时只撤销本插件写的覆盖（接口地址、凭据引用），并删掉占位凭据，网页搜索回到 DeepSeek 官方接口与 `DEEPSEEK_API_KEY`。
  不会让网页搜索指向 Tavily 的 key。
- **Web 搜索 API 开关（DSH 0.2.1-rc.2）**：内置网页搜索页的「启用新版 Web 搜索 API」打开后把
  `web.searchProvider` / `web.fetchProvider` 设为 `deepseek-search-api` / `deepseek-fetch-api`，搜索改走
  `web-deepseek-api`（默认 `https://api.deepseek.com/v1/tools/search`）。卡片读同一个 `web` 设置命名空间：
  开关打开时，「网页搜索接入」改为操作 `web-deepseek-api` 的**基础地址**——接入后是
  `http://127.0.0.1:8787/v1/tools`，本插件按新版 Search API 的请求/响应形状返回 Tavily 结果；同时把抓取提供方
  从开关配对写入的 `deepseek-fetch-api` 改成本地 HTTP（`http`），网页抓取仍由 DSH 自己完成，不消耗 Tavily 额度。
  开关关闭时沿用原来的 Messages 接入（`web-search-deepseek` 接口地址 + 占位凭据）。
  两套接入互不影响：开关切到哪一侧，卡片就把那一侧接到本插件；「恢复默认」只撤销本插件写过的覆盖，不碰开关本身。
  0.2.1-rc.1 及更早没有这个开关（`web` 命名空间不下发），卡片照旧只看 Messages 接口地址。
  搜索提供方被别的插件占用时标「已被占用」，点「接入网页搜索」会接回本插件（装了新版搜索插件时接新版 API）。
- 本插件**只模拟新版 Search API**，不模拟 `/fetch`（新版 Fetch API 的抓取）：那样网页抓取也会改走
  Tavily Extract、消耗 Tavily 额度，抓取行为也跟着变。所以新版接入会把抓取提供方改成本地 HTTP；
  万一把抓取提供方又切回 `deepseek-fetch-api`，抓取请求会打到本插件的 `/fetch` 并得到明确的拒绝说明，
  卡片同时显示「待修复」，点「修复接入」即可改回本地 HTTP。
- 配了 `shimApiKey` 时，接入后在内置网页搜索页的 API Key 栏填同一个值（写进占位凭据）；卡片再次接入不会覆盖它。
- 密钥输入框用宿主的 `SettingsSecretField`（与内置网页搜索页同款）；宿主组件拿不到时退回自带的同款输入框。
- 一键更新使用 DSH 的官方插件管理器。卡片先用 `listBundles` 核对本插件的 `updatable`，再用 `listVersions` 选最新的兼容、
  未弃用正式版，把精确版本和同一注册表交给 `updateBundle`。兼容性检查、锁、安装与失败时恢复旧版都由宿主处理。
  卡片展示核对、卸载、安装、恢复阶段，并按结果提示是否需要重启。只有实际安装版本等于目标版本才显示成功。
  恢复失败或连接中断时，卡片会提示核对实际安装状态。
- `listVersions` 每次要在宿主上跑一串 `pnpm view`，所以 npm 显示已是最新时不去列，列过的结果按已装版本缓存 10 分钟；
  「检查更新」两者都绕过。npm 落后于宿主注册表这种少见情况，点「检查更新」即可看到官方给出的新版本。
- 宿主的插件管理器每完成一次操作都会广播变更（包括在官方插件页里更新本插件），卡片据此静默重读实际安装状态。
- 宿主在卸载步骤报 `bundle-in-use`（热重载后本插件仍在运行，DSH 拒绝卸下）时，没有安装新版本，旧版照常运行，卡片说明原因并展开指定版本重装入口。
  宿主此时已把本插件移出 `dsh.profile.bundles` 且不撤回，卡片会用 `setBundleEnabled` 补回；补回失败时提示在重启前手动启用。
- 有新版本时，卡片会说明无法一键更新的原因，例如本地安装、托管安装、缺少官方更新接口或没有兼容版本。
- 旧宿主缺少官方接口时，可升级 DSH 或在 DSH「插件」页按指定版本重新安装。遇到 `bundle-in-use` 时也会展开重装指引。
  复制卡片给出的 `@zhiqiangme/dsh-tavily-search@版本号`，在本插件详情页先关闭组件，再卸载并在「添加插件」中粘贴，
  装好后重新打开组件。保留插件数据即可沿用 API Key 与搜索配置，安装后按宿主提示重启。
- 本地 `file:/link:` 安装请更新源码并重新运行安装脚本；宿主托管或其他不具备更新资格的安装不显示一键更新。
- 两处卡片共享更新任务。整页刷新或插件热重载后，卡片重新读取运行版本与实际安装状态。
  宿主启用 HMR 时，更新会先卸下本插件，卡片随之重载，结果以重载后读到的安装版本为准。

## 行为

- **进程内监听**：随插件加载监听、随插件卸载关闭，没有外部进程；出站请求走 DSH 的代理策略。
- **两种协议同一个端口**：`POST /v1/messages`（旧版 Messages，兼容 `/anthropic/v1/messages`）、
  `POST /v1/tools/search`（新版 Search API，兼容 `/tools/search`、`/search`）。新版 Search API 的 `count`
  不会突破插件配置的 `maxResults`；每条结果都补齐 `title` / `snippet` / `date` 字段（DSH 的解析器要求字段存在）。
  `POST .../fetch`（新版 Fetch API）返回 501 并说明「本插件只提供搜索」，不调用 Tavily。
- **搜索接口只供宿主 / CLI 调用**：带 `Origin` 或跨站 Fetch 标记的浏览器请求返回 403，避免网页借本机接口消耗 Tavily 额度。
  插件卡片的「测试搜索」通过宿主面板路由转发，照常可用（按当前通道发对应协议的形状）。
- **不抢端口**：端口上已有同类适配服务（例如用下文"独立运行"起的实例）时只记日志，DSH 的请求由它处理；
  端口被别的程序占着时记错误日志。插件重载时会先等约 2s，让上一个实例释放端口。
- **失败不阻断**：监听不上只写日志，DSH 本身照常可用。
- **API Key 存在 DSH 凭据库**：引用名默认 `TAVILY_API_KEY`，值在 `~/.dsh/.credentials.yaml`，不写进任何设置文件。
  每次请求现取，改 key 不用重启；缺 key 时搜索返回明确的错误，提示去哪里填写。
- **多个 key**：第 1 个是 `TAVILY_API_KEY`，其余依次是 `TAVILY_API_KEY_2` … `TAVILY_API_KEY_10`。请求间轮流使用，
  均摊各 key 的额度；某个 key 被 Tavily 拒绝（401 / 403 / 429 / 432 / 433：无效、禁用、限流、额度用尽）时当场换下一个重试。
  5xx、网络错误、超时与 key 无关，不换 key 重试。
- **只依赖 Node 内置模块**：不声明 Host Service 依赖；凭据服务缺席时退回同名环境变量。

## 安装到 profile

从 npm 安装：先**完全退出** DSH 桌面版，然后在终端运行（`dsh` 命令随 DSH 桌面版一起安装），重新打开 DSH 生效：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-tavily-search
# 更新：dsh plugin --profile desktop update --latest @zhiqiangme/dsh-tavily-search
# 刚发布的版本：用查到的明确版本重新 add，例如
dsh plugin --profile desktop add @zhiqiangme/dsh-tavily-search@26.10.18
```

装到 Web / CLI 就把 `desktop` 换成 `web` / `headless`。更新要带 `--latest`：版本号按日期编排（`26.10.11`），
跨年时主版本号会变。更多说明见[仓库 README](https://github.com/zhiqiangme/dsh-plugins#从-npm-安装推荐)。
上面的 `26.10.18` 是示例；实际使用卡片查到的 npm 最新版，或运行 `npm view @zhiqiangme/dsh-tavily-search version` 查询。
命令行 `add 包名@版本` 可更新已有依赖。图形界面可在 DSH 的插件详情页使用内置「版本」区块，
也可在本插件的设置卡片里调用同一个官方 `updateBundle` 接口。

从源码安装：克隆[仓库](https://github.com/zhiqiangme/dsh-plugins)后双击根目录的 `install-plugins.cmd`，
按提示选择插件和 profile（说明见[仓库 README](https://github.com/zhiqiangme/dsh-plugins#从源码安装)），完成后重启 DSH 生效。
改了本目录的代码后再运行一次同样的"安装 / 更新"即可换上新代码。

手动安装等价于（先完全退出桌面版）：

```powershell
dsh plugin --profile desktop add "file:<仓库路径>\dsh-tavily-search"
```

> `file:` 依赖是**拷贝**进 profile 的 `node_modules`，改了代码后再 `add`（包括 `--force`）pnpm 都认为"已是最新"，
> 要先 `dsh plugin --profile desktop remove @zhiqiangme/dsh-tavily-search` 再 `add`。安装脚本会比对文件哈希自动做这一步。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（全部可省略）：

```yaml
- id: dsh-tavily-search
  name: '@zhiqiangme/dsh-tavily-search'   # 包名以 @ 开头，YAML 里必须加引号
  config:
    port: 8787
    maxResults: 8
    searchDepth: basic
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 时关闭提供方与兼容接口 |
| `host` / `port` | `127.0.0.1` / `8787` | 兼容接口的监听地址；旧宿主使用自定义端口时需同步修改搜索接口地址 |
| `apiKeyRef` | `TAVILY_API_KEY` | 第 1 个 key 的凭据引用名（环境变量名形状）；其余 key 为 `<apiKeyRef>_2` … `_10` |
| `importEnvFile` | 空 | 一次性导入：凭据库里还没有 key 时，从这个 `.env` 里取同名变量写进凭据库 |
| `tavilyBaseUrl` | `https://api.tavily.com` | Tavily 端点，测试时可指向 mock |
| `maxResults` | `8` | 单次检索返回条数；新版 Search API 的 `count`（网页搜索页「每次搜索结果数」）以它为上限 |
| `searchDepth` | 空 | `basic` / `advanced`，留空用 Tavily 默认档 |
| `timeoutMs` | `30000` | 单次 Tavily 调用超时，超时按 502 返回 |
| `maxQueryChars` | `600` | 检索词长度上限，超出 400 |
| `shimApiKey` | 空 | 非空时校验调用方的 `x-api-key` / `Bearer` |

任何非法值都会退回默认值，不会让插件加载失败。

## 独立运行

不开 DSH 也能起一个同样的接口（排障、给别的客户端用）。没有凭据库，配置从环境变量读
（`TAVILY_API_KEY`，多个 key 再加 `TAVILY_API_KEY_2` …；`LISTEN`、`TAVILY_MAX_RESULTS`、`TAVILY_SEARCH_DEPTH`……）。
旧版客户端打 `/v1/messages`；新版客户端把 Search API 基础地址设为 `http://127.0.0.1:<port>/v1/tools`：

```powershell
$env:TAVILY_API_KEY = 'tvly-…'
node lib/cli.js                  # 前台监听，Ctrl+C 退出
node lib/cli.js --print-config   # 只打印解析出的配置
```

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。
`test/helpers.mjs` 不带 `.test`，不会被当成用例执行。
