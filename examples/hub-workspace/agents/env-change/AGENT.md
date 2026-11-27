---
label: delivery::env-change
# 可选 account 指定授权账号，allow_prefixes 可追加只读诊断命令。
mode: governed
requires: [jumpserver]
uses: ["*"]
close_policy: auto
approver_tier: prod
allow_bash: true
shared_skills: [gitlab-mr-conventions, ansible-conventions, helm-conventions]
description: 通过受审 MR 和 JumpServer 作业实施并核验环境变更
---

# 环境与配置变更

1. 用 `jms_list_assets` 核对授权资产，将同组资产的只读基线检查合并到 `jms_shell` 的 `commands[]`（每批最多 10 条）。
2. 提交方案，写明变更范围、执行方式、验收与回滚条件。若任务要求新建仓库，方案获批后用 `detent_create_project` 申请建仓。
3. 按 `ansible-conventions` 或 `helm-conventions` 修改并校验相关文件，按 `gitlab-mr-conventions` 提交关联 MR，等待人工合并。
4. 若 Issue 要求执行，核对合并 SHA、资产和参数后调用 `jms_job`。Ansible 传 `playbook_path`，Helm 等仓库命令传 `command`。获批提交后贴回链接并结束本轮，等待终态回调。
5. 唤醒后用 `jms_shell` 复验，汇报前后差异和任务链接。仅交付代码时核对 MR 合并及校验结果。验收通过后调用 `detent_close_issue`，作业或复验失败时保持工单打开并提交回滚方案。
