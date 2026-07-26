---
slug: delegation-continue-session
type: introspection
sha_range: 未 commit（spec 三件套本轮首次落盘，尚在工作区）→ 对照物为 review.codex.md / review2.codex.md / review3.codex.md 三轮意见
created: 2026-07-26
review_rounds: 3
p0_total: 7
p0_adopted: 5
p0_rejected: 2
---

# Introspection · delegation-continue-session

三阶段材料：初稿（本轮首次落盘的 design.md/requirements.md）→ 评审（R1 P0=3 / R2 P0=3 / R3 P0=1）→ 最终稿（三轮修订后）。
P0 计数说明：R1 三条（A1/A2/A3）+ R2 三条（B1/B2/B3）+ R3 一条（A1）= 7；其中 A3（租户授权）整条驳回、A2（持久化 closed）核心诉求驳回并降级 deferred，计 2 条 rejected。

---

### 误区 · I-1 · 把上游合并便利当成内部领域边界

**Fingerprint**: `PROCESS / conflate-concepts / merge-convenience-vs-domain-boundary`

**Applies When**: 设计要对齐上游 PR / 第三方 SDK / 外部契约，且你正在以「保持兼容」为理由拒绍某个内部结构。不适用：根本无外部契约的自包含模块。

**Stability**: high

**我原来怎么写**：R1 评审指出 Session 与 Turn 未分离（A1）时，我在 Property 4 下明确拒绝引入分离，写下的理由是「那会与 PR #375 的 `task_id` 契约分叉，导致将来合并要重写（违背 D2）」，改为只在文档里声明「`task_id` = session id，`RunningTask` 承担 turn 身份」。

**我当时的依据**：D2 决策（对齐上游 PR #375 契约以换取零冲突合并）。我把它当成了一条覆盖全设计的约束，于是任何"上游没有的结构"都被我判为违背 D2。

**评审指出什么问题**（R2-B3，`review2.codex.md` §B3）：「以上游 PR 的字段布局约束内部领域模型，是错误的架构优先级」——上游约束的是 **wire**，Session/Turn 分离可以完全局限在 broker 内部，用 facade 映射回上游报告结构。合并便利不能作为压缩领域模型的理由。

**认知误区归类**：`CONCEPT-CONFUSION` —— 混淆了「兼容外部契约」与「内部模型必须同构于外部契约」。前者是接口层约束，后者是我自己加的。

| 判据 | 通过? |
|---|---|
| ① 可跨项目复用 | ✅ 任何「对齐上游/第三方契约」的设计都可能踩：SDK 包装、协议适配器、fork 维护 |
| ② Rule 可执行 | ✅ 见下方绕出动作 |
| ③ 有实证锚点 | ✅ `docs/specs/delegation-continue-session/review2.codex.md` §B3；被推翻的原文在 design.md §Update Log R1 的 A1 行 |
| ④ 非单次巧合 | 🟡 本 spec 首次实证（Evidence Count = 1） |

**绕出动作**：写下「不能做 X，因为要兼容上游/第三方 Y」之前，先回答一句：**Y 约束的是 wire/API 表面，还是内部结构？** 若只约束表面 → 内部该怎么建就怎么建，加一层 facade 映射；把兼容性下沉到边界层，不要让它上浮成领域约束。判据 = 能说出「若我按正确模型建，需要在哪一层写映射代码」，答得出就说明兼容性并未真的阻塞。

**归维**：BS-NNN（作者-评审轴：主 AI 漏，codex 抓）。Direction = `作者→漏`。

---

### 误区 · I-2 · 给不可逆副作用配事后告知而非事前拒绝

**Fingerprint**: `CONTRACT / notify-after-side-effect / irreversible-degradation`

**Applies When**: 设计包含「主路径失败 → 降级路径」的流程，且降级路径会产生外部副作用（发送/写入/扣费/覆盖凭据）。不适用：纯读降级、无副作用的重试。

**Stability**: high

**我原来怎么写**：R1-F5 要求「上下文丢失」有机器可判定契约，我的处置是：resume 失败后仍降级到 `session/new` 发送消息，返回 `status: Running` + `context_lost: true` 标志，语义定义为「消息已发送、子代理从零开始」，并更新 `external_id` 为新 session。

**我当时的依据**：R1-F5 的字面要求是「把自然语言提示改成结构化结果」。我照着字面做了结构化，却没退一步问「这个操作本身该不该发生」。同时我默认「降级也比失败好」——保住了 `task_id` 稳定和 DB 行复用。

**评审指出什么问题**（R2-B1，`review2.codex.md` §B1）：这是把冷启动包装成成功续聊。消息发出后用户才知道上下文没了，无法撤回；覆盖 `external_id` 还会丢掉原会话的恢复凭据。`context_lost` 字段是在掩盖领域语义已经改变。

**主 AI 处置时亲验补强（评审只推理，我去核实了）**：`git grep update_external_id` → `lifecycle.rs:189` 是 `SessionStarted` 到达时的**无条件覆盖**（无「仅当为空才写」守卫）。即评审担心的凭据丢失不是假设，是必然发生。这条核实把 B1 从「设计品味问题」升级为「数据损坏」。

**认知误区归类**：`IMPLICIT-ASSUMPTION` —— 默认了「降级 + 告知」优于「拒绝」。对可逆操作成立，对**已产生外部副作用**的操作不成立。

| 判据 | 通过? |
|---|---|
| ① 可跨项目复用 | ✅ 任何「主路径失败 → 降级路径」的设计都可能踩：支付降级、缓存穿透兜底、协议版本回退、重试改写目标 |
| ② Rule 可执行 | ✅ 见下方绕出动作 |
| ③ 有实证锚点 | ✅ `review2.codex.md` §B1；核实锚点 `src-tauri/src/acp/lifecycle.rs:189` |
| ④ 非单次巧合 | 🟡 本 spec 首次实证（Evidence Count = 1）。与 E-014「安全跳过门控加在恢复动作内部」同属"降级路径设计错位"家族，但机制不同（E-014 是门控位置错，本条是降级时机错），交叉引用不 merge |
| 判据小结 | 4 判据全过 → 入库 |

**绕出动作**：设计任何降级/兜底路径时，先定位**副作用发生点**，再问：降级后的语义是否与原操作等价？
- 等价（纯性能差异，如走 resume 而非活连接）→ 可自动降级。
- **不等价**（上下文丢失、目标变更、精度损失）→ **必须在副作用发生前返回错误**，把是否降级的决定权交给调用方。
- 判据：「用户/调用方拿到我的成功响应后，能否撤回这次降级带来的后果？」不能撤回 = 禁止自动降级。
- 附带检查：降级过程是否会覆盖原路径的恢复凭据（id/token/游标）？若会，**先备份或拒绝覆盖**——凭据一旦被覆盖，连"回到原路径重试"都做不到了。

**归维**：BS-NNN（作者-评审轴）。Direction = `作者→漏`。

---

### 误区 · I-3 · 给缓存加职责直到它变成事实上的注册表

**Fingerprint**: `STATE-SYNC / accrete-responsibility / cache-becomes-registry`

**Applies When**: 往一个带容量/TTL/LRU 淘汰的容器新增字段，尤其是新字段会被用于判定存在性/权限/幂等。不适用：纯可重建的派生数据缓存。

**Stability**: high

**我原来怎么写**：初稿把保活连接 id、`closed` 标记、恢复元数据（`external_id`/`folder_id`/`working_dir`）、`parent_tool_use_id` 全部加到 `CompletedTask`（结果文本缓存）上，共新增 7 个字段，并声明「broker 的 `PendingInner` 是任务状态的 SSOT」。

**我当时的依据**：跟随上游 PR #375 的字段布局（它就是这么加的），加上「已经有一个按 parent 索引的 map，放这里最省」。

**评审指出什么问题**（R1-A2 + R2-B3）：`Completed_Cache` 有字节上限 FIFO 淘汰、父连接拆除时被整体丢弃，却同时承担「session 是否存在/是否已关闭/是否可续聊」的判定 —— 缓存淘汰或重启就会改变领域行为。R2 更直接：「`Completed_Cache` 从结果缓存膨胀为事实上的 session registry」。

**认知误区归类**：`SINGLE-ANGLE-VIEW` —— 只从「字段放哪里最省」角度看，没从「这个容器的生命周期语义是什么」角度看。缓存的定义特征就是**可以随时丢**，往它身上加不可丢的信息是自相矛盾。

| 判据 | 通过? |
|---|---|
| ① 可跨项目复用 | ✅ 任何 LRU/TTL/容量受限容器都可能被逐步加职责：session store、connection pool、结果缓存、去重表 |
| ② Rule 可执行 | ✅ 见下方绕出动作 |
| ③ 有实证锚点 | ✅ `review.codex.md` §A2 + `review2.codex.md` §B3 |
| ④ 非单次巧合 | 🟡 本 spec 首次实证（Evidence Count = 1） |

**绕出动作**：往一个容器加字段前，先问「**这个容器允许丢失吗？**」允许丢（缓存/索引/池）→ 只能放可重建的数据；不允许丢（领域状态/审计/幂等凭据）→ 必须放在持久层或独立的不可淘汰结构。判据：**把这个容器整个清空，系统行为应该只变慢，不变错**。若清空会导致行为错误（已关闭的会话复活、幂等失效、归属丢失），说明它已经不是缓存了 —— 要么拆出独立结构，要么把它降级为纯缓存并把领域字段搬走。

**归维**：BS-NNN（作者-评审轴）。Direction = `作者→漏`。

---

## Direction 平衡自检

本轮评审器（codex）也有漏项与错项，同样记录：

- **`评审X→漏/错`**：R1-A6 声称「用户 API 签名不含 `client_message_id`，MCP 也只有 task_id/message」，但它确实存在于 `web/handlers/acp.rs:160/176` ——评审未核实既有代码就断言字段不存在。其结论（不能充当续聊幂等键）仍成立，但依据有误。
- **`作者→漏`（评审优于我的自查）**：R3-A2 列的 5 处矛盾全部真实，是我 R2 修订留下的遗留——改了局部契约却未做全局一致性收口。已转为下方 H 候选。
- **`双方均漏`**：三轮都没人追问「`kept_alive_cap` 默认值应为多少」与「Kiro agent 的 resume 能力未实测」——后者已写入 design.md 风险段作开工核验项，前者留给实施时定。

## Rejected 意见（防「对家没提某维度 → 假盲区」）

| Issue | reject 理由 | 证据锚点 |
|---|---|---|
| R1-A3 租户/对象级授权模型 | codeg 是单用户单租户：`git grep tenant -- src-tauri/src` 仅命中 lark 后端与 paths 工具（无关用法）；`conversation` 表无 `user_id`/`workspace_id` 列（`db/entities/conversation.rs`）；server 鉴权是单个全局 `CODEG_TOKEN`（`bin/codeg_server.rs:203-219`），持有即全权。建 tenant→parent→child 归属链是为不存在的场景加防御（§0.17 D 类技术洁癖）。**部分采纳**其可落地部分：不泄漏存在性 + 拒绝把普通会话当子代理 | design.md §验收追踪矩阵「授权验收」段 |
| R1-A2 持久化 `closed` 状态 | 需给 `conversation` 加列 + 迁移，收益仅覆盖「重启后误续聊一个已关闭会话」，后果是多起一个子代理而非数据损坏。R2-B4 后该诉求本身消解：close 重定义为「资源释放」语义，重启后重新可续聊变成**正确行为**而非缺陷 | design.md §状态权威的两层划分 |

**方向对称性检查**：本轮评审器（codex）也有漏项与错项，同样记录，防评估霸权：
- R1-A6 声称「用户 API 签名不含 `client_message_id`，MCP 也只有 task_id/message」，但 `client_message_id` 确实存在于 `web/handlers/acp.rs:160/176` —— 评审未核实既有代码就断言字段不存在。其结论（不能充当续聊幂等键）仍成立，但依据有误。
- R3-A2 列的 5 处矛盾全部真实，属于**我 R2 修订留下的遗留**——评审器在这一项上表现优于我的自查（我改了局部契约却没做全局一致性收口）。这条反向记入下方启发式。

---

## 正向启发式（费劲才走对的姿势）

**H 候选**：`局部契约修订后必须做一次全局术语收口`

R2 我改了三处核心语义（`context_lost` → `resume_unavailable`、`closed` → `Released`、幂等键 → `continuation_id`），但只改了主张段落，没扫全文。R3-A2 一次性抓出 5 处残留矛盾：函数签名缺参数、错误码表没新码、Error Handling 表仍写旧机制、验收矩阵仍写旧行为、新旧术语并存。

**绕出动作**：每轮评审修订收尾时，对本轮**新引入或改名的每个术语**跑一次 `git grep <旧术语>`，命中处逐一处置。判据 = 旧术语在文档内零命中（或仅出现在「历史别名」说明处）。这与 E-060「就地覆写正文而非追加章节」同源但更细一层：E-060 治「改了主张但留在附录」，本条治「改了主张但漏了引用点」。

| 判据 | 通过? |
|---|---|
| ① 可跨项目复用 | ✅ 任何多轮评审/多轮重构的文档与代码都适用 |
| ② Rule 可执行 | ✅ grep 旧术语零命中 |
| ③ 有实证锚点 | ✅ `review3.codex.md` §A2 五条 |
| ④ 非单次巧合 | 🟡 单次（与 E-060 同根但不同层，交叉引用不 merge） |

**归维**：H-NNN（HEURISTICS.md）。

---

## 入库操作清单

| fingerprint | 维度 | 操作 | 状态 |
|---|---|---|---|
| `PROCESS / conflate-concepts / merge-convenience-vs-domain-boundary` | BS | **BS-015 新建**（grep `merge-convenience` / `upstream-wire` 零命中） | 🟡 Evidence Count = 1 |
| `CONTRACT / notify-after-side-effect / irreversible-degradation` | BS | **BS-016 新建**（grep `silent-fallback` / `degrade` / `side-effect-before` 全库零命中） | 🟡 Evidence Count = 1 |
| `STATE-SYNC / accrete-responsibility / cache-becomes-registry` | BS | **BS-017 新建**（grep `cache-becomes` 零命中；与 ANTI-PATTERNS `CONTRACT/conflate/owning-set-vs-per-request-subset` 非同根） | 🟡 Evidence Count = 1 |
| `PROCESS / partial-rename / stale-term-references`（正向面） | H | **H-006 新建**，交叉引用 E-060 | 🟡 Evidence Count = 1 |

三条 BS 均为 Mode A（作者-评审轴）· Direction = `作者→漏` · 单份 spec 实证故全部挂 🟡，待第二份 spec 同方向重现才转 🟢。
