## 发版请求

- 目标仓库、分支与候选提交 SHA
- 上一稳定 Tag、当前生效版本与拟发布 Tag
- 关联 MR、Release Notes 与 Tag 构建流水线（如有）
- 目标环境、配置仓、发布时间与健康验收条件
- 各环境 promotion_gate、服务 Owner 与生产交接人 @用户名

<!-- 先审方案和锁定 SHA，再打 Tag。按 env-topology 逐环境提独立 MR、人工合并、执行并核验。
任一环境或晋级检查失败时，保持工单打开，按同一单环境流程回退故障环境到上一稳定 Tag。 -->

/label ~"delivery::release"
