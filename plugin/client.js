window.__ModuleLoader__.load({
  id: '@local/dsh-cliapi',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const PROVIDERS = [
      { id: 'codex', name: 'Codex', desc: 'OpenAI / ChatGPT OAuth' },
      { id: 'claude', name: 'Claude', desc: 'Anthropic OAuth' },
      { id: 'antigravity', name: 'Antigravity', desc: 'Google OAuth · Gemini' },
      { id: 'kimi', name: 'Kimi', desc: '设备码 OAuth' },
      { id: 'grok', name: 'Grok', desc: 'xAI 设备码 OAuth' },
    ]

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 1180 },
      heading: { margin: 0, fontSize: 22 },
      muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.6 },
      notice: { padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13 },
      bad: { padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 },
      card: { padding: 14, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)' },
      row: { display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 180 },
      label: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 },
      input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
      button: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', padding: '7px 11px', cursor: 'pointer' },
      primary: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', padding: '7px 11px', cursor: 'pointer', fontWeight: 650 },
      danger: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', padding: '5px 8px', cursor: 'pointer' },
      candidate: { display: 'grid', gridTemplateColumns: '28px 1fr auto', gap: 8, alignItems: 'center', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '7px 8px', marginBottom: 6 },
    }

    const keyOf = (provider, model) => `${provider}\u0000${model}`

    async function api(path, options = {}) {
      const response = await fetch(`/dsh-cliapi/api${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    function CliapiPanel() {
      const [payload, setPayload] = useState(null)
      const [candidates, setCandidates] = useState([])
      const [enabled, setEnabled] = useState(true)
      const [cooldown, setCooldown] = useState(60)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')

      const refresh = useCallback(async () => {
        const next = await api('/status')
        setPayload(next)
        setCandidates((next.auto?.candidates ?? []).map(item => ({ ...item })))
        setEnabled(next.auto?.enabled !== false)
        setCooldown(next.auto?.cooldownSeconds ?? 60)
      }, [])

      useEffect(() => {
        refresh().catch(item => setError(item.message))
      }, [refresh])

      const flash = (message, bad = false) => {
        if (bad) { setError(message); setNotice('') } else { setNotice(message); setError('') }
      }

      const startOAuth = async (provider) => {
        setBusy(provider)
        const popup = window.open('about:blank', '_blank', 'width=920,height=760')
        if (popup) popup.opener = null
        try {
          const flow = await api('/oauth/start', { method: 'POST', body: JSON.stringify({ provider }) })
          if (popup) popup.location.href = flow.url
          else window.open(flow.url, '_blank', 'noopener')
          flash(`${provider} 授权页已打开${flow.userCode ? `，设备码 ${flow.userCode}` : ''}。完成后会自动刷新。`)
          const timer = window.setInterval(async () => {
            try {
              const result = await api(`/oauth/status?state=${encodeURIComponent(flow.state)}`)
              if (result.status === 'ok') {
                window.clearInterval(timer)
                flash(`${provider} 授权成功`)
                await refresh()
              } else if (result.status === 'error') {
                window.clearInterval(timer)
                flash(result.error || `${provider} 授权失败`, true)
              }
            } catch (item) {
              window.clearInterval(timer)
              flash(item.message, true)
            }
          }, 1800)
        } catch (item) {
          if (popup) popup.close()
          flash(item.message, true)
        } finally {
          setBusy('')
        }
      }

      const saveDefault = async () => {
        const select = document.getElementById('dsh-cliapi-default')
        if (!select) return
        const [provider, model] = select.value.split('\u0000')
        setBusy('default')
        try {
          await api('/default-model', { method: 'POST', body: JSON.stringify({ provider, model }) })
          flash('默认模型已更新；新会话会使用它。')
          await refresh()
        } catch (item) {
          flash(item.message, true)
        } finally {
          setBusy('')
        }
      }

      const saveAuto = async (makeDefault) => {
        setBusy(makeDefault ? 'auto-default' : 'auto')
        try {
          await api('/auto', {
            method: 'PUT',
            body: JSON.stringify({ enabled, candidates, cooldownSeconds: Number(cooldown) }),
          })
          if (makeDefault) {
            await api('/default-model', { method: 'POST', body: JSON.stringify({ provider: payload.auto.provider, model: 'auto' }) })
          }
          flash(makeDefault ? 'Auto 已保存并设为默认' : 'Auto 设置已保存')
          await refresh()
        } catch (item) {
          flash(item.message, true)
        } finally {
          setBusy('')
        }
      }

      if (!payload) {
        return React.createElement('section', { style: styles.root },
          React.createElement('h2', { style: styles.heading }, '授权与 Auto'),
          React.createElement('p', { style: styles.muted }, error || '正在读取本机授权状态…'))
      }

      const accountsOf = id => (payload.accounts ?? []).filter(row => row.provider === id)
      const addSelectModels = (payload.models ?? []).filter(model =>
        !candidates.some(item => item.provider === model.provider && item.model === model.id))

      return React.createElement('section', { style: styles.root, 'aria-label': 'DSH_CLIAPI 授权与 Auto' },
        React.createElement('div', null,
          React.createElement('h2', { style: styles.heading }, '授权与 Auto（DSH_CLIAPI）'),
          React.createElement('p', { style: { ...styles.muted, marginTop: 6 } },
            `本机服务 v${payload.version} · 在设置里完成授权和 Auto，不再打开单独的浏览器面板。厂商登录页仍由官方站点处理。`)),
        error ? React.createElement('div', { style: styles.bad }, error) : null,
        notice ? React.createElement('div', { style: styles.notice }, notice) : null,
        React.createElement('div', { style: styles.grid },
          PROVIDERS.map(provider => {
            const accounts = accountsOf(provider.id)
            return React.createElement('article', { key: provider.id, style: styles.card },
              React.createElement('strong', null, provider.name),
              React.createElement('p', { style: styles.muted }, provider.desc),
              React.createElement('p', { style: { ...styles.muted, margin: '8px 0' } },
                accounts.length ? `已连接 ${accounts.length}` : '未连接'),
              accounts.map(account => React.createElement('div', { key: account.label, style: styles.muted },
                `${account.label} · ${account.disabled ? '已停用' : account.unavailable ? '暂不可用' : '可用'}`)),
              React.createElement('button', {
                style: styles.primary,
                disabled: busy === provider.id,
                onClick: () => startOAuth(provider.id),
              }, busy === provider.id ? '正在发起…' : '连接或重新授权'))
          })),
        React.createElement('article', { style: styles.card },
          React.createElement('h3', { style: { margin: '0 0 8px', fontSize: 16 } }, '默认模型'),
          React.createElement('p', { style: styles.muted }, '只影响以后新建的会话。'),
          React.createElement('div', { style: styles.row },
            React.createElement('div', { style: styles.grow },
              React.createElement('label', { style: styles.label, htmlFor: 'dsh-cliapi-default' }, '模型'),
              React.createElement('select', {
                id: 'dsh-cliapi-default',
                style: styles.input,
                defaultValue: `${payload.defaultModel.provider}\u0000${payload.defaultModel.model}`,
              },
              [React.createElement('option', {
                key: 'auto',
                value: `${payload.auto.provider}\u0000auto`,
              }, 'Auto · Harness + CLIProxyAPI'),
              ...(payload.models ?? []).map(model => React.createElement('option', {
                key: keyOf(model.provider, model.id),
                value: keyOf(model.provider, model.id),
              }, `${model.source === 'harness' ? 'Harness' : 'CLIProxyAPI'} · ${model.providerName} · ${model.name}`))])),
            React.createElement('button', { style: styles.primary, disabled: busy === 'default', onClick: saveDefault },
              busy === 'default' ? '正在保存…' : '设为默认')),
          React.createElement('p', { style: { ...styles.muted, marginTop: 8 } },
            `当前默认：${payload.defaultModel.provider} / ${payload.defaultModel.model}`)),
        React.createElement('article', { style: styles.card },
          React.createElement('h3', { style: { margin: '0 0 8px', fontSize: 16 } }, 'Auto 自动调度'),
          React.createElement('label', { style: { ...styles.muted, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
            React.createElement('input', { type: 'checkbox', checked: enabled, onChange: event => setEnabled(event.target.checked) }),
            '启用 Auto'),
          candidates.map((candidate, index) => {
            const model = (payload.models ?? []).find(item => item.provider === candidate.provider && item.id === candidate.model)
            return React.createElement('div', { key: `${candidate.provider}/${candidate.model}/${index}`, style: styles.candidate },
              React.createElement('span', null, String(index + 1)),
              React.createElement('code', null, model ? `${model.providerName} / ${model.name}` : `${candidate.provider} / ${candidate.model}`),
              React.createElement('div', null,
                React.createElement('button', {
                  style: styles.button, disabled: index === 0,
                  onClick: () => setCandidates(list => {
                    const next = list.slice()
                    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                    return next
                  }),
                }, '↑'),
                React.createElement('button', {
                  style: styles.button, disabled: index === candidates.length - 1,
                  onClick: () => setCandidates(list => {
                    const next = list.slice()
                    ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                    return next
                  }),
                }, '↓'),
                React.createElement('button', {
                  style: styles.danger,
                  onClick: () => setCandidates(list => list.filter((_, itemIndex) => itemIndex !== index)),
                }, '×')))
          }),
          React.createElement('div', { style: { ...styles.row, marginTop: 8 } },
            React.createElement('select', { id: 'dsh-cliapi-add', style: { ...styles.input, ...styles.grow } },
              addSelectModels.map(model => React.createElement('option', {
                key: keyOf(model.provider, model.id),
                value: keyOf(model.provider, model.id),
              }, `${model.providerName} · ${model.name}`))),
            React.createElement('button', {
              style: styles.button,
              disabled: addSelectModels.length === 0,
              onClick: () => {
                const select = document.getElementById('dsh-cliapi-add')
                if (!select?.value) return
                const [provider, model] = select.value.split('\u0000')
                setCandidates(list => [...list, { provider, model }])
              },
            }, '添加')),
          React.createElement('label', { style: { ...styles.label, marginTop: 12 } }, '失败冷却（秒）'),
          React.createElement('input', {
            type: 'number', min: 5, max: 600, step: 5, value: cooldown, style: styles.input,
            onChange: event => setCooldown(event.target.value),
          }),
          React.createElement('div', { style: { ...styles.row, marginTop: 12 } },
            React.createElement('button', { style: styles.primary, disabled: Boolean(busy), onClick: () => saveAuto(false) },
              busy === 'auto' ? '正在保存…' : '保存 Auto 设置'),
            React.createElement('button', { style: styles.button, disabled: Boolean(busy), onClick: () => saveAuto(true) },
              busy === 'auto-default' ? '正在保存…' : '保存并设为默认')),
          React.createElement('p', { style: { ...styles.muted, marginTop: 8 } },
            payload.auto?.lastDispatch
              ? `最近调度：${payload.auto.lastDispatch.provider} / ${payload.auto.lastDispatch.model}`
              : '最近调度：暂无')))
    }

    const name = 'dsh-cliapi'
    const LLM_LANES = [
      { id: 'text', title: '文本回退（可选）', hint: '媒体模型都失败时才用。平时普通对话仍走当前会话模型。' },
      { id: 'image', title: '图片', hint: '识图、看截图、生图。' },
      { id: 'video', title: '视频', hint: '看视频、生成视频。' },
      { id: 'audio', title: '音频', hint: '听录音、转写、配音。' },
    ]

    const llmKeyOf = item => `${item.provider}\u0000${item.model || item.id}`

    async function llmApi(path, options = {}) {
      const response = await fetch(`/dshllm-api/api${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    function emptyLanes() {
      return { text: [], image: [], video: [], audio: [] }
    }

    function LlmApiPanel() {
      const [payload, setPayload] = useState(null)
      const [lanes, setLanes] = useState(emptyLanes)
      const [enabled, setEnabled] = useState(true)
      const [cooldown, setCooldown] = useState(60)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')

      const refresh = useCallback(async () => {
        const next = await llmApi('/status')
        setPayload(next)
        setLanes({
          text: (next.router?.lanes?.text ?? []).map(item => ({ ...item })),
          image: (next.router?.lanes?.image ?? []).map(item => ({ ...item })),
          video: (next.router?.lanes?.video ?? []).map(item => ({ ...item })),
          audio: (next.router?.lanes?.audio ?? []).map(item => ({ ...item })),
        })
        setEnabled(next.router?.enabled !== false)
        setCooldown(next.router?.cooldownSeconds ?? 60)
      }, [])

      useEffect(() => {
        refresh().catch(item => setError(item.message))
      }, [refresh])

      const flash = (message, bad = false) => {
        if (bad) { setError(message); setNotice('') } else { setNotice(message); setError('') }
      }

      const move = (lane, index, delta) => {
        setLanes(current => {
          const list = current[lane].slice()
          if (delta === 0) {
            list.splice(index, 1)
          } else {
            const target = index + delta
            if (target < 0 || target >= list.length) return current
            ;[list[index], list[target]] = [list[target], list[index]]
          }
          return { ...current, [lane]: list }
        })
      }

      const addToLane = (lane, value) => {
        const [provider, model] = value.split('\u0000')
        if (!provider || !model) return
        setLanes(current => {
          if (Object.values(current).flat().some(item => item.provider === provider && item.model === model)) return current
          return { ...current, [lane]: [...current[lane], { provider, model }] }
        })
      }

      const saveDefault = async () => {
        const select = document.getElementById('dshllm-default')
        if (!select) return
        const [provider, model] = select.value.split('\u0000')
        setBusy('default')
        try {
          await llmApi('/default-model', { method: 'POST', body: JSON.stringify({ provider, model }) })
          flash('默认模型已更新；新会话会使用它。')
          await refresh()
        } catch (item) {
          flash(item.message, true)
        } finally {
          setBusy('')
        }
      }

      const saveRouter = async () => {
        setBusy('router')
        try {
          await llmApi('/router', {
            method: 'PUT',
            body: JSON.stringify({ enabled, lanes, cooldownSeconds: Number(cooldown) }),
          })
          flash('调度设置已保存。普通对话仍用当前模型，媒体任务会自动切换。')
          await refresh()
        } catch (item) {
          flash(item.message, true)
        } finally {
          setBusy('')
        }
      }

      if (!payload) {
        return React.createElement('section', { style: styles.root },
          React.createElement('h2', { style: styles.heading }, '多模态调度'),
          React.createElement('p', { style: styles.muted }, error || '正在读取调度状态…'))
      }

      const used = new Set(Object.values(lanes).flat().map(llmKeyOf))

      return React.createElement('section', { style: styles.root, 'aria-label': 'DSH_CLIAPI 多模态调度' },
        React.createElement('div', null,
          React.createElement('h2', { style: styles.heading }, '多模态调度（已合并到 DSH_CLIAPI）'),
          React.createElement('p', { style: { ...styles.muted, marginTop: 6 } },
            `本机服务 v${payload.version} · 在设置里配置图片/视频/音频优先级，不再打开单独的浏览器面板。`)),
        error ? React.createElement('div', { style: styles.notice }, error) : null,
        notice ? React.createElement('div', { style: styles.notice }, notice) : null,
        React.createElement('article', { style: styles.card },
          React.createElement('h3', { style: { margin: '0 0 8px', fontSize: 16 } }, '当前推理模型'),
          React.createElement('p', { style: styles.muted }, '普通对话继续用这个模型。媒体调度不依赖它。'),
          React.createElement('div', { style: styles.row },
            React.createElement('select', {
              id: 'dshllm-default',
              style: { ...styles.input, ...styles.grow },
              defaultValue: `${payload.defaultModel?.provider ?? ''}\u0000${payload.defaultModel?.model ?? ''}`,
            }, (payload.models ?? []).map(model => React.createElement('option', {
              key: llmKeyOf(model),
              value: `${model.provider}\u0000${model.id}`,
            }, `${model.source === 'cliproxy' ? 'CLIProxyAPI' : 'Harness'} · ${model.providerName} · ${model.name}`))),
            React.createElement('button', { style: styles.primary, disabled: busy === 'default', onClick: saveDefault },
              busy === 'default' ? '正在保存…' : '设为默认'))),
        React.createElement('article', { style: styles.card },
          React.createElement('label', { style: { ...styles.muted, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
            React.createElement('input', { type: 'checkbox', checked: enabled, onChange: event => setEnabled(event.target.checked) }),
            '启用自动调度'),
          React.createElement('div', { style: styles.grid },
            LLM_LANES.map(lane => {
              const available = (payload.models ?? []).filter(model => !used.has(llmKeyOf(model)))
              const preferred = available.filter(model => model.suggestedLane === lane.id)
              const others = available.filter(model => model.suggestedLane !== lane.id)
              return React.createElement('div', { key: lane.id },
                React.createElement('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, lane.title),
                React.createElement('p', { style: styles.muted }, lane.hint),
                lanes[lane.id].map((candidate, index) => {
                  const model = (payload.models ?? []).find(item => item.provider === candidate.provider && item.id === candidate.model)
                  return React.createElement('div', { key: `${candidate.provider}/${candidate.model}`, style: styles.candidate },
                    React.createElement('span', null, String(index + 1)),
                    React.createElement('code', null, model ? `${model.providerName} / ${model.name}` : `${candidate.provider} / ${candidate.model}`),
                    React.createElement('div', null,
                      React.createElement('button', { style: styles.button, disabled: index === 0, onClick: () => move(lane.id, index, -1) }, '↑'),
                      React.createElement('button', { style: styles.button, disabled: index === lanes[lane.id].length - 1, onClick: () => move(lane.id, index, 1) }, '↓'),
                      React.createElement('button', { style: styles.button, onClick: () => move(lane.id, index, 0) }, '×')))
                }),
                React.createElement('div', { style: { ...styles.row, marginTop: 8 } },
                  React.createElement('select', { id: `dshllm-add-${lane.id}`, style: { ...styles.input, ...styles.grow } },
                    [...preferred, ...others].map(model => React.createElement('option', {
                      key: llmKeyOf(model),
                      value: `${model.provider}\u0000${model.id}`,
                    }, `${model.suggestedLane === lane.id ? '建议 · ' : ''}${model.providerName} · ${model.name}`))),
                  React.createElement('button', {
                    style: styles.button,
                    onClick: () => {
                      const select = document.getElementById(`dshllm-add-${lane.id}`)
                      if (select?.value) addToLane(lane.id, select.value)
                    },
                  }, '添加')))
            })),
          React.createElement('label', { style: { ...styles.label, marginTop: 12 } }, '同类失败冷却（秒）'),
          React.createElement('input', {
            type: 'number', min: 5, max: 600, step: 5, value: cooldown, style: styles.input,
            onChange: event => setCooldown(event.target.value),
          }),
          React.createElement('div', { style: { marginTop: 12 } },
            React.createElement('button', { style: styles.primary, disabled: Boolean(busy), onClick: saveRouter },
              busy === 'router' ? '正在保存…' : '保存调度设置')),
          React.createElement('p', { style: { ...styles.muted, marginTop: 8 } },
            payload.router?.lastDispatch
              ? `最近调度：${payload.router.lastDispatch.lane} → ${payload.router.lastDispatch.provider} / ${payload.router.lastDispatch.model}`
              : '最近调度：暂无')))
    }

    function UnifiedPanel() {
      const [tab, setTab] = useState('authorization')
      const tabs = [
        { id: 'authorization', label: '授权与 Auto' },
        { id: 'multimodal', label: '多模态调度' },
      ]
      return React.createElement('section', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, width: '100%' },
        'aria-label': 'DSH_CLIAPI 模型与授权',
      },
      React.createElement('div', {
        role: 'tablist',
        'aria-label': '模型与授权功能',
        style: { display: 'flex', gap: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 8 },
      }, tabs.map(item => React.createElement('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === item.id,
        style: {
          ...styles.button,
          fontWeight: tab === item.id ? 700 : 400,
          borderColor: tab === item.id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)',
        },
        onClick: () => setTab(item.id),
      }, item.label))),
      tab === 'authorization'
        ? React.createElement(CliapiPanel)
        : React.createElement(LlmApiPanel))
    }


    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-cliapi',
        order: 8,
        label: () => '模型与授权',
        inject: () => ({}),
      }, UnifiedPanel))
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
