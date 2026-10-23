/**
 * dsh-plugin-mcp-switch — host half.
 *
 * MCP 服务器默认断开（工具 schema 不占上下文），需要时再打开。
 * 控制面有两个，读写同一份状态：
 *   1) agent 工具：mcp_switch_list / on / off / add / remove / policy / group
 *   2) 设置页里的小面板（client.js）：GET /mcp-switch/api/*
 *
 * 状态文件：~/.dsh/mcp-switch.json
 *   {
 *     "startupMode": "always-off" | "remember" | "auto-start",
 *     "reclaimOnSessionEnd": true,
 *     "groups": { "逆向": ["rea", "blender"] },
 *     "servers": [ { id, name, transport, enabled, autoStart, cost, config } ]
 *   }
 *
 * 启动策略（startupMode）：
 *   always-off  — 每次启动一律断开（默认）
 *   remember    — 恢复上次的开关状态
 *   auto-start  — 只自动连 autoStart:true 的
 *
 * 关键实现点（踩过的坑）：@deepseek-ai/dsh-mcp-client 打在 dsh 安装目录的
 * app.asar 里，profile 安装的插件用裸包名 import 在开机加载时会失败，所以这里
 * 用 process.resourcesPath + pathToFileURL 按绝对路径动态导入（Electron 认 asar）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export const name = 'mcp-switch'
export const inject = ['tools']

const STATE_PATH = join(homedir(), '.dsh', 'mcp-switch.json')
const BACKUP_PATH = STATE_PATH + '.bak'
const LEGACY_STATE_PATH = join(homedir(), '.dsh', 'mcp-console.json')
const API_PREFIX = '/mcp-switch/api'
const DISPOSE_TIMEOUT_MS = 60_000
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MODES = ['always-off', 'remember', 'auto-start']
/** 超过这个量级的 MCP，打开前要求 confirm:true，防止手滑把几十万 tokens 拉回来。 */
const HEAVY_TOKEN_THRESHOLD = 100_000

/** 已实测的上下文成本（按模型实际可见的 schema 投影计，2026-10-23 实测），用于首次提示与阈值判断。 */
const SEED_COSTS = {
  rea: { tools: 207, bytes: 792143, tokens: 220040 },
  'windows-mcp': { tools: 21, bytes: 17722, tokens: 4923 },
  'open-design': { tools: 22, bytes: 18583, tokens: 5162 },
  cad: { tools: 2, bytes: 966, tokens: 268 },
}

const HOST_DSH_NODE_MODULES = process.resourcesPath
  ? join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules')
  : join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules')

const mcpClient = await import(
  pathToFileURL(join(HOST_DSH_NODE_MODULES, '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js')).href
)

// ── 状态 ────────────────────────────────────────────────────────────────────

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** 原子写 + 保留上一版备份：写临时文件再 rename，避免中途失败留下截断的 JSON。 */
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  const text = JSON.stringify(state, null, 2)
  const tmp = STATE_PATH + '.tmp'
  writeFileSync(tmp, text)
  try {
    if (existsSync(STATE_PATH)) copyFileSync(STATE_PATH, BACKUP_PATH)
  } catch { /* 备份失败不影响主写入 */ }
  renameSync(tmp, STATE_PATH)
}

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'always-off'
}

function normalizeServer(s) {
  return {
    id: s.id || randomUUID(),
    name: s.name,
    transport: s.transport || 'stdio',
    enabled: s.enabled !== false,
    autoStart: s.autoStart === true,
    cost: s.cost && typeof s.cost === 'object' ? s.cost : (SEED_COSTS[s.name] || null),
    config: s.config || {},
  }
}

function loadState() {
  const own = readJson(STATE_PATH)
  if (own && Array.isArray(own.servers)) {
    return {
      startupMode: normalizeMode(own.startupMode),
      reclaimOnSessionEnd: own.reclaimOnSessionEnd !== false,
      groups: own.groups && typeof own.groups === 'object' ? own.groups : {},
      servers: own.servers.map(normalizeServer),
    }
  }
  const legacy = readJson(LEGACY_STATE_PATH)
  if (legacy && Array.isArray(legacy.servers) && legacy.servers.length) {
    const migrated = {
      startupMode: 'always-off',
      reclaimOnSessionEnd: true,
      groups: {},
      servers: legacy.servers.map((s) => normalizeServer({ ...s, enabled: false, autoStart: false })),
    }
    saveState(migrated)
    return migrated
  }
  return { startupMode: 'always-off', reclaimOnSessionEnd: true, groups: {}, servers: [] }
}

/** ${VAR} 模板在启动时解析为进程环境变量，token 不落盘。 */
function resolveEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = typeof v === 'string' ? v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, n) => process.env[n] ?? m) : v
  }
  return out
}

function fmtTokens(n) {
  if (!n) return '未知'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M tokens`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k tokens`
  return `${n} tokens`
}

// ── 运行时（动态加载官方 MCP 桥接）───────────────────────────────────────────

export function apply(ctx) {
  const state = loadState()
  /** id -> { fiber, status, error, errorDetail } */
  const live = new Map()
  /** id -> 打开它的会话 id（用于会话结束回收） */
  const openedBy = new Map()
  /** 同一服务器的启停串行化，避免 serverName 预约竞争 */
  const ops = new Map()

  function enqueue(id, fn) {
    const prev = ops.get(id) || Promise.resolve()
    const task = prev.then(fn).catch((e) => {
      ctx.logger?.warn?.(`[mcp-switch] op "${id}" failed: ${e?.message || e}`)
    })
    ops.set(id, task)
    return task
  }

  async function disposeFiber(fiber) {
    if (!fiber) return
    try {
      const task = fiber.dispose()
      if (!task || typeof task.then !== 'function') return
      await Promise.race([task, new Promise((r) => setTimeout(r, DISPOSE_TIMEOUT_MS))])
    } catch { /* ignore */ }
  }

  function errorChain(e) {
    const parts = []
    let cur = e
    let depth = 0
    while (cur && depth < 8) {
      const msg = cur?.message || String(cur)
      if (!parts.includes(msg)) parts.push(msg)
      cur = cur?.cause
      depth += 1
    }
    return parts.join(' <- ')
  }

  /** 统计某服务器注册的工具 schema 体积（模型实际要付的上下文成本）。 */
  function measureCost(server) {
    try {
      const prefix = `mcp__${server.name}__`
      const schemas = (ctx.tools.schemas?.() || []).filter((s) => String(s.name).startsWith(prefix))
      if (!schemas.length) return null
      const bytes = Buffer.byteLength(JSON.stringify(schemas))
      return { tools: schemas.length, bytes, tokens: Math.round(bytes / 3.6) }
    } catch {
      return null
    }
  }

  function serverConfig(server) {
    const cfg = {
      ...server.config,
      transport: server.transport,
      serverName: server.name,
      failOnStartupError: true,
    }
    cfg.env = resolveEnv(cfg.env)
    if (cfg.headers && typeof cfg.headers === 'object') cfg.headers = resolveEnv(cfg.headers)
    return cfg
  }

  function startServer(server, sessionId) {
    // 先同步占位成 connecting：API/工具读状态时不必等 enqueue 真正执行
    const prev = live.get(server.id)
    live.set(server.id, { fiber: prev?.fiber ?? null, status: 'connecting', error: '', errorDetail: '' })
    if (sessionId) openedBy.set(server.id, sessionId)
    return enqueue(server.id, async () => {
      const existing = live.get(server.id)
      if (existing?.fiber) await disposeFiber(existing.fiber)
      const entry = { fiber: null, status: 'connecting', error: '', errorDetail: '' }
      live.set(server.id, entry)
      try {
        const fiber = ctx.plugin(mcpClient, serverConfig(server))
        entry.fiber = fiber
        await fiber
        entry.status = 'connected'
        // 连接成功后量一次成本（工具可能刚注册完，给一帧再量一次）
        let cost = measureCost(server)
        if (!cost) {
          await new Promise((r) => setTimeout(r, 400))
          cost = measureCost(server)
        }
        if (cost) {
          server.cost = cost
          saveState(state)
        }
      } catch (e) {
        entry.status = 'error'
        entry.error = e?.message || String(e)
        entry.errorDetail = errorChain(e)
        ctx.logger?.warn?.(`[mcp-switch] "${server.name}" failed: ${entry.errorDetail}`)
        if (entry.fiber) {
          await disposeFiber(entry.fiber)
          entry.fiber = null
        }
      }
    })
  }

  function stopServer(id) {
    return enqueue(id, async () => {
      openedBy.delete(id)
      const entry = live.get(id)
      if (!entry) return
      live.delete(id)
      await disposeFiber(entry.fiber)
      entry.fiber = null
    })
  }

  function findServer(nameOrId) {
    return state.servers.find((s) => s.name === nameOrId) || state.servers.find((s) => s.id === nameOrId)
  }

  function publicStatus() {
    return state.servers.map((s) => {
      const l = live.get(s.id)
      return {
        id: s.id,
        name: s.name,
        transport: s.transport,
        enabled: s.enabled !== false,
        autoStart: s.autoStart === true,
        status: s.enabled === false ? 'disabled' : (l?.status || 'stopped'),
        error: l?.error || '',
        errorDetail: l?.errorDetail || '',
        cost: s.cost || null,
        openedBy: openedBy.get(s.id) || '',
      }
    })
  }

  function setEnabled(server, on, sessionId) {
    server.enabled = on
    saveState(state)
    if (on) startServer(server, sessionId)
    else stopServer(server.id)
    return { ok: true, server: publicStatus().find((s) => s.id === server.id) }
  }

  /** 重服务器保护：已知成本超过阈值且没带 confirm 时拒绝。 */
  function heavyGate(server, confirm) {
    const tokens = server.cost?.tokens || 0
    return tokens >= HEAVY_TOKEN_THRESHOLD && confirm !== true
  }

  async function waitSettled(id, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const st = publicStatus().find((s) => s.id === id)
      if (st && (st.status === 'connected' || st.status === 'error')) return st
      await new Promise((r) => setTimeout(r, 250))
    }
    return publicStatus().find((s) => s.id === id)
  }

  async function setMode(mode) {
    const next = normalizeMode(mode)
    state.startupMode = next
    saveState(state)

    if (next === 'always-off') {
      for (const s of state.servers) {
        s.enabled = false
        await stopServer(s.id)
      }
      saveState(state)
    } else if (next === 'auto-start') {
      for (const s of state.servers) {
        if (s.autoStart === true) {
          s.enabled = true
          startServer(s)
        } else if (s.enabled !== false) {
          s.enabled = false
          await stopServer(s.id)
        }
      }
      saveState(state)
    }
    return next
  }

  /** 应用一个分组预设：组内连上，组外断开。 */
  async function applyGroup(groupName, confirm, sessionId) {
    const members = state.groups[groupName]
    if (!Array.isArray(members)) return { ok: false, message: `没有名为 "${groupName}" 的分组` }

    const heavy = members
      .map((n) => findServer(n))
      .filter((s) => s && heavyGate(s, confirm))
    if (heavy.length) {
      return {
        ok: false,
        message: `分组 "${groupName}" 含重服务器：${heavy.map((s) => `${s.name}（约 ${fmtTokens(s.cost?.tokens)}）`).join('、')}。确认请再调用一次并传 confirm:true。`,
      }
    }

    const connected = []
    const disconnected = []
    for (const s of state.servers) {
      if (members.includes(s.name)) {
        if (s.enabled !== true) setEnabled(s, true, sessionId)
        connected.push(s.name)
      } else if (s.enabled !== false) {
        setEnabled(s, false)
        disconnected.push(s.name)
      }
    }
    for (const name of connected) await waitSettled(findServer(name)?.id)
    return {
      ok: true,
      message: `已应用分组 "${groupName}"：连接 ${connected.join('、') || '无'}${disconnected.length ? `；断开 ${disconnected.join('、')}` : ''}`,
    }
  }

  // 启动时按策略决定连哪些
  {
    const mode = normalizeMode(state.startupMode)
    for (const s of state.servers) {
      let shouldStart = false
      if (mode === 'remember') shouldStart = s.enabled !== false
      else if (mode === 'auto-start') shouldStart = s.autoStart === true
      s.enabled = shouldStart
      if (shouldStart) startServer(s)
    }
    saveState(state)
  }

  // ── 会话结束回收（#8）────────────────────────────────────────────────────
  // 记录是哪个会话把服务器打开的；该会话的 agent 被 dispose 时回收。
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    if (state.reclaimOnSessionEnd === false) return
    const sessionId = payload?.agent?.id
    if (!sessionId) return
    for (const [id, owner] of [...openedBy.entries()]) {
      if (owner !== sessionId) continue
      const server = state.servers.find((s) => s.id === id)
      if (!server) continue
      server.enabled = false
      stopServer(id)
      ctx.logger?.info?.(`[mcp-switch] 会话结束回收 "${server.name}"`)
    }
    saveState(state)
  })

  // ── agent 工具 ───────────────────────────────────────────────────────────

  const serversSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      transport: { type: 'string' },
      status: { type: 'string' },
      enabled: { type: 'boolean' },
      autoStart: { type: 'boolean' },
      error: { type: 'string' },
      detail: { type: 'string' },
      costText: { type: 'string' },
    },
  }

  const statusValue = () => ({
    startupMode: normalizeMode(state.startupMode),
    reclaimOnSessionEnd: state.reclaimOnSessionEnd !== false,
    groups: Object.keys(state.groups),
    servers: publicStatus().map((s) => ({
      name: s.name,
      transport: s.transport,
      status: s.status,
      enabled: s.enabled,
      autoStart: s.autoStart,
      error: s.error,
      detail: s.errorDetail && s.errorDetail !== s.error ? s.errorDetail : '',
      costText: s.cost ? `${s.cost.tools} 工具 / 约 ${fmtTokens(s.cost.tokens)}` : '未测',
    })),
  })

  const listTool = {
    name: 'mcp_switch_list',
    description:
      '列出所有 MCP 服务器、开关状态、上下文成本（工具数 / 约多少 tokens）与启动策略。' +
      'MCP 默认断开；需要某个 MCP 的工具时先 mcp_switch_on，用完 mcp_switch_off。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startupMode: { type: 'string' },
          reclaimOnSessionEnd: { type: 'boolean' },
          groups: { type: 'array', items: { type: 'string' } },
          servers: { type: 'array', items: serversSchema },
        },
      },
      render: (_args, value) => {
        const modeText = {
          'always-off': 'always-off（每次启动一律断开）',
          remember: 'remember（恢复上次状态）',
          'auto-start': 'auto-start（只连自启的）',
        }[value.startupMode] || value.startupMode
        const head = [
          `启动策略：${modeText}`,
          `会话结束回收：${value.reclaimOnSessionEnd ? '开' : '关'}`,
          value.groups.length ? `分组：${value.groups.join('、')}` : '',
        ].filter(Boolean)
        if (!value.servers.length) return [{ type: 'text', text: [...head, '还没有配置任何 MCP 服务器。'].join('\n') }]
        const lines = value.servers.map((s) => {
          const flags = [
            s.autoStart ? '自启' : '',
            s.costText,
            s.error ? `错误：${s.error}` : '',
            s.detail ? `详情：${String(s.detail).slice(0, 160)}` : '',
          ].filter(Boolean).join('；')
          return `- ${s.name} [${s.status}]  ${flags}`
        })
        const on = value.servers.filter((s) => s.status === 'connected').length
        return [{ type: 'text', text: [...head, `MCP 服务器（${on}/${value.servers.length} 已连接）`, ...lines].join('\n') }]
      },
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    execute: () => statusValue(),
  }

  const onTool = {
    name: 'mcp_switch_on',
    description:
      '打开（连接）一个 MCP 服务器，连上后它的 mcp__<名称>__* 工具立即可用。' +
      '已知成本超过 10 万 tokens 的服务器（如 rea）必须再传 confirm:true 才会打开。name 传 "all" 表示全部打开。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '服务器名称，或 "all"' },
        confirm: { type: 'boolean', description: '确认打开重服务器（>10 万 tokens）' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' }, message: { type: 'string' } },
      },
      render: (_args, value) => {
        if (value.status === 'needs-confirm') return [{ type: 'text', text: value.message || '需要确认。' }]
        if (value.status === 'error') return [{ type: 'text', text: `打开 ${value.name} 失败：${value.error || '未知错误'}` }]
        return [{ type: 'text', text: value.message || `已打开 ${value.name}（状态 ${value.status}）。` }]
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : ''
      const targets = args.name === 'all' ? state.servers : [findServer(args.name)].filter(Boolean)
      if (!targets.length) return { name: String(args.name || ''), status: 'error', error: '找不到这个 MCP 服务器' }

      const blocked = targets.filter((s) => heavyGate(s, args.confirm))
      if (blocked.length) {
        return {
          name: blocked.map((s) => s.name).join('、'),
          status: 'needs-confirm',
          message: `这些 MCP 很贵：${blocked.map((s) => `${s.name}（约 ${fmtTokens(s.cost?.tokens)}）`).join('、')}。确认请带 confirm:true 再调一次。`,
        }
      }

      const started = []
      for (const s of targets) {
        const cur = publicStatus().find((x) => x.id === s.id)
        if (cur?.status === 'connected') continue
        setEnabled(s, true, sessionId)
        started.push(s)
      }
      if (!started.length) return { name: targets.map((s) => s.name).join('、'), status: 'connected', message: '本来就都连着，没动。' }

      const results = []
      for (const s of started) {
        const st = await waitSettled(s.id)
        results.push({ name: s.name, status: st?.status || 'connecting', error: st?.error || '' })
      }
      const failed = results.filter((r) => r.status === 'error')
      if (failed.length === 1 && results.length === 1) return { name: failed[0].name, status: 'error', error: failed[0].error }
      const costSum = started.reduce((a, s) => a + (s.cost?.tokens || 0), 0)
      return {
        name: results.map((r) => `${r.name}[${r.status}]`).join('、'),
        status: failed.length ? 'partial' : 'connected',
        error: failed.map((r) => `${r.name}: ${r.error}`).join('；'),
        message: `已打开 ${results.length} 个（约 +${fmtTokens(costSum)} 上下文）${failed.length ? `，失败 ${failed.length} 个` : ''}。`,
      }
    },
  }

  const offTool = {
    name: 'mcp_switch_off',
    description: '关闭（断开）一个 MCP 服务器，卸载它的 mcp__<名称>__* 工具，释放上下文。name 传 "all" 表示全部断开。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: '服务器名称，或 "all"' } },
      required: ['name'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, status: { type: 'string' }, message: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.message || `已断开 ${value.name}（状态 ${value.status}）。` }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const targets = args.name === 'all' ? state.servers : [findServer(args.name)].filter(Boolean)
      if (!targets.length) return { name: String(args.name || ''), status: 'error', message: '找不到这个 MCP 服务器' }
      for (const s of targets) setEnabled(s, false)
      await new Promise((r) => setTimeout(r, 300))
      const names = targets.map((s) => s.name).join('、')
      return { name: names, status: 'disabled', message: `已断开 ${names}。` }
    },
  }

  const addTool = {
    name: 'mcp_switch_add',
    description:
      '新增一个 MCP 服务器（写入状态文件，可选立即连接）。stdio 传 command/args/env/cwd；' +
      'streamable-http 传 url/headers。env 与 headers 的值都支持 ${VAR} 模板，运行时从环境变量解析，token 不落盘。' +
      'autoStart=true 只在 startupMode=auto-start 时生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '服务器名称（字母/数字/下划线/连字符，≤32），决定工具前缀 mcp__<名称>__' },
        transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '默认 stdio' },
        command: { type: 'string', description: 'stdio：可执行文件，例如 uvx / node / python' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：参数' },
        env: { type: 'object', description: 'stdio：环境变量（值支持 ${VAR}）' },
        cwd: { type: 'string', description: 'stdio：工作目录，可空' },
        url: { type: 'string', description: 'streamable-http：端点 URL' },
        headers: { type: 'object', description: 'streamable-http：请求头（值支持 ${VAR}）' },
        autoStart: { type: 'boolean', description: '是否允许在 auto-start 策略下随启动自动连接，默认 false' },
        connect: { type: 'boolean', description: '添加后是否立即连接，默认 false' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, name: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? (value.message || `已添加 ${value.name}（状态 ${value.status}）。`) : `添加失败：${value.error || '未知错误'}` }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : ''
      const nm = String(args.name || '').trim()
      if (!NAME_PATTERN.test(nm)) return { ok: false, name: nm, error: '名称不合法（仅字母/数字/下划线/连字符，1-32 位）' }
      if (state.servers.some((s) => s.name === nm)) return { ok: false, name: nm, error: `服务器 "${nm}" 已存在` }

      const transport = args.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      let config
      if (transport === 'stdio') {
        if (!args.command) return { ok: false, name: nm, error: 'stdio 需要 command' }
        const cmd = String(args.command)
        if ((/^[A-Za-z]:[\\/]/.test(cmd) || cmd.startsWith('/')) && !existsSync(cmd)) {
          return { ok: false, name: nm, error: `命令不存在：${cmd}` }
        }
        config = {
          command: cmd,
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          env: args.env && typeof args.env === 'object' ? args.env : {},
          cwd: typeof args.cwd === 'string' ? args.cwd : '',
        }
      } else {
        if (!args.url) return { ok: false, name: nm, error: 'streamable-http 需要 url' }
        config = {
          url: String(args.url),
          headers: args.headers && typeof args.headers === 'object' ? args.headers : {},
        }
      }

      const server = normalizeServer({ id: randomUUID(), name: nm, transport, enabled: false, autoStart: args.autoStart === true, cost: null, config })
      state.servers.push(server)
      saveState(state)

      if (args.connect === true) {
        setEnabled(server, true, sessionId)
        const st = await waitSettled(server.id)
        return { ok: true, name: nm, status: st?.status || 'disabled', error: st?.error || '' }
      }
      return { ok: true, name: nm, status: 'disabled', message: `已添加 ${nm}（未连接）。工具前缀 mcp__${nm}__*。` }
    },
  }

  const removeTool = {
    name: 'mcp_switch_remove',
    description: '删除一个 MCP 服务器（先断开再移出状态文件）。配置错了或不再需要时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: '服务器名称' } },
      required: ['name'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, name: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `已删除 ${value.name}。` : `删除失败：${value.error || '未知错误'}` }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const server = findServer(args.name)
      if (!server) return { ok: false, name: String(args.name || ''), error: '找不到这个 MCP 服务器' }
      await stopServer(server.id)
      state.servers = state.servers.filter((s) => s.id !== server.id)
      for (const [g, list] of Object.entries(state.groups)) {
        state.groups[g] = list.filter((n) => n !== server.name)
      }
      saveState(state)
      return { ok: true, name: server.name }
    },
  }

  const policyTool = {
    name: 'mcp_switch_policy',
    description:
      '读取或设置策略。mode：always-off（每次启动一律断开，默认）/ remember（恢复上次）/ auto-start（只连自启的）。' +
      'reclaimOnSessionEnd：会话结束时是否自动断开该会话打开的 MCP（默认 true）。不传参数时只返回当前策略。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['always-off', 'remember', 'auto-start'], description: '启动策略；省略则不改' },
        reclaimOnSessionEnd: { type: 'boolean', description: '会话结束自动回收；省略则不改' },
        autoStart: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
          description: '按名称设置「自启」标记，例如 {"windows-mcp": true}；只在 startupMode=auto-start 时生效',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { startupMode: { type: 'string' }, reclaimOnSessionEnd: { type: 'boolean' } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `启动策略：${value.startupMode}；会话结束回收：${value.reclaimOnSessionEnd ? '开' : '关'}`,
      }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      if (args.mode) await setMode(args.mode)
      if (typeof args.reclaimOnSessionEnd === 'boolean') {
        state.reclaimOnSessionEnd = args.reclaimOnSessionEnd
        saveState(state)
      }
      if (args.autoStart && typeof args.autoStart === 'object') {
        const changed = []
        for (const [name, val] of Object.entries(args.autoStart)) {
          const s = findServer(name)
          if (s) {
            s.autoStart = val === true
            changed.push(`${name}=${s.autoStart ? '自启' : '不自启'}`)
          }
        }
        if (changed.length) {
          saveState(state)
          ctx.logger?.info?.(`[mcp-switch] autoStart: ${changed.join(', ')}`)
        }
      }
      return { startupMode: normalizeMode(state.startupMode), reclaimOnSessionEnd: state.reclaimOnSessionEnd !== false }
    },
  }

  const groupTool = {
    name: 'mcp_switch_group',
    description:
      '管理分组预设。action=list 列出；save 把 servers 存成名为 name 的分组（省略 servers 则用当前已连接的）；' +
      'apply 应用分组（组内连上、组外断开，含重服务器时需 confirm:true）；delete 删除分组。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'apply', 'delete'], description: '默认 list' },
        name: { type: 'string', description: '分组名' },
        servers: { type: 'array', items: { type: 'string' }, description: 'save 时的成员；省略则取当前已连接的' },
        confirm: { type: 'boolean', description: 'apply 含重服务器时确认' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string' }, servers: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.groups) {
          if (!value.groups.length) return [{ type: 'text', text: '还没有分组。用 action=save 建一个。' }]
          return [{ type: 'text', text: '分组：\n' + value.groups.map((g) => `- ${g.name}: ${g.servers.join('、') || '（空）'}`).join('\n') }]
        }
        return [{ type: 'text', text: value.message || (value.ok ? '完成。' : '失败。') }]
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : ''
      const action = args.action || 'list'

      if (action === 'list') {
        return { ok: true, groups: Object.entries(state.groups).map(([name, servers]) => ({ name, servers: [...servers] })) }
      }
      if (action === 'save') {
        if (!args.name) return { ok: false, message: 'save 需要 name' }
        const members = Array.isArray(args.servers) && args.servers.length
          ? args.servers.map(String)
          : publicStatus().filter((s) => s.status === 'connected').map((s) => s.name)
        const unknown = members.filter((n) => !findServer(n))
        if (unknown.length) return { ok: false, message: `这些服务器不存在：${unknown.join('、')}` }
        state.groups[args.name] = members
        saveState(state)
        return { ok: true, message: `已保存分组 "${args.name}"：${members.join('、') || '（空）'}` }
      }
      if (action === 'delete') {
        if (!args.name || !state.groups[args.name]) return { ok: false, message: `没有名为 "${args.name}" 的分组` }
        delete state.groups[args.name]
        saveState(state)
        return { ok: true, message: `已删除分组 "${args.name}"` }
      }
      // apply
      if (!args.name) return { ok: false, message: 'apply 需要 name' }
      return applyGroup(args.name, args.confirm, sessionId)
    },
  }

  ctx.tools.register(listTool)
  ctx.tools.register(onTool)
  ctx.tools.register(offTool)
  ctx.tools.register(addTool)
  ctx.tools.register(removeTool)
  ctx.tools.register(policyTool)
  ctx.tools.register(groupTool)

  // ── 设置页用的小 REST API ────────────────────────────────────────────────
  // 这条 prefix 路由挂在宿主 webServer 上但不受宿主鉴权保护，所以自己做
  // 同源 + sec-fetch-site + 回环 + Host 校验（防跨站开关 MCP、防 DNS rebinding）。

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 65536) { // 本地小 API，拒绝异常大的请求体（不 destroy，以便回 400）
          reject(new Error('request body too large'))
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  const webFiber = ctx.inject(['webServer'], (webCtx) => {
    return webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const origin = req.headers.origin
        const site = req.headers['sec-fetch-site']
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin))) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        }
        if (site && site !== 'same-origin' && site !== 'none') {
          return sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
        }
        const remote = String(req.socket?.remoteAddress || '')
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          return sendJson(res, 403, { ok: false, error: 'loopback only' })
        }
        const host = String(req.headers.host || '')
        if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
          return sendJson(res, 403, { ok: false, error: 'unexpected host' })
        }

        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const p = url.pathname
          const m = req.method

          if (m === 'GET' && p === `${API_PREFIX}/state`) {
            return sendJson(res, 200, {
              ok: true,
              startupMode: normalizeMode(state.startupMode),
              reclaimOnSessionEnd: state.reclaimOnSessionEnd !== false,
              groups: Object.entries(state.groups).map(([name, servers]) => ({ name, servers: [...servers] })),
              servers: publicStatus(),
            })
          }
          if (m === 'GET' && p === `${API_PREFIX}/servers`) {
            return sendJson(res, 200, { ok: true, servers: publicStatus() })
          }
          if (m === 'POST' && p === `${API_PREFIX}/policy`) {
            const body = JSON.parse((await readBody(req)) || '{}')
            if (body.mode && !MODES.includes(body.mode)) return sendJson(res, 400, { ok: false, error: '未知策略' })
            if (body.mode) await setMode(body.mode)
            if (typeof body.reclaimOnSessionEnd === 'boolean') {
              state.reclaimOnSessionEnd = body.reclaimOnSessionEnd
              saveState(state)
            }
            return sendJson(res, 200, { ok: true, startupMode: normalizeMode(state.startupMode), reclaimOnSessionEnd: state.reclaimOnSessionEnd !== false })
          }
          const g = p.match(new RegExp(`^${API_PREFIX}/groups/([^/]+)/apply$`))
          if (m === 'POST' && g) {
            const body = JSON.parse((await readBody(req)) || '{}')
            const r = await applyGroup(decodeURIComponent(g[1]), body.confirm === true, '')
            return sendJson(res, r.ok ? 200 : 400, r)
          }
          const am = p.match(new RegExp(`^${API_PREFIX}/servers/([^/]+)/autostart$`))
          if (m === 'POST' && am) {
            const server = findServer(am[1])
            if (!server) return sendJson(res, 404, { ok: false, error: '服务器不存在' })
            const body = JSON.parse((await readBody(req)) || '{}')
            server.autoStart = body.autoStart === true
            saveState(state)
            return sendJson(res, 200, { ok: true, server: publicStatus().find((s) => s.id === server.id) })
          }
          const mm = p.match(new RegExp(`^${API_PREFIX}/servers/([^/]+)/(connect|disconnect)$`))
          if (m === 'POST' && mm) {
            const server = findServer(mm[1])
            if (!server) return sendJson(res, 404, { ok: false, error: '服务器不存在' })
            if (mm[2] === 'connect' && heavyGate(server, false)) {
              return sendJson(res, 409, {
                ok: false,
                needsConfirm: true,
                error: `${server.name} 约 ${fmtTokens(server.cost?.tokens)}，请在面板确认或改用 agent 工具带 confirm:true`,
              })
            }
            return sendJson(res, 200, setEnabled(server, mm[2] === 'connect', ''))
          }
          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e?.message || String(e) })
        }
      },
    }), 'dsh-plugin-mcp-switch: api routes')
  })

  return async () => {
    try { offDisposed() } catch { /* ignore */ }
    await Promise.all([...live.keys()].map((id) => stopServer(id)))
    try { webFiber.dispose() } catch { /* ignore */ }
  }
}
