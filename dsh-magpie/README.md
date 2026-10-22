# @zhiqiangme/dsh-magpie

在 DSH「插件」页独立管理经 Magpie 调用的模型。模型清单、名称、勾选、顺序、上下文、输出限额、图片输入和思考档位都由本插件保存。

Magpie 网关需自行运行。首版以模型列表管理为主，不安装、更新或托管 Magpie 进程；也不迁移或卸载旧 OpenCode 插件。

## 安装

从本仓库源码安装：先完全退出 DSH（包括托盘），在仓库根目录执行：

```powershell
.\install-plugins.cmd --action install --plugins magpie --profiles desktop --yes
```

或者使用 DSH 自带的插件管理器：

```powershell
dsh plugin --profile desktop add "file:<仓库绝对路径>\dsh-magpie"
```

npm 发布后可用 `dsh plugin --profile desktop add @zhiqiangme/dsh-magpie`。源码依赖是拷贝，更新源码后请重新运行安装脚本。

## 模型管理

1. 在插件卡片的「连接设置」填 Magpie 网关地址，默认 `http://127.0.0.1:3425`，选择调用协议。
2. 点击「手动添加模型」，填写 Magpie 可识别的完整 ID，例如 `workbuddy-ai/deepseek-v4.1-flash` 或路由组 ID。显示名称可留空。
3. 模型列表左侧勾选，显示名称右侧箭头展开详细配置；详情在列表原位展开，后续模型自动下移。按需编辑 ID、名称、上下文、输出限额、图片输入和思考档位，例如 `low, high, max`。未知能力留空，不按模型名称猜测。
4. 勾选模型，使用上下箭头排序，开启「同步所选模型到 DSH」，点击「保存并同步」。选中的模型按清单顺序出现在 **Magpie · DSH** 分组。

支持搜索、全选、取消全选、删除和离线编辑。批量勾选只影响当前搜索结果。保存只写 DSH 配置，不要求 Magpie 正在运行；模型 ID 是否可用，需要网关和上游实际支持。

本分组逐模型默认选择已配置档位中的最高档，按 `off < minimal < low < medium < high < xhigh < max` 排序。例如 Step 的 `low, medium, high` 默认 High，Flash 的 `low, high, max` 默认 Max。手动选择的档位继续生效；未声明推理能力的模型不补默认值。

当前 DSH 的 llm-pi-ai 只提供 provider 级默认配置。插件在宿主现有适配器的 `resolveModel` / `prepareCall` / `stream` 接口上仅补充 `dsh-magpie` 路由的逐模型默认值，沿用同一套模型元数据与协议实现。已有 provider 和模型 ID 保持不变，其它分组不受影响；适配器重载时重新附加，停用插件时撤销。

「从 Magpie 导入」是可选的目录快照：先用 `/api/hello` 核对身份，再读取 `/v1/models`，仅添加新 ID，不覆盖已有模型的名称、能力、勾选或顺序。新条目默认不勾选，点击保存后才持久化。再次导入不会删除消失的模型，也不会自动更改手工清单。导入会把上游最大输出限制在上下文的四分之一以内，为 DSH 预留对话预算，之后可手动调整。

关闭同步或取消全部勾选后保存，只移除本插件创建的 `dsh-magpie` provider；保存的清单仍可编辑。已引用该分组的会话需要重新选择可用模型。卸载插件遵循 DSH 的配置保留规则，需要移除分组时先关闭同步并保存。

## 配置边界与 Key

- 固定插件行 ID 和 provider ID 都是 `dsh-magpie`，不会修改 Magpie 原生的 `magpie` / `magpie-responses` / `magpie-anthropic` 分组、其它 provider、默认模型或其它 profile。
- 模型写入经宿主 `configEditor`，按锁内最新配置合并；已被其他配置占用的同名 provider 拒绝覆盖。两个页面同时编辑时，旧页面保存返回冲突，避免覆盖刚保存的清单。
- 模型列表默认空，同步默认关闭。保存和插件启动只同步自己的清单，不定时读取上游目录。
- 本机 loopback 使用官方约定的 `magpie-dsh` 标识。远程网关需要有效的 gateway key；卡片保存到 DSH 凭据库的 `DSH_MAGPIE_API_KEY`，配置中只保存引用，状态接口不返回 Key。环境变量同名值优先且只读；输入框留空沿用已保存值。
- 调用协议可选 Chat Completions、Responses、Anthropic Messages；前两者使用网关 `/v1/`，Anthropic 使用根地址。修改协议或地址后保存会同步更新 provider。
- 清单保存成功但凭据或 provider 同步失败时，卡片明确显示失败原因；清单保留，修复后再保存同步。读取配置和检查连接不会发送推理请求。

配置示例（写在本插件行的 `config` 下）：

```yaml
syncEnabled: true
baseURL: http://127.0.0.1:3425
api: openai-completions
models:
  - id: workbuddy-ai/deepseek-v4.1-flash
    name: DeepSeek V4.1 Flash
    enabled: true
    contextWindow: 1000000
    maxTokens: 128000
    input: [text, image]
    reasoningEfforts: [low, high, max]
```

## 开发与验证

只有 Node 内置模块，无安装依赖和构建步骤。`node --test test/*.test.mjs` 使用独立的宿主替身与本机假网关，不修改真实 DSH/Magpie 配置，不发送真实推理请求。

上游协议依据 [Magpie 应用接入文档](https://usemagpie.ai/docs/integrate)；模型能力与配额仍取决于实际账号和上游。

MIT，见 [LICENSE](LICENSE)。
