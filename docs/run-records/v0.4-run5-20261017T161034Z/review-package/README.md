# run5 离线验收复核包（正式版）

本目录是 run5（`v0.4-run5-20261017T161034Z`）交付之后的**离线验收收口**材料。它不改写任何 run5 原始归档，也不追认原复核工具没有实际检查过的内容。

- 固定交付提交：`[C39]`（`feat(text-stats): apply the run5 delivery pending human review`）
- 交付文件：`examples/text-stats/text_stats.py`、`test_text_stats.py`、`README.md`（`sample_input.txt` 未改动，因内容本就符合 R-34）
- 原始归档（保留、未改）：`docs/run-records/v0.4-run5-20261017T161034Z/`（`independent-review.py`、`independent-review.json`、`SHA256SUMS.txt` 等）与 `docs/evidence/v0.4-run5-20261017T161034Z/`

## 0. 目录位置与仓库约定

`docs/review/` 在本仓库是**有意不入库**的临时审查材料区（`docs/ROADMAP.md` 记录过历史上误提交 `docs/review/` 后被显式移除的纠正）。因此本包最初落在 `docs/review/run5-offline-acceptance/` 是**位置错误**，现已整体移到这里；移动以一次普通提交完成，不改写历史（该目录曾出现在提交 `[C40]` 的树里，这一事实保留在 git 历史中）。

- **正式材料**（可复算的工具、结果记录、追踪表、验收报告、人工复审清单）：本目录，随仓库长期保留。
- **临时材料**（一次性草稿、原始输出、抓取物）：放 `docs/review/`，不提交。
- 若后续再需要临时目录，本包不再复制到 `docs/review/`；引用关系以本文件为准。

## 1. 为什么另写一个工具

原工具 `docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py` 报告的 “checked 25, passed 25” 只证明它真正执行过的那些探针。三处检查存在证明缺口：

1. **AC-28 的比较是空转的。** 原脚本在 `main()` 里把 `list_pycache()` 当作 “after” 快照传进 `check_ac28()`，而测试套件是在 `check_ac28()` 内部才执行的。也就是说 “运行前后的缓存对比” 比较的是运行前的两份快照。它另外只比较文件名与大小，不比较内容哈希，也没有时间戳口径。
2. **AC-29 在干净副本里必然失败。** 原脚本要求工作区恰好有 3 个已修改文件，并要求状态在复核前后完全不变；一个已提交、干净检出的副本状态为空，于是 `modified == ALLOWED_MODIFIED` 不成立。这既不能证明写入边界，也不能在只读副本上复算。
3. **失败会被当成干净。** 原脚本的 `git_status()` 忽略返回码：git 失败时 stdout 为空，解析结果就是 “没有修改”，于是失败被当成通过。

本目录的 `verify-run5.py` 是修正后的正式复核工具；原脚本与其输出、哈希清单一律保持原样保留。原 25/25 只能被理解为 “原探针集通过”，其中 AC-28、AC-29 两条当时并未真正被检验。

## 2. 修正内容

| 项 | 原实现 | 修正后 |
| --- | --- | --- |
| AC-28 快照顺序 | after 快照在测试运行**之前**采集 | before → 运行文档化测试命令 → after，三步串行 |
| AC-28 比较口径 | 文件名 + 大小 | 文件集合 + 每个文件的 sha256 + `mtime_ns`（容差 0 ns，口径写在报告里） |
| AC-29 变更范围 | 要求工作区恰有 3 个 ` M` 条目 | 独立的 `git diff --name-only <base>..<delivery>` 范围检查（允许 4 个交付文件的**任意子集**，空提交与非交付路径都判失败） |
| AC-29 复核自身 | 与变更范围混在一起 | 单独比较复核前后的工作区状态，并**显式列出**复核自己声明的输出文件 |
| git / 快照 / 证据失败 | 忽略返回码，空输出当干净 | 一律抛 `EvidenceError`，该条目判为失败（非 PASS） |
| R-35 README 其余示例 | 无自动化（只有 sample 示例被校验） | 四个示例逐条以**真实子进程**重放，分别断言退出码、stdout、stderr、统计值，并要求 README 展示同一组数值 |
| R-29 UTF-16 文件解码 | 无自动化 | 两个夹具（无 BOM 的 `--encoding utf-16-le`、带 BOM 的 `--encoding utf-16`）走真实子进程；对照“同文件不加 `--encoding`”必须给出**不同**统计值 |
| R-29 stdin 解码 | 无自动化 | 子进程设 `PYTHONIOENCODING=utf-16`，stdin 送 UTF-16 字节；断言统计值、stdout 用子进程自身流编码写回、父进程环境未被改动，且对照组（不设变量）得不到同一结果 |
| 反例 | 无 | `--self-test` 覆盖 19 个反例（见第 4 节） |

`mtime` 口径的理由：文档化测试命令带 `PYTHONDONTWRITEBYTECODE=1`，因此测试**完全不应触碰**缓存目录；任何 `mtime_ns` 变化都说明抑制失效或写入发生，所以容差取 0 ns 而不是放宽。

环境变量的作用域：`PYTHONIOENCODING` 只加在**测试子进程**的 `env` 副本上，并对比调用前后 `os.environ` 的值——探针自己泄露变量到宿主会直接判失败（反例 `child-env-does-not-leak`）。

## 3. 复算方法

在仓库任意副本内（工具需要 `git`，因此副本必须是 git 工作树；验证只读交付目录，不写交付文件）：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py `
  --repo <副本根> --base [C39]^ --delivery [C39] `
  --out <副本内或仓库内的输出路径>
```

- `--base/--delivery` 缺省为 `HEAD^` / `HEAD`；固定复算请显式给出提交。
- `--self-test` 只跑反例（不触碰交付目录），用于证明工具本身不会把失败当通过。
- 退出码 0 = 全部条目复现且自检通过；1 = 有条目不同或自检失败。
- 工具只使用 Python 标准库，无网络、无模型调用、无时钟依赖判断。
- 临时夹具写在 `tests/.scratch/run5-review/`（已被 `.gitignore` 覆盖）：当前沙箱策略下平台临时目录不可写，因此夹具放在工作区内，并在结束时清理。

## 4. 反例（`--self-test`，19 项）

| 反例 | 证明 |
| --- | --- |
| `cache-unchanged-control` | 未触碰的缓存不报差异（正对照） |
| `cache-added-during-test` | 测试期间新增 `.pyc` 被抓到 |
| `cache-same-name-new-content` | 同名文件内容变化被抓到 |
| `cache-same-size-different-content` | **同大小不同内容**靠 sha256 被抓到 |
| `cache-mtime-moved` | 内容完全相同、仅时间戳移动 5 ms 也被抓到（口径为 0 ns） |
| `scope-exact-match` | 恰好 4 个交付文件通过 |
| `scope-partial-accepted` | 实际交付只改 3 个文件（`sample_input.txt` 未变）也被接受 |
| `scope-empty-rejected` | 空交付提交被拒 |
| `scope-extra-path` | 触碰 `workflows/three-agent-mvp.js` 被拒 |
| `clean-checkout-stability` | 干净副本（状态为空）通过稳定性检查——原实现在这里必然失败 |
| `declared-output-excluded` | 复核自己的输出被排除且必须披露 |
| `undeclared-file-rejected` | 未声明的多余文件被拒 |
| `git-failure-is-not-clean` | git 失败抛错而非当作空树 |
| `example-stats-mismatch` | 示例统计值差一个数即失败 |
| `example-stderr-leak` | 示例向 stderr 漏一行即失败 |
| `example-exit-code` | 示例退出码不对即失败 |
| `example-extra-stdout` | 示例 stdout 多一行即失败 |
| `documented-form-needs-all-four` | README 只写一个数字不算“文档化了该示例” |
| `child-env-does-not-leak` | 子进程环境变量不污染父进程（同时证明该隔离是可观测的） |

结果见 `self-test.json`（19/19 通过）。

## 5. 本目录文件

| 文件 | 内容 |
| --- | --- |
| `verify-run5.py` | 正式复核工具（AC-01 – AC-29 + R-35 + R-29 两个探针 + 19 个自检反例） |
| `verification-clean-copy.json` | 在 `[C39]` 的独立 worktree 副本内复算的结果（**28/28**） |
| `verification-main-checkout.json` | 在主检出处复算的结果（**28/28**；含已存在的 2 个 `.pyc`，额外证明“已有缓存不被触碰”） |
| `self-test.json` | 19 个反例的结果（19/19） |
| `REQUIREMENT-TRACEABILITY.md` | R-01 – R-37 逐条追踪（AC/BC、实现位置、证据、结论、未覆盖边界） |
| `ACCEPTANCE-REPORT.md` | 可决策的验收报告（含剩余事项分类与维护事项） |
| `HUMAN-REVIEW-CHECKLIST.md` | 给仓库所有者的人工复审清单与可直接回复的验收文字 |
| `MAINTENANCE.md` | 本轮明确未处置的维护事项（来源不明 worktree、历史残留、ACL 临时文件） |
| `SHA256SUMS.txt` | 本目录文件与相关证据文件的校验和 |

## 6. 声明

- 未修改交付代码、未修改工作流、未发起任何真实模型调用。
- 未 push、未创建或修改 PR（含草稿 PR #2）、未合并 `main`、未宣布 V0.1 通过。
- 未清理任何历史现场（包括 `examples/text-stats/.test-scratch/tmp*` 的既有残留、未跟踪的历史审查包、来源不明的 worktree 注册项、临时 ACL 文件）。
