---
label: delivery::release
mode: governed
requires: [gitlab-release]
uses: ["*"]
approver_tier: standard
allow_bash: true
close_policy: auto
shared_skills: [env-topology, gitlab-mr-conventions, ansible-conventions, helm-conventions]
description: 服务定版、部署至 dev/pre、验收与生产工单交接
---

# 仓库发版

## 提交方案

方案阶段从工单取仓库、目标版本、提交 SHA、上一稳定版本。用应用仓库路径查询 Tag 基线。涉及部署时读取 `skills/env-topology/SKILL.md` 的生效矩阵，交接人取系统提示中的负责人索引。

仓库、目标和落点明确后，立即调用 `detent_submit_plan` 提交发布、验收、回退步骤，结束本轮。工单给定的完整 SHA 直接入方案。仓库检出、Chart 文件检查、CI 与主机核验在方案获批后执行。缺少影响发布范围的信息时只补查该项；首次发版写明恢复方式。

## 实施已批准的发布

1. 锁定应用目标分支完整 40 位 SHA，复核必要的代码 MR 已合并及 CI 结果。目标 Tag 已存在时核对完整 SHA，相同则复用，冲突则停下报告。缺失时调用 `detent_create_release` 申请打 Tag 或创建 Release，核对指向与链接。
2. 创建版本成功后，在同一轮按工单范围继续。仅发布版本时，核实 Tag、SHA 及所需的 Release 后调用 `detent_close_issue`。镜像就绪后完成首个环境的配置、校验并提交 MR。若该环境由你负责，本轮调用 `detent_merge_mr` 并用返回的合并 SHA 提交部署；人类负责时 @负责人交接。若产物尚在构建，用 `detent_await_pipeline` 登记等待，收到 `asyncCallback` 后结束本轮，成功回调后继续。
3. 服务单最多部署到 pre。按矩阵对请求范围内的 dev/pre 逐环境执行准入、独立 MR、部署、健康核验与 `promotion_gate`（如 E2E），生产变更由另一张环境单承接。
4. 环境部署、核验或晋级检查失败，立即阻断后续晋级，保持工单打开。复用同一单环境动作，把故障环境回退到方案锁定的上一稳定 Tag，汇报恢复证据，等待人工决定后续处理。
5. 仅发布服务时，最后一个目标环境及其晋级检查通过后，汇总证据并调用 `detent_close_issue`。如工单明确要求继续上 prod（含 Bugfix），pre 及约定 E2E 全部通过后调用 `detent_create_hub_issue` 派生一张标签为 `delivery::env-change` 的生产单。正文写明服务、配置仓、Tag、完整应用 SHA、pre MR/作业及 E2E 实测证据，并 @已配置的 prod 负责人。将新工单链接贴回本单并关单。
