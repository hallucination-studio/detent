# AGENT.md — Detent 架构准则与 AI 开发指南

本文档面向参与 Detent 项目开发与维护的 AI Coding Agents（如 ChatGPT、Codex、Claude Code、Antigravity 等）及研发工程师。在修改本项目代码前，**必须先完整阅读本文档、[docs/DESIGN.md](docs/DESIGN.md) 与 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**。

---

## 一、 不可违背的 6 条核心架构红线（Architectural Invariants）

1. **双包单向分层隔离（`@detent/core` 零业务污染）**
   - 项目演进为双包 Monorepo：`packages/core`（`@detent/core` 通用无状态基础架构包）与 `packages/delivery`（`@detent/delivery` 受治理 AI 变更交付中枢）。
   - **严禁 `packages/core` 依赖 `packages/delivery`，严禁在 `packages/core` 内出现 JumpServer、Ansible、特定 CMDB 等具体交付业务代码或字段**；所有业务能力必须通过 Core 暴露的 4 个扩展点（`DetentExtensionTool`、`resumeSession`、`TurnProfileResolver`、`SessionLifecycleHooks`）装配。
2. **`1 个工作区仓库 Issue = 1 个 Claude Code Session`，彻底解耦 Worktree 与 MR（`1 : 0..N`）**
   - 严禁在 `issue_sessions` 主表中写死单一的 `branch_name`、`worktree_path` 或 `mr_iid`。
   - 一个 Issue Session 在生命周期内可以跨任意多个 GitLab 业务项目创建 `0..N` 个 Worktree（`session_worktrees`）以及提交 `0..N` 个 Merge Request（`session_merge_requests`）。
3. **Pod 必须 100% 无状态（Stateless Pod，零本地持久化磁盘依赖）**
   - 单轮对话只能使用临时沙箱目录（`${EPHEMERAL_ROOT}/turn-<uuid>`），并在 `finally` 中强制 `rm -rf` 销毁。
   - **生命周期铁律**：`抢占 MySQL 租约锁 -> 水合 .jsonl 与浅克隆活跃分支(+应用 uncommitted_diff) -> 执行 Claude -> 新增消息与 git diff 增量刷回 MySQL -> 销毁临时沙箱 -> 释放租约锁`。
4. **MySQL 会话消息必须纯增量写入（Append-Only Incremental Messages）**
   - 严禁在主表存取并覆写整份 `.jsonl` 大字段；必须通过 `session_messages` 表按 `(session_id, seq)` 做批量 `INSERT IGNORE` 追加。
   - 严禁对普通只读 `SELECT` 套 `SELECT ... FOR UPDATE` 事务锁，严禁引入 MySQL 高频空转轮询表，租约心跳上限不低于 15s。
5. **生产变更三道门禁与物理凭证隔离（`@detent/delivery` 合规铁律）**
   - **第一道（Plan 方案审批）**：变更前必须先通过只读账号巡检现状并输出方案，未经审批不得进入实施阶段。
   - **第二道（MR 人工合并硬校验）**：调用 JumpServer 执行 Ansible 变更前，必须由硬代码 `guard()` 校验目标 MR 在 MySQL 中已是 `merged` 且 `merge_commit_sha` 与执行版本一致，绝不依赖 Prompt 软约束。
   - **第三道（执行前人工二次审批 + 凭证隔离）**：`jms_run_ansible_job` 治理级别必须为 `always_approve`；JumpServer 只读账号与任务中心执行账号的凭证必须物理分离且严禁透传给 Claude 子进程环境变量；高敏感交付 Agent 禁用裸连 SSH / 本地直跑 Ansible。
6. **严格防止 GitLab Bot 无限自环（Loop Prevention）与脱敏**
   - 收到任何 GitLab Webhook 时，必须校验 `X-Gitlab-Token` 并第一时间通过 `isBotUser` 过滤 Bot 自身事件；所有评论与错误日志必须经过 `redactGitUrl` 脱敏。

---

Stage 1 的装配入口为 `createDetentApp(config, extensions)`。工具按每轮 profile 的白名单注册到 MCP。审批按待审记录的类型和工具名检查权限，外部续跑与 Issue 指令共用租约和临时沙箱。

扩展使用 `defineExtensionTool` 注册不同 Schema 的工具。`always_approve` 放行后，执行前的 `guard` 与 `execute` 从本次调用的 `ctx.approvalId` 取得审批单 ID。轮次和审批共用 `resolveTurnProfile({ session, repo, gitlab })`，可按 Issue 标签选择策略。`matchWebhookEvent` 同步返回队列键和处理函数，由 WebhookQueue 调度。业务表通过 `onInitSchema(pool)` 在 Core 建表后复用同一连接池初始化。

Stage 2 的 Delivery 合并事件处理器按目标项目 ID 和 MR IID 查找所有关联会话。在各自的 `resumeSession.beforeRun` 租约内原子记录合并 SHA、合并人和时间。仅首次更新写入 Hub Issue 通知。会话正在等待方案或工具审批时，回调返回 `false` 并保留待审单；其余会话用 `default` 权限模式续跑。

Stage 3 的只读和自动工具在 `preflight` 执行守卫。生产任务在发卡前、批准后复核，提交前重读当前会话 MR。巡检与执行凭证分开配置，缺少所需凭证即拒绝。资产黑名单同时约束巡检和执行。结果查询必须由注入的 `DeliveryExecutionTracker` 验证会话归属。审批卡渲染、执行与归属判断均读取仓储。

### V3 基线（Stage 5–7）

每轮与每次审批从 Hub 默认分支重读 `workflows/*.md`，按当前 Issue 标签选择 SOP 并检查 `requires`。沙箱内的 Hub `CLAUDE.md` 和顶层 `workflows/` 受写保护。未匹配流程、流程冲突或能力缺失时，`TurnProfile.blockedMessage` 在创建沙箱和调用 Claude 前将引导写入 Issue，会话回到 `IDLE`。

`DetentCapabilityPack` 以 `enabled` 表达能力是否就绪，未启用的包通过 `setupHint` 提供配置指引。Delivery 的 `jumpserver` 包可空。默认启用的 `gitlab-release` 包提供只读的 `detent_list_tags` 和须审批的 `detent_create_release`，发布审批绑定项目、Tag 和完整提交 SHA。旧 Hub 无 SOP 时沿用兼容路由，未配置 JumpServer 时默认代码交付。

`npm run bootstrap` 只补齐缺失的 Hub 规范、流程、Issue 模板和标签，复用同一输出文件内的凭证。`npm run e2e:offline` 在同一个 MySQL 8.0 实例上验证三条链路：缺流程与缺能力时零模型调用、运行中修改 SOP 后发版、重启 Pod 后继续受治理的环境变更。

`jms_run_ansible_job` 与 `detent_create_release` 的待审单仅能在当前流程非只读且显式启用该工具时获批。两者始终校验生产审批人，`approver_tier: prod` 的流程对所有工具审批执行同样校验。方案审批沿用普通项目权限。生产审批要求 `DELIVERY_PROD_APPROVERS` 名单加项目成员门槛，或在名单为空时满足 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）。

`delivery_executions` 通过 `onInitSchema(pool)` 在 Core 表之后、调用方建表之前初始化。所有权、执行状态和审批单关联均以仓储为准，审批卡渲染也从仓储读取 MR。禁止 Delivery 另建池或在 Pod 内缓存业务状态。结果查询更新审计，`renderStatusExtra` 将当前会话的执行记录加入 `/status`。环境变量全集与 Hub 规范见 [.env.example](.env.example) 和 [工作区示例](examples/hub-workspace/CLAUDE.md)。

## 二、 质量门禁：本地提交前检查与推送前 OpenCodeReview 委托审查（必须遵守）

为了确保仓库长期保持 **结构紧凑、逻辑自洽、测试覆盖完整**，所有 AI Agent 与工程师在提交和推送代码前必须遵守以下两道门禁：

### 2.1 提交前本地自动门禁（Pre-Commit）
- 仓库已配置 [`.githooks/pre-commit`](.githooks/pre-commit)（通过 `npm run prepare` 或 `git config core.hooksPath .githooks` 启用）。
- 每次 `git commit` 前必须完整通过：
  ```bash
  npm run check
  ```
  串联执行：`tsc --noEmit`（严格类型检查）+ `knip`（跨文件死代码、未用导出、未用依赖扫描）+ `vitest run`（全量测试）。
- 严禁使用 `--no-verify` 跳过本地门禁；生产目录 `src/` 严禁混入 `InMemory*` 测试假实现。

### 2.2 推送前必须运行 OpenCodeReview 委托模式（Pre-Push OCR Delegation Review）
在执行 `git push` 或提交 Merge Request 之前，**必须使用 `open-code-review-delegate` 委托模式**（复用当前宿主 Agent 的模型），结合项目规则 [`.opencodereview/rule.json`](.opencodereview/rule.json)（已开启 `merge_system_rule: true`）对全部待推送变更进行 100% 覆盖率审查：

1. **预览待审变更范围**：
   ```bash
   ocr delegate preview --format json --from main
   # 若为尚未 commit 的工作区变更：
   ocr delegate preview --format json
   ```
2. **加载合并后的系统质量规则与项目架构红线**：
   ```bash
   ocr delegate rule --format json --from main <file1> <file2> ...
   ```
3. **逐文件审查 Diff 并执行减法优化**：
   - 检查每个变更文件，确保覆盖 `reviewable_files` 100%；
   - 重点拦截：破坏 Core/Delivery 边界、过度设计、死代码残留、绕过 MR 合并硬守卫、破坏无状态 Pod、增加 MySQL 高频读写/锁竞争；
   - 修复所有 **Critical / High** 及合理的 **Medium** 问题，重跑 `npm run check` 通过后再执行 `git push`。

### 2.3 活文档同步原则
- 凡修改数据库表结构、状态机流转、扩展接口、审批权限边界或工具清单的变更，必须在同一次提交中同步更新 `AGENT.md`、[docs/DESIGN.md](docs/DESIGN.md)、[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) 与 [`.opencodereview/rule.json`](.opencodereview/rule.json)。
