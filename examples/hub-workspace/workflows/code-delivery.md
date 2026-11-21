---
label: delivery::code
mode: governed
requires: []
approver_tier: standard
allow_bash: true
description: 跨项目代码研发与 MR 交付
---

# 跨项目代码交付

1. 对照仓库目录梳理受影响项目、接口依赖与兼容要求。提交方案，注明各项目的验收用例和合并顺序。
2. 方案获批后，为各项目检出独立分支，实施修改并运行对应测试与跨项目验证。
3. 分别提交 MR，关联本 Issue 和依赖 MR。在 Issue 汇总测试结果、流水线链接、合并顺序及需要人工确认的事项。
