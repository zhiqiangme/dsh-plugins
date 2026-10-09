# dsh-autostart-workbuddy

DSH 启动时自动拉起 **WorkBuddy Panel**（`wb2api.exe`），替代手动运行 `scripts/WorkBuddy Panel.ps1` 或 `scripts/Start All.ps1`。

| 服务 | 端点 | 作用 |
| --- | --- | --- |
| WorkBuddy Panel（`wb2api.exe`） | `127.0.0.1:7863` | profile 里 `workbuddy` provider 的上游（`http://127.0.0.1:7863/v1/`） |

联网搜索那个上游（tavily-anthropic-search, 8787）由同级插件 [dsh-autostart-websearch](../dsh-autostart-websearch/) 负责：两个服务各自独立开关、独立日志，任何一个出问题都不影响另一个。

## 行为

- **随 DSH 启动**：插件加载后在后台拉起服务，不阻塞 DSH 启动。
- **幂等**：启动前先探测端口，已在监听就跳过——重复启动只会端口冲突。
- **静默**：不打开 WorkBuddy 管理面板浏览器窗口（需要时自行访问 `http://127.0.0.1:7863/panel/`）。
- **失败不阻断**：起不来只写日志，DSH 本身照常可用；失败时会回收自己拉起的进程，不留僵尸进程。
- **退出即停，但只停自己拉起的**：DSH 退出时结束本插件 spawn 的进程；DSH 启动前就已在运行的服务（手动起的、另一个 DSH 实例留下的）不受影响。
- **只依赖 Node 内置模块**：不注入任何 Host Service，因此不受插件加载顺序影响。

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

## 安装到 profile

在 `~/.dsh/profiles/desktop/package.json` 里加一条依赖和一个 bundle：

```jsonc
{
  "dependencies": {
    "dsh-autostart-workbuddy": "file:D:\\Project\\Test\\dsh-autostart-workbuddy"
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
    exe: D:\Portable\Crack\workbuddy2api-panel\wb2api.exe
    args: ['-config', 'config.json']
    cwd: D:\Portable\Crack\workbuddy2api-panel
    models:
      enabled: true
      only:                     # 留空 = 后端全部模型
        - cn:deepseek-v4.1-flash
        - global:deepseek-v4.1-flash
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；`false` 时完全不拉起（默认 true） |
| `title` | 日志里显示的服务名，默认 `WorkBuddy Panel` |
| `host` / `port` | 就绪探测目标，默认 `127.0.0.1:7863` |
| `exe` | 可执行文件，默认 `D:\Portable\Crack\workbuddy2api-panel\wb2api.exe` |
| `args` | 附加参数，默认 `['-config', 'config.json']` |
| `cwd` | 子进程工作目录，默认 `D:\Portable\Crack\workbuddy2api-panel` |
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
