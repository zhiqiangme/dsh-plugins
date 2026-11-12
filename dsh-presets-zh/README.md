# 中文预设

独立包名：`@zhiqiangme/dsh-presets-zh`；安装别名：`presets-zh`。

一个插件提供四种模式，在 DSH「插件 → 中文预设」里每种模式一个页签，分别配置开关、显示名称、描述和系统提示词。修改后点击「保存设置」，无需手工改 YAML。

| 模式 | 内部 ID | 能力 |
| --- | --- | --- |
| 中文标准 | `standard-zh` | 保留标准工具与完整操作说明，将已知系统说明汉化 |
| 中文 PTC | `ptc-zh` | 使用 `run_code` 编排工具调用，汉化 SDK 说明，完整保留动态工具声明与类型 |
| 中文极简 | `minimal-zh` | 沿用内置极简：持久终端、图片读取与上下文压缩，不自动注入 AGENTS.md 或 Skills |
| 中文创造 | `cordis-zh` | 保留 Cordis 检查、预设编写技能与插件管理能力，汉化已知操作说明 |

内部 ID 统一为内置模式 ID 加 `-zh` 后缀。四种模式默认全部启用；安装后 DSH 的新任务默认模式不变，需要时在模式页签点「设为新任务默认」。

## 安装

先完全退出 DSH（包括托盘），从 npm 安装：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-presets-zh
```

也可在仓库根目录从源码安装：

```powershell
.\install-plugins.cmd --action install --plugins presets-zh --profiles desktop --yes
```

重开 DSH，在插件列表打开「中文预设」即可设置四种模式。Web / CLI 安装时将 `desktop` 换为对应 profile。

## 设置与生效范围

- 四种模式可分别启用或停用，不需要安装四个插件。
- 每种模式有独立的显示名称、描述、系统提示词；名称和提示词留空时使用默认值。
- 完整模式的“系统提示词”是角色前缀。工具、团队、MCP 等已知操作说明仍由当前组合动态组装并汉化；中文极简则只使用角色提示词。
- “恢复此模式默认设置”先填回默认值，点击保存后生效。
- 保存通过宿主配置表单进行，使用版本检查防止覆盖其他页面较新的设置。遇到冲突可重新载入后编辑。
- 保存后只更新有变化的预设定义。新会话使用新设置；已有会话保留创建时的组合，可切换模式以使用更新后的定义。停用或卸载也不会改写已有会话历史。

手写配置仍然支持，示例：

```yaml
- id: dsh-presets-zh
  config:
    minimal:
      enabled: true
    standard:
      enabled: true
      name: 中文标准
      prompt: 你是一名乐于助人的软件工程助手。
    ptc:
      enabled: true
    creation:
      enabled: false
```

这是 profile 的行覆盖片段；安装 bundle 会声明插件行，无需再手工插入第二份。

## 新任务默认模式

在模式页签点「设为新任务默认」，新建任务就默认使用这个模式，无需再点保存。它与 DSH「设置 → Agent 预设」里的同名操作写的是同一份设置，当前默认的页签标有「默认」。

- 只有已启用、已保存且加载成功的模式才能设为默认。宿主不校验这个值，写入未注册的模式后新任务会创建失败，所以写入前会重新读取预设名单。
- 当前默认的模式不能停用，需先把其他模式设为默认。宿主在默认预设消失时不会回退，这时面板会提示新任务创建失败。
- 已打开的空白任务保持原模式，可以在任务里手动切换。
- 插件只在点击按钮时写入，启动时不会改动默认设置。
- 宿主没有预设名单接口时，面板不显示这个入口，其他设置不受影响。

## 插件更新

设置页的「插件更新」页签显示当前运行版本与 npm 最新版本，并使用 DSH 官方插件管理器安装更新。

- 版本检查走宿主路由 `/plugins/dsh-presets-zh/version`，同时问 npm 官方源与 npmmirror，取较高者，缓存 10 分钟；「检查更新」绕过缓存。
- **官方接口**（`pluginManager` 有 `listVersions/updateBundle`）：先用 `listBundles` 核对本插件的更新资格，再选最新的兼容、未弃用正式版，把精确版本和同一注册表交给 `updateBundle`。锁、卸载、安装与失败恢复都归宿主；只有实际装上目标版本才显示成功。
- 宿主缺少官方更新接口时，可升级 DSH 或按指定版本重装。宿主报 `bundle-in-use` 时，卡片会用 `setBundleEnabled` 补回被移出的启用状态，并展开重装指引。复制 `@zhiqiangme/dsh-presets-zh@版本号`，在「插件」页本插件详情里先关闭「中文预设」组件，再卸载本插件，通过「添加插件」安装，装好后重新打开该组件。
- 本地 `file:/link:` 安装请更新源码并重新运行安装脚本；DSH 托管的安装随宿主更新。

## 从本机测试预设迁移

插件逐个检测同 ID 的声明式预设；遇到重复时将所有权留给既有声明，不覆盖用户配置，也不会阻止其他模式注册。

早期本机测试版使用 `standard-zh-test`、`ptc-zh-test`、`cordis-zh-test`，正式版已改为 `standard-zh`、`ptc-zh`、`cordis-zh`。
旧 ID 的对话找不到原预设，切换到对应的新模式即可继续使用。若 `cordis.patch.yml` 中仍有旧测试配置的标记块，先备份 profile，
再删除 `BEGIN standard-zh-test` 至 `END standard-zh-test` 等三组完整标记块，避免旧预设与插件模式重复出现。

旧的 `@zhiqiangme/dsh-preset-minimal-prompt` 不属于本插件的旧包名，不会被安装脚本移除或迁移。其 `minimal-prompt` 模式独立保留；本插件使用 `minimal-zh`，两者可以同时启用。

从之前“一个插件提供四种模式”的本地版本迁移时，将 standard、ptc、creation 三组设置转到新插件行；中文极简是新模式，不继承旧极简提示词的设置。插件运行时不会主动修改 profile 或会话文件。

## 提示词与能力边界

四种模式都关闭可选宿主上下文，与内置极简模式的 `includeRuntimeContext: false` 一致；宿主标记为 required 的工作目录、团队等运行时事实仍保留。关闭文字说明不改变实际沙箱和审批策略。

标准、PTC 和创造模式中，AGENTS.md、Skills 的名称、描述与正文原样保留，仅汉化已知的自动包装说明、时间通知和模型切换通知。工具 API 标识、schema、SDK 声明及用户内容中的宿主字样不会全局替换。

中文创造保留内置技能目录解析表达式，并根据 profileContext 判断插件管理工具是否可用；不写死安装路径，也不会在缺少 profile 服务时强行启用管理工具。

## 升级与维护

`lib/presets/*.json` 是已验证预设的工具配置快照。`lib/translations/*.json` 保存已知说明及译文。DSH 升级后，如工具组合或原文发生变化，应对比新版内置预设并同步。

`26.11.4` 已同步 DSH `0.2.2-rc.1` 的子代理配置：`list_agents` 由 `@deepseek-ai/dsh-tool-subagent-control` 统一注册，不再加载已移除的 `/list-agents` 子入口；模型选择与发现使用 `modelSelection`、`modelDiscovery`。修复中文标准、中文 PTC 和中文创造因旧入口失效而无法加载的问题。

已同步 DSH `0.2.2-rc.2` 的具名子智能体、团队任务板和收件箱等待说明。三个完整模式随内置预设默认关闭 `interrupt_agent`。宿主提供新版 PTC 执行器时直接使用该执行器，支持汉化 TypeScript 和 Python SDK 说明。宿主提供 Office 工具时，中文标准和中文 PTC 按宿主规则在加载相关技能后提供这些工具。

汉化仅命中已知段落名和原文；未知或变化后的说明原样保留，避免误改。特定宿主身份、源码路径和 Web 界面的系统段落按名称省略。SDK 只替换已知说明前缀，不替换动态代码声明。

这不能保证第三方模型服务始终兼容；三个完整模式的普通回复、PTC 只读终端调用及创造模式只读检查此前已在本机通过，偶发连接错误仍可能发生。实际安装插件、修改预设等创造模式写入流程尚未全面验证。

## 开发

```powershell
cd dsh-presets-zh
npm ci --ignore-scripts
npm test
```

依赖宿主同款 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` peer。测试覆盖预设注册、独立设置更新、提示词汉化、SDK 保留、上下文隔离、设置页保存冲突、新任务默认及 DSH 官方插件更新，使用测试替身即可运行。

## 停用与卸载

停用整个插件会撤下其拥有的四种预设；也可以仅在插件设置中停用某一种。

如果新任务默认是本插件的模式，停用或卸载整个插件前，先到 DSH「设置 → Agent 预设」把默认换成其他预设，否则新任务会创建失败。

```powershell
dsh plugin --profile desktop remove @zhiqiangme/dsh-presets-zh
```

## 许可

[MIT](LICENSE)
