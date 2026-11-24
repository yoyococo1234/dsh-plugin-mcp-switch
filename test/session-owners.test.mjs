import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addOwner,
  removeOwner,
  isVisibleTo,
  dropSessionOwners,
  ownersToObject,
  objectToOwners,
  visibleToText,
} from '../lib/session-owners.mjs'

test('addOwner 登记拥有者；空 sessionId 不登记', () => {
  const m = new Map()
  assert.equal(addOwner(m, 's1', 'session-A'), true)
  assert.equal(addOwner(m, 's1', 'session-A'), false, '重复登记不算新增')
  assert.equal(addOwner(m, 's1', ''), false, '空 sessionId 不登记')
  assert.deepEqual([...m.get('s1')], ['session-A'])
})

test('removeOwner 只摘当前会话；还有别的拥有者时不 empty', () => {
  const m = new Map([['s1', new Set(['A', 'B'])]])
  const r1 = removeOwner(m, 's1', 'A')
  assert.deepEqual(r1, { removed: true, empty: false, anonymous: false })
  assert.deepEqual([...m.get('s1')], ['B'], 'B 仍在，连接不能断')

  const r2 = removeOwner(m, 's1', 'B')
  assert.deepEqual(r2, { removed: true, empty: true, anonymous: false })
  assert.equal(m.has('s1'), false, '最后一个拥有者走了，条目删除')
})

test('removeOwner 对匿名连接返回 anonymous，允许全局断开', () => {
  const m = new Map()
  assert.deepEqual(removeOwner(m, 's1', 'A'), { removed: false, empty: true, anonymous: true })
})

test('removeOwner 摘一个不是拥有者的会话：不动连接', () => {
  const m = new Map([['s1', new Set(['A'])]])
  assert.deepEqual(removeOwner(m, 's1', 'B'), { removed: false, empty: false, anonymous: false })
  assert.deepEqual([...m.get('s1')], ['A'])
})

test('isVisibleTo：匿名人人可见，拥有者可见，外人不可见', () => {
  const m = new Map([['s1', new Set(['A'])]])
  assert.equal(isVisibleTo(m, 's2', 'B'), true, '无归属 = 全局可见')
  assert.equal(isVisibleTo(m, 's1', 'A'), true, '拥有者可见')
  assert.equal(isVisibleTo(m, 's1', 'B'), false, '外会话不可见')
})

test('isVisibleTo：子智能体通过 isOwnedBy 继承可见性', () => {
  const m = new Map([['s1', new Set(['parent'])]])
  const isOwnedBy = (child, owner) => child === 'child-1' && owner === 'parent'
  assert.equal(isVisibleTo(m, 's1', 'child-1', isOwnedBy), true)
  assert.equal(isVisibleTo(m, 's1', 'child-2', isOwnedBy), false)
})

test('isVisibleTo：isOwnedBy 抛错时 fail closed', () => {
  const m = new Map([['s1', new Set(['A'])]])
  assert.equal(isVisibleTo(m, 's1', 'B', () => { throw new Error('boom') }), false)
})

test('dropSessionOwners：reclaim=true 返回要断开的连接', () => {
  const m = new Map([
    ['s1', new Set(['A'])],
    ['s2', new Set(['A', 'B'])],
    ['s3', new Set(['B'])],
  ])
  const r = dropSessionOwners(m, 'A', true)
  assert.equal(r.changed, true)
  assert.deepEqual(r.emptied.sort(), ['s1'], '只有 s1 因 A 离开而变空')
  assert.deepEqual([...m.get('s2')], ['B'])
  assert.equal(m.has('s1'), false)
})

test('dropSessionOwners：reclaim=false 时空归属连接不进 emptied（转匿名）', () => {
  const m = new Map([['s1', new Set(['A'])]])
  const r = dropSessionOwners(m, 'A', false)
  assert.deepEqual(r.emptied, [])
  assert.equal(m.has('s1'), false, '条目删除 = 全局可见')
})

test('归属可往返序列化；脏数据被过滤', () => {
  const m = new Map([['s1', new Set(['A', 'B'])], ['s2', new Set()]])
  const obj = ownersToObject(m)
  assert.deepEqual(obj, { s1: ['A', 'B'] }, '空集不写盘')
  assert.deepEqual([...objectToOwners(obj).get('s1')], ['A', 'B'])
  const dirty = objectToOwners({ s1: ['A', '', 42, null], s2: 'not-array' })
  assert.deepEqual([...dirty.get('s1')], ['A'])
  assert.equal(dirty.has('s2'), false)
})

test('visibleToText：空归属显示 fallback，有归属短 id 拼接', () => {
  const m = new Map([['s1', new Set(['session-abcdef123456', 'B'])]])
  const short = (x) => String(x).replace(/^session-/, '').slice(0, 8)
  assert.equal(visibleToText(new Map(), 's1', short), '全部会话')
  assert.equal(visibleToText(m, 's1', short), 'abcdef12、B')
})
