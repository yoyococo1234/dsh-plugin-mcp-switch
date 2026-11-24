/**
 * 会话归属的纯数据模型（无宿主依赖，可单测）。
 *
 * openedBy: Map<serverId, Set<sessionId>>
 *   - 无条目 / 空集 = 匿名连接（设置页 / REST / 启动策略），对所有会话可见
 *   - 非空 = 只有列出的会话及其子智能体可见
 *
 * 所有改动都返回「是否变空」，让调用方决定是否真的 dispose 连接——
 * 这是「开/关对称」的关键：关只摘当前会话，最后一个拥有者走了才断开。
 */

/** Map -> 可 JSON 化的普通对象（写盘用）。 */
export function ownersToObject(openedBy) {
  const out = {}
  if (!(openedBy instanceof Map)) return out
  for (const [serverId, set] of openedBy) {
    if (set && set.size) out[String(serverId)] = [...set].map(String)
  }
  return out
}

/** 盘上的对象 -> Map（读盘用），过滤脏数据。 */
export function objectToOwners(raw) {
  const out = new Map()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [serverId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    const set = new Set(value.filter((x) => typeof x === 'string' && x).map(String))
    if (set.size) out.set(serverId, set)
  }
  return out
}

/** 给连接加一个拥有者。返回是否真的新增。 */
export function addOwner(openedBy, serverId, sessionId) {
  if (!sessionId) return false
  const id = String(serverId)
  const sid = String(sessionId)
  let set = openedBy.get(id)
  if (!set) {
    set = new Set()
    openedBy.set(id, set)
  }
  const before = set.size
  set.add(sid)
  return set.size !== before
}

/**
 * 摘掉一个会话对某连接的归属。
 * 返回 { removed, empty, anonymous }：
 *   removed   — 该会话确实是拥有者且被摘掉
 *   empty     — 摘完后没有任何拥有者（调用方应真正断开）
 *   anonymous — 本来就没有拥有者（全局连接，调用方可全局断开）
 */
export function removeOwner(openedBy, serverId, sessionId) {
  const id = String(serverId)
  const set = openedBy.get(id)
  if (!set || !set.size) return { removed: false, empty: true, anonymous: true }
  const sid = String(sessionId || '')
  if (!sid || !set.has(sid)) return { removed: false, empty: false, anonymous: false }
  set.delete(sid)
  const empty = set.size === 0
  if (empty) openedBy.delete(id)
  return { removed: true, empty, anonymous: false }
}

/**
 * 会话能否看见某连接。
 * isOwnedBy(childId, ownerId) 由宿主注入；缺省只认精确 id（子智能体判定不可用）。
 */
export function isVisibleTo(openedBy, serverId, sessionId, isOwnedBy) {
  const owners = openedBy.get(String(serverId))
  if (!owners || owners.size === 0) return true // 匿名 = 人人可见
  const id = String(sessionId || '')
  if (!id) return false
  if (owners.has(id)) return true
  if (typeof isOwnedBy !== 'function') return false
  for (const owner of owners) {
    try {
      if (isOwnedBy(id, owner)) return true
    } catch {
      // 宿主判定抛错就当不是子智能体，fail closed
    }
  }
  return false
}

/**
 * 会话消失后摘掉它的全部归属。
 * reclaim=true 时返回需要真正断开的 serverId；false 时这些连接变成匿名（全局可见）。
 */
export function dropSessionOwners(openedBy, sessionId, reclaim) {
  const sid = String(sessionId || '')
  const emptied = []
  let changed = false
  for (const [serverId, set] of [...openedBy]) {
    if (!set.has(sid)) continue
    set.delete(sid)
    changed = true
    if (set.size) continue
    openedBy.delete(serverId)
    if (reclaim) emptied.push(serverId)
  }
  return { changed, emptied }
}

/** 状态面板用：拥有者列表的人读文本。 */
export function visibleToText(openedBy, serverId, shorten, fallback = '全部会话') {
  const owners = openedBy.get(String(serverId))
  if (!owners || !owners.size) return fallback
  const fmt = typeof shorten === 'function' ? shorten : (x) => String(x)
  return [...owners].map(fmt).join('、')
}
