# 维护事项（本轮明确未处置）

本文件只登记，不执行。本轮授权范围是“修改复核工具、配套测试与文档并本地提交”，**不包含**清理历史现场、处理来源不明的 worktree、`git worktree prune`、修改 ACL 或重写历史。

## 1. worktree 注册项

| 路径 | 状态 | 本轮处置 |
| --- | --- | --- |
| `<repo-root>` | 主检出处，分支 `feat/v0.1-three-agent-mvp` | 正常使用 |
| `<user-home>/AppData/Local/Temp/dsh-GtGhMV/tla-5034985-tree` | **来源不明**（detached `5034985`，位于系统临时目录） | **未处理**：不删除、不 prune、不改其内容。若需清理，请显式授权后执行 `git worktree remove --force` |
| `tests/.scratch/run5-review/copy` | 本轮为复算 `[C39]` 创建的独立副本（detached `[C39]`，位于 `.gitignore` 覆盖的 `tests/.scratch/` 内） | **保留**：供 `verification-clean-copy.json` 的方式复算；清理同样需显式执行 `git worktree remove --force` |

## 2. 未跟踪的历史残留

| 路径 | 内容 | 本轮处置 |
| --- | --- | --- |
| `examples/text-stats/.test-scratch/tmp*` | 12 个目录 + `.gitkeep`，创建时间 **2026-10-16 19:20:06 – 19:27:11**（早于 run5 的 2026-10-18），被 ACL 拒绝访问 | 未删除；已确认本轮复核前后条目数不变（13 → 13），不是本轮产生的 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/` | 5 个未跟踪文件（`approval-evidence.json`、`state-before/after.json`、`.acl-before/after.tmp`） | 未加入版本库、未删除；其 ACL 临时文件亦未清理 |
| `docs/review/`（历史包 `[C17]`、`029bdcc`、`b003651`、`e3c27c1`、`f04886a`、`[C08]`、`unattended-2026-10-17` 等） | 有意不入库的临时审查材料 | 保持未跟踪；本轮把**正式**材料移入 `docs/run-records/v0.4-run5-20261017T161034Z/review-package/`，不再往 `docs/review/` 增加内容 |

## 3. 与 `docs/review/` 约定的关系

仓库既有约定：`docs/review/` 是**有意不入库**的本地审查材料区；正式材料放 `docs/run-records/<runId>/review-package/`（参见 `docs/ROADMAP.md` 中 v0.2-run1 的纠正记录，以及 `docs/run-records/v0.2-run1-20261017T121445Z/review-package/README.md` 第 6–9 行）。

本轮先前把复核包提交在 `docs/review/run5-offline-acceptance/` 属**位置错误**，已用一次普通提交整体移动到正式位置；旧路径的提交出现在历史中（`[C40]`），未改写历史。

## 4. 未执行的动作（逐条声明）

- 未 `git worktree prune`，未删除任何 worktree。
- 未删除 `.test-scratch/tmp*`，未修改其 ACL。
- 未删除 `docs/review/` 下任何历史包。
- 未 push、未创建或修改 PR（含草稿 PR #2）、未合并 `main`。
- 未发起任何真实模型调用或流水线运行。
