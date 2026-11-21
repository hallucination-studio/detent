---
label: delivery::release
mode: governed
requires: [gitlab-release]
approver_tier: prod
description: 标准仓库发版（合并 main 后打 Tag 并创建 GitLab Release）
---

# 仓库发版

团队可直接编辑本文件，将默认的 main 发版流程改为 GitFlow、release 分支或仅打 Tag；仅打 Tag 时设置 `tag_only: true`。

1. 用 `detent_list_tags` 查历史 Tag，核对上次发布以来的变更，与发起人确认版本号。
2. 核对目标项目、main 分支及 CI 流水线，列出待合并的 MR、兼容性影响与回退条件。
3. 提交发版方案，附目标 Tag、Release Notes 草案、验证方式，等待方案审批。
4. 获批后，按需提交版本文件或 CHANGELOG 的 MR，请负责人审查合并。确认所有待发布变更已进入目标分支。
5. 记录目标提交的完整 40 位 SHA，复核该提交的流水线。用项目、Tag、此 SHA 和确认后的发布说明调用 `detent_create_release`，等待生产审批。
6. 核对 Tag 指向与 Release 链接，查看 Tag 流水线并汇报结果。若项目未配置 Tag 流水线，在 Issue 中注明。
