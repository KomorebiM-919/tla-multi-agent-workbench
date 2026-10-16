# text-stats

仅使用 Python 标准库的文本统计命令行工具。输入一段文本（文件或标准输入），输出四项统计结果。

## 统计规则

| 指标 | 含义 | 依据 |
| --- | --- | --- |
| `char_count` | 归一化后文本的字符数（`len(str)`，即 Unicode 码点数，不按字节、不按显示宽度） | BC-01 |
| `line_count` | 空字符串为 0；否则为归一化文本按 `\n` 切分所得的片段个数（结尾换行不产生额外空行） | BC-03 |
| `non_empty_line_count` | 去掉换行后仍含非空白字符的行数（空白定义同 `str.strip()`，含 `\u3000`、`\u00a0`） | BC-04 |
| `word_count` | ASCII 字母（`a-z`、`A-Z`）构成的最大连续片段个数；单个内部 `-`、`'`、`'` 可连接两段字母仍算 1 个词 | BC-06 … BC-10 |

处理细节：

- **换行归一化**：统计前把 `\r\n` 与 `\r` 都替换为 `\n`，因此 `\r\n` 在 `char_count` 中只计 1 个字符。
- **BOM 剥离**：解码后若文本以 `\ufeff`（UTF-8 BOM）开头，先剥离该字符再统计，BOM 不计入 `char_count`。
- **数字、下划线、非 ASCII 字母**都不是单词字符，会把字母片段切开：`a_b` → 2，`café` → 1，`中文` → 0。
- **纯函数与命令行同一口径**：命令行路径复用 `count_text`，不存在两套口径。

## 命令行用法

```text
python text_stats.py [PATH] [--encoding NAME]
```

- 给出 `PATH` 时读取该文件；省略时从标准输入读取全部文本。
- 默认按 UTF-8 解码，`--encoding` 可覆盖（未知编码名按错误处理）。

### 可直接复制的示例

```console
$ python text_stats.py sample_input.txt
char_count: 20
line_count: 2
non_empty_line_count: 2
word_count: 4
```

从标准输入读取：

```console
$ printf 'hello world\n' | python text_stats.py
char_count: 12
line_count: 1
non_empty_line_count: 1
word_count: 2
```

错误路径（文件不存在、目录、权限不足、解码失败、未知编码）向标准错误输出一行以 `error: ` 开头的英文消息，标准输出为空，退出码为 `1`。

## 测试

```console
$ python -m unittest discover -s examples/text-stats -p "test_*.py"
```

在交付目录内运行（等价写法）：

```console
$ cd examples/text-stats
$ python -m unittest discover -p "test_*.py"
```

测试仅依赖标准库 `unittest`，覆盖 BC-01 至 BC-15 每条边界条件，并通过真实子进程校验命令行入口、退出码与四行输出格式。

> 测试需要交付目录内已存在 `.test-scratch/` 目录（仓库中已保留占位文件），用于写入临时输入文件；测试结束会删除写入的文件。
> 该目录已被交付目录内的 `.gitignore` 忽略，不会进入版本库。测试只在该目录下写**平铺文件**、不新建子目录：DSH 沙箱禁止向本次运行中新建的目录写入文件，也禁止写入工作区之外（含系统临时目录）。
> 该目录内另有 12 个 v0.1 初版遗留、被沙箱权限锁定而无法删除的 `tmp*` 子目录，详见 `docs/evidence/v0.1-first-run/coding-report-revision-2.json`。

## 需求内部矛盾说明

需求文档有两处自相矛盾之处，本实现按 `boundary_conditions` 的规范条文执行，并在 `test_text_stats.py` 中以
`TestSpecificationConflicts` 固定当前行为：

1. **结尾换行后的行数**：AC-02/AC-06 声称 `'hello world\nfoo bar\n'` 的 `line_count` 为 3，但 BC-03 明文规定“以换行结尾不产生额外的空行”（`'a\n'` → 1），AC-07 对同样带结尾换行的输入也要求 1。遵循 BC-03，该输入为 2 行。
2. **非 ASCII 重音字母的单词数**：AC-05 断言 `'cafe\u0301'` 的 `word_count` 为 2，但 BC-09 对等价写法 `'café'` 断言 1，且 BC-06 规定的正则 `[A-Za-z]+` 对两者都只能得到 1。遵循 BC-06/BC-09，两者均为 1。
