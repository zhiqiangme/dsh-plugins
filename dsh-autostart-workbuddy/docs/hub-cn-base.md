# workbuddy2api-hub：国内版上游地址需要怎么改

对照版本：[ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) `59759d7`（v1.7.14，2026-10-18）。
行号都按这个提交算。

## 问题

hub 和 wb2api 有同一个问题：国内版上游写死成 `https://copilot.tencent.com`。

2026-10-18 在 Clash 全局模式（TUN、洛杉矶出口）下实测：

- 到 `copilot.tencent.com` 的 TLS 握手每次都被复位（curl / Node / Go / OpenSSL 都一样）；
- `www.workbuddy.cn`、`www.codebuddy.cn` 正常可达；
- 用同一个 CN 账号、换成 `https://www.workbuddy.cn` 作 base：模型目录返回 20 个模型，`/v2/chat/completions` 200 正常流式输出；
- 官方 WorkBuddy 桌面端当前用的就是 `endpoint: https://www.workbuddy.cn`。

wb2api 那边的修法（PR [linguo2625469/workbuddy2api-panel#220](https://github.com/linguo2625469/workbuddy2api-panel/pull/220)）是加一个 `cn.chat_base` 配置。
hub 要支持同样的场景，需要一个等价的开关。

## hub 里和国内版地址相关的地方

| 位置 | 内容 | 用在哪 |
| --- | --- | --- |
| `wb_accounts.py:242-247` | `REALM_CONFIGS["cn"]` 的 `chat_upstream` / `domain` | 刷新 token（`:1527`）、浏览器登录三步（`:3764` `:3795` `:3820`）、签到（`:2111`）、远程配置与模型目录（`wb_proxy.py:10913` `:14082`）、账号缺省 domain（`:421` `:585` `:3832` `:3992`） |
| `wb_identity.py:205,207` | `_ENDPOINTS[("cn", desktop)]`、`_ENDPOINTS[("cn", cli)]` | 对话请求的 base 与 `X-Domain`（经 `wb_accounts.py:1512` 的 `endpoint_for`） |
| `wb_identity.py:206` | `_ENDPOINTS[("cn", vscode)]` = `www.workbuddy.cn` | **已经**走新域，不用改 |
| `wb_tasks.py:18` | `CHAT_BASE` | 成长任务、能量、连登、抽奖、猫猫旅行、`/v2/report` 上报 |
| `wb_accounts.py:2111` | `cfg.get("chat_upstream", "https://copilot.tencent.com")` | 兜底值；`cfg` 改了这里自然跟着改 |
| `wb_proxy.py:20875` | 启动日志里显示的出口域 | 只影响显示 |
| `wb_accounts.py:314` | `CN_REALM_MARKERS` 已含 `workbuddy.cn` | 认区域不受影响，不用改 |

## 现在就能用的部分绕过（未实测）

hub 看板里每个账号都能切"出站身份"（WorkBuddy 桌面 / VSCode / CLI）。把 CN 账号切到 **VSCode**，
对话请求就走 `www.workbuddy.cn`（`_ENDPOINTS[("cn", vscode)]`）。

但下面这些仍然读 `REALM_CONFIGS["cn"]["chat_upstream"]`，海外出口下按代码推断还是会失败：

- 刷新 token
- 模型目录
- 浏览器登录
- 签到与任务中心

所以这只能临时救急，不算修好。

## 建议的补丁

加一个环境变量，缺省值不变，老部署不受影响：

```python
# wb_accounts.py（REALM_CONFIGS 定义之后）
_CN_BASE = (os.environ.get("WB_CN_CHAT_UPSTREAM") or "").strip().rstrip("/")
if _CN_BASE:
    REALM_CONFIGS["cn"]["chat_upstream"] = _CN_BASE
    REALM_CONFIGS["cn"]["domain"] = urllib.parse.urlparse(_CN_BASE).hostname or REALM_CONFIGS["cn"]["domain"]
```

```python
# wb_identity.py（_ENDPOINTS 定义之后；不能 import wb_accounts，会成环，所以各读一次环境变量）
_CN_BASE = (os.environ.get("WB_CN_CHAT_UPSTREAM") or "").strip().rstrip("/")
if _CN_BASE:
    _host = urllib.parse.urlparse(_CN_BASE).hostname
    for _product in (PRODUCT_DESKTOP, PRODUCT_CLI):
        _ENDPOINTS[("cn", _product)] = (_CN_BASE, _host or _ENDPOINTS[("cn", _product)][1])
```

```python
# wb_tasks.py
CHAT_BASE = (os.environ.get("WB_CN_CHAT_UPSTREAM") or "https://copilot.tencent.com").strip().rstrip("/")
```

另外两处小改动：

- `wb_proxy.py:20875` 的启动日志改成读 `get_realm_config("cn")["domain"]`，显示真实出口；
- 看板「设置」页如果要能改，需要把它做成持久化设置。环境变量只在启动时读一次，改了要重启。

### 要注意的地方

- **`X-Domain` 头**：账号文件里存了登录时的 domain（通常是 `www.codebuddy.cn`），
  请求头用 `self.domain or cfg["domain"]`（`wb_accounts.py:1404` `:1538`），所以多数请求的 `X-Domain` 不受 base 改动影响。
  wb2api 的做法也一样：用账号自己的 domain，实测正常。
- **`wb_tasks.py:273` 的领奖接口**：它本来就有 `copilot.tencent.com → www.workbuddy.cn` 的自动降级，
  改了 `CHAT_BASE` 后两次请求都会打到新域，逻辑不受影响。
- **来源头**：`origin` / `billing_upstream`（`www.codebuddy.cn`）海外可达，不用动。

## 改完之后要验证的

1. 海外出口下 `GET /v1/models?realm=cn` 返回 CN 模型（不再是空表或 502）；
2. CN 模型对话正常（流式与非流式）；
3. 等 token 过期或在看板手动刷新，确认刷新走新域并成功；
4. 看板「登录新账号」的国内版流程能走完；
5. 国内出口下不设环境变量，行为与改动前完全一致。

## 插件侧

已在 fork 实现：[zhiqiangme/workbuddy2api-hub](https://github.com/zhiqiangme/workbuddy2api-hub) 分支 `fix/cn-chat-upstream`，
变量名定为 `WB_CN_CHAT_UPSTREAM`。实际做法比上面的草案更集中：`wb_identity.CN_CHAT_BASE` 作为唯一来源，
`REALM_CONFIGS["cn"]["chat_upstream"]` 与 `wb_tasks.CHAT_BASE` 都取它；`domain` / X-Domain 不改。
2026-10-18 海外出口下冒烟：设了变量 CN 对话流式与非流式均 200；不设时同样的账号 TLS EOF、502。

本插件启动 hub 时把 `cnChatBase`（缺省 `https://www.workbuddy.cn`）作为 `WB_CN_CHAT_UPSTREAM` 传给子进程
（`lib/config.js` 的 `buildHubSpec`），与 wb2api 的 `cn.chat_base` 一致。不认这个变量的 hub 版本会忽略它，行为不变。
