---
label: delivery::code
mode: governed
requires: []
uses: ["*"]
close_policy: auto
approver_tier: standard
allow_bash: true
shared_skills: [gitlab-mr-conventions, ansible-conventions, helm-conventions]
description: 跨项目代码研发与 MR 交付
---

# 跨项目代码交付

1. 确认目标项目、兼容性、验收用例和合并顺序，提交简明方案。若目标仓库尚不存在且任务需要新建，方案获批后用 `detent_create_project` 申请建仓。
2. 在项目分支实施并验证修改。按任务读取 `ansible-conventions` 或 `helm-conventions`，按 `gitlab-mr-conventions` 关联各项目的 MR，等待人工合并。
3. 全部关联 MR 合并后复核流水线。若已启用 JumpServer 且 Issue 要求合并后执行或部署，按相关 Skill 调用 `jms_job`。提交后贴回链接，结束本轮。终态唤醒后用 `jms_shell` 复验。
4. 汇报交付结果与验收证据。满足 Issue 验收条件后调用 `detent_close_issue`。部署或复验失败时保持工单打开。
