---
name: helm-conventions
description: 约定 Helm Chart 的仓库布局、模板基线、版本管理、离线校验及发布后复验
---

团队可直接在 GitLab Hub 编辑本文件，自定义 Chart 布局、编码规范、校验命令和发布策略。

## 新建仓库默认布局（可改）

默认一仓一 Chart。根目录放 `Chart.yaml`（`apiVersion: v2`）、`values.yaml`、`values-<env>.yaml`（如 `values-prod.yaml`）和 `.helmignore`。公共模板放 `templates/_helpers.tpl`，按资源拆分 `templates/deployment.yaml`、`templates/service.yaml`、`templates/configmap.yaml`、`templates/ingress.yaml` 等文件。使用说明放 `templates/NOTES.txt`。

## 新建 Chart 的 Kubernetes 基线

- 将镜像拆分为 `image.repository` 与不可变的 `image.tag`，禁止使用裸 `latest`。为工作负载配置 `resources.requests`、`resources.limits`、`livenessProbe` 及 `readinessProbe`。
- 在 `_helpers.tpl` 统一维护 `app.kubernetes.io/*` 标签。`selector.matchLabels` 仅引用不可变的 `selectorLabels`，禁止包含版本标签。确保 Pod 模板携带相同的选择标签。
- 渲染嵌套值时使用 `toYaml | nindent` 并核对缩进。严禁将明文密钥写入 `values*.yaml`。

## 存量 Chart 最小修改

沿用既有布局，严禁修改已有工作负载的不可变 `selector.matchLabels`。未明确要求时禁止编造探针路径或资源 Limit。仅在修改 `templates/` 时递增 `Chart.yaml` 的 version。纯 `values-<env>.yaml` 镜像 Tag 晋级、回退或调参保留现有 Chart 版本。

## 校验与发布

在 Chart 目录，仅对受影响环境各运行一次合并的离线校验，替换环境和 release 占位符。

```sh
helm lint . --strict -f values-<env>.yaml && helm template <release> . -f values-<env>.yaml >/dev/null
```

MR 合并后按 `env-topology` 提交 `jms_job(environment=..., command=...)`，使用对应 SHA、命名空间及环境值文件。默认命令如下，特殊集群以 Hub 的 `CLAUDE.md` 为准。

```sh
helm upgrade --install <release> . -f values-<env>.yaml -n <namespace> --create-namespace --atomic --wait --timeout 5m && helm status <release> -n <namespace>
```

提交后结束本轮。回调的发布状态和就绪证据满足验收条件时直接汇报，证据不足或生产验收另有要求时用 `jms_shell` 补检。
