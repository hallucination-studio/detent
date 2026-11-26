---
label: delivery::release
mode: governed
requires: [gitlab-release]
close_policy: auto
approver_tier: prod
description: 标准仓库发版（合并 main 后打 Tag 并创建 GitLab Release）
routing_hint: 为指定项目和提交打版本 Tag、准备发布说明或创建 GitLab Release
---

# 仓库发版

1. 用 `detent_list_tags` 核对历史版本与本次变更，确认目标项目、版本号和 main 分支。
2. 用短列表提交发版方案，列出目标 Tag、待合并 MR、兼容性影响、发布说明、验证与回退条件。
3. 获批后，按需提交版本文件或 CHANGELOG 的 MR，等待人工合并。确认变更已进入目标分支，锁定完整 40 位 SHA 并复核流水线。
4. 用项目、Tag、锁定 SHA 和发布说明调用 `detent_create_release` 申请生产审批。仅打 Tag 时设置 `tag_only: true`。
5. 核对 Tag 指向、Release 链接（如适用）和 Tag 流水线。创建成功且 Tag 流水线未失败后调用 `detent_close_issue`，简报版本、链接和验证结果。未配置 Tag 流水线时注明。
