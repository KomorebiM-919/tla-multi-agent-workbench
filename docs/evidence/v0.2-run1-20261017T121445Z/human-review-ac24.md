# 人工复审记录：AC-24 判定不成立（不修改 review.json 原件）

- 记录时间：2026-10-17，人工复审（用户复审意见）之后追加。
- 对象：`docs/evidence/v0.2-run1-20261017T121445Z/review.json` 中 `result.criteria_check` 的 AC-24 条目。
- 处置：**原件不改**（字节、哈希保持运行当时写入的样子）。本文件是追加的复审结论，不是对原件的改写。
  因此 `review.json` 里该条仍是 `satisfied: true` —— 它是**当时的错误判定**，不是现在的结论；
  以本文件与 `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` §16.2 为准。

## 1. Review 原件写的原文（逐字引用）

> criterion：`AC-24 写入边界：仅四个交付文件；不新增 __pycache__；其它目录无改动`
>
> satisfied：`true`
>
> evidence：`git status --porcelain -- examples/text-stats 仅 3 个 M（README.md、test_text_stats.py、text_stats.py），无未跟踪项；sample_input.txt 未改动但经字节断言为固定 20 字节样例；git status --porcelain --untracked-files=no 全仓库无交付目录之外的被跟踪文件改动。两次以 PYTHONDONTWRITEBYTECODE=1 复跑后 __pycache__ 内两个 .pyc 的 mtime 仍为 20:27:08（Verifier 未设该变量时产生的旧产物），未新增文件。补充：tests/review-run-evidence.py 为 20:20:02 生成的编排复核工具（早于 coding 阶段报告 20:26），非本轮交付改动。`

## 2. 事实

- 该 evidence 自己承认了两个 `.pyc` 的 mtime 是 `20:27:08`，而 `20:27` 正是 Verifier 阶段执行规范测试命令的时间；
- Verifier 阶段执行命令时没有 `PYTHONDONTWRITEBYTECODE=1`（当时的 `isAllowedTestCommand` 只放行规范命令原文），
  所以**运行期确实发生了字节码写入**；
- 子代理随后自行设置该变量复跑，`.pyc` 保持 `20:27:08` 不变 —— 这只能说明"复跑没有再写"，不能说明"本轮运行没有写"。

## 3. 结论

- **本次工作流返回 `ok: true` / `APPROVED` 是历史事实**（记录在 `review.json` 与编排层返回值里，不因此改写）。
- **AC-24 没有获得充分证明**。已确认的缓存写入**违反了本轮运行期写入约束**（R-33 / AC-24 的"不新增 `__pycache__/`"）。
- `__pycache__/` 被 `.gitignore` 忽略、未进入版本库、被跟踪文件未被改动 —— 这三件事**都不能替代运行期写入边界检查**，
  也**不能**把该项算作满足。
- 先前把这件事解释为"需求条款与编排契约之间的环境冲突"**不足以据以免除该项**；正确表述是：
  该条款在本轮**未被满足**，冲突只解释了**原因**，不构成**豁免**。

## 4. 后续处理（已在后续改动中落地，另行验证）

- 授权的最小编排改动让 Coding / Verifier / Review 的测试进程实际获得 `PYTHONDONTWRITEBYTECODE=1`，
  并在 Verifier / Review 证据中新增 `bytecode_scope`（测试前后对 `<targetDir>/__pycache__` 的清单 + `env_applied`），
  由编排层 `judgeBytecodeScopePair` 判定：写入 → `BYTECODE_CACHE_WRITTEN`，未设 → `BYTECODE_ENV_NOT_APPLIED`，
  未测量 → `BYTECODE_SCOPE_UNMEASURED`，三者都判不通过（`REVIEW_NOT_APPROVED` 之前的硬门禁）。
- 上述改动在本轮**只做离线验证**，不调用真实模型；它能否在实际运行里满足 AC-24，需要下一次获授权的真实运行来证明
  —— 本轮不作此结论。

## 5. 本文件不能证明什么

- 不能证明本轮其它 AC 的判定都正确（只处理 AC-24 这一条）；
- 不能证明新门禁在真实运行中生效（离线测试通过 ≠ 真实运行通过）；
- 不改变 run 6、v0.1 各次运行的历史记录。
