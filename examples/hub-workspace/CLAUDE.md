# 团队交付工作区

## 协作约定

- 按本轮能力索引用 Read 读取匹配的 `agents/<id>/AGENT.md`，按需查阅 `skills/` 中的 Ansible、Helm 和 MR 规范。
- 只读问答和巡检直接汇报证据。变更前用 `detent_submit_plan` 提交简明方案，等待用户在 GitLab 点 👍 批准。无标签工单保持开放。
- 开单时写明目标项目、范围、验收条件及风险。资产或分支有歧义时，先在 Issue 中确认。
- 用 `detent_list_projects` 查询目标仓库。任务需要新仓库时，用 `detent_create_project` 申请建仓并配置 Webhook。
- 已启用 JumpServer 时，用 `jms_list_assets` 确认授权资产，将同组资产的只读检查合并为一次 `jms_shell` 调用（每批最多 10 条）。任务要求执行时，在 MR 合并后调用 `jms_job`。获批提交后贴回链接并结束本轮，待终态唤醒后复验。
- 在各项目分支提交变更，MR 关联本 Issue，由项目负责人审查合并。
- 将测试、流水线、审批及交付结果链接贴回 Issue。日志摘要须脱敏。用 `/status` 查看关联 MR、执行记录与待审批项。

<!-- 如需补充团队环境拓扑或常用仓库说明，可在此填写 -->
