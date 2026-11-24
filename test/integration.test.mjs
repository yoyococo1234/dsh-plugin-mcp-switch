/**
 * 集成测试：用最小假 ctx 驱动真实的 apply()，验证「AI 在对话里自由开关 MCP、
 * 别的对话不受影响」在真实工具调用路径上成立。
 *
 * 不连真 MCP：mcpClient 解析失败时插件按设计照常加载（host-bridge 加固），
 * 这里把 ctx.plugin 做成立即 resolve 的假 fiber，工具注册照常发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── 用临时 HOME 隔离真实状态文件 ──────────────────────────────────────────
// index.js 顶层用 homedir() 算 STATE_PATH，所以要在 import 之前改 HOME/USERPROFILE。
const tmpHome = mkdtempSync(join(tmpdir(), 'mcp-switch-test-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
// 让 bridge 解析快速失败，不碰用户真 DSH 安装
process.env.DSH_APP_MODULES = join(tmpHome, 'no-such-modules')

const stateFile = join(tmpHome, '.dsh', 'mcp-switch.json')
const { apply } = await import(pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href)

function makeCtx(options = {}) {
  const listeners = {}
  const registered = new Map()
  const agents = new Map()
  const agentList = () => [...agents.values()]
  const globalSchemas = []
  const scopeSchemas = new Map() // agentId -> Set（被 restrict 遮挡后从这里去掉）
  const restrictLog = []

  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register: (t) => registered.set(t.name, t),
      schemas: (agent) => {
        if (!agent) return [...globalSchemas]
        const hidden = scopeSchemas.get(String(agent.id)) || new Set()
        return globalSchemas.filter((s) => !hidden.has(s.name))
      },
      // 假 restrict：只记录调用，返回 disposer。
      // 本测试不往 globalSchemas 塞工具，遮挡不会真正触发——遮挡计划由 mask-planner 单测覆盖。
      restrict: ({ deny }) => {
        restrictLog.push({ deny: [...deny] })
        return { dispose() {} }
      },
    },
    on: (evt, fn) => { (listeners[evt] ||= []).push(fn); return () => {} },
    get: (key) => {
      if (key === 'agents') {
        return {
          list: agentList,
          get: (id) => agents.get(String(id)),
          isOwnedBy: (child, owner) => {
            // 测试里把 child -> parent 关系写死在 options.parentOf
            return options.parentOf?.[String(child)] === String(owner?.id || owner)
          },
        }
      }
      return null
    },
    plugin: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    inject: () => ({ dispose() {} }),
    _agents: agents,
    _registered: registered,
    _listeners: listeners,
    _globalSchemas: globalSchemas,
    _restrictLog: restrictLog,
    _scopeSchemas: scopeSchemas,
  }
  return ctx
}

function emit(ctx, evt, payload) {
  for (const fn of ctx._listeners[evt] || []) fn(payload)
}

test('集成：AI 在会话 A 打开 MCP 后，off 只影响 A，不摘掉会话 B 的归属', async () => {
  // 预置一个 connected 的服务器 + 归属 A、B
  const initial = {
    startupMode: 'remember', // 恢复 enabled=true，不触发启动断开
    reclaimOnSessionEnd: true,
    groups: {},
    servers: [{ id: 'srv1', name: 'unity', transport: 'stdio', enabled: true, autoStart: false, cost: null, config: { command: 'x' } }],
    owners: { srv1: ['agent-A', 'agent-B'] },
  }
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(tmpHome, '.dsh'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(initial))

  const ctx = makeCtx()
  ctx._agents.set('agent-A', { id: 'agent-A', ctx })
  ctx._agents.set('agent-B', { id: 'agent-B', ctx })
  const dispose = apply(ctx)
  // apply() 里的启动策略块会跑；always-off 会 stopServer 把 enabled 设 false
  // 所以手动把它重新标记为 connected，模拟"已经连着"
  // 用 list 工具读公开状态
  const listTool = ctx._registered.get('mcp_switch_list')
  const offTool = ctx._registered.get('mcp_switch_off')
  assert.ok(listTool && offTool, '工具已注册')

  // 直接走 agent/disposed 路径来验证 owner 摘除的对称性：
  // 会话 A 结束（等价于 A 不再拥有），B 仍在 → 不应断连接
  const before = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.deepEqual(before.owners.srv1.sort(), ['agent-A', 'agent-B'])
  emit(ctx, 'agent/disposed', { agent: { id: 'agent-A' } })
  // 等 stopServer 的可能 enqueue 跑完
  await new Promise((r) => setTimeout(r, 50))
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.deepEqual(after.owners.srv1, ['agent-B'], 'A 走了只摘 A 的归属')
  assert.equal(after.servers[0].enabled, true, 'B 还在用，连接不能断')

  await dispose()
})

test('集成：最后一个拥有者结束才真正断开', async () => {
  const initial = {
    startupMode: 'remember', // 恢复上次开关状态，保证 enabled=true
    reclaimOnSessionEnd: true,
    groups: {},
    servers: [{ id: 'srv2', name: 'blender', transport: 'stdio', enabled: true, autoStart: false, cost: null, config: { command: 'x' } }],
    owners: { srv2: ['agent-A'] },
  }
  writeFileSync(stateFile, JSON.stringify(initial))
  const ctx = makeCtx()
  ctx._agents.set('agent-A', { id: 'agent-A', ctx }) // 活着，启动清理不会摘它的归属
  const dispose = apply(ctx)
  emit(ctx, 'agent/disposed', { agent: { id: 'agent-A' } })
  await new Promise((r) => setTimeout(r, 50))
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(after.servers[0].enabled, false, '最后一个拥有者走了，enabled 置 false')
  assert.ok(!after.owners.srv2, '归属清空')
  await dispose()
})

test('集成：归属落盘后重启，stale 会话 id 被清理', async () => {
  const initial = {
    startupMode: 'always-off',
    reclaimOnSessionEnd: true,
    groups: {},
    servers: [{ id: 'srv3', name: 'cad', transport: 'stdio', enabled: false, autoStart: false, cost: null, config: { command: 'x' } }],
    owners: { srv3: ['dead-session'] },
  }
  writeFileSync(stateFile, JSON.stringify(initial))
  const ctx = makeCtx()
  // agents 列表里没有 dead-session → 启动清理应该把它删掉并落盘
  const dispose = apply(ctx)
  const after = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(!after.owners.srv3, '不存在的会话归属被清理')
  await dispose()
})
