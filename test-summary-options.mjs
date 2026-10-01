// 离线单测（2026-09-27 22:3x）：`summarizeWithModel` 的调用姿势对不对 ——
// ①支持 `off` 的路由必须传 `reasoningEffort:'off'`；②不支持／查不到的路由**不许**传（传了会被适配器拒，
// 那样每次总结都失败退回机械那份）；③只吐思考时五段式守卫仍要拦住；④那行 finish/usage 诊断要真的落盘。
// 跑法：`node test-summary-options.mjs`（不需要宿主、不联网）。它会往 /tmp/dsh-auto-handoff.log 写几行，跑完自己截掉。
import { statSync, truncateSync } from 'node:fs';
import { summarizeWithModel } from './handoff-summary.js';

const LOG = '/tmp/dsh-auto-handoff.log';
const before = (() => { try { return statSync(LOG).size; } catch { return 0; } })();

const session = {
  id: 's-test',
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: '帮我看下插件' }] } }],
};

function fakeLlm({ supportsOff, text, reasoning }) {
  return {
    resolveModelInfo: async () => (supportsOff ? { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } : {}),
    async *stream(options) {
      globalThis.__captured = options;
      if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
      if (text) yield { type: 'text-delta', text };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: reasoning ? 20 : 0 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

let pass = 0;
let fail = 0;
const check = (name, cond) => { if (cond) { pass += 1; console.log(`✓ ${name}`); } else { fail += 1; console.log(`✗ ${name}`); } };

const ctx1 = { get: () => fakeLlm({ supportsOff: true, text: '【这一轮在做什么】改插件\n【挂着的】无' }) };
const out1 = await summarizeWithModel(ctx1, session, {});
check('支持 off → 传 reasoningEffort=off', globalThis.__captured.reasoningEffort === 'off');
check('五段正文原样返回', out1.includes('【这一轮在做什么】'));

const ctx2 = { get: () => fakeLlm({ supportsOff: false, text: '【这一轮在做什么】改插件' }) };
await summarizeWithModel(ctx2, session, {});
check('不支持 → 不传 reasoningEffort', !('reasoningEffort' in globalThis.__captured));

const ctx3 = { get: () => fakeLlm({ supportsOff: true, reasoning: '用户要求总结一下。我需要如实写。' }) };
let threw = '';
try { await summarizeWithModel(ctx3, session, {}); } catch (error) { threw = String(error.message); }
check('只有思考 → 守卫拦住（不是五段式）', threw.includes('不是五段式'));

check('诊断行含 finish 与字数', (await import('node:fs')).readFileSync(LOG, 'utf8').includes('模型总结调用：finish=stop'));

// 收尾：把这次测试写进诊断日志的几行截掉，别污染真机日志（这一段本身不该让测试失败）。
try { if (before > 0) truncateSync(LOG, before); } catch { /* 截不掉也不影响结论 */ }

console.log(`—— 结果：${pass} 过 / ${fail} 失败 ——`);
process.exit(fail === 0 ? 0 : 1);
