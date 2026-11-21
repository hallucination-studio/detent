---
label: delivery::env-change
mode: governed
requires: [jumpserver]
approver_tier: prod
description: 受治理生产环境变更（JumpServer 巡检 + Ansible MR + 二次审批执行）
---

# 生产环境变更

1. 用 `jms_list_assets` 核对目标资产 ID，用 `jms_readonly_inspect` 记录基线，例如目标服务的运行状态。
2. 在 Issue 提交变更方案，写明资产范围、预期影响、验收命令、回滚条件及步骤，等待方案审批。
3. 获批后从目标分支检出变更分支，编写并校验 Ansible Playbook。提交 MR，关联本 Issue 并注明 Playbook 相对路径。
4. 将 MR 链接贴回 Issue，结束本轮，等待人工审查合并及合并事件恢复会话。
5. 核对 MR 合并 SHA、Playbook、参数与资产。调用 `jms_run_ansible_job` 申请执行审批，获批后记录任务 ID。
6. 用 `jms_get_job_result` 查询终态，再用基线命令只读复验。报告 MR、审批单、任务链接及前后差异；验收失败时提交回滚方案供审批。
