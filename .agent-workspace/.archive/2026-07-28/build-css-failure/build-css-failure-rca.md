# RCA — `pnpm build` 失败：Tailwind v4 扫描到含 Windows 路径的归档 md 触发 `Invalid code point 11758589`

- 日期：2026-07-28
- 模式：Mode B（反锚定独立复核，主 AI 已排除 4 项假设并明确提示「报错位置 globals.css 很可能是误导」）
- 结论状态：**根因已定论（双向受控翻转已证实）**

---

### 🔴 1. 现象与上下文

**现象锁定（单一可证伪命题）**：在 `F:\codeg-research` 执行 `pnpm build`（Next 16 + Turbopack），期望产出 `out/`，实际 EXIT=1，报
`CssSyntaxError: tailwindcss: F:\codeg-research\src\app\globals.css:1:1: Invalid code point 11758589`。
`11758589 = 0xB36BFD`，远超 Unicode 上限 `0x10FFFF`。

**关键澄清**：报错位置 `globals.css:1:1` 是 postcss 的**默认归因位置**（`Root.error` 无节点定位时落到根节点），
与真实出错内容**无关**。真实触发内容不在 `globals.css`、也不在任何 CSS 文件里——在一个 **markdown 归档报告**中。
主 AI 对此的怀疑是正确的。

---

### 🔍 1.5 假设账本（状态机）

主 AI 的立场：未锁定单一根因，已排除 4 项（文件编码 / 本轮改动 / NODE_ENV / CSS 内 unicode 转义），
worktree 对比实验失败无效。**我不复用它的任何归因，独立列候选。**

| ID | 假设 | 置信度(初) | 状态 | 证伪/确认证据（目标样本直接证据 + 工具/命令） |
|----|------|------|------|------|
| A | Turbopack 集成问题（postcss transform / IPC 层）导致，tailwind 单独跑不复现 | 20% | 🔴Falsified | 用 `node` 直接 `postcss([tailwindPostcss()]).process(globals.css)`，**完全绕开 Next/Turbopack**，同样抛 `RangeError: Invalid code point 11758589`。堆栈里无任何 turbopack 帧。→ 与 Turbopack 无关 |
| B | `globals.css` 或其 `@import` 链中某个 CSS 文件（含 node_modules 内 tailwind 内部文件）含越界 `\XXXXXX` 转义 | 25% | 🔴Falsified | hook `String.fromCodePoint` 打全栈后拿到的入参**不是 CSS 内容**，是一个文件系统路径字符串（见 D）。堆栈路径为 `markUsedVariable` ← 候选扫描，非 CSS 解析路径（CSS 解析会走 parser 帧） |
| C | `@theme` / `@utility` / `@custom-variant` 指令内容触发 | 15% | 🔴Falsified | 同 B 的证据：入参是路径不是 theme token。且 `git grep` 确认 globals.css 只有 `@custom-variant dark` + `@theme inline` 两条，均不含反斜杠 |
| D | Tailwind v4 oxide 自动源扫描（Automatic Source Detection）扫到了某个**非源码文件**，其中一段 `\` + 6 位十六进制被 CSS unescape 误判为码点转义 | 35% | 🟢**Confirmed** | hook `String.prototype.replace` 捕获到确切入参：`"--Users-7-AppData-Roaming-app-codeg-chat-sessions-2026-07-27-4f2472cd35ab41168660b2927d4fc668\\b36bfde5-7eb1-4d40-a2fb-ecdeb6d12d5a"`，`escape="\b36bfd"` → `0xb36bfd` = 11758589。`git grep -nF` 定位到全仓**唯一**一处：`.agent-workspace/.archive/2026-07-27/builtin-sub-interaction/builtin-sub-interaction-recon.md:70`。**双向受控翻转**（见 §2） |
| E | CRLF / `core.autocrlf=true` 参与 | 5% | 🔴Falsified | 触发串中无 CR/LF；捕获到的 charcodes 序列（记录于诊断日志）在 `\` (92) 前后均为普通 ASCII 字母数字，无 13/10 |
| F | pnpm 符号链接 node_modules 布局与扫描器交互 | 5% | 🔴Falsified | 在 `C:\Temp` 下用扁平 `npm install`（非 pnpm）的最小复现工程同样复现，码点数值完全一致（11758589） |

自查：恰好一行 🟢，其余全 🔴，🟢 证据为目标样本的直接证据（捕获到确切入参 + 双向翻转）。

---

### 🔍 2. 根因分析

**根因**：Tailwind v4 的 oxide 自动源扫描把仓库内 `.agent-workspace/.archive/**/*.md` 也当作候选来源扫描。
其中一份归档侦察报告的正文里，为说明 Claude Code 会话文件位置而**原文抄录了一条 Windows 绝对路径**：

```
C:\Users\7\.claude\projects\C--Users-7-AppData-Roaming-app-codeg-chat-sessions-2026-07-27-4f2472cd35ab41168660b2927d4fc668\b36bfde5-7eb1-4d40-a2fb-ecdeb6d12d5a.jsonl
```

该路径中的目录名以 `C--Users-...` 开头（Claude Code 自己的路径编码规则会把 `:\` 变成 `--`）。
扫描器提取出以 `--` 开头的 token，于是走进「这看起来像一个 CSS 自定义属性」的分支，交给 `markUsedVariable()`；
后者调用 unescape 函数 `Se()`，其正则 `/\\([\dA-Fa-f]{1,6}[\t\n\f\r ]?|[\S\s])/g` 把
**Windows 路径分隔符 `\` + 紧随的 UUID 前 6 位十六进制 `b36bfd`** 匹配为一个 CSS 十六进制转义，
`parseInt("b36bfd",16) = 11758589 > 0x10FFFF`，`String.fromCodePoint` 抛 `RangeError`。
postcss 捕获后包装成 `CssSyntaxError` 并归因到入口 CSS 的 1:1，产生了误导性的报错位置。

**First broken point**（依赖内，非本仓库代码）：
`node_modules/.pnpm/tailwindcss@4.1.18/node_modules/tailwindcss/dist/chunk-CT46QCH7.mjs:1:5453`
——函数 `Se()`（源码名 `unescape()`）无边界检查直接调用 `String.fromCodePoint`。
调用链：`Object.build` → `lt.markUsedVariable` (`:1:7620`) → `Se` (`:1:5382`) → `String.fromCodePoint` (`:1:5453`)。

**触发内容位置**（本仓库，属他人文件）：
`F:\codeg-research\.agent-workspace\.archive\2026-07-27\builtin-sub-interaction\builtin-sub-interaction-recon.md:70`

**Bug class（§5.2 七分类）**：**接口契约不清**（Interface Contract Ambiguity）——
扫描器对「候选 token」的契约过宽，把任意文本文件里的 Windows 路径当作 CSS 变量候选，
且下游 unescape 未按 CSS Syntax spec §4.3.8 做越界兜底。

**为什么主 AI 的 4 项排除都对但没定位到**：它们全部把搜索范围限定在 CSS 文件内。
真实触发内容在 markdown 里，`globals.css` 完全无辜——所以「文件编码正常」「无 `\XXXX` 转义」这些结论
都是**正确但无关**的。这正是错误的报错位置造成的锚定陷阱。

#### 受控对比实验（双向翻转，Gate 3）

| 操作 | 结果 |
|---|---|
| 原状 | tailwind 独立跑 FAIL（`Invalid code point 11758589`） |
| 把该 md 移出仓库（唯一变量） | tailwind 独立跑 `BUILD OK`；`pnpm build` **EXIT=0，产出 `out/`，全部 39 个路由 prerender 成功** |
| 把该 md 移回原位（还原） | 同一错误、同一码点复现 |

结论翻转成立，非相关性。文件已还原，`git status` 仅剩既存的 ` M src-tauri/Cargo.toml`。

#### 最小复现（Gate 2 + Gate 4，目标环境 Windows）

在 `C:\Temp` 下建的空工程（`@import "tailwindcss";` + 一个含上述路径的 `poison.md`，扁平 npm 安装）：

| tailwindcss 版本 | EXIT | `Invalid code point` 命中 |
|---|---|---|
| 4.1.18（本仓库当前） | 1 | 1（码点 11758589，与生产完全一致） |
| 4.2.1 | 1 | 1 |
| 4.2.2 | 1 | 1 |
| **4.2.3** | **0** | **0** |
| 4.3.3（latest） | 0 | 0 |

→ 修复边界精确落在 **4.2.3**。

---

### 🕵️ 3. 变体扫描

**重复实现检视**：本次无新增实现（诊断类任务，根因在第三方依赖）；无需检索同义实现。

**指纹**：仓库内被 tailwind 扫描到的任意文本文件中，出现 `\` 紧跟 ≥6 位十六进制字符、且所在 token 以 `--` 开头。

**全仓扫描结果**：`git grep -nF "C--Users"` → 全仓**仅 1 处命中**（即上述 md:70）。
即当前只有一个触发点，但这是**偶发命中**而非结构性唯一：`.agent-workspace/.archive/` 下持续沉淀 AI 报告，
报告正文经常抄录 Windows 路径 / UUID / 哈希；只要下次某条路径的 `\` 后恰好跟 6 位十六进制且 token 以 `--` 起头，
构建会再次崩。**这是一个会复发的类，不是一次性实例。**

未收敛变体：无（唯一命中点已由方案覆盖）。

---

### 👥 4. 真实场景模拟

1. **归档报告持续增长**：`.gitignore` 明确保留 `.agent-workspace/.archive/`（`!.agent-workspace/.archive/`），
   意味着归档 md 是**追踪进仓的正常资产**，且会持续增加。任一新报告抄一条 Windows 路径就可能复发。
   防御：方案 A（`@source not`）从源头把整个目录排除，对未来新增文件天然免疫。
2. **CI / 干净克隆**：由于触发文件已提交进仓（非本地未追踪产物），任何机器上的干净克隆 + `pnpm build` 都会失败，
   不是本地环境特异问题。方案 A/B 均随仓库生效。
3. **Linux / macOS 构建**：触发依赖的是**文件内容里的反斜杠字符**，而非运行平台的路径分隔符，
   所以在非 Windows 平台构建同样会崩（内容是常量）。方案不依赖平台判断。
4. **dev 模式**：同一扫描路径也在 `next dev --turbopack` 生效，理论上 dev 也会崩。**本轮未实测 dev**
   （`unverified: 未运行 pnpm dev`），但根因同源，方案 A/B 同样覆盖。

本轮**未处理**的已知失败：tailwind < 4.2.3 的 `unescape()` 本身缺边界检查这一上游缺陷，
本仓库无法根治（属依赖内代码），只能通过升级或缩小扫描面规避。

---

### 📚 5. 行业参考

全部为可验证锚点（工具 `exa.web_search_exa` + `tavily_search`）：

1. **tailwindlabs/tailwindcss#19786** — <https://github.com/tailwindlabs/tailwindcss/issues/19786>
   「[Bug] Invalid code point crash on Windows when oxide scanner picks up runtime path+UUID identifiers」
   与本例**同一母题**：`--...Workspace\d8819554-...` 中 `\d88195` 被当十六进制转义 → `0xD88195 = 14188949` 越界崩溃。
   状态 closed，由 RobinMalfait 指派并修复。
2. **tailwindlabs/tailwindcss#19910** — <https://github.com/tailwindlabs/tailwindcss/issues/19910>
   同类（closed as duplicate），报告者直接给出了 `Se()`/`he()` 的正则与越界推导，与我实测的机制逐字一致。
3. **PR #19829（已 merged，merge commit `bd30a716`）** — <https://github.com/tailwindlabs/tailwindcss/pull/19829>
   「Fix crash due to invalid characters in candidate」：`unescape()` 增加码点校验，
   越界值与 surrogate（`0xD800`–`0xDFFF`）按 CSS Syntax spec 替换为 `\uFFFD`。
   **PR 描述明确给出临时解法**：`@source not "…";` 排除相关文件路径。
4. **tailwindlabs/tailwindcss#19801** — <https://github.com/tailwindlabs/tailwindcss/issues/19801>
   记录了「自动生成的 markdown 含十六进制串被扫描 → Invalid code point」这一**与本例最贴近的场景**，
   并列出三种 workaround（`@source not` / 加进 repo `.gitignore` / 删文件）。
5. 规范依据：CSS Syntax §4.3.8 <https://www.w3.org/TR/css-syntax-3/#consume-escaped-code-point>
   ——越界 / 零 / surrogate 应返回 U+FFFD 而非抛错。证实这是**上游 bug**，不是本仓库用法不当。

---

### 🛠️ 6. 修复方案（未实施，待裁决）

按约束「涉及他人文件 / 依赖版本变更 → 只给方案不实施」，本轮**未改动任何业务代码**。

**方案 A（推荐 · 治类而非治例 · 不动依赖）**
在 `src/app/globals.css` 第 1 行 `@import "tailwindcss";` 之后加一行：

```css
@source not "../../.agent-workspace";
```

- 改 1 个文件、加 1 行，无依赖变更、无版本风险。
- **治的是类**：整个归档目录从此不参与扫描，未来新增的任何 AI 报告都免疫。
- 已验证：最小工程上（4.1.18 + poison 文件在 `.agent-workspace/`）加此行后 `EXIT=0`，不加则 `EXIT=1`。
- 语义正确性：`.agent-workspace/` 是 AI 归档目录，**本就不该被当作 CSS class 来源扫描**，
  排除它不会丢任何真实使用的 class。
- 注意路径相对 stylesheet（`src/app/` → 仓库根需 `../../`）。落地时需在真实仓库验证一次 `pnpm build`。

**方案 B（根治上游 · 但影响面大）**
把 `tailwindcss` + `@tailwindcss/postcss` 从 `^4.1.18` 升到 `>= 4.2.3`（latest 4.3.3）。

- 已验证 4.2.3 是修复起点（4.2.2 仍崩）。
- 真正修掉 unescape 的越界缺陷，对任何来源的越界转义都免疫。
- **代价**：跨两个 minor 的 Tailwind 升级，可能带来样式回归；本项目 `globals.css` 2422 行、
  含 `@theme inline` + 大量 `oklch` 主题预设 + `tw-animate-css` / `shadcn/tailwind.css` 三方 CSS，
  升级需完整视觉回归。且 `^4.1.18` 的 caret 语义上允许 4.3.3，但 `pnpm-lock.yaml` 锁在 4.1.18，
  需显式 `pnpm up`。**这属于依赖版本变更 + 影响面大，交裁决。**

**建议组合**：先上方案 A 立即解锁构建（低风险、治类）；方案 B 作为独立的依赖升级轮次单独排期，
届时可保留方案 A 的 `@source not`（它本身语义正确，且能省掉扫描归档目录的无谓 IO）。

**明确不做的修复（下游诱人补丁点）**：
- ❌ 删除或改写那份 md（`builtin-sub-interaction-recon.md`）——他人文件，且治例不治类，下一份报告照样崩。
- ❌ 把 `.agent-workspace/.archive/` 加进 `.gitignore`——会推翻 commit `d699ba1e`「归档 AI 报告」的明确设计意图（§2.6② archaeology：该目录是被**刻意**用 `!` 反排除保留的）。
- ❌ 在 globals.css 里对该字符串做任何转义/规避——治例不治类。

---

### ⚠️ 7. 影响面与回归风险

- **影响面**：方案 A 仅改 `src/app/globals.css` 1 行，作用域是 tailwind 扫描器的文件枚举范围，不改任何 CSS 输出。
- **回归验证锚点**：`pnpm build` EXIT=0 且产出 `out/`。本轮已用「移走触发文件」的等价隔离证明了
  构建链其余部分健康：39 个路由全部 static prerender 成功。
- **回归风险**：方案 A 若把 `@source not` 路径写错（相对层级），会静默失效（构建仍崩）或误排除真实源码目录
  （导致 class 丢失、样式缺失）。落地时必须验证 `pnpm build` 通过**且**页面样式无缺失。
- **回归守卫建议**：可加一条架构 gate——`git grep -nE '\\\\[0-9a-fA-F]{6}' -- '.agent-workspace/.archive/**'`
  命中即提示。但方案 A 生效后该风险已从源头消除，gate 属可选冗余。

---

### 🧩 8. 边界加固

本次诊断顺带暴露一个边界缺口：**仓库把 AI 归档 md 作为追踪资产保留（`.gitignore` 的 `!` 反排除），
但没有把它们从前端构建工具链的扫描面里排除**。即「归档目录是仓库资产」与「构建工具只该看源码」
这两个边界没有对齐。方案 A 正是补这个边界，而非单纯规避一个字符串。

---

## Update Log

- **2026-07-28 · debugger (Mode B 反锚定独立复核)** — 定论：根因**不在** `globals.css`（报错位置 `1:1` 是 postcss 默认归因，误导）。
  真实根因 = Tailwind v4 oxide 自动源扫描读到 `.agent-workspace/.archive/2026-07-27/builtin-sub-interaction/builtin-sub-interaction-recon.md:70`
  正文抄录的 Windows 路径，其中 `\b36bfd`（路径分隔符 + UUID 前 6 位十六进制）被 CSS unescape 正则误判为码点转义，
  `0xb36bfd = 11758589 > 0x10FFFF` → `String.fromCodePoint` 抛错。
  First broken point（依赖内）：`tailwindcss@4.1.18/dist/chunk-CT46QCH7.mjs:1:5453`（`Se()` 无边界检查）。
  证据：① 绕开 Turbopack 用裸 postcss 复现（证伪 Turbopack 归因）；② hook `String.prototype.replace` 捕获确切入参；
  ③ 双向受控翻转（移走该 md → `pnpm build` EXIT=0 产出 out/ + 39 路由 prerender 成功；移回 → 同错复现）；
  ④ `C:\Temp` 最小工程版本二分：4.1.18/4.2.1/4.2.2 崩、4.2.3/4.3.3 通过。
  上游锚点：issues #19786 / #19910 / #19801，修复 PR #19829（merged, `bd30a716`）。
  修复方案**未实施**（涉他人文件 / 依赖变更，交用户裁决）：A = globals.css 加 `@source not "../../.agent-workspace";`（推荐，治类）；
  B = tailwindcss + @tailwindcss/postcss 升至 ≥ 4.2.3（根治上游，需视觉回归）。
  诊断期临时文件已全部清理，`git status` 仅剩既存 ` M src-tauri/Cargo.toml`。未 commit。
