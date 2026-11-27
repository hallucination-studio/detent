# Detent：双包分层架构与“受治理 AI 变更交付中枢”设计文档

Detent 的名称来自飞机油门杆上点火前的机械止动槽。受治理 AI 变更交付中枢将这一原则落实为执行门禁：生产任务只有在目标 MR 已合并、合并版本校验通过且执行审批获准后才会下发。

> [!IMPORTANT]
> **总体定位**：本项目采用 **双包分层架构（`@detent/core` + `@detent/delivery`）**，并在 V3 演进为 **“硬安全边界由代码兜底 + 软交付流程由 Hub 仓库 SOP 驱动 + 运维能力包可空可插拔”**：
> 1. **`@detent/core`（通用基础架构包）**：将配置的 GitLab CE v18.3.0 **工作区仓库（Workspace Hub Repo）** 打造为 100% 无状态、多项目、纯增量 MySQL 持久化的 Claude Code 会话中枢（Hub Issue 与目标 MR 各自拥有独立 Claude Code Session，解耦 `0..N` 个跨项目 Worktree 与 `0..N` 个 MR，支持双层审批、Hub Agent 与兼容 SOP 加载、可空能力包预检与通用 GitLab Release 工具）。**保持零业务耦合，可独立复用或开源。**
> 2. **`@detent/delivery`（受治理 AI 变更交付中枢拓展模块）**：基于 `@detent/core` 的标准扩展点构建，将 JumpServer + Ansible 封装为**可选/可空能力包（`jumpserver`）**，并随 Hub 模板预置开箱即用的标准交付 SOP（`release` / `env-change` / `code-delivery` / `audit`）。客户可直接编辑 Hub 仓库 Markdown 定制流程，无需 JumpServer 也可独立运行发版与代码交付，或接入自有执行 MCP。

---

## 一、 双包分层架构与模块职责边界

### 1.1 为什么拆分为两个独立 Module（同仓 Monorepo）？

```text
detent/
├── package.json                       # npm workspaces: ["packages/*"]
├── packages/
│   ├── core/                          # @detent/core（通用基础架构包，零 JumpServer/Ansible 等业务耦合）
│   │   ├── package.json
│   │   ├── src/
│   │   └── tests/
│   └── delivery/                      # @detent/delivery（生产变更交付拓展包，依赖 @detent/core）
│       ├── package.json
│       ├── src/
│       └── tests/
├── docs/
│   ├── DESIGN.md
│   └── IMPLEMENTATION_PLAN.md
├── .opencodereview/rule.json          # 按 core 与 delivery 分层守卫代码质量与架构红线
├── .githooks/pre-commit
└── .gitlab-ci.yml
```

| 模块 | 职责定位 | 核心包含内容 | 边界红线 |
| :--- | :--- | :--- | :--- |
| **`@detent/core`** | 通用 GitLab Issue × Claude Code 无状态会话运行时 | • Webhook 网关（验签、防自环、内存队列）<br/>• MySQL 纯增量 `session_messages` 与分布式租约锁<br/>• 无状态 `/tmp` 沙箱（浅克隆 + `uncommitted_diff`）<br/>• 单评论节流流式渲染（`NoteStreamer`）<br/>• Claude SDK 运行器、通用双层审批引擎与基础 GitLab 工具<br/>• 4 个标准业务扩展钩子 | **绝不引入任何业务系统依赖**（不得出现 JumpServer、Ansible、特定 CMDB 等业务词汇或逻辑） |
| **`@detent/delivery`** | 面向生产交付与基础设施变更的受治理 AI 变更中枢 | • **JumpServer 适配器**（单 AccessKey、父进程工具门禁）<br/>• **合规硬守卫（Policy Guards）**：强制校验目标 Ansible MR 已 `merged` 且 SHA 一致；禁止直连 SSH/Ansible<br/>• **GitOps 续跑联动**：监听目标仓库 `merge_request (merge)` 事件自动唤醒原 Issue Session<br/>• **多交付 Agent 角色路由**（环境变更、配置发布、只读排查等）与变更执行审计表 | 所有通用会话、沙箱、MySQL 增量消息与评论渲染均复用 `@detent/core`，不重复造轮子 |

---

### 1.2 整体架构拓扑

```mermaid
flowchart TD
    subgraph GitLab["GitLab CE v18.3.0"]
        Hub_Repo["工作区仓库 (Workspace Hub Repo)<br/>Issues = 交付工单 / Claude Sessions<br/>存放 CLAUDE.md、Agent 定义与 Skills"]
        Target_Repos["业务配置与 Ansible 脚本仓库群<br/>(ansible-infra / k8s-config / app-repo...)<br/>承载代码版本 / 人工 Review & Merge / Pipelines"]
        GL_Webhook["Webhooks<br/>(Hub Issue/Note/Emoji + 目标库 MR/Note/Emoji/Pipeline/Deployment)"]
        GL_API["GitLab REST API v4"]
    end

    subgraph DeliveryApp["Detent 无状态 Pod 集群 (K8s Replicas 1..N, 无 PVC)"]
        subgraph DeliveryPkg["@detent/delivery (生产变更交付拓展模块)"]
            Agent_Router["多 Agent 路由<br/>(显式标签、Jev 自动路由与 Triage)"]
            MR_Hook["MR 合并事件处理器<br/>(目标库 Merge -> 自动唤醒原 Issue Session)"]
            Policy_Guard["交付合规硬守卫<br/>(强校验 MR=merged & SHA 一致 / 禁裸连 SSH)"]
            JMS_Tools["JumpServer MCP 工具集<br/>(只读巡检 | 生产审批执行)"]
        end

        subgraph CorePkg["@detent/core (通用基础架构包)"]
            WH_Gateway["Webhook 网关 & 内存队列<br/>(验签 / 防 Bot 自环 / 优雅停服)"]
            Session_Orch["Session 编排器<br/>(MySQL 租约锁 / 状态机 / resumeSession 扩展口)"]
            Note_Streamer["单评论节流流式渲染器"]
            Perm_Gate["双层权限门禁<br/>(Plan Gate + 工具 policy: readonly/coding_auto/always_approve)"]
            Core_Tools["基础 GitLab 工具 (SDK MCP)<br/>(Worktree / Commit&Push / 多 MR / Pipeline)"]
            Sandbox["单轮临时 /tmp 沙箱 (用完即焚)"]
        end
    end

    subgraph Infra["外部受控执行面与唯一持久化存储"]
        JMS_RO["JumpServer 堡垒机<br/>环境现状巡检 & 变更后核验"]
        JMS_Job["JumpServer 任务中心<br/>受控运行已合入的 Ansible Playbook + 录像审计"]
        MySQL[("MySQL 8.0<br/>Core 6 张表 (会话 / 纯增量消息 / Worktree / MR / 审批 / 收件箱)<br/>+ delivery_executions (交付执行审计表)")]
    end

    Hub_Repo --> GL_Webhook
    Target_Repos --> GL_Webhook
    GL_Webhook --> WH_Gateway
    WH_Gateway --> Session_Orch
    WH_Gateway --> MR_Hook
    MR_Hook -->|resumeSession| Session_Orch
    Agent_Router --> Session_Orch
    JMS_Tools --> Policy_Guard
    Policy_Guard --> Perm_Gate
    Session_Orch <--> MySQL
    Session_Orch --> Sandbox
    Sandbox <--> Target_Repos
    Sandbox <--> Hub_Repo
    Core_Tools --> GL_API
    Note_Streamer --> GL_API
    JMS_Tools -->|AccessKey| JMS_RO
    JMS_Tools -->|AccessKey| JMS_Job
    JMS_Tools -->|审计留痕| MySQL
```

---

## 二、 `@detent/core` 基础架构层设计与 4 个标准扩展点

### 2.1 核心底座机制（已在 V1 落地并验证）

1. **`1 Issue = 1 Session`，解耦 `0..N` Worktree 与 `0..N` MR**：
   - `issue_sessions` 主表仅保存轻量元数据、分布式租约锁（`locked_by_pod`、`lock_expires_at`，心跳上限 15s）与消息游标 `last_message_seq`。
   - `session_worktrees`（1:N）与 `session_merge_requests`（1:N）独立关联，支持单 Session 跨多个 GitLab 仓库创建多个分支与多个 MR。
2. **100% 无状态 Pod + MySQL 纯增量存储**：
   - `session_messages` 表按 `(session_id, seq)` 做纯增量 `INSERT IGNORE` 批量追加（绝不在主表存整份 JSONL 大字段）。
   - 单轮运行使用 `${EPHEMERAL_ROOT}/turn-<uuid>` 临时沙箱，`finally` 强制 `rm -rf`；未提交改动以 `git diff --binary` 补丁存入 `session_worktrees.uncommitted_diff`，实现跨 Pod 无缝水合还原。
3. **单评论流式渲染与热/冷双模审批挂起**：
   - `NoteStreamer` 节流刷新单条评论并折叠工具轨迹；
   - `PermissionGate` 在暂停前先刷盘 `checkpoint()`，支持同 Pod 内存 Promise 0 延迟热唤醒以及跨 Pod / 重启后的 `--resume` 冷恢复（跨 Pod 等锁具备状态早退机制）。

---

### Jev 语义风控

Core 的 `DecisionClient` 以一次 POST 提交 choice、noul、score 三问，兼容百炼 Decision Model API 和 TypeSafe System One。默认关闭。Bash 硬门禁优先，静态安全命令免网络请求。语义放行要求无外部影响概率达到阈值（默认 0.9），只读分类的影响分上限为 0.6，编码可接受工作区开发类且影响分不超过 1.4。其余结果和网络、协议错误在编码时发审批卡，在只读和 Plan 时拒绝。

Delivery 共享同一实例。只读巡检可在静态白名单外评估诊断命令，要求纯只读、无副作用概率达标、影响分 ≤ 0.6；资产黑名单和账号授权校验始终生效。只读巡检失败直接拒绝。生产任务、发版、需审批的关单与 Plan 沿用人工审批和权限检查。服务端隔离 Jev 密钥，错误与评论脱敏。

### 2.2 `@detent/core` 暴露的 4 个极简扩展契约（供 `@detent/delivery` 及未来其他模块接入）

为了保持 `@detent/core` 极度紧凑、不引入重型插件框架，仅定义以下 **4 个强类型接口**：

应用通过 `createDetentApp(config, { tools, resolveTurnProfile, hooks, matchWebhookEvent, onInitSchema, renderStatusExtra })` 装配扩展。各项均可省略，单独启动 Core 使用 `packages/core/src/server.ts`。Core 在 `onReady` 中完成基础表初始化后等待 `onInitSchema(pool)` 建立业务表，关闭时在队列 drain 后释放该连接池。

#### 扩展点 1：自定义工具与治理级别注册（`DetentExtensionTool`）
```ts
export type ToolGovernancePolicy = 'readonly' | 'coding_auto' | 'always_approve';

export interface ExtensionToolContext {
  session: IssueSessionRow;
  repo: DetentRepository;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  approvalId?: string;
  profileName?: string;
}

export interface DetentExtensionTool<TSchema extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: TSchema;
  /**
   * - readonly:       plan 与 coding 阶段均可自动放行（如 JumpServer 只读巡检）
   * - coding_auto:    plan 阶段禁止，coding 阶段自动放行（如基础 Git 工具）
   * - always_approve: plan 阶段禁止，coding 阶段强制弹出 GitLab Issue 审批卡片（如生产变更执行）
   */
  policy: ToolGovernancePolicy;
  /**
   * 只读与自动工具在 preflight 中校验一次。强制审批工具在发卡前与批准后各校验一次。
   * 返回 { ok: false, reason } 时直接拒绝，哪怕 LLM 幻觉想跳过前置步骤也无法绕过。
   */
  guard?: (input: z.infer<z.ZodObject<TSchema>>, ctx: ExtensionToolContext) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 可选自定义审批卡片 Markdown 渲染器（如展示目标主机组、已合并 MR Commit SHA、JumpServer 模板名）。
   */
  renderApprovalCard?: (approvalId: string, input: z.infer<z.ZodObject<TSchema>>, ctx: ExtensionToolContext) => string | Promise<string>;
  execute: (input: z.infer<z.ZodObject<TSchema>>, ctx: ExtensionToolContext) => Promise<unknown>;
}
```

使用 `defineExtensionTool({ schema, ... })` 定义每个工具，回调的入参类型从该工具的 Zod Schema 推导。返回的工具可放入同一个 `readonly AnyDetentExtensionTool[]`。对于获批的 `always_approve` 调用，执行前复检和执行函数均收到对应审批记录的 `ctx.approvalId`，热唤醒与冷恢复遵循相同约定。

#### 扩展点 2：外部 Webhook 事件扩展与受控会话唤醒（`resumeSession`）
- `SessionOrchestrator.resumeSession(sessionId: string, prompt: string, options?: { permissionMode?: PermissionMode; beforeRun?: (session: IssueSessionRow) => Promise<boolean> })`：
  - 取得租约并重读会话后先执行 `beforeRun`。返回 `false` 时直接释放租约。返回 `true` 或省略回调时继续检查待审状态，再设置权限模式并启动轮次。
  - 租约占用时抛出 `SessionBusy`，等待方案或工具审批时保留待审状态并拒绝续跑。
  - 受分布式租约锁保护的公开入口，供业务模块在收到外部事件（如目标仓库 **MR 被人工合并**、JumpServer 异步任务回调、告警触发）后唤醒对应的 Hub Issue Session。
- 通过验签和 Bot 过滤的非内置事件交给同步匹配器 `matchWebhookEvent(event)` 校验。返回 `null` 时，网关将事件提交到队列评估 Hub 策略并响应 202；未配置策略匹配器时响应 200 和 `{ ignored: true }`。返回 `{ key, handle(orchestrator) }` 时，网关提交到与内置事件共用的 WebhookQueue 后即响应 202。队列按 eventId 去重，同一 key 串行，遇到 `SessionBusy` 退避重试。停服时中断退避并等待在途处理结束。

#### 扩展点 3：多 Agent 角色与审批人策略解析（`TurnProfileResolver`）
轮次启动与审批授权均调用 `resolveTurnProfile({ session, repo, gitlab })`。`gitlab.getIssue(project, iid)` 提供 Issue 的 ID、IID、标题、描述、标签和状态，供扩展按标签选择角色。`gitlab.hasApprovalPermission(project, userId, minAccessLevel?)` 可用于复用项目成员权限检查。

```ts
export interface TurnProfile {
  name?: string;
  readonly?: boolean;
  /** 追加到 System Prompt 的业务规范（如环境变更规范、JumpServer 约束说明） */
  extraSystemPrompt?: string;
  /** 本次会话允许启用的扩展工具白名单（按 Agent 角色最小权限裁剪） */
  enabledExtensionTools?: string[];
  /** 是否禁用 Claude 内置 Bash 工具（例如高敏感交付 Agent 禁止直接执行任意 Shell） */
  disableBash?: boolean;
  /** 自定义审批人权限校验（例如生产变更要求 Maintainer 或指定 SRE 用户名单） */
  canApprove?: (params: { projectId: number; userId: number; username: string; approvalType: ApprovalType; toolName: string }) => Promise<boolean>;
}
```

#### 扩展点 4：审计生命周期回调（`SessionLifecycleHooks`）
- 审批记录从 PENDING 更新为 APPROVED、REJECTED 或 EXPIRED 后，成功写入决策的一方调用 `onApprovalResolved(approval, session)`。
- 每个成功完成的轮次在消息、工作区和最终会话状态保存后调用 `onTurnCompleted(session, result)`，其中 `result` 是本轮最终文本。钩子异常写入脱敏日志，审批和轮次按已保存的结果继续。

---

## 三、 `@detent/delivery`：受治理 AI 变更交付中枢详细设计

### 3.1 生产环境变更 6 阶段端到端闭环

```mermaid
sequenceDiagram
    autonumber
    actor Ops as 交付/运维工程师 (GitLab)
    participant GL_Hub as GitLab 工作区仓库 (Issue)
    participant GL_Ans as GitLab Ansible 仓库 (MR)
    participant Detent as Detent (@detent/core + @detent/delivery)
    participant JMS_RO as JumpServer 巡检
    participant JMS_Job as JumpServer 任务中心

    rect rgb(235, 245, 255)
        Note over Ops,JMS_RO: 阶段 1 & 2：发起变更工单 -> JumpServer 只读巡检 -> 产出变更方案
        Ops->>GL_Hub: 创建环境变更 Issue #88 (如标签 delivery::env-change)
        GL_Hub->>Detent: Issue Hook (open) -> 匹配 EnvChangeAgent
        Detent->>JMS_RO: jms_list_assets & jms_readonly_inspect (只读巡检目标主机现状)
        JMS_RO-->>Detent: 返回当前 Nginx/配置/服务状态
        Detent->>GL_Hub: 输出《环境变更实施方案审批卡》(现状 + 变更脚本计划 + 回滚方案)
    end

    rect rgb(255, 248, 230)
        Note over Ops,GL_Ans: 阶段 3 & 4：第一道门禁(方案审批) -> 编写 Ansible 脚本并提交 MR
        Ops->>GL_Hub: 对方案卡片点 👍 或回复 /approve
        GL_Hub->>Detent: Emoji/Note Hook -> 切换 CODING 模式
        Detent->>GL_Ans: 检出 ansible-infra 分支 -> 编写/修改 Playbook -> 创建 MR !205
        Detent->>GL_Hub: 回复 MR !205 链接，提示「请人工 Review 并合并 MR，合并后将自动进入执行审批阶段」
    end

    rect rgb(232, 245, 233)
        Note over Ops,GL_Hub: 阶段 5：第二道门禁(人工合并 MR) -> 自动唤醒原 Issue Session
        Ops->>GL_Ans: 人工 Review Ansible Playbook Diff 并点击 Merge MR !205
        GL_Ans->>Detent: Webhook: Merge Request Hook (action: merge, merge_commit_sha: 9f8e7d)
        Detent->>Detent: resumeSession 取得租约，beforeRun 原子标记 merged，记录 SHA、合并人及时间
        opt 首次记录合并
            Detent->>GL_Hub: 发布合并通知并说明待审批或自动续跑
            opt 当前无需等待审批
                Detent->>Detent: 用 default 权限模式恢复同一 Claude Session
            end
        end
    end

    rect rgb(255, 235, 238)
        Note over Ops,JMS_Job: 阶段 6：第三道门禁(执行前硬校验 + 人工审批) -> JumpServer 任务中心执行 & 只读验收
        Detent->>Detent: Claude 调用 jms_run_ansible_job -> Policy Guard 硬校验 MR !205 必须已 merged 且 SHA 一致
        Detent->>GL_Hub: 弹出【生产变更执行审批卡片】(展示资产组 / 已合并 MR SHA / Playbook 路径)
        Ops->>GL_Hub: 运维负责人点 👍 或回复 /approve 放行执行
        Detent->>JMS_Job: 调用 JumpServer 任务中心 API 执行已合入的 Ansible Playbook
        JMS_Job-->>Detent: 返回任务 ID、执行结果与审计录像链接
        Detent->>JMS_RO: jms_readonly_inspect (执行变更后只读健康验收)
        Detent->>GL_Hub: 输出《变更交付完成报告》(MR + 审批人 + JumpServer 任务链接 + 验收结果)
    end
```

---

### 3.2 `@detent/delivery` 内置的 JumpServer MCP 工具集与安全护栏

| 工具名 | 绑定凭证 | 治理级别 (`policy`) | 强制守卫 (`guard`) | 功能说明 |
| :--- | :--- | :--- | :--- | :--- |
| `jms_list_assets` | Hub AccessKey | `readonly` | 仅限查询已授权节点/主机组 | 按搜索词或节点查询已授权资产的 ID、名称与地址 |
| `jms_readonly_inspect` | Hub AccessKey | `readonly` | 硬拒绝危险命令，校验允许前缀或通过 Jev 只读判定（禁止写/改/删命令） | 通过 JumpServer 授权账号在目标环境执行只读巡检（如查配置、端口、进程、磁盘、健康检查） |
| `jms_run_ansible_job` | Hub AccessKey | **`always_approve`** | **1. 硬校验对应 Ansible MR 在 MySQL 中已 `merged` 且 `merge_commit_sha` 匹配**<br/>**2. 校验目标资产组不在黑名单**<br/>**3. 审批前与放行后双重校验** | 通过 JumpServer 任务中心（Ops Job Center）下发指定仓库、指定已合并 Commit 的 Ansible Playbook 任务，并通过注入的 tracker 记录实际执行 ID |
| `jms_get_job_result` | Hub AccessKey | `readonly` | 必须由 tracker 确认本 Session 拥有任务 ID；未配置则拒绝 | 轮询并拉取 JumpServer 任务中心执行状态、标准输出摘要及 JumpServer Web 审计链接 |

Stage 3 通过 `createDeliveryApp(config, options)` 装配。Hub 配置服务地址和 `auth` 后启用四个工具。默认使用同一 AccessKey 做 HMAC-SHA256 签名。未配置 Hub 条目的旧部署仍可使用环境变量为两个角色分别指定凭证。巡检与 Playbook 均校验资产账号，并发送 `runas` 和 `runas_policy=skip`。

执行前重读当前会话的 MR，默认拦截失败流水线。HTTP 客户端按合并 SHA 下载 GitLab ZIP，将指定相对路径作为私有 Playbook 的入口，保留同一提交中的角色、文件和相对引用。归档下载及解压各限 64 MiB。GitLab 凭证仅用于 GitLab 请求。任务变量遵循 Job Center 的 `jms_` 命名空间，例如参数 `version` 在 Playbook 中为 `jms_version`。审批卡渲染时从仓储重读 MR。默认追踪器使用共享 MySQL 连接池写入交付审计。

> [!CAUTION]
> **四重防绕过安全机制（Defence in Depth）**：
> 1. **父进程工具门禁**：JumpServer AccessKey 仅由服务端使用。只读流程隐藏执行工具，巡检命令通过硬拦截和只读判断后才能提交。生产执行须通过 prod 审批。
> 2. **禁止裸连 SSH / 本地直跑 Ansible**：交付类 Agent（如 `EnvChangeAgent`）默认禁用或严格限制 `Bash`（禁止 `ssh`、`scp`、`ansible`、`ansible-playbook` 直连命令），所有环境触达必须走 JumpServer 工具。
> 3. **代码硬校验 MR 已合并**：即使 Prompt 提示词被绕过，只要目标 Ansible MR 还没在 GitLab 上真实 `merged`，`jms_run_ansible_job.guard()` 会直接以硬代码拒绝执行。
> 4. **三方审计闭环**：每一次生产变更在 MySQL `delivery_executions` 表中将 **GitLab Issue（工单与审批人） + GitLab MR（已合并的 Ansible Commit SHA） + JumpServer Job ID（执行日志与堡垒机审计记录）** 强关联存证。

---

### 3.3 多交付 Agent 角色体系（配置驱动）

Stage 4 的 `TurnProfileResolver` 在每轮和每次审批时从 GitLab 读取 Hub Issue 标签，去除两端空白并忽略大小写。依次匹配 audit、env-change、code，无匹配标签时选择 EnvChangeAgent。

| Agent 角色 | 触发标签（示例） | 允许工具范围 | 审批策略 |
| :--- | :--- | :--- | :--- |
| **`EnvChangeAgent`**（环境变更交付） | `delivery::env-change`（或默认） | GitLab Worktree/MR 工具 + JumpServer 只读巡检 + JumpServer Ansible 执行（禁用裸 `Bash` SSH） | Plan 方案审批（Developer+） + **MR 人工合并** + 执行前二次审批（Maintainer / 指定 SRE 审批组） |
| **`ReadonlyAuditAgent`**（只读巡检/排障） | `delivery::audit` | GitLab 只读 + JumpServer 只读巡检（禁止一切写工具与执行工具） | SDK 使用 default 模式，门禁与工作区强制只读；巡检验收后按 SOP 关闭工单 |
| **`CodeDeliveryAgent`**（通用研发交付） | `delivery::code` | `@detent/core` 标准多项目编码工具 + 受控 `Bash` | 遵循 `@detent/core` 默认双层审批 |

---

`jms_run_ansible_job` 的审批权由 `DELIVERY_PROD_APPROVERS`（用户名名单 + 项目普通审批门槛）或空名单时的 `DELIVERY_PROD_MIN_ACCESS_LEVEL`（默认 40）控制。其他审批使用项目普通门槛。生产服务使用 `npm run start:delivery`，完整凭证、超时、资产限制等配置见 [环境示例](../.env.example)。

## 四、 MySQL 8.0 数据模型增量演进

V6 使用六张 Core 表和一张 Delivery 审计表。交付审计关联会话、MR 与批准的工具执行。

```mermaid
erDiagram
    ISSUE_SESSIONS ||--o{ SESSION_MESSAGES : "1:N 纯增量消息 (@detent/core)"
    ISSUE_SESSIONS ||--o{ SESSION_INBOX : "1:N 轮中指示 (@detent/core)"
    ISSUE_SESSIONS ||--o{ SESSION_WORKTREES : "1:N 跨项目分支 (@detent/core)"
    ISSUE_SESSIONS ||--o{ SESSION_MERGE_REQUESTS : "1:N 跨项目 MR (@detent/core)"
    ISSUE_SESSIONS ||--o{ APPROVAL_REQUESTS : "1:N 方案/工具/执行审批 (@detent/core)"
    ISSUE_SESSIONS ||--o{ DELIVERY_EXECUTIONS : "1:N 变更执行审计 (@detent/delivery)"

    SESSION_MERGE_REQUESTS {
        char(36) id PK
        char(36) session_id FK
        bigint target_project_id
        bigint mr_iid
        varchar(32) mr_state "opened | merged | closed"
        varchar(64) merge_commit_sha "新增：MR 合并后的最终 Commit SHA (用于硬校验)"
        varchar(128) merged_by "新增：合并人 GitLab username"
        datetime merged_at "新增：合并时间"
    }

    DELIVERY_EXECUTIONS {
        char(36) id PK "UUID"
        char(36) session_id FK "关联 Issue Session"
        char(36) mr_id FK "关联已合并的 Ansible MR"
        char(36) approval_id FK "关联执行前人工审批单 ID"
        varchar(64) agent_profile "执行本次变更的 Agent 角色"
        varchar(128) jumpserver_job_id "JumpServer 任务中心 Job ID"
        varchar(512) jumpserver_job_url "JumpServer 审计详情链接"
        varchar(255) playbook_path "执行的 Ansible Playbook 路径"
        varchar(64) commit_sha "执行对应的已合并 Git Commit SHA"
        json target_assets "目标资产/主机组 JSON"
        varchar(32) status "PENDING | RUNNING | SUCCESS | FAILED"
        mediumtext output_summary "执行输出摘要"
        datetime created_at
        datetime finished_at
    }
```

`delivery_executions` 使用 InnoDB，与 Core 外键使用相同的 `utf8mb4_bin` 排序规则。共享池初始化完成后登记提交时的角色、目标资产、Playbook 和合并 SHA。`(session_id, jumpserver_job_id)` 唯一标识会话中的任务，`(session_id, created_at)` 支持按时间列出审计记录。结果查询保存状态与摘要，首次进入 SUCCESS 或 FAILED 时保存毫秒级完成时间。`/status` 在状态和 MR 摘要下显示已有执行记录、关联审批单与任务链接。

---

## 五、 V3 架构演进：Hub 仓库 SOP 驱动与可空能力包（方案 A）

### 5.1 设计动机与核心边界

企业交付流程千差万别（例如发版策略可能是“合并 `main` 后直接打 tag”，也可能是“拉 `release/vX.Y` 改版本号再合并打 tag”；运维执行面可能是 JumpServer + Ansible，也可能是纯 GitLab CI / ArgoCD / 自研发布平台）。V3 将 **“硬安全门禁”** 与 **“软业务流程”** 彻底解耦：

| 层次 | 承载位置 | 职责边界 | 变更方式 |
| :--- | :--- | :--- | :--- |
| **Layer 3：软交付流程（SOP）** | **GitLab Hub 仓库**（`CLAUDE.md`、`workflows/*.md`、`.gitlab/issue_templates/*.md`） | 分支/Tag 策略、前后置检查清单、MR 编排步骤、回滚与报告格式、自定义新流程（如 `hotfix.md`） | 客户直接编辑 Hub 仓库 Markdown 并合并到受保护默认分支，**下一轮立即生效、零发版、自带 Git Review 审计** |
| **Layer 2：可空能力包（Capability Packs）** | `@detent/core`（`gitlab-release`）+ `@detent/delivery`（`jumpserver`）+ 用户扩展（`capabilities`） | 封装外部系统原子工具及其**工具级硬守卫**；**所有非基础能力均可空**，未配置即不注册，不向未启用客户暴露无关提示词 | 通过环境变量按需开启，或通过 `DetentCapabilityPack` 接入自有工具 |
| **Layer 1：硬治理底座** | `@detent/core` 编排器与 `PermissionGate` | 无状态 Pod、MySQL 增量持久化、Plan 门禁、`always_approve` 审批卡、RBAC 审批人校验、能力/SOP 缺失预检与 Issue 提示、Hub 治理文件写保护 | 平台代码保障，**不可被 Markdown SOP 弱化或绕过** |

### 5.2 Hub 仓库标准目录与 `workflows/*.md` 契约

以下为 V3 兼容布局。新 Hub 使用第七节的 Agent 与 Skill 目录。

```text
workspace-hub/
├── CLAUDE.md                         # 全局上下文：团队仓库清单、环境/资产表、通用约定
├── workflows/                        # 每个 Markdown 文件定义一种可定制交付流程
│   ├── release.md                    # 标准发版 SOP（requires: [gitlab-release]）
│   ├── env-change.md                 # 标准生产环境变更 SOP（requires: [jumpserver]）
│   ├── code-delivery.md              # 标准跨项目研发交付 SOP（requires: []）
│   └── audit.md                      # 标准只读巡检排障 SOP（requires: [jumpserver]）
└── .gitlab/
    └── issue_templates/              # GitLab 原生开单模板（下拉选流程并自动打标签）
        ├── release.md
        ├── env-change.md
        ├── code-delivery.md
        └── audit.md
```

每个 `workflows/<name>.md` 采用 **极简 YAML Frontmatter（仅声明路由、安全档位与能力依赖）+ 纯自然语言 Markdown 正文（不引入重型 DSL 引擎）**：

```markdown
---
label: delivery::release          # 触发该 SOP 的 GitLab Issue 标签（忽略大小写）
mode: governed                    # readonly（纯只读直接出报告）| governed（走 Plan 审批与写/执行阶段）
requires: [gitlab-release]        # 所需能力包清单；纯代码/GitOps 写 []
approver_tier: prod               # standard（普通审批门槛）| prod（生产审批人名单 / Maintainer 门槛）
default: false                    # 可选：是否作为无标签 Issue 的默认兜底流程（默认 false）
description: 标准仓库发版流程
---

# 标准发版流程（客户可按团队规范直接修改正文）
...
```

> [!IMPORTANT]
> **安全不变量（SOP 不可越权）**：
> 1. `EphemeralSandbox` 将 Hub 仓库的 `CLAUDE.md`、`.claude/` 与 `workflows/` 拷入沙箱后，`PermissionGate` **严禁编码 Agent 写入 `CLAUDE.md` 或 `workflows/`**，仅允许修改 `projects/` 下的业务仓库。
> 2. `mode: readonly` 使用 SDK `default` 模式。只读 SOP 禁用 `Edit`/`Write`/`Bash`；门禁与工作区强制只读，关单按 `close_policy` 单独授权。
> 3. **高危工具权限不可被 SOP 降级**：诸如 `jms_run_ansible_job`、`detent_create_release` 等代码定义的生产级工具，即使 SOP 误写 `approver_tier: standard` 或审批期间被更换 Issue 标签，审批时必须重新确认当前流程已就绪、非只读且启用该工具，再校验生产审批人。
> 4. `approver_tier: prod` 对流程内的所有 `TOOL_USE` 审批生效。Plan 审批使用普通项目权限。

### 5.3 核心扩展契约演进（`@detent/core` 零业务污染）

1. **可空能力包契约（`DetentCapabilityPack`）**：
   ```ts
   export interface DetentCapabilityPack {
     /** 能力包标识，对应 workflows/*.md frontmatter 的 requires 项 */
     name: string;
     /** 能力未启用时展示在 GitLab Issue 引导卡片中的配置提示 */
     setupHint?: string;
     /** true 表示服务端已就绪可用；false 表示当前未配置（工具不注册） */
     enabled: boolean;
     /** 能力包提供的受治理扩展工具（enabled 为 false 时忽略） */
     tools: readonly AnyDetentExtensionTool[];
   }
   ```
   - `gitlab-workspace`（基础分支/提交/MR/Pipeline）始终内置可用。
   - `gitlab-release`（`@detent/core` 内置可选能力包）：
     - `detent_list_tags`（`policy: 'readonly'`）：列出目标仓库已有 tag 与对应 commit SHA，辅助生成 Release Notes 与版本规划。
     - `detent_create_release`（`policy: 'always_approve'`）：支持创建 Git Tag + GitLab Release（或 `tag_only: true` 仅打 Tag）。**硬守卫**：校验 tag 名格式合法、目标 `commit_sha` 为完整 40 位有效提交且存在于目标仓库、该 tag 尚未存在、（可配置）对应提交最新流水线非 `failed`。审批卡明确锁定 **目标仓库、Tag 名、40 位 Commit SHA、模式与 Release Notes 摘要**，人工确认 👍 后执行。
   - `jumpserver`（`@detent/delivery` 可选/可空能力包）：配置 Hub 服务地址和凭证、使用旧版 `JUMPSERVER_BASE_URL` 或注入 `jumpserverClient` 时 `enabled: true`；未配置时 `enabled: false` 并携带 `setupHint`，**零 JumpServer 配置即可完整运行 `start:delivery`、Release 与代码交付**。
   - 用户自有扩展：可通过 `createDetentApp / createDeliveryApp` 的 `capabilities` 注册自定义能力包（如 `{ name: 'argocd', enabled: true, tools: [...] }`），并在 Hub `workflows/*.md` 中通过 `requires: [argocd]` 引用。

2. **轮次预检短路（`TurnProfile.blockedMessage`）**：
   - `TurnProfile` 新增可选字段 `blockedMessage?: string`。
   - `TurnProfileResolver` 上下文的 `gitlab` 同步开放 `listRepositoryTree` 与 `getRepositoryFile`（只读读取 Hub 仓库默认分支，保证无状态 Pod 跨轮次、跨审批回调都能一致解析 `workflows/*.md`，禁止 Pod 内存缓存业务状态）。
   - `SessionOrchestrator.run()` 在解析 `profile` 后、**克隆沙箱与调用 Claude 之前**检测 `profile.blockedMessage`：若存在则直接将引导说明发布到 Issue 评论、置状态为 `IDLE`（保留原 `permissionMode` 以便用户补齐配置或打标签后无缝继续）并结束本轮，**零 Token 消耗、不让 AI 盲猜报错**。

3. **逻辑/能力缺失时的 Issue 友好引导（4 种场景）**：
   - **场景 1（SOP 依赖的能力包未启用 / 为空）**：例如命中 `workflows/env-change.md`（`requires: [jumpserver]`）但未配置 JumpServer → 直接在 Issue 提示缺失能力名。正文列出已就绪的流程与标签，管理员配置提示折叠展示。
   - **场景 2（Issue 未匹配到任何 SOP）**：Hub 仓库存在 `workflows/`，但 Issue 无匹配标签且无 `default: true` 流程 → 直接在 Issue 列出 Hub 当前全部可用流程（标签、文件、说明），指导用户加标签或新增 `workflows/<name>.md`。
   - **场景 3（多条冲突流程标签同时命中）**：同一 Issue 同时打了多个非只读流程标签（如同时打 `delivery::release` 与 `delivery::env-change`）→ 在 Issue 提示仅保留一个目标流程标签，避免歧义。
   - **场景 4（老 Hub 仓库尚无 `workflows/` 目录）**：平滑兼容回退——仅启用服务端实际已配置的能力包，按 `CLAUDE.md` 工作（若无 `jumpserver` 能力则绝不注入 JumpServer/Ansible 提示词）。

4. **初始化脚本非破坏性预置（`scripts/bootstrap.ts`）**：
   - `npm run bootstrap` 将 `examples/hub-workspace/` 下的模板递归补齐到 Hub 默认分支，保留已有文件，并补齐内置标签。

---

## 六、 V4 架构演进：Issue 自动闭环终止条件与全 SOP 确定性验收

### 6.1 设计原则：将“轮次结束（`IDLE`）”与“工单闭环（`DONE` / `closed`）”解耦

在多轮审批与跨库 MR 协作场景下，单轮结束（`IDLE`）往往只是在等待人工 Review、合并或追问，**绝不能在每轮结束后无条件关闭 Issue**；但当需求与当前 Hub SOP 的全部验收条件都已满足时，工单也不应长期滞留在 `Open` 状态。

V4 通过 **3 层组合机制** 实现安全可控的 Issue 闭环：

1. **新增状态与标签**：`SessionStatus` 新增 `'DONE'`，对应 GitLab 状态标签 `claude::done`（清晰区分等待中的 `claude::idle` 与已闭环的 `claude::done`；人工手动关闭 Issue 同样同步为 `DONE` / `claude::done`）。
2. **Hub `workflows/*.md` 声明关闭策略（`close_policy`）**：
   - `close_policy: manual`（未声明时的默认保守策略）：不向 Claude 暴露关单工具，只能由人工手动关闭 Issue。
   - `close_policy: auto`：向 Claude 暴露 `detent_close_issue({ summary })`；满足代码硬守卫后，在**本轮末尾原子收口关闭**。
   - `close_policy: approve`：向 Claude 暴露 `detent_close_issue({ summary })` 且治理策略为 `always_approve`；通过代码硬守卫后弹出【工单闭环关闭审批】卡，需人工点 👍 或 `/approve` 才在轮次末尾关闭。
   - 4 套内置标准 SOP（`audit`、`release`、`env-change`、`code-delivery`）默认配置 `close_policy: auto`，并在 SOP 正文写明各自的业务终止条件；用户可直接改为 `approve` 或 `manual`。
3. **代码层硬守卫与轮次末尾延迟原子关闭**：
   - **`detent_close_issue` 硬守卫（不可被 LLM 幻觉绕过）**：
     1. 非 `readonly` 流程在 `permissionMode === 'plan'` 阶段（方案尚未批准）严禁关单；
     2. 存在其他 `PENDING` 审批请求时严禁关单；
     3. 当前会话在 `session_merge_requests` 中只要还有任意一条 `mr_state === 'opened'` 的未合并 MR，严禁关单（防止刚提 MR 就误关）；
     4. 支持扩展钩子 `canCloseIssue({ session, repo })`：`@detent/delivery` 校验若本会话存在 `delivery_executions` 记录且最新一条状态非 `SUCCESS`，严禁关单。
   - **延迟原子收口**：`detent_close_issue` 在轮次中仅记录待关闭请求；只有本轮 Claude 正常结束且未抛错时，编排器按序完成 **增量落库 transcript → 保存工作区检查点 → 复核关单守卫 → 归档全部活跃 Worktree → 刷新最终评论 → 调用 GitLab `closeIssue`（`state_event: 'close'`）→ 状态置为 `DONE` 并打上 `claude::done`**。Bot 自身关闭触发的 `issue (close)` Webhook 被 `isBotUser` 自动忽略，零自环；人工后续在 GitLab 点 Reopen 并发表评论可无缝恢复会话。
   - **已闭环会话防误唤醒**：`@detent/delivery` 的 MR 合并处理器对已处于 `DONE` 的会话记录合并信息但不再自动拉起新轮次。

### 6.2 全 SOP 确定性 Mock-LLM 验收体系（双目标模式）

为避免依赖外部模型 API，E2E 采用本地确定性 Mock Anthropic SSE 服务驱动真实 `@anthropic-ai/claude-code` 进程。双目标复用同一套场景，V5 扩展见第七节。
- **`npm run e2e:offline`**：离线 GitLab（含真实 `git-http-backend`）+ 离线 JumpServer + Mock Anthropic + 真实 MySQL 8.0 Docker + 真实 `bootstrap.ts` + 真实 `packages/delivery/dist/server.js`。
- **`npm run e2e:gitlab`**：直连真实本地 GitLab CE v18.3.0（如 `http://127.0.0.1:8080`）+ 真实 MySQL 8.0 + Mock Anthropic + Mock JumpServer，零模型 API 费用、100% 确定性验收真实 GitLab API/Webhook/Tag/Release/Issue 自动闭环。

---

## 七、 V5 架构演进：Multi-Agent Hub 仓库、单 Agent Skills、Jev + Triage 智能路由与声明式外部 MCP 代理

### 7.1 Hub 目录与单 Agent 工作区

Core 从 Hub 默认分支递归读取 `agents/` 和 `skills/`。`agents/<id>/AGENT.md` 沿用 V3 的流程字段，标签默认 `agent::<id>`，可通过 `description` 和 `routing_hint` 提供 Jev 路由依据。`shared_skills` 引用根目录 `skills/<skill>/SKILL.md`，同 Agent 的私有 Skill 则位于 `agents/<id>/skills/<skill>/SKILL.md`。Skill 用 `name` 和 `description` 声明索引。旧的 `workflows/<name>.md` 按同一套路由，若同 ID 有新版 Agent 则优先加载新版入口。

编排器为选定的 V5 Agent 拷贝 Hub 的 `CLAUDE.md`、`.claude/`、该 Agent 目录及其声明的共享 Skills。系统提示词包含 Agent 正文和 Skill 的名称、描述与路径，Claude 以 `Read` 按需获取 Skill 正文。沙箱跳过符号链接并保护根目录的 `CLAUDE.md`、`agents/`、`skills/` 与 `workflows/`。Issue 仍复用同一个 Session 和已登记的业务 Worktree。示例包含四个原有交付 Agent 和 `image-sync`，Bootstrap 递归补齐目录及 `agent::image-sync` 等标签，并跳过已有文件。[Hub 示例](../examples/hub-workspace/CLAUDE.md)

### 7.2 Jev 自动路由、Triage 与人工切换

1. Delivery 每轮重读 Hub 定义及 Issue 标签。匹配标签时按确定性规则选择，唯一的只读匹配优先于其他匹配，其余冲突返回引导。缺失 `requires` 时在创建沙箱前返回能力名、配置指引和就绪选项。
2. 无匹配标签的普通轮次使用同一个 `DecisionClient` 评估 `hub_agent_routing`。输入包括工单标题、描述、非状态标签和最多四条去重后的近期用户消息，排除 Bot 与系统评论。三问校验是否存在唯一候选、`clear_match` 是否达到 `JEV_ROUTING_THRESHOLD`（默认 0.8）及 `ambiguity` 是否不超过 1.2。
3. 高置信度且能力已就绪时，编排器在当前租约内先将权限模式持久化为 `plan`，再写回 Agent 标签，本轮评论附路由提示。后续轮次按该标签选择。候选需要未开通能力且没有更强的就绪候选时直接返回同一张能力卡。其余不确定的请求可回退到默认 Agent。没有默认 Agent 时，Triage 以只读模式运行，无扩展能力工具，区分已就绪与未开通的能力，最多询问三个必要问题并回到 `IDLE`。用户补充信息后可再次路由。
4. 具备项目普通审批权限的成员可用 `/use <id 或标签> [补充需求]` 切换。旧轮次停止后，编排器在租约内作废待审单，先持久化 Plan 重置，再替换 Agent 标签并启动新轮次。`purpose === 'approval'` 只按现有标签或默认 Agent 重读授权，无 Jev 调用或 Triage 轮次。

### 7.3 声明式外部 MCP 能力包

`createDetentApp` 在启动时读取 `DETENT_MCP_CAPABILITIES_FILE`，通过 Streamable HTTP 初始化外部 MCP 会话、发现工具并转换其输入 Schema。以下部署示例用环境变量为注册表工具提供凭证。

```json
{
  "capabilities": [
    {
      "name": "harbor-sync",
      "approverTier": "prod",
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/harbor",
        "headers": { "Authorization": "Bearer ${HARBOR_SYNC_TOKEN}" }
      },
      "toolPolicies": { "check_image_exists": "readonly" }
    }
  ]
}
```

Agent 通过 `requires: [harbor-sync]` 启用本包，工具以 `<包前缀>__<工具名>` 注册到 Detent SDK MCP。上例中 `harbor-sync__check_image_exists` 可在 Plan 调用，未指定策略的 `harbor-sync__sync_image` 默认 `always_approve`，在 Coding 阶段通过工具审批后才调用远端。`toolPolicies` 可覆盖 `defaultPolicy`，工具仍通过既有门禁。缺失凭证、初始化失败或工具名冲突会禁用对应能力包，经 `setupHint` 提供引导。

请求头在服务端展开。代理在工具元数据、审批卡片、工具结果和错误返回前脱敏，外部凭证不传给 Claude Code。Delivery 重读当前 Agent 验证工具仍启用，并对 `approverTier: prod` 包的工具执行生产审批权限校验，即使 SOP 指定 `approver_tier: standard`。Plan 保持普通项目审批权限。示例 `image-sync` 默认 `requires: []`，可通过 GitOps 清单 MR 与 CI 完成同步，也可配置此能力包。[镜像同步 Agent](../examples/hub-workspace/agents/image-sync/AGENT.md)

### 7.4 V5 确定性验收

同一套 E2E 保留缺能力、跨库双 MR、在线更新发版 Agent、旧 `workflows/hotfix.md`、只读审计和跨 Pod 环境变更。在镜像同步场景中，Mock Jev 先以低置信度触发澄清。用户回复后，服务写回选定 Agent 的标签，真实 Claude Code 读取私有 Skill 并在 Plan 查询 Mock MCP。测试检查 Developer 批准 Plan、生产工具须 SRE 批准、同步成功后关闭工单，并确认 MCP 回显的 Bearer 凭证在进入模型结果及 Issue 评论前已脱敏。

## 八、V6 控制面基础

`issue_sessions` 以会话类型、项目 ID 和资源 IID 唯一标识 Issue 或 MR。旧数据升级为 Issue。主表增加自动修复次数、最近失败的流水线 ID 和恢复次数。MR 默认进入 CODING，使用 default 权限模式。创建 MR 时将已识别的 Bot 加入受理人。

`session_inbox` 以 `(session_id, event_id)` 去重，按递增 ID 在短事务内消费。普通评论先入库再尝试取得租约。SDK 的 PostToolUse 读取当前会话的待处理评论。轮末若有新消息，在同一租约下创建下一轮沙箱。发布最终评论后，只有收件箱为空才结束正常轮次。等待审批的会话保留人工门禁。

Watchdog 以无锁查询发现过期的活跃会话和遗留消息。抢占恢复租约时同时比对扫描到的到期时间。成功轮次清零恢复次数。次数用尽后会话进入 FAILED，旧的待处理消息标为 EXPIRED，GitLab 评论提示用户重新发送。定时器在 Fastify 就绪后启动，关闭时等待在途扫描结束。

Hub 默认分支可提供如下 `events.json`。规则按顺序处理，`actionType` 指定处置，此时可用 `action` 匹配 GitLab 操作。省略 `actionType` 时，`action` 直接指定处置。过滤字段支持单个字符串或非空字符串数组，数组内任一值匹配即可。项目和分支支持 `*` 通配符。`semantic` 只向 Jev 发送简短摘要、提示与候选动作，故障时使用 `fallbackAction`，缺省为 notify。

```json
{
  "version": 1,
  "rules": [
    { "event": "release", "action": "create", "actionType": "notify", "notifyTarget": "hub_issue" },
    { "event": ["build", "deployment"], "project": "apps/*", "status": ["failed"], "branch": ["main", "release/*"], "action": "notify", "notifyTarget": "commit" }
  ]
}
```

内置 Issue 与流水线处理优先，已匹配的扩展继续拥有其事件。进入策略处理的事件由 WebhookQueue 加载并评估规则。通知按资源、提交或 Hub 告警 Issue 投递，再调用可选的 `onNotify`。资源缺少 Issue 或 MR 时优先使用提交，缺少提交时创建 Hub 告警 Issue。人为事件带有 actor ID 时，`run` 先校验其在来源项目的审批权限，缺少项目 ID 时校验 Hub 权限。通过后按常规运行流程处理。运行流程将摘要投递到关联的 Hub Issue；缺少关联时创建 Hub Issue，从 Plan 开始。

### 8.1 独立 MR 工作轮次

`MergeRequestOrchestrator` 通过目标项目与 MR IID 查找会话，接单后以 `default` 模式检出源分支。只有 Bot 新增为受理人的更新触发接单。未分配的 MR 通过显式提及请求单次协助。目标项目的成员权限适用于人为接单、评论和审批。评论的文件位置和讨论串 ID 随收件箱持久化。繁忙轮次通过 PostToolUse 读取新指示，回复发回对应讨论串。

MR 轮次可用 Read、Glob、Grep、Edit、Write、Bash、AskUserQuestion，以及以下工具。Bash 复用静态命令与 Jev 风控。跨 Fork 写入要求 Bot 在源项目至少有 Developer 权限，缺少权限时通过 GitLab 评论提供建议。

| 工具 | 作用域 |
| --- | --- |
| `detent_commit_and_push` | 当前 MR 工作树和源分支 |
| `detent_get_pipeline_status`、`detent_get_pipeline_job_log` | MR 或源分支的 CI |
| `detent_get_mr_diff`、`detent_list_mr_discussions` | 当前 MR 的脱敏差异与讨论串 |
| `detent_sync_target_branch` | 在工作树中合入目标项目的目标分支，返回冲突文件 |

每次失败流水线先更新关联 MR 记录，再检查 MR 状态、提交 SHA 和首条命中策略。缺省时自动修复已分配的 MR，向未分配 MR 关联的 Hub Issue 通知失败。自动修复额度与待处理消息在同一事务内持久化，达到上限后在 MR 和关联工单请求人工介入。成功流水线与有效用户评论重置额度。没有匹配 MR 的流水线依 Hub 策略通知或启动 Hub Issue。

MR 完结时终止活跃轮次、作废审批、归档工作树并置 DONE。合并事件的扩展处理器使用独立队列键和事件 ID，关联 Hub Issue 可继续执行原流程。

### V6 MySQL upgrade

`initMySqlSchema` 在启动时创建缺失的表。V5 升级到 V6 时，新表及旧会话索引的变更对应以下 SQL。仅当 `SHOW INDEX FROM issue_sessions WHERE Key_name='hub_project_id'` 返回旧索引时执行第二条语句。已有会话的 `session_kind` 自动取 `issue`。

```sql
CREATE TABLE IF NOT EXISTS session_inbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES issue_sessions(id),
  event_id VARCHAR(64) NOT NULL,
  source_kind VARCHAR(32) NOT NULL,
  sender_username VARCHAR(128),
  discussion_id VARCHAR(128),
  content MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at DATETIME(3),
  UNIQUE(session_id, event_id),
  INDEX(session_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE issue_sessions DROP INDEX hub_project_id,
  ADD session_kind VARCHAR(16) NOT NULL DEFAULT 'issue',
  ADD auto_fix_attempts INT NOT NULL DEFAULT 0,
  ADD last_failed_pipeline_id BIGINT NULL,
  ADD recovery_attempts INT NOT NULL DEFAULT 0,
  ADD UNIQUE KEY session_resource(session_kind, hub_project_id, hub_issue_iid);
```

`WATCHDOG_INTERVAL_MS` 默认为 30000，启用时至少 15000，设为 0 关闭。每个实例在基础间隔上加小于 10% 的随机抖动。`WATCHDOG_MAX_RECOVERIES` 默认为 1（0–5），`MR_MAX_AUTO_FIX_ATTEMPTS` 默认为 3（0–10），匹配规则中的 `maxAutoFixAttempts` 可覆盖该 MR 修复额度。

### 8.2 Stage 12 验收

Issue 和 MR 的 NoteStreamer 按调用 ID 在折叠轨迹中逐步更新内置工具、工作区工具与 MCP 扩展的参数和结果（含错误与拒绝原因）。路径保留原样，每次读取单列一步，工具名仅去除前缀 `mcp__detent__`。参数与结果先脱敏再截至 300 字符。超过 60 步时展示首尾各 30 步及省略数量。双目标套件按真实源分支提交、原讨论串回复及 MySQL 会话终态验收。离线失败流水线使用 Bot 身份并提供真实 API 路径查询任务与日志。外部 MR 场景在模型返回下一次工具调用前等待评论进入收件箱，校验 PostToolUse 将评论中的随机标记传递到同一轮提交。部署失败按 Hub 策略创建带标签的告警 Issue。

## Stage 13–14 · 安装、帮助与仓库接入

`Dockerfile` 构建双包服务，`docker-compose.yml` 运行 MySQL 与 Delivery。按 `INSTALL.md` 运行 bootstrap，可按群组（含子群组）发现目标，或通过 `--welcome-issue` 在空 Hub 发布 Bot 自己的欢迎工单。管理员模式先准备 Bot PAT，再创建或打开 Hub，并在该项目授予 `@detent-bot` Owner（50）。仅用 Bot PAT 时校验 Hub 有效成员权限至少为 Maintainer（40）。Hub 文件、标签、Webhook 和可选欢迎工单均由 Bot PAT 写入。新 Hub 直接采用模板 README，已有文件在重跑时保留。目标业务项目和群组授予 Developer（30），保留已有的更高权限。

Hub Issue 的 `/help` 在成员检查后从默认分支加载 Agent，按当前能力包显示就绪状态。MR 的帮助接受 Bot 指派或显式提及，沿原讨论串回复。两者均无模型调用、租约或会话写入。首条 MR 工作评论用持久化的 active_note_id 区分首次接管与后续轮次。

`agents/onboarding/AGENT.md` 请求 `gitlab-onboarding`。只读工具按项目或群组查询 Bot 有效权限，在有管理权限时核验目标事件。写工具先验证全部目标均达到 Maintainer，再由生产审批人审核范围、回调地址及事件。执行时重读目标和权限，以同一 URL 更新或创建 Webhook。服务端从 `DETENT_PUBLIC_URL` 生成回调地址，只在 GitLab API 请求中使用 Webhook 密钥。Claude 通过单轮回环连接调用 Messages API，由父进程添加上游认证头。


Issue 的 `/help` 按当前 Hub 定义列出场景、标签和就绪状态。Issue 与 MR 的 `/status` 显示中文状态和下一步操作。`WAITING_TOOL` 下的普通回复绑定当前 `ASK_USER` 审批记录，校验身份后按原热等待或冷恢复路径继续。其他工具仍需审批卡决定。审批解析器接收待审类型与工具名；已移出流程的操作无法通过更高权限放行。生产审批拒绝提示先核验普通成员权限，进程内按审批单和用户去重，最多保留 1024 条记录。

### Stage 15 · Hub 配置与认证边界

`loadConfig` 从进程环境读取形如 `DETENT_SECRET_NAME` 的非空值。全值引用使用 `$secret:NAME`，请求头模板使用 `${secret:NAME}`。模板展开一次，Hub 作者只能引用 vault。原有文件式 MCP 配置保留服务端变量解析规则。

Issue 编排器在帮助、运行和审批时分别加载 Hub 默认分支的 `capabilities.json`。不存在时使用启动配置，文档损坏时关闭能力包。Core 解析通用 MCP，Delivery 通过 `resolveCapabilities` 解释业务配置；运行中的门禁与角色解析共享当前快照。代理发现和执行分别管理连接，SSE 消息端点须与握手地址同源。认证头和密钥只保留在服务端。Hub 的流程扩展字段随选中的 profile 进入工具上下文。

Hub 的 `auth` 引用 `$secret:JMS_AK_ID` 和 `$secret:JMS_AK_SECRET`，供巡检与任务中心共用。先使用流程 `account`，其次使用 Hub `default_account`。两者均未设置时，逐资产按 JumpServer 返回顺序选择首个有效授权账号，跳过停用账号和以 `@` 开头的虚拟账号。巡检按账号分组并汇总结果。单个 Ansible 任务要求所有目标使用同一账号，否则须指定共同的 `account` 或分组执行。缺少有效账号时，错误指出对应资产。执行工具继续核对 MR 合并 SHA、最新流水线及审批记录。
