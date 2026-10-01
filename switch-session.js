/**
 * dsh-auto-handoff · 会话切换那一摊（**2026-09-28 从 `dsh-session-switch` 整包搬进来的**）。
 *
 * 为什么搬：她那天说「合插件」—— 这两个插件本来就是一问一答的一对（档案那摊写完了得有人建会话），
 * 却要靠一个 HTTP 调用 + 一个约定文件握手。合并之后：
 *   · 内部握手走**直调** `runSwitch(ctx, payload, log)`（同一条代码路径，不再是网络往返）；
 *   · 四条 HTTP 路由**照旧注册**（`/api/session/switch|pending|ack|health`）——
 *     自检、手工 curl、以及"万一还有别的调用方"都还认它们；
 *   · 状态目录不变：`~/.dsh/session-switch/`（`DSH_SESSION_SWITCH_DIR` 可覆盖）。
 *
 * 原三条不能动的边界，一条没松：
 *  1. 只写自己的 `~/.dsh/session-switch/`，绝不碰用户的记忆档案、也绝不碰 `~/.dsh` 下别人的目录。
 *  2. `GET /api/session/pending` 没有待接时**返回 200 + 空**，绝不 404（客户端每 10 秒轮询一次）。
 *  3. 写任何状态文件都"先写临时文件再 rename"；读状态容忍不存在/空/坏 JSON。
 *
 * ⚠ 搬移口径：**函数体一行没改**，只做了三件结构性的事 ——
 *   ① `apply`/`name`/`inject` 换成 `SWITCH_INJECT` ＋ `registerSwitchRoutes()`（由 auto-handoff 的 apply 调用，
 *      且走**运行时注入**：服务没到齐只让"会话那一摊"缺席，不再像独立包那样整个插件卡 pending）；
 *   ② `makeSwitchHandler` 的核心抽成 `runSwitch()`，HTTP 与直调**共用同一条串行链**（原子段语义不变）；
 *   ③ 自检入口从本文件挪到 `index.js --switch-selftest`，函数本体一行没动。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUDGET_MAX_PER_WINDOW, BUDGET_MAX_RECORDS, BUDGET_WINDOW_MS, MAX_PENDING_AGE_MS, PENDING_FIELDS, SOURCE_COOLDOWN_MS, appendLog, budgetFile, buildPending, checkHandoffGate, errorCode, errorMessage, llmModule, loadCreateUserMessage, logPath, makeLogger, noteHandoff, parseAt, pendingDir, pendingFile, readBudget, readPending, writeBudget, writeFileAtomic, writePending } from './switch-store.js';

/**
 * 造新会话第一条消息要用的 `createUserMessage`。
 *
 * 为什么**不用静态 import**：静态 import 会让"包不在解析路径上"这件事在
 * 模块加载阶段就炸掉，于是 `node index.js --selftest` 连一行都跑不出来
 * （自检的整个意义就是"独立跑也能自证"）。改成首次真正要建消息时再解析，
 * 缺依赖就退化成一条明确错误交给路由返回，而不是整个插件起不来。
 *
 * 运行期这个包一定在：插件由 dsh 通过 profile 的 node_modules 加载，那里有
 * `@deepseek-ai/dsh-llm`（它也是本包的 peerDependency）。
 *
 * @returns {Promise<Function>} 真正用到的 `createUserMessage`。
 */

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/** 不校验 content-type：auto-handoff 用 fetch 发 JSON，但手工 curl 验证时常常忘带 header。 */
async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limitBytes) {
			req.resume();
			return { ok: false, reason: `body 超过 ${limitBytes} 字节` };
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (text === '') return { ok: true, value: {} };
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'body 必须是 JSON 对象' };
		return { ok: true, value };
	} catch (error) {
		return { ok: false, reason: `JSON 解析失败：${errorMessage(error)}` };
	}
}

/** 从请求里取"新会话用什么模型"；调用方给的 provider/model 都为空时返回 undefined（用默认）。 */
function routeOf(body) {
	return {
		provider: typeof body.provider === 'string' ? body.provider : '',
		model: typeof body.model === 'string' ? body.model : '',
	};
}

/** 选择新会话的 provider/model：请求里带了就用请求的，否则用当前部署默认。 */
function modelRouteFor(ctx, route) {
	const current = ctx.agentDefaultModel.currentSelection();
	if (route.provider !== '' && route.model !== '') return { provider: route.provider, model: route.model };
	if (route.provider === '' && route.model === '') return { provider: current.provider, model: current.model };
	// 只给了一半：信明确的那一半，另一半用默认（而不是整条丢掉）。
	return {
		provider: route.provider === '' ? current.provider : route.provider,
		model: route.model === '' ? current.model : route.model,
	};
}

/** 选 agent 预设：请求里指定则用指定的，否则用默认预设。 */
async function resolveAgentPreset(ctx, requested) {
	if (typeof requested === 'string' && requested.trim() !== '') await ctx.agentPresets.resolve(requested);
	return await ctx.agentPresets.resolve();
}

// ---------------------------------------------------------------------------
// 建会话
// ---------------------------------------------------------------------------

/**
 * 建一个新会话并把交接包作为**第一条消息**发进去。
 *
 * `followup` 而不是 `inject`：`inject` 会插进"当前这一步"的上下文，而这是一段
 * 全新对话的开场白，必须是这个新会话的第一条用户消息。
 *
 * 顺序跟官方 `dsh-webhook` 的 `createWebhookSession` 一致，并且同样做了回滚：
 * attach 失败就 dispose 掉半成品会话，避免留下"界面里看不见但占着 id"的鬼会话。
 *
 * @returns {Promise<{ ok: true, sessionId: string, agent: object, title: string } | { ok: false, error: string }>}
 */
async function createSessionForHandoff(ctx, { handoff, cwd, route, agentPreset, permissionPreset, sourceTitle }) {
	// 这几样是"能建会话"的前提。缺任何一个都直接说清楚缺谁：
	// 报 `Cannot read properties of undefined` 等于让人去猜（本机被裁过插件的组合里真的会缺）。
	for (const service of ['agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry']) {
		if (ctx[service] === undefined) throw new Error(`本机没有 ${service} 服务，建不了会话（这个组合里可能没装对应的插件）`);
	}
	const preset = await resolveAgentPreset(ctx, agentPreset);
	const permission = typeof permissionPreset === 'string' && permissionPreset.trim() !== '' ? permissionPreset : ctx.permissionPresets.defaultPreset;
	ctx.permissionPresets.resolve(permission);

	const workspace = await ctx.workspaceRegistry.create(cwd, '会话切换');
	const sessionId = `session-${randomUUID()}`;
	const handle = await ctx.agents.create({
		sessionId,
		meta: { cwd: workspace.path, agentPreset: preset.id },
		agentOptions: { ...modelRouteFor(ctx, route) },
		setup: async (agentCtx) => {
			await ctx.agentPresets.mount(agentCtx, preset.id);
		},
	});

	try {
		await workspace.attachSession(sessionId);
		ctx.permissionPresets.set(handle.agent.session, permission);
		// 新会话沿用**原会话的名字**（她 2026-09-27 定的口径）；拿不到原名才回退「会话交接」。
		const usedTitle = renameSessionTitle(ctx, handle.agent.session, sourceTitle);
		// 必须用 `createUserMessage`：`UserMessage` 还带自动生成的 `id` 和标了来源的
		// `source`，手写 `{role,content}` 会造出一条缺字段的消息，落盘/投影时才炸
		//（官方 dsh-webhook 也是这么建的）。依赖缺失时这里抛出的错会被下面接住、
		// 回滚半成品会话，然后由路由返回明确错误 JSON。
		const createUserMessage = await loadCreateUserMessage();
		handle.agent.followup(createUserMessage({
			content: [{ type: 'text', text: handoff }],
			source: { kind: 'user' },
		}));
		return { ok: true, sessionId, agent: handle.agent, title: usedTitle };
	} catch (error) {
		try {
			await workspace.detachSession(sessionId);
		} catch (rollbackError) {
			// 回滚失败只记日志，不能盖住原始错误（那是真正要诊断的东西）。
			ctx.logger.warn(`session-switch: 回滚 detach 失败 ${errorMessage(rollbackError)}`);
		}
		try {
			await handle.dispose();
		} catch (rollbackError) {
			ctx.logger.warn(`session-switch: 回滚 dispose 失败 ${errorMessage(rollbackError)}`);
		}
		return { ok: false, error: errorMessage(error) };
	}
}

/**
 * 给新建的交接会话起名：**优先沿用原会话的标题**（她 2026-09-27 要求的"新会话名字与原会话一致"）。
 *
 * 三条一起守住：
 *   ① **拿不到原名就回退**「会话交接」（老调用方、对面没传名字时，行为跟以前一模一样）；
 *   ② `rename` 对"归一化之后为空"的标题会抛 `SessionTitleInvalidError`（全空白、或太长被裁空都会），
 *      所以必须 try/catch —— **绝不能让"起名"这一步把整个交接搞失败**（会话已经建好了，为此回滚更亏）；
 *   ③ 失败只写日志，不往上抛。
 *
 * @param {object} ctx 宿主上下文（`sessionTitle` 是本插件的硬依赖，已在 `inject` 里）
 * @param {object} session 刚建好的新会话
 * @param {string} preferredTitle 原会话的标题（可能为空/不合法）
 * @returns {string} 实际用上的标题；两种都没成就是空串
 */
function renameSessionTitle(ctx, session, preferredTitle) {
	const fallback = '会话交接';
	for (const candidate of [preferredTitle, fallback]) {
		if (typeof candidate !== 'string' || candidate.trim() === '') continue;
		try {
			ctx.sessionTitle.rename(session, candidate);
			return candidate.trim();
		} catch (error) {
			ctx.logger?.warn?.(`session-switch: 起名失败（${candidate.slice(0, 24)}）：${errorMessage(error)}`);
		}
	}
	return '';
}

// ---------------------------------------------------------------------------
// 路由处理（拆成小函数：一个函数一个端点，方便直接喂假 req/res 测）
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader('allow', allow);
	res.end();
}

/**
 * 把请求体解析成建会话要的参数。
 * @returns {{ ok: true, value: object } | { ok: false, status: number, error: string }}
 */
function parseSwitchRequest(body) {
	const handoff = typeof body.handoff === 'string' ? body.handoff : '';
	if (handoff.trim() === '') return { ok: false, status: 400, error: 'handoff 不能为空' };
	return {
		ok: true,
		value: {
			handoff,
			cwd: typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd : process.cwd(),
			sourceSession: typeof body.sourceSession === 'string' ? body.sourceSession : '',
			// 原会话的名字：建新会话时沿用（她 2026-09-27 要求"新会话名字与原会话一致"）。
			sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : '',
			route: routeOf(body),
			agentPreset: body.agentPreset,
			permissionPreset: body.permissionPreset,
			seq: body.seq,
		},
	};
}

/**
 * 会话切换的**核心**：HTTP 路由与 auto-handoff 直调走的是**同一条路**。
 *
 * ⚠ 2026-09-27：整段包在 `switchChain` 串行锁里。原因：`checkHandoffGate` 只读、
 * `noteHandoff` 在 `await createSessionForHandoff` **之后**才写盘 —— 两个请求同时进来时，
 * 两边都能看到"还没到上限"，于是都建了会话。事故那天是短时间内涌进上百个请求，
 * 这种竞态会被放大到"闸形同虚设"。串行化之后最坏只是排队慢一点。
 * ⚠ 2026-09-28 合并：链由**直调与 HTTP 共用**（合并前只有 HTTP 那条路有链）。
 */
let switchChain = Promise.resolve();

/**
 * 收下切换请求（直调入口）：建会话 → 发交接包 → 记 pending → 回结果。
 * @returns {Promise<{status:number, payload:object}>} 状态码 + 要回给调用方的 JSON。
 */
export function runSwitch(ctx, rawBody, log) {
	const next = switchChain.then(
		() => doSwitch(ctx, rawBody, log),
		() => doSwitch(ctx, rawBody, log),
	);
	// 链上永远不落拒绝，否则一次失败会把后面所有请求一起带崩。
	switchChain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function doSwitch(ctx, rawBody, log) {
	const parsed = parseSwitchRequest(rawBody);
	if (!parsed.ok) {
		log(`收到切换请求但参数不合法：${parsed.error}`);
		return { status: parsed.status, payload: { ok: false, error: parsed.error } };
	}
	const input = parsed.value;

	// 🛑 刹车（2026-09-27 事故）：先过闸，拒了**绝不建会话**、也不消耗预算。
	const gate = checkHandoffGate(input, log);
	if (!gate.allow) {
		log(`切换被闸住（${gate.reason}）：${gate.error}｜sourceSession=${input.sourceSession || '(空)'}`);
		return { status: gate.status, payload: { ok: false, error: gate.error, reason: gate.reason } };
	}

	log(`收到切换请求：sourceSession=${input.sourceSession || '(空)'} seq=${String(input.seq)} handoff=${input.handoff.length} 字 cwd=${input.cwd}`);

	let made;
	try {
		made = await createSessionForHandoff(ctx, input);
	} catch (error) {
		made = { ok: false, error: errorMessage(error) };
	}

	if (!made.ok) {
		// 建会话失败**不写 pending**：写了等于让客户端切到一个不存在的会话。
		// 调用方（auto-handoff）会自己降级成"把待接写进约定位置"，这是设计好的分工。
		log(`建会话失败（未写 pending，等调用方降级）：${made.error}`);
		return { status: 500, payload: { ok: false, error: `建会话失败：${made.error}` } };
	}
	log(`建会话成功：${made.sessionId}（标题＝${made.title || '（未起名）'}）`);

	const pending = buildPending({
		mode: 'auto',
		seq: input.seq,
		sourceSession: input.sourceSession,
		newSessionId: made.sessionId,
		handoff: input.handoff,
		note: '由 dsh-auto-handoff 的会话那一摊（原 dsh-session-switch）建会话并写入',
	});
	try {
		writePending(pending, undefined, log);
	} catch (error) {
		log(`写 pending 失败（会话已建好，界面可能切不过去）：${errorMessage(error)}`);
	}
	// 🛑 记账放在"会话真的建好之后"：建失败不算一次交接（调用方会降级），不消耗预算。
	noteHandoff(input, undefined, log);
	return { status: 200, payload: { ok: true, pending: { newSessionId: made.sessionId } } };
}

/** HTTP 入口：解析请求体之后走 `runSwitch`（与直调完全同一条路）。 */
export function makeSwitchHandler(ctx, log) {
	return async function handleSwitch(req, res) {
		if (req.method !== 'POST') {
			sendMethodNotAllowed(res, 'POST');
			return;
		}
		const body = await readJsonBody(req);
		if (!body.ok) {
			log(`收到切换请求但 body 不合法：${body.reason}`);
			sendJson(res, 400, { ok: false, error: body.reason });
			return;
		}
		const { status, payload } = await runSwitch(ctx, body.value, log);
		sendJson(res, status, payload);
	};
}

/**
 * 给客户端轮询：**永远 200**。
 * 没有待接时返回空壳而不是 404 —— 客户端是每 10 秒一次的定时轮询，
 * 404 会让浏览器 Console 每隔 10 秒多一条红色报错，真正的错误反而被淹掉。
 */
export function makePendingHandler(log) {
	return function handlePending(req, res) {
		if (req.method !== 'GET') {
			sendMethodNotAllowed(res, 'GET');
			return;
		}
		const { pending, stale } = readPending(undefined, log);
		sendJson(res, 200, {
			ok: true,
			pending,
			empty: pending === null,
			stale,
		});
	};
}

/**
 * 界面切完之后回报，按 `at` 去重。
 * 去重只靠 `at`（而不是"有没有 pending 文件"）：客户端可能重试，重试不该再切一次。
 */
export async function handleAck(req, res, log, ctx) {
	if (req.method !== 'POST') {
		sendMethodNotAllowed(res, 'POST');
		return;
	}
	const body = await readJsonBody(req);
	if (!body.ok) {
		sendJson(res, 400, { ok: false, error: body.reason });
		return;
	}
	const at = typeof body.value.at === 'string' ? body.value.at : '';
	if (at.trim() === '') {
		sendJson(res, 400, { ok: false, error: 'ack 需要 at（就是 pending 里的那个 at）' });
		return;
	}
	const { pending, acked } = readPending(undefined, log);
	if (acked) {
		// 按 `at` 去重：这条已经处理过了（客户端重试、或另一个客户端先 ack 了），不再来一遍。
		log(`收到 ack ${at}：这条已经处理过，去重忽略`);
		sendJson(res, 200, { ok: true, acked: true, duplicate: true, note: '这条 at 已处理过' });
		return;
	}
	if (pending === null) {
		log(`收到 ack ${at}：当前没有待接`);
		sendJson(res, 200, { ok: true, acked: false, note: '没有待接，视为已处理' });
		return;
	}
	if (pending.at !== at) {
		log(`收到 ack ${at}：与当前待接 ${String(pending.at)} 不匹配，不动`);
		sendJson(res, 200, { ok: true, acked: false, note: 'at 不匹配，忽略' });
		return;
	}
	// 归档的是**源**会话（交接完就退场的那一段），不是新建出来的那段。
	// 有活着的客户端时界面多半已经自己归档过；这里失败（例如"源会话本来就没归任何工作区"）
	// 只记日志，不能反过来把 ack 变成错误 —— ack 的语义是"界面已经切过去了"。
	if (typeof pending.sourceSession === 'string' && pending.sourceSession !== '' && ctx.workspaceRegistry !== undefined) {
		try {
			await ctx.workspaceRegistry.archiveSession(pending.sourceSession, { stopActivity: true });
			log(`已归档源会话：${pending.sourceSession}`);
		} catch (error) {
			log(`归档源会话失败（不影响 ack）：${errorMessage(error)}`);
		}
	}
	try {
		// 留一个 handled 标记再落盘：pending 从此读出来是"空"（客户端不会重切），
		// 但 at 还在，重复 ack 能被识别成"这个我已经办过了"。
		writePending({ ...pending, handled: true, handledAt: new Date().toISOString(), note: 'acked' }, undefined, log);
	} catch (error) {
		log(`写 handled 标记失败：${errorMessage(error)}`);
	}
	log(`ack 完成：at=${at}`);
	sendJson(res, 200, { ok: true, acked: true });
}

function makeHealthHandler() {
	return function handleHealth(req, res) {
		if (req.method !== 'GET') {
			sendMethodNotAllowed(res, 'GET');
			return;
		}
		sendJson(res, 200, { ok: true, plugin: 'dsh-auto-handoff', part: 'session-switch', half: 'host', stateDir: pendingDir() });
	};
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 会话那一摊需要的服务（2026-09-25 13:0x 真机事故后定的，别再"精简"它）：
 *
 * 血泪经过：第一版写成 `{ required, optional }` → 插件卡 pending（cordis 的 inject 是**数组**）；
 * 第二版"聪明"了一把，只留 `webServer`、把建会话要的六样留到运行时检查 —— 结果真机上
 * `POST /api/session/switch` 一路报 **`cannot get property "agents" without inject`**
 * （cordis 不允许访问没在 inject 里声明过的服务，运行时那层检查根本轮不到）。
 * → **交接卡在"建不了会话"，她看到的就是"新会话没开起来"。**
 *
 * 教训：**cordis 的注入声明是硬门禁，"运行时再检查"不成立**；要用就写进来。
 * ⚠ 2026-09-28 合并后的做法：这份清单改成由 auto-handoff 的 apply 用
 * **`ctx.inject(SWITCH_INJECT, cb)` 运行时注入** —— 声明仍然是硬门禁（回调里拿得到 `ctx.agents`），
 * 但"缺服务"的后果从"整个插件卡 pending"缩小成"只有会话那一摊缺席"，档案那一摊照常。
 */
export const SWITCH_INJECT = ['connection', 'agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry'];

/** 当前会话那一摊的日志函数（直调 `runSwitch` 时要用；注册路由时初始化）。 */
let switchLogger = null;
/** 注册时那个"服务已就位"的 ctx —— 直调入口要用它（没有它＝服务不齐，直调不成立）。 */
let switchContext = null;

/** 注册四条路由（由 auto-handoff 的 apply 在服务到齐后调用）。 */
/**
 * 把 Node 风格的 `(req, res)` 处理器适配成 `ctx.connection.fetch.register` 要的 `fetch(request) → Response`。
 *
 * 为什么加这一层（2026-09-28 安全修复）：这四条路由原来挂 `ctx.webServer.register({ kind: 'exact' })`，
 * 而宿主的分派顺序是 **exact 优先于 `/api` 前缀** —— 于是它们绕过了宿主给 `/api` 路由加的
 * token ＋ Host/Origin 防线（实测：不带任何凭据 `GET /api/session/health` 就回 200，而 `/api/memory/*` 回 401）。
 * 改走 `connection.fetch` 之后，它们和别的 `/api` 路由一样要过 `requestRejection()` 那两道检查。
 * 处理器本身**一行没改**，这里只做 `Request ⇄ (req, res)` 的形状转换。
 */
function nodeHandlerToFetch(handler) {
	return async function fetchRoute(request) {
		const url = new URL(request.url);
		const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
		const req = {
			method: request.method,
			url: url.pathname + url.search,
			headers: Object.fromEntries(request.headers),
			async *[Symbol.asyncIterator]() {
				if (text !== '') yield Buffer.from(text, 'utf8');
			},
			resume() {},
		};
		const chunks = [];
		let status = 200;
		const headers = {};
		const res = {
			get statusCode() {
				return status;
			},
			set statusCode(code) {
				status = code;
			},
			setHeader(key, value) {
				headers[String(key).toLowerCase()] = String(value);
			},
			writeHead(code, extra) {
				status = code;
				for (const [k, v] of Object.entries(extra ?? {})) res.setHeader(k, v);
			},
			write(chunk) {
				if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
			},
			end(chunk) {
				if (chunk !== undefined && chunk !== null) res.write(chunk);
			},
			on() {},
			once() {},
			removeListener() {},
			emit() {},
		};
		await handler(req, res);
		return new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, { status, headers });
	};
}

export function registerSwitchRoutes(ctx) {
	const log = makeLogger(ctx, undefined);
	switchLogger = log;
	switchContext = ctx;
	log(`apply 进入（stateDir=${pendingDir()}）`);

	ctx.connection.fetch.register({ path: '/api/session/switch', methods: ['POST'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makeSwitchHandler(ctx, log)) });
	log('已注册 POST /api/session/switch');

	ctx.connection.fetch.register({ path: '/api/session/pending', methods: ['GET'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makePendingHandler(log)) });
	log('已注册 GET /api/session/pending');

	ctx.connection.fetch.register({ path: '/api/session/ack', methods: ['POST'], requestBody: 'buffered', fetch: nodeHandlerToFetch((req, res) => handleAck(req, res, log, ctx)) });
	log('已注册 POST /api/session/ack');

	ctx.connection.fetch.register({ path: '/api/session/health', methods: ['GET'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makeHealthHandler()) });
	log('已注册 GET /api/session/health');
	// 卸载/热重载时把这两个模块级引用清掉：别让已销毁的 ctx 被一直攥着（也避免下次直调打到死 ctx）。
	ctx.effect(() => () => {
		switchContext = null;
		switchLogger = null;
	}, 'session-switch: 释放 ctx 引用');
}

/** 给 auto-handoff 的直调用：取当前 log（还没注册过路由时现造一个，只用于写日志）。 */
export function switchLog(ctx) {
	return switchLogger ?? makeLogger(ctx, undefined);
}

/** 会话那一摊是否已就位（七个服务都到齐、路由已注册）。 */
export function switchReady() {
	return switchContext !== null;
}

/**
 * **直调入口**（2026-09-28 合并后 auto-handoff 走这条）：与 HTTP 路由同一条代码路径。
 * @returns {Promise<{status:number, payload:object}>|null} 未就位时返回 null，调用方走 HTTP 兜底。
 */
export function runSwitchDirect(rawBody) {
	if (switchContext === null) return null;
	return runSwitch(switchContext, rawBody, switchLog(switchContext));
}


/* 2026-09-28 拆分：自检口搬去 `switch-session-selftest.js`；这里再导出一次，index.js 的 import 不变。 */
export { runSwitchSelfTest } from './switch-session-selftest.js';
