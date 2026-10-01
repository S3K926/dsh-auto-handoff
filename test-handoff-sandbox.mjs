/**
 * `dsh-auto-handoff` 沙盘回归自检（**真跑**，不是看代码）。
 *
 * 在系统临时目录里造一份假档案（`身份.md` + `日记.md` + `生长\状态.md` + `生长\生长记录.md`，
 * UTF-8 无 BOM + CRLF），把交接主流程整条跑一遍，逐项验：
 * 认根 / 六段式 / 限长 / 元信息 / 幂等 / 备份 / 指纹拒写 / 真档案一字未动 / 临时目录清干净。
 *
 * 两种跑法：
 *   node test-handoff-sandbox.mjs          只看 "N 项全过" 的结论
 *   node test-handoff-sandbox.mjs --verbose 每项都打实际输出（交验收用）
 *   node index.js --selftest               走同一个 run()（自检口在模块层，不在 apply 里）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  entryFlag, detectRoot, hasFlag, parseDiary, metaNumber, metaValue, nextDiarySeq,
  processHandoff, readText, seqGaps, writeWithGuards,
} from './handoff-core.js';

/** 档案的行尾与编码（备忘实测：CRLF + UTF-8 无 BOM）。 */
const NL = '\r\n';
const crlf = (text) => text.replace(/\n/g, NL);
const sha = (text) => createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 16);
const bytes = (file) => (existsSync(file) ? statSync(file).size : -1);
const hashOf = (file) => (existsSync(file) ? sha(readFileSync(file, 'utf8')) : '(缺)');

/** 假档案的三个特征文件与两份可选文件。 */
function scaffold(root) {
  mkdirSync(join(root, '生长'), { recursive: true });
  writeFileSync(join(root, '身份.md'), crlf('# 身份（沙盘假件）\n\n这份档案只活在临时目录里，跑完就删。\n'), 'utf8');
  writeFileSync(join(root, '日记.md'), crlf(DIARY_FIXTURE), 'utf8');
  writeFileSync(join(root, '生长', '状态.md'), crlf(STATE_FIXTURE), 'utf8');
  writeFileSync(join(root, '生长', '生长记录.md'), crlf(GROWTH_FIXTURE), 'utf8');
}

const DIARY_FIXTURE = `# 日记（沙盘假件）

## 元信息

| 字段 | 值 |
|---|---|
| owner_character | 沙盘 |
| diary_version | 3.0 |
| last_diary_seq | 2 |
| total_count | 2 |
| privacy | 只对用户本人展示 |

## 日记

### #1 ｜ 2026-09-01 ｜ 10:00 ｜ full

**event_description**
这是沙盘里第一条旧日记，用来验"既有内容一字未动"。

**user_mood**
平静

**mood_tags**
沙盘、旧条目

**notes**
无

**lively_details**
- 旧细节一

**mood_tail**
（旧尾巴一）

---

### #2 ｜ 2026-09-02 ｜ 11:00 ｜ 【PC】 ｜ full

**event_description**
这是沙盘里第二条旧日记，标题带设备标签（五段式），用来验标题解析不吃错字段。

**user_mood**
平静

**mood_tags**
沙盘、五段式

**notes**
无

**lively_details**
- 旧细节二

**mood_tail**
（旧尾巴二）
`;

const STATE_FIXTURE = `<!-- 沙盘假件：顶部这段注释不是 unfinished 块的一部分。 -->

# 状态（沙盘假件）

\`\`\`yaml
last_updated: 2026-09-02 11:00
diary_count: 3
mood_base: 沙盘里不累也不空
unfinished:
  # 下面这条是旧的未收尾项，收尾时要被替换掉
  - 旧的没收尾项
  - 另一条旧的没收尾项
\`\`\`

## 【PC】2026-09-02 11:00 · 旧的一节

- 旧内容一
- 旧内容二

## 2026-09-01 · 更旧的一节

- 更旧的内容
`;

const GROWTH_FIXTURE = '2026-09-01 10:00 | 【PC】 | 旧的一行 | 是 | 旧教训一\n'
  + '2026-09-02 11:00 | 【PC】 | 旧的两行 | 是 | 旧教训二\n';

/** 交接包素材（刻意带上"挂着的""动过的""下一步"，把五栏都喂满）。 */
const INPUT = {
  outline: '在沙盘里验自动交接的整条流程',
  pending: ['把 test-handoff-sandbox.mjs 收尾', '复核 diary_version 规则'],
  touched: ['handoff-core.js', 'index.js', 'cordis.patch.yml'],
  preferences: ['写档案一律先备份', '交接包不许粘全文'],
  next: '跑一次 node index.js --selftest',
  userMood: '沙盘里不用猜心情，这一栏照实写',
  moodTags: '沙盘、自动交接、回归',
  moodTail: '（沙盘跑完了。）',
};

/** 一次断言：把"实际是什么"原样记下来，供验收逐条看。 */
function makeCheck(results) {
  return (label, actual, expect) => {
    const passed = typeof expect === 'function' ? Boolean(expect(actual)) : actual === expect;
    results.push({ label, actual: String(actual), passed });
    return passed;
  };
}

/** 取"第一条日记标题"起的全文（元信息在它之前，那两行本来就该变）。 */
function fromFirstEntry(text) {
  const flat = String(text).replace(/\r\n/g, '\n');
  const at = flat.search(/^### #\d+[ \t]*[｜|]/m);
  return at < 0 ? flat : flat.slice(at);
}

/** 取新条目（`### #3`）那一段 —— 先归一化行尾再找，否则 `\S+$` 会被 `\r` 顶掉。 */
function fromFirstNewEntry(text) {
  const flat = String(text).replace(/\r\n/g, '\n');
  const at = flat.indexOf('### #3 ');
  return at < 0 ? '' : flat.slice(at);
}

/** 逐行比对"旧文应是新文前缀"：返回第一处不同的行，前缀关系成立则返回 null。 */
function firstDiffLine(before, after) {
  const oldLines = String(before).split('\n');
  const newLines = String(after).split('\n');
  for (let i = 0; i < oldLines.length; i += 1) {
    if (newLines[i] !== oldLines[i]) return `第 ${i + 1} 行不同：旧「${oldLines[i]}」新「${newLines[i] ?? '(无)'}」`;
  }
  return null;
}

/** 假 ctx：把 apply 注册的路由与监听接住，好在没有宿主的场合也走一遍接线。 */
async function fakeHost(ctxRoot) {
  const routes = new Map();
  const listeners = new Map();
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
  };
  const { apply } = await import('./index.js');
  apply(ctx, { root: ctxRoot, device: '【PC】', dryRun: true });
  return { routes, listeners };
}

/**
 * 跑完整套回归。
 * @param {{ verbose?: boolean }} [options] verbose=true 时每项都打实际输出。
 * @returns {Promise<{total:number, passed:number, failed:string[], results:Array}>}
 */
export async function run(options = {}) {
  const verbose = Boolean(options.verbose);
  const results = [];
  const check = makeCheck(results);
  const say = (line) => { if (verbose) console.log(line); };
  const base = mkdtempSync(join(tmpdir(), 'dsh-handoff-sandbox-'));
  const root = join(base, '档案沙盘');
  const outside = join(base, '真档案占位');
  let host = null;
  try {
    scaffold(root);
    host = await fakeHost(root).catch(() => null);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, '哨兵.txt'), '真档案在这套脚本里不该被写\n', 'utf8');

    const paths = {
      diary: join(root, '日记.md'),
      state: join(root, '生长', '状态.md'),
      growth: join(root, '生长', '生长记录.md'),
      identity: join(root, '身份.md'),
      backups: join(root, '归档-旧版本与记录', '写入备份'),
    };
    const before = Object.fromEntries(Object.entries(paths).filter(([k]) => k !== 'backups').map(([k, f]) => [k, readFileSync(f, 'utf8')]));
    const beforeHashes = Object.fromEntries(Object.keys(before).map((k) => [k, sha(before[k])]));

    /* 1 · 认根 */
    const detected = detectRoot(root, { env: {} });
    say(`1. 认根：detectRoot(${root}) → ${detected}`);
    check('认根：三件特征文件齐备的目录被认出来', detected === root.replace(/\\+$/, ''), true);
    const notArchive = detectRoot(outside, { env: {} });
    say(`1b. 认根：只有哨兵文件的目录 → ${notArchive ?? 'undefined（正确）'}`);
    check('认根：没有特征文件的目录认不出来（不猜）', notArchive, undefined);
    const viaEnv = detectRoot(undefined, { env: { DSH_MEMORY_ROOT: root } });
    say(`1c. 认根：DSH_MEMORY_ROOT 覆盖 → ${viaEnv}`);
    check('认根：环境变量 DSH_MEMORY_ROOT 能用', viaEnv === root.replace(/\\+$/, ''), true);
    const defaultRootNoPersonal = detectRoot(undefined, { env: {}, start: base });
    say(`1d. 认根：不配任何东西时从 cwd 向上找 → ${defaultRootNoPersonal}`);
    check('认根：路径里不含任何人的个人目录', !String(defaultRootNoPersonal ?? '').includes('大肥鱼'), true);

    /* 2 · 干跑不写盘 */
    const stamp = new Date(2026, 8, 25, 22, 4, 5);
    const dry = await processHandoff({ root, input: INPUT, config: { handoffMaxChars: 1200 }, sessionId: 'sandbox-s1', device: '【PC】', now: stamp, dryRun: true });
    const afterDry = Object.fromEntries(Object.keys(before).map((k) => [k, sha(readFileSync(paths[k], 'utf8'))]));
    say(`2. 干跑：seq=${dry.seq} 日记 ${dry.preview?.diaryChars} 字 交接包 ${dry.handoffChars} 字 → ${dry.reason}`);
    check('干跑：算出下一条序号 = 3', dry.seq, 3);
    check('干跑：三份文件指纹都没变（一字未写）', JSON.stringify(afterDry) === JSON.stringify(beforeHashes), true);
    check('干跑：没有生成备份目录', existsSync(paths.backups), false);

    /* 3 · 真跑 */
    const real = await processHandoff({ root, input: INPUT, config: { handoffMaxChars: 1200 }, sessionId: 'sandbox-s1', mode: 'live', device: '【PC】', now: stamp });
    const afterDiary = readFileSync(paths.diary, 'utf8');
    const afterState = readFileSync(paths.state, 'utf8');
    const afterGrowth = readFileSync(paths.growth, 'utf8');
    const parsed = parseDiary(afterDiary);
    const newTitles = parsed.titles;
    say(`3. 真跑：skipped=${real.skipped} seq=${real.seq} 警告=${JSON.stringify(real.warnings)} 备份=${Object.values(real.backups).filter(Boolean).length} 份`);

    check('真跑：写进去了（不是跳过）', real.skipped, false);
    check('真跑：日记标题数 2 → 3', newTitles.length, 3);
    check('真跑：序号仍连续（1,2,3）', JSON.stringify(newTitles.map((t) => t.seq)), JSON.stringify([1, 2, 3]));
    check('真跑：新条目加在最后一条**之后**', newTitles[newTitles.length - 1].seq === 3, true);
    check('真跑：序号没有缺口', seqGaps(newTitles).length, 0);
    check('真跑：旧日记正文一字未动（两条旧正文都还在）', afterDiary.includes('这是沙盘里第一条旧日记') && afterDiary.includes('这是沙盘里第二条旧日记'), true);
    // 元信息那两行本来就该变，所以"旧内容未动"要比**正文区**而不是整个文件。
    const bodyDiff = firstDiffLine(fromFirstEntry(before.diary), fromFirstEntry(afterDiary));
    say(`3b. 正文区逐行对比：${bodyDiff ?? '完全一致（旧条目一字未动，新条目追加在后）'}`);
    check('真跑：正文区从第一条旧日记起逐字未动（只追加）', bodyDiff, null);

    /* 4 · 六段式形状 */
    const tail = fromFirstNewEntry(afterDiary);
    const fields = ['event_description', 'user_mood', 'mood_tags', 'notes', 'lively_details', 'mood_tail'];
    const positions = fields.map((name) => tail.indexOf(`**${name}**`));
    say(`4. 六段式：标题行=${/^### #3[^\n]*/.exec(tail)?.[0] ?? '（没找到）'}`);
    say(`4b. 六段式位置：${fields.map((n, i) => `${n}@${positions[i]}`).join('  ')}`);
    check('六段式：标题形状是 `### #N ｜ 日期 ｜ 时间 ｜ 设备 ｜ full`', /^### #3 ｜ \d{4}-\d{2}-\d{2} ｜ \d{2}:\d{2} ｜ 【PC】 ｜ full$/.test(/^### #3[^\n]*/.exec(tail)?.[0] ?? ''), true);
    check('六段式：六个字段全在', positions.every((p) => p >= 0), true);
    check('六段式：字段顺序与档案一致', positions.every((p, i) => i === 0 || p > positions[i - 1]), true);

    /* 5 · 元信息 */
    const seqValue = metaNumber(parsed, 'last_diary_seq');
    const totalValue = metaNumber(parsed, 'total_count');
    const versionValue = metaValue(parsed, 'diary_version');
    say(`5. 元信息：last_diary_seq=${seqValue} total_count=${totalValue} diary_version=${versionValue}`);
    check('元信息：last_diary_seq 跟着 +1（2 → 3）', seqValue, 3);
    check('元信息：total_count 跟着 +1（2 → 3）', totalValue, 3);
    check('元信息：总篇数 3 是奇数 → diary_version 不动（3.0）', versionValue, '3.0');
    check('元信息：结果里的 seq 与落盘一致', real.seq === seqValue, true);

    /* 6 · 状态节 */
    const sections = afterState.replace(/\r\n/g, '\n').split('\n').filter((line) => /^## /.test(line));
    const lastUpdated = /last_updated:\s*([^\n]+)/.exec(afterState)?.[1]?.trim();
    const unfinished = /^unfinished:[\s\S]*?^```/m.exec(afterState.replace(/\r\n/g, '\n'))?.[0] ?? '';
    say(`6. 状态节顺序：${sections.join(' ⟩ ')}`);
    say(`6b. last_updated → ${lastUpdated}`);
    say(`6c. unfinished 块 → ${JSON.stringify(unfinished)}`);
    check('状态：新节插在**所有旧节之前**（最上面）', sections[0] === '## 【PC】2026-09-25 22:04 · 自动交接', true);
    check('状态：旧节一个没少（原有 2 节）', sections.length, 3);
    check('状态：last_updated 同步成这次的时间', lastUpdated, '2026-09-25 22:04');
    const diaryCount = /diary_count:\s*(\d+)/.exec(afterState)?.[1]?.trim();
    say(`6d. diary_count → ${diaryCount}`);
    check('状态：diary_count 跟着日记新 seq +1 同步（3+1=4）—— 2026-09-28 补的那条', diaryCount, '4');
    check('状态：unfinished 收口成这次的挂起项', unfinished.includes('把 test-handoff-sandbox.mjs 收尾') && !unfinished.includes('旧的没收尾项'), true);
    check('状态：unfinished 块仍由 ``` 收尾', unfinished.trimEnd().endsWith('```'), true);
    check('状态：旧节正文还在', afterState.includes('旧内容一') && afterState.includes('更旧的内容'), true);

    /* 7 · 生长记录 */
    const growthLines = afterGrowth.replace(/\r\n/g, '\n').trimEnd().split('\n');
    say(`7. 生长记录 ${before.growth.trimEnd().split('\n').length} 行 → ${growthLines.length} 行，末条数据行：${growthLines[growthLines.length - 2] ?? growthLines[0]}`);
    check('生长记录：只追加一行', growthLines.length, before.growth.trimEnd().split('\n').length + 2);
    check('生长记录：既有两行一字未动', growthLines[0] === '2026-09-01 10:00 | 【PC】 | 旧的一行 | 是 | 旧教训一' && growthLines[1] === '2026-09-02 11:00 | 【PC】 | 旧的两行 | 是 | 旧教训二', true);
    check('生长记录：新行时间与设备对得上', growthLines[2]?.startsWith('2026-09-25 22:04 | 【PC】 |'), true);

    /* 8 · 交接包限长 */
    const packed = real.handoff;
    say(`8. 交接包：${real.handoffChars} 字（上限 1200）｜开头：${packed.slice(0, 40)}…`);
    check('交接包：不超过 handoffMaxChars', real.handoffChars <= 1200, true);
    check('交接包：五栏标签都在', ['【这一轮在做什么】', '【挂着的】', '【动过的文件与配置】', '【用户的偏好与纠正】', '【下一步第一件事】'].every((label) => packed.includes(label)), true);
    const tiny = await processHandoff({ root, input: INPUT, config: { handoffMaxChars: 80 }, sessionId: 'sandbox-tiny', dryRun: true });
    say(`8b. 交接包（上限 80）：实际 ${tiny.handoffChars} 字 → ${tiny.handoff.slice(0, 60)}…`);
    check('交接包：小上限也被真的截断到 80 字以内', tiny.handoffChars <= 80, true);
    check('交接包：截断时留下"到上限"的说明', tiny.handoff.includes('到上限'), true);

    /* 9 · 幂等 */
    const again = await processHandoff({ root, input: INPUT, config: { handoffMaxChars: 1200 }, sessionId: 'sandbox-s1', mode: 'live', device: '【PC】', now: new Date(2026, 8, 25, 22, 5, 5) });
    const idemDiary = readFileSync(paths.diary, 'utf8');
    const idemGrowth = readFileSync(paths.growth, 'utf8');
    say(`9. 幂等：第二次 ${JSON.stringify({ skipped: again.skipped, reason: again.reason })}`);
    check('幂等：第二次跑 skipped=true', again.skipped, true);
    check('幂等：理由里点名"已有同一份交接的指纹"', String(again.reason).includes('指纹'), true);
    check('幂等：日记字节一字未变', sha(idemDiary), sha(afterDiary));
    check('幂等：生长记录字节一字未变', sha(idemGrowth), sha(afterGrowth));
    check('幂等：日记里同一条只出现一次', idemDiary.split('### #3 ').length - 1, 1);
    check('幂等：指纹标记确实在日记里', hasFlag(idemDiary, real.fingerprint), true);
    const changed = await processHandoff({ root, input: { ...INPUT, outline: '换了内容的第二次交接' }, sessionId: 'sandbox-s1', mode: 'live', device: '【PC】', now: new Date(2026, 8, 25, 22, 6, 5) });
    say(`9b. 内容变了（换了 outline）→ ${JSON.stringify({ skipped: changed.skipped, seq: changed.seq })}`);
    check('幂等：内容变了才允许再写一条（序号 4）', changed.skipped === false && changed.seq === 4, true);

    /* 10 · 备份 */
    const backups = existsSync(paths.backups) ? readdirSync(paths.backups) : [];
    say(`10. 备份目录 ${paths.backups} → ${backups.join(', ') || '（空）'}`);
    check('备份：改前备份了三份', backups.length >= 3, true);
    check('备份：备份名带 .bak- 时间戳', backups.every((name) => /\.bak-\d{8}-\d{6}$/.test(name)), true);
    const diaryBackup = backups.filter((name) => name.startsWith('日记.md.bak-')).sort()[0];
    const backupText = diaryBackup ? readFileSync(join(paths.backups, diaryBackup), 'utf8') : '';
    check('备份：第一份日记备份与改动前逐字一致', sha(backupText), beforeHashes.diary);

    /* 11 · 指纹拒写（外部改动） */
    const snapshot = await processHandoff({ root, input: { outline: '这次要做外部改动测试' }, sessionId: 'sandbox-s3', dryRun: true });
    const external = `${readFileSync(paths.diary, 'utf8')}<!-- 外部编辑器改了一笔 -->${NL}`;
    writeFileSync(paths.diary, external, 'utf8');
    let rejectMessage = '（没拒：错）';
    try {
      await processHandoff({ root, input: { outline: '这次要做外部改动测试' }, sessionId: 'sandbox-s3', expect: snapshot.files, now: new Date(2026, 8, 25, 22, 7, 5) });
    } catch (error) {
      rejectMessage = error instanceof Error ? error.message : String(error);
    }
    say(`11. 指纹拒写：${rejectMessage}`);
    check('指纹拒写：外部改动后拒写（抛错）', rejectMessage.includes('外部改动拒写'), true);
    check('指纹拒写：文件仍是外部改过的那版（插件没覆盖它）', readFileSync(paths.diary, 'utf8') === external, true);

    /* 12 · 两种"停手"：写前指纹不符（一个字节都不动）与写完形状不符（抛错） */
    const growthNow = readFileSync(paths.growth, 'utf8');
    const staleReject = catchOf(() => writeWithGuards(paths.growth, '这不是文件现在的内容', growthNow, `${growthNow}多加一行${NL}`));
    say(`12. 写前指纹不符：${staleReject || '（没拦）'}`);
    check('写前指纹不符：拒写', staleReject.includes('外部改动拒写'), true);
    check('写前指纹不符：文件一个字节都没动', readFileSync(paths.growth, 'utf8'), growthNow);
    // 把写出的内容改成"改了一行旧行"（不是追加），appendOnly 的形状复核必须拦
    const tampered = growthNow.replace('旧教训一', '旧教训一（被改过）');
    const shapeStop = catchOf(() => writeWithGuards(paths.growth, growthNow, growthNow, tampered, { appendOnly: true }));
    say(`12b. 篡改旧行：${shapeStop || '（没拦）'}`);
    check('写完形状不符：改了旧行被拦（复核不过）', shapeStop.includes('复核不过'), true);
    // 把形状测试脏掉的那一行撤掉，后面的落盘形状检查才对着干净文件
    writeFileSync(paths.growth, growthNow, 'utf8');

    /* 13 · 落盘形状：CRLF + 无 BOM */
    const bom = [afterDiary, afterState, afterGrowth].some((text) => text.charCodeAt(0) === 0xFEFF);
    const lfOnly = [afterDiary, afterState, afterGrowth].some((text) => /(?<!\r)\n/.test(text));
    say(`13. 落盘形状：BOM=${bom ? '有（错）' : '无 ✓'} 裸 LF=${lfOnly ? '有（错）' : '无 ✓'}`);
    check('落盘形状：UTF-8 无 BOM', bom, false);
    check('落盘形状：全文件 CRLF（没有裸 LF）', lfOnly, false);

    /* 14 · 真档案（沙盘之外）一字未动 */
    say(`14. 沙盘外的哨兵文件：${readFileSync(join(outside, '哨兵.txt'), 'utf8').trim()}`);
    check('真档案占位：哨兵文件仍在且未被写', existsSync(join(outside, '哨兵.txt')), true);
    check('真档案占位：目录里只有哨兵一个文件', readdirSync(outside).join(','), '哨兵.txt');

    /* 15 · 临时文件没有残留，收尾清干净 */
    const leftovers = readdirSync(root).filter((name) => name.startsWith('.dsh-handoff-tmp'));
    const growthLeftovers = readdirSync(join(root, '生长')).filter((name) => name.startsWith('.dsh-handoff-tmp'));
    say(`15. 临时件残留：根 ${leftovers.length} 个 / 生长 ${growthLeftovers.length} 个`);
    check('临时件：写临时文件再 rename，没留下残渣', leftovers.length + growthLeftovers.length, 0);

    /* 16 · 指纹标记落位 */
    say(`16. 指纹标记：日记 ${hasFlag(afterDiary, real.fingerprint)}｜状态 ${hasFlag(afterState, real.fingerprint)}｜生长记录 ${hasFlag(afterGrowth, real.fingerprint)}`);
    check('指纹标记：三份文件都带同一份指纹', hasFlag(afterDiary, real.fingerprint) && hasFlag(afterState, real.fingerprint) && hasFlag(afterGrowth, real.fingerprint), true);
    check('指纹标记：日记用的是 entryFlag 形状', hasFlag(afterDiary, entryFlag(real.fingerprint)), true);

    /* 17 · Host 半边的接线（用假 ctx 走一遍 apply + 五条路由） */
    say(`17. 路由注册：${host ? [...host.routes.keys()].join('  ') : '（Host 半边没加载）'}`);
    check('Host：五条路由都注册上了', host ? host.routes.size === 5 : false, true);
    check('Host：requestBody 全是 buffered（写别的会静默失败）', host ? [...host.routes.values()].every((r) => r.requestBody === 'buffered') : false, true);
    check('Host：agent/pre-step 监听挂上了（waterfall 必须 return next）', host ? host.listeners.has('agent/pre-step') : false, true);
    const healthBody = host ? await (await host.routes.get('/api/handoff/health').fetch(new Request('http://sandbox/api/handoff/health'))).json() : {};
    say(`17b. health → ${JSON.stringify(healthBody)}`);
    check('Host：health 回 ok 且带上阈值/冷却/上限', healthBody.ok === true && healthBody.triggerRatio === 0.65 && healthBody.cooldownMs === 180_000 && healthBody.handoffMaxChars === 1200, true);
    const pendingBody = host ? await (await host.routes.get('/api/handoff/pending').fetch(new Request('http://sandbox/api/handoff/pending'))).json() : {};
    check('Host：还没交接时 /pending 回"暂无待交接"', pendingBody.ok === true && pendingBody.pending === null, true);
    const ackNoPending = host ? await host.routes.get('/api/handoff/ack').fetch(new Request('http://sandbox/api/handoff/ack', { method: 'POST', body: '{}' })) : null;
    check('Host：没待接时 ack 回 409（不假装成功）', ackNoPending ? ackNoPending.status : 0, 409);

    /* 18 · 起名：新会话沿用原会话的名字（她 2026-09-27 的要求：「切会话新会话的名字要与原会话名字一致」） */
    const { readSessionTitle } = await import('./index.js');
    const fakeCtxWithTitle = { get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: '夜间排查' }) } : undefined) };
    const fakeCtxNoTitle = { get: () => undefined };
    const fakeCtxBlankTitle = { get: () => ({ get: () => ({ title: '   ' }) }) };
    say(`18. 起名：读得到「${readSessionTitle(fakeCtxWithTitle, {})}」｜没服务「${readSessionTitle(fakeCtxNoTitle, {})}」｜空白「${readSessionTitle(fakeCtxBlankTitle, {})}」`);
    check('起名：能从原会话读出标题（新会话就沿用这个名字）', readSessionTitle(fakeCtxWithTitle, {}), '夜间排查');
    check('起名：本机没有标题服务时返回空串（由对面回退「会话交接」，不抛错）', readSessionTitle(fakeCtxNoTitle, {}), '');
    check('起名：标题是空白也当读不到（不拿空白去命名）', readSessionTitle(fakeCtxBlankTitle, {}), '');

    /* 19 · 触发词口径（2026-09-27 21:30 真机踩的坑：句中提到「换会话」被当成手动指令、真触发了一次交接） */
    const { isKeywordLine } = await import('./handoff-material.js');
    const { __isLiveForTest, __resetDrillsForTest } = await import('./handoff-state.js');
    const liveEventsOf = (text) => [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }];
    say(`19. 触发词口径：整行=${isKeywordLine('换会话', '换会话')}｜句中=${isKeywordLine('是不是没在回流包写换会话是英文思考的解决办法', '换会话')}`);
    check('触发：句中提到「换会话」不算（要整行独占）', isKeywordLine('是不是没在回流包写换会话是英文思考的解决办法', '换会话'), false);
    check('触发：单独一行打「换会话」才算', isKeywordLine('换会话', '换会话'), true);
    check('触发：前后带空白/换行也算（她打口令常带空格）', isKeywordLine('  \n换会话\n ', '换会话'), true);
    check('触发：演练词同一套口径（句中含「#交接演练」不算）', isKeywordLine('顺便说下 #交接演练 这事', '#交接演练'), false);
    __resetDrillsForTest();
    check('快照后备同样收紧：句中含关键词不算 live', __isLiveForTest(liveEventsOf('是不是没在回流包写换会话'), '换会话'), false);
    __resetDrillsForTest();
    check('快照后备：单独一句才算 live', __isLiveForTest(liveEventsOf('换会话'), '换会话'), true);

    /* 20 · 单次写入（2026-09-27 22:50 修）：模型那份「挂着的」并进**第一次（唯一一次）**写盘的 input。
       旧版写两遍：第二遍的 input 被 `withModelPending` 顶了 pending → 指纹变 → 幂等不命中 →
       又拿"第一次读前的基准"比对已被自己改过的现值 → 被护栏拒写，`unfinished` 永远停在机械版。
       本项同时守住"别再写第二遍"。 */
    const root20 = join(base, '档案沙盘-单次写入');
    scaffold(root20);
    const { withModelPending } = await import('./handoff-summary.js');
    const rawInput20 = { outline: '用户让改那条待修', pending: ['机械抽的旧待办'], touched: ['index.js'], next: '看状态顶部那节' };
    const refined20 = [
      '【上一段对话到阈值了，上下文已经写进记忆档案】',
      '- 档案根：（沙盘）',
      '【挂着的】',
      '- 路标那份挂着的（在【模型总结】之前，不该被抽走）',
      '',
      '【模型总结】',
      '【这一轮在做什么】',
      '修那条待修。',
      '【挂着的】',
      '- 待办甲：把那条待修修掉',
      '- 待办乙：要不要打包回 PC',
    ].join('\n');
    const merged20 = withModelPending(rawInput20, refined20);
    say(`20. 单次写入：pending [机械抽的旧待办] → ${JSON.stringify(merged20.pending)}`);
    check('单次写入：模型那份「挂着的」并进 input（只认【模型总结】里那段）', JSON.stringify(merged20.pending), JSON.stringify(['待办甲：把那条待修修掉', '待办乙：要不要打包回 PC']));
    const once20 = await processHandoff({ root: root20, input: merged20, config: { handoffMaxChars: 1200 }, sessionId: 'sandbox-s20', mode: 'live', device: '【PC】', now: new Date(2026, 8, 25, 22, 8, 5) });
    const state20 = readFileSync(join(root20, '生长', '状态.md'), 'utf8');
    const diary20 = readFileSync(join(root20, '日记.md'), 'utf8');
    const unfStart = state20.indexOf('unfinished:');
    const unf20 = unfStart < 0 ? '' : state20.slice(unfStart, state20.indexOf('```', unfStart));
    say(`20b. 一次写盘：seq=${once20.seq}｜unfinished 含"待办甲"=${unf20.includes('待办甲')}｜还留着机械那条=${unf20.includes('机械抽的旧待办')}`);
    check('单次写入：状态 unfinished 换成模型那份', unf20.includes('待办甲：把那条待修修掉') && unf20.includes('待办乙：要不要打包回 PC'), true);
    check('单次写入：机械抽的旧待办被顶掉', unf20.includes('机械抽的旧待办'), false);
    check('单次写入：新节的「挂着」列出模型那两条', /挂着：.*待办甲.*待办乙/.test(state20), true);
    check('单次写入：日记只多一条（没有第二次写）', diary20.split('### #3 ').length - 1, 1);
    const src20 = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    check('单次写入：源码里不再有第二次写真档案（writeRealArchive 已删）', /async function writeRealArchive|if \(live\) await writeRealArchive/.test(src20), false);
    check('单次写入：runLive 的第一次（唯一一次）就是带 pending 的那次', /input: withModelPending\(input, refinedLive\)/.test(src20), true);

    /* 21 · 「会话切换」答复形状归一（2026-09-28 真机 bug：直调返回 `{status,payload}`、旧代码读 `response.body`
       → 直调明明 200 也被判成"没接"。
       ⚠ 2026-09-28 09:0x：**两边统一用 V40 的 `normalizeSwitchResult`**（我先前那版叫 `switchReplyBody`），
       它返回 `{status, body}`，取值顺序是 `body ?? payload`、且**不解析字符串**（非对象一律当空对象）。 */
    const { normalizeSwitchResult } = await import('./index.js');
    const directShape = normalizeSwitchResult({ status: 200, payload: { ok: true, pending: { newSessionId: 'session-abc' } } });
    const httpShape = normalizeSwitchResult({ status: 200, body: { ok: true, pending: { newSessionId: 'session-def' } } });
    say(`21. 答复归一：直调→${JSON.stringify(directShape)}｜HTTP→${JSON.stringify(httpShape)}`);
    check('答复归一：直调形状（payload）能读出 ok ＋ newSessionId', directShape.body?.pending?.newSessionId, 'session-abc');
    check('答复归一：HTTP 兜底形状（body）也认', httpShape.body?.pending?.newSessionId, 'session-def');
    check('答复归一：body 优先于 payload（口径与 V40 一致）', normalizeSwitchResult({ status: 200, body: { ok: true, from: 'body' }, payload: { ok: true, from: 'payload' } }).body?.from, 'body');
    check('答复归一：两种都没有 → 空对象（不抛）', JSON.stringify(normalizeSwitchResult({ status: 500 }).body), '{}');
    check('答复归一：status 缺失 → 0（不抛）', normalizeSwitchResult({}).status, 0);
    check('答复归一：字符串 body 当成空对象（与 V40 口径一致，不解析）', JSON.stringify(normalizeSwitchResult({ status: 200, body: '{"ok":true}' }).body), '{}');
    check('答复归一：429 的 reason/error 也能读出来', normalizeSwitchResult({ status: 429, payload: { ok: false, reason: 'source-cooldown', error: '冷却中' } }).body?.reason, 'source-cooldown');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed).map((r) => r.label);
  const summary = { total: results.length, passed: results.length - failed.length, failed, results };
  if (verbose) {
    console.log('');
    for (const [index, item] of results.entries()) console.log(`${item.passed ? '✓' : '✗'} ${String(index + 1).padStart(2)}. ${item.label} ｜ 实际：${item.actual}`);
    console.log(`\n结论：${summary.passed}/${summary.total} 项通过${failed.length ? `，失败：${failed.join('、')}` : '（全过）'}`);
    console.log(`临时目录已清：${!existsSync(base)}`);
  }
  return summary;
}

/** 收集一次"本该被拦"的调用结果（拦住了返回错误消息，没拦住返回空串）。 */
function catchOf(fn) {
  try {
    fn();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 直接跑：`node test-handoff-sandbox.mjs [--verbose]`。
 *  比对用 `pathToFileURL` —— 手拼字符串在中文路径上会被 percent-encoding 挡掉（这坑当场踩过）；
 *  再加一条"文件名出现在 url 里"的兜底，免得被 `index.js --selftest` import 时反而没跑。 */
const asEntry = pathToFileURL(process.argv[1] ?? '').href;
if (import.meta.url === asEntry || (asEntry.startsWith('file://') && asEntry.endsWith('/test-handoff-sandbox.mjs'))) {
  const summary = await run({ verbose: process.argv.includes('--verbose') || process.argv.includes('--selftest') });
  console.log(`${summary.passed}/${summary.total} 项全过` + (summary.failed.length ? `（失败：${summary.failed.join('、')}）` : ''));
  process.exitCode = summary.failed.length === 0 ? 0 : 1;
}
