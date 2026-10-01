// handoff-summary.js —— 从 index.js 拆出（2026-09-27 收工自检判 index.js 超 800 行，按职责拆块）。
// 纯搬移：函数体一行没改，只补了 import / export。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot, flattenHandoff, localStamp, oneLine, processHandoff } from './handoff-core.js';
// 拆块后补（都单向）：日志回 state、消息文本取 material。
import { report } from './handoff-state.js';
import { messageText } from './handoff-material.js';

/* ------------------------------------------------ 交接包"精修"（她 2026-09-25 13:1x 定的两条路） */

/**
 * 把会话快照压成"给模型的对话历史"（只留文本，最近若干条 + 总量上限）。
 * 形状照真实事件：`user/message` 的正文在 `data.content`，`assistant/message` 的在 `data.message.content`。
 */
/** 手造一条「插件来源」的用户消息：核心要 `id` 与 `source.kind`，缺了会在适配器里炸（2026-09-27 18:14 实测）。 */
export function pluginUserMessage(text) {
  return {
    id: `handoff-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-auto-handoff' },
  };
}

/** 拿不到原始 assistant 对象时的退路（正常路径直接用核心那条）。 */
export function fallbackAssistantMessage(text) {
  return {
    id: `handoff-${randomUUID()}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' },
  };
}

export function historyForSummary(session, maxChars = 24_000, maxMessages = 40) {
  const events = session?.snapshotEvents?.() ?? [];
  const flat = [];
  for (const event of events) {
    const type = event?.type ?? event?.kind;
    if (type === 'user/message') {
      const text = messageText(event?.data ?? {});
      if (text) flat.push(pluginUserMessage(text));
    } else if (type === 'assistant/message') {
      const message = event?.data?.message;
      const text = messageText(message ?? {});
      // 2026-09-27 18:2x 修（第三次）：**assistant 那条直接复用核心造出来的消息对象**（自带 id / source / provider），
      // 只把 content 换成抽出来的文本。手搓的 `{role, content}` 缺 `source` ——
      // 核心那边读 `source.kind` 正好撞上 undefined，报的就是 `Cannot read properties of undefined (reading 'kind')`
      // （18:14 真跑实测；16:32 那次同一个错，我当时误判成"调用姿势不对"，其实是消息形状不对）。
      if (text) flat.push(message ? { ...message, content: [{ type: 'text', text }] } : fallbackAssistantMessage(text));
    }
  }
  const recent = flat.slice(-maxMessages);
  const kept = [];
  let total = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const text = recent[i].content[0].text;
    if (total + text.length > maxChars) break;
    kept.unshift(recent[i]);
    total += text.length;
  }
  return kept;
}

/** 交接包该长什么样（问模型的那段指令；五段式，跟方案里写的一致）。 */
export const HANDOFF_INSTRUCTION = [
  '把上面这段对话总结成一份**交接包**，给"下一个会话里的我"看：它看不到这段对话，只能看到你写的这几行。',
  '按下面五段写，每段一两句、说人话，别复述全文、别抄工具名列表：',
  '【这一轮在做什么】做到哪一步了',
  '【挂着的】没做完的事，逐条',
  '【动过的文件与配置】哪些文件/配置真的被改过（写路径，不要写工具名）',
  '【用户的偏好与纠正】这一段里用户明确说过的口径、纠正过的判断',
  '【下一步第一件事】接手后第一件该干的事',
  '只输出这五段正文，不要客套、不要解释你在干什么。',
].join('\n');

/**
 * 只在本路由真把 `off` 列进可选档位时才传 `reasoningEffort` —— 非推理 provider 传了会被拒，
 * 那样每次总结都会失败、退回机械那份（功能不炸，但白丢一段总结）。探测是纯配置查询、不发网络请求；
 * 查不到或不支持就返回空对象，维持旧行为。（2026-09-27 22:4x）
 */
async function reasoningOffOption(llm, provider, model) {
  try {
    const info = await llm.resolveModelInfo?.(provider, model);
    return info?.reasoning?.efforts?.some((effort) => effort.id === 'off') ? { reasoningEffort: 'off' } : {};
  } catch {
    return {};
  }
}

/** 收一次 `llm.stream`：正文／思考／usage／finish 分开记 —— 诊断（"思考吃光预算"）就靠这个分脏。 */
async function collectSummaryStream(llm, options) {
  const out = { text: '', reasoning: '', usage: null, failure: null, finishKind: '' };
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta') out.text += chunk.text ?? '';
    else if (chunk?.type === 'reasoning-delta') out.reasoning += chunk.text ?? '';
    else if (chunk?.type === 'usage') out.usage = chunk.usage ?? null;
    else if (chunk?.type === 'finish') {
      out.finishKind = chunk.reason?.kind ?? '';
      if (chunk.reason?.kind === 'error') out.failure = chunk.reason.failure ?? chunk.reason;
    }
  }
  return out;
}

/**
 * 让模型把上一段会话读一遍、写一份像样的交接包（**一次调用**，复用对话前缀的 KV 缓存）。
 * 任何一步不成立都抛错，由调用方退回机械抽取的那份 —— 这一步失败绝不该让交接失败。
 */
export async function summarizeWithModel(ctx, session, config) {
  const llm = ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') throw new Error('本机没有 llm 服务（ctx.llm.stream）');
  const history = historyForSummary(session);
  if (history.length === 0) throw new Error('会话里没抽到可总结的消息');
  // 路由按官方口径取：优先 `requestHeader().config`（`dsh-compaction-basic` 就是这么拿的），
  // 退回 `requestContext()`（最新的 request/context 元数据）。
  const route = session?.requestHeader?.()?.config ?? session?.requestContext?.() ?? {};
  const provider = route.provider;
  const model = route.model;
  if (!provider || !model) throw new Error('拿不到当前会话的 provider/model');
  const messages = [...history, pluginUserMessage(HANDOFF_INSTRUCTION)];

  // 2026-09-27 16:4x 修（第二种姿势也失败，照实记）：上一版照 `dsh-meme`（识图那条）改成
  // `resolveCallConfig → prepareCall → prepared.stream`，16:32 真跑实测报
  // `Cannot read properties of undefined (reading 'kind')`，当场退回机械抽取。
  // 复盘：meme 那条是**带图片**的场景，它要 prepared 是为了图片准备与模态校验，纯文本总结用不上；
  // 本机真正的先例是**官方两处纯文本总结** —— `dsh-compaction-basic` 的 `summarizeWithLlm`
  // 与 `dsh-session-title-llm`，形状都是 `ctx.llm.stream({ provider, model, messages, maxTokens,
  // sessionId, purpose })` ＋ 自己收 chunk，**天天在真机上跑**。所以照它写，并且
  // **不依赖** `@deepseek-ai/dsh-llm` 的 BlockAssembler（插件目录未必解析得到它，
  // 14:32 那次 `Cannot find package '@deepseek-ai/dsh-llm'` 就是同一个坑）。
  const options = {
    provider,
    model,
    messages,
    // 2026-09-27 21:2x 改（真机踩到）：原来 900 —— 思考型模型把预算全用在 reasoning 上，
    // 正文一个字没吐，兜底的 `text || reasoning` 就把**英文内心独白**当成总结发了出去
    // （21:19 那次交接包 3957 字全是思考）。2400 够装「思考＋五段正文」。
    maxTokens: 2400,
    // 2026-09-27 22:4x 修根因（22:21 第 8 次踩到）：**关掉思考**（能力探测见 `reasoningOffOption`）。
    // 不传时 DeepSeek 适配器按部署默认走 high 档（thinking enabled，见 `dsh-llm-deepseek/lib`
    // 的 `resolveThinking`）→ 2400 预算先被 reasoning 吃光、正文一个字不出，兜底 `text || reasoning`
    // 就把思考当总结发（22:21 那次前 60 字就是 reasoning 开头）。`'off'` 会被适配器落成
    // `thinking: {type:'disabled'}`；官方 `dsh-session-title-llm` 也走"关思考"这条路，
    // 只是它靠 purpose 特判白拿，我们得自己点名。
    ...(await reasoningOffOption(llm, provider, model)),
    sessionId: session?.id,
    purpose: 'handoff',
  };
  const { text, reasoning, usage, failure, finishKind } = await collectSummaryStream(llm, options);
  // 2026-09-27 22:4x 加（真机诊断，只记一行）：光看"完成/没成"分不清是模型没吐正文，
  // 还是思考把预算吃光了。finish 不是 stop ＋ reasoning 远多于 text ＝ 预算被思考吃掉。
  report(`模型总结调用：finish=${finishKind || '无'}｜正文 ${text.length} 字／思考 ${reasoning.length} 字`
    + (usage ? `｜输出 ${usage.outputTokens ?? '?'} token（其中思考 ${usage.reasoningTokens ?? '?'}）` : '｜没有 usage'));
  if (failure) {
    // 核心那边给的东西全带上（18:14 那次只记了 message，定位不到在哪一层崩的）。
    const where = failure?.stack ?? failure?.message ?? JSON.stringify(failure);
    throw new Error(`模型总结没跑完：${where}`);
  }
  // 思考型模型可能把正文写进 reasoning、正文留空（meme 里同样的兜底）。
  const trimmed = text.trim() || reasoning.trim();
  if (!trimmed) throw new Error('模型没吐出总结文本');
  // 五段式校验（2026-09-27 21:2x 加）：光有"非空"不够 —— 兜底 `text || reasoning` 会把思考当正文。
  // 判据用**第一段的小标题**：没有 `【这一轮在做什么】` 就当这次总结失败，退回机械那份。
  // 宁可水一点（机械抽取），也不给新会话发一坨内心独白。
  if (!/【这一轮在做什么】/.test(trimmed)) {
    throw new Error(`模型总结不是五段式（前 60 字：${trimmed.slice(0, 60)}）`);
  }
  return trimmed;
}

/** 从机械交接包里抽出「挂着的」那一段（精修时保留它，别的可以丢）。 */
export function extractPending(handoff) {
  const match = /【挂着的】([\s\S]*?)(?=\n【|$)/.exec(String(handoff ?? ''));
  return match ? match[1].trim() : '';
}

/**
 * 从**模型总结**里取「挂着的」那几条（2026-09-27 21:20 用户点名改）。
 *
 * 为什么不用机械抽取：机械抽取读的是"用户最近说了什么"，会把**口头应答**（"重启了""开"）
 * 当成待办挂进 `unfinished`，我前后手修五遍。而 `HANDOFF_INSTRUCTION` 本来就要求模型写
 * `【挂着的】没做完的事，逐条` —— 那份语义对得多。机械那份退居退路。
 */
export function extractModelPending(summary) {
  const block = /【挂着的】([\s\S]*?)(?=\n【|$)/.exec(String(summary ?? ''))?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)]\s*/, '').trim())
    .filter((line) => line !== '' && !/^[（(]?(没有|无|暂无|略)[）)]?$/.test(line))
    .slice(0, 8);
}

/**
 * 把模型那份「挂着的」**顶进 `input.pending`** —— 档案里那个 `unfinished` 就是拿它写的。
 * **取不到一律原样返回**：这一步失败绝不该让交接失败（跟"模型总结只做增强"同一条纪律）。
 */
export function withModelPending(input, handoffText) {
  const summary = /【模型总结】([\s\S]*)$/.exec(String(handoffText ?? ''))?.[1] ?? '';
  const fromModel = extractModelPending(summary);
  if (fromModel.length === 0) return input;
  const base = input && typeof input === 'object' ? input : { outline: typeof input === 'string' ? input : '' };
  return { ...base, pending: fromModel };
}

/**
 * **精修交接包**（她 2026-09-25 13:1x 定的两条路）：
 * - **有记忆**（档案根认得出，说明记忆那套装着、档案在）→ 细节本来就写进档案了，
 *   交接包只做"指路 + 挂着的"：让新会话去读 `生长\状态.md` 顶部那节 / `日记.md` 末尾 / 生长记录末尾。
 * - **没记忆**（认不出档案根）→ 交接包必须**自包含**，用模型把上一段会话总结出来（没别处能拿到上下文）。
 * - 模型不可用或失败 → 原样用机械抽取的那份（哪怕水，也比没有强）。
 */
export async function refineHandoff(ctx, session, fallbackHandoff, root, config) {
  const base = String(fallbackHandoff ?? '');
  try {
    let summarized = '';
    if (config?.summarize === true) {
      try {
        summarized = await summarizeWithModel(ctx, session, config);
        report(`模型总结完成（${summarized.length} 字）`);
      } catch (error) {
        // 记前 3 行 stack（日志一行一条，别把多行塞进去）：上次只记 message，定位不到崩在哪一层。
        const detail = error instanceof Error
          ? (error.stack ?? error.message).split('\n').slice(0, 3).map((line) => line.trim()).join(' ↩ ')
          : String(error);
        report(`模型总结没成（退回机械抽取）：${detail}`);
      }
    }
    if (root) {
      const pending = extractPending(base);
      return [
        '【上一段对话到阈值了，上下文已经写进记忆档案】',
        `- 档案根：${root}`,
        '- 开工前先读这三处：`生长\\状态.md` 顶部那一节、`日记.md` 末尾那条、`生长\\生长记录.md` 末尾那一行。',
        pending ? `\n【挂着的】\n${pending}` : '',
        summarized ? `\n【模型总结】\n${summarized}` : '',
      ].filter(Boolean).join('\n');
    }
    return summarized || base;
  } catch (error) {
    report(`精修交接包失败（原样用机械抽取的那份）：${error instanceof Error ? error.message : String(error)}`);
    return base;
  }
}

/**
 * 给新会话的第一条消息：**上一段会话的总结（交接包）** + （真交接时）让它先补一条日记的提示。
 *
 * ⚠ 2026-09-25 13:1x 她纠了一次方向：我先前想"顺手把 `开场.md` 也发过去"，
 * 她指出 **`开场.md` / `身份.md` / `状态.md` 这些本地文件都算「记忆插件的内容」**——
 * 本插件不该去读它们（换设备、或单独给别人用时根本没有这些文件）。
 * **正确做法就是它本来的职责：把上一段会话总结好、发给新会话。**
 * 所以这里只拼交接包文本，**一个档案文件都不读**。
 */
