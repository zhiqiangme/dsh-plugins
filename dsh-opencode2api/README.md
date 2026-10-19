# @zhiqiangme/dsh-opencode2api

让 [opencode2api](https://github.com/jasonxu114514/opencode2api) 随 DSH 启动，沿用本仓库 WorkBuddy 插件的结构。
默认托管独立的 Windows 程序；也可在卡片中切换到 [TiaraBasori/OpenCode2API](https://github.com/TiaraBasori/OpenCode2API) 第二后端，两者无需 Docker 或全局安装 OpenCode CLI。

## 使用

完全退出 DSH（包括托盘），从 npm 安装：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-opencode2api@26.10.19
```

也可以在本仓库从本地源码安装：

```powershell
.\install-plugins.cmd --action install --plugins opencode2api --profiles desktop --yes
```

重新打开 DSH，在「插件 → OpenCode API」中：

1. 点击后端「安装」，从 `jasonxu114514/opencode2api` 最新 GitHub Release 下载对应 Windows x64 / ARM64 产物，核对同一发布中的 `.sha256` 与 Go 构建 revision。装好后卡片自动勾选「同步到 DSH 模型列表」并同步一次（沿用已有的模型勾选）。
2. 点击后端管理页链接。首次登录用户名为 `admin`，点击「复制初始管理密码」获取随机密码；管理页改过密码后使用新密码。
3. 需要时在后端管理页配置 Zen / Go Key。初始配置启用匿名通道；它是否可用取决于上游，并不承诺解决免费层 403。
4. 按需调整模型勾选并「保存并同步」。模型分组为 `OpenCode`，provider id 为 `opencode2api`。

后续更新到 npm 最新版：

```powershell
dsh plugin --profile desktop update --latest @zhiqiangme/dsh-opencode2api
```

Web / CLI 使用 `web` / `headless` profile。后端安装器支持 Windows x64、ARM64；现有外部实例可用自定义 `exe` / `cwd` 接入，版本需自行维护。

## 第二后端（TiaraBasori）

参照 WorkBuddy 插件，在「后端网关」选择 **TiaraBasori**，再点击下方「安装」。切换由宿主重启本插件：先停旧后端，再启动新后端；同一时刻只托管一个，API 端口与 DSH 的 `opencode2api` provider 沿用原设置。原后端默认选中（`gateway: jasonxu`），随时可以切回。

- 首次安装从 GitHub 下载 **main 分支的固定 commit 源码**。上游没有正式 Release，检查更新按 commit 比较，卡片显示 `main-<commit>`；安装记录同时保存上游包版本和源码压缩包的 SHA256。
- Node.js 复用 DSH 自带运行时；安装器下载并校验固定版本的 npm，按源码 `package-lock.json` 安装生产依赖，再从官方 GitHub Release 下载 **OpenCode 1.19.0** Windows x64 / ARM64 ZIP 并核对固定 SHA256。依赖安装禁用生命周期脚本，npm 使用插件自己的缓存；首次安装可能需要几分钟，需能访问 GitHub/codeload 与 npm 官方源。
- OpenCode 版本固定是因为 Tiara 的 SDK 仍使用 1.x 协议。它的程序、配置、缓存和会话放在插件自己的目录，不升级或修改本机全局 OpenCode。
- 管理页改为 API 端口下的 `/panel`（默认 `http://127.0.0.1:8080/panel`），点击「复制面板访问密钥」后粘贴登录。它是只读面板，配置保存在 `tiara/data/config.json`；需要上游 Zen Key 时在该文件配置 `ZEN_API_KEY`，重启插件生效。
- 首次启动会先预热模型目录，默认等待上限为 210 秒；显式配置的 `readinessTimeoutMs` 仍优先。
- 安装在宿主后台运行，卡片显示源码、依赖、运行时下载和首次启动等阶段；下载显示实际字节进度，断线自动重试并保留断点。离开插件页后再进入会恢复同一任务；DSH 退出会中断安装，下次可复用缓存重试。
- 首次启动失败时保留已经安装的程序与版本记录，在卡片点「重试启动」即可，无需重新下载。成功和失败结果会保留；「可安装 / 可更新」仅表示上游版本查询结果。
- 托管启动器对 Tiara 2.5 的流式错误处理做兼容修复，上游 403、配额和连接错误会作为 API 错误透传，不再返回无内容的成功完成。模型目录可见仍不代表当前网络出口获准调用免费模型。
- DSH 把所有 HTTP 401/403 归为本地认证失败，并隐藏详情。因此已通过本地认证的上游访问拒绝使用网关 502 返回具体原因，原始状态保留在 `X-OpenCode-Upstream-Status` 响应头；真正的本地密钥错误仍返回 401。这不会解除上游的出口或账号限制。
- 内部 OpenCode 服务仅监听 `127.0.0.1:10001`，可用 `tiaraServerPort` 修改；已被其他进程占用时拒绝启动。退出、切换、更新时回收本插件拉起的整个进程树。
- 程序更新按整目录替换，支持失败恢复和手动回滚；「卸载」保留 `tiara/data/`。卡片「彻底卸载」清除两套后端及整个插件数据根目录。
- 两种后端的数据各自保留，首次生成 Tiara 本地 Key 时优先沿用原后端本地 Key。模型 ID 可能不同，切换后检查勾选并保存同步。真实推理可用性仍取决于上游限制。

配置示例（放在本插件的 `config` 下）：

```yaml
gateway: tiara          # jasonxu（默认）/ tiara
port: 8080
tiaraServerPort: 10001
```

Tiara 不沿用给 Go 后端设置的 `exe/cwd/args`；原值保留，切回原后端后继续生效。其 `webHost/webPort` 不参与 Tiara 面板地址，面板与 API 共用端口。

命令行排障、更新可加 `--gateway tiara`，例如 `node lib/backend-cli.js --gateway tiara --check`。

## 行为

- 启动和模型同步在后台执行，不阻塞 DSH。后端没安装时保留插件卡片，等待用户点击安装。
- API 默认 `127.0.0.1:8080`，WebUI 默认 `127.0.0.1:8081`。两个端口单独配置；插件不会自动打开浏览器。
- 先探测端口，再验证 `/healthz` 的 opencode2api 响应。占端口的其他服务不会被误当成后端，也不会被结束。
- DSH 退出或停用插件时，只停止该实例自己拉起的进程；外部手动启动的进程保留。
- 后端更新由用户点击；支持保留历史版本、失败回滚、卸载程序。更新不覆盖配置和密钥。
- 模型同步默认关闭，在卡片上装好后端时自动打开；通过 DSH `configEditor` 写配置；只修改自己的 provider 模型列表，保留其他 provider。勾选与同步开关变化不重启后端。
- 开启同步后，除启动时和卡片保存时，运行中每 10 分钟（`models.resyncIntervalMs`，`0` 关闭，最小 1 分钟）再同步一次，跟上后端下架或新增的模型。后端 `/healthz` 未就绪时跳过；后端返回空列表时不清空；某个模型要连续两轮缺席才会移除，避免目录刷新抖动误删。
- 本地 API Key 保存到 DSH 凭据库的 `OPENCODE2API_PROXY_KEY` 引用，profile 中不写密钥明文。它与 Zen / Go 的上游 Key 是不同的凭据。
- 从 `/v1/models` 同步上下文、最大输出、视觉模态和上游声明的思考档位。`System One` 专用模型不导入普通对话选择器；未知价格显示 `—`，价格单位为 USD / 百万 token。
- 展示名按连字符分段、各段首字母大写，例如 `Deepseek-V4.1-Flash-Free`，模型 id 保持不变。选中的模型都支持 Max 时，OpenCode 提供商默认使用 Max；混有不支持 Max 的模型时不强设默认档位。在 DSH 里手动改过的默认档位，只要新清单的模型都支持就保持不变，否则移除。
- 模型列表与 `/healthz` 正常只代表目录和服务状态；真实推理仍可能被上游拒绝或限流。
- 本地 `file:` / `link:` 安装显示「本地安装」，跳过 npm 检查，通过仓库安装脚本更新。npm 安装才检查注册表版本并提供 dshmarket 更新入口。
- 安装脚本会把旧包名 `@zhiqiangme/dsh-autostart-opencode2api` 和旧配置行迁移到新名称，保留模型勾选与同步开关。后端数据目录继续沿用 `~/.dsh/autostart-opencode2api`，保留已安装程序和凭据。

## 配置

在当前 profile 的 `cordis.patch.yml` 中按行 id 覆盖：

```yaml
- id: dsh-opencode2api
  name: '@zhiqiangme/dsh-opencode2api'
  config:
    enabled: true
    host: 127.0.0.1
    port: 8080
    webHost: 127.0.0.1
    webPort: 8081
    readinessTimeoutMs: 30000
    stopTimeoutMs: 5000
    models:
      enabled: false
      only: []                # 空 = 后端全部可用于普通对话的模型
      exclude: []
      efforts: auto           # 按上游声明；也可显式列出档位
      apiKeyRef: OPENCODE2API_PROXY_KEY
      resyncIntervalMs: 600000  # 运行中定时重同步；0 = 关闭
    backend:
      checkOnStart: true      # 只提示，不自动下载
      keepVersions: 3
```

可选 `exe`、`cwd`、`args`、`env`、`logDir`；显式 `exe` 表示外部后端，不在卡片中安装、更新、卸载它。
命令行最终追加 `-listen` 和 `-web-listen`，确保端口与插件配置一致。手动已有实例使用不同管理页地址时可设 `panelUrl`。
`models.baseURL`、`models.panelConfig` 可覆盖目录地址和本地 Key 的配置文件路径；该文件需为标准 JSON。
没有 configEditor 或凭据服务时会跳过模型写入并显示原因，进程托管仍可独立运行。

## 数据与卸载

默认根目录为 `$DSH_HOME/autostart-opencode2api`（`DSH_HOME` 默认 `~/.dsh`），可用 `DSH_OPENCODE2API_BACKEND_ROOT` 覆盖：

```text
backend/current/  opencode2api.exe、config.json、installed.json、后端模型缓存
backend/versions/ 历史 exe
data/             initial-admin.json（初始管理用户名与密码）
cache/            release 查询与下载暂存
logs/             后端标准输出、错误日志
```

初始 `config.json` 生成随机本地 Key 与随机管理密码，仅在文件不存在时创建。上游会把管理密码迁移为哈希；`data/initial-admin.json` 保留初始密码用于手动复制，请按凭据文件保管。
程序和数据不放进 npm 安装目录，插件更新或重装不会丢失配置。

```powershell
dsh plugin --profile desktop remove @zhiqiangme/dsh-opencode2api
```

卸载插件保留后端和配置：DSH 卸载插件时不通知插件，插件也分不清卸载与停用、重启、更新，所以不在卸载时自动删除。卡片「卸载后端」删除 exe、版本与下载缓存，保留 `config.json`、后端状态、`data/` 和日志。卡片「彻底卸载」（在「卸载」右侧）先停掉本插件拉起的后端，再删除整个根目录（含 `config.json`、`data/` 里的凭据和日志），不可撤销；想卸载干净，在「插件」页卸载前先点它。若已同步过模型，卸载后需在 DSH 删除 `opencode2api` provider，并重新选择其他默认模型；本插件不会擅自删除会话或用户模型设置。

第二后端单独使用以下目录；原后端沿用已有布局，无需迁移：

```text
tiara/backend/current/   源码、生产依赖、runtime/ 内的 OpenCode 1.x
tiara/backend/versions/  历史程序目录
tiara/data/              config.json、OpenCode 配置、缓存和会话（切版本保留）
tiara/cache/             安装器、下载缓存、源码版本检查缓存
tiara/installed.json     安装来源与上一版本
```

## 验证与排障

```powershell
node --test test/*.test.mjs
node lib/cli.js --check
node lib/backend-cli.js --check
node lib/sync-cli.js           # 预览模型规划，不写 profile
```

真实 Windows 后端测试可设置 `OPENCODE2API_TEST_EXE` 后运行 `test/native-smoke.test.mjs`；上游被替换为本地假服务，不消耗真实模型额度。
后端不可达时保留原模型配置；403 / 401 等 HTTP 状态会显示为错误，不能据此把空结果写回模型列表。

插件代码采用 [MIT](LICENSE)，由本仓库的 WorkBuddy 插件适配而来；独立下载的原后端 jasonxu114514/opencode2api 使用 GPL-3.0-or-later，TiaraBasori/OpenCode2API 使用 MIT，OpenCode 运行时遵循其自身许可。本 npm 包不包含这些上游程序。
