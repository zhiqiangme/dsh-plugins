# dsh-tavily-search

DSH 启动时自动拉起 **tavily-anthropic-search**（联网搜索的上游 shim），替代手动运行 `tavily-anthropic-search/start.ps1` 或 `scripts/Start All.ps1`。

| 服务 | 端点 | 作用 |
| --- | --- | --- |
| tavily-anthropic-search（`server.js`） | `127.0.0.1:8787` | `web-search-deepseek` 的上游（`http://127.0.0.1:8787/v1`） |

WorkBuddy Panel 那个上游（wb2api, 7863）由同级插件 [dsh-autostart-workbuddy](../dsh-autostart-workbuddy/) 负责：两个服务各自独立开关、独立日志，任何一个出问题都不影响另一个。

## 行为

- **随 DSH 启动**：插件加载后在后台拉起服务，不阻塞 DSH 启动。
- **幂等**：启动前先探测端口，已在监听就跳过——重复启动只会端口冲突。
- **静默**：不弹控制台窗口。
- **缺 key 不硬起**：`TAVILY_API_KEY` 缺失时直接失败并说明原因，不去起一个必然搜不到东西的服务。
- **失败不阻断**：起不来只写日志，DSH 本身照常可用；失败时会回收自己拉起的进程，不留僵尸进程。
- **退出即停，但只停自己拉起的**：DSH 退出时结束本插件 spawn 的进程；DSH 启动前就已在运行的服务（手动起的、另一个 DSH 实例留下的）不受影响。
- **只依赖 Node 内置模块**：不注入任何 Host Service，因此不受插件加载顺序影响。

与手动运行 `start.ps1` 的差异：不再经过那层 pwsh 编排（也就没有临时日志目录）。

## 安装到 profile

在 `~/.dsh/profiles/desktop/package.json` 里加一条依赖和一个 bundle：

```jsonc
{
  "dependencies": {
    "dsh-tavily-search": "file:D:\\Project\\DeepSeek Harness\\dsh-tavily-search"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-tavily-search"
      ]
    }
  }
}
```

然后在该目录执行 `pnpm install`（用 DSH 自带的 pnpm），重启 DSH 生效。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-tavily-search
  name: dsh-tavily-search
  config:
    enabled: true
    readinessTimeoutMs: 30000
    stopTimeoutMs: 5000
    port: 8787
    script: D:\Project\Test\tavily-anthropic-search\server.js
    envFile: D:\Project\Test\tavily-anthropic-search\.env
    nodePath: C:\Program Files\nodejs\node.exe
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；`false` 时完全不拉起（默认 true） |
| `title` | 日志里显示的服务名，默认 `tavily-anthropic-search` |
| `host` / `port` | 就绪探测目标，默认 `127.0.0.1:8787`。**若在 `.env` 里改了 `LISTEN_PORT`，这里要同步改** |
| `script` | `server.js` 路径，默认 `D:\Project\Test\tavily-anthropic-search\server.js` |
| `envFile` | `.env` 路径；其中变量只在宿主环境没有同名键时补位 |
| `nodePath` | 跑 `server.js` 的 node 可执行文件；默认取 PATH 里的 `node`，取不到才退回宿主 execPath + `ELECTRON_RUN_AS_NODE` |
| `args` | 附加参数（会拼在 `server.js` 之后） |
| `cwd` | 子进程工作目录，默认 `D:\Project\Test\tavily-anthropic-search` |
| `env` | 追加到子进程环境的键值对（不会改写 DSH 自己的环境） |
| `logDir` | 日志目录，默认 `$DSH_HOME/autostart-websearch/logs` |
| `logName` | 日志文件名前缀，默认 `tavily-shim` |
| `readinessTimeoutMs` | 等待端口就绪的上限，默认 30000 |
| `stopTimeoutMs` | 停止时等待退出的上限，默认 5000；超时后强制结束 |

任何非法值都会退回默认值，不会让插件加载失败。

## 排障

```powershell
# 看插件解析出的实际规格（只读，不启动任何东西）
node lib/cli.js

# 额外校验 node / server.js / .env 是否存在、key 是否就绪、端口当前状态
node lib/cli.js --check
```

日志按时间戳分文件写在 `logDir`：`tavily-shim.<时间戳>.out.log` / `.err.log`。

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。

`fixtures/` 下是测试用的假服务；**不要**把它放进 `test/`，否则 Node 的测试运行器会把它当成用例执行，而一个正在 listen 的服务器会让整轮测试挂死。
