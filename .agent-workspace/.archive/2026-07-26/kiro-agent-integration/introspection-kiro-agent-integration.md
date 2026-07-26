---
slug: kiro-agent-integration
type: introspection
sha_range: 00bc59bc..WORKTREE
review_rounds: 3
p0_total: 7
p0_adopted: 6
p0_rejected: 1
created: 2026-07-26
---

# Introspection · kiro-agent-integration

## 三阶段材料索引

- **初稿 SHA**: `00bc59bc`（charter 三件套在此 commit 之后于工作区创建，尚未提交 → 初稿状态见本文引用）
- **最终稿**: 工作区 `docs/specs/kiro-agent-integration/{requirements,design}.md`
- **Review 文件**:
  - `docs/specs/kiro-agent-integration/review.codex.md`（R1 · codex gpt-5.6-sol · NEEDS_CHANGES p0=3 / 15 条）
  - `docs/specs/kiro-agent-integration/review2.codex.md`（R2 · p0=3 / 6 条）
  - `docs/specs/kiro-agent-integration/review3.codex.md`（R3 硬止 · p0=1 / 6 条）
- **勘察报告**: `.agent-workspace/.archive/2026-07-25/kiro-agent/kiro-agent-recon.md`（565 行）
- **ADR**: `docs/architecture/ADR-0001-agent-distribution-system-binary.md`

## 初稿认知盘点（主 AI 主观复盘 · 非事实描述）

我最初这么设计：

- **决策 A · 会话轮次边界只认 `Clear`**
  - **依据**：我扫了 kind 直方图（`AssistantMessage` / `ToolResults` / `Prompt` / `Compaction` / `Clear`），
    看到 `Clear` 语义上就是"清空上下文"，直接把它当唯一分段标记。
  - **默认前提（当时没意识到）**：我默认"轮次边界"只有一种，且它一定是个显式的边界事件。
    没想过用户消息本身（`Prompt`）就是轮次起点 —— 我看的是**频率统计**，没看**序列**。

- **决策 B · MCP 配置目标是单一固定文件**
  - **依据**：`kiro-cli mcp list` 输出匹配 `settings/mcp.json` 的 8 个 server，我据此认定它是"那个文件"。
  - **默认前提**：我默认配置来源是**单选**的（"是这个文件还是那个文件"），
    没考虑分层配置系统的常态是**合并**。

- **决策 B' · R2 后改成"按所选 agent 二选一配置源"**（这是我在评审推动下做出的**新错误**）
  - **依据**：本机 6 个 agent JSON 里 5 个内嵌 `mcpServers` 且 `useLegacyMcpJson: false`，
    1 个（main）无内嵌且为 `true`。我从这个分布**推断出排他语义**："内嵌的不读全局"。
  - **默认前提**：我默认"配置文件里字段的分布"能反推"运行时的组合规则"。
  - **结果**：还为它写了一整段论证（"若固定写全局则用户改的东西完全无效，且无任何报错"）——
    论证本身自洽，但前提是错的。**用户凭日常使用经验直接指出反例**，查官方文档确认是三层合并。

- **决策 C · 验证基线 = "8 个已知失败之外全绿"**
  - **依据**：我实跑了基线，确认 `1648 passed; 8 failed`，也定位了根因（`/tmp` 硬编码 + Windows
    `is_absolute()==false`）。为防 executor 误以为是自己弄坏的，我把"8 个"写进验收标准。
  - **默认前提**：我默认"数量"能标识"身份"。没想过新回归可以**顶替**一个旧失败而总数不变。

- **决策 D · ADR needed: no**
  - **依据**：我判"删除变体即回到原状、无数据迁移" → 可逆 → 不需要 ADR。
  - **默认前提**：我把 ADR 准入条件当成了「难以逆转 **且** 边界定义」，实际是「**或**」。
    我只检查了自己先想到的那一半。

- **决策 E · `.kiro` 整根开放给 ACP 写入**
  - **依据**：Kiro 需要维护自己的会话与设置 → 把它的数据根设为可写。
  - **默认前提**：我把"Kiro 进程需要写 `~/.kiro`"和"codeg 需要代它写 `~/.kiro`"当成同一件事。

---

## 误区逐条复盘

### 误区 · P0-1 · 会话轮次边界遗漏 `Prompt`（R1-F1）

- **评审来源**：`review.codex.md` §F1
- **我原来怎么写**：初稿 R3.4「WHEN 遇到 `kind == "Clear"` THE 系统 SHALL 将其视为会话轮次的边界。」
- **我当时的依据**：kind 频率直方图 + `Clear` 的字面语义。
- **评审指出问题**：`Prompt` 同样是边界，否则 `toolResult` 可能被跨轮移动，导致工具结果配对到错误的调用。
- **我的独立验证**：实测同一 `.jsonl` 的 kind **序列**（不是频率）：
  `Prompt > AssistantMessage > ToolResults > ... > Prompt > ...`，且 `ToolResults` 从不直接跟在
  `Prompt` 后 → 确认 `Prompt` 是轮次起点，评审正确。
- **认知误区分类**：
  - [x] `SINGLE-ANGLE-VIEW` · 只从一个角度看问题（看了频率分布，没看时序结构）
- **触发信号**（本应提前触发）：
  - "解析事件流 / 日志 / transcript" —— 频率统计回答"有哪些类型"，回答不了"它们怎么排列"
  - "分段 / 边界 / 轮次" 这类概念，必须看序列而非计数
- **Fingerprint**: `CONTRACT / infer-structure-from-frequency / event-stream-boundary`
- **Applies When**: 要为一个事件流/日志格式定义分段、配对或状态机语义时。
- **NOT Applies When**: 只需知道"存在哪些事件类型"（如决定枚举变体数量）时，频率统计足够。
- **Stability**: high · 机制清晰（计数丢失顺序信息，这是数学性质而非工具怪癖）。

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | 任何 JSONL/事件流/审计日志解析都可能踩；不依赖 Kiro 字段名 |
| ② Rule 可执行 | ✅ | "要定义分段/配对语义时，必须打印一段真实**序列**，不能只看 `Group-Object` 计数" |
| ③ 有实证锚点 | ✅ | `review.codex.md` §F1；requirements R3.4–3.4.3 + P-1b；序列实测输出见 design.md Update Log R1 段 |
| ④ 非单次巧合 | ✅ | 同域已有 E-053（按符号名而非契约做变体扫描）—— 同属"用易得的替代量代替真正的判据" |

**归维决策**：通过 4 判据 → 入 `AP-016`（反直觉认知偏差：看似"统计过了就了解这个格式"，实则丢了结构）。

**库操作**：
- [x] 目标维度：`ANTI-PATTERNS.md`
- [x] Grep 结果：`assume-exclusive|merge-semant|infer-structure` 均未命中；AP-013/014/015 机制不同 → **新建 AP-016** · Status 🟡

---

### 误区 · P0-2 · 从本机配置分布推断排他语义（R2-A1 · 用户纠偏）

- **评审来源**：`review2.codex.md` §R2-A1（评审只指出"全局固定文件可能不是所选 agent 的实际来源"，
  **方向对但未给出正确语义**）；**正确语义由用户指出 + 官方文档核实**。
- **我原来怎么写**：R2 后我把 R4.1 改成「THE 系统 SHALL 按当前所选的自定义 agent 解析该 agent 的
  MCP 配置源」+ 4.1.2「WHERE 所选 agent 的定义内含 `mcpServers` THE 系统 SHALL 以该 agent 定义文件
  的 `mcpServers` 对象作为读写目标」。
- **我当时的依据**：本机 6 个 agent JSON 的字段分布（5 个内嵌 + `false`，1 个不内嵌 + `true`）。
- **评审/用户指出问题**：用户凭日常使用直接说"自定义 agent 的 MCP 工具还是依赖全局的，
  只不过可以对工具进行禁用"。官方文档（`kiro.dev/docs/cli/mcp/configuration`）确认：
  三作用域**合并**，`Agent > Project > Global`，**同名才覆盖、不同名叠加**。
- **认知误区分类**：
  - [x] `IMPLICIT-ASSUMPTION` · 默认了不该默认的（默认分层配置是单选而非合并）
- **触发信号**（本应提前触发）：
  - "同一种配置在多个位置都能写" → 先查官方的 "loading priority" / "precedence" / "conflicts" 章节
  - 手里只有**配置文件内容**却要断言**运行时生效结果** —— 这是从输入反推组合规则
- **Fingerprint**: `CONTRACT / infer-precedence-from-local-instances / layered-config-merge-semantics`
- **Applies When**: 要断言某第三方工具的分层配置（全局/项目/profile/agent 级）哪一层生效时。
- **NOT Applies When**: 单一配置文件、或已读过该工具官方 precedence 文档时。
- **Stability**: high · 分层配置默认合并是行业普遍设计（git config / eslint / tsconfig 皆然）。

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | git config / eslint / tsconfig / k8s / MCP 客户端皆分层；不含 Kiro 专有名 |
| ② Rule 可执行 | ✅ | "断言分层配置生效层之前，必须读官方 precedence 章节；本机文件内容只用于验证文档、不用于反推语义" |
| ③ 有实证锚点 | ✅ | `review2.codex.md` §R2-A1；design.md Update Log R2 段；官方文档 URL 已引；requirements R4.1–4.1.12 |
| ④ 非单次巧合 | ✅ | 同根于 §0.15「禁止用后处理结果反推前处理信息」（输入分布 → 组合规则同型） |

**归维决策**：通过 4 判据 → 入 `E-083`（`CONFIG.md`）。

**库操作**：
- [x] 目标维度：`CONFIG.md`（分层配置领域）
- [x] Grep 结果：CONTRACT.md / CONFIG.md 内均无 `precedence|merge-semant|assume-exclusive` 命中 → **新建 E-083**
- [x] 交叉引用：`AP-016`（同属"用易得替代量代替真判据"）· §0.15

---

### 误区 · P0-3 · 用失败数量代替失败集合作为验收判据（R1-F9）

- **评审来源**：`review.codex.md` §F9
- **我原来怎么写**：初稿「**验收标准 = 这 8 个已知失败之外全绿。**」
- **我当时的依据**：我实跑确认了 8 个失败并定位了根因，认为"排除已知 8 个"就够精确。
- **评审指出问题**：新回归可能**替换**某个旧失败而总数仍为 8 → 门禁不可证伪。
- **认知误区分类**：
  - [x] `SINGLE-ANGLE-VIEW` · 只从一个角度看（把"多少个红"当成了"哪些是红"）
- **触发信号**：
  - "允许已知失败 / 基线不绿 / waiver / baseline exception" → 必须固定**标识集合**并做集合比较
  - 任何"排除 N 个"的表述 —— N 是数量，不是身份
- **Fingerprint**: `VERIFICATION / substitute-count-for-identity / known-failure-waiver-set`
- **Applies When**: 基线本身不绿、需要设"允许失败"豁免的验收门禁时。
- **NOT Applies When**: 基线全绿（此时"零失败"本身就是身份判据）。
- **Stability**: high

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | 任何有 baseline waiver 的 CI/测试门禁；不含项目字段 |
| ② Rule 可执行 | ✅ | "设已知失败豁免时，必须写出测试标识全集 + 错误指纹，验收做集合 ⊆ 比较" |
| ③ 有实证锚点 | ✅ | `review.codex.md` §F9；requirements「验证基线」段（8 个标识 + 错误指纹 + 三条判据） |
| ④ 非单次巧合 | ✅ | **同域已有 E-082**（用字符串匹配代替退出码 → 伪造"基线绿"）· 同根：**用易得的弱信号代替真判据，导致门禁不可证伪** |

**归维决策**：通过 4 判据 → **追加实证到 E-082**（同 TYPE `VERIFICATION`、同根机制"判定器不可证伪"，
但 verb/object 不同：E-082 是 `verdict-parsing/case-insensitive-match`，本条是
`substitute-count-for-identity/known-failure-waiver-set`）→ 按 taxonomy「部分匹配 · 同根 → merge」，
在 E-082 的 Ref/Evidence 段追加本轮场景，并把"数量≠身份"补进其 Rule。

**库操作**：
- [x] 目标维度：`VERIFICATION.md`
- [x] Grep 结果：命中 `E-082`（`VERIFICATION.md:174`）→ **追加实证**（不新建编号）

---

### 误区 · P0-4 · ADR 准入条件误读为「且」（R1-A6）

- **评审来源**：`review.codex.md` §A6
- **我原来怎么写**：design.md「**needed: no** …该决策**可逆**…不满足「难以逆转 + 边界定义」的 ADR 准入条件。」
- **我当时的依据**：我检查了可逆性（删变体无数据迁移）→ 判 no。
- **评审指出问题**：`background.md` 的 W4/checklist 明确要求为 `SystemBinary` 建 ADR，两处互斥。
- **复查结论**：准入条件是「难以逆转 **或** 边界定义」，`AgentDistribution` 是跨 agent 的分布模型
  → 命中后者 → 需要。我初稿把「或」当「且」，且只验证了自己先想到的那一半。
- **认知误区分类**：
  - [x] `MISSING-PREMISE` · 遗漏了本该在前提清单里的一项（准入条件的第二个析取项）
- **Fingerprint**: `PROCESS / evaluate-one-disjunct-only / multi-condition-admission-gate`
- **Applies When**: 判定一个「满足任一条件即触发」的门禁（ADR 准入 / 升级条件 / 告警规则）时。
- **NOT Applies When**: 合取门禁（所有条件都需满足），此时否证一项即可结论。
- **Stability**: medium · 依赖门禁本身的措辞清晰度。

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | 任何析取型门禁；不含项目名 |
| ② Rule 可执行 | ✅ | "判析取门禁时逐项列出并逐项判定，禁止验证一项就下结论" |
| ③ 有实证锚点 | ✅ | `review.codex.md` §A6；design.md「ADR admission」段已翻转；ADR-0001 已落盘 |
| ④ 非单次巧合 | ❌ | **本轮首次**，全局库中未找到同 fingerprint 或近邻 |

**归维决策**：④ fail（单次）→ 按 skill 规约，单次实证**仍可新建但挂 🟡**。
判据表 ④ 的定义是"单次挂 🟡 待第二次实证"，非 fail-to-reject → **新建 BS-012 · Status 🟡 · Evidence Count = 1**。
Direction = `主 AI 漏 · 评审器抓`。

**库操作**：
- [x] 目标维度：`CROSS-MODEL-BLINDSPOTS.md`（Mode A 作者-评审轴：我漏、评审抓）
- [x] Grep 结果：BS-007/010/011 机制不同 → **新建 BS-012** · 🟡

---

### 误区 · P0-5 · 混淆「进程自己写」与「宿主代它写」（R2-A2）

- **评审来源**：`review2.codex.md` §R2-A2（R1-F8 已指出主体不清，R2 升级为要求证明必要性）
- **我原来怎么写**：初稿 R8.1「THE 系统 SHALL 把 Kiro 的数据根设为用户主目录下的 `.kiro` 目录」
  + 8.2「WHEN Kiro 通过 ACP 请求写入其数据根之内的路径 THE 系统 SHALL 允许该写入」。
- **我当时的依据**：Kiro 需要维护自己的会话与设置 → 给它写权限。
- **评审指出问题**：进程原生持久化**推不出** ACP 需要整个 `.kiro` 根写权限；ACP 通路是**模型可驱动**的，
  开放整根等于把写入面扩到会话记录 / agent 定义 / MCP 凭据。
- **认知误区分类**：
  - [x] `CONCEPT-CONFUSION` · 概念混淆（"进程需要写 X" vs "宿主需要代它写 X"是两个主体）
- **Fingerprint**: `SCOPE / conflate-subjects / process-native-write-vs-host-proxied-write`
- **Applies When**: 为外部进程/插件/agent 设定宿主代理的文件或网络授权范围时。
- **NOT Applies When**: 目标进程完全不经宿主做 I/O（无代理通路）。
- **Stability**: high

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | 任何 host-plugin / MCP / LSP / sandbox 授权设计通用 |
| ② Rule 可执行 | ✅ | "定授权范围前先问：这条通路的调用主体是谁？是进程自己还是模型可驱动的代理？" |
| ③ 有实证锚点 | ✅ | `review.codex.md` §F8 + `review2.codex.md` §R2-A2；requirements R8 已重写为白名单 + 8.7 |
| ④ 非单次巧合 | 🟡 | 本轮首次；与 AP-013（拥有多凭据 ≠ 每请求发全部）同属"授权范围过宽"家族但机制不同 |

**归维决策**：新建条目 · 归 `SCOPE.md` · **E-084** · Status 🟡 · 交叉引用 AP-013。

**库操作**：
- [x] 目标维度：`SCOPE.md`
- [x] Grep 结果：未命中同 fingerprint → **新建 E-084** · 🟡

---

### 误区 · P0-6 · 历史资产自称「执行契约」造成双真源（R3-A1）

- **评审来源**：`review3.codex.md` §R3-A1
- **我原来怎么写**：把上一轮残存的规格 `git mv` 成 `background.md` 当"背景输入"，
  但**没改它的自我定位** —— 它头部仍写着「**执行契约**：本文所有「决策」段是**已定案**」。
- **我当时的依据**：我认为"放进 spec 目录当 background、charter 里引用它作历史"就足以表明它不是契约。
- **评审指出问题**：requirements / design / background 三份文档对"MCP 凭据明文 vs 脱敏"存在互斥契约。
- **我的处置**：根因不在 requirements，而在 background 的**自我声明**。
  → 整体降级：文件头加「本文不是执行契约，冲突处一律以 requirements/design 为准」+ 9 条推翻对照表。
  这消除双真源，而不是在三份文档间同步同一句话。
- **认知误区分类**：
  - [x] `PROCESS` · `conflate-concepts` · 混淆"文件的物理位置/引用关系"与"文件的规范性地位"
- **Fingerprint**: `PROCESS / relocate-without-restating-authority / superseded-doc-self-declared-contract`
- **Applies When**: 把旧规格/旧设计降级为参考资料，或引入他人文档作为输入时。
- **NOT Applies When**: 新建文档（无历史自我声明）。
- **Stability**: high
- **同根条目**：E-060（决策记录 vs 决策落地 · `PROCESS/conflate-concepts/update-log-vs-canonical-body`）
  —— 同 TYPE 同 verb，object 不同（那条是"记录了但没落地正文"，本条是"移了位置但没撤销权威声明"）。

**4 判据 Generalizability Gate**:

| 判据 | 通过? | 证据 |
|---|---|---|
| ① 可跨项目复用 | ✅ | 任何 spec 迭代 / 文档继承场景 |
| ② Rule 可执行 | ✅ | "降级一份旧文档时，必须改它自己的头部声明，而非仅移动位置或在别处说明" |
| ③ 有实证锚点 | ✅ | `review3.codex.md` §R3-A1；`background.md` 头部已重写 |
| ④ 非单次巧合 | ✅ | 同根于 E-060（PROCESS/conflate-concepts）→ **追加实证** |

**归维决策**：同根 → **追加实证到 E-060**（`PROCESS.md`），在其 Evidence 追加"另一场景：
旧规格降级为 background 时未撤销其『执行契约』自我声明 → 三文档互斥"。

**库操作**：
- [x] 目标维度：`PROCESS.md` · E-060
- [x] Grep 结果：命中 → **追加实证**

---

## Rejected 意见（每条一行 · reject 理由 + 证据锚点）

- `R1-A3 补限界上下文与依赖图` · reject：往已有 12 agent 的成熟注册表加第 13 个，上游架构未变；
  补领域概念图不改变任何实现、不消除已识别风险（横切风险已由 CCV 链路表覆盖）· §0.17 D 类
- `R1-A5 建跨注册表自动一致性门禁` · reject：本仓零 pre-commit hook（`core.hooksPath` 为空，
  实测 `.git/hooks` 只有 sample）；评审自己也写"长期重构可另立任务，不必阻塞本次接入"
- `R1-F3 会话资源预算入 AC` · reject：只读路径的分页/性能属实现细节；真实风险（`Compaction` 单条
  43KB 且可能含 steering 全文）已作为 R3.5.1 入 AC
- `R1-F5 模型列表定义 CLI 来源/缓存` · reject：`background.md` §4 已实测 `--list-models` 未登录时
  挂在 auth portal；R2-F1 采纳的替代方案（预设非权威 + 允许自定义输入）不需要调 CLI
- `R1-F6 whoami 检测实际认证来源` · reject：`kiro-cli` 子命令输出与 stderr 日志混排（本轮实测），
  把 UI 建在解析其自由文本上是脆弱依赖；用户已裁决降级为提示文案（R7.4）
- `R2-A4 在 ADR 中再比一轮枚举扩展 vs 职责拆分` · reject：ADR-0001 已固化三方案对比；
  9 处 match 是编译器强制暴露的机械落点，非职责过载
- `R2-A5 按能力纵向拆波次` · reject：波次依据是**实测的共享文件冲突面**
  （`connection.rs` 9929 行含 4 个关注点、`commands/acp.rs` 13149 行含 6 处 match）；
  按能力纵切会让两个 executor 同改一文件
- `R3-F4 把信任边界写进 background.md 的 D5` · reject：该文件本轮已整体降级为非契约，
  往其中补契约级约束会**重建刚消除的双真源**（正是 R3-A1 的根因）；约束已在 R5.1–5.6

## 项目特例（不入全局库 · 只入本 spec Update Log）

- `Kiro CLI 版本 2.12.1 → 2.14.2 漂移` · fail 判据 ①（具体版本号不可迁移）· 已入 design.md Current-State Inventory
- `chat_channel::webhook 测试模块不存在` · fail 判据 ①（项目具体测试名）· 已入 design.md
- `Tailwind @source not 零命中` · fail 判据 ①（项目具体配置）· 已入 design.md 未决风险
- `tools/git-pre-commit.ps1 在本仓不存在` · fail 判据 ①（跨仓设施混淆，属单次环境差异）· 已入 design.md

## Direction 平衡自检（防评估霸权）

- **主 AI 漏 · 评审器抓**：5 条（P0-1 / P0-3 / P0-4 / P0-5 / P0-6）
- **评审器漏 · 主 AI 抓 or 用户抓**：**2 条**
  1. **评审器给出错误方向、用户纠正**（P0-2）：R2-A1 只指出"全局固定文件可能不是实际来源"，
     未给出正确语义；我据本机数据改成"二选一"后，是**用户**凭日常使用经验指出反例，
     官方文档核实为三层合并。→ **评审器在缺少外部文档访问能力时，只能报"这里可疑"，
     报不出"正确语义是什么"；主 AI 若据本机数据自行补全，会产出比原稿更错的版本。**
     这条已归 BS 的对偶方向（见下）。
  2. **评审器未识别 background.md 是双真源根因**：R1/R2 两轮都在 requirements 侧反复要求
     "冻结唯一契约"（R1-A1、R2-A3），直到 R3 才指出三文档互斥；而根因（background 自称契约）
     从 R1 起就存在。→ 评审器倾向在**被指定审阅的文件内**找问题，对"输入材料本身的规范性地位"
     不敏感。
- **BS-012 已记录 Direction = 主 AI 漏**；上述第 1 条的对偶方向（评审器"报可疑但给错方向、
  诱发主 AI 产出更差版本"）作为 **BS-012 的 Anti-Pattern 备注**一并记录，避免单向对齐。

## 库操作汇总清单

| 操作 | 目标 | 状态 |
|---|---|---|
| 新建 | `AP-016` · `CONTRACT/infer-structure-from-frequency/event-stream-boundary` · 🟡 | [ ] pending |
| 新建 | `E-083`（CONFIG.md）· `CONFIG/infer-precedence-from-local-instances/layered-config-merge-semantics` · 🟡 | [ ] pending |
| 追加实证 | `E-082`（VERIFICATION.md）· 补"数量≠身份"到 Rule · Evidence 1 → 2 | [ ] pending |
| 新建 | `BS-012`（CROSS-MODEL-BLINDSPOTS.md）· 析取门禁只验一项 · 🟡 · 含对偶方向备注 | [ ] pending |
| 新建 | `E-084`（SCOPE.md）· `SCOPE/conflate-subjects/process-native-write-vs-host-proxied-write` · 🟡 | [ ] pending |
| 追加实证 | `E-060`（PROCESS.md）· 补"降级文档未撤销权威声明"场景 | [ ] pending |
| 项目特例 | 4 条 · 已入 `design.md` Current-State Inventory / 未决风险 | [x] done |

## 提交契约

本文件落盘后，主 AI 在同 commit 内执行上表所有库文件修改，commit body 引用本文件路径。
