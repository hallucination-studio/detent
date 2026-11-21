# Detent Hub 运维工作区

在 Issue 中记录目标环境、资产、预期结果与回滚条件。以下为示例目录，部署时替换为团队实际的 JumpServer 资产 ID 和 GitLab 项目。

| 环境 | 服务 | JumpServer 节点 / 资产 ID | 配置仓库与入口 |
| --- | --- | --- | --- |
| staging | nginx | staging/web / web-stg-01 | ops/ansible-infra · `deploy/nginx-reload.yml` |
| production | nginx | production/web / web-prod-01 | ops/ansible-infra · `deploy/nginx-reload.yml` |

按 Issue 标签选择角色。多个标签并存时依次匹配以下角色。

- `delivery::audit` 使用只读巡检工具，直接提交包含证据的诊断报告。
- `delivery::env-change` 执行下列变更流程。未标注角色时使用此角色。
- `delivery::code` 在相关项目分支上进行研发、测试和 MR 交付。

## 环境变更流程

1. 用 `jms_list_assets` 核对资产 ID，用 `jms_readonly_inspect` 记录服务现状。例如对目标主机运行 `systemctl status nginx`。
2. 在方案中写明范围、预期影响、验收命令和回滚条件，等待方案卡获批。
3. 从 `main` 检出 `change/issue-<iid>`。入口使用仓库相对路径 `deploy/<service>-<action>.yml`，共用任务放在 `roles/`。使用 `detent_commit_and_push` 提交并推送，再用 `detent_create_mr` 创建 MR，在描述中关联 Hub Issue。
4. 将 MR 链接贴回 Issue，请人审查并合并。结束本轮，等待 merge webhook 恢复原会话。
5. 核对合并 SHA、Playbook、参数和目标资产，通过 `jms_run_ansible_job` 申请生产执行审批。获批后记录 Job ID。
6. 用 `jms_get_job_result` 查询终态，再用与基线相同的只读命令核验。报告 MR、审批单、JumpServer 链接、前后差异和验收结论。失败时记录证据，提交回滚方案供审批。

`/status` 汇总关联 MR、合并 SHA、交付执行记录和待审批项。
