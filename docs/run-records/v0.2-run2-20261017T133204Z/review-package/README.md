# v0.2-run2 复核材料

本目录是对 2026-10-17 第二次真实流水线运行 `v0.2-run2-20261017T133204Z` 的复核材料，
由编排层在运行结束后独立采集，不采信子代理的 `APPROVED` 字面结论。

这次运行本身返回 **`ok: false`**（`MAX_ATTEMPTS_BYTECODE_CACHE_CHANGED_ACROSS_RUN`）。
第 4 节说明这个"不通过"由什么构成，以及其中多少是真问题、多少是误报。

## 1. 复现方式

一条命令重跑全部复核项（会重写 `text/`、`json/`、`suite-results.json`）：

```powershell
python tests/run-review-suite.py --run-id v0.2-run2-20261017T133204Z `
  --out-dir docs/run-records/v0.2-run2-20261017T133204Z/review-package `
  --parent-session session-3f96bf08-83ae-48d6-a239-0223d4b1c12c `
  --workflow-name tla-v02-run2 --since 2026-10-17T21:32:04+08:00
```

该脚本按固定 argv 依次执行 13 条命令，记录每条命令的 argv、退出码、耗时、输出路径与输出 sha256，
并把输出统一写成 UTF-8 / LF：文本输出在 `text/`，结构化输出在 `json/`，汇总在 `suite-results.json`。
它只写本目录（加上被测工具按契约产生的 `tests/.scratch/`），不改任何被跟踪文件。

## 2. 结果（本次 13 条命令全部退出码 0）

| 编号 | 内容 | 结果 |
| --- | --- | --- |
| 01 | 交付单元测试（`python -m unittest discover -s examples/text-stats`） | `Ran 81 tests` / `OK` |
| 02 | 独立复核 `tests/review-run-evidence.py`（带映射与 11 条显式排除项） | **70/70** 项通过 |
| 03 | 复核工具自检 `--self-test` | **14/14** 夹具 |
| 04 | 独立行为探针 `tests/probe-text-stats-requirement.py` | **180/180** |
| 05 | 变异检查 `tests/mutation-text-stats.py` | 基线 81/81；**3/3** 变异体被抓（5 / 1 / 3 例失败） |
| 06 | 工作流逻辑 `tests/workflow-logic.test.mjs` | **100/100** 场景、464 断言 |
| 07 | 真实子进程集成 `tests/bytecode-integration.test.mjs` | **6/6** 场景、45 断言 |
| 08 | 预检认领 `tests/preflight-claim-integration.test.mjs` | **6/6** 场景、59 断言 |
| 09 | 审批取证 `tests/approval-rejection-evidence.test.mjs` | **131/131** 断言 |
| 10 | 审批取证变异 `tests/approval-evidence-mutation.test.mjs` | 18/18 用例 + strict 11/11 |
| 11 | 统计性质测试 `tests/property_text_stats.py` | 1217 组（16 固定 + 1200 随机 + 1 长文本） |
| 12 | `tests/` 下单元测试 | `Ran 27 tests` / `OK` |
| 13 | 原生日志提取 `tests/extract-native-events.mjs` | **10/10** 派生检查通过 |

> 第一次跑这套复核时有两条命令以 `exit=1` 结束（02 与 05）。两次失败都不是交付实现的问题，
> 而是复核工具自己的口径过时——修法见第 5 节；修完重跑才是这一份全绿记录。

## 3. 交付物

- `delivery.diff`：本次运行对 `examples/text-stats/` 的完整改动（`git diff -- examples/text-stats`），
  188000 字节；改动了 `text_stats.py`、`test_text_stats.py`、`README.md` 三个文件（`sample_input.txt` 未变）。
- 产物指纹（Verifier 记录与磁盘逐字节一致，02 的产物比对检查）：
  - `examples/text-stats/text_stats.py`：13008 B / sha256 `17e12277…a78cc79a`
  - `examples/text-stats/test_text_stats.py`：37430 B / sha256 `caaca9d4…ef2af1e`
- `SHA256SUMS.txt`：本目录与 `../` 记录文件的 sha256 总表。

## 4. 这次运行为什么返回 `ok: false`（重点）

两个编码轮次的实质产物都合格：81 例测试通过、Verifier 独立复跑 81 例通过、Review `APPROVED`
且 AC-01 – AC-25 逐条 `satisfied: true`、需求自检 `conflicts: []`。
不通过的唯一原因是**运行期写入边界（`__pycache__`）判定**。把它拆开看，一共 5 条告警：

| # | 告警 | 复核结论 |
| --- | --- | --- |
| 1 | `text_stats.cpython-313.pyc` 在「运行前基线」与「Coding 执行前」之间被重写 | **误报**（mtime 表示精度，见下） |
| 2 | `test_text_stats.cpython-313.pyc` 在「Coding 后」与「Verifier 前」之间被重写 | **误报** |
| 3 | `text_stats.cpython-313.pyc` 在「Coding 后」与「Verifier 前」之间被重写 | **误报** |
| 4 | `test_text_stats.cpython-313.pyc` 在「Verifier 后」与「Review 前」之间被重写 | **误报** |
| 5 | `text_stats.cpython-313.pyc` 在「Verifier 后」与「Review 前」之间被重写 | **真实写入** |

- **误报的成因**：同一个文件被不同子代理报成整数毫秒与浮点毫秒两种表示（`1792240028919` vs
  `1792240028919.332`、`1792244851273` vs `1792244851273.0972`），而比较用的是 `!==` 严格相等。
  同一份内容的同一个时间戳，就这样被判成"被重写"。
- **那一条真实写入**：`cache-final.json`（21:50:29）显示 `text_stats.pyc` 变成 14885 B /
  mtime `2026-10-17T13:47:31.273Z`，而 Verifier 在 `13:46:34Z` 已经结束——时间点落在 Review 阶段。
  原因是 Review Agent 用**不带** `$env:PYTHONDONTWRITEBYTECODE = '1';` 前缀的临时 `python` 调用
  import 了被测模块（它自己的测试命令是带前缀的，但抽查与导入不是）。
  这一条说明：门禁抓的是真事，只是被 4 条误报淹没了。

### 同轮修复

1. 新增 `sameCacheObservation(earlier, later)`：先比 `bytes` 与 `sha256`（内容身份），两者一致时
   才比 `mtimeMs`，且允许 ≤ `MTIME_TOLERANCE_MS`（**5 毫秒**）的表示差。真实重写要么改内容，
   要么时间差远超容差——离线场景 54 / 55 分别锁住这两种情形。
2. `bytecodeScopeNote` 的提示词补成硬要求：本阶段内**任何**执行 Python 的命令都必须带同一前缀，
   包括 `python -c` 抽查、临时脚本、`--help` 试跑、导入被测模块；`mtime_ms` 要求写成整数。
3. `review-run-evidence.py` 的 `command_is_canonical` 允许剥离**逐字符已知**的字节码环境前缀；
   前缀里换了值（`= '0'`）仍算不 canonical（见第 5 节）。
4. `mutation-text-stats.py` 的"变异体被抓住"判据从固定用例名改为行为关键词（见第 5 节）。

**这些修复只在离线下验证过（100/100 场景、464 断言、6/6 集成场景），尚未在真实运行中验证。
是否跑第三次由仓库所有者决定；本轮没有自动重开。**

## 5. 这套复核工具自身暴露的两个问题

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 命令比对不认环境前缀 | 02 号命令 `exit=1`：`verify.command_is_canonical` 与 `review.independent_command_is_canonical` 都判 FAIL，因为运行记录的 `testCommand` 带了 `$env:PYTHONDONTWRITEBYTECODE = '1'; ` 前缀，而复核工具只认裸命令 | `normalize_test_command()` 剥离逐字符已知前缀；夹具 `bytecode_prefix_accepted` / `bytecode_prefix_wrong_value` 分别锁住"该放行的放行"与"换了值的仍拒绝"，自检 14/14 |
| 变异判据绑死用例名 | 05 号命令 `exit=1`：三个变异体都让交付套件失败了（失败用例分别是 `test_ac15_…`/`test_ac16_…`/`test_bc13_…`），但旧判据要求失败名以 run1 的 `test_ac12_…` 等开头，于是记成"命中目标=0"、判为漏抓 | 判据改为"套件失败 **且** 至少一个失败用例名命中该变异体的行为关键词（`silent\|quiet\|stderr`、`help\|usage`、`encoding`）"；`tests/test_mutation_gate.py` 用 run2 的真实用例名做回归，并断言提示不得退回 `test_` 固定名 |

两者都不是"为了让报告变绿而放宽"：前缀只接受逐字符已知的两种写法，关键词命中是**在**
"套件必须失败"之上的额外条件。

## 6. 需求映射

`../requirement-mapping.json`：37 条需求（R-01 – R-37）→ 51 个验收项（AC-01 – AC-25、BC-01 – BC-26）。
run2 与 run1 的注入需求逐字节相同，但验收项集合是 Requirement Agent 本轮自己拆的（run1 是 54 个），
所以映射重算。

生成方法：对每条 AC/BC 正文与条款正文按"中文字符二元组 + ASCII 词 + 数字"重叠打分，取
`>= max(12, 0.55 * 最高分)` 的条款都算覆盖（允许一条验收项归到多条条款）。
结果：37 条条款与 51 个验收项**都被引用**；`notProven` 列出 8 条无法用文本重叠归位的条款
（`R-12`、`R-18`、`R-19`、`R-24`、`R-28`、`R-30`、`R-36`、`R-37`）——这是自动归位的局限，
不等于需求未落实（例如 R-37 是冲突门禁，本身没有对应的统计验收项）。

## 7. 这份材料不能证明什么

- 不能证明**下一次**真实运行会通过缓存账本门禁（修复只做了离线验证）；
- 不能证明 Review 对 51 条验收项的判定都正确（交叉证据是独立探针 180 项与 81 例交付测试）；
- 不能证明 `notProven` 里那 8 条条款已被实现覆盖（只说明自动文本归位没找到落点）；
- 不能证明宿主日志整体未被篡改（原生证据取自日志白名单字段，不是全量重放）；
- 远端仓库状态仍未观测（未 push、未创建或修改 PR、未合并）。V0.1 最终验收**仍未通过**。
