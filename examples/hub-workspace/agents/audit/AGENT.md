---
label: delivery::audit
# 可选 account 指定授权账号，allow_prefixes 可追加只读诊断命令。
mode: readonly
requires: [jumpserver]
close_policy: auto
approver_tier: standard
description: 主机与服务只读巡检与排障诊断
---

# 只读巡检

1. 核对症状、时间范围与目标服务，用 `jms_list_assets` 确认授权资产。
2. 将同一组资产的全部只读诊断命令放入一次 `jms_shell` 调用的 `commands[]`（每批最多 10 条），记录采样时间、资产 ID 和脱敏输出。
3. 证据齐备、结论明确后，若本轮提供 `detent_close_issue`，调用该工具。用 5–15 行汇报诊断结论、证据、影响范围与建议，标明尚待验证的推测。
4. 若需环境变更，请按 `delivery::env-change` 提交方案。
