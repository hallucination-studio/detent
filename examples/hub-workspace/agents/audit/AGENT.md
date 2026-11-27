---
label: delivery::audit
mode: readonly
requires: [jumpserver]
close_policy: auto
approver_tier: standard
description: 主机与服务只读巡检与排障诊断
routing_hint: 采集目标服务、主机或端口的状态与诊断证据，汇报影响范围
---

# 只读巡检

1. 核对症状、时间范围与目标服务，用 `jms_list_assets` 确认授权资产。
2. 用 `jms_readonly_inspect` 采集证据，记录采样时间、资产 ID 和脱敏输出。
3. 证据齐备、结论明确后，本轮直接调用 `detent_close_issue`。用 5–15 行汇报诊断结论、证据、影响范围与建议，标明尚待验证的推测。配置修改或服务重启另开环境变更单。
