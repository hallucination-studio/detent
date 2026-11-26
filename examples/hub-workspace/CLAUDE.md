# 团队交付工作区

在 Hub 创建 Issue 时可选用模板或添加 Agent 标签。`agents/<id>/AGENT.md` 定义职责、审批档位和能力依赖。Agent 按需读取自身 `agents/<id>/skills/` 下的 Skills 以及通过 `shared_skills` 引用的根目录 `skills/`。团队通过 MR 更新默认分支上的规范。

未匹配标签时，已启用的 Jev 会根据工单和用户补充信息自动路由，并写回所选 Agent 的标签。需求不明确时，Triage 会只读分析并在 Issue 中追问。直接回复补充信息，或用 `/use <agent>` 选择或切换 Agent。

## 仓库目录

以下路径与资产均为示例，启用前请替换为团队的实际值。

| GitLab 项目 | 默认分支 | 用途 |
| --- | --- | --- |
| apps/web | main | Web 服务、版本文件与 CHANGELOG |
| ops/ansible-infra | main | 环境配置、Playbook 与共用角色 |

## 环境与资产

| 环境 | 服务 | JumpServer 节点 / 资产 ID | 配置仓库与入口 |
| --- | --- | --- | --- |
| staging | nginx | staging/web / web-stg-01 | ops/ansible-infra · `deploy/nginx-reload.yml` |
| production | nginx | production/web / web-prod-01 | ops/ansible-infra · `deploy/nginx-reload.yml` |

## 协作约定

- 开单时写明目标项目、范围、验收条件及风险。资产或分支有歧义时，先在 Issue 中确认。
- 在各项目分支提交变更，MR 关联本 Issue，由项目负责人审查合并。
- 将测试、流水线、审批及交付结果链接贴回 Issue。日志摘要须脱敏。用 `/status` 查看关联 MR、执行记录与待审批项。
