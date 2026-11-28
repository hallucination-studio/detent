---
name: env-topology
description: 单环境变更、晋级与回退的共同步骤，环境落点、交接人及晋级条件
---

## 单环境变更

发布方案从当前环境矩阵读取顺序、落点和晋级条件。负责人直接取系统提示中的实时索引，它来自 Hub `capabilities.json` 的 `jumpserver.environments.<env>.owner`。未配置 owner 时沿用原审批等级与人工交接。方案获批后，正向晋级、日常变更和回退都按以下清单逐环境实施。

1. 核对当前配置、运行版本和授权资产，记录验收条件、上一稳定 Tag 及其证据。按已批准方案只改目标环境的配置。使用同一 Chart 调整镜像时，在该环境的 values 文件中设置镜像 Tag，沿用 Chart 版本。独立回退工单只处理所请求的环境。
2. 按 Helm 或 Ansible 规范离线校验，提交独立环境 MR，链接工单、目标版本和验证结果。Bot 负责的非生产环境在本轮调用 `detent_merge_mr`，传入目标环境并使用返回的完整合并 SHA 继续部署。人类负责时在工单 @对应负责人，等待其审查合并。
3. 取得合并事件的完整 SHA。使用 JumpServer 时，通过 `jms_job` 提交环境、资产和作业参数。Bot 负责的环境由 Bot 对原卡点 👍，人类负责的环境由卡片点名的负责人点 👍。系统按批准的原参数直接提交作业并发布任务链接，终态回调后继续核验。使用 CI 部署时，按约定 ref 或 ID 调用 `detent_await_pipeline`，已登记异步回调时结束本轮。
4. 回调后核验目标版本、作业状态及服务健康，记录链接和证据。需要晋级时再执行本环境的 `promotion_gate`。发布中途失败时停止晋级，保持发布工单打开，用本节动作提交故障环境的回退 MR、执行恢复并核验。以回退为目标的独立工单在恢复验收通过后按其关单策略收尾。

## 前置环境严格准入与强批（Break-Glass）

正向晋级到非首个环境前，按当前矩阵找到直接前置环境（默认 pre 查 dev、prod 查 pre）。在提目标环境 MR 前，逐个比对目标 Tag、前置环境配置和实时运行镜像，核实可用副本、服务健康与已约定的晋级检查。整环境发布先对比两侧配置列出全部差异服务，再逐服务全量核查。

任一待发服务未就绪、版本不同、被回退、异常或缺少核验证据，整单阻断。保持工单打开，列出服务、期望值、实测值和失败检查，提示修复前置环境后回复“继续”重验，严禁创建目标环境 MR。仅当目标环境配置的人类负责人亲自在工单明确回复强行继续并给出原因，才可记录其 GitLab 用户名、原因与接受的风险，继续提交方案或实施已批方案。核对评论发送者；普通“继续”、方案获批、转述他人意见均不构成强批。Bot 负责的环境必须等前置环境恢复。独立回滚和紧急止血直接走目标环境的 MR 与执行审批。

## 默认环境矩阵

按 `dev → pre → prod` 推进工单指定的环境。配置仓以实际使用的 Helm 或 Ansible 落点为准。

| 环境 | Helm 值文件 / Ansible 清单 | JumpServer 节点 / 标签 | promotion_gate |
| --- | --- | --- | --- |
| dev | `values-dev.yaml` / `inventories/dev/` | `/DEFAULT/dev` / `env:dev` | 无附加检查 |
| pre | `values-pre.yaml` / `inventories/pre/` | `/DEFAULT/pre` / `env:pre` | 无附加检查 |
| prod | `values-prod.yaml` / `inventories/prod/` | `/DEFAULT/prod` / `env:prod` | 无附加检查 |

进入 prod 前在工单用 GitLab 原生 `@用户名` 交接目标环境负责人，附 Tag、上一环境与晋级检查证据、prod MR 链接。配置仓可用 `.gitlab/CODEOWNERS` 指定生产配置审查人。

<!-- 启用跨仓 E2E 时只改本文件。将 pre 的 promotion_gate 替换为：
pre 健康核验通过后调用 detent_trigger_pipeline({ project: "qa/platform-e2e", ref: "main", variables: { RELEASE_TAG: "<本次 Tag>" } })。
返回 asyncCallback 时结束本轮；终态 success 才交接 prod，其他终态按上文回退 pre。 -->

在 Hub 的 `capabilities.json` 中给 `jumpserver` 添加以下字段即可启用环境硬守卫。节点、标签、资产 ID、名称或地址按实际授权范围填写，每台资产至少命中本环境的一条规则。

```json
{
  "environments": {
    "dev":  { "match": ["/DEFAULT/dev", "label:env:dev"], "approver_tier": "standard", "owner": "@detent-bot" },
    "pre":  { "match": ["/DEFAULT/pre", "label:env:pre"], "approver_tier": "standard", "owner": "@detent-bot" },
    "prod": { "match": ["/DEFAULT/prod", "label:env:prod"], "approver_tier": "prod", "owner": "@平台负责人" }
  }
}
```
