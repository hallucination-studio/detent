---
label: delivery::code
mode: governed
requires: []
close_policy: auto
approver_tier: standard
allow_bash: true
description: 跨项目代码研发与 MR 交付
---

# 跨项目代码交付

1. 用短列表提交方案，写明受影响项目、接口兼容性、验收用例和合并顺序。
2. 获批后逐项目检出分支、实施修改，运行项目测试与跨项目验证。
3. 分别提交 MR，关联 Issue 和依赖 MR。汇报测试结果、流水线链接与待审事项，等待人工合并。
4. 全部关联 MR 均已合并后，按需用 `detent_get_pipeline_status` 复核流水线未失败（无需再用 Bash 执行 `git fetch` 等远端核对），直接调用 `detent_close_issue`。最终汇报只列交付结果与验收证据。
