/**
 * 只验一件事（2026-10-03 加的规则）：
 *   **认得出档案根时，不再让模型把整段会话读一遍写总结**——内容已经在档案里了。
 *
 * 跑法：node test/refine-skip-summary.test.mjs
 */
import assert from 'node:assert/strict';
import { refineHandoff } from '../handoff-summary.js';

/** 假的 llm 服务：被调用就在 called 上记一笔（我们要的就是"有没有被调用"）。 */
function fakeCtx() {
  const calls = { stream: 0 };
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }] } };
    },
    // 真被调用就抛：这份测试关心的是"调没调"，不是"总结写得好不好"
    stream() {
      calls.stream += 1;
      throw new Error('总结被调用了（这条断言要看的就是这个）');
    },
  };
  return { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, calls };
}

const session = {
  id: 's-1',
  // historyForSummary 抽不到任何消息时会直接抛（"会话里没抽到可总结的消息"），
  // 那样 llm.stream 根本走不到，这条断言就验不到东西 —— 所以给一条最简的用户消息。
  snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: '在整理备份' }] } }],
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
};

// ① 有档案根 → 不该调用模型总结
{
  const { ctx, calls } = fakeCtx();
  const out = await refineHandoff(ctx, session, '机械包：挂着的 → 把插件改动推 GitHub', 'D:/假档案根', { summarize: true });
  assert.equal(calls.stream, 0, '有档案根时不该再调模型总结（省一次完整上下文调用）');
  assert.ok(out.includes('档案根'), '应该返回"指路"版交接包');
  assert.ok(!out.includes('【模型总结】'), '跳过了就不该出现模型总结');
  console.log('[OK ] 有档案根 → 跳过模型总结');
}

// ② 没有档案根 → 照旧尝试总结（自包含的那条路不能断），失败也只是退回机械包
{
  const { ctx, calls } = fakeCtx();
  const out = await refineHandoff(ctx, session, '机械包', '', { summarize: true });
  assert.equal(calls.stream, 1, '没档案根时必须尝试总结（那时没别处能拿到上下文）');
  assert.equal(out, '机械包', '总结失败就退回机械包，功能不能炸');
  console.log('[OK ] 没档案根 → 照旧尝试总结，失败退回机械包');
}

// ③ summarize 关着时，两种情况下都不该调用
{
  const { ctx, calls } = fakeCtx();
  await refineHandoff(ctx, session, '机械包', 'D:/假档案根', { summarize: false });
  assert.equal(calls.stream, 0);
  console.log('[OK ] summarize=false → 永远不调');
}

// ④ summarizeAlways=true 时，即使有档案根也照旧跑（保留原行为的开关）
{
  const { ctx, calls } = fakeCtx();
  await refineHandoff(ctx, session, '机械包', 'D:/假档案根', { summarize: true, summarizeAlways: true });
  assert.equal(calls.stream, 1, 'summarizeAlways 打开就该照旧跑');
  console.log('[OK ] summarizeAlways=true → 有档案根也照旧跑');
}

console.log('\n=== 交接"跳过总结"自检：4/4 通过 ===');
