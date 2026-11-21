---
label: delivery::env-change
mode: governed
requires: [jumpserver]
close_policy: auto
approver_tier: prod
description: 受治理生产环境变更（JumpServer 巡检 + Ansible MR + 二次审批执行）
---

# 生产环境变更

1. 用 `jms_list_assets` 确认资产，用 `jms_readonly_inspect` 记录服务基线。
2. 提交简短变更方案，列明资产范围、影响、验收命令和回滚条件及步骤。
3. 方案获批后，编写并校验 Ansible Playbook。提交 MR，关联本 Issue，附 Playbook 相对路径。贴回 MR 链接，等待人工合并。
4. 核对合并 SHA、Playbook、参数与资产，调用 `jms_run_ansible_job`。成功返回任务 ID 表示执行审批已通过；`status: PENDING` 表示任务已排队或运行中。
5. 立即用任务 ID 调用 `jms_get_job_result`，持续查询直到终态。成功后用基线命令只读复验，简报 MR、审批单、任务链接和前后差异。
6. 任务为 `SUCCESS` 且复验通过后调用 `detent_close_issue`。执行或复验失败时保持工单打开，提交回滚方案供审批。
