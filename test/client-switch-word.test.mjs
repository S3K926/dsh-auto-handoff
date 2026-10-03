// dsh-auto-handoff 客户端半 · 离线自测：指令菜单里的「换会话」
//（2026-09-28 从 dsh-session-switch 的客户端半搬来的那条）
//
// 跑法：node --test test/client-switch-word.test.mjs
//
// 守的是什么（这半块的历史教训：客户端炸一次＝整页打不开）：
//   ① 加载仍是"惰性工厂 + 预打包形式"，plugin id 严格等于包名；
//   ② 「换会话」注册成 action 指令，点下去发的是**纯文本词**（不是 `/换会话` —— Host 靠整行关键词认词）；
//   ③ 服务没到齐、会话没挂上输入框、发送抛错 —— 三种都不许把页面带崩。
//
// 🔴 2026-10-03 修「发不出去」后同步 + 补两条：
//   · 走新 API（ctx.get('sessions').using + uiSession.bindingSource），旧断言按新行为重写；
//   · setDraft + submit 这条官方通道**保留**（有 document 时 DOM 里没字才补真实 DOM 输入）；
//   · 新增 ① 有 document → 走 DOM 输入；② submit 抛错 → 回退派发 Enter。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/**
 * 把 client.js 当页面脚本加载一遍，拿回它的 exports（不吃 ESM 缓存，每次重新执行）。
 * `globals` 用来给离线沙箱补 `document` / 各类事件构造器 —— 不传时沙箱里没有 `document`，
 * 正好用来验证"没有 DOM 也必须不抛"。
 */
async function loadClient({ globals } = {}) {
  const code = await readFile(CLIENT, 'utf8')
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(cfg) {
          captured = cfg
        },
      },
    },
    console,
    ...(globals || {}),
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'dsh-auto-handoff/client.js' })
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load(...)')
  assert.equal(captured.id, 'dsh-auto-handoff')
  return captured.factory()
}

/**
 * 造一套极简假 DOM，只为让 `client.js` 的 DOM 路径能跑：
 *   - `document.querySelector/querySelectorAll` 按 `_selectors` 集合匹配；
 *   - `document.execCommand` 默认返回 false（逼代码走 textContent + InputEvent 的兜底）；
 *   - textarea 的原生 value setter 挂在自己原型上（`Object.getOwnPropertyDescriptor(...,'value').set` 才拿得到）。
 */
function makeFakeEnv() {
  const nodes = []

  const textAreaProto = {}
  Object.defineProperty(textAreaProto, 'value', {
    configurable: true,
    get() {
      return this._value
    },
    set(next) {
      this._value = next
    },
  })
  const inputProto = {}
  Object.defineProperty(inputProto, 'value', {
    configurable: true,
    get() {
      return this._value
    },
    set(next) {
      this._value = next
    },
  })

  class FakeEvent {
    constructor(type, init) {
      this.type = type
      Object.assign(this, init)
    }
  }
  class FakeInputEvent extends FakeEvent {}
  class FakeKeyboardEvent extends FakeEvent {}

  const document = {
    _execCommands: [],
    _execResult: false,
    querySelector(selector) {
      return nodes.find((node) => node._selectors.has(selector)) ?? null
    },
    querySelectorAll(selector) {
      return nodes.filter((node) => node._selectors.has(selector))
    },
    execCommand(command, ui, text) {
      this._execCommands.push([command, ui, text])
      return this._execResult
    },
  }

  function withEvents(node) {
    node._events = []
    node.focus = function () {
      this._focused = true
    }
    node.dispatchEvent = function (event) {
      this._events.push(event)
      return true
    }
    nodes.push(node)
    return node
  }

  return {
    document,
    globals: {
      document,
      Event: FakeEvent,
      InputEvent: FakeInputEvent,
      KeyboardEvent: FakeKeyboardEvent,
      HTMLTextAreaElement: { prototype: textAreaProto },
      HTMLInputElement: { prototype: inputProto },
    },
    /** DSH 0.2.0-rc.2 的真实输入框：`<div role="textbox" data-composer-input>`（没有 value）。 */
    makeComposer() {
      return withEvents({
        tagName: 'DIV',
        textContent: '',
        _selectors: new Set(['[data-composer-input]']),
      })
    },
    /** 老版 DSH 的 textarea 输入框（走原生 value setter 那条路）。 */
    makeTextArea() {
      const node = Object.create(textAreaProto)
      node.tagName = 'TEXTAREA'
      node._value = ''
      node.textContent = ''
      node._selectors = new Set(['textarea'])
      return withEvents(node)
    },
  }
}

/**
 * 只测注册函数，不跑 apply（apply 会起 setInterval 并摸 DOM —— 那是页面的事，不是这里的事）。
 * ctx 按**新 API** 造：注册回调拿到的 scope 带 `get('sessions')` / `get('uiSession')`，
 * `sessions.using(id, opts, cb)` 同步回调，`uiSession.bindingSource()` 的 snapshot 里挂 inputActions。
 */
function makeCtx({ inputActions, sessions, uiSession, injectRuns = true } = {}) {
  const registered = []
  const sessionsService = sessions ?? {
    using(sessionId, options, cb) {
      cb({ sessionId })
      return Promise.resolve()
    },
  }
  const uiSessionService = uiSession ?? {
    bindingSource() {
      return { getSnapshot: () => ({ props: { inputActions } }) }
    },
  }
  const scope = {
    commandUi: {
      register(contribution) {
        registered.push(contribution)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessions') return sessionsService
      if (name === 'uiSession') return uiSessionService
      return undefined
    },
    effect(fn) {
      return fn()
    },
  }
  const seenInjections = []
  const ctx = {
    inject(names, cb) {
      seenInjections.push(Array.from(names))
      if (injectRuns) cb(scope)
    },
  }
  return { ctx, registered, seenInjections, scope }
}

test('元信息：惰性工厂形式，id 等于包名，模块级 inject 声明了 uiWorkspace/sessions/uiSession', async () => {
  const mod = await loadClient()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(Array.from(mod.inject), ['uiWorkspace', 'sessions', 'uiSession'])
})

test('注册：一条 action 指令「换会话」', async () => {
  const mod = await loadClient()
  const { ctx, registered, seenInjections } = makeCtx({ inputActions: { setDraft() {}, submit() {} } })
  mod.__test.registerSwitchWord(ctx)

  assert.deepEqual(seenInjections, [['commandUi', 'uiSession', 'sessions']])
  assert.equal(registered.length, 1)
  const c = registered[0]
  assert.equal(c.name, '换会话')
  assert.equal(c.ui.kind, 'action')
  assert.equal(c.available({}), true)
  assert.ok(c.description().length > 0)
})

test('点一下：官方通道仍是 setDraft + submit，发的是词本身（纯文本，不是 /换会话）', async () => {
  const mod = await loadClient()
  const calls = []
  const { ctx, registered } = makeCtx({
    inputActions: {
      setDraft(text) {
        calls.push(['setDraft', text])
      },
      submit() {
        calls.push(['submit'])
      },
    },
  })
  mod.__test.registerSwitchWord(ctx)
  registered[0].ui.run({ sessionId: 'session-19f7' })
  assert.deepEqual(calls, [
    ['setDraft', '换会话'],
    ['submit'],
  ])
})

test('有 document：setDraft 没把字落进 DOM → 走真实 DOM 输入（contenteditable）', async () => {
  const env = makeFakeEnv()
  const composer = env.makeComposer()
  const mod = await loadClient({ globals: env.globals })
  const calls = []
  const { ctx, registered } = makeCtx({
    inputActions: {
      // 故意不落 DOM，模拟官方 setDraft 在新版 DSH 下失效
      setDraft(text) {
        calls.push(['setDraft', text])
      },
      submit() {
        calls.push(['submit'])
      },
    },
  })
  mod.__test.registerSwitchWord(ctx)
  assert.doesNotThrow(() => registered[0].ui.run({ sessionId: 'session-19f7' }))

  assert.equal(composer.textContent, '换会话', '回退要把词写进 input 框')
  assert.equal(composer._focused, true, '写之前要先 focus 输入框')
  assert.ok(
    composer._events.some((e) => e.type === 'input'),
    '写进 DOM 后要派发 input 事件（让编辑器知道内容变了）',
  )
  assert.deepEqual(calls, [
    ['setDraft', '换会话'],
    ['submit'],
  ])
  assert.ok(
    !composer._events.some((e) => e.type === 'keydown'),
    'DOM 里已经有文本时，不该再多派一次 Enter',
  )
})

test('submit 抛错：回退对输入框派发 Enter（keyCode=13），且不崩', async () => {
  const env = makeFakeEnv()
  const composer = env.makeComposer()
  const mod = await loadClient({ globals: env.globals })
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => warned.push(args.join(' '))
  try {
    const { ctx, registered } = makeCtx({
      inputActions: {
        setDraft() {},
        submit() {
          throw new Error('queue-busy')
        },
      },
    })
    mod.__test.registerSwitchWord(ctx)
    assert.doesNotThrow(() => registered[0].ui.run({ sessionId: 's1' }))

    const keydown = composer._events.find((e) => e.type === 'keydown')
    assert.ok(keydown, 'submit 抛错必须回退派发 Enter')
    assert.equal(keydown.key, 'Enter')
    assert.equal(keydown.code, 'Enter')
    assert.equal(keydown.keyCode, 13)
    assert.equal(keydown.bubbles, true)
    assert.equal(keydown.cancelable, true)
    assert.ok(warned.some((w) => w.includes('queue-busy')))
  } finally {
    console.warn = realWarn
  }
})

test('服务没到齐（inject 不回调）：不抛、不注册', async () => {
  const mod = await loadClient()
  const { ctx, registered } = makeCtx({ injectRuns: false })
  assert.doesNotThrow(() => mod.__test.registerSwitchWord(ctx))
  assert.equal(registered.length, 0)
})

test('拿不到输入框 / setDraft 抛错：都不崩，只留 warning', async () => {
  const mod = await loadClient()
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => warned.push(args.join(' '))
  try {
    // inputActions 为 undefined → "这个会话还没挂上输入框"
    const missing = makeCtx()
    mod.__test.registerSwitchWord(missing.ctx)
    assert.doesNotThrow(() => missing.registered[0].ui.run({ sessionId: 's1' }))
    assert.doesNotThrow(() => missing.registered[0].ui.run({}))
    assert.ok(warned.some((w) => w.includes('没挂上输入框')))
    assert.ok(warned.some((w) => w.includes('没有 sessionId')))

    const broken = makeCtx({
      inputActions: {
        setDraft() {
          throw new Error('boom')
        },
        submit() {},
      },
    })
    mod.__test.registerSwitchWord(broken.ctx)
    assert.doesNotThrow(() => broken.registered[0].ui.run({ sessionId: 's1' }))
    assert.ok(warned.some((w) => w.includes('boom')))
  } finally {
    console.warn = realWarn
  }
})
