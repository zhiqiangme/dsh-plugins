# @zhiqiangme/dsh-tavily-search

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：用 **Tavily** 给 DSH 的「网页搜索」供数。

DSH 自带的搜索提供方（`@deepseek-ai/dsh-web-search-deepseek`）向「接口地址」发 Anthropic Messages 请求，
只解析响应里的 `web_search_tool_result` 结构化块。本插件在 **DSH 进程内**监听 `127.0.0.1:8787`，
把这类请求转成一次 Tavily 检索，再合成提供方能解析的响应——不调用任何模型。

```
DSH 网页搜索 ── POST http://127.0.0.1:8787/v1/messages ──▶ 本插件（DSH 进程内） ── POST /search ──▶ Tavily
            ◀── server_tool_use + web_search_tool_result + 引用摘要 ──
```

在插件页卡片里点「接入网页搜索」即可：它把 DSH「插件 → 网页搜索」的**接口地址**设为 `http://127.0.0.1:8787/v1`，
并让网页搜索改读本插件的占位凭据（原因见下文）。

## 插件页卡片

在 DSH「插件 → Tavily 联网搜索」里有一张配置卡片，分五块：

| 区块 | 做什么 | 走哪条通道 |
| --- | --- | --- |
| **API Key** | 可添加多个 Tavily API Key（最多 10 个），逐个列出、各自单独删除（删除前二次确认）；列表只显示末 4 位用于辨认，从不回显完整值 | 写入 / 删除走 DSH 凭据库（`remote.credentials`），与内置「网页搜索」页同一条路；列表走宿主半侧路由 `/plugins/dsh-tavily-search/keys` |
| **搜索接口** | 显示 `127.0.0.1:8787/v1` 的状态（运行中 / 外部实例 / 端口被占用 / 启动失败）；「测试搜索」按 DSH 的请求形状真打一次 | 宿主半侧路由 `/plugins/dsh-tavily-search/status`、`/test` |
| **网页搜索接入** | 显示「网页搜索」当前的接口地址；未接入时一键把接口地址改成本插件的端点、凭据引用改成本插件的占位凭据，已接入时可恢复默认；只改了接口地址的旧版接入显示「待修复」 | `configForms.get('web-search-deepseek')`，即内置网页搜索页编辑的同一个设置命名空间；占位凭据走 `remote.credentials` |
| **清除插件数据** | 卸载本插件前点一下：二次确认后删除卡片里保存的全部 Tavily API Key，并把网页搜索里本插件写的接口地址与凭据引用恢复为 DSH 默认（卸载后 `127.0.0.1:8787` 没人监听，不恢复的话网页搜索会失败）。环境变量等只读来源的 key 只提示、不删。没有可清的内容时整块不显示 | 删 key 走 `remote.credentials.unset`，恢复走 `configForms.get('web-search-deepseek')`，与上面两块同一条路 |
| **插件更新** | 显示当前运行版本与 npm 最新版本；装了 [dshmarket](https://www.npmjs.com/package/dshmarket) 时一键更新并显示进度，没装时只提示有新版本 | 版本检查走宿主半侧路由 `/plugins/dsh-tavily-search/version`（同时问 npm 官方源与 npmmirror，取较高者，缓存 10 分钟）；更新走 dshmarket 的公开更新 API v1 |

几点说明：

- **为什么要改凭据引用**：DSH 的网页搜索在它那栏 API Key（`apiKeyEnv` 指向的凭据，默认 `DEEPSEEK_API_KEY`）为空时
  直接报错、不发请求（DeepSeek 账号模型除外），而 `DEEPSEEK_API_KEY` 同时是 DeepSeek 聊天的 key——
  在网页搜索页随便填一个值会覆盖聊天 key，借用聊天 key 又会把真 key 发给本机接口。
  所以接入时卡片先写入占位凭据 `DSH_TAVILY_SEARCH_PLACEHOLDER`（值 `dsh-tavily-search`，本插件默认不校验），
  再把 `apiKeyEnv` 与接口地址一次改指向本插件。之后内置网页搜索页那栏显示的就是这个占位凭据，不用再填。
- 恢复默认时只撤销本插件写的覆盖（接口地址、凭据引用），并删掉占位凭据，网页搜索回到 DeepSeek 官方接口与 `DEEPSEEK_API_KEY`。
  不会让网页搜索指向 Tavily 的 key。
- 配了 `shimApiKey` 时，接入后在内置网页搜索页的 API Key 栏填同一个值（写进占位凭据）；卡片再次接入不会覆盖它。
- 密钥输入框用宿主的 `SettingsSecretField`（与内置网页搜索页同款）；宿主组件拿不到时退回自带的同款输入框。
- 一键更新不自己跑 pnpm：DSH 自带的插件管理器不支持升级已安装的插件，本插件把更新交给 dshmarket，
  由它处理 profile 锁、文件占用、回滚与版本核对。桌面版更新完成后要**重启 DSH** 才会换上新代码
  （桌面版的重启归桌面壳管，卡片不提供重启按钮）。新版本刚发布时可能被 pnpm 的发布冷却期挡下，卡片会给出「强制更新」。
- 一键更新只对从 npm 安装的情况有效。从本地目录（`file:`）装时 dshmarket 拒绝更新（`locally linked plugins update from their checkout`），
  卡片会先向 dshmarket 查询安装来源，这种情况下不显示更新按钮，改为提示：拉取新代码后重新安装，或改为从 npm 安装。

## 行为

- **进程内监听**：随插件加载监听、随插件卸载关闭，没有外部进程；出站请求走 DSH 的代理策略。
- **搜索接口只供宿主 / CLI 调用**：带 `Origin` 或跨站 Fetch 标记的浏览器请求返回 403，避免网页借本机接口消耗 Tavily 额度。
  插件卡片的「测试搜索」通过宿主面板路由转发，照常可用。
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
```

装到 Web / CLI 就把 `desktop` 换成 `web` / `headless`。更新要带 `--latest`：版本号按日期编排（`26.10.11`），
跨年时主版本号会变。更多说明见[仓库 README](https://github.com/zhiqiangme/dsh-plugins#从-npm-安装推荐)。

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
| `enabled` | `true` | 只有显式 `false` 才不监听 |
| `host` / `port` | `127.0.0.1` / `8787` | 监听地址；改了端口要同步改网页搜索的接口地址 |
| `apiKeyRef` | `TAVILY_API_KEY` | 第 1 个 key 的凭据引用名（环境变量名形状）；其余 key 为 `<apiKeyRef>_2` … `_10` |
| `importEnvFile` | 空 | 一次性导入：凭据库里还没有 key 时，从这个 `.env` 里取同名变量写进凭据库 |
| `tavilyBaseUrl` | `https://api.tavily.com` | Tavily 端点，测试时可指向 mock |
| `maxResults` | `8` | 单次检索返回条数 |
| `searchDepth` | 空 | `basic` / `advanced`，留空用 Tavily 默认档 |
| `timeoutMs` | `30000` | 单次 Tavily 调用超时，超时按 502 返回 |
| `maxQueryChars` | `600` | 检索词长度上限，超出 400 |
| `shimApiKey` | 空 | 非空时校验调用方的 `x-api-key` / `Bearer` |

任何非法值都会退回默认值，不会让插件加载失败。

## 独立运行

不开 DSH 也能起一个同样的接口（排障、给别的客户端用）。没有凭据库，配置从环境变量读
（`TAVILY_API_KEY`，多个 key 再加 `TAVILY_API_KEY_2` …；`LISTEN`、`TAVILY_MAX_RESULTS`、`TAVILY_SEARCH_DEPTH`……）：

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
