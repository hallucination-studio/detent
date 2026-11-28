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

根目录放 `ansible.cfg`，用 `inventories/<env>/hosts.yml` 划分环境，在 `group_vars/` 维护组变量。顶层业务入口放在 `playbooks/<action>.yml`，可复用逻辑下沉到 `roles/<role_name>/`。默认目录约定为 `roles/<role_name>/{defaults,tasks,handlers,templates,files}/main.yml`。前三个目录的 `main.yml` 是 Ansible 自动加载的入口；后两个目录按任务引用的实际名称存放模板和静态文件。

## 存量仓库演进（最小触达 + 触达即重构）

保留既有 Playbook 入口，仅按上述规范重构本次新增或直接修改的逻辑。将涉及的内联任务提取到 `roles/<role_name>/`，从原入口调用该 Role，内置模块使用完整名称 `ansible.builtin.*`。与任务无关的文件保持原样。

## 代码与安全

- 通过 `jms_job` 执行时，JumpServer 注入的动态 inventory 仅包含本次获批的目标资产，统一归入内置 `all` 组。Playbook 应设置 `hosts: all`，避免因自定义组名无法匹配而跳过所选资产。
- 为每个 Play 和 Task 写明 `name`。内置模块使用完整名称 `ansible.builtin.*`。
- 优先使用声明式模块，如 `ansible.builtin.template`、`lineinfile`、`copy`、`file` 和 `service`。配置变化通过 `notify` 触发对应 handler。只读探测设置 `changed_when: false`。
- 仅对需要提权的任务设置 `become: true`。严禁提交明文凭据，敏感参数通过外部密钥注入或受保护的 `extra_vars` 提供。

## 校验与执行（按已开通能力自适应，可改）

提交 MR 前，仅使用本轮临时沙箱中已安装的工具。若已安装 `yamllint`，用它检查涉及的 YAML。若已安装 `ansible-playbook`，用 `ansible-playbook --syntax-check` 配合对应 inventory 检查入口。严禁在沙箱内安装软件包或创建虚拟环境（如使用 `pip` 安装依赖或用 `venv` 创建环境）。缺少某项工具时，注明该工具未安装，跳过对应检查并继续。记录实际执行的检查及结果。

若已启用 `jumpserver` 且任务要求落地变更，待 MR 合并后，核对合并 SHA、授权资产和参数，调用 `jms_job` 并传入仓库相对路径 `playbook_path`。获批提交后贴回任务链接并结束本轮。终态回调唤醒后，用 `jms_shell` 只读复验验收条件。其余情况仅交付 MR。
