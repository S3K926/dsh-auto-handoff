// handoff-state.js —— 从 index.js 拆出（2026-09-27 收工自检判 index.js 超 800 行，按职责拆块）。
// 纯搬移：函数体一行没改，只补了 import / export。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot, flattenHandoff, localStamp, oneLine, processHandoff } from './handoff-core.js';
// 拆块后补：`isDrill` / `isLive` 要读"用户最近说了什么"（material 的活）。
// ⚠ 只往 material 单向引 —— 别在这儿 import summary，那会绕成环（summary 已经 import 本模块的 report）。
import { isKeywordLine, userSaidEntries } from './handoff-material.js';

export const LOG_FILE = join(tmpdir(), 'dsh-auto-handoff.log');
export const LOG_CAP = 200;

/* --------------------------------------------------------------- 模块态 */

/** 插件级状态：宿主里只此一份，路由与触发器共用。 */
export const pluginState = {
  pending: null,
  pendingNewSessionId: null,
  lastRatio: null,
  lastDecision: '（还没算过）',
  lastTrigger: new Map(),
  // 演练关键词"待命"标记：`user/message` 事件里抓到关键词先记下，等下一次 pre-step 消费。
  // 为什么不在 pre-step 里直接读消息 —— 真机时序（2026-09-25 12:46 对着会话事件实测）：
  // turn/start → agent/inbox/spliced → step/start → **user/message**，
  // 也就是 **pre-step 跑在"消息入流"之前**，那一刻快照里根本没有这条消息。
  drillPending: null,
  // 真交接关键词"待命"标记（2026-09-27 16:3x 加）：跟 drillPending 同一个道理，
  // 但**只在实时抓取那条路**设，且只消费一次。打一次真交接关键词（现口径：`换会话`）= 立刻写真档案 + 切会话。
  livePending: null,
  // 演练去重（2026-09-27 16:1x 修 bug 时加的）：匹配到的**那条用户消息**的指纹。
  // 为什么必须有 —— `isDrill` 读的是整个快照，"最近三条用户消息"里只要还挂着 `#交接演练`，
  // **每一次 pre-step 都会重跑一遍演练**（真机 16:05-16:06：一分钟内跑了 4 次，
  // 于是打了 4 次切换请求，全靠 session-switch 的闸挡住才没建出第 5 个会话）。
  drilledMessages: new Set(),
  // 本次 `apply` 的时刻（2026-09-27 加）：只认「这次启动之后到达」的消息，
  // 免得重启把去重记忆清空之后，**旧关键词又被吃一次**（真机 20:1x 踩到）。
  sinceMs: 0,
  logs: [],
};

/** 待接记录（内存版）：客户端轮询 `/pending` 拿的就是它。 */
export function pendingView() {
  if (!pluginState.pending) return { ok: true, pending: null, note: '暂无待交接' };
  return { ok: true, pending: pluginState.pending };
}

/** 交接完成后的待接落盘 —— 客户端据此决定"切到哪个会话"。 */
export function writePending(mode, result, session, newSessionId) {
  const record = {
    at: new Date().toISOString(),
    mode,
    seq: result.seq ?? null,
    sourceSession: String(session?.id ?? ''),
    newSessionId: newSessionId ?? null,
    handoff: result.handoff ?? '',
    handoffChars: (result.handoff ?? '').length,
    note: '由 dsh-auto-handoff 写入（真档案已写；切会话由本插件的会话那一摊接手）',
  };
  pluginState.pending = record;
  pluginState.pendingNewSessionId = newSessionId ?? null;
  return record;
}

/* ----------------------------------------------------------------- 日志 */

/** 写一行诊断日志（同步、绝不抛：诊断件坏了不能拖垮交接）。 */
export function report(line) {
  const text = `${localStamp().written} ${line}`;
  pluginState.logs.push(text);
  if (pluginState.logs.length > LOG_CAP) pluginState.logs.splice(0, pluginState.logs.length - LOG_CAP);
  try {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(LOG_FILE, `${text}\n`, { encoding: 'utf8', flag: 'a' });
  } catch { /* 诊断日志写不进去不影响交接本身 */ }
  return text;
}

/* ------------------------------------------------------------- 占用率口径 */

/**
 * 量上下文占用率。**优先会话投影 `contextPressure`**（跟页面上那个百分比同源），
 * 拿不到再退回 `ctx.tokenMeter.measure() ÷ request/context().contextWindow`；
 * **两者都拿不到就返回 null 且不动作** —— 不许瞎猜分母。
 */
export function measureRatio(ctx, session) {
  // ⚠ 2026-09-25 12:0x 真机事故：这个函数体里任何一步都可能抛
  //（实测 `stateOf(session,'contextPressure')` 抛过 `Cannot read properties of undefined (reading 'kind')`），
  // 而它挂在 `agent/pre-step` 上 —— **一抛就是"用户每发一条消息都本轮运行失败"**。
  // 所以整段兜住：量不到就返回 null = "不动作"，绝不把异常放回对话链路。
  try {
    const pressure = ctx.get('sessionProjections')?.stateOf(session, 'contextPressure');
    const projection = ratioFrom(pressure?.projectedTokens, pressure?.contextWindow, 'projection');
    if (projection) return projection;
    const fallback = ratioFrom(ctx.get('tokenMeter')?.measure?.(session)?.totalTokens, session?.requestContext?.()?.contextWindow, 'tokenMeter');
    if (fallback) return fallback;
    return null;
  } catch (error) {
    report(`量占用率失败（已忽略，不拦对话）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 有分子有分母才算得出占用率；缺一个就返回 null（这一条是"不动作"的判据）。 */
export function ratioFrom(tokens, contextWindow, basis) {
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return { ratio: tokens / contextWindow, tokens, contextWindow, basis };
}

/**
 * 全局冷静期（2026-09-27 交接连锁事故后加的）：**同一时间窗里最多自动交接几次**。
 *
 * 为什么本地冷却不够：`cooldownMs` 是**按会话**记的（`lastTrigger` 的键是 session.id），
 * 所以"160 个会话各自冷却 3 分钟"= 一点刹车都没有。事故那天就是每个会话都合规地触发了一次。
 * 这一道是**跨会话的**：窗口内到量就一律不触发，直到最早的记录出窗。
 */
export const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_MAX_PER_WINDOW = 2;
export const GLOBAL_FIRE_LOG_CAP = 50;

/** 当前生效的全局闸参数（取配置，配置坏了退回默认 —— 口径与 `DEFAULTS` 一致）。 */
export function globalGate() {
  const config = pluginState.config ?? {};
  const windowMs = Number.isFinite(config.globalWindowMs) && config.globalWindowMs > 0 ? config.globalWindowMs : GLOBAL_WINDOW_MS;
  const max = Number.isFinite(config.globalMaxPerWindow) && config.globalMaxPerWindow > 0 ? config.globalMaxPerWindow : GLOBAL_MAX_PER_WINDOW;
  return { windowMs, max };
}

/** 判全局冷静期：只读 `pluginState.lastFires`，不产生副作用（`now` 只为自检注入，正常不传）。 */
export function globalCooldown(now = Date.now()) {
  const { windowMs, max } = globalGate();
  pluginState.lastFires = (pluginState.lastFires ?? []).filter((at) => Number.isFinite(at) && now - at < windowMs);
  const used = pluginState.lastFires.length;
  if (used >= max) {
    const waitMin = Math.ceil((windowMs - (now - pluginState.lastFires[0])) / 60_000);
    return { ok: false, used, reason: `全局冷静期：${windowMs / 60_000} 分钟内已交接 ${used}/${max} 次（再等 ${waitMin} 分钟）` };
  }
  return { ok: true, used, reason: `全局冷静期已过（${used}/${max}）` };
}

/** 给自检用：把"最近几次交接"直接摆好（真实路径只会由 `noteGlobalFire` 追加）。 */
export function __setLastFiresForTest(fires) {
  pluginState.lastFires = Array.isArray(fires) ? [...fires] : [];
}

/** 给自检用：读一次全局冷静期判定（只读，不改状态）。 */
export function __globalCooldownForTest(now = Date.now()) {
  return globalCooldown(now);
}

/**
 * 给自检用：直接问"这一段快照该不该演练"（`isDrill` 是模块内部的，不外露）。
 * 2026-09-27 16:1x 修"每个 pre-step 重跑一遍演练"时加的验收入口。
 */
export function __isDrillForTest(events, keyword) {
  return isDrill({ snapshotEvents: () => events }, keyword);
}

/** 给自检用：直接问"这一段快照该不该触发**真**交接"（`isLive` 是模块内部的）。 */
export function __isLiveForTest(events, keyword) {
  return isLive({ snapshotEvents: () => events }, keyword);
}

/** 给自检用：清掉演练去重记录（免得自检之间互相干扰）。 */
export function __resetDrillsForTest() {
  pluginState.drilledMessages.clear();
  pluginState.drillPending = null;
  pluginState.livePending = null;
}

/** 给自检用：读一眼模块态（验"哪个关键词待命了"）。 */
export function __stateForTest() {
  return pluginState;
}

/** 记一次真的发生过的交接（只有非 dryRun 的真交接才记）。 */
export function noteGlobalFire() {
  pluginState.lastFires = [...(pluginState.lastFires ?? []), Date.now()].slice(-GLOBAL_FIRE_LOG_CAP);
}

/* 全局闸的两项已并入上方 `DEFAULTS`（`globalWindowMs` / `globalMaxPerWindow`），
   由 `resolveConfig` 统一补默认值 —— 这里不再另立一份，免得"两处口径"打架。 */


/** 本会话已经过了多少轮（用 `turn/start` 事件数，拿不到就退到当前 turn 号）。 */
export function turnsOf(session, fallbackTurn) {
  const events = session?.snapshotEvents?.();
  if (Array.isArray(events) && events.length > 0) {
    const seen = new Set();
    for (const event of events) if (event?.type === 'turn/start' && Number.isFinite(event.data?.turn)) seen.add(event.data.turn);
    if (seen.size > 0) return seen.size;
  }
  return Number.isFinite(fallbackTurn) ? fallbackTurn : 0;
}
/* -------------------------------------------------------------- 手动入口 */

/** 演练去重指纹：按**消息原文**取短哈希（同一句只演练一次；不引第三方依赖）。 */
export function drillFingerprint(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12);
}

/** 只在**用户消息**里匹配演练关键词（粘贴的日志里出现不算）。 */
/**
 * 去重指纹：**必须带「这条消息自己的标识」**（`data.id`，退而求其次用时间）。
 *
 * ⚠ 2026-09-27 20:37 真机踩的坑：原来只按文本取指纹 —— 他 19:57 打过一句 `#交接`，
 * 20:37 又打了一句一模一样的，**插件一声不吭**（指纹撞了，被当成「这句处理过了」）。
 * 带上消息 id 之后：同一条消息被反复扫到 → 指纹一样（照旧只跑一次）；
 * 两条不同的消息即使一字不差 → 指纹不同（该跑就跑）。
 */
export function messageFingerprint(prefix, entry) {
  const key = entry?.id || (Number.isFinite(entry?.time) ? `t${entry.time}` : '');
  return drillFingerprint(`${prefix}:${entry?.text ?? ''}#${key}`);
}

/**
 * 关键词时间闸（2026-09-27 20:1x 加）：重启清空去重指纹后，快照里**旧关键词会复活**。
 * 修法：`apply` 时记下 `sinceMs`，早于它（留 3 分钟宽限，本机开机要 ~80 秒）的消息不参与判定。
 */
export const KEYWORD_GRACE_MS = 180_000;

export function keywordGate(entries, sinceMs, graceMs = KEYWORD_GRACE_MS) {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return entries;
  return entries.filter((entry) => !Number.isFinite(entry.time) || entry.time >= sinceMs - graceMs);
}

/** 只认「本次运行之后到达」的用户消息（宽限期见 keywordGate）。 */
function userSaidEntriesSinceApply(events) {
  const since = pluginState.sinceMs;
  const entries = userSaidEntries(events);
  if (!Number.isFinite(since) || since <= 0) return entries;
  return keywordGate(entries, since);
}

export function isDrill(session, keyword) {
  const events = session?.snapshotEvents?.() ?? [];
  const said = userSaidEntriesSinceApply(events);
  // 诊断日志已撤（真因确认后）：这条路径读不到"当前这条消息"（见 pluginState.drillPending 的注释），
  // 关键词抓取改在 `user/message` 事件里做；这里只留作后备。
  if (said.length === 0) return false;
  // 放宽成"最近三条里包含关键词"：用户可能前后带空格/标点，或跟别的话一起打。
  const hit = said.slice(-3).filter((entry) => isKeywordLine(entry.text, keyword)).pop();
  if (!hit) return false;
  // ⚠ 2026-09-27 16:1x 修的重复触发 bug：上面读的是**整个快照**，所以同一句 `#交接演练`
  //   只要还挂在"最近三条用户消息"里，**每个 pre-step 都会再跑一遍演练**（每个 pre-step 都会
  //   等 20 秒空闲 + 打一次切换请求）。修法：按消息原文记指纹，同一句只演练一次。
  const fingerprint = messageFingerprint('drill', hit);
  if (pluginState.drilledMessages.has(fingerprint)) return false;
  pluginState.drilledMessages.add(fingerprint);
  return true;
}

/**
 * 按需真交接关键词的**快照后备**（2026-09-27 16:3x 加，真机踩出来的）。
 *
 * 为什么必须有：实时抓取那条路（`user/message` 事件）**在真机上从没验证成功过** ——
 * 她 16:26 亲手打了 `#交接`，日志里**一条抓取记录都没有**；翻历史日志，所有"演练命中"
 * 也都标着"（从快照里认出来的）"，没有一条"消息入流时抓到的"。
 * 所以这里复用演练那条**已被真机证明能命中**的读法：看快照里最近三条用户消息；
 * 命中就按消息原文记指纹，**同一句只交接一次**（去重与实时抓取共用同一个指纹集合）。
 */
export function isLive(session, keyword) {
  const kw = String(keyword ?? '');
  if (kw === '') return false;
  const events = session?.snapshotEvents?.() ?? [];
  const said = userSaidEntriesSinceApply(events);
  if (said.length === 0) return false;
  // 演练关键词优先：演练消息里若同时含真交接关键词，也不算真交接（`#交接演练` 含 `#交接` 那会儿的规矩，现在关键词换成 `换会话` 了、这条继续留着防手滑）。
  const drillKeyword = pluginState.config?.drillKeyword ?? '#交接演练';
  const hit = said.slice(-3).filter((entry) => isKeywordLine(entry.text, kw) && !isKeywordLine(entry.text, drillKeyword)).pop();
  if (!hit) return false;
  const fingerprint = messageFingerprint('live', hit);
  if (pluginState.drilledMessages.has(fingerprint)) return false;
  pluginState.drilledMessages.add(fingerprint);
  return true;
}
