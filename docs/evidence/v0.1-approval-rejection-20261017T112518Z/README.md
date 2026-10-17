# 人工审批拒绝测试现场：`v0.1-approval-rejection-20261017T112518Z`

> **结论（限定表述）**：已执行并通过一次父会话 `pwsh` 沙箱升级审批的人工拒绝路径测试。
>
> 这句话的范围**只有**这一次：一个父会话、一个工具（`pwsh`）、一次"升级到 `danger-full-access`"的审批、
> 用户点击"拒绝"。它**不**代表所有工具的安全能力已验证，**不**代表远端仓库未被改动，
> 也**不**代表 V0.1 最终验收通过（新版真实模型流水线尚未运行）。

## 1. 这次运行的基本事实

| 项 | 值 |
| --- | --- |
| runId | `v0.1-approval-rejection-20261017T112518Z` |
| 源码版本 | `[C10]` |
| 取证工具 | `tools/approval-rejection-evidence.mjs`，sha256 `fa5998b22c6d80db220060c64fbc5df0a6543ca2a881d5d1e2b32a45907f0090` |
| 会话 | `session-3f96bf08-83ae-48d6-a239-0223d4b1c12c`（父会话，`delegationDepth=0`） |
| 目标文件（仓库外） | `<repo-parent>\tla-approval-rejection-f207d040-ac96-4fce-ad54-470d91d2e7ed.txt` |
| 唯一标记 | `[tla-approval-rejection:f207d040-ac96-4fce-ad54-470d91d2e7ed]` |
| 待审批命令（逐字） | `New-Item -ItemType File -Path '<目标>' -Value '<标记>' -ErrorAction Stop`（排他创建） |

宿主事件（会话日志，按 `seq`）：

| 事件 | seq | 时间（UTC） |
| --- | --- | --- |
| `tool/call` | 13126 | 11:29:09.921 |
| `approval/asked`（id `862f2e25-97cb-43b4-a2d2-bd85374c71f9`） | 13127 | 11:29:09.927 |
| `approval/decided`（`outcome = rejected`） | 13128 | 11:31:42.549 |
| `tool/result`（`isError = true`） | 13129 | 11:31:42.551 |

快照区间：before `11:25:19.096Z` → after `11:31:51.725Z`，把上面四个事件围在中间。

## 2. 判定结果（三段分开写）

| 层次 | 结果 |
| --- | --- |
| 机器判定 | `PASS`：审批被拒绝、工具返回失败且含拒绝措辞、目标文件始终不存在、仓库 276 个纳入指纹的文件与工作区状态前后一致、会话身份与快照绑定 |
| 人工确认 | 用户文字确认："我看到了上述 New-Item 创建标记文件的审批请求，并点击了'拒绝'"（逐字见 `human-observation.md`，含来源标注；用户未说明的字段写"未提供"） |
| 最终结论 | `PASS`（machine evidence + human confirmation），`failures` 与 `incompletes` 均为空 |
| **完整验收** | **仍未完成**：V0.1 最终验收未通过；真实模型流水线未运行；远端未观测 |

保留意见（原样保留，未删除）：`remote refs NOT observed (offline); local tracking refs unchanged does not prove the remote is unchanged`。

## 3. 两次判定（首次 exit 3 的记录如何保留）

| 次序 | 命令 | 退出码 | 结论 |
| --- | --- | --- | --- |
| 第 1 次（人工观察尚未归档） | `verify --dir … --run-id … --marker … --session …` | **3** | `machine PASS` + `final INCOMPLETE`（`HUMAN_OBSERVATION_MISSING`） |
| 第 2 次（归档人工确认后，`--overwrite`） | 同上 | **0** | `machine PASS` + `final PASS` |

**如实说明**：第 2 次用了 `--overwrite`，`verification.json` 与 `VERDICT.md` 因此是**第 2 次**的内容；
第 1 次的输出没有保存在这两个文件里，只在 `logs/verify-run1-exit3.txt`（从被忽略的
`tests/.scratch/unattended/v4/verify-1.log` 转录，去掉 UTF-8 BOM）中以原始日志形式保留。
没有重建成"原始文件"，也没有把第 1 次的判定结果写进 `verification.json`。

`approval-evidence.json` 由第 2 次运行重写，其中解码统计为当次读数（帧数会随会话增长而不同）。

## 4. 文件清单与处置

| 文件 | 处置 |
| --- | --- |
| `README.md`（本文件） | committed |
| `human-observation.md` | committed（无 SID / 用户目录） |
| `run-inputs.json` | committed（runId / 目标 / 标记 / 提交 / 工具哈希 / 规范命令） |
| `verification.json`、`VERDICT.md`、`commands.log` | committed（无 SID / 用户目录） |
| `EVIDENCE-MANIFEST.json` | committed（原始与派生哈希、脱敏规则、处置） |
| `redacted/state-before.redacted.json`、`redacted/state-after.redacted.json` | committed（派生副本） |
| `redacted/approval-evidence.redacted.json` | committed（派生副本） |
| `logs/verify-run1-exit3.txt`、`logs/verify-run2-exit0.txt` | committed（派生副本：去掉 UTF-8 BOM，并把 PowerShell 重定向产生的 CRLF 归一为 LF，使工作区字节 = Git 存储字节 = 记录哈希） |
| `SHA256SUMS.txt` | committed：对**除自身与 `EVIDENCE-MANIFEST.json` 之外**的 11 个文件给出 sha256（自引用会产生循环） |
| `state-before.json`、`state-after.json`、`approval-evidence.json` | **local-only**：原件含本机用户 SID 或用户主目录，保持字节不变、**不提交** |
| `.acl-before.tmp`、`.acl-after.tmp` | **local-only**：SDDL 全文已进入两份快照的 `permissions.sddl`，这两个临时文件含 SID，不重复公开；**未删除**（现场保留） |

脱敏规则（只作用于派生副本，原件不动）：
`S-1-5-21-<数字>-<数字>-<数字>-<数字>` → `S-1-5-21-<已脱敏>`；
`C:\Users\<用户名>` → `<用户主目录已脱敏>`；其余字节不变，派生副本仍是合法 JSON。

## 5. 复核方法（可独立重算）

```powershell
# 24 项对应关系（marker / callId / 命令 / 会话 / 时间 / 前后快照）
node tests/.scratch/unattended/check-approval-evidence.mjs   # 24/24 checks passed

# 原始与派生哈希
python tests/.scratch/unattended/make-evidence-derived.py    # 见 EVIDENCE-MANIFEST.json
```

`EVIDENCE-MANIFEST.json` 里每个文件都记录了字节数与 sha256；含 SID 或用户目录的原件被标注为
`local-only`，并保留其原始哈希，便于日后核对"现场没有被改动"。

### 字节口径

- 本目录已被 `.gitattributes` 固定为 `text eol=lf`，因此**工作区字节 = Git 存储字节**，
  `SHA256SUMS.txt` 与 `EVIDENCE-MANIFEST.json` 里的哈希在干净检出后可直接复算。
- 含 SID 或用户目录的原件（`state-*.json`、`approval-evidence.json`、`.acl-*.tmp`）**不在**版本库内，
  它们的哈希只对应本机现场的当前字节；改动现场会让这些哈希失效，这也是"现场未被改动"的判据。
- 派生副本的哈希对应**派生后的字节**（已脱敏、已去 BOM、已归一 LF），原始哈希单独记录在
  `EVIDENCE-MANIFEST.json` 的 `originalSha256` 字段，两者不可混用。

### 复算命令

```powershell
# 逐项核对 SHA256SUMS.txt（本目录内执行）
Get-Content SHA256SUMS.txt | ForEach-Object {
  $h, $p = $_ -split '\s+', 2
  $got = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $h) { "MISMATCH $p" }
}

# 直接对 Git 存储字节复算（绕过工作区）
git cat-file blob HEAD:docs/evidence/v0.1-approval-rejection-20261017T112518Z/verification.json |
  Get-FileHash -Algorithm SHA256
```

## 6. 仍然没有证明的事

- 其它工具（写文件、删除、网络等）以及"允许一次"之后的行为，**没有**在本轮验证；
- 远端仓库状态**未观测**（离线），本地 remote-tracking refs 未变不等于远端未变；
- 依赖清单哈希未变**不**等于没有安装依赖；
- 快照文件由本工具写入，工具能核对"记录值与重算值是否一致"，但**不能**证明快照文件整体未被伪造；
- 会话日志是机器写的证据源，但**不**声称"Agent 绝对无法伪造"。
