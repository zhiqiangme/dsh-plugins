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

任何非法值都会退回默认值，不会让插件加载失败。

## 排障

```powershell
# 看插件解析出的实际规格（只读，不启动任何东西）
node lib/cli.js

# 额外校验可执行文件是否存在、端口当前状态
node lib/cli.js --check
```

日志按时间戳分文件写在 `logDir`：`wb2api.<时间戳>.out.log` / `.err.log`。

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。

`fixtures/` 下是测试用的假服务；**不要**把它放进 `test/`，否则 Node 的测试运行器会把它当成用例执行，而一个正在 listen 的服务器会让整轮测试挂死。
