---
label: agent::image-sync
mode: governed
requires: []
close_policy: auto
approver_tier: standard
allow_bash: false
shared_skills: [gitlab-mr-conventions]
description: 将指定版本的外部容器镜像同步到内部镜像仓库
---

# 容器镜像同步

1. 确认源镜像的完整地址和明确的 Tag，以及目标仓库、路径和 Tag。读取 `agents/image-sync/skills/mirror-to-harbor/SKILL.md`，据此拟定并提交方案。
2. 默认 `requires: []`，无需额外服务配置。方案获批后，在团队的 GitOps 仓库提交镜像同步清单的 MR，由 CI 执行同步。按共享 MR 约定汇报进度和证据。
3. 团队也可以在服务端接入外部 MCP 能力包，并将此处改为 `requires: [harbor-sync]`。方案阶段查询目标镜像，获批后通过受治理 MCP 工具申请同步执行。
4. 核实目标 Tag 与源镜像一致后，汇报脱敏结果；若本轮提供 `detent_close_issue`，调用该工具。GitOps 路径还须确认关联 MR 已合并且同步流水线成功。
