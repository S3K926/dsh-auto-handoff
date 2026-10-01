/**
 * dsh-auto-handoff · 交接主流程（2026-09-28 从 `handoff-core.js` 拆出来的一层）
 *
 * 只搬不改：**函数体一行没动**。拆的动机：`收工自检` 的 800 行线，core 里塞了
 * "工具＋解析＋守卫＋主流程"四层，主流程占掉最后三分之一。
 * 对外接口不变 —— `handoff-core.js` 末尾把它们再导出一次，`index.js` 与测试文件的
 * import 一个字都不用改。
 */
import {
	applyLocalEdits, backupFile, commentFlag, editLastUpdated, editMetaRow, editUnfinished,
	entryFlag, findDiaryAppendIndex, fingerprint, firstStateSectionIndex, flattenHandoff,
	hasFlag, localStamp, metaNumber, metaValue, nextDiarySeq, oneLine, parseDiary,
	renderDiaryEntry, renderGrowthLine, renderHandoffPack, renderStateSection, readArchive,
	toCRLF, writeWithGuards,
} from './handoff-core.js';

/* ------------------------------------------------------------------ 主流程 */

/**
 * 交接主流程：一条日记 + 一节状态 + 一行生长记录 + 一份交接包。
 *
 * 顺序刻意如此：**备份 → 状态 → 生长记录 → 日记（带指纹）**。幂等标记落在日记
 * 上，日记最后写，半途失败就不会留下"标记在、内容不在"。
 *
 * @param {{root:string,input?:string|object,config?:object,now?:Date,dryRun?:boolean,device?:string,sessionId?:string,mode?:string,expect?:object}} request
 * @returns {Promise<object>} `{ok,skipped,reason,seq,handoff,handoffChars,written,backups,warnings,files}`
 */
export async function processHandoff(request) {
  const {
    root, input, config = {}, now = new Date(), dryRun = false, device = '', sessionId = '', mode = 'live', expect,
  } = request ?? {};
  if (!root) throw new Error('processHandoff：没有档案根（先 detectRoot 或给 config.root）');
  const archive = readArchive(root);
  if (archive.diary === null || archive.state === null) {
    throw new Error(`processHandoff：档案不完整（日记=${archive.diary === null ? '缺' : '在'}、状态=${archive.state === null ? '缺' : '在'}）`);
  }

  const diary = parseDiary(archive.diary);
  const print = fingerprint([sessionId, mode, typeof input === 'string' ? input : JSON.stringify(input ?? {})]);
  const handoff = renderHandoffPack(input, config.handoffMaxChars ?? 1200);
  const warnings = [];
  const files = filePrints(archive);
  const guarded = guardedParts(archive, print);
  if (guarded.length > 0) {
    return {
      ok: true, skipped: true, root, handoff, handoffChars: handoff.length, warnings, files,
      reason: `幂等：${guarded.join(' / ')} 里已有同一份交接的指纹（不重复追加）`,
      seq: metaNumber(diary, 'last_diary_seq'), written: {}, backups: {}, fingerprint: print, dryRun,
    };
  }

  const plan = buildPlan({ archive, diary, input, device, now, handoff, warnings });
  if (dryRun) {
    return {
      ok: true, skipped: true, root, handoff, handoffChars: handoff.length, warnings, dryRun: true, files,
      reason: '干跑（dryRun）：只算不写', seq: plan.seq, written: {}, backups: {}, preview: summarizePlan(plan),
    };
  }

  const backups = createBackups(archive, now);
  // 写前的"该拿什么当基准"：调用方给了跨调用的期望就用它（严格），否则用刚读到的这版。
  const written = writeParts(expect ? { ...archive, ...expect } : archive, plan, print);
  return {
    ok: true, skipped: false, reason: '', root, handoff, handoffChars: handoff.length, warnings, files,
    seq: plan.seq, written, backups, fingerprint: print, dryRun: false,
  };
}

/** 各文件的指纹：调用方留着，下次当 `expect` 传回来即可做跨调用比对。 */
function filePrints(archive) {
  return {
    diary: fingerprint([archive.diary]),
    state: fingerprint([archive.state]),
    growth: fingerprint([archive.growth]),
  };
}

/** 哪些部分已经带同一份指纹（重复跑的直接证据）。 */
function guardedParts(archive, print) {
  const parts = [];
  if (hasFlag(archive.diary, print)) parts.push('日记');
  if (hasFlag(archive.state, print)) parts.push('状态');
  if (hasFlag(archive.growth, print)) parts.push('生长记录');
  return parts;
}

/**
 * 全部内容先在内存里算出来（含"改前/改后"两版），备份与复核都对着同一份预期
 * 比对，不会出现"写了一半才发现算错"。
 */
function buildPlan({ archive, diary, input, device, now, handoff, warnings }) {
  const stamp = localStamp(now);
  const seq = nextDiarySeq(diary);
  if (metaNumber(diary, 'last_diary_seq') === undefined) warnings.push('元信息里没有 last_diary_seq，序号退到"最大标题 + 1"（形状要复核）');
  const total = metaNumber(diary, 'total_count') === undefined ? undefined : metaNumber(diary, 'total_count') + 1;
  if (total === undefined) warnings.push('元信息里没有 total_count，跳过它');

  const fields = diaryFieldsFrom(input, seq, handoff, device, stamp, warnings);
  const newEntry = renderDiaryEntry({ seq, date: stamp.day, time: stamp.clock, device, format: 'full', fields, flag: entryFlag('') });
  return {
    stamp, seq, total, newEntry,
    diaryText: buildDiaryText(archive.diary, diary, { seq, total, newEntry, warnings }),
    stateText: buildStateText(archive.state, { device, stamp, handoff, input, warnings, diaryTotal: total }),
    growthText: buildGrowthText(archive.growth, { device, stamp, input }),
  };
}

/** 六段式取材：**不许编造** —— 缺哪一段就写一句实话，不假造感知。 */
function diaryFieldsFrom(input, seq, handoff, device, stamp, warnings) {
  const source = (input === null || input === undefined || typeof input === 'string') ? { outline: input ?? '' } : input;
  const pending = asList(source.pending);
  const touched = asList(source.touched);
  if (!source.userMood) warnings.push('没给 user_mood：这一栏写的是内容侧的事实，不是编出来的心情');
  return {
    event_description: [
      `上下文占用到阈值，插件自动做了一次交接（第 ${seq} 条，${device || '未标设备'}，${stamp.written}）。`,
      source.outline || '（这一轮的经过没拿到摘要，只记下"发生过一次自动交接"这件事。）',
      touched.length ? `动过：${touched.map((t) => oneLine(t)).join('、')}` : '这一轮没有登记动过的文件或配置。',
    ].join('\n'),
    user_mood: source.userMood || '（这一栏留白：插件不替用户编心情，需要时自己补。）',
    mood_tags: source.moodTags || '自动交接、上下文到阈值',
    notes: [handoff, '', '（这条是插件按阈值写的，是压缩后的接手起点，不是这一轮的全文。）'].join('\n'),
    lively_details: [
      '触发口径：上下文占用到阈值 + 最少轮数 + 过了冷却。',
      pending.length ? `挂着的事：${pending.map((p) => oneLine(p)).join('；')}` : '这一刻没有登记挂着的未收尾项。',
      touched.length ? `动过的文件与配置：${touched.map((t) => oneLine(t)).join('；')}` : '这一轮没有动文件或配置。',
    ],
    mood_tail: source.moodTail || '（交接完成，下一段接着来。）',
  };
}

/** 把任意值收成一行一条的列表。 */
function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value.filter((v) => String(v).trim() !== '') : [value];
}

/** 日记新全文：追加到末尾 + 只改 `last_diary_seq` / `total_count` / `diary_version` 三处。 */
function buildDiaryText(original, diary, { seq, total, newEntry, warnings }) {
  const previous = metaNumber(diary, 'last_diary_seq');
  const previousTotal = metaNumber(diary, 'total_count');
  const edits = [];
  if (previous !== undefined && previous !== seq) {
    const edit = editMetaRow(diary, 'last_diary_seq', seq);
    if (edit) edits.push(edit);
  }
  if (previousTotal !== undefined && total !== undefined) {
    const edit = editMetaRow(diary, 'total_count', total);
    if (edit) edits.push(edit);
  }
  const version = versionEditFor(diary, total, warnings);
  if (version) edits.push(version);

  const out = applyLocalEdits(diary.source, edits);
  const lines = out.split('\n');
  const at = findDiaryAppendIndex(parseDiary(out));
  const gap = at > 0 && lines[at - 1].trim() === '' ? [newEntry] : ['', newEntry];
  lines.splice(at, 0, ...gap);
  return toCRLF(lines.join('\n'));
}

/** `diary_version` 规则：第二位**只在总篇数为 2 的倍数时 +1**，奇数篇不动。 */
function versionEditFor(diary, total, warnings) {
  const current = metaValue(diary, 'diary_version');
  if (current === undefined) { warnings.push('元信息里没有 diary_version，跳过它（规则不清就不改）'); return null; }
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(current);
  if (!match || total === undefined || total % 2 !== 0) return null;
  const next = `${match[1]}.${Number(match[2]) + 1}${match[3] ? `.${match[3]}` : ''}`;
  return editMetaRow(diary, 'diary_version', next);
}

/** 状态新全文：顶部 `last_updated` 同步 + `unfinished` 收口 + 顶部插一节。 */
export function buildStateText(original, { device, stamp, handoff, input, warnings, diaryTotal }) {
  const source = (input === null || input === undefined || typeof input === 'string') ? { outline: input ?? '' } : input;
  const pending = asList(source.pending);
  let out = String(original).replace(/\r\n/g, '\n');
  const previousUpdated = /last_updated:\s*([^\n]+)/.exec(out)?.[1]?.trim();
  if (previousUpdated) out = applyLocalEdits(out, [editLastUpdated(previousUpdated, stamp.written)]);
  else warnings.push('状态顶部没有 last_updated，跳过它（不硬塞字段）');
  // diary_count 的口径是「日记最后一条 seq + 1」（体检器同口径）。自动交接刚写了日记 #N，
  // 这里必须一起同步 —— 否则每次自动交接之后 `体检.py` 都会报「diary_count 漏同步」。
  // ⚠ 2026-09-28 加：08:17 那次真交接就报了（插件写了日记 #78，diary_count 还停在 78，应为 79）。
  if (Number.isFinite(diaryTotal)) {
    if (/diary_count:\s*\d+/.test(out)) out = out.replace(/diary_count:\s*\d+/, `diary_count: ${diaryTotal + 1}`);
    else warnings.push('状态顶部没有 diary_count，跳过它（不硬塞字段）');
  } else {
    warnings.push('拿不到日记的新 seq，diary_count 未同步（体检器会报）');
  }
  if (pending.length > 0) {
    const edit = editUnfinished(out, pending);
    if (edit) out = applyLocalEdits(out, [edit]);
    else warnings.push('状态顶部没有可用的 unfinished 块，未收尾项只进了新节');
  }
  const section = renderStateSection({
    device,
    day: stamp.day,
    clock: stamp.clock,
    title: '自动交接',
    bullets: [
      source.outline || '上下文到阈值，插件自动做了一次交接。',
      `交接包（${handoff.length} 字）：${flattenHandoff(source) || '（空）'}`,
      pending.length ? `挂着：${pending.map((p) => oneLine(p)).join('；')}` : '这一刻没有挂着的未收尾项。',
    ],
  });
  const lines = out.split('\n');
  const insertAt = firstStateSectionIndex(out);
  lines.splice(insertAt < 0 ? lines.length : insertAt, 0, ...`${section}\n\n`.split('\n'));
  return toCRLF(lines.join('\n'));
}

/** 生长记录：**只在末尾追加一行**，既有行一字不动。 */
function buildGrowthText(original, { device, stamp, input }) {
  const source = (input === null || input === undefined || typeof input === 'string') ? { outline: input ?? '' } : input;
  const line = renderGrowthLine({
    day: stamp.day,
    clock: stamp.clock,
    device: device || '【未标设备】',
    what: source.outline || '上下文到阈值自动交接（插件写入）',
    changed: source.changed ?? '是',
    lesson: source.lesson || '交接包只带上限内的接手起点，不搬全文。',
  });
  const body = String(original ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return toCRLF([body, line].filter((part) => part !== '').join('\n'));
}

/** 改前备份三份。备份失败直接抛 —— 宁可这次不写，也不留"改了没退路"。 */
function createBackups(archive, now) {
  const stamp = localStamp(now).fileTag;
  return {
    diary: backupFile(archive.paths.diary, { stamp, backupDir: archive.paths.backupDir }),
    state: backupFile(archive.paths.state, { stamp, backupDir: archive.paths.backupDir }),
    growth: backupFile(archive.paths.growth, { stamp, backupDir: archive.paths.backupDir }),
  };
}

/** 真写：状态 → 生长记录 → 日记（带指纹）；每份写完立刻读回复核。 */
function writeParts(archive, plan, print) {
  const flag = commentFlag(print);
  const stateText = withTrailingFlag(plan.stateText, flag);
  const growthText = withTrailingFlag(plan.growthText, flag);
  const diaryText = plan.diaryText.replace(entryFlag(''), entryFlag(print));
  const written = {};
  writeWithGuards(archive.paths.state, archive.state, archive.state, stateText);
  written.state = true;
  writeWithGuards(archive.paths.growth, archive.growth, archive.growth, growthText, { appendOnly: true });
  written.growth = true;
  writeWithGuards(archive.paths.diary, archive.diary, archive.diary, diaryText, { appendOnly: false });
  written.diary = true;
  return written;
}

/** 在文本末尾另起一行放指纹标记（状态与生长记录都用它）。 */
function withTrailingFlag(text, flag) {
  const body = String(text).replace(/(\r\n|\n)*$/, '');
  return `${body}\r\n${flag}\r\n`;
}

/** 干跑时给日志看的"本来会写什么"。 */
function summarizePlan(plan) {
  const growthLines = plan.growthText.trim().split('\n');
  return {
    seq: plan.seq,
    total: plan.total,
    diaryChars: plan.newEntry.length,
    stateSection: plan.stateText.split('\n').find((line) => /^##[ \t]/.test(line)) ?? '',
    growthLine: growthLines[growthLines.length - 1] ?? '',
  };
}
