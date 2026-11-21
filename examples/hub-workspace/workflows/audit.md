---
label: delivery::audit
mode: readonly
requires: [jumpserver]
approver_tier: standard
description: 生产环境只读巡检与排障诊断
---

# 只读巡检

1. 在 Issue 中确认时间范围、症状及目标服务，用 `jms_list_assets` 确认授权资产。
2. 用 `jms_readonly_inspect` 执行允许的只读命令。记录采样时间、资产 ID 与脱敏输出，区分观察结果和待验证的推测。
3. 直接在 Issue 提交诊断报告，附证据、影响范围及建议。需要修改配置或重启服务时，另开环境变更单。
