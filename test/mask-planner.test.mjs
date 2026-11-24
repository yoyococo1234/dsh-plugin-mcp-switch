import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ToolNameCache,
  buildMaskPlan,
  DirtyScheduler,
} from '../lib/mask-planner.mjs'

const servers = [
  { id: 's1' },
  { id: 's2' },
]
const agents = [{ id: 'A' }, { id: 'B' }]

test('ToolNameCache：同集合不同顺序/重复项不算变化', () => {
  const c = new ToolNameCache()
  const first = c.update('s1', ['b', 'a'])
  assert.equal(first.changed, true)
  assert.deepEqual(first.names, ['b', 'a'])
  const second = c.update('s1', ['a', 'b', 'a'])
  assert.equal(second.changed, false, '排序+去重后相同，不重打 restrict')
  assert.equal(second.key, 'a|b')
  const third = c.update('s1', ['a', 'b', 'c'])
  assert.equal(third.changed, true)
  assert.deepEqual(third.names, ['a', 'b', 'c'])
})

test('ToolNameCache：delete/clear', () => {
  const c = new ToolNameCache()
  c.update('s1', ['a'])
  c.update('s2', ['b'])
  c.delete('s1')
  assert.deepEqual(c.get('s1'), [])
  assert.equal(c.update('s1', ['a']).changed, true)
  c.clear()
  assert.deepEqual(c.get('s2'), [])
})

test('buildMaskPlan：只给「连着 + 看不见 + 有工具」的会话出计划', () => {
  const cache = new ToolNameCache()
  const plan = buildMaskPlan({
    agents,
    servers,
    isConnected: (id) => id === 's1',
    toolNames: () => ['mcp__s1__x'],
    isVisibleTo: (sid, aid) => aid === 'A', // A 拥有 s1，B 没有
    cache,
  })
  assert.equal(plan.length, 1)
  assert.deepEqual(plan[0], {
    agentId: 'B',
    serverId: 's1',
    names: ['mcp__s1__x'],
    key: 'mcp__s1__x',
  })
})

test('buildMaskPlan：工具没注册完（空清单）不挡', () => {
  const plan = buildMaskPlan({
    agents,
    servers,
    isConnected: () => true,
    toolNames: () => [],
    isVisibleTo: () => false,
    cache: new ToolNameCache(),
  })
  assert.equal(plan.length, 0, '拿空清单去挡等于没挡（11-04 踩过的坑）')
})

test('buildMaskPlan：所有会话都可见时无遮挡', () => {
  const plan = buildMaskPlan({
    agents,
    servers,
    isConnected: () => true,
    toolNames: () => ['mcp__s1__x'],
    isVisibleTo: () => true,
    cache: new ToolNameCache(),
  })
  assert.equal(plan.length, 0)
})

test('buildMaskPlan：工具名集合变化时 key 变化，触发重打', () => {
  const cache = new ToolNameCache()
  const base = {
    agents,
    servers,
    isConnected: () => true,
    isVisibleTo: () => false,
    cache,
  }
  const p1 = buildMaskPlan({ ...base, toolNames: () => ['mcp__s1__a'] })
  const p2 = buildMaskPlan({ ...base, toolNames: () => ['mcp__s1__b'] })
  const a1 = p1.find((x) => x.agentId === 'A' && x.serverId === 's1')
  const a2 = p2.find((x) => x.agentId === 'A' && x.serverId === 's1')
  assert.notEqual(a1.key, a2.key)
})

test('DirtyScheduler：run 中再次 request 会再跑一轮（不吞事件）', () => {
  let runs = 0
  const sched = new DirtyScheduler(() => {
    runs += 1
    if (runs === 1) sched.request() // render 期间来了一个新变更
  })
  sched.request()
  assert.equal(runs, 2, '重入请求在循环里被处理，而不是被 syncing 标志丢掉')
})

test('DirtyScheduler：防抖内连续 request 只触发一轮（index.js 里 80ms timer 的实际用法）', async () => {
  let runs = 0
  const sched = new DirtyScheduler(() => { runs += 1 })
  // 模拟 index.js：scheduleSync 用 timer 把多次 tools/change 合成一次 request
  let timer = null
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => { timer = null; sched.request() }, 20)
  }
  schedule(); schedule(); schedule()
  assert.equal(runs, 0, '防抖窗口内还没执行')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(runs, 1, '三次 request 合成一轮')
})

test('DirtyScheduler：request 是同步的，每次独立调用各自成轮（防抖是调用方职责）', () => {
  let runs = 0
  const sched = new DirtyScheduler(() => { runs += 1 })
  sched.request()
  sched.request()
  sched.request()
  assert.equal(runs, 3)
})

test('DirtyScheduler：病态循环在 maxRounds 处停下并标记 truncated', () => {
  let runs = 0
  const sched = new DirtyScheduler(() => {
    runs += 1
    sched.request() // 永远脏
  })
  sched.maxRounds = 3
  sched.request()
  assert.equal(runs, 3)
  assert.equal(sched.truncated, true)
})
