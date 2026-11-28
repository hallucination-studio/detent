---
label: delivery::release
mode: governed
requires: [gitlab-release]
uses: ["*"]
approver_tier: standard
allow_bash: true
close_policy: auto
shared_skills: [env-topology, gitlab-mr-conventions, ansible-conventions, helm-conventions]
description: 打 Tag、按环境晋级并在失败时回退到上一稳定版本
---

# 仓库发版

## 提交方案

从工单直接取目标仓库、目标版本、给定的提交 SHA 和上一稳定版本。用目标仓库路径查询 Tag 基线；涉及环境时读取 `skills/env-topology/SKILL.md` 中对应的环境矩阵和交接人。首次发版没有旧 Tag 时写明恢复方式。

这些信息足以确定范围时，下一步就是调用 `detent_submit_plan`，列出发布、验收、回退步骤并结束本轮。工单给出的完整 SHA 可直接写入方案。把检出仓库、逐文件检查 Chart、资产与 CI 复核列在获批后的实施步骤中。只有缺少影响方案的必要信息时才补查该项。

## 实施已批准的发布

1. 在必要 MR 人工合并后，锁定目标分支完整 40 位 SHA，复核 CI。调用 `detent_create_release` 申请打 Tag 或创建 Release，核对 Tag 指向与链接。
2. 创建版本成功后，在同一轮按工单范围继续。仅发布版本时，核实 Tag、SHA 及所需的 Release 后调用 `detent_close_issue`。需要部署且镜像已就绪时，立即完成第一个环境的配置、校验并提交 MR，拿到 MR 链接后交给负责人。若部署依赖尚在构建的产物，用 `detent_await_pipeline` 登记等待，收到 `asyncCallback` 后结束本轮，成功回调后继续。
3. 依次对每个目标环境执行 `env-topology` 的单环境变更动作，每环境独立 MR。完成健康核验和该环境的 `promotion_gate` 后再推进。到 prod 时在工单 @平台负责人交接审查、合并和执行放行。
4. 环境部署、核验或晋级检查失败，立即阻断后续晋级，保持工单打开。复用同一单环境动作，把故障环境回退到方案锁定的上一稳定 Tag，汇报恢复证据，等待人工决定后续处理。
5. 全部约定目标通过后，汇总 Tag、MR、审批、流水线和健康证据，调用 `detent_close_issue`。
