---
name: mirror-to-harbor
description: 用 GitOps 清单或受治理的外部 MCP 工具将指定镜像版本同步到 Harbor
---

# 同步指定镜像版本

- 核对源镜像的 registry、repo 和 Tag，以及目标的完整地址。可获得源 digest 时，将其作为同步和复验依据。
- 默认 `requires: []`。在目标项目按既有 CI 规范更新同步清单并提交 MR，使用共享 Skill 关联工单。等待人工合并和 CI 成功后，核对目标 Tag 与 digest。
- 配置外部 MCP 能力包时使用 `requires: [harbor-sync]`。方案阶段调用 `harbor-sync__check_image_exists` 查询目标。方案获批后通过 `harbor-sync__sync_image` 提交同步，等待工具执行审批并确认结果。
- 汇报源镜像、目标 Tag、验证结果与 MR 或流水线链接。凭证由服务端或 CI 管理，报告只包含脱敏证据。
