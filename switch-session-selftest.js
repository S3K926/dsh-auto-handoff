/**
 * dsh-auto-handoff · 会话切换自检口（2026-09-28 从 `switch-session.js` 拆出来的一层）
 *
 * 只搬不改：**自检用例一行没动**。拆的动机同上（800 行线）——自检占掉 switch-session
 * 最后三分之一，而它天生只在命令行跑，跟路由逻辑不是一类的。
 * 跑法（不给临时目录它会拒绝跑，见下面 ①）：
 *   DSH_SESSION_SWITCH_DIR=/tmp/ss-selftest node index.js --switch-selftest
 * 对外接口不变 —— `switch-session.js` 末尾再导出 `runSwitchSelfTest`，`index.js` 不用改。
 */
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	BUDGET_MAX_PER_WINDOW, appendLog, budgetFile, buildPending, errorMessage, logPath, pendingFile,
	readBudget, readPending, writePending,
} from './switch-store.js';
import { handleAck, makePendingHandler, makeSwitchHandler } from './switch-session.js';

// ---------------------------------------------------------------------------
// 自检（模块层）
//
// **必须在这里，不能放进 apply()**：原版第一版把自检写在 apply 里，独立跑
// `node index.js --selftest` 时 cordis 根本不会调 apply，脚本一声不吭地退出，
// 看起来"通过了"，实际什么都没测。
// ---------------------------------------------------------------------------

/** 构造一个假的 res，把状态码/JSON 收集下来给自检断言用。 */
function fakeResponse() {
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k] = v;
		},
		end(text) {
			this.body = text ?? '';
		},
		json() {
			return this.body === '' ? null : JSON.parse(this.body);
		},
	};
	return res;
}

/** 把一段字符串包成异步可迭代的请求体。 */
function fakeRequest({ method = 'GET', body }) {
	const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	return {
		method,
		headers: { 'content-type': 'application/json' },
		async *[Symbol.asyncIterator]() {
			if (text !== '') yield Buffer.from(text, 'utf8');
		},
		resume() {},
	};
}

/** 自检用的假 ctx：够跑通路由，且**绝不**真的建会话。 */
function fakeContext({ failCreate }) {
	const warnings = [];
	const session = { id: 'session-fake' };
	return {
		warnings,
		logger: { info() {}, warn: (line) => warnings.push(line) },
		agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
		agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => ({}) },
		permissionPresets: { defaultPreset: 'workspace-write', resolve: () => ({}), set: () => {} },
		workspaceRegistry: {
			create: async (path) => {
				if (failCreate !== undefined) throw new Error(failCreate);
				return { path, attachSession: async () => {}, detachSession: async () => {} };
			},
			archiveSession: async () => {},
		},
		// 记下每次起名：⑮ 要验"新会话沿用原会话的名字"。
		sessionTitle: {
			renamed: [],
			rename(session, title) {
				this.renamed.push({ session, title });
			},
		},
		agents: {
			create: async () => ({ agent: { session, followup: () => {} }, dispose: async () => {} }),
		},
	};
}

// ⚠ 2026-09-28：【V40】把原先被注释成「[自检口]」的打印**全部恢复**了。
//   原因：注释掉之后 `node index.js --selftest` 只返回退出码（没设 DSH_SESSION_SWITCH_DIR 时
//   静默 return 1），看起来像"自检坏了"，实际是"自检没跑"。跑法：
//     DSH_SESSION_SWITCH_DIR=/tmp/ss-selftest node index.js --selftest
//   （它拒绝在真实 ~/.dsh 里跑，所以必须给临时目录。）
export async function runSwitchSelfTest() {
	const override = process.env.DSH_SESSION_SWITCH_DIR;
	if (typeof override !== 'string' || override.trim() === '') {
		console.error('✗ 自检必须显式指定 DSH_SESSION_SWITCH_DIR（指向临时目录）；本插件绝不往真实的 ~/.dsh 里写测试数据。');
		return 1;
	}
	const dir = resolve(override.trim());
	// 双保险：就算环境变量指到了真家里，也在写任何东西之前掉头。
	const liveHome = join(homedir(), '.dsh');
	if (resolve(liveHome) === dir || dir.startsWith(`${resolve(liveHome)}\\`) || dir.startsWith(`${resolve(liveHome)}/`)) {
		console.error(`✗ 拒绝在真实 DSH 家目录里自检：${dir}`);
		return 1;
	}
	try {
		realpathSync.native(dir);
	} catch {
		// 目录还不存在：正常，第一次写的时候会 mkdir。
	}

	const results = [];
	const check = (label, pass, detail = '') => {
		results.push({ label, pass, detail });
		console.log(`${pass ? '✓' : '✗'} ${label}${detail === '' ? '' : `  → ${detail}`}`);
	};
	const log = (line) => {
		appendLog(`session-switch: ${line}`, dir);
	};
	const file = pendingFile(dir);
	const logFile = logPath(dir);

	console.log(`自检目录：${dir}\n`);

	// ① pending.json 不存在时读待接 = 空，而不是报错
	const missing = readPending(dir, log);
	check('① pending.json 不存在时读出来是"空"（不报错）', missing.pending === null && missing.stale === false, `pending=${JSON.stringify(missing.pending)}`);

	// ② 写一条待接后能读出来
	const written = writePending(
		buildPending({ at: new Date().toISOString(), mode: 'auto', seq: 48, sourceSession: 'session-src', newSessionId: 'session-dst', handoff: '交接包内容', note: 'selftest' }),
		dir,
		log,
	);
	const readBack = readPending(dir, log).pending;
	check(
		'② 写一条待接后能读出来（字段齐、handoffChars 算得对）',
		readBack !== null && readBack.newSessionId === 'session-dst' && readBack.seq === 48 && readBack.handoffChars === written.handoffChars,
		`newSessionId=${String(readBack?.newSessionId)} seq=${String(readBack?.seq)} handoffChars=${String(readBack?.handoffChars)}`,
	);

	// ③ ack 后不再重复返回（pending 读出来是空，且第二次 ack 被按 at 去重）
	const ctx = fakeContext({});
	const ackRes = fakeResponse();
	await handleAck(fakeRequest({ method: 'POST', body: { at: written.at } }), ackRes, log, ctx);
	const afterAck = readPending(dir, log);
	check('③ ack 后不再重复返回（待接读出来是空）', ackRes.statusCode === 200 && ackRes.json()?.acked === true && afterAck.pending === null, `HTTP ${ackRes.statusCode} pending=${JSON.stringify(afterAck.pending)}`);
	const ackAgain = fakeResponse();
	await handleAck(fakeRequest({ method: 'POST', body: { at: written.at } }), ackAgain, log, ctx);
	const ackAgainBody = ackAgain.json();
	check('③b 重复 ack 按 at 去重（acked=true, duplicate=true）', ackAgain.statusCode === 200 && ackAgainBody?.duplicate === true, `HTTP ${ackAgain.statusCode} ${JSON.stringify(ackAgainBody)}`);
	const pendingAfterAck = fakeResponse();
	makePendingHandler(log)(fakeRequest({ method: 'GET' }), pendingAfterAck);
	check('③c ack 之后 GET /pending 返回空', pendingAfterAck.json()?.empty === true, JSON.stringify(pendingAfterAck.json()));

	// ④ 坏 JSON 不崩
	writeFileSync(file, '{ 这不是 JSON', 'utf8');
	const broken = readPending(dir, log);
	const logText1 = readFileSync(logFile, 'utf8');
	check('④ 坏 JSON 不崩、当空处理、并记了一行日志', broken.pending === null && logText1.includes('JSON 解析失败'), `pending=${JSON.stringify(broken.pending)}`);

	// ⑤ 超过 2 小时的旧待接被跳过并记日志
	const oldAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	writePending(buildPending({ at: oldAt, mode: 'auto', sourceSession: 'session-old', handoff: '过期交接包' }), dir, log);
	const stale = readPending(dir, log);
	const logText2 = readFileSync(logFile, 'utf8');
	check('⑤ 超过 2 小时的旧待接被跳过并记日志', stale.pending === null && stale.stale === true && logText2.includes('超过 2 小时'), `stale=${String(stale.stale)} pending=${JSON.stringify(stale.pending)}`);

	// ⑥ 路由：pending 没有待接时必须是 200 + 空，**不是 404**（客户端每 10 秒轮询，404 会刷爆 Console）
	const pendingRes = fakeResponse();
	makePendingHandler(log)(fakeRequest({ method: 'GET' }), pendingRes);
	const pendingBody = pendingRes.json();
	check('⑥ GET /api/session/pending 无待接时 200 + 空（不是 404）', pendingRes.statusCode === 200 && pendingBody?.empty === true && pendingBody?.pending === null, `HTTP ${pendingRes.statusCode}`);

	// ⑦ 降级路径：拿假 ctx 直接调 handler，看"叫不动时返回什么"
	const failCtx = fakeContext({ failCreate: '本机没有活的会话工厂' });
	const failRes = fakeResponse();
	await makeSwitchHandler(failCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-x', seq: 1, handoff: '交接包', cwd: 'D:\\dsh' } }), failRes);
	const failBody = failRes.json();
	check(
		'⑦ 建会话失败时返回明确错误 JSON（不是挂住、不是 200）',
		failRes.statusCode === 500 && failBody?.ok === false && typeof failBody?.error === 'string',
		`HTTP ${failRes.statusCode} error=${String(failBody?.error)}`,
	);
	const stillEmpty = readPending(dir, log).pending;
	check('⑦b 建会话失败时**不写** pending（避免切到不存在的会话）', stillEmpty === null, `pending=${JSON.stringify(stillEmpty)}`);

	// ⑧ 降级路径：没有 agents 等服务时，要**点名说缺谁**，而不是抛个 undefined 让人去猜
	const nakedCtx = { logger: { info() {}, warn() {} } };
	const nakedRes = fakeResponse();
	await makeSwitchHandler(nakedCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-y', handoff: '交接包' } }), nakedRes);
	const nakedBody = nakedRes.json();
	check(
		'⑧ 缺少建会话服务时点名说缺谁（不是 Cannot read properties）',
		nakedRes.statusCode === 500 && nakedBody?.ok === false && String(nakedBody.error).includes('agents'),
		`HTTP ${nakedRes.statusCode} error=${String(nakedBody?.error)}`,
	);

	// ⑨ 交接包真的发不进去时（这条路径 = 建消息的依赖不在解析路径上），
	// 必须回滚半成品会话并返回明确错误，而不是留下一个空的鬼会话。
	let disposed = 0;
	const noLlmCtx = fakeContext({});
	noLlmCtx.agents.create = async () => ({
		agent: { session: { id: 'session-fake' }, followup: () => { throw new Error('不该走到这里'); } },
		dispose: async () => {
			disposed += 1;
		},
	});
	const noLlmRes = fakeResponse();
	await makeSwitchHandler(noLlmCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-z', handoff: '交接包' } }), noLlmRes);
	const noLlmBody = noLlmRes.json();
	check(
		'⑨ 交接包发不进去时回滚并返回明确错误（本进程解析不到 @deepseek-ai/dsh-llm）',
		noLlmRes.statusCode === 500 && noLlmBody?.ok === false && disposed === 1,
		`HTTP ${noLlmRes.statusCode} disposed=${disposed} error=${String(noLlmBody?.error).slice(0, 60)}`,
	);

	// ⑪～⑬ 刹车三道闸（2026-09-27 交接连锁事故后加的）。**从零开始**，不受前面用例影响：
	// 先清预算记录，再逐条验"同源冷却 / 全局预算 / 记账与容错"。
	rmSync(budgetFile(dir), { force: true });

	// ⑪ 同源冷却：同一个 sourceSession 在冷却期内第二次请求必须被 429 拒掉，且**不建会话**
	const gateCtx1 = fakeContext({});
	let gateCreated1 = 0;
	gateCtx1.agents.create = async () => {
		gateCreated1 += 1;
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const c1Res = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-a2', handoff: '交接包第一次' } }), c1Res);
	const res1 = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-a2', handoff: '交接包第二次' } }), res1);
	const body1 = res1.json();
	check(
		'⑪ 同源冷却：同一会话 30 分钟内第二次交接被 429 拒（且没再建会话）',
		c1Res.statusCode === 200 && res1.statusCode === 429 && body1?.reason === 'source-cooldown' && gateCreated1 === 1,
		`第一次 HTTP ${c1Res.statusCode}｜第二次 HTTP ${res1.statusCode} reason=${String(body1?.reason)}｜共建会话=${gateCreated1}`,
	);

	// ⑫ 全局预算：一小时 3 次，第 4 次（换新来源会话）必须被 429 拒
	rmSync(budgetFile(dir), { force: true });
	const gateCtx2 = fakeContext({});
	let gateCreated2 = 0;
	gateCtx2.agents.create = async () => {
		gateCreated2 += 1;
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const budgetCodes = [];
	for (const tag of ['b1', 'b2', 'b3', 'b4']) {
		const r = fakeResponse();
		await makeSwitchHandler(gateCtx2, log)(fakeRequest({ method: 'POST', body: { sourceSession: `session-${tag}`, handoff: `交接包-${tag}` } }), r);
		budgetCodes.push(r.statusCode);
	}
	check(
		'⑫ 全局预算：一小时内建到上限后第 4 次被 429 拒（换新会话也挡）',
		budgetCodes.slice(0, 3).every((c) => c === 200) && budgetCodes[3] === 429 && gateCreated2 === BUDGET_MAX_PER_WINDOW,
		`四次状态码=${budgetCodes.join(',')} 预设上限=${BUDGET_MAX_PER_WINDOW} 实际建会话=${gateCreated2}`,
	);

	// ⑬ 记账：预算文件是合法 JSON、条数对得上；且**坏文件/陈旧记录不会把插件搞死**
	let budgetOk = false;
	let budgetDetail = '';
	try {
		const saved = readBudget(dir);
		budgetOk = saved.records.length === BUDGET_MAX_PER_WINDOW;
		budgetDetail = `记录数=${saved.records.length}`;
	} catch (error) {
		budgetDetail = `读预算抛了：${errorMessage(error)}`;
	}
	check('⑬ 记账：成功的交接都记进了 handoff-budget.json（条数=上限）', budgetOk, budgetDetail);

	// ⑬b 坏 JSON + 全是过期记录 → 当成"没有记录"，照常放行（绝不能让刹车反过来卡死正常交接）
	writeFileSync(budgetFile(dir), '{ 这不是 JSON', 'utf8');
	const brokenRes = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-c1', handoff: '坏文件之后' } }), brokenRes);
	writeFileSync(budgetFile(dir), JSON.stringify({ records: [{ at: Date.now() - 10 * 24 * 60 * 60 * 1000, sourceSession: 'session-old', seq: 1, handoffChars: 1 }] }), 'utf8');
	const staleRes = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-c2', handoff: '陈旧记录之后' } }), staleRes);
	check(
		'⑬b 坏 JSON / 陈旧记录都当"没有记录"：照常放行（刹车不会反过来卡死）',
		brokenRes.statusCode === 200 && staleRes.statusCode === 200,
		`坏 JSON 后 HTTP ${brokenRes.statusCode}｜陈旧后 HTTP ${staleRes.statusCode}`,
	);
	rmSync(budgetFile(dir), { force: true });

	// ⑭ 并发雪崩（事故的复现形状）：8 个请求**同时**打进来（每个来源会话都不同，
	// 所以同源冷却挡不住它们），只许建到全局上限为止 —— 这一条就是"不再雪崩"的验收。
	rmSync(budgetFile(dir), { force: true });
	const gateCtx3 = fakeContext({});
	let concurrentCreated = 0;
	gateCtx3.agents.create = async () => {
		concurrentCreated += 1;
		// 故意 yield 一次：有竞态时这里就是两个请求都能读到"没到上限"的窗口。
		await new Promise((r) => setTimeout(r, 5));
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const concurrentRes = Array.from({ length: 8 }, () => fakeResponse());
	await Promise.all(concurrentRes.map((res, i) => makeSwitchHandler(gateCtx3, log)(fakeRequest({ method: 'POST', body: { sourceSession: `session-burst-${i}`, handoff: `雪崩测试-${i}` } }), res)));
	const codes = concurrentRes.map((r) => r.statusCode);
	const okCount = codes.filter((c) => c === 200).length;
	check(
		'⑭ 并发雪崩：8 个不同来源同时请求，只建到上限（其余 429），不会像 14:4x 那样刷满',
		okCount === BUDGET_MAX_PER_WINDOW && concurrentCreated === BUDGET_MAX_PER_WINDOW && codes.filter((c) => c === 429).length === 8 - BUDGET_MAX_PER_WINDOW,
		`状态码=${codes.join(',')}｜建会话=${concurrentCreated}（上限 ${BUDGET_MAX_PER_WINDOW}）`,
	);

	// ⑩ 方法不对给 405（而不是把 GET 当 POST 处理）
	const methodRes = fakeResponse();
	await makeSwitchHandler(ctx, log)(fakeRequest({ method: 'GET' }), methodRes);
	check('⑩ 方法不对给 405', methodRes.statusCode === 405 && methodRes.headers.allow === 'POST', `HTTP ${methodRes.statusCode} allow=${String(methodRes.headers.allow)}`);

	// ⑮ 起名（她 2026-09-27 的要求）：新会话沿用**原会话的名字**；没带名字才回退「会话交接」。
	// 先清预算记录（⑪～⑭ 已经用掉几个名额），两次请求来自不同来源会话、不受同源冷却影响。
	rmSync(budgetFile(dir), { force: true });
	const titleCtx = fakeContext({});
	const titleRes1 = fakeResponse();
	await makeSwitchHandler(titleCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-t1', handoff: '交接包', sourceTitle: '夜间排查' } }), titleRes1);
	const titleRes2 = fakeResponse();
	await makeSwitchHandler(titleCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-t2', handoff: '交接包' } }), titleRes2);
	const renamedTitles = titleCtx.sessionTitle.renamed.map((r) => r.title);
	check(
		'⑮ 新会话沿用原会话的名字（没带名字才回退「会话交接」）',
		titleRes1.statusCode === 200 && titleRes2.statusCode === 200 && renamedTitles[0] === '夜间排查' && renamedTitles[1] === '会话交接',
		`第一次=${String(renamedTitles[0])}｜第二次=${String(renamedTitles[1])}｜HTTP ${titleRes1.statusCode},${titleRes2.statusCode}`,
	);
	rmSync(budgetFile(dir), { force: true });

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${results.length - failed.length}/${results.length}`);
	console.log(`状态目录：${dir}`);
	return failed.length === 0 ? 0 : 1;
}
