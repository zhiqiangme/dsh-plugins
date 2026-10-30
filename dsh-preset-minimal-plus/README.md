# @zhiqiangme/dsh-preset-minimal-plus

给 DSH 自动新增 **「极简增强模式」**（preset id `minimal-plus`）：系统提示词与极简模式一致，工具、AGENTS.md、Skills 和运行时上下文与标准模式一致。

装上插件后不需要手动改 `cordis.patch.yml`，插件加载时会自动向 Agent preset 注册表注册这个模式。

## 这个模式是什么

| 内容 | 来源 |
| --- | --- |
| 系统提示词（system message） | 极简模式，固定为 `You are a helpful software engineer assistant.` |
| 工具 | 标准模式：read / write / edit / glob / grep / pwsh / jobs / schedule / skill / goal / plan / subagent / workflow / todo / web / present 等 |
| AGENTS.md | 标准模式：由 `agent-instructions` 注入 |
| Skills | 标准模式：`skill-filesystem` + `tool-skill`，含技能目录 |
| 时间 / 运行时上下文 | 标准模式：时间、工作目录、沙箱与审批策略等 |
| 标准系统提示词里的工具说明、团队说明、MCP 说明 | 不写入；`complete: true` 会抑制所有其他 system prompt 段落 |

工具 schema 仍会随工具集完整发送，所以模型知道自己能调用什么；但标准模式系统提示词里的长篇操作说明不会出现。这是“极简提示词 + 标准工具”的预期代价。

## 安装

### 从 npm 安装（推荐）

先完全退出 DSH 桌面版（托盘图标也要退出），然后：

```powershell
dsh plugin --profile desktop add @zhiqiangme/dsh-preset-minimal-plus
```

重新打开 DSH，插件加载后会自动注册新模式。装到 Web / CLI 时把 `desktop` 换成 `web` / `headless`。

### 从源码安装

在仓库根目录运行：

```powershell
.\install-plugins.cmd --action install --plugins minimal-plus --profiles desktop --yes
```

或让安装脚本选择“全部”，新插件会出现在列表中。

## 安装后的行为

1. 插件 bundle 的 `cordis.patch.yml` 先挂载插件自身。
2. `lib/index.js` 在 `agentPresets` 服务就绪后检查是否已经有同 id 的声明式预设。
3. 没有冲突时调用 `agentPresets.register(PRESET)`，注册「极简增强模式」。
4. 停用插件行或卸载插件时，注册会被释放；之后新建的任务不再提供这个模式。已有会话保留启动时的组合，不受影响。

### 如果已经手动加过 `minimal-plus`

如果你之前按手工方式往 `cordis.patch.yml` 加过：

```yaml
- insert:
    - id: preset-minimal-plus
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal-plus
        ...
```

插件会检测到这条声明并跳过自动注册，避免同一个 `minimal-plus` 出现两份（重复 id 会让其中一份显示加载失败）。

要让插件接管这个模式：

1. 删除 `cordis.patch.yml` 里包含 `preset-minimal-plus` 的那段 `- insert:` 块；
2. 重启 DSH，或在插件页把本插件停用再启用；
3. 插件会重新注册并成为该模式的唯一来源。

## 启用、停用与卸载

- **停用**：在 DSH 插件页停用 `dsh-preset-minimal-plus` 行，或设置页禁用对应 bundle。新模式从后续新会话中消失。
- **卸载**：

```powershell
dsh plugin --profile desktop remove @zhiqiangme/dsh-preset-minimal-plus
```

卸载后插件编辑过的 profile 配置不会残留（本插件不写 profile 文件）；如果之前有手动声明，手动声明仍然保留。

## 和标准模式保持同步

本插件的 `lib/preset.js` 是 **DSH 标准模式插件列表的快照**，安装时不需要读取 DSH 安装目录。这样它能离线安装、可审计，也不会因为 DSH 升级时文件路径变化而加载失败。

代价是：DSH 升级后，如果标准模式新增或删除了工具，插件不会自动跟着变。升级 DSH 后可以：

1. 对比新版本 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 的 `plugins` 列表；
2. 更新 `lib/preset.js`，只改 `persona` 为极简配置，其余行保持标准模式；
3. 运行 `npm test` 和下面的运行时验证。

`test/preset.test.mjs` 会检查关键行是否存在，但不会连接 DSH 安装目录，所以 CI 不需要 DSH。

## 运行时验证

本仓库的测试不依赖 DSH。需要确认插件在真实 DSH 中能注册时，可以：

1. 在一个测试 profile 中安装本插件；
2. 启动 Web profile，调用 `agentPresets/list`，确认返回 `minimal-plus` 且没有 `broken`；
3. 新建一个 `minimal-plus` 会话，确认：
   - system message 是 `You are a helpful software engineer assistant.`；
   - `request/header.tools` 与同 profile 的 standard 会话一致；
   - user messages 包含 `agent-instructions`、`skill-catalog`、`time-context` 和 `runtime-context`。

## 实现说明

- `cordis.patch.yml` 只插入插件自身，不直接插入 preset 声明；这样代码可以先检查 profile 里已有的手写声明，避免重复 id。
- `lib/index.js` 使用 `ctx.loader.entries()` 检查未禁用的 `@deepseek-ai/dsh-agent-preset` 行，再查一次 `agentPresets.list()`，都没有才注册。
- `lib/preset.js` 是纯数据对象，不依赖 YAML 解析器或 DSH 内部文件。
- 平台相关的 shell 行在加载时求值：Windows 启用 `tool-pwsh`，其他平台启用 `tool-bash`。
- `tool-plugin-manager` 与 `tool-plugin-market` 保持标准模式的默认禁用状态。

## 已知限制

- 没有客户端 UI；模式卡片由 DSH 的 Agent preset 页面统一展示，显示名称和描述来自 `PRESET`。
- 预设是标准模式的静态快照；DSH 升级后需要手动同步工具列表。
- 如果 profile 里已经有同 id 的手写声明，插件会跳过注册而不是覆盖它；需要按上面的步骤移除手写声明。
- 已有会话不会因为插件安装/停用而改变组合；只有新建会话会读取当前注册表。

## 开发

```powershell
cd dsh-preset-minimal-plus
node --test test/*.test.mjs
```

只依赖 Node 内置模块和 `@deepseek-ai/cordis` peer；测试使用 fake host，不需要 DSH 或网络。

## 许可

[MIT](LICENSE)
