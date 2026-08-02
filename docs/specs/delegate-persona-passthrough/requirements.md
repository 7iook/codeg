# Requirements · delegate-persona-passthrough

## Introduction

`delegate_to_agent` MCP 工具当前只允许主 AI 挑「哪个 CLI 供应商」派子任务(claude_code / codex / kiro / …),不允许挑「用该 CLI 里的哪个人格 / subagent 定义」。用户在 Kiro 的 `<KIRO_HOME>/agents/<name>.json`、Claude Code 的 `~/.claude/agents/<name>.md`、Codex 的 `~/.codex/agents/<name>.md` 里已定义了若干人格(如 `plan-reality-recon` / `debugger` / `executor`),但派任务时无法一次性点名。本 spec 在 delegation 工具链新增可选字段 `subagent_type`,让主 AI 派任务时能透传人格选择。三家 CLI 的 wrapper 支持面差异明显,方案本身需要区分对待:Kiro 原生就位,Claude / Codex 只能走「首轮消息前贴人格文本」变通(不是「真人格」)。

## Success State (§0.16 · MANDATORY · sourced, NEVER self-invented)

NOT `delegate_to_agent` 的 wire schema 里出现一个新字段, BUT 三家 CLI 各按其**真实支持面**兑现人格选择:
- **Kiro**(真人格):子进程 argv 出现 `--agent <name>`,kiro-cli 加载 `<KIRO_HOME>/agents/<name>.json` 完整定义(权限 / 工具 / 提示词全生效)。
- **Claude Code / Codex**(**best-effort 提示词模拟,不是真人格**):子会话首轮 prompt 前面出现 `~/.claude/agents/<name>.md` 或 `~/.codex/agents/<name>.md` 的 markdown body 文本。**权限模式 / 工具白名单 / 模型 / hook 等 frontmatter 高阶字段全部丢失**,仅文本指令生效。wire schema 与 UI 均明写这个差异,主 AI 与用户不得误以为等价于原生人格。

Must NOT happen:
- 主 AI 传 `subagent_type` 到不支持的 CLI(其它 8 家)时,delegation 因此失败或超时——必须静默降级为「不生效 + note」。
- Kiro / Claude / Codex 派人格失败的 wire code 语义分家(不是矛盾,是**故意的两条恢复路径**):
  - **Kiro** — 由 kiro-cli 自校验(`connection.rs:1234 verify_kiro_selected_agent_exists`)决定,failure 落 `spawn_failed`。主 AI 语义:「kiro 启动过程有事,重试或换一家」。
  - **Claude / Codex** — 由 broker 预校(name grammar)+ persona resolver(文件读取/UTF-8/上限/canonical)决定,failure 落 `invalid_persona`。主 AI 语义:「人格名/文件本身有问题,修名重试」。
  - 这两类错误码**不是「统一 invalid_persona」**——是根据 failure 发生的**层级**分开命名,主 AI 需要用不同的应对策略,故意不合并。
- 同一次 delegation 同时应用两层人格(Kiro 走 `--agent` + Claude 走 preamble prepend)——每家 CLI 只走一条路径,互斥。
- codeg 服务器模式下,主体 A 的 delegation 调用能读到主体 B 私有目录的人格文件。**v1 明写:桌面与服务器共享单主体信任模型**(CLAUDE.md 项目说明:server 模式共享一个 `CODEG_TOKEN` + 一个 data dir),persona 文件均从**当前进程 `$HOME`** 下读取,不做租户隔离,不承诺多用户安全。
- 前端 delegation card 从 `raw_input.subagent_type` 直接渲染成「已生效人格」——unsupported CLI 传了 subagent_type 也会假显示「已应用」。UI 必须消费 outcome-level 的 `applied_persona` 状态(见 Requirement 5),不消费请求参数。

Source: 用户 2026-08-03 原话「我想在调用这个智能体的时候也能传入这个自定义的」+「主要需要支持的是 claude kiro codex 当然如果其他几个能一起做是最好的」。用户对 Claude/Codex 只能走 preamble 变通的语义降级问题(AskUserQuestion Q1)declined,主 AI 依 §0.20 依据「recon 已证明 wrapper 无原生入参 + 用户明确要求三家都做」定选项 2(preamble 变通)并**同步收窄 wire 语义**为 best-effort,不主张真人格等价。下游消费者前置条件:`connection.rs:213 kiro_launch_args` 已消费 `runtime_env["KIRO_AGENT"]`;Claude/Codex 侧下游消费者待建(`send_prompt_linked_for_delegation` 首轮 prompt 拼接点)。

Verified once by(**六条**真实链路验收矩阵,任一失败视为未达成 Success State):

1. **Kiro 真人格 e2e**:桌面 codeg 起 host,发 `delegate_to_agent({agent_type:"kiro", task:"say hi", subagent_type:"plan-reality-recon"})`,子 Kiro 会话卡片显示「Kiro · @plan-reality-recon」,`[ACP] spawning` 日志含 `--agent plan-reality-recon`。
2. **Claude Code preamble e2e**:同 host 发 `agent_type:"claude_code"` + 相同 subagent_type,先在 `~/.claude/agents/plan-reality-recon.md` 落一份内容特征字符串 `SPEC_MARKER_R1_CLAUDE`,子会话首轮 prompt 前 300 字节含该字符串。
3. **Codex preamble e2e**:同 §2,`~/.codex/agents/plan-reality-recon.md` + `SPEC_MARKER_R1_CODEX`,子会话首轮 prompt 含该字符串。
4. **Unsupported CLI 静默降级**:发 `agent_type:"gemini"` + 任意 subagent_type,delegation 成功返回,`DelegationSuccess.text` 尾部含 `[note] subagent_type=... ignored for gemini`,子进程日志**不**含 `--agent` 参数,首轮 prompt **不**含任何 preamble。
5. **Invalid persona 硬失败**:三家 CLI 各发一次 `subagent_type: "nonexistent-persona-xyz"`,Kiro 返回 `spawn_failed`(kiro-cli 自校验),Claude/Codex 返回 wire code `invalid_persona`(broker preamble 读取失败),主 AI 拿到能重试。
6. **并发 fan-out 人格隔离**:同时发两个 delegation 调用,`agent_type:"kiro"` + 不同 subagent_type,两子进程 argv 分别含各自的 `--agent <name>`,互不污染;`~/.claude/agents/` 同法覆盖 Claude/Codex。

## Glossary

- **`delegate_to_agent`**: codeg-mcp 伴生进程暴露给主 AI 的 MCP 工具,子任务派发入口。定义:`src-tauri/src/acp/delegation/tool_schema.json`。
- **`DelegationRequest`**: broker 收到的 wire request 结构。定义:`src-tauri/src/acp/delegation/types.rs:53-75`。
- **`ConnectionSpawner`**: broker 与 ACP 层之间的 spawn trait。定义:`src-tauri/src/acp/delegation/spawner.rs:85-138`。
- **`spawn_child_inner`**: production spawner 里实际 spawn 子进程的一处。定义:`src-tauri/src/acp/manager.rs:2960-3010`。
- **`runtime_env`**: `BTreeMap<String,String>`,由 `build_session_runtime_env` 从 DB `agent_setting.env_json` 构造,承载子进程启动阶段的所有 codeg 私有 knob 与用户 env。定义:`src-tauri/src/commands/acp.rs:8239-8281`。
- **`kiro_launch_args`**: 从 `runtime_env` 翻译出 kiro-cli 命令行标(`--agent / --model / --effort / …`)。定义:`src-tauri/src/acp/connection.rs:213`。
- **`KIRO_AGENT_ENV`**: codeg 私有 env key `"KIRO_AGENT"`,由 `apply_kiro_env_policy` 在子进程环境泄漏前剥除(仅用作 launch-arg 中转)。定义:`connection.rs:189`。
- **subagent (人格)**: 上游 CLI 里的可命名子智能体定义。Kiro `<KIRO_HOME>/agents/<name>.json` / Claude `~/.claude/agents/<name>.md` / Codex `~/.codex/agents/<name>.md`。**注意:不同于本仓已有 `subagent-transcript` capability(那是显示层「透出子会话文本」),二者语义不重叠**。
- **Preamble 注入**: Claude / Codex 走的变通路径 —— 首轮 prompt 前 prepend 人格文件的 markdown body,不是真人格(丢失权限模式 / 工具白名单等高阶字段)。
- **Delegation card**: 前端时间轴里代表「派了子智能体」的卡片。定义:`src/lib/delegation-card.ts`。

## Requirements

### Requirement 1: `delegate_to_agent` 接受可选 subagent_type

**User Story:** As a host AI(主 AI), I want to pass `subagent_type` alongside `agent_type` when calling `delegate_to_agent`, so that the sub-agent runs under the persona I nominated.

#### Acceptance Criteria (EARS)

1. THE `delegate_to_agent` tool schema SHALL declare `subagent_type` as an optional string field on `inputSchema.properties`.
2. WHEN a `tools/call` for `delegate_to_agent` arrives with `arguments.subagent_type` set to a non-empty string, THE codeg-mcp companion SHALL forward it verbatim to the broker via `BrokerRequest.input.subagent_type`.
3. IF `arguments.subagent_type` is missing, empty, whitespace-only, or non-string, THEN THE listener SHALL treat it as absent and construct `DelegationRequest.subagent_type = None`.
4. WHERE `subagent_type` is present in `DelegationRequest`, THE broker SHALL derive a per-call typed `LaunchOption` value(NOT a generic env-override map)based on `agent_type` before invoking `ConnectionSpawner::spawn`. The `LaunchOption` enum is closed by design (v1 has only `KiroPersona(String)`); adding a new CLI's launch mechanism requires a new variant, never a `BTreeMap<String,String>` escape hatch.

### Requirement 2: Kiro 走 `--agent <name>` 通道

**User Story:** As a host AI delegating to Kiro, I want the nominated persona to reach the child `kiro-cli acp` process as `--agent <name>`, so that Kiro loads the persona definition from `<KIRO_HOME>/agents/<name>.json`.

#### Acceptance Criteria (EARS)

1. WHEN `agent_type == Kiro` AND `subagent_type == Some(name)`, THE broker SHALL construct `LaunchOption::KiroPersona(name)` and pass it as the `launch_option: Option<LaunchOption>` argument of `ConnectionSpawner::spawn`. Translation from `LaunchOption::KiroPersona` to `runtime_env["KIRO_AGENT"]` SHALL happen ONLY inside the production `spawn_child_inner` adapter — the broker itself SHALL NOT mutate any env map.
2. THE `spawn_child_inner` production adapter SHALL merge the translated `KIRO_AGENT` value into `runtime_env` AFTER `build_session_runtime_env` returns AND BEFORE calling `manager.spawn_agent(...)`. The merge order MUST land before `apply_kiro_env_policy` runs (inside `spawn_agent_connection`), otherwise the policy strips `KIRO_*` private keys — this ordering invariant SHALL be enforced by unit test.
3. WHERE the panel's `agent_setting.env_json[KIRO_AGENT]` is also set, THE per-call override SHALL take precedence(per-call wins).
4. THE existing `verify_kiro_selected_agent_exists`(`connection.rs:1234`) SHALL run against the post-merge `runtime_env`, so a nonexistent persona name causes a `spawn_failed` at kiro-cli launch time rather than silently loading the panel default.
5. IF `kiro_launch_args` receives the merged `runtime_env`, THEN it SHALL emit `--agent <name>` into the child argv exactly as it does today for panel-configured `KIRO_AGENT`.

### Requirement 3: Claude Code / Codex 走首轮 Preamble 注入(best-effort · 非真人格)

**User Story:** As a host AI delegating to Claude Code or Codex, I want the nominated persona's markdown body to be prepended to the first turn as a system-prompt hint, so that the sub-agent's behaviour is nudged toward that persona for the delegated task — while accepting that permission mode / tool allowlist / model / hook fields are lost.

#### Acceptance Criteria (EARS)

1. WHEN `agent_type ∈ {ClaudeCode, Codex}` AND `subagent_type == Some(name)`, THE broker SHALL resolve a persona preamble by reading a file whose canonical path, after symlink resolution, is a direct child of `<current_process_home>/.claude/agents/` (ClaudeCode) or `<current_process_home>/.codex/agents/` (Codex).
2. WHERE the persona file's canonical path is inside the expected root AND the file is valid UTF-8 AND its size ≤ 200 KiB, THE broker SHALL prepend its body (after stripping a leading YAML frontmatter block if present, honouring BOM / CRLF / LF / unclosed frontmatter per design §Persona Resolver) to the delegation `task` string with a separator `\n\n---\n\n` before invoking `spawn.send_prompt_linked_for_delegation`.
3. IF the persona name fails grammar (see Requirement 3-name-grammar below) OR the resolved canonical path escapes the expected root OR the file is missing OR is not valid UTF-8 OR exceeds 200 KiB OR the body (post-frontmatter) is empty, THEN THE broker SHALL fail the delegation with wire code `invalid_persona` and message `"persona '<name>' unavailable: <specific reason>"` — do NOT silently proceed without the persona.
4. THE persona resolution SHALL happen exactly once per delegation call. Follow-ups via `continue_with_session` / `send_followup_prompt` SHALL NOT re-resolve or re-prepend — the captured preamble lives in the child conversation's first user turn (which persists in the `conversation` table). Whether the wrapper actually replays this first turn on `session/resume` / `session/load` is `unverified: to be confirmed by executor via Requirement 7.2`; codeg makes no additional guarantee here.
5. WHILE a delegation for Claude Code or Codex is in flight, THE broker SHALL NOT inject any `LaunchOption::KiroPersona` — Preamble and Kiro paths are mutually exclusive per `agent_type`.
6. THE wire schema `subagent_type` description AND the frontend delegation card AND the `[note]` line on unsupported CLIs SHALL each carry a `best-effort` marker for Claude / Codex to distinguish from Kiro's real-persona semantics.
7. THE wire schema description AND the frontend `(best-effort)` marker SHALL further warn that if the host AI's task depends on the persona's hard invariants — permission mode, tool allowlist, model pinning, hook chain — the caller SHOULD either target Kiro only (real persona) or wait for upstream wrapper native support; the Claude/Codex path only carries markdown body text and cannot enforce those hard invariants.

#### Requirement 3-name-grammar (Persona name grammar · shared across all three CLIs)

1. THE grammar SHALL be: 1 ≤ length ≤ 64 characters, each character in `[A-Za-z0-9_-]` (letters, digits, hyphen, underscore only).
2. IF the name contains `.`, `/`, `\\`, or any character outside the grammar, THEN THE listener OR broker SHALL reject the request with wire code `invalid_persona` and message `"persona name '<name>' violates grammar: <detail>"` before touching the filesystem.
3. THE grammar SHALL apply uniformly to Kiro, ClaudeCode, and Codex — Kiro's own `<KIRO_HOME>/agents/<name>.json` naming happens to already satisfy this grammar; enforcing it in codeg is an added defense-in-depth check, not a change to Kiro's contract.

### Requirement 4: 未识别 CLI 的静默忽略语义

**User Story:** As a host AI, I want to pass `subagent_type` for any CLI I choose, so that I don't have to know upfront which CLIs support personas — CLIs that don't support it simply ignore the field with a visible note.

#### Acceptance Criteria (EARS)

1. WHERE `agent_type ∉ {Kiro, ClaudeCode, Codex}` AND `subagent_type == Some(_)`, THE broker SHALL NOT inject any per-call env override AND SHALL NOT resolve a preamble.
2. WHEN the delegation of a non-supporting CLI completes successfully, THE `DelegationSuccess.text` returned to the host AI SHALL carry a one-line note `[note] subagent_type='<name>' ignored for <agent_type> (persona not supported)`.
3. IF the delegation fails for reasons unrelated to `subagent_type`, THEN the note MAY be omitted; tracing::info!(target="delegation::persona") SHALL always record the ignore event regardless of outcome.
4. THE tool schema description for `subagent_type` SHALL enumerate the supported CLIs(Kiro / Claude Code / Codex)and clearly warn that other CLIs will ignore the field.

### Requirement 5: 前端 Delegation Card 显示所派人格(消费 outcome-level 状态)

**User Story:** As a codeg user reviewing the session timeline, I want to see which persona was ACTUALLY applied (native / hint / ignored / failed) at a glance, so that I can trust the label instead of second-guessing whether the request took effect.

#### Acceptance Criteria (EARS)

1. THE broker SHALL emit an outcome-level field `applied_persona: Option<AppliedPersona>` alongside `DelegationSuccess` / `DelegationTaskReport`, where `AppliedPersona` is a **three-variant** tagged enum(R3 F2 删掉 Failed 变体):
   - `Native { name: String }` — Kiro real-persona path succeeded (`--agent <name>` reached kiro-cli argv **AND spawn returned Ok**).
   - `Hint { name: String }` — Claude/Codex preamble prepended successfully **AND** `send_prompt_linked_for_delegation` returned Ok (即首轮 prompt 已被接受金)。
   - `IgnoredUnsupportedCli { name: String }` — an unsupported CLI silently dropped the request; delegation succeeded without persona.
   - **No `Failed` variant** — persona resolution / spawn / send failures 都走既有 `DelegationOutcome::Err` 通道(wire_code = `invalid_persona` / `spawn_failed` / …),UI 把 `wire_code` 与 `raw_input.subagent_type` 拼一起展示。**不扩 Err payload,不引新 wire 契约面与旧客户端兼容风险**(R3 F2 采纳)。
2. WHEN the delegation card renders(`src/lib/delegation-card.ts`), THE parseInput helper SHALL extract `subagent_type` from `raw_input` JSON ONLY for the "requested" indicator, AND the render layer SHALL prefer the outcome-level `applied_persona` value from `DelegationSuccess.applied_persona` for the primary label whenever it is present.
3. WHERE `applied_persona == Native { name }`, THE card SHALL display `<Agent Label> · @<name>` as the primary label. WHERE `applied_persona == Hint { name }`, THE card SHALL display `<Agent Label> · @<name> (best-effort)`. WHERE `applied_persona == IgnoredUnsupportedCli { name }`, THE card SHALL display `<Agent Label> · @<name> (ignored — CLI unsupported)` with a distinct grey/dim styling.
4. **失败渲染完全复用既有失败卡机制**(R3 F2): WHERE the delegation resulted in `DelegationOutcome::Err { code, message, .. }` AND `raw_input.subagent_type` is non-empty, THE card SHALL render its existing error state AND append a `requested: @<subagent_type>` line to explain what persona was nominated — no new outcome-level field, no new Err payload extension.
5. WHERE `applied_persona` is absent AND no error is present (legacy path or terminal state before it can be attached), THE card SHALL NOT display any secondary label — do NOT fall back to raw_input, since raw_input represents the request, not the effect.
6. THE card SHALL truncate the displayed name at a maximum of 32 Unicode grapheme clusters, appending `…` on overflow; the full name SHALL remain accessible via hover tooltip and copy action.
7. THE character grammar defense (Requirement 3-name-grammar) already guarantees safe display characters, so no per-character truncation is needed at the UI layer.

### Requirement 8: 服务器模式的单主体信任边界(v1 明写)

**User Story:** As a codeg operator deploying the server mode (`codeg-server`), I want the persona-passthrough feature to behave predictably on a single-tenant boundary that matches the rest of codeg-server's trust model, so that I don't accidentally expose one operator's persona files to another.

#### Acceptance Criteria (EARS)

1. THE persona file lookup SHALL always resolve `home_dir` from the **current process's own `$HOME`** (POSIX `HOME` env var; Windows `USERPROFILE`), not from any request-level identity, not from any conversation-owner identity, not from any tenant identifier.
2. WHERE codeg is running in `codeg-server` mode, THE feature SHALL rely on `codeg-server`'s existing trust model — one `CODEG_TOKEN` + one data dir shared across an operator's devices — and inherit the same single-tenant semantics as every other codeg-server capability. Multi-tenant isolation of personas is EXPLICITLY OUT OF SCOPE for v1.
3. THE server-mode deployment documentation (or the wire schema description if no server-mode doc exists) SHALL state, in plain language, that persona files are read from the codeg-server process's own `$HOME` and are shared across all authenticated callers.
4. IF a future requirement demands multi-tenant persona isolation, THAT SHALL be introduced as a follow-up spec with its own owner/tenant schema — not silently retrofitted onto this one.

### Requirement 6: MCP 协议兼容性

**User Story:** As an operator upgrading codeg without changing host AI prompts, I want the existing single-arg `delegate_to_agent` calls to keep working, so that no downstream contract breaks.

#### Acceptance Criteria (EARS)

1. THE `subagent_type` field SHALL default to absent in `DelegationRequest` when omitted from `tools/call.arguments`(serde `#[serde(default, skip_serializing_if = "Option::is_none")]`).
2. WHEN a legacy client calls `delegate_to_agent` without `subagent_type`, THE broker SHALL follow the exact code path it followed before this spec's implementation(no new env merge, no preamble read, no note).
3. THE `codeg-mcp` binary SHALL continue to build under `cargo check --no-default-features --bin codeg-mcp`(no `tauri-runtime` feature required on any new field or function).
4. WHERE `subagent_type` is exposed in tool_result / delegation notification events, THE wire representation SHALL be JSON `snake_case` matching the request field(no rename to `subagentType` on any leg).

### Requirement 7: Fan-out 并行 delegation 的 subagent 隔离 & Resume 契约

**User Story:** As a host AI running a fan-out(`plan-reality-recon` in parallel with `debugger`), I want each child to load its own persona independently, so that one child's persona never leaks into another; and I want session resume across process death to behave predictably per each CLI's native mechanism.

#### Acceptance Criteria (EARS)

1. WHEN two `delegate_to_agent` calls are in flight concurrently against the same `agent_type` but different `subagent_type` values, EACH child sub-agent SHALL run under exactly its own resolved persona.
2. THE per-call `LaunchOption`(Kiro path)AND the per-call resolved `preamble`(Claude/Codex path)SHALL be scoped to a single spawn call — no shared mutable state, no ordering-dependent merge across concurrent broker requests.
3. **Persona SSOT (Single Source of Truth) · R3 A1 降级采纳**: `subagent_type` 不入 codeg-side DB。codeg 不代管进程死亡后的 persona 状态,也不重新提名。本 v1 明确采纳「降级为首次启动状态」方案:
   - **`applied_persona` 只描述首次启动**(即 broker 首次 spawn + send_prompt 成功那一瞬的状态)。
   - **`spawn_for_resume` 后的子会话不重新经历 broker 的 persona 分派**——resume 获得的 delegation success/report 已无 `applied_persona`字段(或保留首次当时的 snapshot),不自动探测人格是否仍存在于子进程上下文。
   - UI 在恢复后重渲染时,**若子会话处于恢复后且不知道实际 persona 状态**，需以「首次已应用、恢复后未知」形式展示——不得仅凭首次的 `applied_persona` 直接展示为“仍在生效”。
   - **Kiro 子进程恢复后人格否保持是 Kiro-cli 内部行为**（对 codeg 不可观测）;codeg 不承诺。
   - **Claude/Codex 子会话恢复后包装层是否 replay 首轮也是 wrapper 内部行为**。codeg 不可观测,不承诺。
   - executor 完成 Requirement 7.1 / 7.2 process-death e2e 后将观察到的行为记入 design.md `## Update Log`作为下游实现参考——但 **spec 不强制要求任何自动修复/升级/报告机制**。
4. THE `ConnectionSpawner::spawn_for_resume` signature SHALL NOT accept a `LaunchOption` parameter (only `ConnectionSpawner::spawn` needs it — resume never re-nominates a persona). The trait signature change is confined to `spawn`.
5. WHILE `continue_with_session` sends a follow-up on an existing child(Branch A: `send_followup_prompt`), THE follow-up SHALL NOT re-resolve the preamble(Claude/Codex path)nor re-emit `--agent`(Kiro path)since the child process already carries the persona for the lifetime of that session — the child's persona SHALL remain unchanged for all follow-ups on the same session.

#### Requirement 7.1 (Kiro process-death e2e — MUST run before spec closes)

1. Start Kiro via `delegate_to_agent({agent_type:"kiro", subagent_type:"plan-reality-recon"})`, complete one turn.
2. Force-kill the kiro-cli process (`taskkill /PID <pid> /F`).
3. From codeg, `continue_with_session` on the same task_id (triggers `spawn_for_resume` with `session_id`).
4. **Observe & record in design.md `## Update Log`**: (a) does the resumed kiro-cli reload `plan-reality-recon.json`? (b) does the resumed session's first response reflect persona behaviour (e.g. a `@plan-reality-recon`-flavoured intro)? (c) if it drops, does codeg's `applied_persona` on the resumed session correctly report `Failed { reason: "resume_dropped_persona" }` or does it silently claim `Native`?
5. IF (a)+(b) both hold, THE spec is safe to close on this leg. IF either drops, THE spec SHALL append a `## Known Limitations` section listing what resume actually does and how `applied_persona` reflects it.

#### Requirement 7.2 (Claude/Codex process-death e2e — MUST run before spec closes)

1. Start Claude Code via `delegate_to_agent({agent_type:"claude_code", subagent_type:"plan-reality-recon"})` with a preamble file containing marker `SPEC_MARKER_R2_RESUME_CLAUDE`, complete one turn.
2. Force-kill the claude-agent-acp process.
3. From codeg, `continue_with_session` on the same task_id.
4. **Observe & record**: (a) does the resumed Claude session's context still contain `SPEC_MARKER_R2_RESUME_CLAUDE` (i.e. the wrapper replayed the first turn from `conversation`)? (b) does the second turn's assistant response reflect the persona's intended behaviour?
5. Repeat AC7.2.1-4 for Codex.
6. IF either wrapper does NOT replay first turn, THE spec SHALL append a `## Known Limitations` entry AND the `applied_persona` on the resumed session SHALL be reported as `Failed { reason: "wrapper_dropped_first_turn_on_resume" }` — do NOT silently claim `Hint` when the hint no longer exists in the running context.


## Update Log

- 2026-08-03 · 初稿落盘
- 2026-08-03 · R1 评审(codex)3P0+7P1 采纳修订:
  - **R1-A1 → 采纳**:修 Success State + Requirement 3 顶,明写 Claude/Codex 为 best-effort、非真人格。
  - **R1-A2 → 采纳**:新增 Requirement 8,写死单主体信任边界(对齐 codeg-server 已有信任模型)。
  - **R1-A3 → 采纳**:重写 Requirement 7,SSOT 写清,删 R7.3 盾盾,`spawn_for_resume` 不接 LaunchOption。
  - **R1-A4 → 采纳 · 下衍到 design**:将 per_call_env_overrides 收窄为类型化 LaunchOption 枚举。
  - **R1-A5 → 采纳**:新增 Requirement 3-name-grammar 子段,名称语法收窄为 `[A-Za-z0-9_-]{1,64}`,删 `.` 字符。
  - **R1-F1 → 采纳**:错误码 `invalid_working_dir`-family → `invalid_persona`(Kiro 自身启动失败仍走 `spawn_failed`)。
  - **R1-F2 → deferred**:不在 broker 层做上下文预算检查——那是下游模型层职责(一句 spec 声明已足够,不往 spec 里塞预算机制 → 避免过度工程化)。
  - **R1-F3 → 采纳 · 下衍到 design**:frontmatter 剥离改用 serde_yaml 或较完备的 markdown parser,支持 BOM/CRLF/未闭合/空 body。
  - **R1-F4 → 采纳**:分离请求名长度(64) vs UI grapheme 截断(32)。
  - **R1-F5 → 采纳**:Success State 里五条验收矩阵(Kiro 真人格 / Claude preamble / Codex preamble / unsupported / invalid / 并发)。
  - **R1-F6 → 采纳**:design.md 前 frontmatter 自动回写 vs Update Log 手写不同步 → 本行回同。

- 2026-08-03 · R2 评审(codex)1P0+8P1 三步过筛结果:
  - **R2-A1(P0)→ 部分采纳/部分驳回**:方向本身**驳回**——用户 2026-08-03 原话「主要需要支持的是 claude kiro codex」是明确的业务需求,不是我推理;评审器不知道这条 provenance,把 declined 误读为「没授权」。**采纳其中一条**:R3.7 加 disclaimer,警告 host AI 若依赖 permission mode / tool allowlist 等硬不变量,请只用 Kiro,或等上游 wrapper native 支持。
  - **R2-A2(P1)→ 改法不同**:persona resolver 不建 provider adapter service 层(过度工程化),但**要把 `resolve_preamble` 从 broker 直接调用改成 `registry`/`AcpAgentMeta` 上的一个 provider 方法**——broker 只调 `provider.resolve_persona_effect(name)` 拿标准化结果,不识别 CLI、不定位 home、不读文件。这条已 dependency 到 design 侧,requirements 无变化。
  - **R2-A3(P1)→ 采纳**:R1.4 / R2.1 / R2.2 三处「effect map / runtime_env override map」措辞已改为「typed `LaunchOption`」,broker 不再 mutate env map,翻译只发生在 `spawn_child_inner` adapter 内。
  - **R2-A4(P1)→ 采纳**:R5 大改——UI 不消费 raw_input.subagent_type,消费 outcome-level `applied_persona: Option<AppliedPersona>`(四态 tagged enum: Native / Hint / IgnoredUnsupportedCli / Failed),avoids fake success 表象。
  - **R2-A5(P1)→ 采纳**:R7.3 措辞由「naturally replay」等乐观断言改为 `unverified: to be confirmed by executor`,并新增 R7.1 / R7.2 process-death e2e 硬测,executor 必须跑,结果记入 design.md Update Log 或 Known Limitations。
  - **R2-F1(P1)→ 采纳**:Success State 里「统一 invalid_persona」措辞删除,改为「per-CLI 分家 wire code 是**故意的两条恢复路径**」,不是矛盾——Kiro 走 `spawn_failed`(重试/换),Claude/Codex 走 `invalid_persona`(修名重试)。
  - **R2-F2(P1)→ 采纳,下衍到 design**:未闭合 frontmatter 改为**确定性失败**(`MalformedFrontmatter`),不再宽容降级——避免把 YAML 元数据注入 prompt。
  - **R2-F3(P1)→ 改法不同**:200 KiB 硬 IO 上限保留(防 MB 级退化),但显式声明「不承诺 prompt 预算,只承诺文件 IO 上限」,并在 design Risks 里说清「若组合超限,走 CLI 通用失败链路,不是本 spec 新增机制」。评审要求的「组合预算下推给模型」是模型 context window 层职责,broker 拿不到。
  - **R2-F4(P1)→ 采纳,下衍到 design**:symlink safety 算法描述改为(a)`canonical.parent() == Some(canonical_root)` 而非 starts_with(direct-child 判定);(b)open canonical path 而非 candidate(TOCTOU);(c)`BufReader::take(200*1024 + 1)` 硬 read 上限而非 metadata check。

- 2026-08-03 · R3 评审(codex)1P0+3P1 三步过筛结果:
  - **R3 A1(P0)Resume 承诺不可观测 → 采纳降级方案**:R7.3 重写。`applied_persona` 只描述**首次启动**;`spawn_for_resume` 后 UI 若还想显示,需以「首次已应用/恢复未知」形式,不承诺恢复后自动检测/修复;Kiro / Claude/Codex resume 后 persona 是否保持均是各 wrapper 内部行为,codeg 不承诺。executor 完成 R7.1/R7.2 后把行为记 Update Log 作为下游参考,不强制 spec 加机制。
  - **R3 A2(P1)applied_persona 生成过早 → 采纳**:R5.1 加时机约束——**Native 需 spawn 返回 Ok 后**;**Hint 需 send_prompt_linked_for_delegation 返回 Ok 后**。spawn/send 失败直接走既有 Err 通路,不额外挂 applied。
  - **R3 F1(P1)unsupported CLI 被无关条件阻断 → 采纳(下衍到 design §6)**:骨架顺序改为「先 provider capability check → 支持的 CLI 才做名称校验 → 只有 Hint provider 才解析 HOME」。Kiro 与 unsupported CLI 都不走文件系统。
  - **R3 F2(P1)扩 Err payload 兼容风险 → 采纳,大幅收窄**:R5.1 删 `AppliedPersona::Failed` 变体,变为三态 enum;R5.4 新增「失败渲染完全复用既有 Err wire_code + raw_input.subagent_type 拼接展示,不改 Err payload」。DB / wire / 前端兼容矩阵通过「不引入新失败字段」自然满足。
  - **R3 P2 观察**:「五条」→「六条」已修;`<<PERSONA_LISTS>>` 生成方是 companion tools/list handler(已在 Q2 前端决策明确,不删占位符,评审误读);TOCTOU 「完全消除」→ 「降低 symlink 换链风险」措辞在 design §5 待改。
