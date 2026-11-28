---
name: ansible-conventions
description: 约定 Ansible 仓库布局、存量代码修改范围、语法检查及合并后的执行与复验
---

团队可直接在 GitLab Hub 编辑本文件，自定义仓库布局、编码规范、校验命令和执行策略。

## 目标主机选择机制（默认按 JumpServer 节点/标签，可改）

**默认策略（JumpServer 资产树与标签）**：先用 `jms_list_nodes` 查看获授权的业务和环境节点，再用 `jms_list_assets` 按 `node_id`、`labels` 或 `search` 定位活跃主机。严禁盲猜或跨环境混选。匹配为空时，在 Issue 中说明查询范围并请求确认。命中多个环境，或命中多台主机且工单范围不明确时，列出候选主机的主机名、IP、节点和标签，待确认后继续。

提交方案时列出拟变更主机的主机名、IP、所属节点及总台数。目标至少两台，且工单要求灰度或属于高风险生产变更时，可先对首台提交 `jms_job`。待作业成功并用 `jms_shell` 复验通过后，再用同一已合并 SHA 对剩余主机提交第二批 `jms_job`。

**自定义切换（如改用仓库 Inventory）**：团队可直接编辑本段，将选机来源改为仓库的 `inventories/<env>/hosts.yml`。解析目标主机名和 IP，与 `jms_list_assets` 返回的授权资产逐台精确核对。发现未授权或失配主机时，停止并在 Issue 汇报差异。

## 新建仓库默认布局（可改）

新建仓库时，每个可复用职责放在 `roles/<role>/tasks/main.yml`，同一次作业用 `playbooks/` 下的一个入口组合所需角色。其他团队可以直接引用其中一个角色。按实际角色路径配置 `ansible.cfg`，有可覆盖的默认参数时再加 `defaults/main.yml`。使用 JumpServer 时沿用其动态 inventory，团队维护自己的主机清单时再创建 `inventories/<env>/`。

## 存量仓库最小修改

尊重既有结构，只修改本次涉及的任务、变量或清单。变更与发版 MR 禁止夹带目录重构。已有内联任务可以原位修改。

## 代码与安全

- 通过 `jms_job` 执行时，JumpServer 注入的动态 inventory 仅包含本次获批的目标资产，统一归入内置 `all` 组。Playbook 应设置 `hosts: all`，避免因自定义组名无法匹配而跳过所选资产。
- 为每个 Play 和 Task 写明 `name`。内置模块使用完整名称 `ansible.builtin.*`。
- 优先使用声明式模块，如 `ansible.builtin.template`、`lineinfile`、`copy`、`file` 和 `service`。配置变化通过 `notify` 触发对应 handler。只读探测设置 `changed_when: false`。
- 按目标路径的实际属主和授权账号编写任务。仅在任务确需提权且该账号已有相应授权时设置 `become: true`。严禁提交明文凭据，敏感参数通过外部密钥注入或受保护的 `extra_vars` 提供。

## 校验与执行（按已开通能力自适应，可改）

YAML 采用两空格缩进，以 `---` 开头，以 LF 结束。在工作树根目录运行 `yamllint playbooks roles` 检查变更。遇到 `new-line-at-end-of-file` 时，直接用 `printf '\n' >> 文件路径` 给报告中的文件各补一个 LF。同一批修复和复查可以在一次 Bash 调用内完成。

```sh
cd projects/example-ansible && printf '\n' >> playbooks/site.yml && printf '\n' >> roles/example/tasks/main.yml && yamllint playbooks roles
```

用实际工作树和报错路径替换示例，检查通过后提交 MR。

合并后按 `env-topology` 执行，调用 `jms_job` 时传入已合并 SHA、环境、资产 ID 和仓库相对路径 `playbook_path`。终态回调后核对作业结果，用只读巡检补足目标配置或服务的生效证据。
