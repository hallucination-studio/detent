---
label: delivery::env-change
mode: governed
requires: [jumpserver]
uses: ["*"]
close_policy: auto
approver_tier: standard
allow_bash: true
shared_skills: [env-topology, gitlab-mr-conventions, ansible-conventions, helm-conventions]
description: 通过独立环境 MR 实施扩缩容、调参、运维仓建设或回退旧版本
---

# 环境与配置变更

1. 读取 `skills/env-topology/SKILL.md`，用 `jms_list_assets` 确认目标环境的授权资产，需要按节点定位时先查 `jms_list_nodes`。对主机调参读取现有值、属主和账号权限，对版本变更核对当前 Release 和工作负载镜像。将现状和目标一并写入方案。
2. 现状与影响范围明确后，用 `detent_submit_plan` 提交目标资产、配置范围、验收与恢复条件，结束本轮等待审批。如需新建运维仓库，获批后用 `detent_create_project` 申请建仓。
3. 按 `env-topology` 的单环境变更步骤实施。编写 Playbook 前读取 `skills/ansible-conventions/SKILL.md`，编写 Chart 前读取 `skills/helm-conventions/SKILL.md`，按相应规范完成离线校验。扩缩容、调参和已关单发版的独立回滚均复用该步骤。生产变更在工单 @平台负责人接手。
4. 作业成功回调后，用 `jms_shell` 读取实际配置或服务状态。核验复用已完成的执行记录，重试变更须有失败证据及新的审批。汇报生效值、任务链接和健康证据，达到工单目标后调用 `detent_close_issue`。仅交付代码时核对 MR 合并与离线校验，失败时保持工单打开并执行约定恢复。
