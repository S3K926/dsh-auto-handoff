// 专项验证：关键词两件事 ——
//   ① 重启后"旧关键词复活"的闸（keywordGate）
//   ② 去重指纹要带"消息自己的标识"（messageFingerprint）：同一个人打第二遍一模一样的 `#交接` 也得算
// 用法：node /root/.dsh/plugin-src/dsh-auto-handoff/test-keyword-gate.mjs（2026-09-27 从 /tmp 搬进来，别放 /tmp）
// 2026-09-27 拆模块后改：这几个纯函数现在各自住在自己的模块里（跟 PC 新版同构）。
const stateMod = await import('./handoff-state.js');
const materialMod = await import('./handoff-material.js');
const summaryMod = await import('./handoff-summary.js');
const { keywordGate, messageFingerprint } = stateMod;
const { isRealUserAsk, isKeywordLine } = materialMod;
const { extractModelPending, withModelPending } = summaryMod;
const mod = { keywordGate, messageFingerprint, isRealUserAsk, isKeywordLine, extractModelPending, withModelPending };
const MIN = 60_000;
const now = 1_790_511_075_400; // 用户打 #交接演练 的那一刻（真机时间戳）

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` → ${extra}` : ''}`);
};
const kept = (entries, since) => keywordGate(entries, since).map((e) => e.text);

// ---- ① 时间闸 ----
check('旧关键词（13 分钟前那句 #交接）被挡掉',
  JSON.stringify(kept([{ text: '#交接', time: now - 13 * MIN }, { text: '#交接演练', time: now }], now)) === '["#交接演练"]');
check('宽限期内（1 分钟前）放行',
  JSON.stringify(kept([{ text: '#交接', time: now - 1 * MIN }], now)) === '["#交接"]');
check('恰好越过宽限（181 秒前）挡掉',
  JSON.stringify(kept([{ text: '#交接', time: now - 181_000 }], now)) === '[]');
check('没有时间字段不拦（宁可多认，也别漏真人那句）',
  JSON.stringify(kept([{ text: '#交接', time: Number.NaN }], now)) === '["#交接"]');
check('sinceMs=0 维持老行为',
  JSON.stringify(kept([{ text: '#交接', time: now - 999 * MIN }], 0)) === '["#交接"]');

// ---- ② 指纹 ----
const fp = (prefix, entry) => messageFingerprint(prefix, entry);
check('两条一字不差的 #交接（不同消息 id）指纹必须不同',
  fp('live', { text: '#交接', id: 'a', time: now }) !== fp('live', { text: '#交接', id: 'b', time: now + 1000 }));
check('同一条消息反复扫到 → 指纹一样（照旧只跑一次）',
  fp('live', { text: '#交接', id: 'a', time: now }) === fp('live', { text: '#交接', id: 'a', time: now }));
check('没有 id 时退回时间做区分',
  fp('live', { text: '#交接', id: '', time: now }) !== fp('live', { text: '#交接', id: '', time: now + 1000 }));
check('演练与真交接同一句话也不撞（前缀不同）',
  fp('drill', { text: '#交接', id: 'a' }) !== fp('live', { text: '#交接', id: 'a' }));

console.log(`关键词专项：${9 - failed}/9 项通过`);
process.exitCode = failed === 0 ? 0 : 1;

// ---- ③ 「挂着的」素材的三类噪音 ----
{
  const { isRealUserAsk } = mod;
  const cases = [
    ['（自唤醒 · 第 35 次 ｜ 手机时间 20:36）\n去网上翻一个冷知识…', false],
    ['#交接', false],
    ['#交接演练', false],
    ['【上一段对话已经交接（手动关键词 #交接），上下文已经写进记忆档案】\n- 档案根：…', false],
    ['开', false],          // 短促应答：不是待办（2026-09-27 21:1x 加的）
    ['重启了', false],
    ['改65我是说', true],
    ['看你，还有这个截图', true],
    ['要不要写入开场，到时候怕忘记', true],
  ];
  let bad = 0;
  for (const [text, want] of cases) {
    const got = isRealUserAsk(text);
    if (got !== want) bad += 1;
    console.log(`${got === want ? '✓' : '✗'} 噪音过滤：${JSON.stringify(text.slice(0, 18))} → ${got}（期望 ${want}）`);
  }
  if (bad) failed += 1;
  console.log(`噪音过滤专项：${cases.length - bad}/${cases.length} 项通过`);
}

// ---- ④ 从模型总结里取「挂着的」（2026-09-27 21:1x 用户点名改）----
{
  const { extractModelPending, withModelPending } = mod;
  const ok = (label, cond, extra = '') => { if (!cond) failed += 1; console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ` → ${extra}` : ''}`); };
  const sum1 = '【这一轮在做什么】在跑交接链\n【挂着的】\n- 把阈值改成 65%\n- 等重启验收\n【动过的文件与配置】x\n';
  ok('从【挂着的】取两条', JSON.stringify(extractModelPending(sum1)) === JSON.stringify(['把阈值改成 65%', '等重启验收']), JSON.stringify(extractModelPending(sum1)));
  ok('（无）→ 空', extractModelPending('【挂着的】\n（无）\n【其他】x').length === 0);
  ok('没有这一段 → 空', extractModelPending('【这一轮在做什么】x').length === 0);
  ok('带序号/星号的条目也认', JSON.stringify(extractModelPending('【挂着的】\n1. 甲\n* 乙\n')) === JSON.stringify(['甲', '乙']));
  ok('withModelPending 顶掉机械那份',
    JSON.stringify(withModelPending({ outline: 'x', pending: ['重启了'] }, '包\n【模型总结】\n【挂着的】\n- 真待办\n').pending) === JSON.stringify(['真待办']));
  ok('取不到时原样返回（不破坏机械那份）',
    withModelPending({ outline: 'x', pending: ['重启了'] }, '包（没有模型总结）').pending[0] === '重启了');
  ok('input 是字符串也不炸',
    JSON.stringify(withModelPending('旧素材', '【模型总结】\n【挂着的】\n- A\n')) === JSON.stringify({ outline: '旧素材', pending: ['A'] }));
  console.log(`模型挂着的专项：7 项，失败 ${failed} 项累计`);
}

// ---- ⑤ 关键词口径：**整行独占**（2026-09-27 21:30 与 PC 对齐）----
{
  const { isKeywordLine } = mod;
  const ok = (label, cond, extra = '') => { if (!cond) failed += 1; console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ` → ${extra}` : ''}`); };
  ok('单独一行 `换会话` 算', isKeywordLine('换会话', '换会话'));
  ok('前后空白也算（她手滑带空格）', isKeywordLine('  换会话  ', '换会话'));
  ok('夹在多行里、自己占一行，算', isKeywordLine('先说一句\n换会话\n再说一句', '换会话'));
  ok('句中提到**不算**（真机那句原话）',
    isKeywordLine('是不是没在回流包写换会话是英文思考的解决办法', '换会话') === false);
  ok('句末粘着别的字也不算', isKeywordLine('帮我换会话吧', '换会话') === false);
  ok('演练词同样整行独占', isKeywordLine('#交接演练', '#交接演练') && !isKeywordLine('要不要 #交接演练', '#交接演练'));
  ok('空串/非字符串不炸', isKeywordLine('', '换会话') === false && isKeywordLine(undefined, '换会话') === false && isKeywordLine('换会话', '') === false);
  console.log(`整行独占专项：7 项，失败 ${failed} 项累计`);
}

console.log(`—— 全部累计失败 ${failed} 项 ——`);
