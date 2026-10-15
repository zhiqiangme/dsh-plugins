# @zhiqiangme/dsh-autostart-opencode2api

让 [opencode2api](https://github.com/jasonxu114514/opencode2api) 随 DSH 启动，沿用本仓库 WorkBuddy 插件的结构。
它托管独立的 Windows 程序，无需 Docker 或本机 OpenCode CLI。

## 使用

当前先从本地源码安装：完全退出 DSH（包括托盘），在本仓库运行：

```powershell
.\install-plugins.cmd --action install --plugins opencode2api --profiles desktop --yes
```

重新打开 DSH，在「插件 → OpenCode API 自动启动」中：

1. 点击后端「安装」，从 `jasonxu114514/opencode2api` 最新 GitHub Release 下载对应 Windows x64 / ARM64 产物，核对同一发布中的 `.sha256` 与 Go 构建 revision。
2. 点击后端管理页链接。首次登录用户名为 `admin`，点击「复制初始管理密码」获取随机密码；管理页改过密码后使用新密码。
3. 需要时在后端管理页配置 Zen / Go Key。初始配置启用匿名通道；它是否可用取决于上游，并不承诺解决免费层 403。
4. 勾选「同步到 DSH 模型列表」，选择模型并「保存并同步」。模型分组为 `OpenCode`，provider id 为 `opencode2api`。

包名预留为 `@zhiqiangme/dsh-autostart-opencode2api`，**本次开发未发布 npm**；发布后可用：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-autostart-opencode2api
```

Web / CLI 使用 `web` / `headless` profile。后端安装器支持 Windows x64、ARM64；现有外部实例可用自定义 `exe` / `cwd` 接入，版本需自行维护。

## 行为

- 启动和模型同步在后台执行，不阻塞 DSH。后端没安装时保留插件卡片，等待用户点击安装。
- API 默认 `127.0.0.1:8080`，WebUI 默认 `127.0.0.1:8081`。两个端口单独配置；插件不会自动打开浏览器。
- 先探测端口，再验证 `/healthz` 的 opencode2api 响应。占端口的其他服务不会被误当成后端，也不会被结束。
- DSH 退出或停用插件时，只停止该实例自己拉起的进程；外部手动启动的进程保留。
- 后端更新由用户点击；支持保留历史版本、失败回滚、卸载程序。更新不覆盖配置和密钥。
- 模型同步默认关闭，通过 DSH `configEditor` 写配置；只修改自己的 provider 模型列表，保留其他 provider。勾选与同步开关变化不重启后端。
- 本地 API Key 保存到 DSH 凭据库的 `OPENCODE2API_PROXY_KEY` 引用，profile 中不写密钥明文。它与 Zen / Go 的上游 Key 是不同的凭据。
- 从 `/v1/models` 同步上下文、最大输出、视觉模态和上游声明的思考档位。`System One` 专用模型不导入普通对话选择器；未知价格显示 `—`，价格单位为 USD / 百万 token。
- 模型列表与 `/healthz` 正常只代表目录和服务状态；真实推理仍可能被上游拒绝或限流。
- 插件自身版本检查和 dshmarket 更新入口沿用 WorkBuddy 卡片；本地 `file:` 安装通过仓库安装脚本更新。

## 配置

在当前 profile 的 `cordis.patch.yml` 中按行 id 覆盖：

```yaml
- id: dsh-autostart-opencode2api
  name: '@zhiqiangme/dsh-autostart-opencode2api'
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
dsh plugin --profile desktop remove @zhiqiangme/dsh-autostart-opencode2api
```

卸载插件保留后端和配置。卡片「卸载后端」删除 exe、版本与下载缓存，保留 `config.json`、后端状态、`data/` 和日志。若已同步过模型，卸载后需在 DSH 删除 `opencode2api` provider，并重新选择其他默认模型；本插件不会擅自删除会话或用户模型设置。

## 验证与排障

```powershell
node --test test/*.test.mjs
node lib/cli.js --check
node lib/backend-cli.js --check
node lib/sync-cli.js           # 预览模型规划，不写 profile
```

真实 Windows 后端测试可设置 `OPENCODE2API_TEST_EXE` 后运行 `test/native-smoke.test.mjs`；上游被替换为本地假服务，不消耗真实模型额度。
后端不可达时保留原模型配置；403 / 401 等 HTTP 状态会显示为错误，不能据此把空结果写回模型列表。

插件代码采用 [MIT](LICENSE)，由本仓库的 WorkBuddy 插件适配而来；独立下载的上游 opencode2api 使用 GPL-3.0-or-later，遵循其自身许可。本 npm 包不包含上游二进制。
