/* 复用宿主的配置表单、持久化与版本检查，不另建配置文件或 HTTP 写入接口。 */
window.__ModuleLoader__.load({
  id: '@zhiqiangme/dsh-preset-minimal-prompt',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React
    const modes = [
      ['minimalPrompt', '极简提示词'], ['standard', '中文标准'],
      ['ptc', '中文 PTC'], ['creation', '中文创造'],
    ]
    const fieldStyle = { display: 'block', width: '100%', boxSizing: 'border-box', color: 'inherit', background: 'transparent', border: '1px solid #8886', borderRadius: 6, padding: 8, marginTop: 5 }

    function ModeSettings({ form, view }) {
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [revision, setRevision] = useState()
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
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
        setNotice('')
      }
      const reload = () => {
        setDraft(structuredClone(snapshot.value))
        setRevision(snapshot.revision)
        setDirty(false)
        setNotice('')
      }
      const save = async () => {
        setBusy(true)
        setNotice('')
        try {
          // 绑定开始编辑时的版本；其他页面写入后须重新载入，不能覆盖较新的设置。
          const accepted = await form.mutate(modes.map(([key]) => ({ op: 'set', path: [key], value: draft[key] })), revision)
          if (accepted) {
            setDirty(false)
            setNotice('已保存。新会话使用新设置；已有会话可切换模式后使用。')
          } else setNotice('未保存，配置可能已在其他页面更新。请重新载入后再编辑。')
        } catch (error) {
          setNotice(`保存失败：${error.message}`)
        } finally { setBusy(false) }
      }
      const readonly = busy || !snapshot.writable
      return h('section', { style: { maxWidth: 900 } },
        h('h3', null, '中文模式预设'),
        h('p', { style: { opacity: .75 } }, '分别设置四种模式，修改后点击保存。AGENTS.md 与技能原文保留。'),
        ...modes.map(([key, label]) => h('details', { key, open: true, style: { border: '1px solid #8885', borderRadius: 10, padding: 14, marginBottom: 12 } },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, label),
          h('fieldset', { disabled: readonly, style: { border: 0, padding: '12px 0 0', margin: 0, minWidth: 0 } },
            h('label', null, h('input', { type: 'checkbox', checked: draft[key]?.enabled !== false, onChange: event => change(key, 'enabled', event.target.checked) }), ' 启用此模式'),
            ...[['name', '显示名称'], ['description', '模式描述'], ['prompt', '系统提示词']].map(([field, title]) => h('label', { key: field, style: { display: 'block', marginTop: 12 } }, title,
              h(field === 'prompt' ? 'textarea' : 'input', { style: fieldStyle, rows: field === 'prompt' ? 4 : undefined, value: draft[key]?.[field] ?? '', onChange: event => change(key, field, event.target.value) }))),
            h('button', { type: 'button', style: { marginTop: 12 }, onClick: () => {
              setDraft(previous => ({ ...previous, [key]: structuredClone(snapshot.base[key]) }))
              setDirty(true)
              setNotice('默认内容已填入，点击保存后生效。')
            } }, '恢复此模式默认设置')))),
        h('div', { style: { display: 'flex', gap: 12 } },
          h('button', { type: 'button', disabled: readonly || !dirty, onClick: save }, busy ? '保存中…' : '保存设置'),
          h('button', { type: 'button', disabled: busy, onClick: reload }, '重新载入')),
        h('p', { role: 'status', 'aria-live': 'polite' }, notice || (dirty ? '有未保存的更改' : '')))
    }

    function apply(ctx) {
      const form = ctx.configForms.get('dsh-preset-minimal-prompt')
      for (const [slot, key] of [
        ['plugins.bundle.config', '@zhiqiangme/dsh-preset-minimal-prompt'],
        ['plugins.row.config', '@zhiqiangme/dsh-preset-minimal-prompt#dsh-preset-minimal-prompt'],
      ]) ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key, priority: 30, inject: () => ({ form }) }, ModeSettings))
    }
    return { name: 'minimal-prompt-settings', inject: ['slots', 'configForms'], apply, ModeSettings }
  },
})
