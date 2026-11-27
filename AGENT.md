# AGENT.md — Detent 架构准则与 AI 开发指南

本文档面向参与 Detent 项目开发与维护的 AI Coding Agents（如 ChatGPT、Codex、Claude Code、Antigravity 等）及研发工程师。在修改本项目代码前，**必须先完整阅读本文档、[docs/DESIGN.md](docs/DESIGN.md) 与 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**。

---

## 一、 不可违背的 7 条核心架构红线（Architectural Invariants）

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
5. **生产变更三道门禁与父进程权限隔离（`@detent/delivery` 合规铁律）**
   - **第一道（Plan 方案审批）**：变更前必须先通过只读工具巡检现状并输出方案，未经审批不得进入实施阶段。
   - **第二道（MR 人工合并硬校验）**：调用 JumpServer 执行 Ansible 变更前，必须由硬代码 `guard()` 校验目标 MR 在 MySQL 中已是 `merged` 且 `merge_commit_sha` 与执行版本一致，绝不依赖 Prompt 软约束。
   - **第三道（执行前生产审批）**：`jms_job` 治理级别必须为 `always_approve`；父进程按 `mode: readonly` 隐藏执行工具，巡检先硬拒绝危险命令，再检查允许前缀或交 Jev 评估。生产执行要求 `prod` 审批。JumpServer 推荐共用一把 AccessKey，仅由父进程持有；高敏感交付 Agent 禁用裸连 SSH / 本地直跑 Ansible。
6. **严格防止 GitLab Bot 无限自环（Loop Prevention）与脱敏**
   - 收到任何 GitLab Webhook 时，必须校验 `X-Gitlab-Token` 并第一时间通过 `isBotUser` 过滤 Bot 自身的人为操作事件。pipeline、build、deployment 保留 Bot 触发的状态变化；所有评论与错误日志必须经过 `redactGitUrl` 脱敏。

7. **错误可观测性与脱敏**
   - 禁止静默吞错：禁止裸 `catch {}`。上游 HTTP 4xx/5xx 错误必须用 `logError` 或 `console.error` 记录状态及脱敏后的原始响应详情。先脱敏再截断，将安全摘要传递给工具轨迹。

---

Stage 1 的装配入口为 `createDetentApp(config, extensions)`。工具按每轮 profile 的白名单注册到 MCP。审批按待审记录的类型和工具名检查权限，外部续跑与 Issue 指令共用租约和临时沙箱。

扩展使用 `defineExtensionTool` 注册不同 Schema 的工具。`always_approve` 放行后，执行前的 `guard` 与 `execute` 从本次调用的 `ctx.approvalId` 取得审批单 ID。轮次和审批共用 `resolveTurnProfile({ session, repo, gitlab })`，可按 Issue 标签选择策略。`matchWebhookEvent` 同步返回队列键和处理函数，由 WebhookQueue 调度。业务表通过 `onInitSchema(pool)` 在 Core 建表后复用同一连接池初始化。

Stage 2 的 Delivery 合并事件处理器按目标项目 ID 和 MR IID 查找所有关联会话。在各自的 `resumeSession.beforeRun` 租约内原子记录合并 SHA、合并人和时间。仅首次更新写入 Hub Issue 通知。会话正在等待方案或工具审批时，回调返回 `false` 并保留待审单；已关闭的会话仅记录合并信息，其余会话用 `default` 权限模式续跑。

Stage 3 的只读和自动工具在 `preflight` 执行守卫。生产任务在发卡前、批准后复核，提交前重读当前会话 MR。Hub 的单个 `auth` 同时用于巡检和执行，旧环境可显式配置两套凭证。资产黑名单同时约束巡检和执行。结果查询必须由注入的 `DeliveryExecutionTracker` 验证会话归属。审批卡渲染、执行与归属判断均读取仓储。

### Hub 能力检查

显式流程标签使用对应 SOP 的能力、账号、命令前缀、审批等级和关单策略。缺少必需能力时，编排器在创建沙箱前发布配置指引并回到 `IDLE`。

`DetentCapabilityPack` 以 `enabled` 表达能力是否就绪，未启用的包通过 `setupHint` 提供配置指引。Delivery 的 `jumpserver` 包可空。默认启用的 `gitlab-release` 包提供只读的 `detent_list_tags` 和须审批的 `detent_create_release`，发布审批绑定项目、Tag 和完整提交 SHA。

`npm run bootstrap` 只补齐缺失的 Hub 规范、流程、Issue 模板和标签，复用同一输出文件内的凭证。

`jms_job` 与 `detent_create_release` 的待审单仅能在当前流程非只读且显式启用该工具时获批。两者始终校验生产审批人，`approver_tier: prod` 的流程对所有工具审批执行同样校验。方案审批沿用普通项目权限。生产审批要求 `DELIVERY_PROD_APPROVERS` 名单加项目成员门槛，或在名单为空时满足 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）。

`delivery_executions` 通过 `onInitSchema(pool)` 在 Core 表之后、调用方建表之前初始化。所有权、执行状态和审批单关联均以仓储为准，审批卡渲染也从仓储读取 MR。禁止 Delivery 另建池或在 Pod 内缓存业务状态。结果查询更新审计，`renderStatusExtra` 将当前会话的执行记录加入 `/status`。环境变量全集与 Hub 规范见 [.env.example](.env.example) 和 [工作区示例](examples/hub-workspace/CLAUDE.md)。

### V4 工单闭环（Stage 8）

Hub SOP 的 `close_policy` 默认 `manual`。`auto` 和 `approve` 启用每轮的 `detent_close_issue`，其中 `approve` 按流程审批人等级发卡。readonly 角色使用 SDK default 模式，禁用 Edit/Write，在 disableBash 时禁用 Bash；PermissionGate 与 WorkspaceTools 始终强制工作区只读。关单工具仅登记本轮请求。编排器在轮次成功、transcript 与工作区已保存后复核方案、待审单、未合并 MR 和 `TurnProfile.canCloseIssue`，先归档 Worktree，再刷新最终评论，随后关闭 Issue 并同步 `DONE` / `claude::done`。Delivery 要求最新执行记录为 `SUCCESS`。人工关单同样归档并进入 `DONE`。

每轮 Claude 通过带令牌认证的回环 HTTP MCP 调用工具。工具审批和提问先保存会话并释放 Pod 租约，获授权的用户回复后由新进程恢复。通过 `jms_list_assets` 查询资产，向 `jms_shell` 传入 `commands` 数组完成批量巡检。生产审批通过后，`jms_job` 异步提交任务并返回链接，本轮结束。Delivery 记录终态并唤醒原 Issue 进行核验。`jms_job_status` 可查询当前会话所属的任务。

### Stage 9 真实服务栈 SOP E2E

第 2 步将提供真实服务栈验收入口。依次使用 `npm run e2e:up` 启动测试环境、`npm run e2e` 构建并运行 SOP 场景、`npm run e2e:down` 拆除环境。场景通过真实 GitLab API 操作 Issue、审批和 MR，由 GitLab 投递 Webhook。关单时核对 GitLab 状态和审批人身份，以及 MySQL 会话终态和 Worktree 归档记录。

### Jev 命令风控

Core 持有通用 System One 客户端（百炼 Decision Model API、TypeSafe、custom）和沙箱 Bash 门禁。先硬拦截，再走静态规则，其余可评估命令通过分类、无副作用概率和影响分联合判断。评估失败一律收紧权限，编码转人工，只读或 Plan 拒绝。Delivery 通过 `DetentExtensions.decisionClient` 共享实例，仅为只读巡检扩展命令判断。密钥禁止进入 Claude 环境、日志和 Issue 评论。方案、生产执行、发版及 `close_policy: approve` 始终由人按权限审批。

### Stage 17 统一工程会话

无流程标签的 Issue 使用一个工程会话。主会话按索引读取 `agents/<id>/AGENT.md` 和相关 Skill，直接调用已就绪的工具。只读诊断结束后汇报证据并进入 `IDLE`。变更通过 `detent_submit_plan` 登记方案，进入 `WAITING_PLAN`，用户在 GitLab 点 👍 批准后继续实施。

统一会话挂载全部 SOP 和 Skills；显式标签只挂载所选 SOP 及其共享 Skills。Hub 规范与能力配置受写保护。

父进程按三档执行工具门禁。

- `readonly` 允许方案阶段和实施阶段使用。
- `coding_auto` 在方案批准后开放。
- `always_approve` 要求单次工具审批，生产工具额外校验生产审批人。

模型代理在父进程脱敏并认证请求，向上游发送 Messages 和 token 计数请求前，将模型名统一为配置的 `CLAUDE_MODEL`。

服务端通过 `DETENT_MCP_CAPABILITIES_FILE` 加载 Streamable HTTP 能力包，由 Agent 的 `requires` 选用。代理工具默认 `always_approve`，由既有 Plan 与工具门禁治理。认证信息由服务端解析，代理对工具元数据、审批卡、调用结果和错误脱敏。Delivery 对 `approverTier: prod` 包的工具审批强制校验生产权限，SOP 的 `approver_tier: standard` 无法降级。

### V6 控制面基础（Stage 10）

Issue 与 MR 按 `(session_kind, hub_project_id, hub_issue_iid)` 独立标识。新增的 `session_inbox` 按会话和事件去重。持租约的 Issue 与 MR 轮次在 PostToolUse 注入新指示，并在工具结束、沙箱清理与释放租约之间接续晚到的评论。Watchdog 默认每 30 秒加抖动扫描，最小间隔 15 秒，设为 0 可关闭。扫描只读，恢复在租约内完成。

沙箱内 Hub 根目录的 `events.json` 受写保护。WebhookQueue 从 Hub 默认分支读取规则，按首条命中规则处理扩展匹配器交还的事件。人为事件带有 actor ID 且处置为 `run` 时，先校验来源项目的审批权限；缺少项目 ID 时使用 Hub。`semantic` 仅在规则命中时调用 Jev。通知通过 GitLab 客户端渲染后触发 `onNotify`。

### V6 独立 MR 工作轮次（Stage 11）

MR 编排器复用 TurnRuntime 租约、审批和恢复机制。分配给 Bot 的打开事件、首次添加 Bot 的分配变更以及有效提及可启动编码轮次。人为接单、评论和审批均校验目标项目权限。MR 回复使用原讨论串，状态仅写入数据库。源项目为 Fork 时，Bot 至少有 Developer 权限才能写入。

MR 沙箱只检出源分支。SDK 与门禁共用工作区工具白名单，限于提交推送和两项 CI 查询。另提供当前 MR 的差异、讨论串和目标分支同步工具。推送时复核目录与当前分支。流水线先更新关联记录，再按 Hub 策略路由；无命中规则时，Bot 受理的 MR 可自动修复，未受理的关联 MR 向 Hub Issue 发通知。合并事件分别调度 MR 收尾与扩展处理器。

### V6 MR 验收（Stage 12）

Issue 与 MR 复用 NoteStreamer 折叠工具轨迹。MR 验收通过 GitLab 分配、提及、行内评论和合并触发 Webhook，检查源分支提交、原讨论串回复和双 MR 合并后的会话终态。流水线与部署场景以 GitLab 实际产生的事件验证策略切换、轮中指示与 Hub 告警。

`MR_MAX_AUTO_FIX_ATTEMPTS` 默认 3（0–10），`WATCHDOG_INTERVAL_MS` 默认 30000，`WATCHDOG_MAX_RECOVERIES` 默认 1（0–5）。既有库由初始化程序原子替换旧唯一键，升级 SQL 见[设计文档](docs/DESIGN.md#v6-mysql-upgrade)。

### Stage 13–14 安装与 GitLab 内自助接入

依照 `INSTALL.md` 使用 `Dockerfile` 和 `docker-compose.yml` 安装。bootstrap 支持 `DETENT_TARGET_GROUPS` 与 Bot 欢迎工单。管理员模式先准备 Bot PAT，再在 Hub 项目授予 `@detent-bot` Owner（50）；仅用 Bot PAT 时先校验 Hub 有效权限至少为 Maintainer（40）。Hub 模板、标签、Webhook 和可选欢迎工单均用 Bot PAT 写入。新建 Hub 直接写入模板首页，已有 Hub 保留自己的首页。目标业务项目与群组授予 Developer（30），保留已有的更高权限。

Hub 和 MR 的 `/help` 在检查成员权限后直接发评论，禁止创建会话或调用模型。MR 还须验证实时分配或显式提及，首次接管提示只出现在首条工作评论。`agents/onboarding/AGENT.md` 使用 Core 通用 `gitlab-onboarding` 能力包。回调地址来自 `DETENT_PUBLIC_URL`。服务端检查所有目标的有效 Maintainer 权限，Delivery 对写 Webhook 工具强制生产审批。Webhook 密钥只进入 GitLab 管理请求；模型 API 凭证由父进程为上游请求注入。

### 用户交互与审批反馈

能力缺失时直接列出所需能力与已就绪流程，管理员配置提示来自 `setupHint`。Hub 示例只提供协作规范，仓库与资产以实时查询为准。

Issue 与 MR 的普通回复只可回答当前待审的 `ASK_USER`，沿用审批身份校验与冷恢复。`TOOL_USE` 保留显式审批。审批时按待审类型和工具名复核当前流程，已撤销授权的工具保持静默。生产审批权限不足的项目成员收到去重提示，外部人员无反馈。Issue 与 MR 的折叠工具轨迹逐次展示所有工具的名称、原始路径与参数，原位更新执行结果、错误或拒绝原因。参数和结果先脱敏再截断。超过 60 步时展示首尾各 30 步及省略数量，无工具调用时省略轨迹。

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

### Stage 15 · 服务端密钥与 Hub 能力解析

`DETENT_SECRET_*` 仅在父进程解析。新增输出路径必须使用完整配置密钥集合脱敏，包含 SDK 输入、代理元数据、工具参数与结果、审批、Jev、GitLab 和增量 transcript。沙箱保护 Hub 根目录的 `capabilities.json`，包含 Edit、Write、Bash 和符号链接路径。

Issue 的 `/help`、轮次、审批分别读取 Hub 默认分支的能力配置。单轮解析所得的工具与流程授权使用同一份能力清单。MCP 请求头只在服务端展开；Hub 配置不能展开通用进程环境变量。临时连接在发现或调用结束时释放。Delivery 解释业务能力字段，Core 透传通用的流程 `account` 与 `allow_prefixes`。Hub 的 JumpServer `auth` 通过 `$secret:JMS_AK_ID` 和 `$secret:JMS_AK_SECRET` 引用父进程密钥。先使用流程 `account`，其次使用 Hub `default_account`。两者均未设置时，逐资产按 JumpServer 返回顺序选择首个有效授权账号，跳过停用账号和以 `@` 开头的虚拟账号。巡检按账号分组并汇总结果。单个 Ansible 任务要求所有目标使用同一账号，否则须指定共同的 `account` 或分组执行。缺少有效账号时，错误指出对应资产。

JumpServer 即时巡检与 Playbook 定义均在 `POST /api/v1/ops/jobs/` 显式发送 `is_periodic: false`。巡检按等价标志静态放行 `ss -lntp`。白名单外诊断要求 Jev 返回 `choice=pure_readonly`、`noul ≥ 0.75`、`0 ≤ impact ≤ 1.35`，拒绝理由保留三项指标。Jev 请求默认超时 6000 ms。
