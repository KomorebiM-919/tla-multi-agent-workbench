# text-stats

仅使用 Python 标准库的文本统计命令行工具。输入一段文本（文件或标准输入），输出四项统计结果。

## 统计规则

四项口径由本轮规范条文（AC-01 至 AC-29、BC-01 至 BC-30）唯一确定，实现、测试与文档三处数值一致。

| 指标 | 含义 | 依据 |
| --- | --- | --- |
| `char_count` | 归一化后文本的字符数（`len(str)`，即 Unicode 码点数；不按字节、不按字形簇、不按显示宽度） | BC-07 |
| `line_count` | 归一化文本的行数，等于按 LF 切分后的行数（LF、CR、CRLF 三种换行序列在归一化后都只剩 LF）；空串为 0，以换行结尾不产生额外空行。**不使用** `str.splitlines()`，因为它会把 U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 也当作换行 | BC-04、BC-05 |
| `non_empty_line_count` | 与 `line_count` 同一批切分出的行里，`strip()` 后仍含字符的行数（空白定义同 `str.strip()`，含全角空格 `\u3000`、不换行空格 `\u00a0`） | BC-06 |
| `word_count` | 满足 `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*` 的片段个数 | BC-08 |

处理细节：

- **记号约定**（BC-01）：LF 指 U+000A，CR 指 U+000D，CRLF 指 CR 紧跟 LF，BOM 指 U+FEFF，`\u2019` 指右单引号 U+2019，`\u00e9` 指 é，`\u0301` 指组合重音；文档与测试一律用这些记号书写，不写实际控制字符。
- **换行归一化**（BC-03）：统计前先剥除一个前导 `\ufeff`，再把 `\r\n` 替换为 `\n`，最后把剩余的 `\r` 替换为 `\n`；步骤顺序固定，其它字符一律不改写。因此 U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 都不产生新行（它们留在行内容中并计入 `char_count`）。`\r\n` 在 `char_count` 中只计 1 个字符。
- **BOM 剥离**（BC-03）：解码后若文本以单个 `\ufeff`（UTF-8 BOM）开头，先剥除该字符再统计，BOM 不计入 `char_count`；只剥除一个，第二个仍计入：`'\ufeffabc'` → 3，`'\ufeff\ufeffabc'` → 4。
- **行数判定表**（BC-05）：`''` → 0；`'\n'` → 1；`'a\n'` → 1；`'a'` → 1；`'a\nb'` → 2；`'a\n\n'` → 2；`'hello world\nfoo bar\n'` → 2；`'hello world\nfoo bar\n\n'` → 3；`'  \n\t\n'` → 2。以换行结尾一律不再另计一行。
- **字符数对照表**（BC-07）：`''` → 0；`'hello world\nfoo bar\n'` → 20；`'a\r\nb'` → 3（`\r\n` 归一化后只计 1 个字符）；`'a\r\nb\rc'` → 5；`'caf\u00e9'` → 4；`'cafe\u0301'` → 5（e 加组合重音 U+0301）；`'\ufeffabc'` → 3。
- **空白判定**（BC-06）：`non_empty_line_count` 使用 Python `str.strip()` 的空白集合（含空格、`\t`、`\x0b`、`\x0c`、`\u00a0`、`\u3000` 等），不做自定义扩展也不做缩减；`'  \n\t\n'` → `line_count` 2、`non_empty_line_count` 0。
- **单词字符集**（BC-08、BC-09）：只有 ASCII 字母 `a-z`、`A-Z` 是单词字符；ASCII 数字、下划线 `_`、非 ASCII 字母（`é`、`中` 等）与组合用记号（如 U+0301）都不是，会把字母片段切开。`abc123` → 1，`a1b` → 2，`a_b` → 2，`foo_bar baz` → 3，`123 456` → 0。
- **大小写**（BC-08）：不做小写化归并，每个 `[A-Za-z]+` 片段各计 1 个词，`Hello hello HELLO` → 3。
- **连接符**（BC-08、BC-11）：只有三种连接符能把两个字母片段连成 1 个词 —— ASCII 连字符 `-`、ASCII 撇号 `'`（U+0027）与右单引号 `\u2019`（U+2019）；连接符两侧必须都紧邻 ASCII 字母，且一次只允许一个连接符。`well-known` → 1，`don't` → 1，`it\u2019s` → 1，`a-b-c` → 1，但 `hello--world` → 2（连续两个连接符不连接）。
- **非 ASCII 字母与组合记号**（BC-10）：它们既不是单词字符也不是连接符。`caf\u00e9-mocha` → 2，`cafe\u0301` → 1（并且 `char_count` 为 5，不得断言为 2 个词）。
- **单一实现路径**（BC-23）：命令行路径与标准输入路径都复用 `count_text`，归一化只在 `count_text` 一处完成，同一份已解码文本得到同一组四个数值。
- **不做额外改写**（BC-12）：不做 Unicode 归一化（NFC/NFD 都不做），字符不折叠、不去尾、不 trim 整篇；`\u00a0` 与 `\u3000` 原样保留并计入 `char_count`，只在 `strip()` 判空时算作空白。

## 命令行用法

```text
python text_stats.py [PATH] [--encoding NAME]
```

- 给出 `PATH` 时读取该文件；省略时从标准输入读取全部文本。
- 文件默认按 UTF-8 解码，`--encoding NAME` 只覆盖文件解码（未知编码名按受控错误处理，BC-18）；标准输入由 `sys.stdin` 自身的编码解码，`--encoding` 不改变它（BC-21、BC-22）。
- 位置参数最多 1 个；给出 2 个及以上属用法错误，退出码为 `1`（BC-17、BC-25）。
- `-` 不是标准输入别名，按普通文件名处理。
- 读文件时保留原始换行（`newline=""`），归一化只在 `count_text` 一处完成（BC-22、BC-23）。

## 退出码约定

| 情形 | 退出码 | 标准输出 | 标准错误 |
| --- | --- | --- | --- |
| 成功 | `0` | 恰好 4 行 `key: value`（BC-13） | 无 |
| `--help` | `0` | 用法文本（BC-15） | 无 |
| 任何受控错误，命令行调用 | `1` | 空 | 恰好一行以 `error: ` 开头的英文消息（BC-17） |
| 任何受控错误，程序化调用 | `1` | 空 | **空**（静默，见下节；BC-17） |

受控错误共五类：位置参数多于 1 个且参数里没有 `--help`、文件不存在、文件不可读或是目录、解码失败、`--encoding` 指定的编码名非法。错误时不会抛出未捕获异常，也不会打印 traceback，退出码集合只有 `0` 与 `1`（BC-25，不使用 argparse 默认的 `2`）。

## 程序化调用

以 `main(argv=None, stdin_text=None)` 调用时，只要显式传入 `stdin_text`（传空串也算），即为程序化调用（BC-02）：函数只返回退出码，**两个输出流都不写**、不读进程标准输入，由调用方自行打印结果。省略 `stdin_text`（`None`）才是命令行调用，成功时写那 4 行（BC-02、BC-13）。两类调用的期望不同但适用于不同调用方式，不构成冲突。

"静默"覆盖全部程序化路径，不只是成功路径：

- 成功（含编码名合法且省略 `PATH`）：`0`，两个流都空（BC-20）；
- `--help`：`0`，两个流都空（用法文本只属于命令行调用，BC-15、BC-16）；
- 受控错误（文件不存在 / 是目录 / 解码失败 / 非法 `--encoding` / 参数过多）：`1`，两个流都空（BC-17）；
- 非法 `--encoding` 在选输入之前就校验，所以**没有 `PATH`、注入空文本也照样返回 `1`**（BC-18）；
- 只给 `PATH`、不给注入文本时属命令行调用，仍然读文件并写出 4 行；程序化调用给 `PATH` 时也会真的读该文件，但只在出错时返回 `1`，成功时同样不写任何流（BC-19）。

```python
from text_stats import count_text, main

count_text("hello world\n")           # {'char_count': 12, 'line_count': 1, ...}
main([], stdin_text="hello world\n")  # 0，不打印任何内容
```

## 可直接复制的示例

读取交付目录内的样例文件 `sample_input.txt`（内容恰为 `hello world\nfoo bar\n`，20 字节，LF 结尾，BC-29）：

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

标准输入立即读到 EOF 时，四项全为 0、退出码 0，且不阻塞等待输入（BC-21）：

```console
$ printf '' | python text_stats.py
char_count: 0
line_count: 0
non_empty_line_count: 0
word_count: 0
```

Windows 命令行等价写法（`NUL` 提供立即 EOF）：

```console
> python text_stats.py < NUL
char_count: 0
line_count: 0
non_empty_line_count: 0
word_count: 0
```

含 CRLF 与单独 CR 的文本（`a\r\nb\rc` 归一化为 `a\nb\nc`，5 个字符、3 行、3 个词）：

```python
>>> from text_stats import count_text
>>> count_text("a\r\nb\rc")
{'char_count': 5, 'line_count': 3, 'non_empty_line_count': 3, 'word_count': 3}
```

`--encoding` 只作用于文件解码（BC-22）：先用 Python 造一个 UTF-16LE 文件，再读它。

```console
$ python -c "open('.test-scratch/utf16le-demo.txt','wb').write('abc\n'.encode('utf-16-le'))"
$ python text_stats.py .test-scratch/utf16le-demo.txt --encoding utf-16-le
char_count: 4
line_count: 1
non_empty_line_count: 1
word_count: 1
```

用法文本（退出码 0，标准错误为空，BC-15）：

```console
$ python text_stats.py --help
usage: text_stats.py [-h] [--encoding ENCODING] [path]
...
```

错误路径示例：把目录当作 `PATH`，退出码为 `1`、标准输出为空、标准错误恰好一行（BC-17；错误正文随平台变化，只要求以 `error: ` 开头）：

```console
$ python text_stats.py .
error: .: ...
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

测试仅依赖标准库 `unittest`，覆盖本轮 `acceptance_criteria` **AC-01 至 AC-29** 每条验收条件与 `boundary_conditions` **BC-01 至 BC-30** 每条边界条件；每条用例的名称或注释都标注了它覆盖的 AC/BC 编号，并通过真实子进程校验命令行入口、退出码、四行输出、错误契约与程序化静默性。

> 测试需要交付目录内已存在 `.test-scratch/` 目录（仓库中已保留占位文件），用于写入临时输入文件；测试只在该目录下写**平铺文件**、不新建子目录，并在结束时删除写入的文件（BC-27）。DSH 沙箱禁止向本次运行中新建的目录写入文件，也禁止写入工作区之外（含系统临时目录）。
> 该目录已被交付目录内的 `.gitignore` 忽略，不会进入版本库。
> 该目录内另有若干早期轮次遗留、被沙箱权限锁定而无法删除的 `tmp*` 子目录，清理需要人工处理 ACL；它们不影响测试，新临时文件仍写在平铺层并自删。
> 运行测试前设置 `PYTHONDONTWRITEBYTECODE=1`（本仓库的规范化运行方式），不会在交付目录内新增或改写 `__pycache__` 内文件（BC-28）。

## 规范优先级

本目录内历史文档或历史测试若与本轮 `boundary_conditions`（BC-01 至 BC-30）或 `acceptance_criteria`（AC-01 至 AC-29）冲突，一律以本轮规范为准，冲突值已在实现、测试与文档中一并修正：

1. **行边界的集合**（BC-04）：只有 LF、CR、CRLF 构成换行。`line_count` 按归一化后的 LF 切分计数，不使用 `str.splitlines()`；U+2028、U+2029、`\x0b`、`\x0c`、`\x1c`、`\x1d`、`\x1e`、`\x85` 一律保留为行内容。
2. **结尾换行后的行数**（BC-05）：`line_count` 只有一套口径。`'hello world\nfoo bar\n'` 为 2 行、`'a\n\n'` 为 2 行、`'hello world\nfoo bar\n\n'` 为 3 行；不存在"以换行结尾另计一行"的第二种说法。
3. **组合重音字符的单词数**（BC-10）：`'cafe\u0301'` 与 `'caf\u00e9'` 均为 1 个词，`char_count` 分别为 5 与 4；不存在断言为 2 的写法。
4. **用法错误与受控错误的退出码**（BC-17、BC-25）：位置参数多于 1 个时退出码为 `1`，不使用 argparse 的默认退出码 `2`；全部路径只允许 `0`（成功与 `--help`）和 `1`（受控错误）两个值。
5. **程序化调用的静默性**（BC-02、BC-16、BC-17）：显式传入 `stdin_text` 时 `main()` 只返回退出码、**两个输出流都不写**（成功、`--help`、受控错误都一样）；只有命令行调用才输出那 4 行。
6. **错误文本**（BC-17）：命令行调用在标准错误上**恰好一行**以 `error: ` 开头、不含 traceback 的消息；程序化调用没有任何输出。
7. **`'  \r\n \r\n'` 的 `char_count`**：本轮口径统一为 `5`。该输入共 7 个原始码点，按 BC-03 归一化为 `'  \n \n'` 后按 BC-07 只有 5 个码点；历史轮次记录的另一个数值无法与 BC-03、BC-07 同时成立，已从实现、测试与文档中删除（AC-13）。

```python
>>> count_text("  \r\n \r\n")
{'char_count': 5, 'line_count': 2, 'non_empty_line_count': 0, 'word_count': 0}
```

## 边界条件速查

| 边界 | 规则 | 示例 |
| --- | --- | --- |
| BC-01 记号约定 | LF=U+000A，CR=U+000D，CRLF=CR+LF，BOM=U+FEFF，`\u2019`=U+2019，`\u00e9`=é，`\u0301`=组合重音 | 文档与测试不写实际控制字符 |
| BC-02 调用方式 | `stdin_text is None` 为命令行调用；显式传入（含 `""`）为程序化调用，只决定输入来源与输出作用域，不决定退出码 | `main([], stdin_text="")` → 0，静默 |
| BC-03 归一化顺序 | 剥一个前导 BOM → CRLF→LF → 剩余 CR→LF | `'\ufeff\ufeffabc'` → 4 |
| BC-04 行边界 | 只有 LF、CR、CRLF | `'a\u2028b'` → 1 行、3 字符 |
| BC-05 行数口径 | 空串 0 行；末尾换行不开新行；纯空白行仍是行 | `'\n'` → 1、`'a'` → 1 |
| BC-06 非空行 | 与 `line_count` 同一次切分后 `str.strip()` | `'  \n\t\n'` → 2 / 0 |
| BC-07 字符数 | 归一化后码点数 | `'cafe\u0301'` → 5 |
| BC-08 单词 | `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*` 的匹配个数 | `'hello--world'` → 2 |
| BC-09 数字与下划线 | 不是单词字符，会切开字母片段 | `'a1b'` → 2、`'a_b'` → 2 |
| BC-10 非 ASCII 与组合记号 | 既非单词字符也非连接符 | `'cafe\u0301'` → 1 个词、5 个字符 |
| BC-11 连接符 | 两侧必须紧邻 ASCII 字母，一次只允许一个 | `'hello--world'` → 2 |
| BC-12 不做额外改写 | 不做 NFC/NFD、不折叠、不 trim；`\u00a0`、`\u3000` 原样保留 | `'cafe\u0301'` 不变成 `'caf\u00e9'` |
| BC-13 输出格式 | 4 行 `<key>: <value>`，顺序固定，无其它行 | 见上面的样例文件示例 |
| BC-14 宿主换行 | 只约束 4 个逻辑行；Windows 写出 CRLF 不算违规 | 按文本读入后 `splitlines()` 为 4 |
| BC-15 命令行 `--help` | 退出码 0，stdout 说明 PATH 与 `--encoding`；有 `--help` 时不再校验位置参数个数 | `python text_stats.py --help a.txt b.txt` → 0 |
| BC-16 程序化 `--help` | 退出码 0，两个流都不写 | `main(["--help"], stdin_text="")` → 0 |
| BC-17 五类受控错误 | 命令行：stdout 空 + 一行 `error: `；程序化：两流都空 | 退出码均为 1 |
| BC-18 编码校验 | `codecs.lookup` 校验先于输入选择 | `main(["--encoding","no-such-encoding"], stdin_text="")` → 1 |
| BC-19 程序化给 PATH | 真的读该文件；成功返回 0 且不输出统计，失败返回 1 且静默 | `main(["sample_input.txt"], stdin_text="")` → 0 |
| BC-20 程序化无 PATH | 注入文本即本次输入，不读进程标准输入 | 数值需另用 `count_text` 取得 |
| BC-21 命令行读 stdin | 由 `sys.stdin` 自身编码解码；`--encoding` 不作用于它；立即 EOF 为空文本 | 无 stdin 编码覆盖选项 |
| BC-22 文件解码 | 默认 UTF-8；`--encoding` 只作用于文件；保留原始换行 | `newline=""` |
| BC-23 两路径一致 | 同一份已解码文本，PATH 与 stdin 四项数值相同 | 20 / 2 / 2 / 4 |
| BC-24 argv 契约 | `None` 等价于 `sys.argv[1:]`，不含程序名；`main` 返回整数，函数内不调用 `sys.exit` | `main(["path.txt"])` 的 `path.txt` 是 PATH |
| BC-25 退出码集合 | 只有 `0`（成功与 `--help`）与 `1`（受控错误） | 无 `2` |
| BC-26 依赖边界 | 仅标准库，不联网，不新增依赖声明文件 | 无第三方 import |
| BC-27 写入边界 | 只改四个交付文件；临时文件只写 `.test-scratch/` 平铺层并自删 | 不新增其它写入 |
| BC-28 字节码边界 | 不新增、不改写 `__pycache__` 内文件 | `PYTHONDONTWRITEBYTECODE=1` |
| BC-29 样例文件 | `sample_input.txt` 恰 20 字节，内容为 `hello world\nfoo bar\n` | `char_count: 20` |
| BC-30 README 自洽 | 每条可复制示例的数值都与规则一致，编号均真实存在 | 第三方照抄即可复现 |
