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
 * app.asar 里，profile 安装的插件用裸包名 import 在开机加载时会失败，所以必须按
 * 绝对路径动态导入（Electron 认 asar）。
 *
 * 2026-10-30 加固：不再把「安装路径 + lib/index.js」写死，改由 ./host-bridge.mjs
 * 逐候选真 import 解析（裸说明符 → DSH_APP_MODULES → 各候选根目录 × 各候选入口，
 * 入口按包自己的 exports/main 决定），并做形状校验；全部失败时**不抛异常**，
 * 插件照常加载，只在连 MCP 时明确报「MCP 桥不可用」+ 尝试清单。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { resolveHostMcpClient } from './host-bridge.mjs'
import {
  addOwner,
  removeOwner,
  isVisibleTo as isServerVisibleTo,
  dropSessionOwners,
  ownersToObject,
  objectToOwners,
  visibleToText,
} from './lib/session-owners.mjs'
import { ToolNameCache, buildMaskPlan, DirtyScheduler } from './lib/mask-planner.mjs'

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

/**
 * 宿主 MCP 桥的解析结果（见 host-bridge.mjs）。
 * `bridge.ok === false` 时插件仍会加载，只是连 MCP 会给出明确错误而不是整插件崩掉。
 */
const bridge = await resolveHostMcpClient()
const mcpClient = bridge.module
/** 供 /state 与日志复用的解析摘要。 */
const bridgeInfo = () => ({
  ok: bridge.ok,
  source: bridge.source,
  attempts: bridge.tried.length,
  error: bridge.ok ? undefined : bridge.error,
})

// ── 状态 ────────────────────────────────────────────────────────────────────

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** 原子写 + 保留上一版备份：写临时文件再 rename，避免中途失败留下截断的 JSON。 */
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  // Map 不能直接 JSON 化：落盘时把归属转成普通对象
  const serializable = { ...state, owners: ownersToObject(state.owners) }
  const text = JSON.stringify(serializable, null, 2)
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
      // 会话归属落盘：重启后只能认当前活着的会话，stale id 在 apply() 里清理
      owners: objectToOwners(own.owners),
    }
  }
  const legacy = readJson(LEGACY_STATE_PATH)
  if (legacy && Array.isArray(legacy.servers) && legacy.servers.length) {
    const migrated = {
      startupMode: 'always-off',
      reclaimOnSessionEnd: true,
      groups: {},
      servers: legacy.servers.map((s) => normalizeServer({ ...s, enabled: false, autoStart: false })),
      owners: new Map(),
    }
    saveState(migrated)
    return migrated
  }
  return { startupMode: 'always-off', reclaimOnSessionEnd: true, groups: {}, servers: [], owners: new Map() }
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
  /**
   * id -> Set<会话 id>：哪些会话「拥有」这个连接。
   * 空集 = 匿名打开（设置页 / REST API / 启动策略），对所有会话可见；
   * 非空 = 只有这些会话及其子智能体看得见（见下面的会话级可见性）。
   * 指向 state.owners，随 saveState 一起落盘；启动时清掉已不存在的 stale 会话 id。
   */
  const openedBy = state.owners instanceof Map ? state.owners : (state.owners = new Map())
  ;{
    // 重启后旧 session id 都失效了：只保留当前活着的会话，否则会误挡新会话或留归属给幽灵。
    // fail-safe：拿不到 agents 服务时**保留**归属（宁可让连接暂时只对旧 id 可见，
    // 也不要误清成匿名、把昂贵工具放开给所有会话）。
    let alive = null
    try {
      const svc = ctx.get('agents')
      if (svc && typeof svc.list === 'function') {
        alive = new Set((svc.list() || []).map((a) => String(a?.id || a)))
      }
    } catch { alive = null }
    if (alive) {
      let pruned = false
      for (const [sid, set] of [...openedBy]) {
        for (const owner of [...set]) {
          if (!alive.has(owner)) { set.delete(owner); pruned = true }
        }
        if (!set.size) openedBy.delete(sid)
      }
      if (pruned) saveState(state)
    }
  }
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
    if (sessionId && addOwner(openedBy, server.id, sessionId)) saveState(state)
    return enqueue(server.id, async () => {
      const existing = live.get(server.id)
      if (existing?.fiber) await disposeFiber(existing.fiber)
      const entry = { fiber: null, status: 'connecting', error: '', errorDetail: '' }
      live.set(server.id, entry)
      try {
        if (!mcpClient) {
          // 宿主桥没解析到：明确报出来，不要让 ctx.plugin(undefined) 抛一个看不懂的错
          entry.status = 'error'
          entry.error = 'MCP 桥不可用：未解析到宿主的 @deepseek-ai/dsh-mcp-client'
          entry.errorDetail = bridge.error || ''
          ctx.logger?.warn?.(`[mcp-switch] ${entry.error}\n${entry.errorDetail}`)
          return
        }
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
        // MCP 工具是握手之后才异步注册的：先等工具名出现，再给「不拥有它的会话」套遮挡。
        // 拿空清单去挡等于什么都没挡（2026-11-04 实测踩到）。
        for (let i = 0; i < 20 && !serverToolNames(server).length; i += 1) {
          await new Promise((r) => setTimeout(r, 150))
        }
        syncAllAgents()
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
      cache.delete(id)
      dropMasksForServer(id)
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

  // ── 会话级可见性（2026-11-03）────────────────────────────────────────────
  // MCP 客户端挂在宿主全局 ctx 上，工具注册进全局表，进程里每个会话都看得见。
  // 这里给「不拥有该连接的会话」加一层 tools.restrict({ deny: [mcp__<name>__*] })：
  // 从该会话的可见集合里摘掉，模型看不到 = 不付 token，误调也会判 UNKNOWN_TOOL。
  //
  // 拿「该会话作用域下的 tools 服务」按优先级尝试，任一步失败就退回全局（不隔离）
  // 并把原因记在状态里，绝不冒险把遮挡打到全局层。

  /** agentId -> { tools, agent }：该会话作用域下的 tools 服务 */
  const scopedTools = new Map()
  /** agentId -> Map(serverId -> restrict 的 disposer) */
  const masks = new Map()
  /** serverId -> 工具名快照：集合不变就不重打遮挡 */
  const cache = new ToolNameCache()
  /** 'ok' | 'unsupported' | 'unknown' */
  let scopingState = 'unknown'
  let scopingReason = ''
  const warnedOnce = new Set()

  function warnOnce(key, message) {
    if (warnedOnce.has(key)) return
    warnedOnce.add(key)
    ctx.logger?.warn?.(`[mcp-switch] ${message}`)
  }

  function scopedToolsFor(agent) {
    const id = String(agent?.id || '')
    if (!id) return null
    const cached = scopedTools.get(id)
    if (cached) return cached
    let tools = null
    // Agent 的 ctx 就是它自己的作用域上下文（agent-loop 里 this.ctx = createScope(loopCtx, agent).ctx），
    // 用它调 tools.restrict 只会影响这一个会话；调用方若是全局 ctx，宿主会直接抛错而不是误伤所有人。
    try { tools = agent?.ctx?.tools || null } catch { tools = null }
    if (!tools?.restrict) {
      try { tools = ctx.get('agentPresets')?.serviceFor?.(agent, 'tools') || null } catch { tools = null }
    }
    if (!tools?.restrict) {
      if (scopingState !== 'ok') {
        scopingState = 'unsupported'
        scopingReason = '拿不到该会话作用域下的 tools 服务'
      }
      return null
    }
    const rec = { tools, agent }
    scopedTools.set(id, rec)
    return rec
  }

  /** 该服务器当前注册的工具名（全局视角）。结果进 ToolNameCache，集合不变就不重打 restrict。 */
  function serverToolNames(server) {
    const prefix = `mcp__${server.name}__`
    let names = []
    try {
      names = (ctx.tools.schemas?.() || []).map((s) => String(s.name)).filter((n) => n.startsWith(prefix))
    } catch { /* 工具表暂时不可用，交给缓存的上一版 */ }
    return cache.update(server.id, names).names
  }

  /** 这个会话能不能看见该连接：拥有者本人、或拥有者的子智能体；匿名打开则人人可见。 */
  function ownsServer(serverId, agent) {
    const agents = ctx.get('agents')
    const isOwnedBy = (child, owner) => {
      const ownerAgent = agents?.get?.(owner)
      return ownerAgent ? !!agents?.isOwnedBy?.(child, ownerAgent) : false
    }
    return isServerVisibleTo(openedBy, serverId, agent?.id, isOwnedBy)
  }

  /** 让一个会话的可见性对齐该服务器的当前归属。返回是否处于「被遮挡」状态。 */
  function syncMask(agent, server) {
    const id = String(agent?.id || '')
    if (!id) return false
    const connected = live.get(server.id)?.status === 'connected'
    const names = connected ? serverToolNames(server) : []
    const shouldMask = connected && names.length > 0 && !ownsServer(server.id, agent)

    let per = masks.get(id)
    const existing = per?.get(server.id)
    if (!shouldMask) {
      if (existing) {
        try { existing.dispose() } catch { /* ignore */ }
        per.delete(server.id)
        if (!per.size) masks.delete(id)
      }
      return false
    }
    // MCP 工具是异步注册的，清单会变长：名字集合变了就得重打一次遮挡。
    // 用规范化 key（排序+去重），集合没变就不重打，避免 restrict 抖动。
    const key = ToolNameCache.keyOf(names)
    if (existing && existing.key === key) return true
    if (existing) {
      try { existing.dispose() } catch { /* ignore */ }
      per.delete(server.id)
    }

    const rec = scopedToolsFor(agent)
    if (!rec) return false
    try {
      const dispose = rec.tools.restrict({ deny: names })
      if (!per) { per = new Map(); masks.set(id, per) }
      per.set(server.id, { dispose, key })
      // 自检：该会话看不见了、全局还看得见，才算遮挡成功
      const agentView = new Set((ctx.tools.schemas?.(agent) || []).map((s) => String(s.name)))
      const globalView = new Set((ctx.tools.schemas?.() || []).map((s) => String(s.name)))
      const leaked = names.filter((n) => agentView.has(n))
      const overreach = names.filter((n) => !globalView.has(n))
      if (leaked.length || overreach.length) {
        try { dispose() } catch { /* ignore */ }
        per.delete(server.id)
        if (!per.size) masks.delete(id)
        scopingState = 'unsupported'
        scopingReason = leaked.length ? 'restrict 没作用到该会话作用域' : 'restrict 影响到了全局'
        warnOnce('restrict-mismatch', `会话隔离不可用（${scopingReason}），已退回全局可见`)
        return false
      }
      scopingState = 'ok'
      scopingReason = ''
      return true
    } catch (e) {
      warnOnce('restrict-failed', `会话隔离失败：${e?.message || e}`)
      return false
    }
  }

  /** 把所有活着的会话对齐一遍（连上/断开/新会话/工具表变化时调用）。 */
  function syncAllAgents() {
    const agents = ctx.get('agents')
    let list = []
    try { list = agents?.list?.() || [] } catch { list = [] }
    for (const agent of list) {
      for (const server of state.servers) {
        try { syncMask(agent, server) } catch (e) {
          warnOnce('sync-failed', `对齐会话可见性失败：${e?.message || e}`)
        }
      }
    }
  }

  /**
   * 脏标记调度：syncing 期间再来的 tools/change 不再被吞掉，而是标记脏并重跑，
   * 直到一轮没有新变更（或到 maxRounds 上限，防 restrict 自激循环）。
   */
  const syncScheduler = new DirtyScheduler(() => syncAllAgents())

  /** 工具表一变（MCP 刚注册完工具、或我们自己刚加了遮挡）就重算一次，防抖后进脏标记循环。 */
  let syncTimer = null
  function scheduleSync() {
    if (syncTimer) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      const wasTruncated = syncScheduler.truncated
      syncScheduler.request()
      if (syncScheduler.truncated && !wasTruncated) {
        warnOnce('sync-loop', '会话可见性对齐连续触发，已在本轮截断（restrict 可能自激 tools/change）')
      }
    }, 80)
  }

  function dropMasksForServer(serverId) {
    for (const [id, per] of [...masks.entries()]) {
      const entry = per.get(serverId)
      if (!entry) continue
      try { entry.dispose() } catch { /* ignore */ }
      per.delete(serverId)
      if (!per.size) masks.delete(id)
    }
  }

  function dropMasksForAgent(agentId) {
    const id = String(agentId || '')
    const per = masks.get(id)
    if (per) {
      for (const entry of per.values()) { try { entry.dispose() } catch { /* ignore */ } }
      masks.delete(id)
    }
    scopedTools.delete(id)
  }

  /** 会话 id 缩成 8 位（去掉 session- 前缀），够分辨又不刷屏。 */
  function shortSession(id) {
    const s = String(id || '').replace(/^session[-_]/i, '')
    return s.length > 8 ? s.slice(0, 8) : s
  }

  function publicStatus() {
    return state.servers.map((s) => {
      const l = live.get(s.id)
      const owners = openedBy.get(s.id) || new Set()
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
        openedBy: [...owners].join(','),
        /** 人看的归属：空集 = 全局；否则列出拥有者会话 */
        visibleTo: visibleToText(openedBy, s.id, shortSession),
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
    const hidden = []
    for (const s of state.servers) {
      if (members.includes(s.name)) {
        if (s.enabled !== true) setEnabled(s, true, sessionId)
        else if (sessionId && addOwner(openedBy, s.id, sessionId)) saveState(state)
        connected.push(s.name)
      } else if (s.enabled !== false) {
        // 组外：对称处理——只摘当前会话归属，别人还在用就保留连接
        const r = removeOwner(openedBy, s.id, sessionId)
        if (r.anonymous || r.empty) {
          setEnabled(s, false)
          disconnected.push(s.name)
        } else if (r.removed) {
          hidden.push(s.name)
        }
      }
    }
    for (const name of connected) await waitSettled(findServer(name)?.id)
    if (hidden.length) syncAllAgents()
    return {
      ok: true,
      message: `已应用分组 "${groupName}"：连接 ${connected.join('、') || '无'}` +
        `${disconnected.length ? `；断开 ${disconnected.join('、')}` : ''}` +
        `${hidden.length ? `；对你关闭 ${hidden.join('、')}（其他会话仍在用）` : ''}`,
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

  // ── 会话结束回收（#8）与可见性收尾 ───────────────────────────────────────
  // 记录是哪些会话把服务器打开的；拥有者全部走了才回收。
  const offDisposed = ctx.on('agent/disposed', (payload) => {
    const sessionId = payload?.agent?.id ? String(payload.agent.id) : ''
    if (!sessionId) return
    dropMasksForAgent(sessionId)
    const { changed, emptied } = dropSessionOwners(openedBy, sessionId, state.reclaimOnSessionEnd !== false)
    for (const id of emptied) {
      const server = state.servers.find((s) => s.id === id)
      if (!server) continue
      server.enabled = false
      stopServer(id)
      ctx.logger?.info?.(`[mcp-switch] 会话结束回收 "${server.name}"`)
    }
    if (changed) {
      saveState(state)
      syncAllAgents() // 归属变了：其他人的遮挡要跟着重算
    }
  })

  // 新会话进来：立刻对齐到当前归属（不拥有某个连接就给它套上遮挡）
  const offCreated = ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    for (const server of state.servers) {
      try { syncMask(agent, server) } catch { /* 单个会话失败不影响别的 */ }
    }
  })

  // 工具表变化（MCP 陆续注册完工具、或我们刚加了遮挡）→ 脏标记循环里重算
  const offToolsChange = ctx.on('tools/change', () => {
    scheduleSync()
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
      visibleTo: { type: 'string' },
    },
  }

  const statusValue = () => ({
    startupMode: normalizeMode(state.startupMode),
    reclaimOnSessionEnd: state.reclaimOnSessionEnd !== false,
    scoping: { state: scopingState, reason: scopingReason, masked: [...masks.keys()].map(shortSession) },
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
      visibleTo: s.visibleTo,
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
          scoping: {
            type: 'object',
            additionalProperties: false,
            properties: {
              state: { type: 'string' },
              reason: { type: 'string' },
              masked: { type: 'array', items: { type: 'string' } },
            },
          },
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
          value.scoping?.state === 'ok'
            ? `会话隔离：开（只有打开的会话看得见${value.scoping.masked?.length ? `；已遮挡 ${value.scoping.masked.join('、')}` : '；当前没有别的会话'}）`
            : value.scoping?.state === 'unsupported' ? `会话隔离：不可用（${value.scoping.reason || '未知原因'}）`
              : '会话隔离：未验证',
          value.groups.length ? `分组：${value.groups.join('、')}` : '',
        ].filter(Boolean)
        if (!value.servers.length) return [{ type: 'text', text: [...head, '还没有配置任何 MCP 服务器。'].join('\n') }]
        const lines = value.servers.map((s) => {
          const flags = [
            s.autoStart ? '自启' : '',
            s.costText,
            s.status === 'connected' ? `可见：${s.visibleTo || '全部会话'}` : '',
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
      const already = []
      for (const s of targets) {
        const cur = publicStatus().find((x) => x.id === s.id)
        if (cur?.status === 'connected') {
          // 已经连着也要登记归属：别的会话已经打开了，这个会话申请就也该看得见
          if (sessionId && addOwner(openedBy, s.id, sessionId)) {
            saveState(state)
            already.push(s)
          }
          continue
        }
        setEnabled(s, true, sessionId)
        started.push(s)
      }
      if (already.length) syncAllAgents()
      if (!started.length) {
        return {
          name: targets.map((s) => s.name).join('、'),
          status: 'connected',
          message: already.length
            ? `本来就连着，已把这个会话加进可见范围（${already.map((s) => s.name).join('、')}）。`
            : '本来就都连着，没动。',
        }
      }

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
    description:
      '关闭一个 MCP。AI 在对话里调用时只对自己关闭（摘除本会话归属），别的进行中的对话不受影响；' +
      '只有最后一个拥有者关闭时才真正断开、释放上下文。面板/自启打开的匿名连接会全局断开。name 传 "all" 表示全部。',
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
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : ''
      const targets = args.name === 'all' ? state.servers : [findServer(args.name)].filter(Boolean)
      if (!targets.length) return { name: String(args.name || ''), status: 'error', message: '找不到这个 MCP 服务器' }
      const fullyClosed = []
      const leftOpen = []
      for (const s of targets) {
        // 有归属会话：只摘当前会话，其他拥有者继续用；最后一个走了才真断。
        // 匿名连接（面板/REST/自启打开）没有 owner，谁 off 都是全局断开。
        const r = removeOwner(openedBy, s.id, sessionId)
        if (r.anonymous || r.empty) {
          stopServer(s.id)
          s.enabled = false
          fullyClosed.push(s.name)
        } else if (r.removed) {
          leftOpen.push(s.name)
        } else {
          // 当前会话本来就不是 owner：不动别人的连接，只摘掉可能给这个会话的遮挡
          dropMasksForAgent(sessionId)
        }
      }
      saveState(state)
      syncAllAgents()
      await new Promise((r) => setTimeout(r, 300))
      const names = targets.map((s) => s.name).join('、')
      const bits = []
      if (fullyClosed.length) bits.push(`已断开 ${fullyClosed.join('、')}`)
      if (leftOpen.length) bits.push(`${leftOpen.join('、')} 已对你关闭（其他会话仍在用）`)
      return {
        name: names,
        status: fullyClosed.length ? 'disabled' : 'hidden',
        message: bits.join('；') || `已对当前会话隐藏 ${names}。`,
      }
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
              scoping: { state: scopingState, reason: scopingReason, masked: [...masks.keys()].map(shortSession) },
              bridge: bridgeInfo(),
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
            const body = JSON.parse((await readBody(req)) || '{}')
            if (mm[2] === 'connect' && heavyGate(server, body.confirm === true)) {
              return sendJson(res, 409, {
                ok: false,
                needsConfirm: true,
                error: `${server.name} 约 ${fmtTokens(server.cost?.tokens)}，再点一次「确认连接」以打开`,
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
    try { offCreated() } catch { /* ignore */ }
    try { offToolsChange() } catch { /* ignore */ }
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
    for (const id of [...masks.keys()]) dropMasksForAgent(id)
    await Promise.all([...live.keys()].map((id) => stopServer(id)))
    try { webFiber.dispose() } catch { /* ignore */ }
  }
}
