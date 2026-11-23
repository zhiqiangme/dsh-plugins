export const name = 'presets-zh-context'

export function installSubagentIdentity(ctx) {
  const installed = new WeakSet()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || installed.has(agent)) return decision
    if (typeof agent.ctx.get('subagents')?.namesOf !== 'function') return decision
    // 宿主在发请求前重读已注册的运行时上下文。用单个 agent 的作用域覆盖身份段，
    // 让刷新、重试和会话日志都使用同一份译文，同时保留宿主实时计算的名称与工具可见性。
    // 在会话开始执行后再注册，避免空白会话切换到其他预设时继承这份覆盖。
    await agent.ctx.inject(['systemPrompt', 'tools', 'subagents'], scope => {
      const { systemPrompt, tools, subagents } = scope
      systemPrompt.context({
        name: 'subagent:identity',
        order: systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        required: true,
        interpolate: false,
        text: ({ scope: toolScope, toolSet }) => {
          try {
            const names = subagents.namesOf(agent)
            const identity = names.parent === undefined
              ? `你是根智能体，名称为 ${JSON.stringify(names.self)}。`
              : `你是由 ${JSON.stringify(names.parent)} 委派的子智能体，名称为 ${JSON.stringify(names.self)}。\n协作树的根智能体是 ${JSON.stringify(subagents.namesOf(subagents.rootOf(agent)).self)}。`
            const guidance = []
            if (tools.get('send_message', toolScope, toolSet)) {
              guidance.push('使用 send_message({ agent: "<agent-name>", message: "..." }) 给其他智能体发消息。')
              // 团队模式通过共享任务板协调结果，仅普通委派要求子智能体主动发消息汇报。
              if (names.parent !== undefined && agent.ctx.get('agentTeams')?.isEnabled(agent) !== true) {
                guidance.push('完成后，使用 send_message 向委派你的智能体发送完整独立的结果。一旦发现会影响其他智能体后续行动的信息，立即给对方发消息；发送消息不会结束你的轮次。')
              }
            }
            if (tools.get('list_agents', toolScope, toolSet)) {
              guidance.push('使用 list_agents({}) 查找协作者及其名称。')
            }
            return [identity, ...guidance].join('\n')
          } catch (error) {
            if (error?.name !== 'SubagentError' || error.code !== 'UNAUTHORIZED') throw error
            return `你的智能体 ID 是 ${JSON.stringify(agent.id)}。协作树的根智能体当前不可用，请继续独立工作。查找其他智能体和发送消息需要根智能体在线。`
          }
        },
      })
    })
    installed.add(agent)
    return decision
  })
}

const INTRO = '以下工作区指令可能适用于当前任务。请在适用时遵循；更具体的指令优先于更宽泛的指令，但不能覆盖系统、开发者或用户的直接指令。'
const INSTRUCTION_INTROS = new Map([
  ['The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.', INTRO],
  ['This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.', '以下完整工作区指令替代此前的工作区指令。' + INTRO],
  ['This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.', '以下完整工作区指令替代此前的工作区指令；当前没有生效的工作区指令。'],
  ['Workspace instructions were omitted or truncated to fit the configured byte budget.', '工作区指令已按配置的字节上限省略或截断。'],
])

function instructionText(text) {
  const opening = /^<system-reminder>\r?\n/.exec(text)?.[0]
  if (!opening) return text
  let rest = text.slice(opening.length)
  let intro = ''
  for (const [english, chinese] of INSTRUCTION_INTROS) {
    if (rest.startsWith(english + '\n') || rest.startsWith(english + '\r\n')) {
      rest = rest.slice(english.length)
      intro = chinese
      break
    }
  }
  // 只处理框架开头的来源行；正文中同样的英文、路径和 DSH 字样属于用户原文。
  const header = /^(\r?\n)*(Instructions from|Additional instructions from|Updated instructions from): ([^\r\n]+)(\r?\n\r?\n)/.exec(rest)
  if (header) {
    const path = /^(?:~\/\.dsh|\$DSH_HOME)\/AGENTS\.md$/.test(header[3]) ? '用户全局 AGENTS.md' : header[3]
    const label = header[2] === 'Additional instructions from' ? '补充指令来源' : header[2] === 'Updated instructions from' ? '更新指令来源' : '指令来源'
    rest = header[0].slice(0, header[0].indexOf(header[2])) + `${label}：${path}` + header[4] + rest.slice(header[0].length)
  }
  return opening + intro + rest
}

function catalogText(text, source) {
  if (!text.startsWith('<system-reminder>\nA skill is a reusable set of task-specific instructions.') &&
      !text.startsWith('<system-reminder>\nNo skills could be confirmed in this discovery attempt.') &&
      !text.startsWith('<system-reminder>\nThe available skill catalog changed.') &&
      !text.startsWith('<system-reminder>\nSkill discovery is incomplete.')) return text
  const start = text.indexOf('<available_skills>\n')
  const end = text.indexOf('\n</available_skills>', start)
  if (start < 0 || end < start) return text
  // 直接保留目录块，避免重新编码技能名称、描述，或触碰技能正文。
  const catalog = text.slice(start, end + '\n</available_skills>'.length)
  const available = Array.isArray(source.entries) && source.entries.length > 0
  const incomplete = source.incomplete === true
  const heading = source.update
    ? (incomplete
      ? '技能发现未完成；以下当前可用技能目录替代本会话此前的所有技能目录：'
      : '可用技能目录已更新；以下完整目录替代本会话此前的所有技能目录：')
    : (available
      ? '技能是一组可复用的任务指令。当前会话可用的技能如下：'
      : '本次技能发现未能确认任何可用技能。')
  const availability = available
    ? '仅使用当前目录中的技能名称。用户点名技能，或任务明确符合其描述时，行动前先用 skill 工具按准确名称加载所有适用技能，再遵循其完整指令。目录只有摘要，请在加载后再执行技能要求。'
    : (!source.update && incomplete
      ? '请等待目录更新后再调用 skill 工具，不要根据空目录推测技能指令。'
      : '当前没有可通过 skill 工具调用的技能，请勿使用旧目录中的名称。')
  return [
    '<system-reminder>',
    heading,
    '', catalog, '',
    ...(incomplete ? ['部分技能未能完成检查。此处仅列出已确认的技能；当优先来源不可用时，可能会选用同名的低优先级定义。下次请求将重试发现。', ''] : []),
    availability,
    '用户也可以直接调用技能，其 <skill_content> 内容会出现在对话中；请遵循该内容，无需再次调用 skill 工具加载同一技能。',
    '</system-reminder>',
  ].join('\n')
}

function runtimeContextSectionText(text) {
  const cwd = /^Current working directory: (".+")\.$/.exec(text)
  if (cwd) return `当前工作目录：${cwd[1]}。`
  if (text === 'Timeline storage is unavailable. Continue ordinary work and report the error; preserve saved plans instead of creating replacements.') {
    return 'Timeline 存储当前不可用。请继续常规工作并报告该错误；保留已保存的计划，不要新建替代计划。'
  }
  if (text === 'Task progress checkpoint: Save changes to the current goal’s tree, or start one if this multi-step goal has none. Use timeline_pull when choosing the next task.') {
    return '任务进度检查点：请将变更保存到当前目标的任务树中；如果这项多步骤目标尚未建树，请先新建一棵。选择下一项任务时调用 timeline_pull。'
  }
  const plan = /^Current Timeline plan \(turn-start state, not a new request\): ([^\n]+)(\nAddress open discussions at a safe checkpoint\. Use timeline_read with annotation set to the ID if you need the full message or context\. Save replies with timeline_reply\. Apply pause or continue to the requested scope before confirming it\.)?$/.exec(text)
  if (plan) {
    const suffix = plan[2]
      ? '\n在安全检查点处理未关闭的讨论。如需查看完整消息或上下文，调用 timeline_read 并将 annotation 设为对应 ID；使用 timeline_reply 保存回复；先对请求的范围执行暂停或继续，再予以确认。'
      : ''
    return `当前 Timeline 计划（本轮开始时的状态，并非新请求）：${plan[1]}${suffix}`
  }
  if (text === 'Report assigned work to the delegating agent.') {
    return '向委派你的智能体汇报所分配的工作。'
  }
  const reportParent = /^Report assigned work to parent ([^\n.]+)\.$/.exec(text)
  if (reportParent) return `向上级 ${reportParent[1]} 汇报所分配的工作。`
  const delegation = /^Timeline delegation: parent ([^;.\n]+)(?:; plan owner ([^;.\n]+))?(?:; current tree ([^:\n]+): (".+"))?\. These are references, not assignments\. Use the tree\/task IDs in the latest assignment message; report missing IDs to the parent\.$/.exec(text)
  if (delegation) {
    const parts = [`上级 ${delegation[1]}`]
    if (delegation[2]) parts.push(`计划归属 ${delegation[2]}`)
    if (delegation[3] && delegation[4]) parts.push(`当前任务树 ${delegation[3]}：${delegation[4]}`)
    return `Timeline 委派参考：${parts.join('；')}。这些仅作参考而非任务分配，请使用最新分配消息中的树／任务 ID；缺少 ID 时向上级汇报。`
  }
  const depth = /^Delegation depth for `([a-z0-9_]+)`: current (\d+), maximum (\d+), remaining levels 0\. Do not call `\1` at this depth; carry out the work directly\.$/.exec(text)
  if (depth) return `${depth[1]} 委派深度：当前 ${depth[2]}，上限 ${depth[3]}，剩余层级 0。请勿在此深度继续调用 ${depth[1]}，直接完成该工作。`
  return text
}

const RUNTIME_CONTEXT_INTROS = new Map([
  ['The following information describes your current session:', '以下信息描述你的当前会话：'],
  ['The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.', '以下信息描述你的当前会话，并替代此前的同类型上下文（包括会话摘要中保留的旧版本）：'],
])

function runtimeContextText(text, source) {
  if (text === '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>') {
    return '<system-reminder>\n当前运行时上下文：无。此前的运行时上下文快照不再适用。\n</system-reminder>'
  }
  if (!text.startsWith('<system-reminder>\n') || !text.endsWith('\n</system-reminder>')) return text
  const inner = text.slice('<system-reminder>\n'.length, -'\n</system-reminder>'.length)
  const sep = inner.indexOf('\n\n')
  if (sep < 0) return text
  const intro = RUNTIME_CONTEXT_INTROS.get(inner.slice(0, sep))
  if (!intro) return text
  // 若宿主附带了结构化 sections，按每段独立翻译，避免单段包含空行时被拆散；
  // 但绝不改写 message.source.sections，因为宿主 RuntimeContextProjection 用它做去重比对。
  const body = Array.isArray(source?.sections) && source.sections.length > 0
    ? source.sections
      .map(section => typeof section?.text === 'string' ? runtimeContextSectionText(section.text) : '')
      .filter(Boolean)
      .join('\n\n')
      .replace(/<\/system-reminder\s*>/gi, tag => `<\\${tag.slice(1)}`)
    : inner.slice(sep + 2).split('\n\n').map(runtimeContextSectionText).join('\n\n')
  return `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`
}

function workingDirectoryText(text) {
  const changed = /^The working directory changed from (".+") to (".+")\.$/.exec(text)
  if (changed) return `工作目录已从 ${changed[1]} 变更为 ${changed[2]}。`
  const recovered = /^The working directory (".+") is unavailable\. The working directory is now (".+")\.$/.exec(text)
  if (recovered) return `工作目录 ${recovered[1]} 不可用，当前工作目录已恢复为 ${recovered[2]}。`
  return text
}

function timelinePriorityText(text) {
  const match = /^Timeline priority update: P0 changed\. At the next safe checkpoint, prefer the highest-priority eligible work within the current goal\.\nEligible prioritized tasks: (.+)$/.exec(text)
  if (!match) return text
  return `Timeline 优先级更新：P0 已变化。请在下一个安全检查点优先处理当前目标内优先级最高的待办任务。\n可执行的优先级任务：${match[1]}`
}

function cuaHeldInputsText(text) {
  if (!text.startsWith('<system-reminder>\n') || !text.endsWith('\n</system-reminder>')) return text
  const lines = text.split('\n')
  if (lines.length < 4) return text
  if (lines[1] === 'CUA inputs are still held:' &&
      lines.at(-2) === "They remain pressed across programs and turns. To release them, call sendKeyEvent or toggleMouse on the same target with direction 'up' and the same input options as the down.") {
    return [
      lines[0],
      'CUA 输入仍处于按住状态：',
      ...lines.slice(2, -2),
      "这些输入会跨程序、跨轮次保持按住。请在同一目标上调用 sendKeyEvent 或 toggleMouse，传入 direction 'up' 及与按下时相同的输入选项以释放。",
      lines.at(-1),
    ].join('\n')
  }
  if (lines[1] === 'CUA inputs were released during cleanup:' &&
      lines.at(-2) === 'These inputs are no longer held.') {
    return [
      lines[0],
      '清理阶段已释放以下 CUA 输入：',
      ...lines.slice(2, -2),
      '这些输入已不再处于按住状态。',
      lines.at(-1),
    ].join('\n')
  }
  return text
}

function timeText(text) {
  const match = /^Time sampled while preparing turn (\d+), step (\d+): ([^\n]+)\n([^\n]+)\nElapsed since the preceding (model-visible message|step context): ([^\n]+)\.$/.exec(text)
  if (!match) return text
  const zone = match[4]
    .replace(/^Browser time zone for this request: ([^ ]+)\. Interpret otherwise-unqualified dates and times in this zone\.$/, '本次请求的时区：$1。未注明时区的日期和时间按此时区理解。')
    .replace(/^Browser time zone for this request: mixed (.+)\. Ask the user to clarify otherwise-unqualified dates and times\.$/, '本次请求包含多个时区：$1。日期和时间未注明时区时，请向用户确认。')
    .replace(/^Browser time zone for this request: unavailable\. Ask the user to clarify otherwise-unqualified dates and times\.$/, '本次请求的时区不可用。日期和时间未注明时区时，请向用户确认。')
  return `本次请求时间（第 ${match[1]} 轮，第 ${match[2]} 步）：${match[3]}\n${zone}\n距上一${match[5] === 'model-visible message' ? '条模型可见消息' : '步上下文'}的时间：${match[6] === 'unavailable' ? '未知' : match[6]}。`
}

const LOCALIZED_KINDS = new Set([
  'agent-instructions',
  'skill-catalog',
  'time-context',
  'model-selection',
  'runtime-context',
  'working-directory',
  'timeline-priority',
  'ptc-mode',
  'cua-held-inputs',
])

/** 仅处理可识别的宿主生成框架；未知版本的格式和普通消息保持原样。 */
export function localizeMessage(message) {
  const kind = message.source?.kind
  if (!LOCALIZED_KINDS.has(kind)) return message
  if (!Array.isArray(message.content)) return message
  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = kind === 'agent-instructions' ? instructionText(block.text)
      : kind === 'skill-catalog' ? catalogText(block.text, message.source)
        : kind === 'time-context' ? timeText(block.text)
          : kind === 'runtime-context' ? runtimeContextText(block.text, message.source)
            : kind === 'working-directory' ? workingDirectoryText(block.text)
              : kind === 'timeline-priority' ? timelinePriorityText(block.text)
                : kind === 'ptc-mode'
                  ? (block.text === 'Program environment reset; retained variables cleared. Completed tool effects remain.'
                    ? '程序运行环境已重置，保留的变量已清空；已完成工具调用产生的效果保持不变。'
                    : block.text)
                  : kind === 'cua-held-inputs' ? cuaHeldInputsText(block.text)
                    : /^\[model changed: assistant turns above this point were generated by .+; the session continues with .+\]$/.test(block.text)
                      ? '[模型已切换：此前的助手回复由先前的模型生成，后续回复使用当前选定的模型。]'
                      : block.text
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  if (!changed) return message
  const source = kind === 'time-context' && Array.isArray(message.source.sections)
    ? { ...message.source, sections: message.source.sections.map((section) => ({ ...section, text: timeText(section.text) })) }
    : message.source
  return { ...message, content, source }
}

/**
 * 在进入会话日志之前格式化，保证轨迹与模型实际接收的消息一致。
 * running 事件晚于模型选择器的安装；此时 prepend 才能包住其模型切换通知。
 * 本模块挂在预设的作用域内，其他模式不会注册这些监听器。
 */
export function apply(ctx) {
  const installed = new WeakMap()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'running' || installed.has(agent)) return
    const dispose = ctx.on('agent/pre-step', async ({ agent: current, signal }, next) => {
      const decision = await next()
      if (current !== agent || signal.aborted || decision.kind === 'reject') return decision
      const messages = decision.messages.map(localizeMessage)
      return messages.some((message, index) => message !== decision.messages[index]) ? { ...decision, messages } : decision
    }, { prepend: true })
    installed.set(agent, dispose)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
}
