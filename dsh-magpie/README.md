# @zhiqiangme/dsh-magpie

在 DSH「插件」页管理 Magpie 提供的模型，并把选中的模型写入 DSH 的 **Magpie** 模型分组。模型清单、名称、勾选、顺序、上下文、输出限额、图片输入和思考档位都由本插件保存。

可在卡片下载或升级 Windows 版 Magpie，完成后自动启动；可选退出 DSH 时关闭本机 Magpie。插件只在下载或升级完成时启动 Magpie，不在 DSH 启动时拉起，也不迁移或卸载旧 OpenCode 插件。

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

## 插件自身更新

卡片底部「插件更新」管理 `@zhiqiangme/dsh-magpie` 的版本，与「Magpie 下载与升级」分开。

- 显示当前运行版本与 npm 最新版本。沿用 WB 插件的检查机制，由宿主并行查询 npm 官方源和 npmmirror，取成功响应中的最高版本；成功结果缓存十分钟，点击「检查更新」可强制刷新。
- 检测到支持公开更新 API v1 的 dshmarket，且本插件从 npm / git 安装时，可点击「更新到 v…」。更新交给 dshmarket，显示进度、失败原因及实际安装版本；仅在发布冷却期或版本未变的失败之后提供「强制更新」。卡片重新挂载可恢复当前任务的进度。
- 未安装 dshmarket 时只提示；`file:` 本地目录安装需更新源码并重新运行安装脚本，由桌面端统一管理的版本则通过宿主管理。插件不自行执行包管理器或改写 profile。
- 模型有未保存更改或当前操作未完成时，先保存或放弃更改、等待操作结束，再更新插件。更新成功后按结果提示重启 DSH 或刷新页面；只有 dshmarket 明确支持重启时才显示重启按钮，桌面版通常由桌面壳负责重启。

## 退出时关闭 Magpie

卡片顶部「退出 DSH 时同时关闭 Magpie」默认关闭，点击「保存并同步」后生效。开启后，正常退出 DSH 时结束本机目标 Magpie，包括托盘进程；停用、卸载或更新本插件不会触发关闭。

指定了「Magpie 程序路径」时只处理该完整路径的进程；未指定时，优先识别占用本机 Magpie 端口、文件名为 `magpie.exe` 或官方 Windows 产物名的进程，未找到则检查插件独立目录。远程 Magpie 不会被关闭，不按进程名称批量结束。Windows 之外暂不支持此联动；强制结束 DSH 进程无法保证执行退出回调。

## 下载与升级 Magpie

展开「Magpie 下载与升级」，点击「检查更新」或「下载 Magpie」。已安装时显示当前版本和「升级 Magpie」；下载期间显示进度。下载或升级完成后自动以独立进程启动 Magpie，DSH 退出不会连带结束它（除非开启「退出 DSH 时同时关闭 Magpie」）；若该程序已在运行则不重复启动，启动失败只提示原因、不影响安装结果。升级前完全退出目标 Magpie（包括托盘），再点击升级；插件不会替你结束正在运行的 Magpie。

- 默认安装到 `<DSH_HOME>/magpie/backend/current/magpie.exe`，未指定 `DSH_HOME` 时使用 `~/.dsh`。`Magpie 程序路径` 可填写已有 exe 的绝对路径，留空恢复独立目录；通过「保存并同步」保存路径偏好。程序操作立即作用于填写的路径，但不会保存或覆盖模型草稿。
- 下载中断后自动续传：连接 30 秒无数据即断开，从已下载的字节继续请求，最多尝试 5 次；仍失败时保留部分文件，再次点击「下载 Magpie」或「升级 Magpie」接着下载。部分文件以预期 SHA-256 命名，放在 `<DSH_HOME>/magpie/cache/downloads`，换了 Release 不会续到旧文件上；校验不符时删除并从头下载，安装成功后删除。
- 使用官方 [`yetone/magpie-releases`](https://github.com/yetone/magpie-releases/releases) 的最新正式版，选择完整 GUI 产物 `magpie-windows-amd64.exe` / `magpie-windows-arm64.exe`。使用 GitHub 提供的 SHA-256 digest，缺少时读取同一 Release 的 `SHA256SUMS`；无有效校验值则拒绝安装。`GITHUB_TOKEN` / `GH_TOKEN` 可提高版本查询额度，界面不返回 token。
- 下载、校验与暂存版本验证通过后才替换；升级后再次验证，失败自动恢复旧文件。旧版备份放在 `<DSH_HOME>/magpie/backend/versions`，每个目标保留最近三次成功升级的备份。并发安装通过操作锁保护，插件关闭取消下载。Magpie 自己的账号、插件和设置目录不会迁移或清理。
- 下载升级目前支持 Windows x64 / ARM64；其他平台的模型管理照常使用。检查更新由按钮触发，不在后台自动下载升级。开发和测试可用 `DSH_MAGPIE_BACKEND_ROOT` 单独指定程序管理根目录。

## 模型管理

1. 在插件卡片的「连接设置」填 Magpie 地址，默认 `http://127.0.0.1:3425`，选择调用协议。
   点击「从 Magpie 同步」会立即用当前 Magpie 目录覆盖保存清单并更新 DSH，无需再次点击保存。
2. 点击「手动添加模型」，填写 Magpie 可识别的完整 ID，例如 `workbuddy-ai/deepseek-v4.1-flash` 或路由组 ID。显示名称可留空。
3. 模型列表左侧勾选，显示名称右侧箭头展开详细配置；详情在列表原位展开，后续模型自动下移。按需编辑 ID、名称、上下文、输出限额、图片输入和思考档位，例如 `low, high, max`。思考档位只能使用 DSH 支持的 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，且不能只有 `off`；不支持思考的模型留空。未知能力留空，不按模型名称猜测。
4. 勾选模型，拖动勾选框左侧的六点手柄调整顺序，开启「同步所选模型到 DSH」，点击「保存并同步」。选中的模型按清单顺序出现在 **Magpie** 分组（provider ID 仍为 `dsh-magpie`）。

管理列表与 DSH 模型选择器会在模型名后追加供应商简称，例如 `DeepSeek V4.1 Flash WorkBuddy`、`Step-5-Preview WorkBuddy GL`、`DeepSeek V4.1 Flash Free OpenCode`。`workbuddy-ai` 为国际版，显示为 `WorkBuddy GL`；`workbuddy` 为国内版，显示为 `WorkBuddy`。Qoder / Trae 国际版同样使用 `GL`。名称已带对应简称时不重复追加；手工名称、模型 ID 与排序保持不变，未知供应商或路由组不追加简称。

`DeepSeek-Flash`、`Deepseek-V4.1-Flash` 等写法统一显示为 `DeepSeek V4.1 Flash`，保留 `Free`、`(Max)` 等尾缀和供应商简称；搜索、快捷排序与 DSH 模型名称同步使用这一显示规则。此规则仅派生显示名称，不改写保存的名称或模型 ID，其他 DeepSeek 版本不受影响。

支持搜索、全选、取消全选、删除和离线编辑。批量勾选只影响当前搜索结果。保存只写 DSH 配置，不要求 Magpie 正在运行；模型 ID 是否可用，取决于 Magpie 和上游实际支持。

「按模型排序」按模型名称升序排列，同名模型再按供应商简称排列；「按供应商排序」先按供应商简称升序分组，再按模型名称排列。排序忽略大小写，数字按自然顺序排列（例如 Model 2 在 Model 10 前），空名称或无供应商的条目排在后面；键值相同的条目保留相对顺序。有搜索条件时只重排匹配模型，隐藏条目的位置不变。勾选、编辑内容和展开状态一并保留，点击「保存并同步」后保存新顺序。

本分组逐模型默认选择已配置档位中的最高档，按 `off < minimal < low < medium < high < xhigh < max` 排序。例如 Step 的 `low, medium, high` 默认 High，Flash 的 `low, high, max` 默认 Max。手动选择的档位继续生效；未声明推理能力的模型不补默认值。

当前 DSH 的 llm-pi-ai 只提供 provider 级默认配置。插件在宿主现有适配器的 `resolveModel` / `prepareCall` / `stream` 接口上仅补充 `dsh-magpie` 路由的逐模型默认值，沿用同一套模型元数据与协议实现。已有 provider 和模型 ID 保持不变，其它分组不受影响；适配器重载时重新附加，停用插件时撤销。

「从 Magpie 同步」先用 `/api/hello` 核对身份，再完整读取并校验 `/v1/models`。每次点击都以 Magpie 当前可用目录替换整个清单：名称、顺序、上下文、最大输出、图片能力和思考档位跟随上游；模型全部勾选，开启同步，并立即保存及更新 **Magpie** 分组。上游已关闭或删除的模型、本地手工添加或修改的模型都会被这次全量结果覆盖；上游目录合法为空时清空清单并移除分组。请求失败、目录异常或版本冲突时保留原配置；清单保存后 DSH 分组更新失败会明确提示，可再次同步。模型名称仍追加供应商简称，默认推理档位仍选最高档。上游档位中 DSH 不支持的值（例如 `none`）会被忽略，只剩 `off` 时视为不声明思考；上游最大输出不小于上下文时只省略该模型的最大输出，其余字段照常导入。

关闭同步或取消全部勾选后保存，只移除本插件创建的 `dsh-magpie` provider；保存的清单仍可编辑。已引用该分组的会话需要重新选择可用模型。卸载插件遵循 DSH 的配置保留规则，需要移除分组时先关闭同步并保存。

## 配置边界与 Key

- 固定插件行 ID 和 provider ID 都是 `dsh-magpie`，不会修改 Magpie 原生的 `magpie` / `magpie-responses` / `magpie-anthropic` 分组、其它 provider、默认模型或其它 profile。
- 模型写入经宿主 `configEditor`，按锁内最新配置合并；已被其他配置占用的同名 provider 拒绝覆盖。两个页面同时编辑时，旧页面保存返回冲突，避免覆盖刚保存的清单。
- 模型列表默认空，同步默认关闭。手动点击「从 Magpie 同步」才读取上游目录；普通保存和插件启动沿用已保存清单，不定时读取上游目录。
- 本机 loopback 使用官方约定的 `magpie-dsh` 标识；它会写入凭据供 DSH 调用，但不算已保存的 Key，切到远程 Magpie 时也不会发出。远程 Magpie 需要有效的 gateway key；卡片保存到 DSH 凭据库的 `DSH_MAGPIE_API_KEY`，配置中只保存引用，状态接口不返回 Key。环境变量同名值优先且只读；输入框留空沿用已保存值。
- 调用协议可选 Chat Completions、Responses、Anthropic Messages；前两者使用 Magpie 地址下的 `/v1/`，Anthropic 使用根地址。修改协议或地址后保存会同步更新 provider。
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

只有 Node 内置模块，无安装依赖和构建步骤。`node --test test/*.test.mjs` 使用独立的宿主替身与本机假 Magpie 服务，不修改真实 DSH/Magpie 配置，不发送真实推理请求。

上游协议依据 [Magpie 应用接入文档](https://usemagpie.ai/docs/integrate)；模型能力与配额仍取决于实际账号和上游。

MIT，见 [LICENSE](LICENSE)。
