> ### ⚠ 2026-09-28 合并记录：本插件现在**也管"会话那一摊"**
>
> 她那天说「合插件」——`dsh-session-switch`（建新会话、发交接包、写 pending、供界面切过去）
> 整个搬进了本包，作为 `switch-session.js` 与 `switch-store.js` 两个模块：
>
> * **内部握手改成直调**（`runSwitchDirect()`），不再是 `POST http://127.0.0.1:3080/api/session/switch` 那条网络往返；
> * 那四条 HTTP 路由**照旧注册**（`/api/session/switch|pending|ack|health`），自检、手工 curl、老调用方都还认；
> * 状态目录不变：`~/.dsh/session-switch/`（`DSH_SESSION_SWITCH_DIR` 可覆盖）；
> * 会话那一摊要的七个宿主服务改成**运行时注入**：缺谁只让这一摊缺席，**档案那一摊照常**（合并前是"整包卡 pending"）；
> * 自检多了一个口：`DSH_SESSION_SWITCH_DIR=/tmp/ss node index.js --switch-selftest`（原样 19 项）。
>
> 撤下前的完整副本在 `plugin-src/归档-合并前-20260927-232845/`。

# dsh-auto-handoff

DSH（DeepSeek Harness）插件：**上下文占用到阈值时自动交接**。

到阈值那一刻，它做四件事：

1. 往档案里**写一条日记**（六段式，跟档案既有的形状一致）；
2. 往 `生长\状态.md` **顶部插一节**，并同步顶部的 `last_updated` / `unfinished`；
3. 往 `生长\生长记录.md` **末尾追加一行**；
4. 拼一份**限长的交接包**（默认 1200 字，**只有它进新会话**），请
   [`dsh-session-switch`](../../..) 开新会话并把交接包当第一条消息送进去。

**本插件不自己建会话。** 建会话、切界面、归档原会话都是 `dsh-session-switch` 的活；
两者只靠一个 HTTP 调用握手，叫不动就走降级（把完整待接写到约定位置，由浏览器那半边自己切）。
所以**两个插件谁单独装都能用**，只是"切会话"这件事的效果不同。

---

## 它管什么 / 不管什么

| | 本插件 | `dsh-session-switch` |
|---|---|---|
| 管什么 | **档案**：日记 / 状态 / 生长记录 / 交接包 / 待接记录 | **会话**：建、切、归档 |
| 触发 | 上下文到阈值自动；或手动打演练关键词 | 收到 `/api/session/switch` 才动 |

记忆的**看 / 编 / 导入 / 导出**是另一个插件（记忆面板）的事，本插件不碰。

---

## 安装

1. 把这个目录放进你的 DSH 插件源目录（本机示例：`~/.dsh/plugin-src/dsh-auto-handoff`）。
2. 把 `cordis.patch.example.yml` 里那一条按你的情况改好，插进 profile 的
   `cordis.patch.yml`；或者用 Plugin Manager 的 `install_bundle` 把它当 bundle 装进 profile。
3. **重启宿主**。实测：装 bundle、改 bundle 内代码、改 config **都认重启**（HMR 不可靠）。

唯一的必填项是**档案根**：留空则依次尝试

```
config.root → 环境变量 DSH_MEMORY_ROOT → ~/.dsh/memory → 从当前目录逐级向上找
```

**认根靠特征文件**：`身份.md` + `日记.md` + `生长\状态.md` 三者齐备才算一份档案；
**认不到就不动作**（绝不拿一个猜出来的根去写真档案）。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `''` | 档案根；留空按上面的顺序找 |
| `triggerRatio` | `0.65` | 占用到这个比例触发交接 |
| `minTurns` | `3` | 会话太短不触发 |
| `cooldownMs` | `180000` | 冷却 3 分钟；**过了冷却还能再交一次**（不是"一会话一次"） |
| `handoffMaxChars` | `1200` | 交接包上限 |
| `dryRun` | `true` | **首启只算不写**：把"本来会写什么"记日志，一个字节都不落盘 |
| `device` | `【PC】` | 日记标题与状态节里的设备标签 |
| `drillKeyword` | `#交接演练` | 手动演练关键词（只在**用户消息**里整句匹配） |
| `gatewayBase` | `http://127.0.0.1:3080` | `dsh-session-switch` 的地址 |
| `legacyDevice` / `legacyBoundary` | `''` | 旧条目设备归属判据；**没配就完全不推断** |

占用率的取数口径：**优先会话投影 `contextPressure`**（跟页面上那个百分比同源），
拿不到再退回 `ctx.tokenMeter.measure()` ÷ `request/context().contextWindow`；
**两个都拿不到就返回"不动作"** —— 不许瞎猜分母。

---

## 手动演练

在对话里整句打 `#交接演练`：

- **只写演练副本根**（`sandboxRoot`），真档案一个字节不碰；
- 没配 `sandboxRoot` 就只做一次干跑，日志里能看到"本来会写什么"；
- `sandboxRoot` 落在真档案根**里面**时**硬拒**（那样"演练"就是真写）。

---

## Host 侧路由

前缀 `/api/handoff/`，五条各自注册一次（`requestBody` 只能是 `buffered`，写别的会静默失败）。

| 路由 | 方法 | 用途 |
|---|---|---|
| `pending` | GET | 给客户端轮询的待接（完整交接包 + `sourceSession` + `newSessionId`） |
| `take` | GET/POST | 与 `pending` 同义（取一份待接） |
| `ack` | POST | 客户端切完回报，标记"已处理" |
| `health` | GET | 一眼看配置与管道：阈值 / 冷却 / 上限 / 档案根 / gateway |
| `status` | GET | 最近 20 行诊断日志 + 上次判定 |

客户端半边（`client.js`）**只做"轮询 + 调导航/归档"**：不注册 slot、不写 DOM，
出错只 `console`，绝不抛 —— 客户端入口抛错的代价是"整个页面打不开"。

---

## 写档案的护栏

写盘一律四条：

1. **改前备份**（整份复制到 `<根>\归档-旧版本与记录\写入备份\`，`.bak-YYYYMMDD-HHMMSS`）；
2. **只改定位处**（序号 +1、`total_count` +1、`last_updated`、`unfinished`，别的一字不动）；
3. **写完复核**（读回来逐字比对 + "旧内容只能是新内容的前缀/只差一处"的形状复核）；
4. **外部改动拒写**（指纹比对：我们读过之后被改过 → 拒写）。

外加：

- **幂等**：同一份交接重复跑不追加第二条（指纹标记写在日记里）；
- **写临时文件再 rename**，不赌覆盖式写入；
- **行尾/编码**：全文件 CRLF、UTF-8 无 BOM。

---

## 自检

```bash
node index.js --selftest            # 在临时目录造假档案，跑全套回归（每项打实际输出）
node test-handoff-sandbox.mjs       # 同一套，只打结论
node test-handoff-sandbox.mjs --verbose
```

自检口在**模块层**（不是 `apply` 里）—— 独立跑 `node index.js` 时 cordis 不会调
`apply`，写在里面会一声不吭。

---

## 已知边界

- **它不保证"交接的内容是这一轮的全文"**：交接包是压缩后的接手起点，不是复制品
  —— 新会话一开就吃满上下文等于把坑搬过去。
- **日记正文里的 `event_description`** 由"最近说过的话 + 动过的工具"拼成；
  没给 `userMood` 时那一栏会照实留白，**不替你编心情**。
- **跨设备没做**：手机侧没有同一套 Web 客户端，切会话要另想办法。
- **`legacyDevice` / `legacyBoundary` 只是判据**：本插件不会去改写任何旧条目。

## License

MIT
