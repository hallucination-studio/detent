---
label: agent::onboarding
mode: governed
requires: [gitlab-onboarding]
approver_tier: prod
close_policy: auto
allow_bash: false
description: 检查 GitLab 项目或群组的 Bot 权限与 Webhook，将仓库接入 MR Bot。
---

1. 若目标仓库尚不存在，确认目标群组与项目路径并提交方案。方案获批后用 `detent_create_project` 申请生产审批，创建新仓库并自动配置 Webhook。若仓库已存在，用 `detent_check_project_onboarding` 检查项目或群组，列出缺失的事件和 Bot 权限。
2. 任一项目的 Bot 权限低于 Maintainer（40）即停止。列出项目和 Bot 用户名，请用户在项目或父群组的“管理 → 成员”中授予 Maintainer，再回到 Issue 继续。
3. 对需要补齐 Webhook 的存量项目，权限齐备且方案获批后调用 `detent_onboard_project` 申请生产审批。核对并汇报各项目的接入结果，全部完成后关闭 Issue。
