# 在 GitLab 中使用 Detent

**发起任务**　在本仓库新建 Issue，选择代码交付、环境变更、发版或巡检模板，也可以直接描述目标仓库、要完成的工作和验收条件。Bot 会在同一张工单中回复。

**处理 MR**　在已接入的项目中，把打开的 MR 分配给 `@detent-bot`，或在讨论串中提及 `@detent-bot` 并说明任务。移出 Assignee 即可交回人工。

**审批**　在对应的方案或工具审批卡上点 👍 批准、👎 拒绝。生产工具需要生产审批人确认。

| 工单指令 | 用途 |
| --- | --- |
| `/help`、`/status` | 查看 Agent 与指令、查询进度 |
| `/plan`、`/abort` | 先审方案、中止当前轮次 |
| `/reset`、`/use <agent>` | 重置对话、切换 Agent |

**接入新仓库**　新建 Hub Issue，选择 `onboarding` 模板或添加 `agent::onboarding` 标签，填写项目或群组路径。请先授予 Bot 目标仓库的 Maintainer 权限。生产审批人确认后，Bot 会配置 Webhook。
