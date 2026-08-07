# Spec 索引 — Feature Specifications

> **AI 入口**:查"某个功能设计当初为什么这么定 / 现在什么状态 / 与哪个 ADR 关联" → 先读本表 → 点进对应 spec 的 `design.md`。
>
> spec = 功能级设计工作区(design.md + requirements.md + tasks.md + `review*.md`)。生命周期 drafting → shipped/superseded。
> 决策定边界写 ADR(`../architecture/`,若存在),不写 spec;spec 写"某功能怎么实施 + 评审如何收敛"。
>
> 检索方式(AI 友好):
>
> - 按状态:`grep -H "^status:" docs/specs/*/design.md`
> - 按标签:`grep -H "^tags:.*<标签>" docs/specs/*/design.md`
> - 按关联 ADR:`grep -H "related_adrs:.*ADR-XXX" docs/specs/*/design.md`
> - 已收敛未 ship:`grep -l "^status: converged" docs/specs/*/design.md`

## 索引表(新增 spec 时追加一行 · 或跑 `python C:\Users\7\.agents\scripts\sync-spec-index.py docs/specs` 自动重生 AUTO-INDEX 区块)

<!-- BEGIN AUTO-INDEX -->
<!-- 本区块由 sync-spec-index.py 自动重生成,人工修改会被覆盖。人工内容请写在本注释外的其它区域。 -->

| slug | 标题 | status | rounds | last review | related ADR | tags | 一句话 |
|------|------|------|------|------|------|------|------|
| [kiro-agent-integration](./kiro-agent-integration/design.md) | Kiro CLI 作为 ACP agent 接入 codeg · 设计 | converged | 3 | NEEDS_CHANGES | ADR-0001 | acp, agent-integration, kiro, mcp | 新增 SystemBinary 分布类型接入系统安装的 kiro-cli，复用 Cursor/Grok 的既有模式完成注册、会话解析、MCP 接管与启动参数注入。 |
| [subagent-observatory](./subagent-observatory/design.md) | 常驻子智能体观察面板（委托 + 内部 SUB 统一观察） · 设计 | converged | 3 | NEEDS_CHANGES | — | delegation, subagent, observability, ui, broker, cancel | 给委托子智能体与 Claude 内置 SUB 加一条常驻指示条与清单面板，让用户不滚消息流就能看到谁在跑并能就地取消；顺带修掉 cancel_task_by_id 对用户侧恒返 unknown 的归属校验缺陷。 |
| [delegate-persona-passthrough](./delegate-persona-passthrough/design.md) | delegate_to_agent 支持透传自定义 subagent 人格(Kiro / Claude / Codex) · 设计 | shipped | 3 | NEEDS_CHANGES | — | delegation, subagent, persona, acp, kiro, claude-code, codex, broker | 给 delegate_to_agent 加可选 subagent_type,让主 AI 派任务时能点名 Kiro/Claude/Codex 里的自定义人格;Kiro 走 --agent 原生真人格,Claude/Codex 走首轮 preamble best-effort 变通。 |
| [delegation-continue-session](./delegation-continue-session/design.md) | 委托子代理从一次性改为可续聊 + 用户侧交互入口 · 设计 | shipped | 3 | NEEDS_CHANGES | — | delegation, subagent, acp, lifecycle, broker | 拆掉 broker 的 one-shot 销毁让终态子会话保留可复用，对齐上游 PR |

### Legacy(未回填 front-matter · 需触碰时按 spec-deliverable §Spec Front-matter 补)

- `midturn-steering` · reason: `no_frontmatter`

<!-- END AUTO-INDEX -->

## 生命周期状态机

```
drafting  ──►  reviewing  ──►  converged  ──►  in-impl  ──►  shipped
   │              │                │              │             │
   └──────────────┴────────────────┴──────────────┴──►  abandoned
                                                          │
                                                          └──►  superseded (被新 spec 取代)
```

- `drafting → reviewing`:主 AI 或用户 · 首次跑 spec-cross-review 时
- `reviewing → converged`:主 AI 判定 · APPROVED 或 P0=0 且可进 tasks
- `converged → in-impl`:主 AI 自动 · tasks.md 开始勾第一个 checkbox
- `in-impl → shipped`:主 AI 自动 · tasks.md 全部完成 + 填 `shipped_commit`
- `* → abandoned/superseded`:用户命令(或被新 spec 取代)

**⛔ `spec-cross-review` 只自动回写 4 个白名单字段**(`review_rounds_done / last_review_status / last_review_p0 / last_updated`),**不触碰 `status`** —— 状态转移是人的判断,防评审误判连锁污染。

## 新增一份 spec 的步骤

1. 决定是否值得建(见 `~/.kiro/skills/engineering-agent/references/spec-deliverable.md` §When to emit · 默认 NO)。
2. `mkdir docs/specs/<slug>/`(slug = kebab-case)。
3. 建 `design.md` + `requirements.md`;**design.md 顶部必落 YAML front-matter**(schema 见 spec-deliverable §Spec Front-matter),status 起始 = `drafting`。
4. 跑 `python C:\Users\7\.agents\scripts\sync-spec-index.py docs/specs/` 让本表 AUTO-INDEX 区块跟上(若仓有 pre-commit hook 会提醒)。
5. 首次跑 `spec-cross-review` 前把 status 改 `reviewing`;评审收敛后主 AI 改 `converged`;开工时改 `in-impl`;交付时改 `shipped` + 填 `shipped_commit`。
6. commit 时把 `docs/specs/README.md` + 该 spec 三件套一起 staged。

## Legacy 提示

- 若仓库有 `.kiro/specs/`(IDE 私有 · 不入 git)· 建议 `git mv` 到 `docs/specs/` 让 spec 走 git 追踪(见 spec-deliverable §SPEC LOCATION RED LINE)
- 历史 spec 未回填 front-matter 的 · sync-spec-index.py 会跳过并在 Legacy 段列出

<!-- 本 README 由 sync-spec-index.py --bootstrap 从模板首次建成。人工可在 AUTO-INDEX 标记块之外自由编辑;AUTO-INDEX 内容由脚本重生成。 -->
