---
name: env-topology
description: 单环境变更、晋级与回退的共同步骤，环境落点、交接人及晋级条件
---

## 单环境变更

发布方案从下方矩阵引用环境、交接人和晋级条件。方案获批后，正向晋级、日常变更和回退都按以下清单逐环境实施。

1. 核对当前配置、运行版本和授权资产，记录验收条件、上一稳定 Tag 及其证据。按已批准方案只改目标环境的配置。使用同一 Chart 调整镜像时，在该环境的 values 文件中设置镜像 Tag，沿用 Chart 版本。独立回退工单只处理所请求的环境。
2. 按 Helm 或 Ansible 规范离线校验，提交独立环境 MR，链接工单、目标版本和验证结果。等待对应负责人审查、合并。
3. 取得合并事件的完整 SHA。使用 JumpServer 时，通过 `jms_job` 提交环境、资产和作业参数。系统在批准后直接提交作业并发布任务链接，终态回调后继续核验。使用 CI 部署时，按约定 ref 或 ID 调用 `detent_await_pipeline`，已登记异步回调时结束本轮。
4. 回调后核验目标版本、作业状态及服务健康，记录链接和证据。需要晋级时再执行本环境的 `promotion_gate`。发布中途失败时停止晋级，保持发布工单打开，用本节动作提交故障环境的回退 MR、执行恢复并核验。以回退为目标的独立工单在恢复验收通过后按其关单策略收尾。

## 默认环境矩阵

按 `dev → pre → prod` 推进工单指定的环境。配置仓以实际使用的 Helm 或 Ansible 落点为准。

| 环境 | Helm 值文件 / Ansible 清单 | JumpServer 节点 / 标签 | MR 合并与执行放行 | promotion_gate |
| --- | --- | --- | --- | --- |
| dev | `values-dev.yaml` / `inventories/dev/` | `/DEFAULT/dev` / `env:dev` | 服务 Owner | 无附加检查 |
| pre | `values-pre.yaml` / `inventories/pre/` | `/DEFAULT/pre` / `env:pre` | 服务 Owner | 无附加检查 |
| prod | `values-prod.yaml` / `inventories/prod/` | `/DEFAULT/prod` / `env:prod` | 平台负责人 | 无附加检查 |

进入 prod 前在工单用 GitLab 原生 `@用户名` 交接平台负责人，附 Tag、上一环境与晋级检查证据、prod MR 链接。配置仓可用 `.gitlab/CODEOWNERS` 指定生产配置审查人。

<!-- 启用跨仓 E2E 时只改本文件。将 pre 的 promotion_gate 替换为：
pre 健康核验通过后调用 detent_trigger_pipeline({ project: "qa/platform-e2e", ref: "main", variables: { RELEASE_TAG: "<本次 Tag>" } })。
返回 asyncCallback 时结束本轮；终态 success 才交接 prod，其他终态按上文回退 pre。 -->

在 Hub 的 `capabilities.json` 中给 `jumpserver` 添加以下字段即可启用环境硬守卫。节点、标签、资产 ID、名称或地址按实际授权范围填写，每台资产至少命中本环境的一条规则。

```json
{
  "environments": {
    "dev":  { "match": ["/DEFAULT/dev", "label:env:dev"], "approver_tier": "standard" },
    "pre":  { "match": ["/DEFAULT/pre", "label:env:pre"], "approver_tier": "standard" },
    "prod": { "match": ["/DEFAULT/prod", "label:env:prod"], "approver_tier": "prod" }
  }
}
```
