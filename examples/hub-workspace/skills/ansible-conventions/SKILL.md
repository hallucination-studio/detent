---
name: ansible-conventions
description: 约定 Ansible 仓库布局、存量代码修改范围、语法检查及合并后的执行与复验
---

团队可直接在 GitLab Hub 编辑本文件，自定义仓库布局、编码规范、校验命令和执行策略。

## 新建仓库默认布局（可改）

根目录放 `ansible.cfg`，用 `inventories/<env>/hosts.yml` 划分环境，在 `group_vars/` 维护组变量。顶层业务入口放在 `playbooks/<action>.yml`，可复用逻辑下沉到 `roles/<role_name>/`。默认目录约定为 `roles/<role_name>/{defaults,tasks,handlers,templates,files}/main.yml`。前三个目录的 `main.yml` 是 Ansible 自动加载的入口；后两个目录按任务引用的实际名称存放模板和静态文件。

## 存量仓库演进（最小触达 + 触达即重构）

保留既有 Playbook 入口，仅按上述规范重构本次新增或直接修改的逻辑。将涉及的内联任务提取到 `roles/<role_name>/`，从原入口调用该 Role，内置模块使用完整名称 `ansible.builtin.*`。与任务无关的文件保持原样。

## 代码与安全

- 为每个 Play 和 Task 写明 `name`。内置模块使用完整名称 `ansible.builtin.*`。
- 优先使用声明式模块，如 `ansible.builtin.template`、`lineinfile`、`copy`、`file` 和 `service`。配置变化通过 `notify` 触发对应 handler。只读探测设置 `changed_when: false`。
- 仅对需要提权的任务设置 `become: true`。严禁提交明文凭据，敏感参数通过外部密钥注入或受保护的 `extra_vars` 提供。

## 校验与执行（按已开通能力自适应，可改）

提交 MR 前，在本地沙箱用可用的 `yamllint` 检查涉及的 YAML，用 `ansible-playbook --syntax-check` 配合对应 inventory 检查入口。记录实际执行的检查及结果。

若已启用 `jumpserver` 且任务要求落地变更，待 MR 合并后，核对合并 SHA、授权资产和参数，调用 `jms_job` 并传入仓库相对路径 `playbook_path`。获批提交后贴回任务链接并结束本轮。终态回调唤醒后，用 `jms_shell` 只读复验验收条件。其余情况仅交付 MR。
