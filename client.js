/**
 * `dsh-auto-handoff` · Client 半边（浏览器里那半）。
 *
 * 只做两件事：**轮询** `/api/handoff/pending` → 有交接就**调导航/归档**。
 *
 * 原版在这半边摔过两次，代价都是"整个页面打不开"，所以这里的规矩是写死的：
 * 1. **不注册 slot、不写 DOM**（这半边没有 UI，设置页整块白掉就是那么来的）。
 *    ⚠ 2026-09-27 16:5x 她要求「隐藏让我看不到」那条自动交接包提示 → 唯一的例外：
 *    `hideHandoffNotice()` 只**读** DOM、只给**它自己那条**气泡设 `display:none`（不建节点、不注册 slot）。
 *    藏的是眼睛不是内容：上下文、档案、宿主侧一律不碰；出错只记 Console。
 * 2. **任何错只 `console`，不 throw**：apply 抛错会让入口 `did not activate`。
 * 3. **工厂体保持无副作用**，资源在 apply 里起、返回清理函数。
 * 4. **只用 `setInterval` + `fetch`**：`ctx.timer` / `ctx.effect` 在这半边被实测
 *    弄挂过页面（`entry did not activate`）。
 * 5. `uiWorkspace` 必须写进 `inject`（不声明就取不到），但**只能在回调里取**，
 *    不能在 apply 同步阶段直接读。
 * 6. 路由全在本插件里；万一插件没起来，`/pending` 才会 404 —— 那样**静默停轮询**，
 *    别每 10 秒刷一行 Console 错误。
 */
/**
 * ⚠ 2026-09-28 合并后新增一件事：往输入框 ➕ 的**指令菜单**注册「换会话」（原 dsh-session-switch 的客户端半）。
 * 边界见下面 registerSwitchWord 的注释（只替她打字，不切界面）。其余规矩一条没变。
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-handoff',
  factory() {
    /** 轮询间隔：10 秒够快也够省。 */
    const POLL_MS = 10_000;
    /** 切过去之后等界面切完再收旧会话（3 秒；原版从 1.5 秒放宽到 3 秒）。 */
    const ARCHIVE_DELAY_MS = 3_000;
    /** 两条路由（`/pending` 与 `/ack` 各注册一次，客户端这边各请求一次）。 */
    const ROUTE_PENDING = 'api/handoff/pending';
    const ROUTE_ACK = 'api/handoff/ack';
    /** 超 2 小时的旧待接不追（修"错过窗口就永远不切"那个 bug 时一并加的）。 */
    const STALE_MS = 2 * 60 * 60 * 1_000;
    /**
     * 自动交接包那条提示的识别串（她不想看到的就是它）。
     * ⚠ 2026-09-27 19:1x：Host 侧首句改成**按真实触发写**（原来是写死的"到阈值了"），
     * 这里必须跟着认两种 —— 旧会话里那些老气泡还得藏得住。
     */
    const HANDOFF_NOTICE_KEYS = ['【上一段对话已经交接', '【上一段对话到阈值了'];
    /** 扫提示气泡的间隔：1.5 秒，够快也够省。 */
    const NOTICE_SCAN_MS = 1_500;

    /** 一次日志前缀，方便在 Console 里过滤。 */
    const log = (message) => console.info(`[handoff-client] ${message}`);
    const warn = (message, error) => console.warn(`[handoff-client] ${message}`, error ?? '');

    /** 已经被处理过的那份待接（按 `at` 去重；**不用时间窗**，时间窗一错过就永久失效）。 */
    let handledAt = null;
    /** 路由不存在就停表：静默一次，别刷屏。 */
    let missingRoute = false;
    let timer = null;
    /** 藏提示气泡的扫表（与轮询分开，因为要快一点）。 */
    let noticeTimer = null;

    /**
     * 把**自动交接包那条提示**从界面上藏掉（她 2026-09-27 16:5x：「能不能隐藏让我看不到」）。
     *
     * 界面上它由 `dsh-recall-plugin` 渲染成 `.dsh-recall-bubble`（探针实测：含「【上一段对话到阈值了」的那一条，
     * 长 494 字）。**只给它自己那条设 `display:none`** —— 不建节点、不注册 slot、不碰上下文与档案。
     * 想收回去（不再隐藏）：把 `apply` 里那两行注掉，或整份还原 `写入备份\auto-handoff.client.藏提示前-*.js`。
     */
    function hideHandoffNotice() {
      try {
        for (const bubble of document.querySelectorAll('.dsh-recall-bubble')) {
          const text = bubble.textContent || '';
          if (!HANDOFF_NOTICE_KEYS.some((key) => text.includes(key))) continue;
          if (bubble.style.display !== 'none') bubble.style.display = 'none';
          // 只藏气泡会留下一条 ~34px 的空行（实测），所以连它所在那一行一起收掉。
          const row = bubble.closest('.dsh-recall-row');
          if (row && row.style.display !== 'none') row.style.display = 'none';
        }
      } catch (error) {
        warn('隐藏交接包提示失败（只记 Console，不影响界面）', error);
      }
    }

    /** 读待接；返回 null 表示"这次不该动作"（404/出错/太旧）。 */
    async function readPending() {
      if (missingRoute) return null;
      const response = await fetch(ROUTE_PENDING, { headers: { accept: 'application/json' } });
      if (response.status === 404) {
        missingRoute = true;
        log('没装 Host 半边（/pending 404）→ 静默停轮询');
        return null;
      }
      if (!response.ok) {
        warn(`/pending 返回 HTTP ${response.status}`);
        return null;
      }
      const body = await response.json().catch(() => null);
      const pending = body?.pending;
      if (!pending?.at || !pending?.handoff) return null;
      if (pending.handledAt || pending.at === handledAt) return null;
      if (Date.now() - Date.parse(pending.at) > STALE_MS) {
        log(`待接太旧（${pending.at}）→ 不追`);
        handledAt = pending.at;
        return null;
      }
      return pending;
    }

    /** 取客户端服务：**声明 + 回调里 try/catch 取**，取不到就只警告。 */
    function workspaceOf(ctx) {
      try {
        return ctx.uiWorkspace ?? null;
      } catch (error) {
        warn('取 uiWorkspace 失败（只警告，不动界面）', error);
        return null;
      }
    }

    /** 切过去：优先 `openSession(新会话 id)`；拿不到 id 才退回 `startSession()` 并说清是空白会话。 */
    function navigate(ui, pending) {
      const target = pending.newSessionId;
      if (target && typeof ui.openSession === 'function') {
        ui.openSession(target);
        log(`openSession(${target}) 已调用`);
        return true;
      }
      if (typeof ui.startSession === 'function') {
        ui.startSession();
        warn(`拿不到 newSessionId → 退回 startSession()（这是**空白**新会话，交接包不在里面）`);
        return true;
      }
      warn('uiWorkspace 既没有 openSession 也没有 startSession → 什么都不做');
      return false;
    }

    /** 归档原会话：失败只警告（页面与会话优先），可取消归档找回。 */
    async function archiveSource(ui, pending) {
      const source = pending.sourceSession;
      log(`归档检查：sourceSession=${source ?? '（无）'} archiveSession=${typeof ui.archiveSession === 'function' ? '有' : '没有'}`);
      if (!source || typeof ui.archiveSession !== 'function') return;
      try {
        await ui.archiveSession(source, { stopActivity: true });
        log(`已归档原会话 ${source}`);
      } catch (error) {
        warn(`归档原会话失败（只警告）`, error);
      }
    }

    /** 回报 Host：这份待接处理过了（成功失败都回报，免得下次重复开）。 */
    async function ack(pending, sessionId) {
      try {
        await fetch(ROUTE_ACK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: pending.at, sessionId: sessionId ?? '' }),
        });
      } catch (error) {
        warn('回报 ack 失败（下次轮询可能重复处理）', error);
      }
    }

    /** 一次轮询：发现交接 → 切过去 → 等界面切完再归档原会话 → 回报。 */
    async function tick(ctx) {
      try {
        const pending = await readPending();
        if (!pending) return;
        const ui = workspaceOf(ctx);
        if (!ui) {
          warn('uiWorkspace 不可用 → 这次不切');
          return;
        }
        log(`发现交接（seq ${pending.seq ?? '?'}，交接包 ${pending.handoffChars ?? pending.handoff.length} 字）→ 切到新会话`);
        const moved = navigate(ui, pending);
        handledAt = pending.at;
        if (moved) {
          // ⚠ 2026-09-27 16:4x 她一句「回原会话」之后关掉了**自动归档原会话**：
          //   这一版 DSH 的归档是**单向的**（官方 README：没有 unarchive，归档集是持久显示过滤），
          //   自动归档等于把她的旧对话从列表里永久拿掉 —— 代价她当场付过一次。
          //   现在只切、不归档；旧会话留在列表里（要清她自己点）。想恢复自动归档就把下面那行放回来。
          // setTimeout(() => { archiveSource(ui, pending).catch(() => {}); }, ARCHIVE_DELAY_MS);
          log(`已切到新会话；按现设置**不自动归档**原会话 ${pending.sourceSession ?? '（无）'}（要归档请自己点）`);
        }
        await ack(pending, pending.newSessionId);
      } catch (error) {
        // 客户端这半边抛错的代价是"整块界面白掉"，所以这里必须兜住一切。
        warn('轮询出错（只记 Console）', error);
      }
    }

    /* ── 指令菜单里的「换会话」（2026-09-28 从 dsh-session-switch 的客户端半搬来的） ──────
     * 她那天说「换会话就塞到换会话的插件里」；两个插件合并后，这一条跟着搬进这里。
     * 点一下 = 发一条**纯文本**「换会话」——Host 半边是按用户消息里的**整行关键词**认触发词的
     * （`liveKeyword` 默认就是「换会话」），发成 `/换会话` 就认不出来了。所以这里只替她打字。
     * 边界一条没松：不写 DOM、不注册 slot、不轮询、**不切界面**（切会话的只有上面那个 tick）。
     * 整块包 try：这一步失败也绝不能连累轮询（客户端抛错＝整页白掉，这条是拿事故换来的）。
     */

    /**
     * ⚠️ 老路（**DSH 新版下已失效**，保留只为兼容 `__test` 导出与历史引用）：
     *   它依赖 `uiSession.resolve(sessionId)` —— 这个 API 升级后已经不在 `UiSession` 上了，
     *   所以这条永远返回 undefined。**新路见下面的 `withInputActions`**。
     */
    function inputActionsOf(uiSession, sessionId) {
      if (uiSession === undefined || uiSession === null) return undefined;
      if (typeof uiSession.resolve !== 'function' || sessionId === undefined) return undefined;
      let binding;
      try {
        binding = uiSession.resolve(sessionId);
      } catch {
        return undefined;
      }
      return binding && binding.props ? binding.props.inputActions : undefined;
    }

    /**
     * 走**新 API** 拿输入动作：`ctx.sessions.using(sessionId, {source}, ref => …)`，
     * 动作在 `ref.binding.props.inputActions`。
     *
     * 🔴 2026-10-01 修（与 `dsh-memory-board/client.js` 的 `withInputActions` 是同一份改动的两份拷贝，
     *   两处必须一起改）：
     *   老写法依赖的 `uiSession.resolve(sessionId)` 在 DSH 升级后**已经不在 UiSession 上了**
     *   （现在只有 bindingSource / provide / registerPendingInteraction / sessionStatus），
     *   于是点「换会话」只会打一句警告、什么都不发 —— 实测控制台抓到了那条 warning。
     */
    function withInputActions(ctx, session, text, fn) {
      const sessionId = session && session.sessionId;
      if (sessionId === undefined || sessionId === null) {
        warn(`「${text}」没发出去：命令里没有 sessionId`);
        return;
      }
      let sessions;
      let uiSession;
      try {
        sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        uiSession = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined;
      } catch {
        sessions = undefined;
        uiSession = undefined;
      }
      if (!sessions || typeof sessions.using !== 'function') {
        warn(`「${text}」没发出去：拿不到 sessions 服务`);
        return;
      }
      sessions
        .using(sessionId, { source: 'auto-handoff-quick-word' }, (ref) => {
          // ⚠️ 2026-10-01 第二版：`ref.binding`（SessionBinding）**没有 props** ——
          //   props（含 inputActions）在 `uiSession.bindingSource(ref)` 返回的 StandardSourceBinding 上，
          //   取值用 `getSnapshot()`（照官方 dsh-client-ui-renderer 的用法）。
          let actions;
          try {
            const source = uiSession && typeof uiSession.bindingSource === 'function' ? uiSession.bindingSource(ref) : undefined;
            const binding = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined;
            const props = binding ? binding.props : undefined;
            actions = props ? props.inputActions : undefined;
          } catch (error) {
            warn(`取输入框失败：${error && error.message ? error.message : error}`);
            return;
          }
          if (actions === undefined || actions === null) {
            warn(`「${text}」没发出去：这个会话还没挂上输入框`);
            return;
          }
          fn(actions);
        })
        .catch((error) => warn(`发送「${text}」失败`, error));
    }

    /** 发一条词：写草稿 + 提交（提交走队列，正忙时会排队）。拿不到输入框就只留一行 warning。 */
    function sendQuickWord(first, session, text) {
      const doSend = (actions) => {
        try {
          actions.setDraft(text);
          actions.submit();
        } catch (error) {
          warn(`发送「${text}」失败`, error);
        }
      };
      // 第一个参数是 ctx（带 .get）→ 走新 API；是 uiSession → 走老路（DSH 新版下老路会打警告）
      if (first && typeof first.get === 'function') {
        withInputActions(first, session, text, doSend);
        return;
      }
      const actions = inputActionsOf(first, session && session.sessionId);
      if (actions === undefined || actions === null) {
        warn(`「${text}」没发出去：这个会话还没挂上输入框`);
        return;
      }
      doSend(actions);
    }

    /** 注册「换会话」指令（服务没到齐就静默不注册）。 */
    function registerSwitchWord(ctx) {
      try {
        // 🔴 2026-10-01：新 API 需要 `sessions`（ctx.sessions.using），一起列进 inject
        ctx.inject(['commandUi', 'uiSession', 'sessions'], (scope) => {
          try {
            scope.effect(
              () =>
                scope.commandUi.register({
                  name: '换会话',
                  available: () => true,
                  description: () => '触发自动交接，切到新会话',
                  ui: {
                    kind: 'action',
                    run: (session) => sendQuickWord(scope, session, '换会话'),
                  },
                }),
              'dsh-auto-handoff: /换会话',
            );
            log('已在指令菜单里注册「换会话」');
          } catch (error) {
            warn('注册「换会话」失败', error);
          }
        });
      } catch (error) {
        warn('注册「换会话」失败', error);
      }
    }

    return {
      // `uiWorkspace` 必须声明才拿得到；**只声明它**（塞进不存在的服务会让入口激活失败）。
      inject: ['uiWorkspace'],
      // 仅给 node --test 用；宿主/页面不消费。
      __test: { inputActionsOf, sendQuickWord, registerSwitchWord },
      apply(ctx) {
        try {
          log('已挂载：每 10 秒轮询一次 /api/handoff/pending（只做轮询 + 导航/归档）');
          timer = setInterval(() => { tick(ctx).catch(() => {}); }, POLL_MS);
          // 顺手把那条又长又刷屏的自动交接包提示从界面上藏掉（她要求："让我看不到"）。
          hideHandoffNotice();
          noticeTimer = setInterval(hideHandoffNotice, NOTICE_SCAN_MS);
          // 指令菜单里的「换会话」（合并后跟着搬进来的那条）。
          registerSwitchWord(ctx);
        } catch (error) {
          warn('挂载失败（只记 Console，组件不抛）', error);
        }
        return () => {
          try {
            if (timer !== null) clearInterval(timer);
            if (noticeTimer !== null) clearInterval(noticeTimer);
            timer = null;
            noticeTimer = null;
          } catch { /* 清理失败不该影响卸载 */ }
        };
      },
    };
  },
});
