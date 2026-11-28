# Detent V2–V6 演进实施与验收计划

本文档承接已验收完成的 **V1 基线**（commit `1498aa4`，包含无状态 Pod 底座、纯增量 MySQL 仓储、GitLab CE 接入、双层审批、25 项测试及 `pre-commit` + `knip` + `OpenCodeReview` 质量门禁），定义 **V2：双包 Monorepo 拆分与面向生产交付的“受治理 AI 变更交付中枢（`@detent/core` + `@detent/delivery`）”** 的前四个阶段，并记录后续演进至 Stage 12 的验收标准。

---

## V1 基线状态（已完成并验收）

- ✅ 无状态 Pod 架构（`/tmp` 沙箱用完即焚 + `uncommitted_diff` 跨 Pod 二进制补丁还原）
- ✅ MySQL 8.0 纯增量 `session_messages` 与分布式租约锁（15s 心跳）
- ✅ 1:N 跨项目 Worktree / MR / Pipeline 基础工具与单评论流式渲染
- ✅ 双层审批门禁（Plan 方案审批 + 高危工具冷恢复审批）
- ✅ 质量门禁落地（`npm run check` = `tsc` + `knip` + `vitest`、`.githooks/pre-commit`、`.opencodereview/rule.json`、`.gitlab-ci.yml`）

---

## V2 总体推进路线（4 个可独立交付验收阶段）

| 阶段 | 阶段目标 | 核心交付物 | 核心验收标准 |
| :--- | :--- | :--- | :--- |
| **Stage 1** | **双包 Monorepo 拆分与 `@detent/core` 4 大扩展点抽象** | `packages/core` (`@detent/core`)<br/>`packages/delivery` (`@detent/delivery` 骨架)<br/>4 个标准扩展接口（`DetentExtensionTool` / `resumeSession` / `TurnProfileResolver` / `SessionLifecycleHooks`） | 1. `packages/core` 零业务词/零业务依赖<br/>2. 原有 25 项测试 100% 通过 + 新增扩展点单测<br/>3. `npm run check` (`tsc` + `knip` + `vitest`) 全绿 |
| **Stage 2** | **GitLab `merge_request` 合并事件监听与会话自动续跑** | `session_merge_requests` 增加 `merge_commit_sha` / `merged_by` / `merged_at`<br/>`@detent/core` 暴露 `resumeSession`<br/>`@detent/delivery` 接入目标库 MR `merge` Webhook 自动唤醒原 Issue Session | 1. 端到端测试覆盖：`提 Ansible MR -> 人工 Merge -> MR Webhook 触发 -> 自动 --resume 原 Issue Session`<br/>2. 幂等校验（重复 Merge Webhook 不重复唤醒） |
| **Stage 3** | **JumpServer 适配器（只读巡检 + 任务中心）与合规硬守卫** | `packages/delivery/src/jumpserver/client.ts`（父进程按工具执行门禁）<br/>4 个 JumpServer MCP 工具（`jms_list_assets` / `jms_shell` / `jms_job` / `jms_job_status`）<br/>合规硬守卫（MR 未合入强拦截 + 强制人工审批卡片） | 1. 单测覆盖：MR 未合并或 SHA 不一致时 `jms_job` 被硬守卫直接拦截<br/>2. Plan 模式拒绝执行，Coding 模式仅在硬守卫通过后弹审批卡<br/>3. 只读巡检工具在 `plan` 阶段可用且禁止写命令 |
| **Stage 4** | **执行审计表与 6 阶段全链路 E2E 验收** | `delivery_executions` MySQL 审计表与仓储<br/>Hub SOP 与生产审批人 RBAC 策略<br/>工作区仓库示例模板 (`examples/hub-workspace/`)<br/>6 阶段全链路端到端集成测试 | 1. 完整跑通：`开变更 Issue -> JumpServer 只读巡检 -> 方案审批 -> 写 Ansible 提 MR -> 人工合并 MR 自动唤醒 -> 执行前二次审批 -> JumpServer 任务中心执行 -> 变更后只读验收 -> 写审计表`<br/>2. 推送前通过 `ocr delegate` 100% 覆盖率审查 |

---

## Stage 1：双包 Monorepo 拆分与 `@detent/core` 扩展接口抽象

### 1.1 目标与约束
- 将根目录改造为 **npm workspaces Monorepo**（`"workspaces": ["packages/*"]`）。
- 现有 `src/` 和 `tests/` 无损迁入 `packages/core/`（包名 `@detent/core`），对外通过 `packages/core/src/index.ts` 导出干净的公共 API（同时保留独立启动入口 `packages/core/src/server.ts`）。
- 新建 `packages/delivery/`（包名 `@detent/delivery`，依赖 `"@detent/core": "*"`），作为受治理 AI 变更交付中枢的服务入口。
- **架构红线**：`packages/core` 内严禁出现 `jumpserver`、`ansible` 等任何业务概念或对 `packages/delivery` 的反向依赖。

### 1.2 核心扩展接口改造（均在 `packages/core` 内）
1. **自定义工具注册与三态治理策略（`DetentExtensionTool`）**：
   - 使用 `defineExtensionTool` 保留每个工具的 Schema 入参推导，向 SDK 与权限门禁注入同一个异构工具数组。
   - `PermissionGate.preflight` 按工具声明的 `policy` 处理：
     - `'readonly'` -> `plan` / `coding` 均在 guard 通过后放行；
     - `'coding_auto'` -> `plan` 拒绝，`coding` 在 guard 通过后放行；
     - `'always_approve'` -> `plan` 拒绝，`coding` 下**必须**先执行 `tool.guard(input, ctx)`（未通过直接返回 `deny(reason)`），通过后返回 `'ask'` 强制弹出 GitLab 审批卡片（支持调用工具自定义的 `renderApprovalCard`）。
   - 冷恢复放行后，执行前的 `tool.guard` 与 `tool.execute` 均接收该审批单的 `ctx.approvalId`。复检失败时终止执行。
2. **`SessionOrchestrator.resumeSession(sessionId, prompt, opts?)`**：
   - 在分布式租约锁保护下，拉起指定 Session 的新 Turn（自动水合 `.jsonl` 和 Worktree），供业务事件驱动续跑。
3. **`TurnProfileResolver`**：
   - 轮次与审批授权均调用 `resolveTurnProfile({ session, repo, gitlab })`，支持通过 `getIssue` 读取标签、通过 `hasApprovalPermission` 查询成员权限，进而选择提示词、工具白名单、Bash 策略和审批人策略。
4. **Webhook 扩展注册**：
   - 通过验签和 Bot 过滤后，`matchWebhookEvent(event)` 同步返回 `null` 或 `{ key, handle }`。匹配的事件入队即返回 202，复用 eventId 去重、按 key 串行、租约退避与停服 drain。

5. **生命周期回调**：审批决策成功写入后调用 `onApprovalResolved`，成功轮次完成持久化后调用 `onTurnCompleted`。
6. **共享连接池**：Core 在 `onReady` 完成基础表初始化后调用 `onInitSchema(pool)`，供 Delivery 在同一 MySQL 连接池上建表。

### 1.3 Stage 1 验收标准（DoD）
- 根目录执行 `npm run check`（`typecheck` + `knip` + 两个包全量 `vitest`）和 `npm run build` 零错误通过。
- 原有 25 项测试 100% 绿灯，且新增扩展机制单测覆盖 `readonly` / `always_approve` / `guard` 拦截 / `resumeSession` / `disableBash`。

Stage 1 已实现。两包通过 `@detent/core` 公共入口装配，CI 在根目录检查、构建后，使用 Node.js 导入两个包的构建产物。

---

## Stage 2：GitLab `merge_request` 合并事件监听与自动续跑

### 2.1 目标与实现内容
1. **数据层演进（`@detent/core`）**：
   - `session_merge_requests` 表新增字段：`merge_commit_sha VARCHAR(64)`、`merged_by VARCHAR(128)`、`merged_at DATETIME(3)`。
   - `DetentRepository` 新增 `findMergeRequest(targetProjectId, mrIid)` 与 `markMergeRequestMerged(id, mergeCommitSha, mergedBy)`（幂等更新：仅当原状态非 `merged` 时返回 `true`，防止重复 Webhook 重复唤醒 Session）。
2. **Webhook 接入（`@detent/core` + `@detent/delivery`）**：
   - Delivery 的 Zod 匹配器接收目标仓库的 `merge_request` 事件，要求 `action === 'merge'`，若提供 `state` 则必须为 `merged`。
   - 在 `@detent/delivery` 中注册 MR 合并处理器：
     1. 根据 `(project.id, object_attributes.iid)` 查找关联的 `session_merge_requests`；
     2. 对每个会话调用 `resumeSession`。租约忙时队列退避重试；获得租约后，`beforeRun` 原子记录 `merged`、合并人、时间和 SHA（快进合并回退到 `last_commit.id`）；
     3. 仅首次记录合并时在 Hub Issue 发布通知。遇到待审方案或工具请求时，通知说明审批后继续，保留待审状态；
     4. 其余会话用 `default` 权限模式恢复原 Claude Session，提示词携带 MR、分支及完整 SHA。

新部署在启动时创建完整表结构。从 Stage 1 升级时，先在现有 MySQL 库执行一次：

```sql
ALTER TABLE session_merge_requests
  ADD COLUMN merge_commit_sha VARCHAR(64),
  ADD COLUMN merged_by VARCHAR(128),
  ADD COLUMN merged_at DATETIME(3),
  ADD INDEX (target_project_id, mr_iid);
```

### 2.2 Stage 2 验收标准（DoD）
- 单元测试验证 `markMergeRequestMerged` 幂等性（同一 `merge` 事件重投两次只唤醒一次）。
- 集成测试覆盖：`Issue Plan 批准 -> 跨库提 Ansible MR -> 投递 MR merge Webhook -> 自动更新 MR 状态并 --resume 同一 Claude Session`。

---

## Stage 3：JumpServer 适配器与合规硬守卫

### 3.1 目标与实现内容
1. **JumpServer 配置与签名客户端（`packages/delivery/src/jumpserver/client.ts`）**：
   - 推荐在 Hub 配置 `base_url`，并通过 `$secret:JMS_AK_ID` 和 `$secret:JMS_AK_SECRET` 引用服务端的单把 AccessKey。兼容旧部署的环境变量如下：
     - `JUMPSERVER_BASE_URL`
     - `JUMPSERVER_READONLY_ACCESS_KEY_ID` / `JUMPSERVER_READONLY_ACCESS_KEY_SECRET`（或 `JUMPSERVER_READONLY_TOKEN`），可用 `JUMPSERVER_READONLY_ACCOUNT` 显式指定旧模式巡检账号
     - `JUMPSERVER_JOB_ACCESS_KEY_ID` / `JUMPSERVER_JOB_ACCESS_KEY_SECRET`（或 `JUMPSERVER_JOB_TOKEN`），仅供任务中心使用
     - `JUMPSERVER_INSPECT_ALLOW_PREFIXES`（只读巡检允许的命令白名单，默认如 `systemctl status,nginx -t,df -h,free -m,uptime,ss -tlnp,kubectl get,cat /etc/nginx` 等）
     - `JUMPSERVER_ORG_ID` 可选，`JUMPSERVER_TIMEOUT_MS` 默认 60000。
     - `JUMPSERVER_BLOCKED_ASSETS` 使用逗号分隔资产 ID，忽略大小写。`JUMPSERVER_BLOCK_FAILED_PIPELINE` 默认开启，可用 false 或 0 关闭。
   - 定义干净的 `JumpServerClient` 接口（支持 JumpServer v3/v4 REST API 签名认证）。
2. **4 个受治理 JumpServer MCP 工具（`packages/delivery/src/jumpserver/tools.ts`）**：
   - `jms_list_assets`（`policy: 'readonly'`）
   - `jms_shell`（`policy: 'readonly'`，内置只读命令白名单 + 禁止 `; | & > < $()` 注入检查）
   - `jms_job`（`policy: 'always_approve'`）：
     - **`guard()` 硬校验**：
       1. 校验入参指定的 `(project, mr_iid)` 属于当前 Session；
       2. 从 MySQL 查询该 MR 状态必须为 `merged`，且 `merge_commit_sha` 非空并与请求执行的 `commit_sha` 完全一致；
       3. 校验该 MR 对应最新 Pipeline 未处于 `failed` 状态（可配置开关）。
     - **自定义审批卡片**：清晰展示 `目标资产组`、`Ansible 仓库与 Playbook 路径`、`已合并 MR 链接与 Commit SHA`、`变更参数变量`，提示运维负责人点 👍 或 `/approve` 放行。
     - **执行与审计**：放行后复核当前 MR，从 GitLab 读取该 SHA 的归档，将批准的 Playbook 提交到任务中心。通过注入的 `DeliveryExecutionTracker` 记录执行 ID、审批单和 MR；Stage 4 已提供共享池 MySQL 实现。
   - `jms_job_status`（`policy: 'readonly'`）要求 tracker 确认任务属于当前会话。缺少仓储时拒绝查询。

### 3.2 Stage 3 验收标准（DoD）
- 单元测试完整覆盖合规硬守卫：
  - MR 仍为 `opened`（未合并）时调用 `jms_job` -> 直接 `deny`，绝不发审批卡也绝不调 JumpServer；
  - `commit_sha` 与 `merge_commit_sha` 不匹配时 -> 直接 `deny`；
  - 只读巡检命令含写操作或 shell 拼接（如 `nginx -t && rm -rf /`） -> 直接 `deny`；
  - MR 已合并且参数合规 -> 弹出定制化生产变更审批卡片，未获当前审批策略授权的人批准不执行（角色级 RBAC 见 Stage 4），批准后成功调用任务中心并返回 Job ID 与审计链接。

---

## Stage 4：执行审计与 6 阶段全链路验收

### 4.1 目标与实现内容
1. **交付执行审计表（`packages/delivery/src/db/audit.ts`）**：
   - 自动初始化 `delivery_executions` 表，关联 `session_id`、`mr_id`、`approval_id`、`jumpserver_job_id`、`commit_sha`、`status`、`output_summary`。
   - 增强 `/status` 指令输出：同时展示当前变更工单的 JumpServer 执行记录与审计链接。
2. **Hub SOP 与审批权限**：每轮和审批时按当前标签与能力配置确定工具范围。
3. **6 阶段全链路端到端集成测试（`packages/delivery/tests/delivery-e2e.test.ts`）**：
   - 串联完整交付生命周期：
     `开环境变更 Issue -> JumpServer 只读巡检 -> 产出变更方案 -> 👍 批方案 -> 改 Ansible 仓库提 MR -> (中途尝试提前执行被硬守卫拦截!) -> 投递 MR Merge Webhook 自动唤醒 -> 弹出生产执行审批卡 -> 运维负责人点 👍 放行 -> JumpServer 任务中心执行 Ansible -> 变更后只读健康验收 -> 写入 delivery_executions 审计记录 -> /tmp 沙箱归零`。

### 4.2 Stage 4 最终验收标准（Final DoD）
1. `npm run check`（全量 `tsc` + `knip` + `packages/core` 与 `packages/delivery` 全量单测与 6 阶段 E2E）100% 通过。
2. 推送前严格按 [`AGENT.md`](../AGENT.md) 执行 `ocr delegate` 100% 覆盖率审查，确认无 Critical / High / 合理 Medium 问题，且 `packages/core` 零业务污染。

**Stage 4 已实现。** 运行 `npm run start:delivery` 启动构建后的入口，或用 `npm run dev:delivery` 开发。显式标签限定本轮 SOP，无标签工单使用统一工程会话。生产审批按 `DELIVERY_PROD_APPROVERS` 名单与项目成员资格校验；无名单时使用 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）。[环境示例](../.env.example) 列出全部 JumpServer 与 Delivery 配置。

审计仓储使用同一 MySQL 池记录角色、目标资产、MR、SHA、审批单、任务与结果，`/status` 同时展示 MR 与执行审计。Delivery 包内的六阶段集成测试通过 HTTP Webhook、临时 Git 仓库与受控外部服务替身验证审批、硬拦截、同一会话恢复、任务验收和沙箱清理。另有共享池建表、只读角色、生产权限与审计仓储测试。

---

## Stage 5–7 · Hub SOP、可选能力包与发版

Core 加载 Hub SOP、检查所需能力并提供受审批的 GitLab 发版工具。Delivery 装配 JumpServer 等可选能力。bootstrap 补齐 Hub 规范和 Issue 模板。SOP 验收目标包括缺能力时的配置指引、运行中更新发布规范和跨 Pod 环境变更。

### V3 发布闭环验收

- Core 在 `gitlab-release` 内按项目、ID 或 ref 持久化流水线等待，触发时自动订阅。用含 skipped 的终态、未创建、并发及重放事件验证等待登记、状态更新、一次唤醒、关单拦截和过期清理。断言重复系统事件跳过抢租约，晚到回调跳过已关闭会话。
- Delivery 以审批单的原始工具参数和当前 Hub 配置计算审批级别。验证 Owner 可批准显式 standard 的 Tag 和 pre 作业，跨环境资产被拒，等待审批时资产移出、黑名单变化、能力撤销或 prod SOP 均不能降低门槛。
- 集成 E2E 串起 Tag 构建回调、pre 配置 MR、跨仓晋级流水线和 prod 交接。失败场景验证阻断、保持工单打开及通过独立 MR 恢复上一稳定 Tag。
- 真实 SOP10 在运行时改写测试 Hub 的环境矩阵。Developer 合并和放行 pre，Maintainer 接棒 prod，并核验 Developer 的生产审批被拒、两个命名空间的 Helm 状态和实际镜像版本、工单关闭及 Worktree 归档。
- 真实 SOP11 在 SOP10 验收后的同一集群开独立 env-change 工单。验证仅改生产 values，Developer 的执行审批被拒，SRE 合并并批准后 prod 恢复上一稳定镜像，pre 的镜像、Deployment 和 Helm revision 保持一致，回滚工单自动关闭并归档。单独选择 SOP11 时自动先跑 SOP10，各自使用完整的场景时限。
- SOP4、SOP7 验证存量仓库按原结构最小修改，SOP8、SOP9 校验新仓的 Ansible 和 Helm 基线。

## V4 演进实施计划：Issue 自动闭环终止条件与真实服务栈 SOP E2E

| 阶段 | 阶段目标 | 核心交付物 | 核心验收标准 |
| :--- | :--- | :--- | :--- |
| **Stage 8** | **Issue 自动闭环机制（`DONE` / `claude::done` + `detent_close_issue` + `close_policy` + 硬守卫）** | • `SessionStatus` 新增 `'DONE'` 与 `claude::done` 标签；`GitLabClient` 新增 `closeIssue`<br/>• `HubWorkflow` 支持 `close_policy: manual \| auto \| approve`（默认 `manual`）<br/>• `SessionOrchestrator` 集成 `detent_close_issue` 延迟关闭与关单硬守卫；`DetentExtensions.resolveTurnProfile` 返回的 `TurnProfile` 支持 `closePolicy` 与 `canCloseIssue`<br/>• `@detent/delivery` 注入执行记录终态守卫、MR 合并跳过 `DONE` 会话；标准模板更新 `close_policy: auto` 与终止条件；`scripts/bootstrap.ts` 补齐 `claude::done` 标签 | 1. 单测覆盖：`manual`/`auto`/`approve`、Plan 阶段禁关、未合并 MR 禁关、未决流水线订阅禁关、待审项禁关、未成功执行记录禁关、轮次报错不关单、只读巡检使用 SDK `default` 模式且工作区保持只读，关单前先归档 Worktree 再刷新最终评论，关闭后置 `DONE`<br/>2. `packages/core` 零业务污染<br/>3. `npm run check && npm run build` 全绿 |
| **Stage 9** | **真实服务栈 SOP 验收** | 通过 `scripts/e2e/stack.ts` 和 `scripts/e2e/run-e2e.ts`，复用 `gitlab-driver.ts` 与 `live-gitlab.ts` 操作真实 GitLab | 先用 `npm run e2e:up` 启动环境，再用 `npm run e2e` 构建并验证巡检、代码交付、发版、环境变更、热修复和关单审批，最后用 `npm run e2e:down` 拆除环境。完成的 Issue 在 GitLab 为 `closed` 且带有 `claude::done`，对应 MySQL 会话为 `DONE`。 |

### Jev 风控验收

使用配置的百炼 Decision Model API 验证 Bash 静态放行、硬门禁、语义放行和失败回退。代码交付在计划获批后执行复合命令，MySQL 中 Bash 审批行数为零；审计通过只读工具执行 `ss -lntp`。单测覆盖超时、响应校验、置信度及密钥隔离。生产执行、发版、方案和审批关单继续验证人工身份。

## Stage 10 · V6 控制面基础

- 初始化时升级原有 Issue 唯一键，同号 Issue、MR 各自独立。唯一新增表为 `session_inbox`。
- 验收同一事件重复投递、并发消费、PostToolUse 热追加、轮末接续、过期租约竞争和恢复耗尽。
- 验收 Bot 触发的 CI 事件、受保护的 Markdown 提及、Hub 事件策略多值匹配、队列内 Jev 回退、人为事件运行权限、沙箱策略文件写保护、通知脱敏及 MR 讨论串路由。
- `npm run check` 同时覆盖 Core 和 Delivery。Stage 11 接入 MR 独立编排与 MR 工具。

## Stage 11 · 独立 MR 编排与工具

- 使用 Stage 10 的表和租约处理 MR 接单、评论、表情审批、主动恢复与归档。
- MR 工具按当前源工作树、分支与 CI 限定范围。测试用真实临时 Git 远端验证浅克隆、合并冲突、Fork 只读，以及冷恢复后推送的合并历史。
- 流水线按 Hub 规则处置，检查提交 SHA、尝试次数与事件幂等性。测试验证关联 Issue 通知及独立的合并事件队列。
- 验收命令为 `npm run check` 和 `npm run build`。真实进程验收见 Stage 12。

## Stage 12 · 真实 GitLab 的 MR 端到端验收

- 在真实服务栈上验证以下 MR 场景。Issue 创建的双 MR 自动分配给 Bot，行内修复在源分支生成提交并回复原讨论串。两次人工合并后检查两个 MR 会话的 `DONE`，以及 Hub Issue 的关闭状态和 `claude::done`。
- 外部 MR 通过单次提及和后续分配分别触发。通过 GitLab 触发 Bot 用户的失败流水线，检查任务日志、独立修复、Hub Issue 评论不变、在线策略从 `notify` 切换到 `run`，以及 PostToolUse 消费轮中指示并影响提交。仓库部署失败应生成带来源信息的 Hub 告警 Issue。
- CI 和部署场景使用 GitLab 实际投递的 Webhook。质量门禁为 `npm run check`、`npm run build` 与 `git diff --check`。
- V6 新增 `MR_MAX_AUTO_FIX_ATTEMPTS`、`WATCHDOG_INTERVAL_MS` 和 `WATCHDOG_MAX_RECOVERIES`。默认值、范围和 MySQL 8.0 升级 SQL 见[设计文档](DESIGN.md#v6-mysql-upgrade)。

## Stage 13 · 可重复安装

- `Dockerfile`、`docker-compose.yml` 与 `INSTALL.md` 提供安装路径。bootstrap 可配置单个项目或整个群组，按需在空 Hub 发布 Bot 欢迎工单。重跑复用凭证及客户定制内容。

## Stage 14 · GitLab 原生接入与工作区帮助

- 新 Hub 的 GitLab 首页来自 `examples/hub-workspace/README.md`。Issue 模板提供编辑器内提示，`agents/onboarding/AGENT.md` 指导用户授权目标仓库与申请接入。
- Hub 与 MR 的 `/help` 走免模型、免会话写入路径。验收实时 Agent 就绪状态、权限、讨论串和首次接管提示。
- `gitlab-onboarding` 根据 `DETENT_PUBLIC_URL` 和服务端 Webhook 密钥启用。验收只读检查、整组 Maintainer 门槛、生产审批、幂等更新及凭证隔离。
- 接入验收从引导首页、群组发现与欢迎工单开始，验证 Developer 无法批准、SRE 批准后新项目的签名 Webhook 能实际启动 MR Worker。在测试环境中通过 `npm run e2e` 验收接入流程。

交互验收覆盖未开通能力零 Claude 调用、就绪场景的简短澄清、Issue 与 MR 的直接回答、生产审批拒绝提示去重与外部人员静默，以及状态、帮助和脱敏的业务执行记录。

## Stage 15 · Hub 能力与密钥

- 验收通用环境密钥、完整引用与请求头模板、默认分支能力热更新、外部 MCP 生产审批，以及 Agent 级账号与巡检前缀。
- 检查真实子进程的环境、模型请求、GitLab 评论与工具轨迹及 MySQL transcript 中的凭证隔离。在编码轮次验证 Hub 能力文件的写保护。
- Branch 4 使用单把 AccessKey 验证巡检和生产执行签名。先使用流程 `account`，其次使用 Hub `default_account`。两者均未设置时，逐资产按 JumpServer 返回顺序选择首个有效授权账号，跳过停用账号和以 `@` 开头的虚拟账号。巡检按账号分组并汇总结果。单个 Ansible 任务要求所有目标使用同一账号，否则须指定共同的 `account` 或分组执行。缺少有效账号时，错误指出对应资产。验收时检查两组巡检，且合并 SHA 与生产审批通过后，Ansible 以首账号和 `runas_policy=skip` 执行。

### JumpServer 契约与单工单会话验收

| 场景 | 观测点 |
| --- | --- |
| J-1 | 直接向 JumpServer API 提交缺失或错误的 `is_periodic` 得到 400。Delivery Pod 提交巡检、Playbook 时须显式为 false。 |
| J-2、J-5 | 过滤虚拟与停用账号，HTML 404 回退至资产详情。按 Agent、Hub、资产首账号选择，空授权或未授权账号在提交前拒绝。 |
| J-3、J-4 | 检查结构化结果及去除 NUL 的日志回退。同账号批量提交一次，不同账号的巡检分组汇总。混合账号的 Playbook 在上传前拒绝，失败执行写审计并阻止关单。 |
| J-6、J-7 | 验证 Kafka 进程、监听端口、Topic 列表、日期和主机名。硬拒绝不访问 Jev 或 JumpServer。语义放行要求 pure_readonly、noul ≥ 0.75、impact ≤ 1.35，拒绝展示评分。资产黑名单覆盖巡检及 Playbook。 |
| J-8 | 校验合并状态、SHA、流水线和生产审批人，对照 ZIP 的 main.yml、runas 与 jms_ 参数，检查 SUCCESS 审计、/status 与自动关单。 |
| J-9、J-10 | 含密钥的 400/403/500 在 Pod stderr 与工具轨迹中保留脱敏原文，MySQL transcript 无密钥。下一条评论加载 Hub 的前缀、账号、黑名单与启停配置。 |

## Stage 17 · 统一工程会话

无流程标签的 Issue 使用一个工程会话。主会话按索引读取 `agents/<id>/AGENT.md` 和相关 Skill，直接调用已就绪的工具。只读诊断结束后汇报证据并进入 `IDLE`。变更通过 `detent_submit_plan` 登记方案，进入 `WAITING_PLAN`，用户在 GitLab 点 👍 批准后继续实施。

父进程按三档执行工具门禁。

- `readonly` 允许方案阶段和实施阶段使用。
- `coding_auto` 在方案批准后开放。
- `always_approve` 要求单次工具审批，生产工具额外校验生产审批人。

模型代理在父进程脱敏并认证请求，向上游发送 Messages 和 token 计数请求前，将模型名统一为配置的 `CLAUDE_MODEL`。验收时核对 Messages 请求的模型名。Kafka 场景通过同一会话的工具轨迹、审批记录、MR 和源分支文件验收。

## Stage 18 · 批量巡检与异步任务

每轮 Claude 通过带令牌认证的回环 HTTP MCP 调用工具。工具审批和提问先保存会话并释放 Pod 租约，获授权的用户回复后由新进程恢复。通过 `jms_list_assets` 查询资产，向 `jms_shell` 传入 `commands` 数组完成批量巡检。生产审批通过后，`jms_job` 异步提交任务并返回链接，本轮结束。Delivery 记录终态并唤醒原 Issue 进行核验。`jms_job_status` 可查询当前会话所属的任务。统一工单与生产变更场景还需验证跨 Pod 恢复、超过 30 秒的工具调用和失败任务拒绝关单。
