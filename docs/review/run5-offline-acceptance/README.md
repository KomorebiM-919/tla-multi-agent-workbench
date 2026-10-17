# run5 离线验收复核包（修正版工具）

本目录是 run5（`v0.4-run5-20261017T161034Z`）交付之后的**离线验收收口**材料。它不改写任何 run5 原始归档，也不追认原复核工具没有实际检查过的内容。

- 固定交付提交：`[C39]`（`feat(text-stats): apply the run5 delivery pending human review`）
- 交付文件：`examples/text-stats/text_stats.py`、`test_text_stats.py`、`README.md`（`sample_input.txt` 未改动，因内容本就符合 R-34）
- 原始归档（保留、未改）：`docs/run-records/v0.4-run5-20261017T161034Z/`、`docs/evidence/v0.4-run5-20261017T161034Z/`

## 1. 为什么另写一个工具

原工具 `docs/run-records/v0.4-run5-20261017T161034Z/independent-review.py` 报告的 “checked 25, passed 25” 只证明它真正执行过的那些探针。两个检查存在证明缺口：

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
| 反例 | 无 | `--self-test` 覆盖 13 个反例（见第 4 节） |

`mtime` 口径的理由：文档化测试命令带 `PYTHONDONTWRITEBYTECODE=1`，因此测试**完全不应触碰**缓存目录；任何 `mtime_ns` 变化都说明抑制失效或写入发生，所以容差取 0 ns 而不是放宽。

## 3. 复算方法

在仓库任意副本内（工具需要 `git`，因此副本必须是 git 工作树；验证只读交付目录，不写交付文件）：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
python docs/review/run5-offline-acceptance/verify-run5.py `
  --repo <副本根> --base [C39]^ --delivery [C39] `
  --out <副本内或仓库内的输出路径>
```

- `--base/--delivery` 缺省为 `HEAD^` / `HEAD`；固定复算请显式给出提交。
- `--self-test` 只跑反例（不触碰交付目录），用于证明工具本身不会把失败当通过。
- 退出码 0 = 全部条目复现且自检通过；1 = 有条目不同或自检失败。
- 工具只使用 Python 标准库，无网络、无模型调用、无时钟依赖判断。
- 临时夹具写在 `tests/.scratch/run5-review/`（已被 `.gitignore` 覆盖）：当前沙箱策略下平台临时目录不可写，因此夹具放在工作区内，并在结束时清理。

## 4. 反例（`--self-test`，13 项）

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

结果见 `self-test.json`（13/13 通过）。

## 5. 本目录文件

| 文件 | 内容 |
| --- | --- |
| `verify-run5.py` | 修正版正式复核工具（AC-01 – AC-29 + 自检反例） |
| `verification-clean-copy.json` | 在 `[C39]` 的独立 worktree 副本内复算的结果（25/25） |
| `verification-main-checkout.json` | 在主检出处复算的结果（含已存在的 `__pycache__`，额外证明“已有缓存不被触碰”） |
| `self-test.json` | 13 个反例的结果 |
| `REQUIREMENT-TRACEABILITY.md` | R-01 – R-37 逐条追踪（AC/BC、实现位置、证据、结论、未覆盖边界） |
| `ACCEPTANCE-REPORT.md` | 可决策的验收报告 |
| `SHA256SUMS.txt` | 本目录与相关证据文件的校验和 |

## 6. 声明

- 未修改交付代码、未修改工作流、未发起任何真实模型调用。
- 未 push、未创建或修改 PR、未合并 `main`、未宣布 V0.1 通过。
- 未清理任何历史现场（包括 `examples/text-stats/.test-scratch/tmp*` 的既有残留）。
