/**
 * dsh-plugin-mcp-switch — client half.
 *
 * 设置里的「MCP 开关」小页面：
 *   - 顶部：启动策略下拉 + 会话结束自动回收勾选
 *   - 分组预设：点一下应用（组内连上、组外断开）
 *   - 列表：状态 + 上下文成本 + 连接/断开
 * 数据来自 host 的 /mcp-switch/api/*，与 agent 工具 mcp_switch_* 共享同一份状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/mcp-switch/api'

    const STATUS_TEXT = {
      connected: '已连接',
      connecting: '连接中',
      error: '错误',
      stopped: '未连接',
      disabled: '已断开',
    }

    const MODE_TEXT = {
      'always-off': 'always-off — 每次启动一律断开',
      remember: 'remember — 恢复上次状态',
      'auto-start': 'auto-start — 只连标记自启的',
    }

    function fmtTokens(n) {
      if (!n) return ''
      if (n >= 1000000) return `≈${(n / 1000000).toFixed(2)}M tokens`
      if (n >= 1000) return `≈${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k tokens`
      return `≈${n} tokens`
    }

    async function call(path, options) {
      const resp = await fetch(API + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })
      const body = await resp.json().catch(() => ({}))
      return { ok: resp.ok, status: resp.status, body }
    }

    const css = [
      '.mcpsw{display:flex;flex-direction:column;gap:14px;padding:0 24px 24px}',
      '.mcpsw-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888)}',
      '.mcpsw-card{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid rgba(128,128,128,.28);border-radius:12px;padding:12px 14px}',
      '.mcpsw-card select{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}',
      '.mcpsw-label{font-weight:600;font-size:14px}',
      '.mcpsw-row{display:flex;align-items:center;gap:12px;border:1px solid rgba(128,128,128,.28);border-radius:12px;padding:12px 14px}',
      '.mcpsw-name{font-weight:600;font-size:14px;min-width:110px}',
      '.mcpsw-badge{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)}',
      '.mcpsw-badge.connected{color:#2e7d32;border-color:#2e7d32}',
      '.mcpsw-badge.error{color:#c62828;border-color:#c62828}',
      '.mcpsw-badge.connecting,.mcpsw-badge.disabled,.mcpsw-badge.stopped{color:#888}',
      '.mcpsw-cost{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}',
      '.mcpsw-err{font-size:11px;color:#c62828;word-break:break-all}',
      '.mcpsw-btn{cursor:pointer;font-size:12px;padding:5px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}',
      '.mcpsw-btn:hover{background:rgba(128,128,128,.12)}',
      '.mcpsw-btn:disabled{opacity:.5;cursor:default}',
      '.mcpsw-row .mcpsw-btn{margin-left:auto}',
      '.mcpsw-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#888)}',
      '.mcpsw-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}',
    ].join('')

    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="dsh-plugin-mcp-switch/page"]')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-mcp-switch'
      tag.dataset.pluginCss = 'dsh-plugin-mcp-switch/page'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    function Row({ server, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const toggle = async () => {
        setBusy(true)
        setError('')
        const action = server.status === 'connected' ? 'disconnect' : 'connect'
        const r = await call(`/servers/${server.id}/${action}`, { method: 'POST' }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        if (!r.ok) setError(r.body.error || '操作失败')
        setBusy(false)
        onChanged()
      }

      const showError = error || server.error
      const toggleAuto = async (next) => {
        await call(`/servers/${server.id}/autostart`, { method: 'POST', body: JSON.stringify({ autoStart: next }) }).catch(() => {})
        onChanged()
      }
      return h('div', { className: 'mcpsw-row' },
        h('span', { className: 'mcpsw-name' }, server.name),
        h('span', { className: `mcpsw-badge ${server.status}` }, STATUS_TEXT[server.status] || server.status),
        h('label', { className: 'mcpsw-cost', title: '只在启动策略为 auto-start 时生效' },
          h('input', { type: 'checkbox', checked: !!server.autoStart, onChange: (e) => toggleAuto(e.target.checked) }),
          '自启',
        ),
        server.cost ? h('span', { className: 'mcpsw-cost' }, `${server.cost.tools} 工具 ${fmtTokens(server.cost.tokens)}`) : null,
        showError ? h('span', { className: 'mcpsw-err' }, showError) : null,
        h('button', {
          className: 'mcpsw-btn',
          onClick: toggle,
          disabled: busy || server.status === 'connecting',
        }, busy ? '…' : (server.status === 'connected' ? '断开' : '连接')),
      )
    }

    function Page() {
      const [servers, setServers] = useState([])
      const [groups, setGroups] = useState([])
      const [mode, setMode] = useState('always-off')
      const [reclaim, setReclaim] = useState(true)
      const [loaded, setLoaded] = useState(false)
      const [notice, setNotice] = useState('')

      const refresh = useCallback(() => {
        call('/state')
          .then((r) => {
            if (r.ok) {
              setServers(r.body.servers || [])
              setGroups(r.body.groups || [])
              setMode(r.body.startupMode || 'always-off')
              setReclaim(r.body.reclaimOnSessionEnd !== false)
            }
            setLoaded(true)
          })
          .catch(() => setLoaded(true))
      }, [])

      useEffect(() => {
        refresh()
        const t = setInterval(refresh, 3000)
        return () => clearInterval(t)
      }, [refresh])

      const changeMode = async (next) => {
        const prev = mode
        setMode(next)
        const r = await call('/policy', { method: 'POST', body: JSON.stringify({ mode: next }) }).catch(() => ({ ok: false }))
        if (!r.ok) setMode(prev)
        refresh()
      }

      const changeReclaim = async (next) => {
        setReclaim(next)
        await call('/policy', { method: 'POST', body: JSON.stringify({ reclaimOnSessionEnd: next }) }).catch(() => {})
        refresh()
      }

      const applyGroup = async (name) => {
        setNotice('')
        const r = await call(`/groups/${encodeURIComponent(name)}/apply`, { method: 'POST', body: '{}' }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        if (!r.ok) setNotice(r.body.error || '应用分组失败')
        else setNotice(r.body.message || '已应用')
        refresh()
      }

      return h('div', { className: 'mcpsw' },
        h('div', { className: 'mcpsw-card' },
          h('span', { className: 'mcpsw-label' }, '启动策略'),
          h('select', { value: mode, onChange: (e) => changeMode(e.target.value) },
            Object.keys(MODE_TEXT).map((k) => h('option', { key: k, value: k }, MODE_TEXT[k])),
          ),
          h('label', { className: 'mcpsw-check' },
            h('input', { type: 'checkbox', checked: reclaim, onChange: (e) => changeReclaim(e.target.checked) }),
            '会话结束自动回收本次打开的 MCP',
          ),
        ),
        groups.length
          ? h('div', { className: 'mcpsw-card' },
            h('span', { className: 'mcpsw-label' }, '分组'),
            groups.map((g) => h('button', {
              key: g.name,
              className: 'mcpsw-btn',
              title: g.servers.join('、'),
              onClick: () => applyGroup(g.name),
            }, `应用 ${g.name}`)),
          )
          : null,
        h('div', { className: 'mcpsw-hint' },
          'MCP 默认断开：不加载工具、不占用上下文。点「连接」临时打开，用完点「断开」。',
          '也可以让我直接用 mcp_switch_on / off / list / add / group 控制。',
        ),
        notice ? h('div', { className: 'mcpsw-hint' }, notice) : null,
        servers.length === 0 && loaded
          ? h('div', { className: 'mcpsw-empty' }, '还没有配置任何 MCP 服务器。')
          : null,
        servers.map((s) => h(Row, { server: s, onChanged: refresh, key: s.id })),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-switch',
          order: 55,
          label: 'MCP 开关',
        }, Page))
      },
    }
  },
})
