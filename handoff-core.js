/**
 * `dsh-auto-handoff` 的纯逻辑内核：认档案根、渲染六段式日记、拼限长交接包、
 * 改前备份、写临时文件再 rename、指纹拒写、幂等。
 *
 * 这个文件**不 import 任何 Harness 包**，所以 `index.js`、模块层自检口、沙盘回归
 * 脚本共用同一份实现 —— 原版就是靠"同一套代码"才敢把测试区验过的东西上真档案。
 *
 * 写盘一律四条硬规矩：改前备份 → 只改定位处 → 写完复核 → 外部改动拒写（指纹比对）；
 * 重复跑不追加第二条（幂等标记落在日记里，重新交接换内容才会再写）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 默认档案根：**刻意不含任何人的路径**，可用环境变量或配置覆盖。 */
export const DEFAULT_ROOT = join(homedir(), '.dsh', 'memory');
/** 环境变量覆盖名（与记忆面板插件共用同一口径）。 */
export const ROOT_ENV = 'DSH_MEMORY_ROOT';
/** 认根用的特征文件：三者齐备才算一份档案。 */
export const ROOT_MARKERS = ['身份.md', join('生长', '状态.md'), '日记.md'];
/** 状态顶部 `unfinished:` 块的收尾符（引擎靠它划边界，见记忆接口备忘 5.2）。 */
export const UNFINISHED_END = '```';
/** 写盘用临时文件的前缀（同目录，保证 rename 不跨卷）。 */
const TMP_PREFIX = '.dsh-handoff-tmp';
/** 日志单行上限，防止把整篇正文写进一行。 */
const LOG_SNIPPET_MAX = 80;

/* ------------------------------------------------------------------ 小工具 */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 时间偏移（分钟）。**2026-09-27 手机侧实测抓到的一刀**：宿主 node 进程的 TZ 可能是空的
 * （V40 上就是 UTC），而档案的时间口径是「手机上时间」（容器 UTC+8）—— 不补就会把插件写的
 * 日记 / 状态节 / 生长记录行全部写成早 8 小时的时间戳（副本 #58 写 11:10、真手机时间 19:10）。
 * PC 侧宿主本地时间本来就是墙上时间，配置默认 0，两边行为一致。
 * ⚠ 这一刀是**手机侧专有**：PC 那版 core 里没有它，合模块时别丢（丢了时间戳就会差 8 小时）。
 */
let stampOffsetMinutes = 0;

/** 由插件配置 `timeOffsetHours` 在 apply 时设一次（认不出的值退回 0，不抛）。 */
export function setStampOffsetMinutes(minutes) {
  stampOffsetMinutes = Number.isFinite(minutes) ? minutes : 0;
}

/** 本地时钟样本：`YYYY-MM-DD HH:MM`、备份后缀 `YYYYMMDD-HHMMSS`（带上 `timeOffsetHours` 偏移）。 */
export function localStamp(date = new Date()) {
  const at = stampOffsetMinutes === 0 ? date : new Date(date.getTime() + stampOffsetMinutes * 60_000);
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const fileTag = `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}-`
    + `${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
  return { day, clock, fileTag, written: `${day} ${clock}` };
}

/** 归一化行尾到 CRLF（档案的既定行尾；LF 源文本也照此写出）。 */
export function toCRLF(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/** 取源文本的行尾风格 —— 写回时要一致，否则文件变成混合行尾。 */
export function eolOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n';
}

/** 取路径末段（兼容正反斜杠）。 */
export function pathLeaf(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 单行化：日志里只留一行，避免把多行正文带进日志。 */
export function oneLine(text, max = LOG_SNIPPET_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 内容指纹：16 位 sha256 前缀，用来判"这份输入是不是已经写过了"。 */
export function fingerprint(parts) {
  return createHash('sha256').update(parts.filter(Boolean).join('\u0000'), 'utf8').digest('hex').slice(0, 16);
}

/* -------------------------------------------------------------- 认档案根 */

/** 一个目录是不是档案根：三件特征文件必须齐（不齐不算，不猜）。 */
export function isArchiveRoot(dir) {
  if (typeof dir !== 'string' || dir.trim() === '' || !existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return ROOT_MARKERS.every((marker) => existsSync(resolve(join(dir, marker))));
}

/**
 * 认档案根。优先级：显式参数 → `config.root` → 环境变量 → 默认目录 → 从 start
 * 逐级向上找特征文件。**全都认不到就返回 undefined** —— 宁可不动，也不拿一个猜
 * 出来的根去写真档案。
 *
 * @param {string|{root?:string}} [explicit] 显式根，或带 `root` 的配置对象。
 * @param {{ env?: object, start?: string, fallback?: string }} [options]
 * @returns {string|undefined} 绝对路径，或 undefined。
 */
export function detectRoot(explicit, options = {}) {
  const env = options.env ?? process.env;
  const configured = typeof explicit === 'string' ? explicit : explicit?.root;
  const candidates = [configured, env[ROOT_ENV], options.fallback ?? DEFAULT_ROOT];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && isArchiveRoot(candidate)) return resolve(candidate);
  }
  for (const step of ancestors(options.start ?? process.cwd())) if (isArchiveRoot(step)) return resolve(step);
  return undefined;
}

/** 从某个目录向上（含自身）列举候选目录。 */
function ancestors(start) {
  const list = [];
  let dir = resolve(start);
  for (;;) {
    list.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return list;
}

/* ------------------------------------------------------------ 档案定位与读 */

/** 由根算出各文件的绝对路径（只拼路径，不碰盘）。 */
export function archivePaths(root) {
  return {
    root,
    identity: join(root, '身份.md'),
    diary: join(root, '日记.md'),
    state: join(root, '生长', '状态.md'),
    growth: join(root, '生长', '生长记录.md'),
    backupDir: join(root, '归档-旧版本与记录', '写入备份'),
  };
}

/** 读文本并剥掉可能的 BOM（档案要求无 BOM，别把别人的 BOM 当内容）。 */
export function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 四份文件的内容快照（缺件记 null，由调用方决定怎么办 —— 不替它编内容）。 */
export function readArchive(root) {
  const paths = archivePaths(root);
  const read = (file) => (existsSync(file) ? readText(file) : null);
  return {
    paths,
    identity: read(paths.identity),
    diary: read(paths.diary),
    state: read(paths.state),
    growth: read(paths.growth),
  };
}

/* --------------------------------------------------------------- 日记解析 */

/** 日记标题行：`### #N ｜ 日期 ｜ 时间 ｜ …`（全角/半角竖线都认）。 */
const DIARY_HEAD = /^###[ \t]*#(\d+)[ \t]*[｜|][ \t]*(.*?)[ \t]*[｜|][ \t]*(.*?)[ \t]*[｜|][ \t]*(\S+)[ \t]*$/;
/** 元信息表格行：`| 字段 | 值 |` —— 值可能带尾注释，原样保留、只换数字。 */
const META_ROW = /^[ \t]*\|[ \t]*([A-Za-z0-9_]+)[ \t]*\|([^|]*)\|[ \t]*$/;

/**
 * 解析日记：既有条目、元信息表、末条位置。
 *
 * 标题有两种形状（`#1`~`#35` 四段、`#36` 起五段带 `【设备】`），所以**按分隔符切段
 * 再认**，不写死段数 —— 原版第一版固定段数正则把 `【PC】` 吃进了 `format`。
 */
export function parseDiary(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const meta = { start: -1, end: -1, entries: new Map() };
  const titles = [];
  let lastEntryIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const row = META_ROW.exec(line);
    if (row) {
      if (meta.start < 0) meta.start = index;
      meta.end = index;
      const raw = row[2];
      const lead = raw.length - raw.trimStart().length;
      const start = line.indexOf(raw);
      meta.entries.set(row[1], {
        lineIndex: index,
        raw: line,
        value: raw.trim(),
        // 值的精确字位：只换这一段，行尾注释（例如 `43  # 反推值`）原样保留。
        valueSpan: [start + lead, start + raw.length - (raw.length - raw.trimEnd().length)],
      });
    }
    const head = DIARY_HEAD.exec(line);
    if (head) {
      const segments = line.replace(/^###[ \t]*/, '').split(/[｜|]/).map((s) => s.trim());
      titles.push({
        index,
        line,
        seq: Number(head[1]),
        date: segments[1] ?? '',
        time: segments[2] ?? '',
        device: segments.length >= 5 ? segments[3] : '',
        format: segments[segments.length - 1],
      });
      lastEntryIndex = index;
    }
  }
  return { source, lines, meta, titles, lastEntryIndex };
}

/** 序号连续性检查（只看相邻两条是否差一）。 */
export function seqGaps(titles) {
  const gaps = [];
  for (let i = 1; i < titles.length; i += 1) {
    if (titles[i].seq !== titles[i - 1].seq + 1) gaps.push(`${titles[i - 1].seq}→${titles[i].seq}`);
  }
  return gaps;
}

/** 读一处元信息的值（读不到返回 undefined）。 */
export function metaValue(parsed, key) {
  return parsed.meta.entries.get(key)?.value;
}

/** 读一处元信息的数字值；不是纯数字就返回 undefined（不硬解析）。 */
export function metaNumber(parsed, key) {
  const raw = metaValue(parsed, key);
  if (raw === undefined) return undefined;
  const digits = /^(\d+)$/.exec(raw)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * 下一个日记序号：**以 `last_diary_seq` 为准** + 1（别猜）。
 * 元信息缺失时退到"最大标题序号 + 1"，并在结果里留警告。
 */
export function nextDiarySeq(parsed) {
  const declared = metaNumber(parsed, 'last_diary_seq');
  if (declared !== undefined) return declared + 1;
  return parsed.titles.reduce((max, t) => (t.seq > max ? t.seq : max), 0) + 1;
}

/* -------------------------------------------------------------- 六段式渲染 */

/** full 的六个字段，顺序即档案里的顺序（备忘第 4 节逐字确认）。 */
export const DIARY_FIELDS = ['event_description', 'user_mood', 'mood_tags', 'notes', 'lively_details', 'mood_tail'];

/** 字段值可以是字符串或字符串数组（`lively_details` 常态是 bullet 列表）。 */
function renderField(name, value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split('\n');
  const kept = raw.map((line) => String(line).replace(/\s+$/, '')).filter((line) => line.trim() !== '');
  const body = name === 'lively_details'
    ? kept.map((line) => (/^[-*]\s/.test(line.trim()) ? line.trim() : `- ${line.trim()}`))
    : kept;
  return [`**${name}**`, ...body];
}

/**
 * 渲染一条日记（六段式）。字段名是**整行只有 `**名字**`**、字段之间空一行 ——
 * 这是档案解析器的硬形状。
 *
 * @param {{seq:number,date:string,time:string,device?:string,format?:string,fields:object,flag?:string}} entry
 * @returns {string} 标题行开头、正文结尾（不带前导/尾随换行）。
 */
export function renderDiaryEntry(entry) {
  const { seq, date, time, device = '', format = 'full', fields = {}, flag = '' } = entry;
  const segments = [`#${seq}`, date, time];
  if (device) segments.push(device);
  segments.push(format);
  const blocks = DIARY_FIELDS.filter((name) => fields[name] !== undefined).map((name) => renderField(name, fields[name]));
  const body = blocks.flatMap((block, i) => (i === 0 ? block : ['', ...block]));
  return [`### ${segments.join(' ｜ ')}`, '', ...body, ...(flag ? ['', flag] : [])].join('\n');
}

/* -------------------------------------------------------------- 交接包渲染 */

/** 交接包五栏。**只有它进新会话** —— 新会话一开就吃满上下文等于把坑搬过去。 */
export const HANDOFF_KEYS = ['outline', 'pending', 'touched', 'preferences', 'next'];
/** 栏名（内部键 → 中文标签），渲染与摊平共用一处，免得两边口径打架。 */
export const HANDOFF_LABELS = {
  outline: '这一轮在做什么',
  pending: '挂着的',
  touched: '动过的文件与配置',
  preferences: '用户的偏好与纠正',
  next: '下一步第一件事',
};

/** 单栏渲染：接受字符串、字符串数组，或它们的混合。 */
function renderPackRow(key, value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split('\n');
  const kept = items.map((line) => String(line).trim()).filter((line) => line !== '');
  if (kept.length === 0) return '';
  return [`【${HANDOFF_LABELS[key]}】`, ...kept.map((line) => (/^[-*\d]/.test(line) ? line : `- ${line}`))].join('\n');
}

/** 按上限截断：保留前面的栏，末栏留省略号 —— 不许把包撑成全文。 */
export function boundHandoff(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : Infinity;
  const source = String(text ?? '');
  if (source.length <= limit) return source;
  const note = '…（交接包到上限，余下留给你自己从档案里读）';
  return `${source.slice(0, Math.max(0, limit - note.length))}${note}`;
}

/**
 * 拼交接包。输入可以是一段现成文本（当作 `大纲`），也可以是
 * `{outline, pending, touched, preferences, next}`。
 */
export function renderHandoffPack(input, maxChars = 1200) {
  const source = (input === null || input === undefined || typeof input === 'string') ? { outline: input ?? '' } : input;
  const rows = HANDOFF_KEYS.map((key) => renderPackRow(key, source[key])).filter(Boolean);
  if (rows.length === 0) return boundHandoff('（交接包为空）', maxChars);
  return boundHandoff(rows.join('\n\n'), maxChars);
}

/** 摊平成一行摘要，给日志/预演这类不读结构化交接包的地方用。 */
export function flattenHandoff(input) {
  if (typeof input === 'string') return oneLine(input);
  return HANDOFF_KEYS
    .filter((key) => input?.[key])
    .map((key) => `${HANDOFF_LABELS[key]}：${oneLine(input[key])}`)
    .join(' ｜ ');
}

/* -------------------------------------------------------- 写盘三件套（内核） */

/** 备份名：`<文件名>.bak-YYYYMMDD-HHMMSS`（与档案既有 `.bak-*` 同款）。 */
export function backupName(file, stamp) {
  return `${file}.bak-${stamp}`;
}

/** 写盘一律"写临时文件再 rename"：**不赌覆盖式写入**（原版在用户那台实测过间歇性 EINVAL）。 */
export function atomicWriteFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `${TMP_PREFIX}-${process.pid}-${Date.now()}-${pathLeaf(file)}`);
  try {
    writeFileSync(tmp, toCRLF(text), 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 临时件清不掉不影响判断 */ }
    throw error;
  }
}

/**
 * 改前备份：整份复制。**备份失败就抛** —— 宁可这次不写，也不留"改了没退路"。
 * 放在 `<根>\归档-旧版本与记录\写入备份\`（与记忆面板同款约定）。
 */
export function backupFile(file, { stamp, backupDir } = {}) {
  if (!existsSync(file)) return null;
  const tag = stamp ?? localStamp().fileTag;
  const target = backupDir ? join(backupDir, `${pathLeaf(file)}.bak-${tag}`) : backupName(file, tag);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(file));
  return target;
}

/**
 * 只改定位处：把 `expected` 换成 `replacement`。
 * **0 处或多处命中都停手**，绝不"差不多就改"。
 */
export function replaceOnce(text, expected, replacement) {
  const source = String(text).replace(/\r\n/g, '\n');
  const needle = String(expected).replace(/\r\n/g, '\n');
  if (needle === '') throw new Error('replaceOnce：定位串为空（拒改）');
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`replaceOnce：定位处 0 命中（拒改）｜${oneLine(needle)}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`replaceOnce：定位处多处命中（拒改）｜${oneLine(needle)}`);
  return `${source.slice(0, first)}${String(replacement).replace(/\r\n/g, '\n')}${source.slice(first + needle.length)}`;
}

/**
 * 写完复核：新内容必须能由旧内容"只改一处"推出来 —— 前后各留一段与旧文**逐字相同**
 * 的公共首尾，中间才是我们改的那处。对不上就抛：复核的作用是抓"我根本没改对地方"，
 * 不是走个过场。
 */
export function verifyEdit(oldText, newText, where = '档案') {
  const before = String(oldText ?? '').replace(/\r\n/g, '\n');
  const after = String(newText ?? '').replace(/\r\n/g, '\n');
  if (before === '' || after.startsWith(before) || after.endsWith(before)) return;
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  // 首尾之外必须刚好覆盖旧文的整个中间段（即"只替换了 [head, before.length-tail) 这一处"）。
  if (before.length - tail >= head) return;
  throw new Error(`复核不过：${where} 的新内容不是"只改一处"能得到的（拒写）`);
}

/**
 * 写完复核（形状二选一）：
 * - `appendOnly`：新内容必须**以旧内容为前缀**（只允许追加，既有内容一字未动）；
 * - 否则：按"只改一处"复核。
 */
export function verifyShape(oldText, newText, { appendOnly = false, where = '档案' } = {}) {
  const before = String(oldText ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const after = String(newText ?? '').replace(/\r\n/g, '\n');
  if (appendOnly) {
    if (before !== '' && !after.startsWith(before)) throw new Error(`复核不过：${where} 的既有内容被改动了（只允许追加）`);
    return;
  }
  verifyEdit(oldText, newText, where);
}

/** 读回复核：文件现在必须**逐字等于**我们算出来的内容。 */
export function verifyWritten(file, expected) {
  if (!existsSync(file)) throw new Error(`复核不过：${pathLeaf(file)} 没写出来`);
  const actual = readText(file);
  if (actual.replace(/\r\n/g, '\n') !== String(expected).replace(/\r\n/g, '\n')) {
    throw new Error(`复核不过：${pathLeaf(file)} 落盘内容与预期不一致`);
  }
  return actual;
}

/**
 * 一次受护写的完整闭环：**指纹拒写 → 写临时件再 rename → 读回复核 → 形状复核**。
 * 每一步失败都抛，调用方负责把"哪一步失败"如实报出来。
 */
export function writeWithGuards(file, expectedOnDisk, originalText, nextText, { appendOnly = false } = {}) {
  const current = existsSync(file) ? readText(file) : null;
  assertUnchanged(file, current, expectedOnDisk);
  atomicWriteFile(file, nextText);
  verifyWritten(file, nextText);
  verifyShape(originalText, nextText, { appendOnly, where: pathLeaf(file) });
  return readText(file);
}

/* --------------------------------------------------- 定位：日记与状态插入点 */

/**
 * 日记条目追加在**最后一条之后**（序号升序、旧的在前）。
 *
 * 注意"之后"是整个条目的之后：上一版从标题行往后跳过空行就插，结果新条目被塞进了
 * 末条正文**里面**（`### #2` 的正文后面突然接 `### #3`）—— 形状错了但条数看着对，
 * 只有肉眼能发现，所以这里必须一路找到"下一个标题或文件末尾"，再回退掉尾部空行。
 */
export function findDiaryAppendIndex(parsed) {
  const { lines } = parsed;
  let next = parsed.lastEntryIndex + 1;
  while (next < lines.length && !/^###[ \t]/.test(lines[next])) next += 1;
  while (next > parsed.lastEntryIndex + 1 && lines[next - 1].trim() === '') next -= 1;
  return next;
}

/** 文本里最后一个日记标题的行号（判断 append 位置时用）。 */
export function lastEntryLineOf(lines) {
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) if (DIARY_HEAD.test(lines[i])) last = i;
  return last;
}

/** 状态第一节的位置（新节插在它前面，永远在最上面）。 */
export function firstStateSectionIndex(stateText) {
  return String(stateText ?? '').replace(/\r\n/g, '\n').split('\n').findIndex((line) => /^##[ \t]/.test(line));
}

/** `unfinished:` 块的收尾 ``` 行号（引擎靠这个边界解析，见备忘 5.2）。 */
export function findUnfinishedEndIndex(stateText) {
  const lines = String(stateText ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^unfinished:/.test(line));
  if (start < 0) return -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    // ⚠ 2026-09-28 加的护栏：**状态节的标题也以 `#` 开头**。缺结束标记时若一路吃到底，
    //    `editUnfinished` 的重建会把每节的正文全丢掉（只留下被当成"注释"的标题）——
    //    真发生过一次：一次交接让 54 个节变成空壳，事后靠备份才补回来。
    //    所以：**遇到第一个 `## ` 节就停**，返回 -1（＝没有可用边界，调用方跳过 unfinished 收口）。
    if (/^##[ \t]/.test(lines[i])) return -1;
    if (lines[i].trim() === UNFINISHED_END) return i;
  }
  return -1;
}

/** 由若干 `{expected, replacement}` 组成的一次定位改写：每处都要求命中且唯一。 */
export function applyLocalEdits(text, edits) {
  let out = String(text);
  for (const { expected, replacement } of edits) out = replaceOnce(out, expected, replacement);
  return out;
}

/** 只改一处字段值的行内改写（保留行尾注释，例如 `43  # 反推值`）。 */
export function editMetaRow(parsed, key, nextValue) {
  const row = parsed.meta.entries.get(key);
  if (!row) return null;
  const [from, to] = row.valueSpan;
  return { expected: row.raw, replacement: `${row.raw.slice(0, from)}${nextValue}${row.raw.slice(to)}`, previous: row.value };
}

/** `last_updated:` 那一行的改写（拿旧值回定位，免得改错行）。 */
export function editLastUpdated(previousValue, nextValue) {
  return { expected: `last_updated: ${previousValue}`, replacement: `last_updated: ${nextValue}` };
}

/**
 * `unfinished:` 块整体替换（保留块里的注释行 —— 那些不是未收尾项）。
 *
 * **收尾的 ``` 必须跟着一起放回去**：引擎靠它划块的边界，丢了的话后面的节会被
 * 当成 unfinished 的一部分（备忘 5.2 写明这条前提）。这个坑当场踩过一次。
 */
export function editUnfinished(stateText, items) {
  const lines = String(stateText).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^unfinished:/.test(line));
  const end = findUnfinishedEndIndex(stateText);
  if (start < 0 || end < 0) return null;
  const comments = lines.slice(start + 1, end).filter((line) => /^\s*#/.test(line));
  const body = items.flatMap((item) => String(item).split('\n')).map((line) => `  - ${line.trim()}`);
  return {
    expected: lines.slice(start, end + 1).join('\n'),
    replacement: ['unfinished:', ...comments, ...body, lines[end].trim()].join('\n'),
  };
}

/* ------------------------------------------------------------ 节与记录行渲染 */

/** 状态新节：`## 【设备】日期 时间 · 自动交接`（节内 bullet，节与节之间空行）。 */
export function renderStateSection({ device, day, clock, title, bullets }) {
  const head = `## ${device ? `${device}${day} ${clock}` : `${day} ${clock}`} · ${title}`;
  const items = bullets.flatMap((b) => String(b).split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `- ${line.replace(/^[-*]\s*/, '')}`);
  return [head, ...items].join('\n');
}

/** 生长记录一行：`时间 | 【设备】 | 做了什么 | 是/否有真实改变 | 教训`。 */
export function renderGrowthLine({ day, clock, device, what, changed, lesson }) {
  return `${day} ${clock} | ${device} | ${oneLine(what, 400)} | ${changed} | ${oneLine(lesson, 400)}`;
}

/* -------------------------------------------------------------- 指纹与幂等 */

/** 日记里的指纹标记：独占一行（正文里不出现即可，日记是追加型所以不会丢）。 */
export function entryFlag(print) {
  return `<!-- dsh-auto-handoff ${print} -->`;
}

/** 状态/生长记录里的指纹标记（HTML 注释，不打扰任何解析器）。 */
export function commentFlag(print) {
  return `<!-- dsh-auto-handoff ${print} -->`;
}

/** 指纹是否已在某份文本里（幂等靠它，不靠时间窗 —— 时间窗一错过就永久失效）。 */
export function hasFlag(text, print) {
  return typeof text === 'string' && print !== '' && text.includes(print);
}

/**
 * 指纹拒写：文件现在的内容必须与"我们读到的"逐字一致。
 * 不一致 = 有别人在我们读之后动过它（用户、外部编辑器、另一个插件）→ 拒写。
 */
export function assertUnchanged(file, currentText, expectedText) {
  const now = String(currentText ?? '').replace(/^\uFEFF/, '');
  const seen = String(expectedText ?? '').replace(/^\uFEFF/, '');
  if (now.replace(/\r\n/g, '\n') !== seen.replace(/\r\n/g, '\n')) {
    throw new Error(`外部改动拒写：${pathLeaf(file)} 在我们读过之后被改过（指纹不符）`);
  }
}


/* 2026-09-28 拆分：主流程搬去 `handoff-plan.js`；这里再导出一次，对外接口不变。 */
export { buildStateText, processHandoff } from './handoff-plan.js';
