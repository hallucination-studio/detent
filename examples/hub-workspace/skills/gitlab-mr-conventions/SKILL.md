---
name: gitlab-mr-conventions
description: 关联跨库 MR、Hub Issue 和流水线，汇报脱敏的验收结果
---

# 跨库 MR 与验收报告

- 在每个 MR 描述中链接 Hub Issue，列出依赖的 MR 和合并顺序。将各项目的 MR 链接和待审事项贴回 Issue。
- 汇报已验证的测试、流水线和交付结果，并附对应链接。发布前移除凭证、带认证信息的 Git URL 及日志中的敏感内容。
