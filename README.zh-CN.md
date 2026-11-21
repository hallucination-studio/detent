<div align="center">

# Detent

**基于 GitLab CE v18.3.0 的无状态多项目 Claude Code 底座与“受治理 AI 变更交付中枢”**

*Detent 取名自飞机油门杆上点火前的机械止动槽。在这个受治理 AI 变更交付中枢，生产变更同样需要人工确认才能执行。*

[![CI](https://github.com/hallucination-studio/detent/actions/workflows/ci.yml/badge.svg)](https://github.com/hallucination-studio/detent/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Architecture](https://img.shields.io/badge/pods-100%25%20stateless-0ea5e9)

[English](./README.md) | **简体中文**

[核心特性](#核心特性) • [系统架构](#系统架构概览) • [GitLab 接入指南](#gitlab-ce-v1830-接入配置指南) • [Issue 交互手册](#issue-内交互使用手册) • [环境配置](#环境配置与目录结构) • [设计文档](#相关文档)

</div>

---

Detent 采用 **双包分层架构**：
- **`@detent/core`（通用基础架构包）**：将一个配置的 GitLab **工作区仓库（Workspace Hub Repository）** 转化为 100% 无状态、纯增量 MySQL 持久化的 Claude Code 会话中枢，实现 **`1 个 GitLab Issue = 1 个 Claude Code Session`**，自由编排跨项目 `0..N` 个 Worktree 与 `0..N` 个 Merge Request，并内置双层审批与单评论流式刷新。
- **`@detent/delivery`（受治理 AI 变更交付中枢，V2 Stage 4 已实现）**：基于 `@detent/core` 扩展构建，面向生产环境与基础设施交付，打通 **GitLab Issue 变更工单 → JumpServer 只读账号巡检 → Ansible 脚本提 MR 人工合并自动续跑 → 执行前人工二次审批 → JumpServer 任务中心下发执行与三方审计留痕** 的合规交付闭环。

## 相关文档

- 👉 **双包架构与变更交付设计文档**：[`docs/DESIGN.md`](./docs/DESIGN.md)
- 👉 **V2 四阶段推进与验收计划**：[`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md)
- 👉 **AI Agent 架构红线与开发规范**：[`AGENT.md`](./AGENT.md)

---

## 核心特性

1. **`1 Issue = 1 Session`，跨项目 `1:N` 自由编排**
   - 配置一个 GitLab **工作区仓库**承载 Issue 会话（并存放全局 `CLAUDE.md`、项目目录规范与公共 Skills）。
   - **彻底解耦 Issue 与单一仓库/单一 MR**：在同一个 Issue Session 中，由 Claude Code 自主决定拉取哪几个 GitLab 业务仓库、创建几个 Worktree（`0..N`）、提交几个跨项目或同项目的 Merge Request（`0..N`），并支持联动 GitLab Pipeline。
2. **双层审批门禁（Dual-Layer Approval Gate）**
   - **宏观需求/方案审批（Plan Gate）**：新建 Issue 默认先进入只读 `plan` 模式探索代码并输出《实施方案审批卡》，人工在 Issue 中点 👍 或回复 `/approve` 后才进入编码执行。
   - **微观运行时工具审批（Hook Gate）**：对接 Claude Code `canUseTool`，编码阶段沙箱内常规文件读写与内置 `detent_*` 工作区工具自动放行，高危操作（如非白名单 `Bash` 命令、`AskUserQuestion`）实时向 Issue 投递【工具执行审批卡片】，支持点 👍/👎 或 `/approve`、`/reject` 控制。
3. **100% 无状态 Pod 架构（Stateless Pod，零 PVC / 零本地磁盘依赖）**
   - Pod 仅在单轮对话执行期使用 `/tmp/detent-sandboxes/turn-<uuid>` 临时沙箱（轮次结束即焚 `rm -rf`）。
   - 跨轮次、跨 Pod 负载均衡或容器重启时，自动从 **MySQL 增量消息表** 水合 Claude `.jsonl` 会话上下文，并从 **GitLab 远端分支 + MySQL `uncommitted_diff` 补丁** 秒级浅克隆还原多项目工作区。
4. **MySQL 纯增量存储（零写放大）**
   - 会话主表 `issue_sessions` 仅存百字节级轻量状态与分布式租约锁（`locked_by_pod`）。
   - 会话消息采用 `session_messages` **纯增量 Append-Only 批量追加（`INSERT IGNORE`）**，绝不覆写整份大字段 JSONL。
5. **单条评论节流流式刷新（防刷屏）**
   - 每轮执行只创建一条评论并通过 GitLab Edit Note API 节流刷新，使用 `<details>` 折叠工具调用链，并实时展示当前 Session 关联的活跃 Worktree 清单与多个 MR/Pipeline 状态。

---

## 系统架构概览

```mermaid
flowchart LR
    User(["研发人员"]) <-->|"提 Issue / 评论 / 点 👍 审批"| HubIssue["GitLab 工作区仓库 Issue"]
    HubIssue -->|"Webhooks (Issue/Note/Emoji)"| DetentPod["Detent 无状态 Pod 集群\n(单轮临时 /tmp 沙箱)"]
    DetentPod <-->|"增量消息 / 分支补丁 / 租约锁"| MySQL[("MySQL 8.0")]
    DetentPod <-->|"浅克隆 / Push / 创建多个 MR / 查 Pipeline"| TargetRepos["GitLab 多个业务项目仓库\n(Project A / B / C...)"]
```

---

## GitLab CE v18.3.0 接入配置指南

### 1. 准备“工作区仓库（Workspace Hub Repo）”
1. 在 GitLab CE v18.3.0 中创建一个专门用于承载研发会话的工作区仓库（例如 `ai/workspace-hub`），记录其 **Project ID**（填入环境变量 `GITLAB_HUB_PROJECT_ID`）。
2. 在该工作区仓库根目录下可维护全局 `CLAUDE.md`（例如说明团队有哪些业务仓库、各自的职责、分支命名规范与测试要求）以及 `.claude/` 自定义配置。

### 2. 创建 GitLab Bot 账号与 Token
1. 创建一个专用 Bot 账号（如 `@detent-bot`）或使用拥有多项目访问权限的 Personal/Group Access Token（勾选 `api`、`read_repository`、`write_repository` 权限）。
2. 将该 Bot 加入工作区仓库及需要修改的目标业务仓库（角色需至少为 `Developer`）。
3. Detent 启动时会自动调用 `GET /api/v4/user` 识别 Bot 自身 `user.id`，在 Webhook 入口自动过滤 Bot 自身发出的评论和编辑事件，**彻底杜绝无限自环**。

### 3. 配置 GitLab Project Webhooks
在 **工作区仓库** 的 `Settings -> Webhooks` 中添加 Webhook：
- **URL**: `http://<your-detent-service>/webhooks/gitlab`
- **Secret token**: 与 `.env` 中的 `GITLAB_WEBHOOK_SECRET` 保持一致
- **Trigger Events**:
  - ✅ **Issues events**（新建 Issue 自动启动 Claude Code Session，关闭 Issue 自动归档工作区）
  - ✅ **Comments (Note events)**（评论驱动多轮 `--resume` 对话与 `/approve`、`/reject` 等斜杠指令）
  - ✅ **Emoji events**（支持在审批卡片评论上点 👍 `thumbsup` 一键批准、点 👎 `thumbsdown` 一键拒绝）
- 环境变更交付还需在 Ansible 目标仓库启用 **Merge request events**，使用相同的 URL 和 Secret token。人工合并后，Detent 记录合并 SHA 并恢复对应 Issue 会话。
- *（可选，用于 Pipeline 联动）* 在目标业务仓库添加 Webhook，勾选 **Pipeline events** 指向同一地址，当关联 MR 的流水线状态变更时会自动同步回对应的工作区 Issue。

---

## Issue 内交互使用手册

### 完整工作流示例
1. **提出需求（新建 Issue）**：
   - 在工作区仓库创建 Issue `#42`：
     > **标题**：升级订单服务与网关的 JWT 鉴权协议到 v2  
     > **正文**：需要在 `backend/order-service` 增加 v2 验签接口，并同步修改 `infra/api-gateway` 的鉴权插件，完成后分别提 MR。
2. **审批实施方案（第一层审批）**：
   - Detent 自动打上 `claude::planning` 标签，Claude 分析代码后输出《实施方案审批卡片》，标签变为 `claude::waiting-approval`。
   - 您只需在该条方案评论下 **点一个 👍**（或评论 `/approve`），Claude 立即进入 `claude::coding` 模式；若方案不满意，直接评论修改意见即可让 Claude 重新调整方案。
3. **审批运行时高危工具（第二层 Hook 审批）**：
   - 编码过程中，Claude 常规读写文件自动放行；当执行非白名单 `Bash` 命令或向您提问时，Issue 下会弹出【工具执行审批卡片】。
   - 对该卡片 **点 👍**（或评论 `/approve`）即可放行继续；**点 👎**（或评论 `/reject <原因>`）则拒绝执行并将原因反馈给 Claude。
4. **跨项目多 MR 与多轮迭代**：
   - Claude 完成修改后会在 `backend/order-service` 和 `infra/api-gateway` 分别推送分支并创建 MR，将所有 MR 链接与 Pipeline 状态汇总在评论底部。
   - 在 Issue 关闭前，您可以随时继续评论（例如：*“帮我看下 `order-service!108` 的 pipeline 为什么失败了并修一下”*），Claude 会在同一 Session 中无缝续跑。

### 支持的评论指令速查

| 交互操作 | 说明 |
| :--- | :--- |
| **对审批评论点 👍** | 一键批准当前待审的《实施方案》或被 Hook 拦截的工具调用 |
| **对审批评论点 👎** | 一键拒绝当前被 Hook 拦截的工具调用 |
| `/approve [附加说明]` | 批准当前待审项，并可附带补充要求一同传给 Claude |
| `/reject <拒绝原因>` | 拒绝当前待审项，并将拒绝原因传给 Claude 重新规划 |
| `/plan [新需求说明]` | 将当前 Session 切换回只读 `plan` 模式重新输出技术方案 |
| `/status` | 查看当前 Session 绑定的活跃 Worktree、所有 MR、合并 SHA、交付执行审计链接及待审批状态 |
| `/abort` | 立即中止当前正在运行的一轮任务并释放租约锁 |
| `/reset` | 清空当前 Issue 的 Claude Session 历史，重新初始化会话 |
| **直接发送普通评论** | 作为新一轮 User Prompt 自动 `--resume` 当前 Claude Code Session |

---

## Webhook 队列

Webhook 返回 `202` 表示事件已进入当前进程的内存队列。正常关闭会等待队列处理完毕，进程异常退出可能丢失尚未处理完的事件。

## 质量门禁与 CI/CD（本地提交前检查 + OpenCodeReview + GitHub Actions / GitLab CI）

1. **本地提交前门禁（Pre-Commit Hook）**：
   - 运行 `npm install` 时会自动执行 `prepare` 脚本启用 [`.githooks/pre-commit`](./.githooks/pre-commit)（也可手动执行 `git config core.hooksPath .githooks`）。
   - 每次提交前自动运行 `npm run check`，串联执行 **TypeScript 类型检查 (`tsc --noEmit`) + 死代码与未用依赖检测 (`knip`) + 全部单元测试 (`vitest run`)**。
2. **推送前代码质量与架构红线审查（OpenCodeReview）**：
   - 仓库已内置 [`.opencodereview/rule.json`](./.opencodereview/rule.json)（开启 `merge_system_rule: true`，自动复用 OCR 内置的 TypeScript 代码质量、死代码、异步与安全规则，并叠加本项目的无状态 Pod 与 MySQL 纯增量架构红线）。
   - 推送前可让 AI Agent 按 [`AGENT.md`](./AGENT.md) 规范通过 **委托模式**（`ocr delegate preview` / `ocr delegate rule`）审查所有变更，或本地直接运行 `npm run review`。
3. **GitHub Actions CI**：
   - [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) 在每次向 `main` 分支推送或提交 Pull Request 时，于 Node.js 20 与 22 矩阵环境自动执行类型检查、死代码检测、单元测试、Workspaces 构建与 ESM 导出校验。
   - 若在 GitHub 仓库 Variables 中开启 `OCR_REVIEW_ENABLED=true` 并在 Secrets 中配置 `OCR_LLM_AUTH_TOKEN`，还会自动执行 PR 级 `ocr review`。
4. **GitLab CE v18.3.0 CI 兜底**：
   - [`.gitlab-ci.yml`](./.gitlab-ci.yml) 在每次 Merge Request 与 `main` 分支推送时自动运行 `npm run check && npm run build`；若在 GitLab CI Variables 中配置了 `OCR_LLM_AUTH_TOKEN`，还会自动执行 MR 级 `ocr review`。

---

## 环境配置与目录结构

### 环境变量
复制 [`.env.example`](./.env.example) 为 `.env` 并按需修改核心配置：
- `GITLAB_BASE_URL` / `GITLAB_TOKEN` / `GITLAB_WEBHOOK_SECRET` / `GITLAB_HUB_PROJECT_ID`
- `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`
- `ANTHROPIC_API_KEY` / `CLAUDE_MODEL`

### 启动交付服务

在服务环境中设置配置变量（本地可用 `set -a; . ./.env; set +a` 加载按示例填写的文件）。安装依赖后运行 `npm run build` 和 `npm run start:delivery`，开发时使用 `npm run dev:delivery`。启动时使用 Core 的 MySQL 连接池创建 `delivery_executions` 表。记录关联会话、已合并 MR、执行审批单和 JumpServer 任务，查询任务结果时更新状态、输出摘要和完成时间。

| 配置项 | 用途与默认值 |
| --- | --- |
| `JUMPSERVER_BASE_URL` / `JUMPSERVER_ORG_ID` | 服务地址启用 JumpServer 工具。组织 ID 可选。 |
| `JUMPSERVER_READONLY_TOKEN` 或 `JUMPSERVER_READONLY_ACCESS_KEY_ID` + `JUMPSERVER_READONLY_ACCESS_KEY_SECRET` | 资产查询和巡检凭证。 |
| `JUMPSERVER_JOB_TOKEN` 或 `JUMPSERVER_JOB_ACCESS_KEY_ID` + `JUMPSERVER_JOB_ACCESS_KEY_SECRET` | 独立的任务中心执行凭证。 |
| `JUMPSERVER_READONLY_ACCOUNT` / `JUMPSERVER_TIMEOUT_MS` | 巡检系统账号默认为 `readonly`，请求超时默认为 30000 毫秒。 |
| `JUMPSERVER_INSPECT_ALLOW_PREFIXES` | 逗号分隔的只读命令前缀，默认清单见 `.env.example`。命令参数仍须通过只读校验。 |
| `JUMPSERVER_BLOCKED_ASSETS` / `JUMPSERVER_BLOCK_FAILED_PIPELINE` | 禁用资产 ID 列表默认空。失败流水线默认阻止执行，可用 `false` 或 `0` 关闭。 |
| `DELIVERY_PROD_APPROVERS` | 逗号分隔的 GitLab 用户名，忽略大小写。配置名单时，生产审批人还须达到 Hub 项目的 `GITLAB_MIN_ACCESS_LEVEL`。 |
| `DELIVERY_PROD_MIN_ACCESS_LEVEL` | 名单为空时的生产审批门槛，默认 40（Maintainer）；方案审批沿用普通门槛，默认 30（Developer）。 |

交付服务在每轮和每次审批时读取 Hub Issue 标签。优先匹配 `delivery::audit`（只读诊断，完成后直接回到 IDLE），其次为 `delivery::env-change`（巡检、方案、Ansible MR、人工合并、二次审批和执行验收），然后为 `delivery::code`（标准多项目研发工具）。未标注角色时使用环境变更流程。可将 [Hub 工作区示例](./examples/hub-workspace/CLAUDE.md) 复制到 Hub 仓库根目录。

### 项目结构
```text
detent/
├── .github/workflows/ci.yml        # GitHub Actions CI（Node 20/22 校验 + 可选 OCR 审查）
├── .gitlab-ci.yml                  # GitLab CI 兜底流水线
├── docs/
│   ├── DESIGN.md                   # 完整系统架构、时序图与 MySQL 增量数据模型设计文档
│   └── IMPLEMENTATION_PLAN.md      # V2 四阶段实施与验收标准
├── AGENT.md                        # AI Agent 架构红线、现有代码基线与分阶段开发规范
├── README.md                       # 英文主文档（默认）
├── README.zh-CN.md                 # 中文文档
├── .env.example                    # 环境变量配置模板
├── package.json
├── tsconfig.json
└── packages/
    ├── core/
    │   ├── src/index.ts            # 公共 API 与扩展契约
    │   ├── src/server.ts           # 独立服务入口（根目录 npm start）
    │   └── tests/
    └── delivery/
        ├── src/index.ts            # createDeliveryApp 装配入口
        ├── src/server.ts           # npm run start:delivery
        └── tests/
```
