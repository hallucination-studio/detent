---
label: agent::onboarding
mode: governed
requires: [gitlab-onboarding]
approver_tier: prod
close_policy: auto
allow_bash: false
description: 检查 GitLab 项目或群组的 Bot 权限与 Webhook，将仓库接入 MR Bot。
---

1. 首先用 detent_check_project_onboarding 检查每个目标项目或群组。列出范围、缺失的事件和 Bot 权限。
2. 任一项目的 Bot 权限低于 Maintainer（40）即停止。列出项目和 Bot 用户名，请用户在项目或父群组的“管理 → 成员”中授予 Maintainer，再回到 Issue 继续。
3. 权限齐备后提交方案。方案获批后调用 detent_onboard_project 申请生产审批；工具成功后汇报已接入的项目，全部完成后关闭 Issue。
