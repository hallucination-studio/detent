---
name: helm-conventions
description: 约定 Helm Chart 的仓库布局、模板基线、版本管理、离线校验及发布后复验
---

团队可直接在 GitLab Hub 编辑本文件，自定义 Chart 布局、编码规范、校验命令和发布策略。

## 新建仓库默认布局（可改）

默认一仓一 Chart。根目录放 `Chart.yaml`（`apiVersion: v2`）、`values.yaml`、`values-<env>.yaml`（如 `values-prod.yaml`）和 `.helmignore`。公共模板放 `templates/_helpers.tpl`，按资源拆分 `templates/deployment.yaml`、`templates/service.yaml`、`templates/configmap.yaml`、`templates/ingress.yaml` 等文件。使用说明放 `templates/NOTES.txt`。

## 存量仓库演进（最小触达 + 触达即重构）

沿用已有 Chart 路径，与任务无关的模板和文件保持原样。本次新增或直接修改的工作负载模板（如 `deployment.yaml`）必须满足下列 Kubernetes 基线，包括 `resources.requests`、`resources.limits`、`livenessProbe`、`readinessProbe` 和不可变的 `selector.matchLabels`。这些模板变更及其他 Chart 逻辑变更均须按 SemVer 递增 `Chart.yaml` 的 `version`。

## 模板与 Kubernetes 基线

- 将镜像拆分为 `image.repository` 与不可变的 `image.tag`，禁止使用裸 `latest`。为工作负载配置 `resources.requests`、`resources.limits`、`livenessProbe` 及 `readinessProbe`。
- 在 `_helpers.tpl` 统一维护 `app.kubernetes.io/*` 标签。`selector.matchLabels` 仅引用不可变的 `selectorLabels`，禁止包含版本标签。确保 Pod 模板携带相同的选择标签。
- 渲染嵌套值时使用 `toYaml | nindent` 并核对缩进。严禁将明文密钥写入 `values*.yaml`。

## 校验与执行（按已开通能力自适应，可改）

提交 MR 前，若沙箱有 Helm CLI，在 Chart 目录先运行离线 `helm lint . --strict` 和 `helm template <release> .`，再逐一带上各环境的 `-f values-<env>.yaml` 重跑两项检查。

若已启用 `jumpserver` 且任务要求部署或验证集群，待 MR 合并后，在授权发布机上用 `jms_job` 的 `command` 执行与任务范围相符的命令。部署时可使用以下命令，按目标环境替换占位符。作业从仓库根目录开始，存量 Chart 按实际路径调整。

```sh
helm lint . --strict -f values-<env>.yaml && helm upgrade --install <release> . -f values-<env>.yaml -n <namespace> --create-namespace
```

获批提交后贴回任务链接并结束本轮。终态回调唤醒后，用 `jms_shell` 执行 `helm status` 或 `kubectl get` 复验发布状态与资源就绪情况。若未启用 `jumpserver` 或仅要求交付代码，则在 MR 合并后汇报校验结果，完成交付。
