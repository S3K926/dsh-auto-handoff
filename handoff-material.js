// handoff-material.js —— 从 index.js 拆出（2026-09-27 收工自检判 index.js 超 800 行，按职责拆块）。
// 纯搬移：函数体一行没改，只补了 import / export。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRoot, flattenHandoff, localStamp, oneLine, processHandoff } from './handoff-core.js';
// （本模块是纯函数：解析消息 / 拼交接包素材，不依赖别的拆出模块。）


/* ---------------------------------------------------------- 交接包素材 */

/** 她/他贴进对话的整段日志不是"要交接的事"，一律滤掉（原版踩过这个）。 */
export function looksLikePastedLog(text) {
  const flat = String(text ?? '');
  if (flat.includes('    at ') || /\b\w+\.\w+:\d+:\d+\b/.test(flat)) return true;
  if (/\b(?:GET|POST)\s+\S+\s+HTTP\/\d/.test(flat)) return true;
  return flat.split('\n').filter((line) => line.trim() !== '').length >= 8 && flat.length > 400;
}

/** 用户真人的话（`source.kind === 'user'`，排除插件注入的交接包）。 */
export function userSaidEntries(events) {
  return events
    .filter((event) => {
      // 2026-09-25 12:4x 真机：用户打了 `#交接演练`，插件却走了普通判定 → 关键词没被认出来。
      // 原来只认一种形状（`type === 'user/message'` 且 `data.source.kind === 'user'`）。
      // 现在放宽：几种常见事件名都认；来源字段拿不到就不拦（宁可多认一条，
      // 也不该漏掉用户亲手打的那句话）。
      const type = event?.type ?? event?.kind;
      if (type !== 'user/message' && type !== 'message/user' && type !== 'user-message') return false;
      const data = event?.data ?? event;
      const source = data?.source;
      const kind = typeof source === 'string' ? source : source?.kind;
      return kind === undefined || kind === null || kind === 'user';
    })
    .map((event) => ({
      text: messageText(event?.data ?? event),
      time: Number(event?.time),
      // 每条消息**自己的标识**：去重指纹必须带上它 —— 只按文本去重的话，同一个人把关键词
      // 打第二遍（一字不差）也会被当"已经处理过"吞掉（2026-09-27 20:37 真机踩到）。
      id: String((event?.data ?? event)?.id ?? event?.id ?? ''),
    }))
    .filter((entry) => entry.text !== '' && !entry.text.includes('【自动交接】') && !looksLikePastedLog(entry.text));
}

/** 用户说了什么（只要文本）—— 旧调用点继续用这个。 */
export function userSaid(events) {
  return userSaidEntries(events).map((entry) => entry.text);
}

/**
 * 「这句算不算用户在提要求」—— 交接包素材的**第④类噪音**在这里滤掉。
 *
 * 来历（都是真机踩出来的）：
 *   ① 自唤醒的提示词（`（自唤醒…` 开头）—— 是我自己发的，不是她；
 *   ② 交接包本身（`【上一段对话已经交接…`）—— 是插件发的；
 *   ③ 光秃秃的关键词（`#交接` / `换会话` / `#交接演练`）—— 是指令，不是待办；
 *   ④ **≤3 字的应答**（"重启了""开""好"）—— 2026-09-27 21:11 真机：`unfinished`
 *      被写成「改65我是说」「重启了」这类口语，我前后手修五遍才把这条加进来。
 */
export function isRealUserAsk(text) {
  const flat = String(text ?? '').trim();
  if (flat === '') return false;
  if (flat.startsWith('（自唤醒')) return false;
  if (flat.startsWith('【上一段对话已经交接')) return false;
  if (/^#[^\s]{1,12}$/.test(flat)) return false;
  if (flat.replace(/\s/g, '').length <= 3) return false;
  return true;
}

/** 一轮里动过的工具（`tool/call` 的 name，前几个）。 */
export function toolsUsed(events) {
  const names = [];
  for (const event of events) {
    const call = event?.type === 'tool/call' ? event.data?.name ?? event.data?.tool : undefined;
    if (typeof call === 'string' && !names.includes(call)) names.push(call);
  }
  return names;
}

/** 消息取纯文本（只认 text 块，别把图片描述也当正文）。 */
export function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
}

/** 交接包素材：**只写工作上下文**（真名/住址/朋友一律不进档案）。 */
export function buildHandoffInput(session) {
  const events = session?.snapshotEvents?.() ?? [];
  // 滤掉四类噪音（自唤醒提示词 / 交接包 / 光秃秃关键词 / ≤3 字应答）—— 见 isRealUserAsk。
  const asked = userSaid(events).filter(isRealUserAsk);
  const tools = toolsUsed(events);
  const route = session?.requestContext?.();
  return {
    outline: asked.length ? oneLine(asked[asked.length - 1], 120) : '（没取到用户最近说的话）',
    pending: asked.length > 1 ? asked.slice(-3, -1).map((t) => oneLine(t, 100)) : [],
    touched: tools.length ? [tools.slice(0, 8).join('、')] : [],
    preferences: route ? [`沿用路由 ${route.provider}/${route.model}`] : [],
    next: '只补账（补一条交接日记，序号接 `last_diary_seq` + 1；`last_updated` 刷实测值）；「挂着的」先判它**是不是已经做过**（看 `档案\\最新.zip` ／ `归档-旧版本与记录\\收工自检-*.txt` 的时间戳），做过就别重跑 —— 日记／备份／收工／整理各有各的词，她点哪个做哪个。先看 `生长\\状态.md` 顶部那一节。',
  };
}

/**
 * 关键词判定：**整行匹配**，不是"句子里出现这三个字"。
 *
 * 2026-09-27 21:30 真机踩出来的坑：交接关键词从 `#交接` 换成 `换会话` 之后，
 * 她一句「是不是没在回流包写换会话是英文思考的解决办法」里**正好含这三个字**，
 * 于是被当成手动指令、**真的触发了一次交接**（写真档案、还写了一条日记）。
 * 口径因此收紧成：**关键词要在一行里独占** —— 单独打一句 `换会话` / `#交接演练` 才算。
 * ⚠ 演练词与真交接词**共用这一套口径**（两处判定必须一致，别再退回 includes）。
 */
export function isKeywordLine(text, keyword) {
  if (typeof text !== 'string' || typeof keyword !== 'string' || keyword === '') return false;
  return text.split(/\r?\n/).some((line) => line.trim() === keyword);
}
