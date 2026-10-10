# dsh-tavily-search

用 **Tavily** 给 DSH 的「网页搜索」供数。

DSH 自带的搜索提供方（`@deepseek-ai/dsh-web-search-deepseek`）向「接口地址」发 Anthropic Messages 请求，
只解析响应里的 `web_search_tool_result` 结构化块。本插件在 **DSH 进程内**监听 `127.0.0.1:8787`，
把这类请求转成一次 Tavily 检索，再合成提供方能解析的响应——不调用任何模型。

```
DSH 网页搜索 ── POST http://127.0.0.1:8787/v1/messages ──▶ 本插件（DSH 进程内） ── POST /search ──▶ Tavily
            ◀── server_tool_use + web_search_tool_result + 引用摘要 ──
```

把 DSH「插件 → 网页搜索」的**接口地址**设为 `http://127.0.0.1:8787/v1` 即接入。

## 行为

- **进程内监听**：随插件加载监听、随插件卸载关闭，没有外部进程；出站请求走 DSH 的代理策略。
- **不抢端口**：端口上已有同类适配服务（例如手动起的旧 `server.js`）时只记日志，DSH 的请求由它处理；
  端口被别的程序占着时记错误日志。插件重载时会先等约 2s，让上一个实例释放端口。
- **失败不阻断**：监听不上只写日志，DSH 本身照常可用。
- **API Key 存在 DSH 凭据库**：引用名默认 `TAVILY_API_KEY`，值在 `~/.dsh/.credentials.yaml`，不写进任何设置文件。
  每次请求现取，改 key 不用重启；缺 key 时搜索返回明确的错误，提示去哪里填写。
- **只依赖 Node 内置模块**：不声明 Host Service 依赖；凭据服务缺席时退回同名环境变量。

## 安装到 profile

在 `~/.dsh/profiles/desktop/package.json` 里加一条依赖和一个 bundle（也可以用仓库根目录的接线脚本）：

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

> `file:` 依赖是**拷贝**进 profile 的 `node_modules`，改了本目录的代码后要重新 `pnpm install --force` 才会生效。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（全部可省略）：

```yaml
- id: dsh-tavily-search
  name: dsh-tavily-search
  config:
    port: 8787
    maxResults: 8
    searchDepth: basic
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 只有显式 `false` 才不监听 |
| `host` / `port` | `127.0.0.1` / `8787` | 监听地址；改了端口要同步改网页搜索的接口地址 |
| `apiKeyRef` | `TAVILY_API_KEY` | 凭据引用名（环境变量名形状） |
| `importEnvFile` | 空 | 一次性导入：凭据库里还没有 key 时，从这个 `.env` 里取同名变量写进凭据库 |
| `tavilyBaseUrl` | `https://api.tavily.com` | Tavily 端点，测试时可指向 mock |
| `maxResults` | `8` | 单次检索返回条数 |
| `searchDepth` | 空 | `basic` / `advanced`，留空用 Tavily 默认档 |
| `timeoutMs` | `30000` | 单次 Tavily 调用超时，超时按 502 返回 |
| `maxQueryChars` | `600` | 检索词长度上限，超出 400 |
| `shimApiKey` | 空 | 非空时校验调用方的 `x-api-key` / `Bearer` |

任何非法值都会退回默认值，不会让插件加载失败。

## 独立运行

不开 DSH 也能起一个同样的接口（排障、给别的客户端用）。没有凭据库，key 从环境变量读，
变量名沿用旧 `tavily-anthropic-search`（`TAVILY_API_KEY`、`LISTEN`、`TAVILY_MAX_RESULTS`、`TAVILY_SEARCH_DEPTH`……）：

```powershell
$env:TAVILY_API_KEY = 'tvly-…'
node lib/cli.js                  # 前台监听，Ctrl+C 退出
node lib/cli.js --print-config   # 只打印解析出的配置
```

## 来源

适配服务（`lib/shim.js`）移植自 `D:\Project\Test\tavily-anthropic-search\server.js`（Test 仓库提交 `242449c`），
响应结构契约与那边的 README 一致。旧目录不再被本插件引用，可以保留作参考，也可以删除。

## 测试

```powershell
node --test test/*.test.mjs
```

注意别写 `node --test test/`：Node 24 会把目录参数当成模块去 require，直接报 `MODULE_NOT_FOUND`。
`test/helpers.mjs` 不带 `.test`，不会被当成用例执行。
