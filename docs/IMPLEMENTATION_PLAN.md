# Detent 演进实施与验收计划（V2：双包分层与受治理 AI 变更交付中枢）

本文档承接已验收完成的 **V1 基线**（commit `1498aa4`，包含无状态 Pod 底座、纯增量 MySQL 仓储、GitLab CE 接入、双层审批、25 项测试及 `pre-commit` + `knip` + `OpenCodeReview` 质量门禁），定义 **V2：双包 Monorepo 拆分与面向生产交付的“受治理 AI 变更交付中枢（`@detent/core` + `@detent/delivery`）”** 的 **4 个推进阶段（Stages）**。

---

## V1 基线状态（已完成并验收）

- ✅ 无状态 Pod 架构（`/tmp` 沙箱用完即焚 + `uncommitted_diff` 跨 Pod 二进制补丁还原）
- ✅ MySQL 8.0 纯增量 `session_messages` 与分布式租约锁（15s 心跳）
- ✅ 1:N 跨项目 Worktree / MR / Pipeline 基础工具与单评论流式渲染
- ✅ 双层审批门禁（Plan 方案审批 + 高危工具热/冷恢复审批）
- ✅ 质量门禁落地（`npm run check` = `tsc` + `knip` + `vitest`、`.githooks/pre-commit`、`.opencodereview/rule.json`、`.gitlab-ci.yml`）

---

## V2 总体推进路线（4 个可独立交付验收阶段）

| 阶段 | 阶段目标 | 核心交付物 | 核心验收标准 |
| :--- | :--- | :--- | :--- |
| **Stage 1** | **双包 Monorepo 拆分与 `@detent/core` 4 大扩展点抽象** | `packages/core` (`@detent/core`)<br/>`packages/delivery` (`@detent/delivery` 骨架)<br/>4 个标准扩展接口（`DetentExtensionTool` / `resumeSession` / `TurnProfileResolver` / `SessionLifecycleHooks`） | 1. `packages/core` 零业务词/零业务依赖<br/>2. 原有 25 项测试 100% 通过 + 新增扩展点单测<br/>3. `npm run check` (`tsc` + `knip` + `vitest`) 全绿 |
| **Stage 2** | **GitLab `merge_request` 合并事件监听与会话自动续跑** | `session_merge_requests` 增加 `merge_commit_sha` / `merged_by` / `merged_at`<br/>`@detent/core` 暴露 `resumeSession`<br/>`@detent/delivery` 接入目标库 MR `merge` Webhook 自动唤醒原 Issue Session | 1. 端到端测试覆盖：`提 Ansible MR -> 人工 Merge -> MR Webhook 触发 -> 自动 --resume 原 Issue Session`<br/>2. 幂等校验（重复 Merge Webhook 不重复唤醒） |
| **Stage 3** | **JumpServer 双凭证适配器（只读巡检 + 任务中心）与合规硬守卫** | `packages/delivery/src/jumpserver/client.ts`（只读 Token / 执行 Token 物理分离）<br/>4 个 JumpServer MCP 工具（`jms_list_assets` / `jms_readonly_inspect` / `jms_run_ansible_job` / `jms_get_job_result`）<br/>合规硬守卫（MR 未合入强拦截 + 强制人工审批卡片） | 1. 单测覆盖：MR 未合并或 SHA 不一致时 `jms_run_ansible_job` 被硬守卫直接拦截<br/>2. Plan 模式拒绝执行，Coding 模式仅在硬守卫通过后弹审批卡<br/>3. 只读巡检工具在 `plan` 阶段可用且禁止写命令 |
| **Stage 4** | **多交付 Agent 角色体系、执行审计表与 6 阶段全链路 E2E 验收** | `delivery_executions` MySQL 审计表与仓储<br/>`EnvChangeAgent` / `ReadonlyAuditAgent` / `CodeDeliveryAgent` 角色路由与审批人 RBAC 策略<br/>工作区仓库示例模板 (`examples/hub-workspace/`)<br/>6 阶段全链路端到端集成测试 | 1. 完整跑通：`开变更 Issue -> JumpServer 只读巡检 -> 方案审批 -> 写 Ansible 提 MR -> 人工合并 MR 自动唤醒 -> 执行前二次审批 -> JumpServer 任务中心执行 -> 变更后只读验收 -> 写审计表`<br/>2. 推送前通过 `ocr delegate` 100% 覆盖率审查 |

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
   - 热审批或冷恢复放行后，执行前的 `tool.guard` 与 `tool.execute` 均接收该审批单的 `ctx.approvalId`。复检失败时终止执行。
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

## Stage 3：JumpServer 双凭证适配器与合规硬守卫

### 3.1 目标与实现内容
1. **JumpServer 配置与双凭证客户端（`packages/delivery/src/jumpserver/client.ts`）**：
   - 独立环境变量配置：
     - `JUMPSERVER_BASE_URL`
     - `JUMPSERVER_READONLY_ACCESS_KEY_ID` / `JUMPSERVER_READONLY_ACCESS_KEY_SECRET`（或 `JUMPSERVER_READONLY_TOKEN`），系统账号由 `JUMPSERVER_READONLY_ACCOUNT` 指定，默认 readonly
     - `JUMPSERVER_JOB_ACCESS_KEY_ID` / `JUMPSERVER_JOB_ACCESS_KEY_SECRET`（或 `JUMPSERVER_JOB_TOKEN`），仅供任务中心使用
     - `JUMPSERVER_INSPECT_ALLOW_PREFIXES`（只读巡检允许的命令白名单，默认如 `systemctl status,nginx -t,df -h,free -m,uptime,ss -tlnp,kubectl get,cat /etc/nginx` 等）
     - `JUMPSERVER_ORG_ID` 可选，`JUMPSERVER_TIMEOUT_MS` 默认 30000。
     - `JUMPSERVER_BLOCKED_ASSETS` 使用逗号分隔资产 ID，忽略大小写。`JUMPSERVER_BLOCK_FAILED_PIPELINE` 默认开启，可用 false 或 0 关闭。
   - 定义干净的 `JumpServerClient` 接口（支持真实 JumpServer v3/v4 REST API 签名认证 + 离线 Mock 实现供自动化测试）。
2. **4 个受治理 JumpServer MCP 工具（`packages/delivery/src/jumpserver/tools.ts`）**：
   - `jms_list_assets`（`policy: 'readonly'`）
   - `jms_readonly_inspect`（`policy: 'readonly'`，内置只读命令白名单 + 禁止 `; | & > < $()` 注入检查）
   - `jms_run_ansible_job`（`policy: 'always_approve'`）：
     - **`guard()` 硬校验**：
       1. 校验入参指定的 `(project, mr_iid)` 属于当前 Session；
       2. 从 MySQL 查询该 MR 状态必须为 `merged`，且 `merge_commit_sha` 非空并与请求执行的 `commit_sha` 完全一致；
       3. 校验该 MR 对应最新 Pipeline 未处于 `failed` 状态（可配置开关）。
     - **自定义审批卡片**：清晰展示 `目标资产组`、`Ansible 仓库与 Playbook 路径`、`已合并 MR 链接与 Commit SHA`、`变更参数变量`，提示运维负责人点 👍 或 `/approve` 放行。
     - **执行与审计**：放行后复核当前 MR，从 GitLab 读取该 SHA 的归档，将批准的 Playbook 提交到任务中心。通过注入的 `DeliveryExecutionTracker` 记录执行 ID、审批单和 MR；Stage 4 已提供共享池 MySQL 实现。
   - `jms_get_job_result`（`policy: 'readonly'`）要求 tracker 确认任务属于当前会话。缺少仓储时拒绝查询。

### 3.2 Stage 3 验收标准（DoD）
- 单元测试完整覆盖合规硬守卫：
  - MR 仍为 `opened`（未合并）时调用 `jms_run_ansible_job` -> 直接 `deny`，绝不发审批卡也绝不调 JumpServer；
  - `commit_sha` 与 `merge_commit_sha` 不匹配时 -> 直接 `deny`；
  - 只读巡检命令含写操作或 shell 拼接（如 `nginx -t && rm -rf /`） -> 直接 `deny`；
  - MR 已合并且参数合规 -> 弹出定制化生产变更审批卡片，未获当前审批策略授权的人批准不执行（角色级 RBAC 见 Stage 4），批准后成功调用任务中心并返回 Job ID 与审计链接。

---

## Stage 4：多交付 Agent 角色路由、执行审计与 6 阶段全链路验收

### 4.1 目标与实现内容
1. **交付执行审计表（`packages/delivery/src/db/audit.ts`）**：
   - 自动初始化 `delivery_executions` 表，关联 `session_id`、`mr_id`、`approval_id`、`jumpserver_job_id`、`commit_sha`、`status`、`output_summary`。
   - 增强 `/status` 指令输出：同时展示当前变更工单的 JumpServer 执行记录与审计链接。
2. **多 Agent 角色路由（`packages/delivery/src/agents/profiles.ts`）**：
   - 实现 `EnvChangeAgent`（默认禁止任意 `Bash` 裸连、强制走 JumpServer + Ansible GitOps 流程、执行审批要求更高权限/指定审批人名单）、`ReadonlyAuditAgent`（纯只读巡检排障）、`CodeDeliveryAgent`（通用研发交付）。
   - 提供工作区仓库示例目录 `examples/hub-workspace/CLAUDE.md`，清晰示范如何在你们的 GitLab 工作区仓库里定义环境清单、Ansible 仓库规范与变更纪律。
3. **6 阶段全链路端到端集成测试（`packages/delivery/tests/delivery-e2e.test.ts`）**：
   - 串联完整交付生命周期：
     `开环境变更 Issue -> JumpServer 只读巡检 -> 产出变更方案 -> 👍 批方案 -> 改 Ansible 仓库提 MR -> (中途尝试提前执行被硬守卫拦截!) -> 投递 MR Merge Webhook 自动唤醒 -> 弹出生产执行审批卡 -> 运维负责人点 👍 放行 -> JumpServer 任务中心执行 Ansible -> 变更后只读健康验收 -> 写入 delivery_executions 审计记录 -> /tmp 沙箱归零`。

### 4.2 Stage 4 最终验收标准（Final DoD）
1. `npm run check`（全量 `tsc` + `knip` + `packages/core` 与 `packages/delivery` 全量单测与 6 阶段 E2E）100% 通过。
2. 推送前严格按 [`AGENT.md`](file:///Users/murphy/code/work/relay/AGENT.md) 执行 `ocr delegate` 100% 覆盖率审查，确认无 Critical / High / 合理 Medium 问题，且 `packages/core` 零业务污染。

**Stage 4 已实现。** 运行 `npm run start:delivery` 启动构建后的入口，或用 `npm run dev:delivery` 开发。角色标签按 `delivery::audit`、`delivery::env-change`、`delivery::code` 顺序匹配，默认环境变更角色。生产审批按 `DELIVERY_PROD_APPROVERS` 名单与项目成员资格校验；无名单时使用 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）。[环境示例](../.env.example) 列出全部 JumpServer 与 Delivery 配置。

审计仓储使用同一 MySQL 池记录角色、目标资产、MR、SHA、审批单、任务与结果，`/status` 同时展示 MR 与执行审计。六阶段 E2E 通过 HTTP Webhook、临时 Git 仓库与受控外部服务替身验证审批、硬拦截、同一会话恢复、任务验收和沙箱清理。另有共享池建表、只读角色、生产权限与审计仓储测试。
