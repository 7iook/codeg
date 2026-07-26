# Decision Card · 会话 ID 展示 / 复制恢复命令 / 定位转录文件(全代理)

日期: 2026-07-27 · 类型: Feature · 参考: F:\claude-code-history-viewer

## 🏗️ 1. Boundary Decisions
- Bounded context: conversation 元信息展示(前端)+ parser 文件定位(后端 infra)。不触碰 delegation/ACP 生命周期。
- 不引入新状态机;纯读操作(复制/定位),无写路径。
- Invariant: resume 命令中的 external_id 必须过白名单 `^[A-Za-z0-9_-]+$`(fail-closed,防转录注入构造 shell 越界);文件定位只返回 parser 自己源目录内的路径。
- ADR admission: 不需要 —— 纯展示/工具功能,无难以逆转的选型。

## 🔍 2. Existing-Implementation Search
- 内部: fast-context `conversation model fields / header component / context menu` → external_id 已在 DbConversationSummary(types.ts:353);conversation-detail-header.tsx 为头部落点;tauri-plugin-opener v2.5.3 已依赖(dev 编译日志证实)。DB 无 source_path 列;AgentParser trait(parsers/mod.rs:188)仅 list/get,无文件定位接口 → 需新增,verified absent。
- 外部: 参考实现 F:\claude-code-history-viewer(SessionContextMenu.tsx / providers.ts:getResumeCommand / useSessionEditing.ts:handleRevealInFinder),机制四件套已摘录至会话记录。无需第三方库(clipboard + opener 均已有)。

## 📐 3. Interface Contract
- Rust: `AgentParser::locate_session_file(&self, external_id: &str) -> Option<PathBuf>`(trait 默认 None;逐 parser 实现,能力门控)。
- 命令/端点: `conversation_session_file(conversation_id) -> Option<String>`(_core 双模式);reveal 走前端 opener 插件(仅桌面;Web 模式隐藏该项,复制路径仍可用)。
- 前端: `getResumeCommand(agentType, externalId): string | null` 模板表(null = 不支持,菜单项隐藏);id 白名单校验在生成函数内,不散落调用点。
- 错误码: 无新增(查询失败返回 null → UI 隐藏/提示)。幂等: 纯读,无。

## 🧪 4. Test Boundaries (TDD Red)
- `getResumeCommand` 表测试: 各 agent 模板正确;非法 id(含空格/引号/`;`)返回 null;不支持的 agent 返回 null。
- locate_session_file: Claude parser 对已知 external_id 返回存在的 .jsonl;未知 id → None;恶意 id(路径穿越字符)→ None(复用 is_safe_subagent_id 思路)。
- header 组件: external_id 缺失时不渲染 id 徽标;点击复制调用 clipboard。
- 边界≥3: id 为空 / agent 无 CLI resume / Web 模式无 opener。

## 🛡️ 5. Anti-Corruption Layer & Registration
- opener 插件仅在前端 platform 判断后动态 import(参考项目同款);Rust 侧不新增外部依赖。
- 注册检查: Tauri invoke_handler + web router 各加 1 端点;i18n 4 个 key × 10 语言;无 feature flag(纯增益 UI)。

## Update Log
- 2026-07-27 调研完成,卡片落盘,待实施(后端 trait → 命令 → 前端 header/菜单 → i18n → 测试)。
- 2026-07-27 实施完成并逐项核销:
  - 头部 id 徽标(monospace 前 8 位,点击复制全量,勾选反馈)✅
  - ⋯ 菜单四项: 复制会话 ID(全代理)✅ · 复制恢复命令(claude/codex/kimi 模板,其余 null 隐藏)✅ · 复制会话文件路径 ✅ · 显示会话文件(仅桌面,revealItemInDir)✅
  - 后端 conversation_session_file(_core/tauri/web/router/lib.rs 五处注册)✅;第一期仅 ClaudeCode(复用 parsers::claude::find_session_file,含委托子会话);其余 agent 返回 None → UI 门控。trait 方案降级为分发函数(diff 更小,verified:仅 claude 有现成定位)。
  - i18n 4 键 × 10 语言 ✅
  - 验证: tsc 零错 · 新增 resume 模板测试 3 passed · conversations 组件 179 passed · eslint 干净 · cargo check(server 模式)零告警
  - 变体扫描: sidebar-conversation-card 的右键菜单为同类落点(参考项目在会话列表也有此菜单)——本轮未加,登记为后续增强(同一 API/lib 直接复用,无重复实现风险)。
