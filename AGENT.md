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
   - 收到任何 GitLab Webhook 时，必须校验 `X-Gitlab-Token` 并第一时间通过 `isBotUser` 过滤 Bot 自身的人为操作事件。pipeline、build、deployment 保留 Bot 触发的状态变化；所有评论与错误日志必须经过 `redactGitUrl` 脱敏。

---

Stage 1 的装配入口为 `createDetentApp(config, extensions)`。工具按每轮 profile 的白名单注册到 MCP。审批按待审记录的类型和工具名检查权限，外部续跑与 Issue 指令共用租约和临时沙箱。

扩展使用 `defineExtensionTool` 注册不同 Schema 的工具。`always_approve` 放行后，执行前的 `guard` 与 `execute` 从本次调用的 `ctx.approvalId` 取得审批单 ID。轮次和审批共用 `resolveTurnProfile({ session, repo, gitlab })`，可按 Issue 标签选择策略。`matchWebhookEvent` 同步返回队列键和处理函数，由 WebhookQueue 调度。业务表通过 `onInitSchema(pool)` 在 Core 建表后复用同一连接池初始化。

Stage 2 的 Delivery 合并事件处理器按目标项目 ID 和 MR IID 查找所有关联会话。在各自的 `resumeSession.beforeRun` 租约内原子记录合并 SHA、合并人和时间。仅首次更新写入 Hub Issue 通知。会话正在等待方案或工具审批时，回调返回 `false` 并保留待审单；已关闭的会话仅记录合并信息，其余会话用 `default` 权限模式续跑。

Stage 3 的只读和自动工具在 `preflight` 执行守卫。生产任务在发卡前、批准后复核，提交前重读当前会话 MR。巡检与执行凭证分开配置，缺少所需凭证即拒绝。资产黑名单同时约束巡检和执行。结果查询必须由注入的 `DeliveryExecutionTracker` 验证会话归属。审批卡渲染、执行与归属判断均读取仓储。

### V3 兼容基线（Stage 5–7）

V3 从 Hub 默认分支加载 `workflows/*.md`，按当前 Issue 标签选择 SOP 并检查 `requires`。沙箱内的 Hub `CLAUDE.md` 和顶层 `workflows/` 受写保护。`TurnProfile.blockedMessage` 在创建沙箱和调用 Claude 前将引导写入 Issue，会话回到 `IDLE`。V5 的无标签路由与澄清见下文。

`DetentCapabilityPack` 以 `enabled` 表达能力是否就绪，未启用的包通过 `setupHint` 提供配置指引。Delivery 的 `jumpserver` 包可空。默认启用的 `gitlab-release` 包提供只读的 `detent_list_tags` 和须审批的 `detent_create_release`，发布审批绑定项目、Tag 和完整提交 SHA。旧 Hub 无 SOP 时沿用兼容路由，未配置 JumpServer 时默认代码交付。

`npm run bootstrap` 只补齐缺失的 Hub 规范、流程、Issue 模板和标签，复用同一输出文件内的凭证。

`jms_run_ansible_job` 与 `detent_create_release` 的待审单仅能在当前流程非只读且显式启用该工具时获批。两者始终校验生产审批人，`approver_tier: prod` 的流程对所有工具审批执行同样校验。方案审批沿用普通项目权限。生产审批要求 `DELIVERY_PROD_APPROVERS` 名单加项目成员门槛，或在名单为空时满足 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）。

`delivery_executions` 通过 `onInitSchema(pool)` 在 Core 表之后、调用方建表之前初始化。所有权、执行状态和审批单关联均以仓储为准，审批卡渲染也从仓储读取 MR。禁止 Delivery 另建池或在 Pod 内缓存业务状态。结果查询更新审计，`renderStatusExtra` 将当前会话的执行记录加入 `/status`。环境变量全集与 Hub 规范见 [.env.example](.env.example) 和 [工作区示例](examples/hub-workspace/CLAUDE.md)。

### V4 工单闭环（Stage 8）

Hub SOP 的 `close_policy` 默认 `manual`。`auto` 和 `approve` 启用每轮的 `detent_close_issue`，其中 `approve` 按流程审批人等级发卡。readonly 角色使用 SDK default 模式，禁用 Edit/Write，在 disableBash 时禁用 Bash；PermissionGate 与 WorkspaceTools 始终强制工作区只读。关单工具仅登记本轮请求。编排器在轮次成功、transcript 与工作区已保存后复核方案、待审单、未合并 MR 和 `TurnProfile.canCloseIssue`，先归档 Worktree，再刷新最终评论，随后关闭 Issue 并同步 `DONE` / `claude::done`。Delivery 要求最新执行记录为 `SUCCESS`。人工关单同样归档并进入 `DONE`。

### Stage 9 确定性 E2E

`npm run e2e:offline` 使用回环 GitLab 与 git-http-backend。导出 `E2E_GITLAB_ADMIN_TOKEN` 后，`E2E_GITLAB_URL=http://127.0.0.1:8080 npm run e2e:gitlab` 使用独立命名空间和真实 GitLab CE 18.3.0 的 API、用户及 Webhook。两种目标共用缺能力引导、镜像同步、跨库双 MR、在线定制发版、旧热修复与关单审批、只读巡检和跨 Pod 环境变更场景。真实 Claude Code 使用本地 Anthropic SSE 替身，Jev、JumpServer 与外部 MCP 也使用回环替身。用 GitLab Issue、审批人身份、MySQL 状态和归档记录验收闭环。

### Jev 命令风控

Core 持有通用 System One 客户端（百炼 Decision Model API、TypeSafe、custom）和沙箱 Bash 门禁。先硬拦截，再走静态规则，其余可评估命令通过分类、无副作用概率和影响分联合判断。评估失败一律收紧权限，编码转人工，只读或 Plan 拒绝。Delivery 通过 `DetentExtensions.decisionClient` 共享实例，仅为只读巡检扩展命令判断。密钥禁止进入 Claude 环境、日志和 Issue 评论。方案、生产执行、发版及 `close_policy: approve` 始终由人按权限审批。

### V5 Multi-Agent Hub、Jev 路由与外部 MCP 能力包

每轮从 Hub 默认分支发现 `agents/<id>/AGENT.md`、Agent 私有 Skills 和经 `shared_skills` 引用的共享 Skills。只将选定 Agent 及其引用的 Skills 放入工作区，提示词列出 Skill 摘要供 `Read` 按需加载。写保护覆盖根目录的 `CLAUDE.md`、`agents/`、`skills/` 和 `workflows/`。同 ID 的新版 Agent 优先，其余 `workflows/*.md` 继续可用。Bootstrap 递归补齐缺失的模板文件。

有匹配标签时按当前 Hub 定义选 Agent。普通轮次无匹配标签时可由 Jev 结合工单与非 Bot 用户评论路由。高置信度且能力齐备时先持久化 Plan，再写回 Agent 标签。无法明确匹配且无默认 Agent 时进入只读 Triage，询问补充信息后回到 `IDLE`。`/use` 在租约内作废旧待审单并持久化 Plan 重置，再替换 Agent 标签。`purpose === 'approval'` 只按现有标签或默认 Agent 解析授权，严禁触发 Jev 或 Triage。

服务端通过 `DETENT_MCP_CAPABILITIES_FILE` 加载 Streamable HTTP 能力包，由 Agent 的 `requires` 选用。代理工具默认 `always_approve`，由既有 Plan 与工具门禁治理。认证信息由服务端解析，代理对工具元数据、审批卡、调用结果和错误脱敏。Delivery 对 `approverTier: prod` 包的工具审批强制校验生产权限，SOP 的 `approver_tier: standard` 无法降级。

### V6 控制面基础（Stage 10）

Issue 与 MR 按 `(session_kind, hub_project_id, hub_issue_iid)` 独立标识。新增的 `session_inbox` 按会话和事件去重。持租约的 Issue 与 MR 轮次在 PostToolUse 注入新指示，并在工具结束、沙箱清理与释放租约之间接续晚到的评论。Watchdog 默认每 30 秒加抖动扫描，最小间隔 15 秒，设为 0 可关闭。扫描只读，恢复在租约内完成。

沙箱内 Hub 根目录的 `events.json` 受写保护。WebhookQueue 从 Hub 默认分支读取规则，按首条命中规则处理扩展匹配器交还的事件。人为事件带有 actor ID 且处置为 `run` 时，先校验来源项目的审批权限；缺少项目 ID 时使用 Hub。`semantic` 仅在规则命中时调用 Jev。通知通过 GitLab 客户端渲染后触发 `onNotify`。

### V6 独立 MR 工作轮次（Stage 11）

MR 编排器复用 TurnRuntime 租约、审批和恢复机制。分配给 Bot 的打开事件、首次添加 Bot 的分配变更以及有效提及可启动编码轮次。人为接单、评论和审批均校验目标项目权限。MR 回复使用原讨论串，状态仅写入数据库。源项目为 Fork 时，Bot 至少有 Developer 权限才能写入。

MR 沙箱只检出源分支。SDK 与门禁共用工作区工具白名单，限于提交推送和两项 CI 查询。另提供当前 MR 的差异、讨论串和目标分支同步工具。推送时复核目录与当前分支。流水线先更新关联记录，再按 Hub 策略路由；无命中规则时，Bot 受理的 MR 可自动修复，未受理的关联 MR 向 Hub Issue 发通知。合并事件分别调度 MR 收尾与扩展处理器。

### V6 双目标验收（Stage 12）

Issue 与 MR 复用 NoteStreamer 折叠工具轨迹。双目标共用真实 Claude Code、MySQL 8.0 和 Delivery 入口，验证分配、单次提及、行内修复与双 MR 合并闭环。离线驱动额外投递带 Bot 身份的流水线失败与部署失败，验证策略在线切换、Hub 告警和轮中指示进入同一轮提交。真实 GitLab 通过 REST 操作触发自身的 Webhook。

`MR_MAX_AUTO_FIX_ATTEMPTS` 默认 3（0–10），`WATCHDOG_INTERVAL_MS` 默认 30000，`WATCHDOG_MAX_RECOVERIES` 默认 1（0–5）。既有库由初始化程序原子替换旧唯一键，升级 SQL 见[设计文档](docs/DESIGN.md#v6-mysql-upgrade)。

### Stage 13–14 安装与 GitLab 内自助接入

依照 `INSTALL.md` 使用 `Dockerfile` 和 `docker-compose.yml` 安装。bootstrap 支持 `DETENT_TARGET_GROUPS` 与 Bot 欢迎工单。管理员模式先准备 Bot PAT，再在 Hub 项目授予 `@detent-bot` Owner（50）；仅用 Bot PAT 时先校验 Hub 有效权限至少为 Maintainer（40）。Hub 模板、标签、Webhook 和可选欢迎工单均用 Bot PAT 写入。新建 Hub 直接写入模板首页，已有 Hub 保留自己的首页。目标业务项目与群组授予 Developer（30），保留已有的更高权限。

Hub 和 MR 的 `/help` 在检查成员权限后直接发评论，禁止创建会话或调用模型。MR 还须验证实时分配或显式提及，首次接管提示只出现在首条工作评论。`agents/onboarding/AGENT.md` 使用 Core 通用 `gitlab-onboarding` 能力包。回调地址来自 `DETENT_PUBLIC_URL`。服务端检查所有目标的有效 Maintainer 权限，Delivery 对写 Webhook 工具强制生产审批。Webhook 密钥只进入 GitLab 管理请求；模型 API 凭证由父进程为上游请求注入。

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
