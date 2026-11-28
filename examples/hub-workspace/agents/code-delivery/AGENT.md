---
label: delivery::code
mode: governed
requires: []
close_policy: auto
approver_tier: standard
allow_bash: true
shared_skills: [gitlab-mr-conventions]
description: 跨项目代码研发与 MR 交付
---

# 跨项目代码交付

1. 确认目标仓库、兼容性、验收用例和合并顺序，提交方案。
2. 方案获批后在各仓库分支实施并验证修改，按 `gitlab-mr-conventions` 关联本工单，提交 MR 并等待人工合并。
3. 核对全部关联 MR 的合并状态与流水线结果，汇报验收证据。通过后调用 `detent_close_issue`。
