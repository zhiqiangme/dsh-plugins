/* 复用宿主的配置表单、持久化与版本检查，不另建配置文件或 HTTP 写入接口。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-presets-zh',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    // 顺序与 lib/modes.js 的注册顺序一致；客户端是独立浏览器模块，不能直接导入服务端快照。
    const modes = [
      { key: 'standard', label: '中文标准', id: 'standard-zh', glyph: '标', summary: '标准工具与完整操作说明', context: true },
      { key: 'ptc', label: '中文 PTC', id: 'ptc-zh', glyph: 'P', summary: 'run_code 编排批量工具调用', context: true },
      { key: 'minimal', label: '中文极简', id: 'minimal-zh', glyph: '简', summary: '终端、读图与上下文压缩', context: false },
      { key: 'creation', label: '中文创造', id: 'cordis-zh', glyph: '创', summary: 'Cordis 检查与插件管理', context: true },
    ]
    // 颜色全部取宿主主题变量，跟随明暗主题；回退值只在脱离宿主预览时生效。
    const css = `
.dpz{--dpz-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--dpz-text:var(--dsw-alias-label-primary,currentColor);--dpz-muted:var(--dsw-alias-label-secondary,#8b919c);--dpz-faint:var(--dsw-alias-label-tertiary,#6f7682);--dpz-line:var(--dsw-alias-border-l2,#8883);--dpz-line-strong:var(--dsw-alias-border-l3,#8885);--dpz-surface:var(--dsw-alias-bg-layer-1,transparent);--dpz-base:var(--dsw-alias-bg-base,Canvas);--dpz-hover:var(--dsw-alias-interactive-bg-hover,#8881);--dpz-ok:var(--dsw-alias-state-success-primary,#22c55e);--dpz-warn:var(--dsw-alias-state-warn-primary,#f59e0b);--dpz-error:var(--dsw-alias-state-error-primary,#ef4444);max-width:960px;color:var(--dpz-text);font-size:14px;line-height:1.55}
.dpz *{box-sizing:border-box}
.dpz-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:16px}
.dpz-head h3{margin:0;font-size:18px;font-weight:600}
.dpz-head p{margin:4px 0 0;color:var(--dpz-muted);font-size:13px}
.dpz-count{flex:none;padding:3px 10px;border:1px solid var(--dpz-line);border-radius:999px;color:var(--dpz-muted);font-size:12px;font-variant-numeric:tabular-nums}
.dpz-count b{color:var(--dpz-text);font-weight:600}
.dpz-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}
.dpz-mode{position:relative;display:flex;border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-md,12px);background:var(--dpz-surface);transition:border-color .15s,background .15s}
.dpz-mode:hover{background:var(--dpz-hover)}
.dpz-mode[data-selected=true]{border-color:var(--dpz-accent);background:color-mix(in srgb,var(--dpz-accent) 9%,var(--dpz-surface))}
.dpz-mode[data-enabled=false] .dpz-glyph,.dpz-mode[data-enabled=false] .dpz-mode-name{opacity:.5}
.dpz-pick{flex:1;min-width:0;display:flex;gap:10px;align-items:flex-start;padding:12px 4px 12px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:inherit}
.dpz-pick:focus-visible,.dpz-btn:focus-visible,.dpz-switch:focus-visible{outline:2px solid var(--dpz-accent);outline-offset:2px}
.dpz-glyph{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dpz-accent) 16%,transparent);color:var(--dpz-accent);font-weight:700;font-size:14px}
.dpz-glyph.dpz-lg{width:40px;height:40px;font-size:16px;border-radius:10px}
.dpz-mode-text{min-width:0;display:grid;gap:2px}
.dpz-mode-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dpz-mode-sub{color:var(--dpz-faint);font-size:12px;line-height:1.4}
.dpz-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dpz-badge{padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;color:var(--dpz-muted);background:var(--dpz-hover)}
.dpz-badge[data-tone=warn]{color:var(--dpz-warn);background:color-mix(in srgb,var(--dpz-warn) 14%,transparent)}
.dpz-badge[data-tone=accent]{color:var(--dpz-accent);background:color-mix(in srgb,var(--dpz-accent) 14%,transparent)}
.dpz-switch{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:34px;height:20px;margin:14px 12px 0 0;border-radius:999px;background:var(--dpz-line-strong);cursor:pointer;transition:background .15s}
.dpz-switch::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0004;transition:transform .15s}
.dpz-switch:checked{background:var(--dpz-accent)}
.dpz-switch:checked::before{transform:translateX(14px)}
.dpz-switch:disabled{opacity:.45;cursor:not-allowed}
.dpz-panel{border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-lg,16px);background:var(--dpz-surface);padding:20px}
.dpz-panel-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--dpz-line)}
.dpz-panel-title{flex:1;min-width:180px}
.dpz-panel-title h4{margin:0;font-size:16px;font-weight:600}
.dpz-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;color:var(--dpz-faint);font-size:12px}
.dpz-meta code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;padding:1px 6px;border-radius:6px;background:var(--dpz-hover);color:var(--dpz-muted)}
.dpz-enable{display:flex;align-items:center;gap:8px;color:var(--dpz-muted);font-size:13px;cursor:pointer}
.dpz-enable .dpz-switch{margin:0}
.dpz-fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:16px}
.dpz-fieldset:disabled{opacity:.6}
.dpz-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.dpz-field{display:grid;gap:6px;min-width:0}
.dpz-label{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:500}
.dpz-label small{color:var(--dpz-faint);font-weight:400;font-size:12px;font-variant-numeric:tabular-nums}
.dpz-input{width:100%;color:inherit;font:inherit;background:var(--dpz-base);border:1px solid var(--dpz-line);border-radius:var(--dsw-radius-sm,8px);padding:8px 11px;transition:border-color .15s,box-shadow .15s}
.dpz-input::placeholder{color:var(--dpz-faint)}
.dpz-input:hover{border-color:var(--dpz-line-strong)}
.dpz-input:focus{outline:none;border-color:var(--dpz-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dpz-accent) 22%,transparent)}
textarea.dpz-input{min-height:168px;resize:vertical;line-height:1.65}
.dpz-hint{color:var(--dpz-faint);font-size:12px}
.dpz-bar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding:12px 0;background:var(--dpz-base);border-top:1px solid var(--dpz-line)}
.dpz-status{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 240px;color:var(--dpz-muted);font-size:13px}
.dpz-status::before{content:'';flex:none;width:7px;height:7px;border-radius:50%;background:var(--dpz-faint)}
.dpz-status[data-tone=ok]::before{background:var(--dpz-ok)}
.dpz-status[data-tone=warn]::before{background:var(--dpz-warn)}
.dpz-status[data-tone=error]{color:var(--dpz-error)}
.dpz-status[data-tone=error]::before{background:var(--dpz-error)}
.dpz-actions{display:flex;gap:8px;margin-left:auto}
.dpz-btn{height:34px;padding:0 16px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dpz-line-strong);background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,opacity .15s}
.dpz-btn:hover:not(:disabled){background:var(--dpz-hover)}
.dpz-btn:disabled{opacity:.45;cursor:not-allowed}
.dpz-btn.dpz-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dpz-accent));color:var(--dsw-alias-brand-primary-invert,#fff)}
.dpz-btn.dpz-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dpz-accent))}
.dpz-btn.dpz-small{height:30px;padding:0 12px;font-size:12px}
`
    const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
    const fields = [
      { field: 'name', title: '显示名称', hint: '留空使用默认名称' },
      { field: 'description', title: '模式描述', hint: '显示在模式选择列表中' },
    ]

    function ModeSettings({ form, view }) {
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [revision, setRevision] = useState()
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [selected, setSelected] = useState(modes[0].key)
      useEffect(() => {
        if (!dirty && snapshot.value) {
          setDraft(structuredClone(snapshot.value))
          setRevision(snapshot.revision)
        }
      }, [snapshot.value, snapshot.revision, dirty])

      if (view === 'summary') return h('span', null, '四种中文模式，各自启用并设置提示词。')
      if (!draft) return h('p', { role: 'status' }, snapshot.status === 'error' ? '配置读取失败，请重新打开插件设置。' : '正在读取模式配置…')

      const change = (key, field, value) => {
        setDraft(previous => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
        setDirty(true)
        setNotice(null)
      }
      const reload = () => {
        setDraft(structuredClone(snapshot.value))
        setRevision(snapshot.revision)
        setDirty(false)
        setNotice(null)
      }
      const reset = key => {
        setDraft(previous => ({ ...previous, [key]: structuredClone(snapshot.base[key]) }))
        setDirty(true)
        setNotice({ tone: 'warn', text: '默认内容已填入，点击保存后生效。' })
      }
      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          // 绑定开始编辑时的版本；其他页面写入后须重新载入，不能覆盖较新的设置。
          const accepted = await form.mutate(modes.map(({ key }) => ({ op: 'set', path: [key], value: draft[key] })), revision)
          if (accepted) {
            setDirty(false)
            setNotice({ tone: 'ok', text: '已保存。新会话使用新设置；已有会话可切换模式后使用。' })
          } else setNotice({ tone: 'error', text: '未保存，配置可能已在其他页面更新。请重新载入后再编辑。' })
        } catch (error) {
          setNotice({ tone: 'error', text: `保存失败：${error.message}` })
        } finally { setBusy(false) }
      }

      const readonly = busy || !snapshot.writable
      const enabledCount = modes.filter(({ key }) => draft[key]?.enabled !== false).length
      const status = notice
        ?? (!snapshot.writable ? { tone: 'error', text: '当前配置为只读，无法保存。' }
          : dirty ? { tone: 'warn', text: '有未保存的更改' } : { tone: 'idle', text: '设置与已保存内容一致' })
      const mode = modes.find(item => item.key === selected) ?? modes[0]
      const value = draft[mode.key] ?? {}
      const base = snapshot.base?.[mode.key] ?? {}

      const toggle = (key, label) => h('input', {
        type: 'checkbox', role: 'switch', className: 'dpz-switch', 'aria-label': `启用${label}`,
        checked: draft[key]?.enabled !== false, disabled: readonly,
        onChange: event => change(key, 'enabled', event.target.checked),
      })
      const card = ({ key, label, glyph, summary }) => {
        const enabled = draft[key]?.enabled !== false
        const badges = [
          !enabled && h('span', { key: 'off', className: 'dpz-badge' }, '已停用'),
          !same(draft[key], snapshot.value[key]) && h('span', { key: 'dirty', className: 'dpz-badge', 'data-tone': 'warn' }, '未保存'),
          !same(draft[key], snapshot.base?.[key]) && h('span', { key: 'custom', className: 'dpz-badge', 'data-tone': 'accent' }, '已自定义'),
        ].filter(Boolean)
        return h('div', { key, className: 'dpz-mode', 'data-selected': String(key === mode.key), 'data-enabled': String(enabled) },
          h('button', { type: 'button', role: 'tab', 'aria-selected': key === mode.key, 'data-mode': key, className: 'dpz-pick', onClick: () => setSelected(key) },
            h('span', { className: 'dpz-glyph', 'aria-hidden': true }, glyph),
            h('span', { className: 'dpz-mode-text' },
              h('span', { className: 'dpz-mode-name' }, draft[key]?.name?.trim() || label),
              h('span', { className: 'dpz-mode-sub' }, summary),
              badges.length ? h('span', { className: 'dpz-badges' }, ...badges) : null)),
          toggle(key, label))
      }

      return h('section', { className: 'dpz' },
        h('style', null, css),
        h('header', { className: 'dpz-head' },
          h('div', null,
            h('h3', null, '中文预设'),
            h('p', null, '选择模式后编辑，修改后点击保存。标准、PTC 和创造模式保留 AGENTS.md 与技能原文。')),
          h('span', { className: 'dpz-count' }, '已启用 ', h('b', null, String(enabledCount)), ' / 4')),
        h('div', { className: 'dpz-modes', role: 'tablist', 'aria-label': '中文预设模式' }, ...modes.map(card)),
        h('div', { className: 'dpz-panel', role: 'tabpanel', 'aria-label': mode.label },
          h('div', { className: 'dpz-panel-head' },
            h('span', { className: 'dpz-glyph dpz-lg', 'aria-hidden': true }, mode.glyph),
            h('div', { className: 'dpz-panel-title' },
              h('h4', null, mode.label),
              h('div', { className: 'dpz-meta' },
                h('code', null, mode.id),
                h('span', null, mode.context ? '保留 AGENTS.md 与 Skills' : '不注入 AGENTS.md 与 Skills'))),
            h('label', { className: 'dpz-enable' }, toggle(mode.key, mode.label), '启用此模式')),
          h('fieldset', { className: 'dpz-fieldset', disabled: readonly },
            h('div', { className: 'dpz-row' }, ...fields.map(({ field, title, hint }) => h('label', { key: field, className: 'dpz-field' },
              h('span', { className: 'dpz-label' }, title),
              h('input', { className: 'dpz-input', value: value[field] ?? '', placeholder: base[field] || hint, onChange: event => change(mode.key, field, event.target.value) })))),
            h('label', { className: 'dpz-field' },
              h('span', { className: 'dpz-label' }, '系统提示词', h('small', null, `${(value.prompt ?? '').length} 字`)),
              h('textarea', { className: 'dpz-input', rows: 8, value: value.prompt ?? '', placeholder: base.prompt, onChange: event => change(mode.key, 'prompt', event.target.value) }),
              h('span', { className: 'dpz-hint' }, mode.context
                ? '作为角色前缀；工具、团队、MCP 等操作说明仍由当前组合动态组装并汉化。留空使用默认内容。'
                : '中文极简只使用这段提示词。留空使用默认内容。')),
            h('div', null,
              h('button', { type: 'button', className: 'dpz-btn dpz-small', disabled: same(value, base), onClick: () => reset(mode.key) }, '恢复此模式默认设置')))),
        h('div', { className: 'dpz-bar' },
          h('p', { className: 'dpz-status', role: 'status', 'aria-live': 'polite', 'data-tone': status.tone, style: { margin: 0 } }, status.text),
          h('div', { className: 'dpz-actions' },
            h('button', { type: 'button', className: 'dpz-btn', disabled: busy, onClick: reload }, '重新载入'),
            h('button', { type: 'button', className: 'dpz-btn dpz-primary', disabled: readonly || !dirty, onClick: save }, busy ? '保存中…' : '保存设置'))))
    }

    function apply(ctx) {
      const form = ctx.configForms.get('dsh-presets-zh')
      for (const [slot, key] of [
        ['plugins.bundle.config', '@zhiqiangme/dsh-presets-zh'],
        ['plugins.row.config', '@zhiqiangme/dsh-presets-zh#dsh-presets-zh'],
      ]) ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, inject: () => ({ form }) }, ModeSettings))
    }
    return { name: 'minimal-prompt-settings', inject: ['slots', 'configForms'], apply, ModeSettings }
  },
})
