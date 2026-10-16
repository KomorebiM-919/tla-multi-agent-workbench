# text-stats

仅使用 Python 标准库的文本统计命令行工具。输入一段文本（文件或标准输入），输出四项统计结果。

## 统计规则

四项口径完全由本文档引用的规范条文（BC 编号）唯一确定，实现、测试与文档三处数值一致。

| 指标 | 含义 | 依据 |
| --- | --- | --- |
| `char_count` | 归一化后文本的字符数（`len(str)`，即 Unicode 码点数；不按字节、不按字形簇、不按显示宽度） | BC-01、BC-02 |
| `line_count` | 归一化文本的行数，等于 `len(text.splitlines())`；空串为 0，以换行结尾不产生额外空行 | BC-03 |
| `non_empty_line_count` | 各行中 `strip()` 后仍含字符的行数（空白定义同 `str.strip()`，含全角空格 `\u3000`、不换行空格 `\u00a0`） | BC-04、BC-05 |
| `word_count` | 满足 `[A-Za-z]+(?:[-'\u2019][A-Za-z]+)*` 的片段个数 | BC-06 … BC-10 |

处理细节：

- **换行归一化**（BC-02）：统计前先把 `\r\n` 替换为 `\n`，再把剩余的 `\r` 替换为 `\n`；其它字符一律不改写，因此 U+2028、U+2029、`\x0b`、`\x0c`、`\x85` 都不产生新行。`\r\n` 在 `char_count` 中只计 1 个字符。
- **行数判定表**（BC-03）：`''` → 0；`'\n'` → 1；`'a\n'` → 1；`'a'` → 1；`'a\nb'` → 2；`'a\n\n'` → 2；`'hello world\nfoo bar\n'` → 2；`'hello world\nfoo bar\n\n'` → 3。
- **BOM 剥离**（BC-01、BC-11）：解码后若文本以单个 `\ufeff`（UTF-8 BOM）开头，先剥离该字符再统计，BOM 不计入 `char_count`。
- **单词字符集**（BC-06、BC-10）：只有 ASCII 字母 `a-z`、`A-Z` 是单词字符；ASCII 数字、下划线 `_`、非 ASCII 字母（`é`、`中` 等）与组合用记号（如 U+0301）都不是，会把字母片段切开。`abc123` → 1，`a1b` → 2，`a_b` → 2，`foo_bar baz` → 3，`123 456` → 0。
- **大小写**（BC-07）：不做小写化归并，每个 `[A-Za-z]+` 片段各计 1 个词，`Hello hello HELLO` → 3。
- **连接符**（BC-08、BC-09）：只有三种连接符能把两个字母片段连成 1 个词 —— ASCII 连字符 `-`、ASCII 撇号 `'`（U+0027）与右单引号 `\u2019`（U+2019）；连接符两侧必须都紧邻 ASCII 字母，且一次只允许一个连接符。`well-known` → 1，`don't` → 1，`it\u2019s` → 1，`a-b-c` → 1，但 `hello--world` → 2（连续两个连接符不连接）。非 ASCII 字母与组合记号不能充当连接符：`caf\u00e9-mocha` → 2，`cafe\u0301` → 1。
- **纯函数与命令行同一口径**（BC-15）：命令行路径复用 `count_text`，不存在两套口径。

## 命令行用法

```text
python text_stats.py [PATH] [--encoding NAME]
```

- 给出 `PATH` 时读取该文件；省略时从标准输入读取全部文本。
- 默认按 UTF-8 解码，`--encoding` 可覆盖（未知编码名按错误处理）。
- 位置参数最多 1 个（BC-14）；给出 2 个及以上属用法错误。

## 退出码约定

| 情形 | 退出码 | 标准输出 | 标准错误 |
| --- | --- | --- | --- |
| 成功 | `0` | 恰好 4 行 `key: value`（BC-12） | 无 |
| 任何错误（BC-13、BC-14） | `1` | 空 | 至少一行以 `error: ` 开头的英文消息 |

错误情形包括：位置参数多于 1 个、文件不存在 / 是目录 / 不可读、解码失败、`--encoding` 指定的编码名未知。错误时不会抛出未捕获异常，也不会打印 traceback。

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

测试仅依赖标准库 `unittest`，覆盖 BC-01 至 BC-19 每条边界条件，并通过真实子进程校验命令行入口、退出码与四行输出格式。

> 测试需要交付目录内已存在 `.test-scratch/` 目录（仓库中已保留占位文件），用于写入临时输入文件；测试结束会删除写入的文件。
> 该目录已被交付目录内的 `.gitignore` 忽略，不会进入版本库。测试只在该目录下写**平铺文件**、不新建子目录：DSH 沙箱禁止向本次运行中新建的目录写入文件，也禁止写入工作区之外（含系统临时目录）。
> 该目录内另有 12 个 v0.1 初版遗留、被沙箱权限锁定而无法删除的 `tmp*` 子目录，清理需要人工处理 ACL，详见 `docs/evidence/v0.1-first-run/coding-report-revision-2.json`。

## 规范优先级

本目录内历史文档或历史测试若与本轮 `boundary_conditions`（BC-01 至 BC-19）冲突，一律以本轮规范为准，
冲突值已在实现、测试与文档中一并修正（BC-17、BC-18）：

1. **结尾换行后的行数**：`line_count` 只有一套口径，即 `len(text.splitlines())`（BC-03）。`'hello world\nfoo bar\n'` 为 2 行、`'hello world\nfoo bar\n\n'` 为 3 行；不再存在“以换行结尾算 3 行”的第二种说法。
2. **组合重音字符的单词数**：`'cafe\u0301'` 与 `'caf\u00e9'` 均为 1 个词，`char_count` 分别为 5 与 4（BC-06、BC-09）；不再存在断言为 2 的写法。
3. **用法错误的退出码**：位置参数多于 1 个时退出码为 `1`，不使用 argparse 的默认退出码 `2`（BC-14）。
