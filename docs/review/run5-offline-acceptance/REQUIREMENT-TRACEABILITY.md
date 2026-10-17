# R-01 – R-37 需求追踪表（run5 交付）

- 唯一需求源：已批准候选稿 v3 `docs/DEMO-REQUIREMENT-INPUT-v3.md` 第 2 节（`v0.2-demo-input-3`），注入文本 `docs/run-records/v0.2-run1-20261017T121445Z/requirement-injected.txt`（15249 B，sha256 `6307a7f0…f71d7`）。
- 被验收的交付提交：`[C39]`（`examples/text-stats/text_stats.py`、`test_text_stats.py`、`README.md`；`sample_input.txt` 未改动）。
- 证据列记号：
  - `V:AC-xx` = `verify-run5.py` 对应条目（离线、确定性、零模型调用）；
  - `V:用例` = 同一工具内的 `count_text` 用例集（38 例）；
  - `T:97` = 交付测试套件独立复跑 `Ran 97 tests ... OK`；
  - `E:*` = run5 原始运行证据（`docs/evidence/v0.4-run5-20261017T161034Z/`），属于**历史运行记录**，不能离线重放。
- **Agent 的 `APPROVED` 与 `criteria_check` 不计为独立证据**；下表的“结论”只依据 `V:*`、`T:97`、源码位置与 `E:*` 中可核对的事实。

| R | 条款要点 | AC / BC | 实现位置 | 独立证据 | 结论 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | 程序化调用只返回整数、不写两个流、不读进程 stdin | AC-01、AC-02；BC-02、BC-24 | `examples/text-stats/text_stats.py:258-295`（`main`，`:286` `programmatic = stdin_text is not None`，`:293` `return EXIT_OK`） | `V:AC-01`（redirect 捕获为空 + `sys.stdin=None`）、`V:AC-02`（`True 0 int`）、`T:97` | 通过 | 无 |
| R-02 | 命令行无 PATH、stdin 立即 EOF → 4 行全 0、退出 0、不阻塞 | AC-03；BC-21 | `:242-256`（`_read_stdin_text`）、`:258-326` | `V:AC-03`（`python text_stats.py < NUL` 等价空输入）、`T:97` | 通过 | 无 |
| R-03 | `count_text` 纯函数、恰好四个整数键 | AC-08；BC-05、BC-07、BC-08 | `:88-121` | `V:AC-08`（键集合与四值、`sys.stdin=None` 复算一致）、`V:用例` | 通过 | 无 |
| R-04 | `main(argv=None, stdin_text=None)`；`argv=None` 等价 `sys.argv[1:]`；仅模块入口 `sys.exit` | AC-02、AC-24、AC-25；BC-24 | `:258`、`:328-329` | `V:AC-02`、`V:AC-24`（AST：`sys.exit` 仅 `:329`）、`V:AC-25` | 通过 | 无 |
| R-05 | 两类调用分别适用、不得合并（命令行打印 / 程序化静默） | AC-01、AC-03、AC-05、AC-23、AC-25；BC-02、BC-19、BC-20 | `:286-325` | `V:AC-01`（静默）、`V:AC-05`（4 行）、`V:AC-23`（给 PATH 的程序化调用静默）、`V:AC-25` | 通过 | 无 |
| R-06 | 命令行成功写恰好 4 行、顺序与格式固定 | AC-04、AC-05、AC-07；BC-13、BC-14 | `:124-128`（`_format_stats`）、`:157-167`（`_write`） | `V:AC-07`（逐行正则 + 键顺序 + 末尾恰一个换行）、`T:97` | 通过 | 仅在本机 Windows 实测；POSIX 的 LF 输出未实测（验收按 `splitlines()` 口径，BC-14 已声明） |
| R-07 | 输入来源不改变统计口径（同一已解码文本四值相同） | AC-06；BC-23 | `:131-142`（`_read_file`）、`:242-256` | `V:AC-06`（PATH 与 stdin 均 20/2/2/4） | 通过 | “两条路径解码规则不同（`--encoding` vs 宿主流）时字节不同不构成失败”未构造用例 |
| R-08 | 读文件保留原始换行，归一化只在 `count_text` | BC-22 | `:140` `open(path, "r", encoding=encoding, newline="")` | 源码位置核对 + `V:AC-06`/`V:用例`（CRLF/CR 归一化用例） | 通过（结构性证据） | 未用“仅含 CRLF 或 CR 的文件”做专门行为探针 |
| R-09 | 输出作用域按调用方式固定（6 行表） | AC-17 – AC-23；BC-15 – BC-20 | `:169-179`（`_report_error`）、`:286-325` | `V:AC-17` – `V:AC-23`、`T:97` | 通过 | 无 |
| R-10 | 五类受控错误一律退出 1、不用 argparse 的 2、无 traceback | AC-19、AC-20；BC-17 | `:181-194`（`_ParserExit`）、`:196-204`（`_UsageErrorParser`） | `V:AC-19`（不存在文件、参数过多）、`V:AC-20`（目录、非法 UTF-8、非法编码名） | 通过 | 无 |
| R-11 | `--help` 退出 0；程序化帮助静默 | AC-17、AC-18；BC-15、BC-16 | `:206-225`（`_build_parser`） | `V:AC-17`（`usage:` + PATH + `--encoding`）、`V:AC-18`（`[0]` 且无输出） | 通过 | 无 |
| R-12 | 错误正文措辞不逐字要求；命令行 `error: ` 前缀、单行、无 traceback；程序化无输出 | AC-19、AC-20、AC-21；BC-17 | `:169-179` | `V:AC-19`/`V:AC-20`（`one_error_line`）、`V:AC-21`（两流为空） | 通过 | 无 |
| R-13 | 程序化给非法 PATH / 非法编码仍返回 1 且两流为空；编码校验先于输入选择 | AC-21、AC-22、AC-23；BC-18、BC-19 | `:286-315` | `V:AC-21`、`V:AC-22`（无 PATH + 空文本仍 1）、`V:AC-23` | 通过 | 无 |
| R-14 | 退出码只有 0/1；函数内部不 `sys.exit` | AC-24；BC-25 | `:328-329`（唯一 `sys.exit(main())`） | `V:AC-24`（观测集合 ⊆ {0,1}、AST 仅入口一处）、`T:97` | 通过 | 无 |
| R-15 | 归一化顺序固定：剥一个 BOM → CRLF → 剩余 CR | AC-09；BC-03 | `:101-105` | `V:AC-09`、`V:用例`（`a\r\nb\rc` → 5/3/3/3） | 通过 | 无 |
| R-16 | 换行边界只有 LF/CR/CRLF；8 个字符不是换行；不得以 `splitlines()` 为唯一依据 | AC-10；BC-04 | `:103-114` | `V:AC-10`（U+2028/2029/0B/0C/1C/1D/1E/85 各 `line_count=1`、`char_count=3`） | 通过 | 无 |
| R-17 | BOM 只剥一个 | AC-09；BC-03 | `:101-102` | `V:AC-09`（双 BOM → `char_count 4`） | 通过 | 无 |
| R-18 | 其它字符一律不改写（不折叠、不去尾、不 trim） | AC-13；BC-06、BC-12 | `:101-121`（无 NFC/NFD、无 trim） | `V:用例`（U+3000、U+00A0 原样保留且计为空白行）、`V:AC-13` | 通过 | U+2003 等其它 Unicode 空白未逐项列举 |
| R-19 | 不做 Unicode 归一化（NFC/NFD 都不做） | AC-12；BC-12 | `:88-121`（无 `unicodedata`） | `V:用例`（`cafe`+U+0301 → `char_count 5`、`word_count 1`） | 通过 | 无 |
| R-20 | `char_count` = 归一化后码点数 | AC-12；BC-07 | `:117` `len(text)` | `V:用例`（20 / 3 / 4 / 5 等） | 通过 | 无 |
| R-21 | `line_count` 口径（空文本 0、末尾 LF 不新增空行、空白行仍算行） | AC-11；BC-05 | `:107-114` | `V:用例`（`""→0`、`"\n"→1`、`"a\n"→1`、`"a\n\n"→2` 等 8 例） | 通过 | 无 |
| R-22 | `non_empty_line_count` 与行数出自同一次切分 | AC-13；BC-05、BC-06 | `:111-119` | `V:用例`（`"  \n\t\n"` → 2/0、`"a\n\n"` → 2/1）、`V:AC-13` | 通过 | 无 |
| R-23 | 空白集合 = `str.strip()` 默认集合 | AC-13；BC-06 | `:119` `line.strip() != ""` | `V:用例`（U+3000、U+00A0 行计为空白行） | 通过 | 同 R-18 |
| R-24 | `cafe`+U+0301 只允许 `word_count 1`、`char_count 5` | AC-12、AC-15；BC-10 | `:85`（正则，组合记号非单词字符） | `V:用例` | 通过 | 无 |
| R-25 | 单词正则 `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*` | AC-14；BC-08 | `:79`（`WORD_JOINERS`）、`:85`（`WORD_PATTERN`）、`:120` | `V:用例`（`hello--world`→2、`a-b-c`→1、`it\u2019s`→1 等 7 例） | 通过 | 无 |
| R-26 | 数字与下划线不是单词字符 | AC-15；BC-09 | `:85`、`:120` | `V:用例`（`123 456`→0、`a1b`→2、`a_b`→2、`foo_bar baz`→3） | 通过 | 无 |
| R-27 | 非 ASCII 字母与组合记号不是单词字符/连接符 | AC-15；BC-10 | `:85` | `V:用例`（`caf\u00e9`→1、`caf\u00e9-mocha`→2） | 通过 | 无 |
| R-28 | 连接符两侧必须紧邻 ASCII 字母 | AC-16；BC-11 | `:85` | `V:用例`（`" -abc"`→1、`"abc- "`→1、`"'abc"`→1） | 通过 | 无 |
| R-29 | 解码分工：文件默认 UTF-8 + `--encoding` 只作用于文件；stdin 用宿主文本流 | AC-05、AC-06、AC-20、AC-22；BC-21、BC-22 | `:144-155`（`_encoding_for`）、`:242-256`（`_read_stdin_text`，`:246` `sys.stdin.read()`） | `V:AC-05`/`V:AC-06`（stdin 与 PATH 同值）、`V:AC-20`/`V:AC-22`（非法编码名） | 通过（部分） | stdin 编码切换（`PYTHONIOENCODING`）与 `--encoding utf-16` 文件解码未由工具覆盖；run5 期间曾用 UTF-16LE 临时文件人工复算 4/1/1/1，本轮未复跑 |
| R-30 | `codecs.lookup` 校验编码名；文件解码失败同退出 1 | AC-20、AC-22；BC-18、BC-22 | `:153` `codecs.lookup(name)` | `V:AC-20`（非法编码名 + 非法 UTF-8 文件）、`V:AC-22` | 通过 | 无 |
| R-31 | 实现与测试只允许 Python 标准库 | AC-26；BC-26 | `text_stats.py` 全部 import（`argparse`、`codecs`、`contextlib`、`io`、`re`、`sys`）；测试另含 `ast`、`hashlib`、`inspect`、`os`、`subprocess`、`unittest` | `V:AC-26`（AST 清单 ⊆ `sys.stdlib_module_names`，且无 `requirements.txt`/`pyproject.toml`/`setup.py`/`Pipfile`） | 通过 | “无网络、不读凭据、不读 `~/.dsh`”只能由“没有相应 import”间接证明 |
| R-32 | 只改交付目录下 4 个文件 | AC-29（变更范围半）；BC-27 | 交付提交 `[C39]` | `V:AC-29`（`git diff --name-only [C39]^..[C39]` 恰 3 个交付文件，`sample_input.txt` 未触碰；无交付目录外路径） | 通过 | 无 |
| R-33 | 运行期只允许 `.test-scratch/` 与注入的证据路径；不新增 `__pycache__` | AC-28、AC-29（稳定性半）；BC-27、BC-28 | 运行期行为（非交付代码） | `V:AC-28`（测试命令前后缓存集合/哈希/`mtime` 全同）、`E:preflight.json`/`E:verify.json` 的 `bytecode_scope` 前后一致、`E:*` 证据目录仅 6 个注入文件 + 本轮采集的 `cache-postrun.json`、`.test-scratch/tmp*` 创建时间早于运行（2026-10-16 19:20–19:27） | 通过（依证据） | 写入窗口由采集点插值，窗口内“写完又改回原样且 mtime 变化 ≤5 ms”的瞬时写入不可观测（run5 已声明） |
| R-34 | `sample_input.txt` 20 字节固定内容 + README 四项自洽 | AC-27；BC-29、BC-30 | `examples/text-stats/sample_input.txt`、`README.md` | `V:AC-27`（20 字节、内容逐字节等于 `hello world\nfoo bar\n`、README 含 20/2/2/4） | 通过 | 无 |
| R-35 | README 每条可复制示例与规则自洽；不得保留矛盾历史值 | AC-27（部分）；BC-30 | `examples/text-stats/README.md` | `V:AC-27`（sample 示例四项一致、无 `char_count: 6`） | 部分通过 | README 其余示例（`hello world\n`→12/1/1/2、`a\r\nb\rc`→5/3/3/3、`'  \r\n \r\n'`→5/2/0/0、空文本→0）本轮未逐条机器复算；run5 人工复核时已逐条复算通过 |
| R-36 | 描述连接符不得出现裸 U+2019 | AC-27；BC-30 | `examples/text-stats/README.md` | `V:AC-27`（`no_bare_u2019=True`，即 README 中不存在裸 U+2019） | 通过 | 无 |
| R-37 | 需求互斥即报冲突并停止，不自行选边 | 运行期约束（编排门禁） | `workflows/three-agent-mvp.js` 门禁 + 需求阶段自检 | `E:requirement.json`（`conflicts: []`、`consistency_check.self_checked: true`）、`E:coding-report.json`（`requirement_conflicts: []`） | 通过（依证据） | 离线未构造互斥需求场景验证门禁确实中止（本轮不发起真实运行） |

## 汇总

- 37 条全部有依据；其中 **R-35 为部分自动化覆盖**（README 只有 sample 示例被机器校验），**R-29 有两条子情形未由工具覆盖**（stdin 编码切换、`--encoding utf-16` 文件解码）。
- 涉及“运行期行为”的 R-33、R-37 只能依据 run5 的历史证据，不能离线重放；这部分属“不可复证事实”，判定为“依证据通过”。
- 文档类（R-34、R-35、R-36）、修改范围（R-32）、运行期约束（R-33、R-37）已按用户要求分别核实，未合并成一条“APPROVED”结论。
