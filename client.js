/**
 * dsh-plugin-mcp-switch — client half.
 *
 * 设置里的「MCP 开关」页面。后端 /mcp-switch/api/state 与 agent 工具
 * mcp_switch_* 共享同一份状态；这个页面是它的可视化控制面。
 *
 * 设计：Operate 模式——状态一眼可读、操作就地反馈、样式只走宿主主题 token。
 * 展示旧 UI 没有暴露的两件事：会话归属（谁开着这个连接）与隔离/桥健康度。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/mcp-switch/api'

    const STATUS = {
      connected: { label: '已连接', tone: 'ok' },
      connecting: { label: '连接中', tone: 'warn' },
      error: { label: '错误', tone: 'error' },
      stopped: { label: '未连接', tone: 'idle' },
      disabled: { label: '已断开', tone: 'idle' },
    }

    const MODE_LABEL = {
      'always-off': '一律断开（默认）',
      remember: '恢复上次状态',
      'auto-start': '只连标记自启的',
    }

    function fmtTokens(n) {
      if (!n) return ''
      if (n >= 1_000_000) return `≈${(n / 1_000_000).toFixed(2)}M tokens`
      if (n >= 1_000) return `≈${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k tokens`
      return `≈${n} tokens`
    }

    async function call(path, options) {
      let resp
      try {
        resp = await fetch(API + path, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        })
      } catch (e) {
        return { ok: false, status: 0, body: { error: `无法连接本地服务：${String(e && e.message || e)}` } }
      }
      const body = await resp.json().catch(() => ({}))
      return { ok: resp.ok, status: resp.status, body }
    }

    // ── 样式：只用宿主主题 token，无硬编码颜色 ───────────────────────────────
    const CSS = [
      '.mcpsw{display:flex;flex-direction:column;gap:16px;padding:2px 0 8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.mcpsw *{box-sizing:border-box}',
      '.mcpsw-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.mcpsw-title{font-size:15px;font-weight:650;letter-spacing:-.01em}',
      '.mcpsw-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcpsw-health{display:flex;gap:8px;flex-wrap:wrap}',
      '.mcpsw-health-item{display:flex;align-items:center;gap:6px;font-size:11px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}',
      '.mcpsw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}',
      '.mcpsw-dot.ok{background:var(--dsw-alias-state-success-primary)}',
      '.mcpsw-dot.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.mcpsw-dot.error{background:var(--dsw-alias-state-error-primary)}',
      '.mcpsw-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
      '.mcpsw-panel-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}',
      '.mcpsw-setting{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.mcpsw-setting-label{display:flex;flex-direction:column;gap:2px}',
      '.mcpsw-setting-label b{font-weight:600;font-size:13px}',
      '.mcpsw-setting-label small{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mcpsw select,.mcpsw button{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;transition:background .15s ease,border-color .15s ease}',
      '.mcpsw button{cursor:pointer}',
      '.mcpsw button:hover:not(:disabled){background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-brand-primary)}',
      '.mcpsw button:focus-visible,.mcpsw select:focus-visible,.mcpsw input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.mcpsw button:disabled{opacity:.5;cursor:default}',
      '.mcpsw button.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.mcpsw-groups{display:flex;gap:8px;flex-wrap:wrap}',
      '.mcpsw-groups button{white-space:nowrap}',
      '.mcpsw-list{display:flex;flex-direction:column;gap:8px}',
      '.mcpsw-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.mcpsw-item-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 220px}',
      '.mcpsw-item-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mcpsw-name{font-weight:600;font-size:13px}',
      '.mcpsw-badge{font-size:10px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-idle-primary)}',
      '.mcpsw-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.mcpsw-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.mcpsw-badge.error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mcpsw-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex-wrap:wrap}',
      '.mcpsw-owners{display:inline-flex;align-items:center;gap:4px}',
      '.mcpsw-owners b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mcpsw-err{font-size:11px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '.mcpsw-actions{display:flex;align-items:center;gap:10px;margin-left:auto}',
      '.mcpsw-auto{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.mcpsw-empty,.mcpsw-loading,.mcpsw-notice{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 0}',
      '.mcpsw-detail-btn{font-size:10px;padding:1px 7px;margin-left:6px}',
      '.mcpsw-retry{margin-left:8px}',
      '.mcpsw-notice{border-left:2px solid var(--dsw-alias-brand-primary);padding-left:10px}',
      '.mcpsw-notice.error{border-left-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.mcpsw-skeleton{height:58px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));opacity:.7}',
    ].join('')

    let cssInjected = false
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-plugin-mcp-switch/page"]')) { cssInjected = true; return }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-mcp-switch'
      tag.dataset.pluginCss = 'dsh-plugin-mcp-switch/page'
      tag.textContent = CSS
      document.head.appendChild(tag)
      cssInjected = true
    }

    function Health({ scoping, bridge }) {
      const scopeTone = scoping?.state === 'ok' ? 'ok' : scoping?.state === 'unsupported' ? 'error' : 'warn'
      const scopeLabel = scoping?.state === 'ok'
        ? `会话隔离正常${scoping.masked?.length ? ` · ${scoping.masked.length} 个会话被遮挡` : ''}`
        : scoping?.state === 'unsupported'
          ? `会话隔离不可用：${scoping.reason || '未知原因'}`
          : '会话隔离状态未知'
      const bridgeTone = bridge?.ok ? 'ok' : 'error'
      const bridgeLabel = bridge?.ok ? 'MCP 桥已就绪' : `MCP 桥不可用${bridge?.error ? `：${bridge.error}` : ''}`
      return h('div', { className: 'mcpsw-health' },
        h('span', { className: 'mcpsw-health-item', title: scoping?.reason || '' },
          h('span', { className: `mcpsw-dot ${scopeTone}` }), scopeLabel),
        h('span', { className: 'mcpsw-health-item', title: bridge?.source || '' },
          h('span', { className: `mcpsw-dot ${bridgeTone}` }), bridgeLabel),
      )
    }

    function ServerRow({ server, onChanged, onNotice }) {
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [showDetail, setShowDetail] = useState(false)
      const status = STATUS[server.status] || { label: server.status, tone: 'idle' }

      const doToggle = async (confirm) => {
        if (busy) return
        setBusy(true)
        // 动作在点击瞬间锁定，不让 3 秒轮询刷新 status 后误判成反向操作
        const action = server.status === 'connected' ? 'disconnect' : 'connect'
        const r = await call(`/servers/${encodeURIComponent(server.id)}/${action}`, {
          method: 'POST',
          body: JSON.stringify(confirm ? { confirm: true } : {}),
        }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        setBusy(false)
        if (r.status === 409 && r.body.needsConfirm && !confirm) {
          setConfirming(true)
          onNotice(`${server.name}：${r.body.error || '重服务器，请再点一次确认。'}`)
          return
        }
        setConfirming(false)
        if (!r.ok) onNotice(`${server.name}：${r.body.error || '操作失败'}`, true)
        else onNotice(`${server.name}：${r.body.message || (action === 'connect' ? '已连接。' : '已断开。')}`)
        onChanged()
      }

      const toggleAuto = async (next) => {
        const r = await call(`/servers/${encodeURIComponent(server.id)}/autostart`, {
          method: 'POST',
          body: JSON.stringify({ autoStart: next }),
        }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        if (!r.ok) onNotice(`${server.name}：设置自启失败——${r.body.error || '未知错误'}`, true)
        onChanged()
      }

      const owners = server.visibleTo || '全部会话'
      const detail = server.errorDetail && server.errorDetail !== server.error ? server.errorDetail : ''
      return h('div', { className: 'mcpsw-item' },
        h('div', { className: 'mcpsw-item-main' },
          h('div', { className: 'mcpsw-item-title' },
            h('span', { className: 'mcpsw-name' }, server.name),
            h('span', { className: `mcpsw-badge ${status.tone}` }, status.label),
            h('span', { className: 'mcpsw-badge' }, server.transport === 'stdio' ? 'stdio' : 'http'),
          ),
          h('div', { className: 'mcpsw-meta' },
            server.cost
              ? h('span', {}, `${server.cost.tools} 工具 · ${fmtTokens(server.cost.tokens)}`)
              : h('span', {}, '成本未测'),
            h('span', { className: 'mcpsw-owners' }, '可见：', h('b', {}, owners)),
          ),
          server.error
            ? h('div', { className: 'mcpsw-err' },
              server.error,
              detail
                ? h('button', {
                  className: 'mcpsw-detail-btn',
                  onClick: () => setShowDetail((v) => !v),
                  title: showDetail ? '收起错误链' : '展开错误链',
                }, showDetail ? '收起' : '详情')
                : null,
              showDetail && detail ? h('div', { className: 'mcpsw-err' }, detail) : null,
            )
            : null,
        ),
        h('div', { className: 'mcpsw-actions' },
          h('label', { className: 'mcpsw-auto', title: '只在启动策略为「只连标记自启的」时生效' },
            h('input', {
              type: 'checkbox',
              checked: !!server.autoStart,
              disabled: busy,
              onChange: (e) => toggleAuto(e.target.checked),
            }),
            '自启',
          ),
          h('button', {
            className: confirming ? 'primary' : '',
            onClick: () => doToggle(confirming),
            disabled: busy || server.status === 'connecting',
          }, busy ? '…' : confirming ? '确认连接' : (server.status === 'connected' ? '断开' : '连接')),
        ),
      )
    }

    function Panel() {
      const [servers, setServers] = useState([])
      const [groups, setGroups] = useState([])
      const [mode, setMode] = useState('always-off')
      const [reclaim, setReclaim] = useState(true)
      const [health, setHealth] = useState(null)
      const [loaded, setLoaded] = useState(false)
      const [notice, setNotice] = useState('')
      const [noticeError, setNoticeError] = useState(false)
      const [confirmGroup, setConfirmGroup] = useState('')
      const [loadFailed, setLoadFailed] = useState(false)
      const firstLoad = useRef(true)
      const writingPolicy = useRef(false) // 写策略期间轮询不覆盖本地乐观值

      const showNotice = useCallback((text, isError) => {
        setNotice(text || '')
        setNoticeError(!!isError)
      }, [])

      const refresh = useCallback(() => {
        call('/state')
          .then((r) => {
            if (r.ok && r.body) {
              const b = r.body
              setLoadFailed(false)
              setServers(b.servers || [])
              setGroups(b.groups || [])
              if (!writingPolicy.current) {
                setMode(b.startupMode || 'always-off')
                setReclaim(b.reclaimOnSessionEnd !== false)
              }
              setHealth({ scoping: b.scoping, bridge: b.bridge })
            } else if (!r.ok) {
              setLoadFailed(true)
              showNotice(r.body.error || '读取状态失败', true)
            }
          })
          .catch((e) => {
            setLoadFailed(true)
            showNotice(`读取状态失败：${String(e && e.message || e)}`, true)
          })
          .finally(() => { setLoaded(true); firstLoad.current = false })
      }, [showNotice])

      useEffect(() => {
        ensureCss()
        refresh()
        const t = setInterval(refresh, 3000)
        return () => clearInterval(t)
      }, [refresh])

      const changeMode = async (next) => {
        const prev = mode
        setMode(next)
        writingPolicy.current = true
        const r = await call('/policy', { method: 'POST', body: JSON.stringify({ mode: next }) }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        writingPolicy.current = false
        if (!r.ok) { setMode(prev); showNotice(`切换策略失败：${r.body.error || '未知错误'}`, true) }
        refresh()
      }

      const changeReclaim = async (next) => {
        const prev = reclaim
        setReclaim(next)
        writingPolicy.current = true
        const r = await call('/policy', { method: 'POST', body: JSON.stringify({ reclaimOnSessionEnd: next }) }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        writingPolicy.current = false
        if (!r.ok) { setReclaim(prev); showNotice(`设置会话回收失败：${r.body.error || '未知错误'}`, true) }
        refresh()
      }

      const applyGroup = async (name, confirmed) => {
        showNotice('')
        const r = await call(`/groups/${encodeURIComponent(name)}/apply`, {
          method: 'POST',
          body: JSON.stringify({ confirm: confirmed === true }),
        }).catch((e) => ({ ok: false, body: { error: String(e) } }))
        // 分组含重服务器且未确认：提示再点一次，不擅自替用户放行
        if (!r.ok && r.body.ok === false && /confirm|确认/.test(r.body.message || '')) {
          setConfirmGroup(name)
          showNotice(r.body.message || '分组含重服务器，请再点一次确认。', true)
          refresh()
          return
        }
        setConfirmGroup('')
        showNotice(r.body.message || (r.ok ? '已应用' : '应用分组失败'), !r.ok)
        refresh()
      }

      return h('div', { className: 'mcpsw' },
        h('div', { className: 'mcpsw-head' },
          h('span', { className: 'mcpsw-title' }, 'MCP 开关'),
          h('span', { className: 'mcpsw-sub' }, '按需连接 MCP，工具不占上下文时自动断开'),
        ),
        health ? h(Health, health) : null,

        h('div', { className: 'mcpsw-panel' },
          h('div', { className: 'mcpsw-panel-title' }, '启动策略'),
          h('div', { className: 'mcpsw-setting' },
            h('span', { className: 'mcpsw-setting-label' },
              h('b', {}, '连接策略'),
              h('small', {}, '决定 DSH 启动时哪些 MCP 自动连上'),
            ),
            h('select', { value: mode, onChange: (e) => changeMode(e.target.value), 'aria-label': '启动策略' },
              Object.keys(MODE_LABEL).map((k) => h('option', { key: k, value: k }, `${k} — ${MODE_LABEL[k]}`)),
            ),
          ),
          h('div', { className: 'mcpsw-setting' },
            h('span', { className: 'mcpsw-setting-label' },
              h('b', {}, '会话结束自动回收'),
              h('small', {}, '打开它的会话都结束后，自动断开连接'),
            ),
            h('label', { className: 'mcpsw-auto' },
              h('input', { type: 'checkbox', checked: reclaim, onChange: (e) => changeReclaim(e.target.checked) }),
              reclaim ? '开启' : '关闭',
            ),
          ),
        ),

        groups.length
          ? h('div', { className: 'mcpsw-panel' },
            h('div', { className: 'mcpsw-panel-title' }, '分组预设'),
            h('div', { className: 'mcpsw-groups' },
              groups.map((g) => h('button', {
                key: g.name,
                className: confirmGroup === g.name ? 'primary' : '',
                title: `组内连接：${(g.servers || []).join('、') || '（空）'}`,
                onClick: () => applyGroup(g.name, confirmGroup === g.name),
              }, confirmGroup === g.name ? `确认应用 ${g.name}` : `应用 ${g.name}`)),
            ),
          )
          : null,

        notice ? h('div', { className: `mcpsw-notice${noticeError ? ' error' : ''}`, role: 'status' }, notice) : null,

        h('div', { className: 'mcpsw-panel-title' }, `服务器（${servers.length}）`),
        !loaded && firstLoad.current
          ? h('div', { className: 'mcpsw-list' },
            h('div', { className: 'mcpsw-skeleton' }), h('div', { className: 'mcpsw-skeleton' }))
          : loadFailed
            ? h('div', { className: 'mcpsw-empty' },
              '无法读取 MCP 状态，请稍后重试。',
              h('button', { className: 'mcpsw-retry', onClick: refresh }, '重试'),
            )
            : servers.length === 0
              ? h('div', { className: 'mcpsw-empty' }, '还没有配置 MCP 服务器。让 agent 用 mcp_switch_add 添加，或在这里连接已有的声明式服务器。')
              : h('div', { className: 'mcpsw-list' },
                servers.map((s) => h(ServerRow, { server: s, key: s.id, onChanged: refresh, onNotice: showNotice })),
              ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-switch',
          order: 55,
          label: 'MCP 开关',
        }, Panel))
      },
    }
  },
})
