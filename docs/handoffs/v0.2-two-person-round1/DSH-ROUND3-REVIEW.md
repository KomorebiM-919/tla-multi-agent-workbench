# DSH 独立复核：第三轮核心工作包

- 审查对象：`fix/v0.2-core-acceptance` 的 `1d316c62fc99dcbeefd8da5b8e93afdf3909a4ac`
- 审查增量：`e3f8573e086974ae52e179f4942318a310f3c63f..1d316c62fc99dcbeefd8da5b8e93afdf3909a4ac`
- 关键提交：`6fe2170`（非字符串哈希修复）、`1d316c6`（独立合成证据采集器）
- 本地复核基线：`feat/v0.2-component-reuse` 的 `a4c0afbeb3decc9cead92a6377cc1aa0610f4e4a`
- 方式：独立归档副本；未合并、未 cherry-pick、未修改核心实现
- 结论：**哈希修复接受；合成采集器作为离线协议实现有条件接受；不能据此宣布 V0.2 真实闭环。**

## 1. 范围与边界

本轮只审查上述提交及父提交。没有启动真实 DSH，没有启动假模型服务，没有发起模型实验，没有安装依赖，没有修改 ACL/profile。

复核的目标是回答三个问题：

1. 非字符串哈希是否还会让判定器抛错或误判？
2. 合成采集器能否把“观测到的事实”可靠地送到验收判定器，并且不被旧日志、缺失观测、失败工具或不完整回读欺骗？
3. 合成成功是否始终与真实宿主验收区分？

## 2. 哈希类型修复

`6fe2170` 在 `tools/acceptance-summary.mjs` 的 `readBackOk` 路径中引入 `validReadHash`/`validWriteHash`：先要求 `typeof sha256 === 'string'` 且匹配 64 位十六进制，再比较小写值。非字符串输入不再进入 `.toLowerCase()`。

验证：

- `tests/v02-core-acceptance.test.mjs`：**30/30**，包含 BigInt、数组、对象、缺失哈希等反例。
- 独立复现：64 位 BigInt 写入/回读不再抛 `TypeError`，判定为不通过，detail 为 `write/read sha256 must be 64-character hexadecimal strings`。
- 大写十六进制仍被接受；字符串比较语义未变。

这一项没有发现残留问题。**接受。**

## 3. 合成采集器实现

`docs/EVIDENCE-PROTOCOL-v1.md` 定义了 `tla.observation-protocol/v1`；`tools/collect-run-evidence.mjs` 实现了：

- 输入绑定：`origin: synthetic`，runner/gate/budget run ID，绝对 `projectRoot`；
- 单一 observer 的全局串行顺序：每个 call 必须先于自己的 result，且前一个 result 必须先于下一个 call；
- exact replay 去重；变更 replay、重复序号、orphan result、缺 result 拒绝；
- captain/worker/reviewer 会话与操作角色校验；
- 任务创建、claim、update、repair、review 状态机与 attempt 血缘；
- 文件 read/write 的 exact base64 字节、写前同会话读、写后回读、最终完整回读；
- 测试命令/退出码/通过失败数、同 suite 字节的 red-to-green；
- 限制：1 MiB 输入、128 operations、64 KiB snapshot、128 ID 长度、1024 path 长度、32 层 JSON；
- 输出 `tla.collected-evidence/v1`，顶层 `scope: 'synthetic-protocol'`、`hostVerified: false`、`verdict: synthetic-closed | partial | not-started`；失败时把空证据交给现有 predicate。

采集器不访问文件系统做物理校验；它只处理输入中声明的观测。这个边界在协议中已写明。

## 4. 八套测试结果

在独立归档副本中逐套运行，只按进程退出码判断，首个失败即停：

| 测试 | 结果 |
| --- | --- |
| `tests/v02-core-acceptance.test.mjs` | 30/30 |
| `tests/v02-acceptance-summary.test.mjs` | 19/19 |
| `tests/v02-evidence-collector.test.mjs` | 68/68 |
| `tests/v02-ledger.test.mjs` | 59/59 |
| `tests/v02-reactive-model.test.mjs` | 45/45 |
| `tests/v02-repair-loop-v3.test.mjs` | 43/43 |
| `tests/preflight-script.test.mjs` | 9 场景 / 42 断言 |
| `tests/workflow-logic.test.mjs` | 114 场景 / 547 断言 |

全部 exit 0，日志保留在审查副本的 `round3-test-output.log`（不入库）。

**覆盖声明：这 8 套是交接文档列出的范围，不等于全项目验收。** 本轮未跑 V0.1 全量、其余 `tests/v02-*`、真实宿主或任何模型请求。

## 5. 攻击性反例

### 5.1 P1：跨链的“通过”可以为另一条未通过链背书

构造两条独立链：

- 链 A：work A1 → review A2 `needs_revision` → repair A3 完成，但**从未有 review pass**；
- 链 B：work B1 → review B2 `needs_revision` → repair B3 完成 → review B4 `passed`。

七项任务全部 `completed`，usage 含 A 的 reject/repair 与 B 的 reject/repair/pass。结果：

```text
status=COMPLETE verdict=synthetic-closed acceptance=closed
issues=[]
```

原因：`REVIEW_REJECTED_THEN_PASSED` 只要求**任意** rejected work 后出现**任意** passed review；`REPAIR_COMPLETED` 只要求存在**任意** completed repair；`TASKS_COMPLETED` 只要求所有任务完成。三条全局谓词没有绑定到同一条 work → repair → pass 链。A 的 rejected work 从未被任何 review 接受，仍可被 B 的 pass 掩盖。

**严重度：P1（协议语义）。** 当前采集器只处理 synthetic，故对现网产品是 P2；一旦作为真实验收协议，这是阻断级缺陷。

最小修复方向：把 pass 绑定到 rejected work 的 repair 血缘，并要求每个 `needs_revision` 的 work 最终有同一链上的 passed review；或显式要求“所有 rejected work 均已闭合”。

### 5.2 P2：review pass 不要求 reviewer 亲自读文件

有效 fixture 中 reviewer 只执行 `task-update`，没有 `file-read`；worker 在 repair 期间的回读足以让 `passed` 及其后的 `READ_BACK_AFTER_WRITE` 成立。采集器仍返回 `synthetic-closed`。

这意味着“reviewer 根据真实文件内容批准”没有被证明；通过可以完全依赖 worker 的自述回读。若评审独立性是验收要求，需要求 `review` 任务的 attempt/session 在 repair 后读取目标实现文件，或把 reviewer 观测单独建模。

**严重度：P2。** 合成成功是真实的（协议内），但不是独立评审证据。

### 5.3 P2：subjects 没有进入输出

协议写“Task subjects are preserved”，采集器内部也保存并校验 subject；但 `evidence.tasks[*]` 不含 subject，`deriveAcceptance` 收到的 `subject` 是 `taskKind`（work/repair/review）。

后果：任务主题（例如 `Implement sum()`）无法在交付证据中审计；acceptance 的 `REPAIR_COMPLETED` 实际按 kind，而不是按 subject。subject 本身不参与误判，但“preserved”在输出层不成立。

**严重度：P2（证据完整性）。** 要么输出 subject 或其哈希，要么把文档改为“subjects are used for validation but omitted from public output”。

### 5.4 P2：run identity 只是调用方断言

`binding.runnerRunId`、`gateRunId`、`budgetRunId` 由输入声明，采集器只校验格式和 gate=budget；没有跨证据、签名或 runner summary 与 gate summary 的绑定。合成 payload 可以把 `runnerRunId` 写成任意值并获得 `synthetic-closed`。

这是协议的已声明边界（生产端未实现），不是实现 bug；但未来真实适配器必须补齐映射与来源证明。

### 5.5 P2：物理属性是 synthetic 断言

`fileKind: 'regular'`、`links: 'none'`、`coverage: 'full'`、suite 字节、snapshot 的 before/after 都是输入断言，采集器不做文件系统、symlink、junction、大小写或真实字节校验。协议已写明“不访问文件系统”；真实观测必须由未实现的生产端证明。

### 5.6 P3：嵌套 `acceptance.verdict` 可能被误读

顶层明确是 `synthetic-closed` / `hostVerified: false`，但输出内嵌的 `acceptance.verdict` 仍为 `closed`。只读嵌套字段的消费者可能把它当成真实闭环。建议 API/文档要求消费者先检查顶层 `scope` 与 `hostVerified`，或把嵌套字段改名为 `syntheticAcceptance`。

### 5.7 P3：按路径最新写，而不是按每次写回读

`readBackFor` 对每个 path 取最后一次写；如果同一文件被多次写，中间写的回读不被要求。协议说“每个变更路径”而不是“每次写”，因此目前不构成假通过；但“所有写入都有回读”的措辞需要避免。

## 6. 哪些情况没有被误判

以下反例均返回 `INCOMPLETE` 或 `partial`，没有 `synthetic-closed`：

- 旧 run10 形状（schema/origin 不支持）；
- 只有 policyFacts、没有结构化观测；
- wrong run binding；
- orphan result、result-before-call；
- 失败的非 test 工具；
- 缺最终回读、read-before-write；
- review pass 无 repair、review 目标未完成；
- 缺 attempt、重复 attempt；
- captain 写文件、worker 做 review、reviewer 写文件、worker 创建任务；
- 未注册 session；
- 字符串顺序、冲突 replay；
- 额外 `hostVerified: true` 字段。

exact replay 去重与乱序但可排序的输入正常通过；输入不可变（`structuredClone` 前后一致）。

## 7. 尚未实现的生产端

以下均**未实现**，不能用现有日志补造：

- 从真实 DSH transcript / session log 生产 `tla.observation-protocol/v1` 的 observer；
- runner run ID 与 gate/budget run ID 的现实映射与签名；
- subagent/member 工具调用与结果的采集；
- 物理文件字节、symlink/junction、路径大小写与 containment 的现实校验；
- 跨 session 并发、重试、部分结果、截断与顺序未知的表达；
- 与 `summariseRun` 的集成；
- 真实宿主的修复闭环。

现有 run10 日志没有 write 调用，read 因缺 `file_path` 失败，update_task 因缺 `attempt_id` 失败；采集器拒绝它是正确行为，不应被适配成通过。

## 8. 兼容性与接受建议

- `tla.collected-evidence/v1` 是新增 opt-in 路径；schema、CLI 与原有 10 个条件码未变。
- `summariseRun` 未接入采集器；旧 acceptance CLI 行为不变。
- 哈希修复只收紧非法输入，不改变合法哈希语义。

**接受结论：**

1. 哈希类型修复：**接受**。
2. 合成采集器：**作为离线 synthetic 协议实现有条件接受**；在 P1 跨链闭合修复前，不得用于“真实返工闭环已验证”的声明。
3. P2 项（reviewer 独立读、subjects、run identity、物理断言）可以按“已披露限制”保留，但必须写进未来生产端的验收条件。
4. 顶层 `scope`/`hostVerified` 必须作为消费门槛；不能只读嵌套 `closed`。

## 9. 复现

- 测试：在独立归档副本中逐套运行上表 8 个文件。
- 跨链反例：构造 A1/A2/A3 与 B1/B2/B3/B4 的 observation 文档，A3 完成后不创建 pass，B4 对 B3 pass；运行 `collectEvidence`，预期当前得到 `synthetic-closed`。
- reviewer 读缺失：使用有效 fixture（reviewer 无 `file-read`），预期当前得到 `synthetic-closed`。
- 旧日志：把 run10 的 `policyFacts`/扁平 events 作为 operation，预期 `INCOMPLETE` / `OBSERVATION_TYPE_UNSUPPORTED`。
- 非字符串哈希：在 core acceptance 输入中放 BigInt/数组/对象哈希，预期不抛错、`READ_BACK_AFTER_WRITE` 不通过。

## 10. 边界

本复核未修改核心实现，未合并或 cherry-pick，未启动宿主/假上游/模型，未安装依赖，未改 ACL/profile。审查文档只记录结论，不代表分支已被合并或实验已获授权；真实宿主实验授权仍为 0。
