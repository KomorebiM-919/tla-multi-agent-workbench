# 发布版说明（v0.1 演示功能）

本目录说明这个分支与本地逐字原件之间的关系，以及如何复核。**发布版不是逐字原件**。

## 1. 两个版本

| 版本 | 位置 | 特征 |
| --- | --- | --- |
| 逐字原件 | 仓库所有者的本地归档（`archive/v0.1-verbatim` 标签，未推送） | 运行工具当时写出的字节，含本机路径与账户名 |
| 发布版 | 本分支 | 本机标识已替换为占位符；清单按派生字节重算；提交 SHA 与原件不同 |

## 2. 为什么这样做

远端已存在的基线是 `029bdcc72543dbc2b10fb5195aae976ecad479a1`；其后的 44 个提交尚未推送，且其中含有本机账户名与工作区绝对路径。
把发布版的基线定在该提交上，可以做到三件事同时成立：不改写远端历史、不需要强推、公开树里不含真实本机标识。

## 3. 如何复核

```powershell
# 1) 交付测试（97 例）
python -m unittest discover -s examples/text-stats -p "test_*.py"

# 2) 编排逻辑回归（114 场景 / 547 断言）
node tests/workflow-logic.test.mjs

# 3) run5 复核工具自检（19 个反例）
python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py --self-test

# 4) run5 的 28 项检查：锚点用发布版真实提交（查 REDACTION-MAP.md §3 的 C39 与它的父提交）
python docs/run-records/v0.4-run5-20261017T161034Z/review-package/verify-run5.py --repo . --base <C39^> --delivery <C39>

# 5) 全树哈希：按 PUBLISHED-SHA256SUMS.txt 逐行比对，例如
Get-Content docs/PUBLICATION/PUBLISHED-SHA256SUMS.txt | ForEach-Object { $h,$p = $_ -split '  ',2; if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() -ne $h){ $p } }
```

## 4. 能证明什么、不能证明什么

能证明：代码与工作流在发布版字节上通过上述检查；证据与清单在发布版内部自洽；逐文件的原件→派生对应关系可查。

不能证明：发布版证据文件与当时运行输出逐字节相同（它们是脱敏副本）；清单里的哈希是当时运行产物（它们是重算值）；
以及任何以原件字节为前提的结论——那需要在所有者本地归档上复核。

## 5. 未改变的边界

- 本分支不合并 `main`，不代表 V0.1 五条验收条件的整体重判，也不代表整个多模型平台开发完成。
- 证据 JSON 里的历史版本字段（运行时的提交号）保持原样，映射见 `REDACTION-MAP.md` §3。
