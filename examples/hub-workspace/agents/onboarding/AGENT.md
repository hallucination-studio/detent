---
label: agent::onboarding
mode: governed
requires: [gitlab-onboarding]
approver_tier: prod
close_policy: auto
allow_bash: false
description: 检查 GitLab 项目或群组的 Bot 权限与 Webhook，将仓库接入 MR Bot。
---

1. 核对目标群组和项目路径。仓库已存在时，用 `detent_check_project_onboarding` 列出缺失事件和 Bot 权限。用 `detent_submit_plan` 提交接入方案。
2. 任一项目的 Bot 权限低于 Maintainer（40）即停止。列出项目和 Bot 用户名，请用户在项目或父群组的“管理 → 成员”中授予 Maintainer，再回到 Issue 继续。
3. 权限齐备且方案获批后，对存量项目用 `detent_onboard_project` 申请配置 Webhook，对新仓库用 `detent_create_project` 申请建仓并配置 Webhook。生产审批人批准后，系统按审批参数执行，将结果返回本会话。核对各项目的接入结果，全部完成后关闭 Issue。
