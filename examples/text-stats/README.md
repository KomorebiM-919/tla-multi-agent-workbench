# text-stats

仅使用 Python 标准库的文本统计命令行工具。输入一段文本（文件或标准输入），输出四项统计结果。

## 统计规则

四项口径完全由本文档引用的规范条文（BC 编号）唯一确定，实现、测试与文档三处数值一致。

| 指标 | 含义 | 依据 |
| --- | --- | --- |
| `char_count` | 归一化后文本的字符数（`len(str)`，即 Unicode 码点数；不按字节、不按字形簇、不按显示宽度） | BC-02、BC-08 |
| `line_count` | 归一化文本的行数，等于按 LF 切分后的行数（LF、CR、CRLF 三种换行序列在归一化后都只剩 LF）；空串为 0，以换行结尾不产生额外空行。**不使用** `str.splitlines()`，因为它会把 U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 也当作换行，违反 BC-01 | BC-01、BC-04、BC-05 |
| `non_empty_line_count` | 各行中 `strip()` 后仍含字符的行数（空白定义同 `str.strip()`，含全角空格 `\u3000`、不换行空格 `\u00a0`） | BC-06、BC-07 |
| `word_count` | 满足 `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*` 的片段个数 | BC-09 … BC-12 |

处理细节：

- **换行归一化**（BC-02）：统计前先剥除一个前导 `\ufeff`，再把 `\r\n` 替换为 `\n`，最后把剩余的 `\r` 替换为 `\n`；其它字符一律不改写，因此 U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 都不产生新行（它们留在行内容中并计入 `char_count`）。`\r\n` 在 `char_count` 中只计 1 个字符（BC-08）。
- **行数判定表**（BC-04、BC-05）：`''` → 0；`'\n'` → 1；`'a\n'` → 1；`'a'` → 1；`'a\nb'` → 2；`'a\n\n'` → 2；`'a\n\nb'` → 3；`'hello world\nfoo bar\n'` → 2；`'  \r\n \r\n'` → 2。以换行结尾一律不再另计一行。
- **字符数对照表**（BC-02、BC-03、BC-08）：`''` → 0；`'hello world\nfoo bar\n'` → 20；`'a\r\nb'` → 3（`\r\n` 归一化后只计 1 个字符）；`'a\rb'` → 3；`'a\r\nb\rc'` → 5；`'  \r\n \r\n'` → 5（`\r\n` 各去掉一个 `\r`）；`'\ufeffabc'` → 3（剥除一个前导 BOM）；`'\ufeff\ufeffabc'` → 4（只剥除一个）；`'caf\u00e9'` → 4；`'cafe\u0301'` → 5（e 加组合重音 U+0301）。`char_count` 数的是归一化后的 Unicode 码点，不按字节、不按字形簇、不按显示宽度。
- **BOM 剥离**（BC-03）：解码后若文本以单个 `\ufeff`（UTF-8 BOM）开头，先剥离该字符再统计，BOM 不计入 `char_count`；只剥离一个，第二个仍计入。
- **空白判定**（BC-07）：`non_empty_line_count` 使用 Python `str.strip()` 的空白集合（含空格、`\t`、`\x0b`、`\x0c`、`\r`、`\n`、`\u00a0`、`\u3000` 等），不做自定义扩展也不做缩减。
- **单词字符集**（BC-09、BC-10）：只有 ASCII 字母 `a-z`、`A-Z` 是单词字符；ASCII 数字、下划线 `_`、非 ASCII 字母（`é`、`中` 等）与组合用记号（如 U+0301）都不是，会把字母片段切开。`abc123` → 1，`a1b` → 2，`a_b` → 2，`foo_bar baz` → 3，`123 456` → 0。
- **大小写**（BC-10）：不做小写化归并，每个 `[A-Za-z]+` 片段各计 1 个词，`Hello hello HELLO` → 3。
- **连接符**（BC-11、BC-12）：只有三种连接符能把两个字母片段连成 1 个词 —— ASCII 连字符 `-`、ASCII 撇号 `'`（U+0027）与右单引号 `\u2019`（U+2019）；连接符两侧必须都紧邻 ASCII 字母，且一次只允许一个连接符。`well-known` → 1，`don't` → 1，`it\u2019s` → 1，`a-b-c` → 1，但 `hello--world` → 2（连续两个连接符不连接）。非 ASCII 字母与组合记号不能充当连接符：`caf\u00e9-mocha` → 2，`cafe\u0301` → 1。
- **单一实现路径**（BC-13、BC-20）：命令行路径与标准输入路径都复用 `count_text`，归一化只在 `count_text` 一处完成，不存在两套口径。

## 命令行用法

```text
python text_stats.py [PATH] [--encoding NAME]
```

- 给出 `PATH` 时读取该文件；省略时从标准输入读取全部文本。
- 默认按 UTF-8 解码，`--encoding` 可覆盖（未知编码名按错误处理，BC-14）。
- 位置参数最多 1 个；给出 2 个及以上属用法错误（BC-18）。

## 退出码约定

| 情形 | 退出码 | 标准输出 | 标准错误 |
| --- | --- | --- | --- |
| 成功 | `0` | 恰好 4 行 `key: value`（BC-16、BC-19） | 无 |
| `--help` | `0` | 用法文本 | 无 |
| 任何错误（BC-14、BC-18），命令行调用 | `1` | 空 | 至少一行以 `error: ` 开头的英文消息 |
| 任何错误（BC-14、BC-18），程序化调用 | `1` | 空 | **空**（静默，见下节） |

错误情形包括：位置参数多于 1 个、文件不存在 / 是目录 / 不可读、解码失败、`--encoding` 指定的编码名未知。错误时不会抛出未捕获异常，也不会打印 traceback。

## 程序化调用

以 `main(argv=None, stdin_text=None)` 调用时，只要显式传入 `stdin_text`（传空串也算），即为程序化调用（BC-15）：函数只返回退出码，**两个输出流都不写**、不读进程流，由调用方自行打印结果。省略 `stdin_text`（`None`）才是命令行调用，成功时写那 4 行（BC-16）。两类调用的期望不同但适用于不同调用方式，不构成冲突（BC-17）。

"静默"覆盖全部程序化路径，不只是成功路径：

- 成功（含编码名合法且省略 `PATH`）：`0`，两个流都空；
- `--help`：`0`，两个流都空（用法文本只属于命令行调用）；
- 受控错误（文件不存在 / 是目录 / 解码失败 / 非法 `--encoding` / 参数过多）：`1`，两个流都空；
- 非法 `--encoding` 在选输入之前就校验，所以**没有 `PATH`、注入空文本也照样返回 `1`**。

```python
from text_stats import count_text, main

count_text("hello world\n")          # {'char_count': 12, 'line_count': 1, ...}
main([], stdin_text="hello world\n")  # 0，不打印任何内容
```

## 可直接复制的示例

读取交付目录内的样例文件（文件内容为 `hello world\nfoo bar\n`，共 20 个字符）：

```console
$ python text_stats.py sample_input.txt
char_count: 20
line_count: 2
non_empty_line_count: 2
word_count: 4
```

从标准输入读取（`\n` 结尾，`char_count` 含结尾换行符）：

```console
$ printf 'hello world\n' | python text_stats.py
char_count: 12
line_count: 1
non_empty_line_count: 1
word_count: 2
```

标准输入立即可读到 EOF 时，四项全为 0 且不阻塞等待输入：

```console
$ printf '' | python text_stats.py
char_count: 0
line_count: 0
non_empty_line_count: 0
word_count: 0
```

含 CRLF 与单独 CR 的文件（内容为 `a\r\nb\rc`，共 5 个字符、3 行）：

```console
$ python text_stats.py crlf_cr.txt
char_count: 5
line_count: 3
non_empty_line_count: 3
word_count: 3
```

错误路径示例（退出码为 `1`，标准输出为空）：

```console
$ python text_stats.py missing-file.txt
error: missing-file.txt: [Errno 2] No such file or directory: 'missing-file.txt'
```

## 测试

在仓库根目录执行（规范化命令）：

```console
$ python -m unittest discover -s examples/text-stats -p "test_*.py"
```

在交付目录内运行的等价写法：

```console
$ cd examples/text-stats
$ python -m unittest discover -p "test_*.py"
```

测试仅依赖标准库 `unittest`，覆盖本轮 `boundary_conditions` **BC-01 至 BC-24** 每条边界条件与 **AC-01 至 AC-23** 每条验收条件，并通过真实子进程校验命令行入口、退出码与四行输出格式。

> 测试需要交付目录内已存在 `.test-scratch/` 目录（仓库中已保留占位文件），用于写入临时输入文件；测试结束会删除写入的文件。
> 该目录已被交付目录内的 `.gitignore` 忽略，不会进入版本库。测试只在该目录下写**平铺文件**、不新建子目录：DSH 沙箱禁止向本次运行中新建的目录写入文件，也禁止写入工作区之外（含系统临时目录）。
> 该目录内另有 12 个 v0.1 初版遗留、被沙箱权限锁定而无法删除的 `tmp*` 子目录，清理需要人工处理 ACL，详见 `docs/evidence/v0.1-first-run/coding-report-revision-2.json`。

## 规范优先级

本目录内历史文档或历史测试若与本轮 `boundary_conditions`（BC-01 至 BC-24）冲突，一律以本轮规范为准，冲突值已在实现、测试与文档中一并修正：

1. **行边界的集合**（BC-01）：只有 LF、CR、CRLF 构成换行。`line_count` 按归一化后的 LF 切分计数，不再使用 `str.splitlines()`；U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 一律保留为行内容。
2. **结尾换行后的行数**（BC-05）：`line_count` 只有一套口径。`'hello world\nfoo bar\n'` 为 2 行、`'a\n\n'` 为 2 行、`'a\n\nb'` 为 3 行、`'  \n\t\n'` 为 2 行且 `non_empty_line_count` 为 0；不存在“以换行结尾另计一行”的第二种说法。
3. **组合重音字符的单词数**（BC-09、BC-12）：`'cafe\u0301'` 与 `'caf\u00e9'` 均为 1 个词，`char_count` 分别为 5 与 4；不存在断言为 2 的写法。
4. **用法错误的退出码**（BC-18）：位置参数多于 1 个时退出码为 `1`，不使用 argparse 的默认退出码 `2`。
5. **程序化调用的静默性**（BC-15、BC-17）：显式传入 `stdin_text` 时 `main()` 只返回退出码、**两个输出流都不写**（成功、`--help`、受控错误都一样）；只有命令行调用才输出那 4 行。非法 `--encoding` 在选输入之前校验，因此没有 `PATH`、注入空文本也必须返回 `1`。
6. **`'  \r\n \r\n'` 的 `char_count`**（AC-05）：本轮口径统一为 `5`，不再是历史轮次的 `6`；实现、测试与文档三处均已按 `5` 落地，见下文「曾经无法自洽、本轮已统一的历史数值」。

### 曾经无法自洽、本轮已统一的历史数值

历史轮次的 AC-05 曾为输入 `'  \r\n \r\n'` 给出 `char_count: 6`，而该输入共 7 个原始码点，按 BC-02 归一化为 `'  \n \n'` 后按 BC-08 只有 5 个码点 —— 任何同时满足 BC-02 与 BC-08 的实现都无法得到 6。

本轮权威口径已把该值统一为 **5**，实现、测试与文档三处一致：

```python
count_text("  \r\n \r\n")
# {'char_count': 5, 'line_count': 2, 'non_empty_line_count': 0, 'word_count': 0}
```

| 字段 | 值 | 依据 |
| --- | --- | --- |
| `char_count` | `5` | 7 个原始码点去掉了 `\r\n` 中的 2 个 `\r`（BC-02、BC-08） |
| `line_count` | `2` | 归一化后为 `'  \n \n'`，2 行（BC-05） |
| `non_empty_line_count` | `0` | 两行分别只有空格（BC-06、BC-07） |
| `word_count` | `0` | 没有 ASCII 字母（BC-09） |

同一输入的四个数值互相自洽，且行数与非空行数出自同一次切分（AC-05）。此前记录在 `docs/evidence/v0.1-run5-20261016T152321Z/coding-report.json` 的 `requirement_conflicts` 已随本轮口径统一而消解，本轮 `requirement_conflicts` 为空数组。
