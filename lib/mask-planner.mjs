/**
 * 会话遮挡的纯计算层（无宿主依赖，可单测）。
 *
 * 职责：
 *   1) 工具名快照缓存：MCP 工具异步注册，名字集合会变；只有变化时才重打 restrict。
 *   2) 遮挡计划：给定会话列表 + 服务器列表 + 归属，算出「谁该被挡、挡哪些工具」。
 *   3) 脏标记调度：sync 重入不再丢弃，改成「标记脏 → 循环到干净」。
 */

/** 工具名快照缓存。key 是排序后 join，集合相同就不算变化。 */
export class ToolNameCache {
  constructor() {
    this.names = new Map() // serverId -> string[]
    this.keys = new Map() // serverId -> joined key
  }

  static keyOf(names) {
    return [...new Set((names || []).map(String))].sort().join('|')
  }

  /**
   * 更新快照。返回 { changed, key, names }：
   *   changed=false 时 names/key 与上次相同，调用方可跳过重建 restrict。
   */
  update(serverId, names) {
    const id = String(serverId)
    const list = [...new Set((names || []).map(String))]
    const key = ToolNameCache.keyOf(list)
    if (this.keys.get(id) === key) return { changed: false, key, names: this.names.get(id) || [] }
    this.keys.set(id, key)
    this.names.set(id, list)
    return { changed: true, key, names: list }
  }

  get(serverId) {
    return this.names.get(String(serverId)) || []
  }

  delete(serverId) {
    this.names.delete(String(serverId))
    this.keys.delete(String(serverId))
  }

  clear() {
    this.names.clear()
    this.keys.clear()
  }
}

/**
 * 计算遮挡计划。
 * 参数都是纯数据/回调，便于测试注入：
 *   agents        — 会话对象数组（需有 id）
 *   servers       — 服务器数组（需有 id）
 *   isConnected   — (serverId) => bool
 *   toolNames     — (server) => string[]，全局视角下该 server 的工具名
 *   isVisibleTo   — (serverId, agentId) => bool（来自 session-owners.isVisibleTo）
 * 返回 [{ agentId, serverId, names, key }]，只含真正需要遮挡的项。
 */
export function buildMaskPlan({ agents, servers, isConnected, toolNames, isVisibleTo, cache }) {
  const plan = []
  for (const agent of agents || []) {
    const agentId = String(agent?.id || '')
    if (!agentId) continue
    for (const server of servers || []) {
      const serverId = String(server?.id || '')
      if (!serverId) continue
      if (!isConnected(serverId)) continue
      if (isVisibleTo(serverId, agentId)) continue
      const names = toolNames(server)
      if (!names || !names.length) continue // 工具还没注册完，挡空清单等于没挡
      const snap = cache ? cache.update(serverId, names) : { changed: true, key: ToolNameCache.keyOf(names), names }
      plan.push({ agentId, serverId, names: snap.names, key: snap.key })
    }
  }
  return plan
}

/**
 * 脏标记调度器：render 执行期间任何 request() 都只置脏，render 结束后再跑一轮，
 * 直到没有新请求。解决原实现「syncing 期间的同源 tools/change 被直接吞掉」的问题。
 */
export class DirtyScheduler {
  constructor(run) {
    this.run = run
    this.dirty = false
    this.running = false
    this.maxRounds = 10 // 防病态循环（restrict 若每次都触发 change，10 轮后停并交给外部告警）
    this.truncated = false
  }

  request() {
    this.dirty = true
    if (!this.running) this.flush()
  }

  flush() {
    if (this.running) return // 重入：只置脏，外层循环会再跑
    this.running = true
    this.truncated = false
    try {
      let rounds = 0
      do {
        this.dirty = false
        this.run()
        rounds += 1
        if (this.dirty && rounds >= this.maxRounds) {
          this.truncated = true
          this.dirty = false
        }
      } while (this.dirty)
    } finally {
      this.running = false
    }
  }
}
