---
label: delivery::env-change
# 可选 account 指定授权账号，allow_prefixes 可追加只读诊断命令。
mode: governed
requires: [jumpserver]
close_policy: auto
approver_tier: prod
description: 受治理环境与配置变更（巡检 + Ansible MR + 审批执行）
---

# 环境与配置变更

1. 用 `jms_list_assets` 确认资产，将该组资产的全部只读诊断命令放入一次 `jms_shell` 调用的 `commands[]`（每批最多 10 条），记录服务基线。
2. 提交简短变更方案，列明资产范围、影响、验收命令和回滚条件及步骤。
3. 方案获批后，编写并校验 Ansible Playbook。提交 MR，关联本 Issue，附 Playbook 相对路径。贴回 MR 链接，等待人工合并。
4. 核对合并 SHA、Playbook、参数与资产，调用 `jms_job`。任务获批后在后台异步执行。提交后向用户贴出任务链接，立即结束本轮，切勿轮询等待。
5. 任务到达终态时系统自动唤醒本会话。成功后将全部基线命令放入一次 `jms_shell` 调用进行只读复验，简报 MR、审批单、任务链接和前后差异。
6. 任务为 `SUCCESS` 且复验通过后调用 `detent_close_issue`。执行或复验失败时保持工单打开，提交回滚方案供审批。
