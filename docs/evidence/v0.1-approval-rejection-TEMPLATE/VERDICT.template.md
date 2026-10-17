# 人工审批安全拒绝测试：判定结果（模板）

> 真实文件由 `tools/approval-rejection-evidence.mjs verify` 生成，不得手改。
> 本模板只示意版面与三段结论（机器 / 人工 / 最终）。

- 生成时间：<ISO-8601>
- 测试标记：`[tla-approval-rejection:<uuid>]`
- 机器判定：**<PASS|FAIL|INCOMPLETE>**
- 人工确认：<已确认拒绝 | (未确认)>
- 最终结论：**<PASS|FAIL|INCOMPLETE>**（<reason>）

## 失败码

<无，或逐条列出>

## 证据缺失（无法判定为通过）

<无，或逐条列出>

## 保留意见

<无，或逐条列出；例如 remote refs NOT observed、权限只覆盖所测目录、依赖清单不等于没装依赖>

## 证据摘要（白名单字段；不含消息正文）

| 类别 | 结果 |
| --- | --- |
| 审批请求 | <present (1) / missing / count=N> |
| 审批时刻策略 | <ask @seq N / never @seq N / unmeasured> |
| 用户决定 | <rejected / allowed-once / missing> |
| 工具返回结果 | <isError=true textLength=N / missing> |

## 结论边界（必须保留）

本次测试只证明：`pwsh` 的沙箱升级审批点在这台机器上确实弹窗、用户确实点了拒绝、拒绝后写入未发生、
并且所采集的范围内观测不到副作用。它**不**证明：所有工具都被拦截、系统权限整体未变、
真实远端仓库未变（本轮未访问网络）、或日志不可伪造（权限与防篡改能力未经本仓库验证）。
