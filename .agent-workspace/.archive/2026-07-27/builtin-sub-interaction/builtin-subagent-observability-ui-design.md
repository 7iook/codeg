# 内置子代理可观测性 — UI/UX 设计卡

> slug: `builtin-subagent-observability` · 阶段：第四包（前端渲染）设计
> 权威范围来源：`builtin-subagent-observability-decision.md`（本卡不得扩张其边界）
> 产出物性质：**设计规格**，不含实现代码。交执行者按此实现。

## 0. 本轮实际读过的东西（可核验清单）

**设计法则（impeccable v4.0.2）** —— 注意：该版本 `reference/` 目录下**不存在** `product.md` /
`brand.md` / `init.md` / `document.md` / `critique.md`（派单描述的是旧版目录结构）。实际读取：

- `C:\Users\7\.claude\skills\impeccable\SKILL.md`
- `C:\Users\7\.claude\skills\impeccable\reference\routing.md`
- `C:\Users\7\.claude\skills\impeccable\reference\shape.md`（规划先行 → 本卡按其 Phase 3 七段式裁剪）
- `C:\Users\7\.claude\skills\impeccable\reference\craft-floor.md`（其 Refuse 清单直接命中本设计的两处
  裁决：**「为不需要保护性专注的任务开 modal」= 拒绝项**、**「嵌套卡片永远是错的」**）

**规则库**：`C:\Users\7\.claude\skills\ui-ux-pro-max\SKILL.md` +
`python scripts\search.py --domain ux --max-results 6 "nested agent transcript progressive disclosure
read-only inspector information hierarchy developer tool"` → 命中 6 条，其中 3 条对本设计有约束力：
Accessibility/Color-Only（severity High，状态不得只靠颜色）、Typography/Line-Length（65–75ch）、
Accessibility/Heading-Hierarchy。

**项目实况（非记忆）**：`package.json`（React 19 / Next 16 / Tailwind 4.1 / shadcn `radix-maia` /
`lucide` / `virtua` / `streamdown` / `use-stick-to-bottom`，**无 PRODUCT.md / DESIGN.md**，
`components.json` 是唯一的设计系统声明源）· `src/components/ui/` 现有 35 个组件清单 ·
`agent-capsule.tsx` · `agent-tool-call.tsx` · `sub-agent-session-dialog.tsx` ·
`delegated-sub-thread.tsx` · `sub-agent-overlay.tsx` · `delegation-status-badge.tsx` ·
`content-parts-renderer.tsx:2300-2385` · `ai-elements-adapter.ts:30-70` ·
`tool-call-normalization.ts:280-325` · `acp-connections-context.tsx:165-205 / 616 / 2915-2975` ·
`types.ts:1243-1265` · `globals.css:1140-1180`（`ws-msg-card` / `ws-msg-chip` 主题族） ·
`en.json:2500-2725` · 决策卡 + 侦察报告全文。

---

## 1. 组件角色：**父卡片原地展开的只读 transcript**，不是抽屉、不是对话框

**结论**：内置 SUB 的完整过程渲染在**它已经所在的那个胶囊体内**
（`AgentCapsule` 的 `CollapsibleContent`，`agent-tool-call.tsx` 当前渲染位置），
作为该胶囊 body 里的一个新区块。不新增顶层容器。

### 为什么不是 Dialog（尽管委托侧是 Dialog）

1. **两者的领域对象不同级**。委托子代理是**一个真实会话**：有 `conversation` 行、有
   `parent_id`、有 `external_id` resume 凭据、能进侧边栏、能开 tab、能续聊。Dialog 是它
   "会话身份" 的合理外化。内置 SUB **什么都没有**——它在数据模型里就是父会话里的一次
   `tool_call`（侦察报告 §2.2 逐项核实）。给它同一个 Dialog 外壳，等于用视觉承诺了
   一套它根本没有的能力面 —— 这正是不变量 1 要防的功能欺骗，只是换成了从**容器形状**
   泄漏出去，而不是从输入框泄漏出去。
2. **阅读动机是「对照」，不是「专注」**。用户点开它的真实场景是：主 AI 说了个结论，
   用户想知道这结论从哪来 → 需要**同屏**对照 SUB 的过程与父对话的下文。modal 遮蔽父
   对话，恰好切断了这个对照。craft-floor 的 Refuse 清单把「为既不需要打断、也不需要
   保护性专注的任务开 modal」列为默认要拒绝的懒惰选择，此处正是该条。
3. **因果位置本身是信息**。「这个 SUB 是在第 3 步、Read 完这批文件之后派出去的」——
   这个上下文由它在消息流里的物理位置免费承载。抽到抽屉/对话框里就丢了，还得靠面包屑
   补回来（ux 规则库 Navigation/Breadcrumbs：3 层以上才值得，这里不值得）。
4. **归组键天然对齐**。`parent_tool_use_id` == 父轮那次 Task 的 `tool_use` id ==
   胶囊现有的 `part.toolCallId`。渲染在胶囊内即**结构性满足**不变量 2（不污染父对话），
   不需要任何额外的归属 UI 或防串扰逻辑。

### 心智模型一句话

> **它是这次工具调用的「过程明细」，不是一个新会话。**
> 类比：调用栈里展开一帧看它的局部变量 —— 而不是打开第二个调试器窗口。

### 一处反直觉的克制

`sub-agent-overlay.tsx` 那个左上悬浮面板（委托用）**本轮不扩到内置 SUB**。它的价值在
"跨消息流追踪一个长期存在的子会话"；内置 SUB 生命周期短、且强绑在它出现的那一轮，
悬浮面板会把「短命的、位置即信息的」东西提升成「常驻的」，与心智模型冲突。
（若日后并发 SUB 监控成为真实痛点，那是独立一卡，不在此。）

---

## 2. 用户目标与场景

### 谁、何时点开

单一用户画像：**codeg 的开发者用户本人**，正在读主 AI 的一轮回复。三个真实触发场景，
按发生频率排序：

| # | 场景 | 用户此刻的问题 | 决定了什么设计 |
|---|---|---|---|
| S1 | 主 AI 报了个结论，用户**不信 / 想验** | "它凭什么这么说？它到底读了什么？" | 展开后必须能快速扫到**证据链**：读了哪些文件、跑了哪些命令 |
| S2 | SUB **正在跑**，用户在等 | "它卡住了吗？现在在干什么？" | 折叠态就要有**活着的证据**（最新一行活动），不必展开 |
| S3 | SUB **失败/结论可疑** | "在哪一步崩的？" | 失败自动展开 + 错误处高亮，不用用户翻 |

### 点开后最想先看到什么（排序有实证依据，不是猜）

注意一个已存在的事实：**SUB 的结论本来就已经可见** —— 胶囊现在渲染的
`part.output` 就是 Task 工具的返回，即 SUB 交回主 AI 的最终报告
（`agent-tool-call.tsx` 末段 `part.output && !isError && …`）。

所以本轮新增的价值**不是结论，是过程**。P0 排序据此定：

1. **它做了什么**（工具调用序列 —— S1 的证据链，也是唯一能反驳/证实结论的东西）
2. **它怎么想的**（prose/thinking —— 新数据的主体，`forwardSubagentText` 就是为它开的）
3. 结论（**已有，不重复渲染**）

---

## 3. 信息优先级 P0 / P1 / P2

### P0 — 折叠态即可见（不展开就能判断「要不要展开」）

胶囊 pill 一行内，全部**已有**，本轮只加第 3 项：

- 身份：`subagent_type: description`（已有 `title`）
- 状态：running / ok / error（已有 `statusLabel` + Shimmer + 时长后缀）
- **【新】过程规模徽标**：`12 msg · 8 tools` —— 一个数字徽标，作用是**告诉用户这里面
  有东西可看**。没有它，用户不知道胶囊里从「只有工具列表」变成了「有完整对话」。
  位置：复用 `AgentCapsule` 已有的 `idBadge` 槽（font-mono / 10px / muted，现成惯例）。
- **【新】running 时的活动尾行**：SUB 最新一条消息的首行，截断成一行，muted。
  这是 S2 的全部需求 —— 用户 90% 情况下**不需要展开**就满意了。
  ⚠️ 只渲染 1 行，不做滚动尾巴（并发 5 个 SUB 时这是崩与不崩的分界，见 §3.4）。

### P1 — 展开后第一屏（一次点击的成本）

- **transcript 主体**：user / assistant 消息按时序，工具调用**内联在产生它的那条
  assistant 消息之下**（不是把工具抽成独立一栏——那样就丢了「它为什么调这个工具」）
- 每条 assistant 消息：prose 走 `MessageResponse`（streamdown，项目既有 md 渲染）
- 每个工具调用：复用父对话同一个 `ToolCallPart`
  （`agent-tool-call.tsx` 已有 `renderToolCall` 注入模式 + `agentStats: undefined`
  防递归，本轮沿用同一注入口，**不新写工具渲染器**）
- **只读徽标**（见 §6，是 P1 而非 P2：它是能力边界声明，必须在用户产生"我能不能回它一句"
  这个念头的同一屏内）

### P2 — 再一次点击 / 或干脆不出现

- thinking 块：默认折叠（沿用 `reasoning.tsx` 既有折叠惯例），它体量大、信噪比低
- `agentId` / 消息 `uuid` / `spawnDepth` / 逐条时间戳 / raw JSON：**不出现**。
  这些是调试 codeg 自己的数据，不是用户理解 SUB 的数据。
  （`agentId` 另有一条硬理由不展示：落盘原文写着
  `internal ID - do not mention to user`，见侦察报告 §2.3。）
- token 用量 / 成本：不出现（内置 SUB 的用量已计入父会话，单独列会让用户以为要额外付费）

### 3.4 并发 5 个 SUB 时为什么不崩（这是本设计最硬的约束）

主 AI 一轮派 5 个 SUB = 父轮里 5 个 Task `tool_use` = **5 个独立 `parent_tool_use_id`**
= 5 个各自独立的胶囊。归属零歧义（无需去重逻辑）。抗崩靠四条：

1. **默认全折叠**。5 个 SUB 在屏上只占 5 个 pill 行 —— 与今天完全一致，零退化。
2. **折叠态每个 SUB 只有 1 行活动尾**。5 个并发 = 5 行 muted 文本在变，不是 5 个滚动区。
3. **transcript 只在展开时挂载**（`CollapsibleContent` 卸载语义 —— 需执行者核实项目
   `instant-collapsible.tsx` 的 unmount 行为；若它保持挂载，则设计要求
   transcript 内容自己做 `open && …` 的条件渲染）。未展开的 SUB 不构建 DOM。
4. **事件层节流沿用既有队列**。`acp-connections-context.tsx` 对 `content_delta` /
   `thinking` 已走 `enqueueStreamingAction` 批处理队列，对 `tool_call_update` 走
   `scheduleToolCallUpdateFlush`。新事件**必须进同一条队列**，不得 per-event `dispatch`
   （否则 5 个 SUB × 每条消息一次同步 dispatch 会直接打穿父会话的渲染预算 —— 这正是
   决策卡 K1 / E5 未验项担心的方向）。

### 3.5 ⚠️ 一处必须改的既有行为（否则功能在最关键的一秒钟自毁）

`agent-capsule.tsx:76-90` 有一条 running → completed 的**自动折叠**：

```
} else if (prevIsRunning && !isRunning && !isError) {
  setBodyOpen(false)
}
```

它对"只有工具列表"的旧 body 是合理的（跑完收起来）。但对本设计是**灾难**：用户
正展开看 live transcript，SUB 一完成，界面把他正在读的东西**当面关掉**——而那一刻恰好是
结论刚出现、最该读的时刻。

**设计要求**：区分「用户显式展开」与「因错误自动展开」。用户手动开过的胶囊，
completed 时**不自动折叠**。（实现层面：记一个 `userToggled` 标记，自动折叠仅在
`!userToggled` 时生效。执行者不得直接删掉自动折叠——那会让旧的纯工具列表胶囊
跑完后堆满屏幕，是另一个回归。）

---

## 4. 布局方案

### 方案 A（**推荐**）：胶囊内原地展开

```
┌ 父对话消息流 ─────────────────────────────────────────────────────┐
│                                                                   │
│  主 AI: 我让三个子代理分别核查了……                                │
│                                                                   │
│  ⌄ general-purpose: 对比三个 CLI 最新版    12msg·8tools    4.2s   │  ← P0 pill（既有形状）
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ [只读 ⓘ]                          ⌃ 折叠                  │   │  ← 只读徽标 + hover 说明
│  ├───────────────────────────────────────────────────────────┤   │
│  │ ··· 显示更早的 8 条 ···                                   │   │  ← 分页锚（懒加载，§7）
│  ├───────────────────────────────────────────────────────────┤   │
│  │ ▸ 思考过程                                                │   │  ← P2 默认折叠
│  │                                                           │   │
│  │ 我需要先确认三个 CLI 的版本号来源……                       │   │  ← P1 prose
│  │   ┌ Read  package.json                            ✓ ┐     │   │  ← P1 内联工具（复用 ToolCallPart）
│  │   └ Bash  npx codex --version                     ✓ ┘     │   │
│  │                                                           │   │
│  │ 三者版本分别是……（结论段）                                 │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ⌄ general-purpose: 核查 license 边界      3msg·1tool     运行中  │  ← 并发的第二个
│     正在读 src-tauri/src/acp/connection.rs …                      │  ← 折叠态活动尾（1 行）
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

关键区域：pill = 恒定 P0 摘要（并发时唯一占位）；body 顶栏 = 能力边界声明 + 分页锚；
body 主体 = 时序 transcript（**旧的在上、新的在下**，与父对话同向，不倒置）。

宽度：body 继承胶囊宽度，文本区受消息流既有 measure 约束（ux 规则库 Line-Length 65–75ch）。
不新开更宽的溢出容器 —— 打破消息流的左边界会让它看起来像另一个面板。

高度：**保留 `AgentCapsule` 既有 `ScrollArea max-h-72`**，不为 transcript 放大。理由：
胶囊在一个 `virtua` 虚拟化列表里（`virtualized-message-thread.tsx`），行高剧烈变化会
引起测量抖动/跳滚。固定上限 + 内部滚动是与虚拟化共存的既有解法，本轮沿用。

### 方案 B（考虑过，本轮不做）：右侧 aux-panel 增一个「子代理」tab

`aux-panel.tsx` 已是 Tabs 结构，加一个 tab 技术上最省事，且并发 5 个时空间最充裕。
**否决理由**：① 丢因果位置（§1.3）；② 与既有 `SubAgentOverlay`（委托）在概念上打架，
用户会问"为什么委托的在悬浮层、内置的在右面板"；③ aux-panel 是**跨会话常驻**语义，
装一个只在某一轮存在的东西，生命周期不匹配 —— 用户切走再切回，那个 tab 该显示什么？
无好答案 = 概念没对齐。

保留价值：若日后 K1 实测证明并发量级确实需要一个"总控台"，方案 B 是那时的正确形状，
届时它承载的应是**跨所有 SUB 的聚合视图**，而不是本轮这个单 SUB 明细。

---

## 5. 组件映射（全部项目既有，零新依赖）

| 用途 | 用什么 | 来源/惯例锚点 |
|---|---|---|
| 外壳 + pill + 折叠 + 滚动 | `AgentCapsule` | `message/agent-capsule.tsx`（已在渲染内置 SUB，本轮只加 body 区块） |
| 折叠（thinking / 更早消息） | `Collapsible` 三件套 | `@/components/ui/instant-collapsible`（项目自有变体，**不用** `ui/collapsible`，胶囊已选前者） |
| 滚动 | `ScrollArea` | `@/components/ui/scroll-area`（胶囊内已用） |
| markdown / prose | `MessageResponse` | `@/components/ai-elements/message`（`agent-tool-call.tsx` 既有用法） |
| 内联工具调用 | `ToolCallPart` 经 `renderToolCall` 注入 | `content-parts-renderer.tsx:2320-2330` 既有防递归注入口 |
| 只读徽标 | `Badge variant="secondary"` + `Tooltip` | `delegation-status-badge.tsx` 的 Badge 惯例；`ui/tooltip.tsx` 已存在 |
| running 指示 | `Loader2`（旋转）+ `Shimmer` | `agent-tool-call.tsx` 既有组合 |
| 首条消息前的等待 | `Skeleton` | `ui/skeleton.tsx`（若首屏空白 > 一瞬） |
| 图标 | `lucide-react`：`Eye`(只读) `ChevronRight` `Loader2` `AlertTriangle` `Scissors`(截断) | `iconLibrary: lucide` |
| 主题/表面 | 沿用 `ws-msg-chip`（pill）；body 内不再套 `ws-msg-card` | `globals.css:1147/1159` —— **嵌套卡片是 craft-floor 明令拒绝项**，body 内只用 `border-border/60` 分隔，不再造一层卡 |

**样式惯例沿用**：`text-xs` / `text-muted-foreground` 为次级文本默认；间距 `space-y-2~3`；
圆角 `rounded-md`；边框 `border-border/60`；错误用 `bg-destructive/10` + `text-destructive`
**并带图标**（ux 规则库 Color-Only 是 High severity：不得只用红色表达失败）。

---

## 6. 明确的「不做」清单

按"用户最可能误以为能做"排序。每条都必须在实现中**主动缺席**，不是"以后再说"。

| # | 不做 | 为什么（不是"暂不支持"，是"不可能/会骗人"） |
|---|---|---|
| 1 | **任何输入框 / textarea** | 协议封死：适配器 17 个方法无一接受 `agentId`，内置 SUB 复用父 `sessionId`（侦察 §3.1 实测）。`SendMessage` 是 Claude 进程内工具，只有模型能调 |
| 2 | **"回复" / "继续" / "追问" 按钮** | 同上。哪怕只是 disabled 状态也不做 —— disabled 传达的是"条件不满足"，而真相是"永不可能"，仍是欺骗 |
| 3 | **伪双向（用户输入 → 主 AI 代转达）** | 决策卡已判 D 类。主 AI 可不转达、可改写，语义骗人 |
| 4 | **"取消 / 停止" 按钮** | `TaskStop` 同样只有主 AI 能调。给用户一个停不掉的停止键，比没有更糟 |
| 5 | **"在标签页打开"** | 委托侧有此键，此处**最容易被要求对齐**。但内置 SUB 无 `conversation` 行、无 `folder_id`、无 `external_id` resume 凭据 —— 没有任何东西可以打开 |
| 6 | **侧边栏出现一行** | 同上：无 DB 行。造一个假行 = 造第二个 SSOT |
| 7 | **Dialog / Sheet / 抽屉** | §1 的四条理由。且 modal 是 craft-floor 的默认拒绝项 |
| 8 | **`waiting`(待批准) 状态徽标** | 委托子代理会向用户要权限，内置 SUB 的权限请求走**父会话**。在这里显示"等待批准"会把用户引向一个不存在于此处的操作 |
| 9 | **"重跑 / 重新生成"** | 不属本卡范围（那是给主 AI 下指令，走父会话输入框） |
| 10 | **嵌套卡片**（body 内再套 Card） | craft-floor：nested cards are always wrong。用分隔线与留白分层 |
| 11 | **暴露 `agentId`** | 落盘原文 `internal ID - do not mention to user` |

### 「想聊」的正确出口（唯一的引流点）

不做 ≠ 不解释。**一个只读徽标 + tooltip**，位置在展开体顶栏（P1 优先级）：

- 徽标恒显（`Eye` + "只读"），不可关闭 —— 它是能力边界的常驻声明
- tooltip 才承载解释与引流："内置子代理由 Claude 自己管理，codeg 只能观察。
  需要能对话的子代理请用**委托**。"
- **为什么放 tooltip 而不是常显横幅**：并发 5 个 SUB 时，5 条横幅 = 噪声，
  会把用户真正要看的 transcript 挤出第一屏。徽标零重复成本，解释按需取用。
  （`sub-agent-session-dialog.tsx` 有个常显 `Info` 横幅先例，那里只有一个会话、
  且传达的是**数据不同步的风险**——风险必须常显，能力边界用徽标即可。）
- commit `58d63358` 已把路由文案引流到委托，此处文案与之保持同一说法，不另起口径。

---

## 7. 空状态与异常态（七个，逐一定义）

| 态 | 触发 | 呈现 | 关键判断 |
|---|---|---|---|
| **E-1 刚派出、零消息** | Task 已发起，首条 subagent 消息未到 | pill：Shimmer 标题 + "运行中"；body 若被展开：`Loader2` + "等待子代理的第一条消息…" | **不用 Skeleton 骨架屏**：骨架屏承诺"内容马上就来且形状已知"，而这里可能等数秒 |
| **E-2 live 流入中** | 消息持续到达 | 折叠态：1 行活动尾（截断）；展开态：新消息追加在底部 + 末条带 Shimmer | **不做自动滚动到底**：用户展开是为了读某一段，抢滚是最恼人的反模式。仅当用户已在底部时才跟随（`use-stick-to-bottom` 既有语义） |
| **E-3 完成但 transcript 为空** | **真实高频**：`forwardSubagentText` 只对本次改动之后新建的会话生效；历史会话 + §3.2 尾随器尚未落地 = 零 live 消息 | 不显示空 body（那就是那个著名的"白盒子"）。`AgentCapsule` 的 `hasBody` 逻辑已能退化成裸 pill —— **沿用即正确**。若已有工具列表则照旧显示工具列表 | 这是本设计最该被诚实对待的一态：**多数历史会话会落在这里**。不得为它编造"暂无数据"的提示卡，退化成今天的样子就是对的 |
| **E-4 SUB 失败** | Task 返回 error | 自动展开（`AgentCapsule` 既有 `isError` 行为）；错误块 `bg-destructive/10` + `AlertTriangle` **图标 + 文字**（不只靠红色）；滚动位置停在**最后一条**（失败点在末尾） | 唯一一个默认展开的态 |
| **E-5 消息过多** | 超过窗口阈值（建议首屏 30 条，具体值执行者按实测定） | 顶部一行锚："显示更早的 {count} 条"，点击向上追加一页。**旧的在上**，与阅读方向一致 | 决策卡 §3.2：官方 `getSubagentMessages` 带 `limit`/`offset` = 上游也认为此处需分页 |
| **E-6 被截断（数据侧丢失）** | 单条消息过长被截 / 后端丢弃了未白名单类型 | 该消息尾部一行 muted + `Scissors` 图标："内容已截断" | 与 E-5 区分：E-5 是"你可以加载更多"，E-6 是"这部分永远拿不到了"。**混为一谈会让用户一直点一个没用的按钮** |
| **E-7 嵌套 SUB（SUB 再派 SUB）** | `spawnDepth > 1`，决策卡 K4 **未验** | 内层消息的 `parent_tool_use_id` 指向一个**不在父会话里**的 tool_use → 成为孤儿。**本轮不做嵌套 UI**：孤儿消息归到最近的已知祖先胶囊末尾，并在该胶囊 pill 上标一个"含嵌套"提示 | 不得静默丢弃（那是 upstream issue #33651 同类的静默丢消息）。也不得本轮就发明多层嵌套展开 —— K4 未验，形状未知 |

---

## 8. 数据 / 字段需求 + 前后端衔接提示

⚠️ 以下是**设计所需的数据**与**疑似缺口的提示**，契约的最终核实归 recon / 执行者。

已具备（决策卡已实现，`types.ts:1253`）：
`{ type: "claude_subagent_message", session_id, parent_tool_use_id, message: unknown }`

设计对数据的要求，逐项：

1. **`message` 是 raw SDKMessage（`unknown`）** —— 前端需要一个归一化器把它转成项目既有的
   `AdaptedContentPart[]`（`role` / `text` / `thinking` / `tool_use` / `tool_result`）。
   **提示**：`ai-elements-adapter.ts` 已有整套 ContentBlock → AdaptedContentPart 的映射，
   应**复用/扩展它**，不要在组件里手写 JSON 解析（否则又是一个并行实现）。
2. **P0 徽标需要计数**（`N msg · M tools`）。逐条累加即可，无需后端字段。
3. **`user` 类型消息里混着两种东西**：SUB 的 `tool_result` 与它的启动 prompt。
   UI 上前者必须内联到对应 `tool_use` 下、后者应作为 transcript 的第一条"任务"。
   **提示**：需要能区分二者（按 content block 类型判定，非按 message 类型）。
4. **【缺口提示 · 排序】** live 路径可用到达序；`§3.2` 历史路径**必须按 `parentUuid` 链**
   （决策卡硬约束）。两路的排序规则不同 —— **UI 层不应各自为政**，建议在数据层收敛出
   单一有序列表后再交渲染。
5. **【缺口提示 · 去重键 K3】** live 与历史两路同时到达时的合并键**未定义**（决策卡 K3 🟡）。
   设计假定 `message.uuid` 可用作合并键。**若 live 事件未透出 `uuid`，这是一个真实的
   前端阻塞点**，需在第二阶段前确认 —— 否则重开会话会看到消息翻倍。
6. **【缺口提示 · 前端消费者仍缺】** `acp-connections-context.tsx` 的 switch 无
   `case "claude_subagent_message"`（决策卡 Update Log 已诚实标注）。新增 case 必须
   进既有 `enqueueStreamingAction` 批处理队列（§3.4 第 4 条），不得 per-event dispatch。
   `ConnectionState` 需新增按 `parent_tool_use_id` 分组的存储槽
   （形如 `subagentTranscripts: Map<parentToolUseId, …>`），并纳入既有的
   turn-end / `CONNECTION_CREATED` / `HYDRATE_FROM_SNAPSHOT` 清理分支 ——
   **漏了清理就是跨轮/跨会话串台**。
7. **【性能 · 对齐 K1】** 设计已在 UI 层给了三道闸（默认折叠 / 单行尾 / 展开才挂载），
   但**事件量级仍未实测**（决策卡 K1、E5 均 🟡）。UI 侧闸门不能替代事件侧节流。

---

## 9. i18n key 清单（英文原文；10 语翻译由实现阶段补）

命名空间沿用 **`Folder.chat.contentParts`**（现有 `agentPromptLabel` / `agentModelLabel` /
`agentRunning` / `agentFallbackTitle` 等内置 SUB 文案都在此，`en.json:2705-2717`）。
前缀统一 `subagent*`。共 **13 个**新 key：

| key | English |
|---|---|
| `subagentReadOnlyBadge` | `Read-only` |
| `subagentReadOnlyTooltip` | `Built-in sub-agents are managed by Claude — codeg can only observe them. To run a sub-agent you can talk to, use delegation.` |
| `subagentTranscriptLabel` | `Sub-agent transcript` |
| `subagentCounts` | `{messages} msg · {tools} tools` |
| `subagentThinkingLabel` | `Thinking` |
| `subagentTaskLabel` | `Task` |
| `subagentWaitingFirstMessage` | `Waiting for the sub-agent's first message…` |
| `subagentLoadEarlier` | `Show {count} earlier messages` |
| `subagentLoadingEarlier` | `Loading…` |
| `subagentContentTruncated` | `Content truncated` |
| `subagentFailedLabel` | `Sub-agent failed` |
| `subagentNestedNotice` | `Includes a nested sub-agent` |
| `subagentCollapseAria` | `Collapse sub-agent transcript` |

（`subagentCounts` 走 next-intl 插值；复数形式由各语言文件自行处理。）

---

## 10. 交给执行者的验收锚（对齐决策卡 E1–E6）

1. 派 1 个内置 SUB → 胶囊 pill 出现计数徽标 → 展开看到 prose + 内联工具（E1）
2. live 过程中消息实时追加，**且完成时不自动关闭用户手开的 body**（E2 + §3.5）
3. 并发 5 个 → 屏上仍是 5 个 pill，各 1 行活动尾，父对话不卡（E5 + §3.4）
4. 父对话消息流中**不出现**任何 subagent 消息（E4，结构性满足）
5. 历史会话（无 live 数据）退化成今天的裸 pill / 工具列表，**不出现空白盒**（E3）
6. 全界面无任何输入框 / 发送键 / 取消键 / "在标签页打开"（不变量 1 · §6）
7. 桌面与 Web 模式一致（E6，事件走统一信封，已自动对等）
