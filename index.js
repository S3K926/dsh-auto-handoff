/**
 * `dsh-auto-handoff` · Host 半边。
 *
 * 管什么：量上下文占用 → 到阈值就**写真档案**（日记一条 + 状态一节 + 生长记录一行）
 * + 拼交接包 → **请"会话那一摊"接手**切会话（2026-09-28 起它就在本插件里）；叫不动就降级成写一份待接，
 * 让浏览器那半边自己切。
 *
 * 三条来自原版的硬教训，改动前先读：
 * 1. `agent/pre-step` 是 **Scoped<Agent>` 事件** —— 挂在插件根 `ctx` 上收不到，
 *    必须在该 agent 自己的 `agent.ctx` 上挂（这是原版栽了很久的那个坑）。
 * 2. **不自己建会话**：`ctx.agents.create` 那条路已废弃，建/切/归档都是
 *    原本是另一个插件（`dsh-session-switch`）的活，两者只靠一个 HTTP 调用握手；
 *    2026-09-28 合并进本插件，握手改直调、HTTP 只当兜底。
 * 3. 自检口（`--selftest`）**必须放在模块层**：独立跑时 cordis 不调 `apply`，
 *    写在里面就一声不吭（原版第一版就是这么哑的）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot, localStamp, oneLine, processHandoff, renderHandoffPack, setStampOffsetMinutes } from './handoff-core.js';
import { HANDOFF_INSTRUCTION, extractPending, fallbackAssistantMessage, historyForSummary, pluginUserMessage, refineHandoff, summarizeWithModel, withModelPending } from './handoff-summary.js';
import { buildHandoffInput, isKeywordLine, looksLikePastedLog, messageText, toolsUsed, userSaid } from './handoff-material.js';
import { SWITCH_INJECT, registerSwitchRoutes, runSwitchDirect, runSwitchSelfTest, switchReady } from './switch-session.js';
import { GLOBAL_FIRE_LOG_CAP, GLOBAL_MAX_PER_WINDOW, GLOBAL_WINDOW_MS, LOG_CAP, LOG_FILE, __globalCooldownForTest, __isDrillForTest, __isLiveForTest, __resetDrillsForTest, __setLastFiresForTest, __stateForTest, globalCooldown, globalGate, isDrill, isLive, measureRatio, messageFingerprint, noteGlobalFire, pendingView, pluginState, ratioFrom, report, turnsOf, writePending } from './handoff-state.js';

export const name = 'auto-handoff';

/**
 * 声明我们真正要用的服务：**只要 `connection`**（路由靠它注册）。
 *
 * ⚠ 这条被真机打回过两次，别再踩：
 * 1) 第一版**没导出 `inject`** → `ctx.connection` 直接被拒（`cannot get property "connection" without inject`），
 *    五条路由一条都没挂上。自检 62/62 全绿也抓不到——**自检只验逻辑，不验"真实 cordis 里拿不拿得到服务"**。
 * 2) 第二版写成 `{ required: [...], optional: [...] }` → 整个插件卡在
 *    `pending (waiting for services: required, optional)`（cordis 把 `required`/`optional` 当服务名了）。
 *    **本机 cordis 的 inject 是数组**（官方插件都是 `static inject = ['typert', 'connection']` 这种）。
 * 所以：数组、只列真正必须的；可选的运行时用 `ctx.get('x')` 取，取不到就走降级。
 */
export const inject = ['connection'];

/**
 * 配置默认值。**刻意不 import `@deepseek-ai/schemastery` 做 schema**：
 * 那样一来 `node index.js --selftest` 在插件目录里都会因为解析不到包而直接崩
 * （实测 ERR_MODULE_NOT_FOUND），而"自检口要能独立跑"是留在这里的第一条规矩。
 * 于是改成自带默认值 + `resolveConfig()` 手写兜底，**不依赖任何 Harness 包**。
 */
export const DEFAULTS = {
  root: '',
  gatewayBase: 'http://127.0.0.1:3080',
  triggerRatio: 0.65,
  minTurns: 3,
  cooldownMs: 180_000,
  handoffMaxChars: 1200,
  dryRun: true,
  // ⚠ 2026-09-25 事故恢复期默认**关掉自动触发**（手动打 `#交接演练` 仍然可用）。
  // 原因：这个插件挂在 `agent/pre-step` 上，真机验收过一次异常把"每发一条消息"变成
  // 「本轮运行失败」。先让它"只判定、不动作"地观察几轮，确认不再炸再开。
  // ⚠ 2026-09-27 16:3x：她要"自动切会话 + 无缝衔接"，patch 里已改成 true（真写 + 真切）。
  autoTrigger: false,
  // 2026-10-03 加：写交接总结时改用这个模型（留空 = 跟会话用同一个）。
  // 总结不需要会话里那个最强模型的推理能力，用便宜模型能省下一大截。
  // 写法：`'模型名'`（沿用当前 provider）或 `'provider/模型名'`（连 provider 一起换）。
  summaryModel: '',
  // 2026-10-03 加：**即使认得出档案根也照旧跑一次模型总结**。
  // 默认 false：有档案时跳过这次调用（内容已经在档案里，再总结一遍是重复开销）。
  summarizeAlways: false,
  device: '【PC】',
  drillKeyword: '#交接演练',
  // 2026-09-27 16:3x 加的：**按需真交接**的关键词（打一次 = 立刻写真档案 + 切到新会话）。
  // 与 `drillKeyword` 分开：演练只写副本、不动真档案；这个是"我现在就想换会话"的手动入口，
  // 也是唯一能把真交接整条链跑一遍来验收的办法（阈值要等上下文到 65% 才触发）。
  // ⚠ 只在 `user/message` 那一刻抓（不做快照后备）：这是会真写真切的动作，宁可漏一次也不能重复触发。
  // 2026-09-27 20:4x 她改口径：**关键词从 `#交接` 换成 `换会话`**（profile patch 的 liveKeyword 同步改了）。
  liveKeyword: '换会话',
  // 交接包要不要额外用模型写一份"五段式总结"（这一轮在做什么 / 挂着的 / 动过的文件 / 偏好 / 下一步第一件事）。
  // 有档案根时交接包本身只是"指路 + 挂着的"，加上这份总结才算真"无缝衔接"。失败自动退回机械包，不影响交接。
  summarize: false,
  // ⚠ **手机侧专有**（PC 那版没有这一项）：宿主 node 的 TZ 可能是空的（V40 上就是 UTC），
  // 档案的时间口径却是"手机上时间"（= 容器 UTC+8）→ 不补就差 8 小时。PC 侧宿主本地时间
  // 就是墙上时间，默认 0，两边行为一致（这一刀只写在手机 patch 里）。
  timeOffsetHours: 0,
  legacyDevice: '',
  legacyBoundary: '',
  // ⚠ 2026-09-27 交接连锁事故后加的两项：**跨会话**的全局闸（`cooldownMs` 是按会话算的，
  // 挡不住"很多个会话各自合规地触发一次"）。默认：10 分钟内最多自动交接 2 次。
  globalWindowMs: 10 * 60 * 1000,
  globalMaxPerWindow: 2,
};

/** 把 patch 里给的那点配置补齐成完整配置（认不出来的值一律退回默认，不抛）。 */
export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input ?? {}) };
  const numeric = ['triggerRatio', 'minTurns', 'cooldownMs', 'handoffMaxChars', 'timeOffsetHours'];
  for (const key of numeric) if (!Number.isFinite(merged[key])) merged[key] = DEFAULTS[key];
  if (typeof merged.dryRun !== 'boolean') merged.dryRun = DEFAULTS.dryRun;
  if (typeof merged.autoTrigger !== 'boolean') merged.autoTrigger = DEFAULTS.autoTrigger;
  // 全局闸的两项也在这里兜底（patch 里写成字符串/负数时退回默认，不抛）。
  for (const key of ['globalWindowMs', 'globalMaxPerWindow']) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) merged[key] = DEFAULTS[key];
  }
  for (const key of ['root', 'gatewayBase', 'device', 'drillKeyword', 'liveKeyword', 'legacyDevice', 'legacyBoundary']) {
    if (typeof merged[key] !== 'string') merged[key] = DEFAULTS[key];
  }
  if (typeof merged.summarize !== 'boolean') merged.summarize = DEFAULTS.summarize;
  if (typeof merged.summarizeAlways !== 'boolean') merged.summarizeAlways = DEFAULTS.summarizeAlways;
  if (typeof merged.summaryModel !== 'string') merged.summaryModel = DEFAULTS.summaryModel;
  return merged;
}

/** 演练副本根（`config.sandboxRoot`，非配置项、只在本地 patch 里给）。 */
const DRILL_DEVICE = '【演练】';
/** 等空闲的兜底上限：等太久反而像卡住。 */
const IDLE_TIMEOUT_MS = 20_000;
/** 叫会话那一摊的超时（只在"直调不成立、走 HTTP 兜底"时才用得上）：本地服务，3 秒足够。 */
const SWITCH_TIMEOUT_MS = 3_000;
/** 降级落点：会话那一摊的状态目录（`~/.dsh/session-switch/`，`DSH_SESSION_SWITCH_DIR` 可覆盖）。 */
const SWITCH_DIR_ENV = 'DSH_SESSION_SWITCH_DIR';
/** 路由前缀（两条路径各自注册一次；**绝不**靠 pathname 分派）。
 *  另记一笔坑：`requestBody` 的合法值只有 `buffered`/`streaming`，写别的会**静默失败**。 */
const ROUTE_PENDING = '/api/handoff/pending';
const ROUTE_TAKE = '/api/handoff/take';
const ROUTE_ACK = '/api/handoff/ack';
const ROUTE_HEALTH = '/api/handoff/health';
const ROUTE_STATUS = '/api/handoff/status';
/** HTTP 响应的 JSON 头（统一一处，免得两边不一致）。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
/** 诊断日志：放系统临时目录，**不动用户的 profile，也不写任何活环境目录**。 */

/* ---------------------------------------------------------- 触发条件判定 */

/**
 * 该不该自动交接。把四个条件的真假都算出来写日志 —— 原版的经验：
 * **报障时先分清"没触发"的四种可能**（没到阈值 / 轮数不够 / 冷却没过 / 读不到占用）。
 */
function decide(ctx, session, turn, config) {
  const measured = measureRatio(ctx, session);
  if (!measured) {
    return { fire: false, ratio: null, reason: '占用率读不到（投影与 tokenMeter 都没有）→ 不动作' };
  }
  pluginState.lastRatio = measured;
  const enoughTurns = turnsOf(session, turn) >= config.minTurns;
  const cooldownMs = pluginState.lastTrigger.has(String(session?.id)) ? Date.now() - pluginState.lastTrigger.get(String(session?.id)) : Infinity;
  const cooled = cooldownMs >= config.cooldownMs;
  const reached = measured.ratio >= config.triggerRatio;
  const detail = `占用 ${(measured.ratio * 100).toFixed(1)}%（${measured.tokens}/${measured.contextWindow}，基线 ${measured.basis}）`
    + `｜到阈值=${reached}｜轮数够=${enoughTurns}｜冷却已过=${cooled}`;
  if (!reached) return { fire: false, ratio: measured, reason: `${detail} → 不触发` };
  if (!enoughTurns) return { fire: false, ratio: measured, reason: `${detail} → 不触发（会话太短）` };
  if (!cooled) return { fire: false, ratio: measured, reason: `${detail} → 不触发（冷却中）` };
  // ⚠ 2026-09-27 交接连锁事故后加的第二道：上面那三条**都是按单个会话算的**，
  //    160 个会话可以各自"合规地"触发一次 —— 所以这里必须有跨会话的全局冷却。
  const global = globalCooldown();
  if (!global.ok) return { fire: false, ratio: measured, reason: `${detail} → 不触发（${global.reason}）` };
  return { fire: true, ratio: measured, reason: `${detail} → 触发交接（${global.reason}）` };
}


/* -------------------------------------------------------- 收尾（核心入口） */

/**
 * 交接收尾（会话那摊交给"会话那一摊"：原 `dsh-session-switch`，2026-09-28 合并进本插件）。
 *
 * 本插件管**档案**：写真档案的日记/状态/生长记录、拼交接包、记一份"待接"备用。
 * **不再自己建会话** —— 那是"会话那一摊"的活（它建、它切、它归档）。
 * 两者只靠一个 HTTP 调用握手：叫不动时**降级**成把待接写到约定位置，让客户端半边
 * 自己切（所以**两个插件谁单独装都能用**，只是"切会话"这件事的效果不同）。
 *
 * @param {object} session 触发它的会话
 * @param {object} result `processHandoff` 的结果（要有 `handoff`）
 * @param {object} [agent] 触发时的 agent（用来等空闲）
 * @param {'drill'|'live'} [mode] 演练（写副本）/ 真交接（写真档案 + 请 switch 切会话）
 * @param {object} [input] 交给 `processHandoff` 的交接输入（真交接写档案时要用）
 */
export async function finishHandoff(session, result, agent, mode = 'drill', input, ctx) {
  const config = pluginState.config ?? {};
  const live = mode === 'live';
  // 提示文案里要写清"往哪个文件追加日记" —— 路径从配置/环境变量取，**不硬编码任何人的档案根**。
  const promptRoot = config.root || detectRoot(undefined) || '（你的记忆档案根）';

  // ① 等用户这边空闲（她的要求：别在正干活时被切走）；20 秒超时兜底。
  if (agent && typeof agent.whenIdle === 'function') {
    const waited = await Promise.race([
      agent.whenIdle().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), IDLE_TIMEOUT_MS)),
    ]);
    report(waited ? '交接：当前已无进行中的任务（whenIdle）' : `交接：等空闲超时 ${IDLE_TIMEOUT_MS / 1000} 秒，继续（不拖着用户）`);
  }

  // ② 拼"给新会话的第一条消息"：交接包 + （真交接时）让它先补一条日记的提示。
  const message = buildSwitchMessage(result, live, promptRoot);

  // ③ 请"会话那一摊"接手（它建会话、把这段话发进去、让界面切过去、归档原会话）。
  const asked = await askSessionSwitch(session, result, message, ctx);

  // ④ 降级：把完整待接写到**约定位置**，让 switch 的客户端半边（或本插件的客户端）有东西可读。
  if (!asked) writeFallbackPending(session, result, message, live);

  // ⑤ 本插件自己的待接记录（宿主侧路由给客户端轮询）
  const record = writePending(live ? 'auto-live' : 'auto', result, session, pluginState.pendingNewSessionId ?? undefined);

  // ⑥ 真档案**不在这里写**：`runLive` 已经在精修之后**一次性**写完了（见那里的顺序说明）。
  //    旧版在这儿又写一遍，第二遍的 input 变了 → 指纹变了 → 幂等不命中，又拿"第一次读前的基准"
  //    比对已被自己改过的现值 → 被指纹护栏拒写 →「模型那份挂着的」永远进不了 `unfinished`。
  //    2026-09-27 22:50 删掉这一步（`writeRealArchive` 一并删），别再加回来。
  return { asked, record, message };
}

function buildSwitchMessage(result, live, promptRoot) {
  const parts = [result.handoff ?? '（交接包为空）'];
  if (!live) return parts.join('\n');
  const stamp = localStamp();
  parts.push([
    '',
    '【这条是插件自动加的，不是用户打的字】',
    `上一段对话的上下文到阈值了，交接包已经写进档案（生长\\状态.md 顶部、生长\\生长记录.md 末尾、日记.md 末尾各一份，时间 ${stamp.written}）。`,
    `请你在开工前先补一件事：**用你的视角往 \`${join(promptRoot, '日记.md')}\` 追加一条**（形状照文件里既有条目：\`### #N ｜ 日期 ｜ 时间 ｜ 设备 ｜ full\` + 六段），`,
    '并把 `生长\\状态.md` 的 `last_updated` 改成这个时间。序号取文件里 `last_diary_seq` + 1，别猜。',
    '（改档案用 `edit` 或小步写入工具，不用 `write` 整份覆盖。）',
    '写完之后，再继续处理交接包里的「挂着的事」。',
  ].join('\n'));
  return parts.join('\n');
}

/**
 * 读原会话的标题 —— 换会话时**新会话要沿用同一个名字**（她 2026-09-27 定的口径）。
 *
 * 用 `ctx.get('sessionTitle')`（可选服务读法：本机没装标题插件就返回空，不硬 inject），
 * 读不到一律返回空串 —— 起名只是"好看"，绝不能因为它把整条交接链搞崩。
 */
export function readSessionTitle(ctx, session) {
  try {
    const title = ctx?.get?.('sessionTitle')?.get?.(session)?.title;
    return typeof title === 'string' ? title.trim() : '';
  } catch {
    return '';
  }
}

/** 请"会话那一摊"接手；**叫不动不报错**，只如实记一行，让调用方走降级。 */
async function askSessionSwitch(session, result, message, ctx) {
  const config = pluginState.config ?? {};
  const route = session?.requestContext?.();
  // 原会话的名字：对面建新会话时用它命名（拿不到/为空时对面自己回退到「会话交接」）。
  const sourceTitle = readSessionTitle(ctx, session);
  const payload = {
    sourceSession: String(session?.id ?? ''),
    sourceTitle,
    seq: result.seq ?? null,
    handoff: message,
    cwd: session?.header?.cwd ?? '',
    provider: route?.provider ?? '',
    model: route?.model ?? '',
  };
  try {
    if (switchReady()) report('会话切换：直调（同一进程内，不再走 HTTP）');
    // ① 直调（2026-09-28 合并后：会话那一摊就在本插件里）；② 没就位才走 HTTP 兜底。
    const direct = runSwitchDirect(payload);
    const via = direct === null ? 'HTTP' : '直调';
    const response = direct !== null
      ? await direct
      : await fetchJson(`${(config.gatewayBase || 'http://127.0.0.1:3080').replace(/\/+$/, '')}/api/session/switch`, payload);
    // 两条路的返回形状不同（HTTP: {ok,status,body}／直调: {status,payload}）→ 先归一，再走同一份判定。
    const { status, body } = normalizeSwitchResult(response);
    if (status >= 200 && status < 300 && body.ok) {
      pluginState.pendingNewSessionId = body.pending?.newSessionId ?? null;
      report(`已请「会话切换」接手（${via}）：新会话 ${String(pluginState.pendingNewSessionId ?? '').slice(0, 12) || '（由界面新开）'}，交接包 ${message.length} 字`);
      return true;
    }
    // 🛑 429 = 被闸住（预算用完 / 同源冷却）。这是**设计好的拒绝**，不是故障：
    //    如实记一行、返回 false 走降级，**绝不重试**（重试就是把事故又跑一遍）。
    if (status === 429) {
      report(`交接被闸住（${body.reason ?? '429'}）：${body.error ?? '预算/冷却'} → 本次不建新会话`);
      return false;
    }
    report(`「会话切换」没接：${body.error ?? `HTTP ${status}`} → 降级：只记待接，让客户端半边自己切`);
    return false;
  } catch (error) {
    report(`叫不动「会话切换」（${error instanceof Error ? error.message : String(error)}）→ 降级：只记待接`);
    return false;
  }
}

/**
 * 把两条路的返回值**归一成同一种形状**。
 *
 * ⚠ 2026-09-28 第一次真交接踩到的坑：HTTP 那条路回 `{ ok, status, body }`，
 * 而我新加的直调回 `{ status, payload }` —— 判定却只认 `response.body?.ok`，
 * 于是"直调明明 200 成功"被读成失败 → 白走一次降级（日志：`「会话切换」没接：HTTP 200 → 降级`）。
 * 教训：**给同一条判断喂两种形状的返回，就是在等它出错**；这里一次归一，两边都走同一份判定。
 *
 * @param {{status?:number, body?:object, payload?:object}|undefined} response 任一路的返回值
 * @returns {{status:number, body:object}}
 */
export function normalizeSwitchResult(response) {
  const status = Number(response?.status ?? 0);
  const source = response?.body ?? response?.payload ?? {};
  const body = typeof source === 'object' && source !== null ? source : {};
  return { status: Number.isFinite(status) ? status : 0, body };
}

/** 带超时的 POST；任何失败都以异常形式交给调用方决定降级。 */
async function fetchJson(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SWITCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 降级落点：`~/.dsh/session-switch/pending.json`（可用 DSH_SESSION_SWITCH_DIR 覆盖）。 */
function writeFallbackPending(session, result, message, live) {
  try {
    const dir = process.env[SWITCH_DIR_ENV] || join(homedir(), '.dsh', 'session-switch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      mode: live ? 'auto-live' : 'auto',
      seq: result.seq ?? null,
      sourceSession: String(session?.id ?? ''),
      newSessionId: pluginState.pendingNewSessionId ?? null,
      handoff: message,
      handoffChars: message.length,
      note: '由 dsh-auto-handoff 降级写入（会话那一摊没就位或叫不动时）',
    }, null, 2)}\n`, 'utf8');
    report(`降级：待接已写到 ${join(dir, 'pending.json')}（${message.length} 字）`);
  } catch (error) {
    report(`降级写待接也失败了（不影响交接本身）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------------------ 触发 */

/** 预步判定：先看演练关键词，再看占用率。任何一步失败都只报不抛。 */
async function handlePreStep(payload = {}, ctx) {
  const config = pluginState.config ?? {};
  const agent = payload?.agent;
  const session = payload?.session ?? agent?.session;
  if (!session) return;
  pluginState.sessionId = String(session.id ?? '');
  try {
    // 演练优先：标记来自 `user/message` 事件（pre-step 跑在消息入流之前，这里读不到当前这条）。
    const drill = pluginState.drillPending;
    if (drill && Date.now() - drill.at < 120_000) {
      pluginState.drillPending = null;
      report(`命中演练关键词「${config.drillKeyword}」（消息入流时抓到的${drill.text ? `：「${drill.text}」` : ''}）：只写演练区副本，真档案一个字节不碰`);
      await runDrill(session, agent, config, ctx);
      return;
    }
    if (isDrill(session, config.drillKeyword)) {
      report(`命中演练关键词「${config.drillKeyword}」（从快照里认出来的）：只写演练区副本，真档案一个字节不碰`);
      await runDrill(session, agent, config, ctx);
      return;
    }
    // 按需真交接（现口径 `换会话`）：跟阈值无关，她打一次就真写真档案 + 切会话。
    // 两条路都认：①实时抓取（`user/message`，尚未在真机验证成功）②快照后备（已证明能命中）。
    const live = pluginState.livePending;
    if (live && Date.now() - live.at < 120_000) {
      pluginState.livePending = null;
      report(`命中真交接关键词「${config.liveKeyword ?? ''}」（消息入流时抓到的）：写真档案 + 请会话切换接手`);
      await runLive(session, agent, config, ctx);
      return;
    }
    if (isLive(session, config.liveKeyword)) {
      report(`命中真交接关键词「${config.liveKeyword ?? ''}」（从快照里认出来的）：写真档案 + 请会话切换接手`);
      await runLive(session, agent, config, ctx);
      return;
    }
    const verdict = decide(ctx, session, payload?.turn, config);
    pluginState.lastDecision = verdict.reason;
    report(`交接判定：${verdict.reason}`);
    if (!verdict.fire) return;
    // 事故恢复期：判定照记，自动动作关着（默认 autoTrigger=false）。要开就改 patch 里的 config。
    if (config.autoTrigger === false) {
      report('自动触发当前是关的（autoTrigger=false）：只判定不动作。想开改 patch 里的 config');
      return;
    }
    await runLive(session, agent, config, ctx);
  } catch (error) {
    report(`预步交接失败（不拦对话）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 真交接：写真档案 + 请 switch 切会话。 */
async function runLive(session, agent, config, ctx) {
  const input = buildHandoffInput(session);
  const root = config.root || detectRoot(undefined);
  if (!root) {
    report('真交接：没认到档案根 → 不动档案（可能没配 root/DSH_MEMORY_ROOT）');
    return;
  }
  // 首启默认 dryRun：只把"本来会写什么"记日志，一个字节都不写（方案里的安全默认）。
  if (config.dryRun) {
    const preview = await processHandoff({
      root, input, config, sessionId: String(session.id ?? ''), device: config.device ?? '【PC】', dryRun: true,
    });
    report(`dryRun=true：本来会写 日记 #${preview.seq}（${preview.preview?.diaryChars ?? 0} 字）、节「${oneLine(preview.preview?.stateSection)}」、交接包 ${preview.handoffChars} 字 → 没写`);
    return;
  }
  // ⚙ 精修交接包（见 refineHandoff 注释）：有记忆 → 指路 + 挂着的；没记忆 → 模型总结。
  // ⚠ 顺序（2026-09-27 22:50 修，别改回去）：**先精修、再一次性写档案**。
  //   旧版是先写真档案、精修完再拿 `withModelPending` 写第二遍；第二遍的 input 变了 → 指纹变了 →
  //   幂等不命中，又拿"第一次读前的基准"比对已被自己改过的现值 → 被指纹护栏拒写（22:40 日志那条
  //   `真交接写真档案失败（外部改动拒写）` 就是它），于是「模型那份挂着的」永远进不了 `unfinished`。
  //   现在 pending 在**第一次也是唯一一次**写盘之前就并进 input：档案与交接包一次到位。
  const draft = renderHandoffPack(input, config.handoffMaxChars ?? 1200);
  const refinedLive = await refineHandoff(ctx, session, draft, root, config);
  const result = await processHandoff({
    root,
    input: withModelPending(input, refinedLive), // 取不到模型那份就原样返回（两条都留着，别删）
    config,
    sessionId: String(session.id ?? ''),
    mode: 'live',
    device: config.device ?? '【PC】',
    now: new Date(),
  });
  pluginState.lastTrigger.set(String(session.id ?? ''), Date.now());
  noteGlobalFire(); // ⚠ 只有走到这里（真写档案）才算一次交接，dryRun 与"只是判定"都不计
  report(`交接完成：${result.skipped ? `跳过（${result.reason}）` : `日记 #${result.seq}、状态一节、生长记录一行、交接包 ${result.handoffChars} 字`}`);
  if (refinedLive && refinedLive !== result.handoff) {
    result.handoff = refinedLive;   // 发出去的那份是精修后的；档案里那节仍嵌机械版（保持既有形状）
    result.handoffChars = refinedLive.length;
    report(`交接包已精修：${refinedLive.length} 字`);
  }
  await finishHandoff(session, result, agent, 'live', input, ctx);
}

/** 演练：只写副本根；没配副本就只算不写。 */
async function runDrill(session, agent, config, ctx) {
  const sandbox = config.sandboxRoot;
  const input = buildHandoffInput(session);
  if (!sandbox) {
    report('演练：没配 sandboxRoot → 只做一次干跑，真档案与副本都没动');
    const dry = await processHandoff({ root: config.root || detectRoot(undefined), input, config, dryRun: true });
    report(`演练干跑：会写 日记 #${dry.seq}、交接包 ${dry.handoffChars} 字`);
    return;
  }
  const real = config.root || detectRoot(undefined);
  if (real && sandbox.startsWith(real)) {
    // 硬拦：副本不能落在真档案里面（那样"演练"就是真写）。
    report(`演练拒绝：sandboxRoot 落在真档案根里（${sandbox} ⊂ ${real}）`);
    return;
  }
  const result = await processHandoff({
    root: sandbox, input, config, sessionId: String(session.id ?? ''), mode: 'drill', device: DRILL_DEVICE, now: new Date(),
  });
  report(`演练完成：${result.skipped ? `跳过（${result.reason}）` : `副本写了日记 #${result.seq}、状态一节、生长记录一行（真档案没动）`}`);
  // 演练也精修（"有记忆"按真档案根判断）：跑完整链路时就该看到新会话拿到的那份到底长什么样。
  const refinedDrill = await refineHandoff(ctx, session, result.handoff, config.root || detectRoot(undefined), config);
  if (refinedDrill && refinedDrill !== result.handoff) {
    result.handoff = refinedDrill;
    result.handoffChars = refinedDrill.length;
    report(`演练交接包已精修：${refinedDrill.length} 字`);
  }
  await finishHandoff(session, result, agent, 'drill', withModelPending(input, result.handoff), ctx);
}

/* ------------------------------------------------------------------ 路由 */

/** 装配 Host 半边：路由 + 两个事件监听。所有注册都挂在 `ctx.effect` 上，卸载即撤。 */
export function apply(ctx, config = {}) {
  pluginState.config = resolveConfig(config);
  // 手机侧专有：宿主 TZ 可能是空的（=UTC），档案要的是手机本地时间（见 handoff-core 的注释）。
  setStampOffsetMinutes((pluginState.config.timeOffsetHours ?? 0) * 60);
  // 记下这次加载的时刻：关键词判定只认「本次运行之后到达」的消息（见 handoff-state 的 keywordGate）。
  pluginState.sinceMs = Date.now();
  report(`apply 已进入：真写=${config.dryRun ? 'off(dryRun)' : 'on'} 阈值=${((config.triggerRatio ?? 0.65) * 100).toFixed(0)}% 冷却=${(config.cooldownMs ?? 180_000) / 1000}s 档案根=${config.root || detectRoot(undefined) || '（未配）'} gateway=${config.gatewayBase || '（默认）'} live=${config.liveKeyword ?? ''} 自动=${config.autoTrigger === false ? 'off' : 'on'} 时差=${config.timeOffsetHours ?? 0}h`);
  registerRoutes(ctx);
  // 会话那一摊（2026-09-28 从 `dsh-session-switch` 合并进来的）：建会话 → 发交接包 → 写 pending → 切界面。
  // 用**运行时注入**等它那七个服务：缺谁就只让这一摊缺席（档案那一摊照常），不再像独立包那样整个插件卡 pending。
  // 2026-09-28 09:15（新会话 d286）：**先探测再调**。原来是"先 try 再换路"——本机有些上下文
  // （沙盘演练／早期加载）根本没有 `ctx.inject`，于是每次都先把 `ctx.inject is not a function`
  // 当成"注入失败"打一行噪音，再落回同一个结果（会话那一摊缺席）。改成先看一眼类型：
  // 不是函数就明确说"跳过"，是函数才走运行时注入 —— 行为不变，只是不再制造假失败。
  if (typeof ctx.inject !== 'function') {
    report('会话那一摊：本机 ctx.inject 不可用，跳过运行时注入（档案那一摊不受影响）');
  } else {
    try {
      ctx.inject(SWITCH_INJECT, (scope) => {
        try {
          registerSwitchRoutes(scope);
          report('会话那一摊已就位（原 dsh-session-switch）：四条路由就位，握手改走直调');
        } catch (error) {
          report(`会话那一摊注册失败（不影响档案交接）：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } catch (error) {
      report(`会话那一摊注入抛错（不影响档案交接）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // ⚠ 2026-09-25 12:3x 真机事故（第二次）的真因就在这两行：
  // `agent/pre-step` 是 **waterfall 事件** —— 监听器拿到 `({ agent, signal }, next)`，
  // **收工前必须 `return next()` 把瀑布传下去**。原版把监听器挂在该 agent 自己的 ctx 上、
  // 且从不调用 `next()`，于是 dsh 推进到下一环时拿到 undefined → 每轮都报
  // `Cannot read properties of undefined (reading 'kind')`（用户的"本轮运行失败"）。
  // 参照官方 `dsh-compaction-basic` 的写法（它就是这么挂、最后 `return next()`）。
  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        if (!signal?.aborted) await handlePreStep({ agent }, ctx);
      } catch (error) {
        report(`预步交接失败（不拦对话）：${error instanceof Error ? error.message : String(error)}`);
      }
      return next(); // 绝不能少：少了下游就拿不到 payload
    });
    return () => off?.();
  });

  // 演练关键词在**消息入流那一刻**抓（真机时序：turn/start → inbox/spliced → step/start → user/message，
  // pre-step 跑在 user/message 之前，所以在 pre-step 里读快照永远看不到当前这条 —— 2026-09-25 12:46 实测）。
  ctx.effect(() => {
    const off = ctx.on('user/message', (payload) => {
      try {
        const data = payload?.data ?? payload ?? {};
        const text = messageText({ content: data.content ?? payload?.content });
        // 2026-09-27 16:3x 加的诊断：把"这条事件到底有没有到、文本取到没有"记下来。
        // 起因：她亲手打 `#交接`，日志里一条抓取记录都没有 —— 是事件没到、还是文本取空了，
        // 光看"没抓到关键词"分不出来。以后读日志一眼就能定性（每条用户消息一行，很便宜）。
        report(`user/message 到达：text=${text.length}字｜payload键=${Object.keys(payload ?? {}).join('|')}｜data键=${Object.keys(data ?? {}).join('|')}`);
        const keyword = pluginState.config?.drillKeyword ?? '#交接演练';
        // 指纹统一按「文本＋消息自己的 id」取（同一条只认一次；两条一字不差的消息各算各的）。
        const stamp = { text, id: String(data.id ?? ''), time: Number(payload?.time) };
        if (isKeywordLine(text, keyword)) {
          // 同一句消息在这里就登记指纹：这样后面 `isDrill` 的后备路径不会把同一条再演练一次。
          const fingerprint = messageFingerprint('drill', stamp);
          if (!pluginState.drilledMessages.has(fingerprint)) {
            pluginState.drilledMessages.add(fingerprint);
            pluginState.drillPending = { at: Date.now(), text: String(oneLine(text)).slice(0, 80), fingerprint };
            report(`演练关键词抓到：「${String(oneLine(text)).slice(0, 40)}」→ 等下一次 pre-step 消费`);
          }
          return;
        }
        // 真交接关键词（现口径 `换会话`）：**演练优先**（演练词只要落在同一条消息里，就不算真交接）。
        const liveKeyword = pluginState.config?.liveKeyword ?? '';
        if (isKeywordLine(text, liveKeyword)) {
          const fingerprint = messageFingerprint('live', stamp);
          if (!pluginState.drilledMessages.has(fingerprint)) {
            pluginState.drilledMessages.add(fingerprint);
            pluginState.livePending = { at: Date.now(), text: String(oneLine(text)).slice(0, 80), fingerprint };
            report(`真交接关键词「${liveKeyword}」抓到：${String(oneLine(text)).slice(0, 40)} → 等下一次 pre-step 消费（会写真档案 + 切会话）`);
          }
        }
      } catch (error) {
        report(`抓演练关键词失败（不影响对话）：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return () => off?.();
  });
  return { pending: () => pluginState };
}

/** 五条路由各注册一次（不靠 pathname 分派）；`requestBody` 只能是 buffered。 */
function registerRoutes(ctx) {
  const routes = [
    [ROUTE_PENDING, ['GET'], () => Response.json(pendingView(), { headers: JSON_HEADERS })],
    [ROUTE_TAKE, ['GET', 'POST'], () => Response.json(pendingView(), { headers: JSON_HEADERS })],
    [ROUTE_ACK, ['POST'], (request) => handleAck(request)],
    [ROUTE_HEALTH, ['GET'], () => Response.json(health(), { headers: JSON_HEADERS })],
    [ROUTE_STATUS, ['GET'], () => Response.json(statusView(), { headers: JSON_HEADERS })],
  ];
  for (const [path, methods, handler] of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request);
        } catch (error) {
          report(`路由 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: JSON_HEADERS });
        }
      },
    }));
  }
}

/** 客户端切完回报：只用来把待接标记成"已处理"，不改档案。 */
async function handleAck(request) {
  const body = await request.json().catch(() => ({}));
  const at = body?.at ?? pluginState.pending?.at ?? null;
  if (!pluginState.pending) return Response.json({ ok: false, error: '没有待接' }, { status: 409, headers: JSON_HEADERS });
  if (at && pluginState.pending.at !== at) {
    return Response.json({ ok: false, error: '待接已换了一份（ack 的是旧的）', current: pluginState.pending.at }, { headers: JSON_HEADERS });
  }
  pluginState.pending.handledAt = new Date().toISOString();
  pluginState.pending.handledBy = String(body?.sessionId ?? '');
  report(`客户端回报已切到 ${pluginState.pending.handledBy || '（未知会话）'}（sourceSession=${pluginState.pending.sourceSession}）`);
  return Response.json({ ok: true, at: pluginState.pending.at }, { headers: JSON_HEADERS });
}

/** 自检口：不碰档案，只回答"配置与管道活着吗"。 */
function health() {
  const config = pluginState.config ?? {};
  return {
    ok: true,
    plugin: name,
    dryRun: Boolean(config.dryRun),
    triggerRatio: config.triggerRatio ?? 0.65,
    minTurns: config.minTurns ?? 3,
    cooldownMs: config.cooldownMs ?? 180_000,
    handoffMaxChars: config.handoffMaxChars ?? 1200,
    device: config.device ?? '',
    legacyDevice: config.legacyDevice ?? '',
    legacyBoundary: config.legacyBoundary ?? '',
    root: config.root || detectRoot(undefined) || '',
    gatewayBase: config.gatewayBase || 'http://127.0.0.1:3080',
    drill: { keyword: config.drillKeyword ?? '#交接演练', sandboxRoot: config.sandboxRoot ? '（已配）' : '' },
  };
}

/** 状态：给面板/排查看"现在到哪了"。 */
function statusView() {
  return {
    ok: true,
    pending: pluginState.pending ? { at: pluginState.pending.at, seq: pluginState.pending.seq, sourceSession: pluginState.pending.sourceSession, newSessionId: pluginState.pending.newSessionId, handoffChars: pluginState.pending.handoffChars, handledAt: pluginState.pending.handledAt ?? null } : null,
    lastRatio: pluginState.lastRatio,
    lastDecision: pluginState.lastDecision,
    logFile: LOG_FILE,
    logs: pluginState.logs.slice(-20),
  };
}

/* ------------------------------------------------- 模块层自检口（不许进 apply） */

/**
 * 全局闸自己的入口：`node index.js --gatetest`
 *
 * 为什么单独开一个而不是塞进 sandbox 那 62 项：那个 run 会造一份假档案、验的是
 * "写档案"那一摊；全局冷静期是**纯内存判定**（不碰磁盘），放这里验最短最清楚。
 */
function runGateTest() {
  const checks = [];
  const check = (label, pass, detail = '') => {
    checks.push({ label, pass });
    // eslint-disable-next-line no-console
    // [自检口] console.log(`${pass ? '✓' : '✗'} ${label}${detail === '' ? '' : `  → ${detail}`}`);
  };

  pluginState.config = resolveConfig({});

  // ① 空记录 → 放行
  __setLastFiresForTest([]);
  const empty = __globalCooldownForTest();
  check('① 一次都没交接时放行', empty.ok === true && empty.used === 0, empty.reason);

  // ② 到量 → 拦（默认 10 分钟 2 次）
  __setLastFiresForTest([Date.now() - 60_000, Date.now() - 30_000]);
  const atCap = __globalCooldownForTest();
  check('② 窗口内到量（2/2）就拦下来', atCap.ok === false && atCap.used === 2, atCap.reason);

  // ③ 时间往前推 11 分钟：那两条都出窗 → 放行（证明"会自己恢复"，不是永久刹车）
  const after = __globalCooldownForTest(Date.now() + 11 * 60 * 1000);
  check('③ 窗口滑过去之后自动放行（不是永久刹车）', after.ok === true, after.reason);

  // ④ 配置被写坏（字符串/0）→ 退回默认，不抛
  pluginState.config = resolveConfig({ globalWindowMs: 'x', globalMaxPerWindow: 0 });
  const fallback = globalGate();
  check('④ 闸参数写坏时退回默认（10 分钟 / 2 次）', fallback.windowMs === 10 * 60 * 1000 && fallback.max === 2, `windowMs=${fallback.windowMs} max=${fallback.max}`);
  pluginState.config = resolveConfig({});

  // ⑤⑥ 演练去重（2026-09-27 16:1x 修的真 bug）：同一句 `#交接演练` 挂在"最近三条"里时，
  //     以前**每个 pre-step 都会重跑一遍演练**（各等 20 秒 + 各打一次切换请求）。
  __resetDrillsForTest();
  const drillEvents = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '先看看这个' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '#交接演练' }] } },
  ];
  const first = __isDrillForTest(drillEvents, '#交接演练');
  const second = __isDrillForTest(drillEvents, '#交接演练');
  const third = __isDrillForTest(drillEvents, '#交接演练');
  check('⑤ 同一句演练关键词只触发一次（不再每个 pre-step 重跑）', first === true && second === false && third === false, `1=${first} 2=${second} 3=${third}`);
  // ⑥ 去重不是"把功能关掉"：清掉去重记录之后，同一句照样能再演练一次。
  //    ⚠ 原来这条是"再造一句**句中**带关键词的新消息"，但 2026-09-27 21:4x 把口径收成**整行独占**之后，
  //    "新的句子 + 整行等于关键词"在语义上不存在（内容必然相同 → 指纹相同 → 被去重挡）——
  //    所以改成验"去重是可清的"，新口径另立一条 ⑦。
  __resetDrillsForTest();
  const fresh = __isDrillForTest(drillEvents, '#交接演练');
  check('⑥ 清掉去重记录后同一句还能再演练（去重不是把功能关掉）', fresh === true);
  // ⑦ 新口径：**句中**含关键词不再算（要整行独占）—— 2026-09-27 21:30 真机踩的坑。
  __resetDrillsForTest();
  const midSentence = __isDrillForTest(
    [{ type: 'user/message', data: { content: [{ type: 'text', text: '再演一次 #交接演练' }] } }],
    '#交接演练',
  );
  check('⑦ 句中含关键词不再演练（整行独占的新口径）', midSentence === false);
  __resetDrillsForTest();

  const failed = checks.filter((c) => !c.pass).length;
  // eslint-disable-next-line no-console
  // [自检口] console.log(`\n全局闸自检：${checks.length - failed}/${checks.length} 项通过`);
  return { passed: checks.length - failed, total: checks.length, failed: checks.filter((c) => !c.pass).map((c) => c.label) };
}

/**
 * `node index.js --selftest` / `--writetest`：在**临时目录**里造一份假档案，
 * 逐项验认根、六段式、限长、幂等、备份、指纹拒写。
 *
 * 位置很要紧：独立跑 `node index.js` 时 cordis 不会调 `apply`，所以自检口必须在
 * **模块层** —— 原版第一版写进 `apply` 里，结果一声不吭。
 */
async function runSelftest() {
  const { run } = await import('./test-handoff-sandbox.mjs');
  return run({ verbose: true });
}

if (process.argv.includes('--gatetest')) {
  const gate = runGateTest();
  // 2026-09-27 补：失败时要说清**是哪一条**失败 —— 原来只给退出码，排障得靠猜。
  // eslint-disable-next-line no-console
  console.log(`全局闸自检：${gate.passed}/${gate.total} 项通过${gate.failed.length ? `，失败：${gate.failed.join('、')}` : ''}`);
  process.exitCode = gate.failed.length === 0 ? 0 : 1;
}

if (process.argv.includes('--selftest') || process.argv.includes('--writetest')) {
  runSelftest().then(
    (summary) => {
      // eslint-disable-next-line no-console
      console.log(`自检结束：${summary.passed}/${summary.total} 项通过${summary.failed.length ? `，失败 ${summary.failed.join('、')}` : ''}`);
      process.exitCode = summary.failed.length === 0 ? 0 : 1;
    },
    (error) => {
      // eslint-disable-next-line no-console
      console.error(`自检崩了：${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 1;
    },
  );
}

// 自检口二：会话那一摊（2026-09-28 从 dsh-session-switch 搬来；函数体一行没动）。
// 跑法：`DSH_SESSION_SWITCH_DIR=/tmp/ss-selftest node index.js --switch-selftest`
// （它拒绝在真实 ~/.dsh 里跑，所以**必须**给临时目录。）
if (process.argv.includes('--switch-selftest')) {
  runSwitchSelfTest().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // eslint-disable-next-line no-console
      console.error(`会话切换自检崩了：${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 1;
    },
  );
}

// 导出给沙盘脚本/别的插件用的小工具（口径与 core 保持一处）。
export { detectRoot, localStamp, oneLine, processHandoff };
