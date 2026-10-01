// dsh-auto-handoff · 回归测试：两条往返的返回值必须归一到同一形状
//
// 跑法：node --test test/switch-direct.test.mjs
//
// 这条守的是 2026-09-28 第一次真交接踩到的坑（合并当天）：
//   HTTP 那条路回 `{ ok, status, body }`，新加的直调回 `{ status, payload }`，
//   而判定只认 `response.body?.ok` → "直调明明 200 成功"被读成失败 → 白走一次降级
//   （日志原文：`「会话切换」没接：HTTP 200 → 降级：只记待接，让客户端半边自己切`）。
// 所以这里对**两种形状**都断言一次，谁改坏了都会红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSwitchResult } from '../index.js'

test('HTTP path shape: { ok, status, body }', () => {
  const r = normalizeSwitchResult({ ok: true, status: 200, body: { ok: true, pending: { newSessionId: 'session-a' } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.pending.newSessionId, 'session-a')
})

test('direct-call shape: { status, payload } —— 合并后第一次真交接就是死在这上面', () => {
  const r = normalizeSwitchResult({ status: 200, payload: { ok: true, pending: { newSessionId: 'session-b' } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true, '直调的 payload 必须能被当成 body 读')
  assert.equal(r.body.pending.newSessionId, 'session-b')
})

test('闸住（429）两种形状都能读出 reason', () => {
  const http = normalizeSwitchResult({ ok: false, status: 429, body: { ok: false, reason: 'source-cooldown', error: '同源冷却' } })
  assert.equal(http.status, 429)
  assert.equal(http.body.reason, 'source-cooldown')

  const direct = normalizeSwitchResult({ status: 429, payload: { ok: false, reason: 'budget', error: '预算用完' } })
  assert.equal(direct.status, 429)
  assert.equal(direct.body.reason, 'budget')
})

test('建会话失败（500）两种形状都能读出 error', () => {
  for (const raw of [
    { ok: false, status: 500, body: { ok: false, error: '建会话失败：没有活的会话工厂' } },
    { status: 500, payload: { ok: false, error: '建会话失败：没有活的会话工厂' } },
  ]) {
    const r = normalizeSwitchResult(raw)
    assert.equal(r.status, 500)
    assert.match(r.body.error, /建会话失败/)
  }
})

test('坏输入不抛：undefined / null / 字符串 / 缺字段', () => {
  for (const raw of [undefined, null, 'nope', 42, {}, { status: 'x' }]) {
    const r = normalizeSwitchResult(raw)
    assert.equal(typeof r.status, 'number')
    assert.ok(!Number.isNaN(r.status))
    assert.equal(typeof r.body, 'object')
  }
  assert.equal(normalizeSwitchResult(undefined).status, 0)
  assert.deepEqual(normalizeSwitchResult(undefined).body, {})
})
