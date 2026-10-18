# 发布版映射表（REDACTION-MAP）

本文件由本地重放工具生成，记录**逐字原件**与**发布版派生副本**之间的对应关系。

## 1. 范围与基线

- 公开基线（远端已存在的最后一个提交）：`029bdcc72543dbc2b10fb5195aae976ecad479a1`
- 未推送的源历史：`b2b48ab686c60e7d95f8513b3876b656818269a3`（44 个提交，含最终方案提交）
- 发布分支 tip（本文件提交前）：`687b391e43402d9e61b35912e626bb37eb77c0ab`
- 发布分支 = `029bdcc72543dbc2b10fb5195aae976ecad479a1` + 44 个重放提交 + 本文件所在提交；**不含**任何未脱敏提交。

## 2. 脱敏规则（字面值只保留在本地，不在本仓库出现）

| 编号 | 规则 | 替换为 |
| --- | --- | --- |
| R-1 | 本机用户主目录（盘符 + Users + 本机账户名，反斜杠/正斜杠/JSON 转义三种写法） | `<user-home>` |
| R-2 | 单独出现的本机账户名（5 位数字，路径片段内） | `<account-name>` |
| R-3 | 工作区绝对路径（盘符 + AI + TLA + 仓库目录名，三种写法） | `<repo-root>` |
| R-4 | 工作区父目录（盘符 + AI + TLA） | `<repo-parent>` |
| R-5 | 宿主安装目录绝对路径 | `<harness-install-dir>` |
| L-1 | 未推送提交的短/全 SHA 引用（文档与说明性文本内） | `[Cnn]` 标签 |

保留不动：`C:\tmp\…`、`C:\repo\…`、`C:\Windows\Temp`、`D:\Windows\Temp` 等**示意路径**（不含真实标识）。

## 3. 提交映射（旧 → 新）

| 标签 | 源提交 | 发布提交 | 主题 |
| --- | --- | --- | --- |
| C01 | `7d0337ae0e02` | `fdca14accb53` | docs(requirement) 落盘 P-1–P-6 的人工裁定与需求基线 |
| C02 | `abe636cdc95a` | `d88756268f4f` | feat(tools) 加固审批拒绝取证工具的判定规则 |
| C03 | `cab9e0207e6d` | `7caf13ad2611` | docs 同步审批拒绝取证 v2 与当前测试计数 |
| C04 | `866b2cf51680` | `93eac28298cd` | fix(workflow) 拒绝把全体跳过的测试当作通过 |
| C05 | `76cedd83ec64` | `d7a6a141943e` | fix(repro) 固定样本输入文件的行尾，并加入有界性质测试 |
| C06 | `b85ad75cca25` | `7143114c24e3` | docs 记录无人值守离线审查与两个缺陷修复 |
| C07 | `5cf770fe57a5` | `a102f610395b` | fix(tools): 收紧取证判据并把审批操作绑定到被观察目标 |
| C08 | `3fdc11721bba` | `74377d87fcfe` | docs: 记录复审修复、更正被夸大的证明范围 |
| C09 | `48c1ce5e93d4` | `00eb306f24b4` | fix(tools): 收紧取证判据并改用排他创建的目标操作 |
| C10 | `b608d43c3325` | `8d2ff6ebec35` | docs: 同步取证 v4 的判据、计数与证明边界 |
| C11 | `208540376f28` | `e21e425dea7f` | docs(evidence) 归档人工审批拒绝测试的现场与执行记录 |
| C12 | `9d81c6e67992` | `6ccd07a5781f` | docs: 汇总 V0.1 演示任务需求输入候选稿 v0.2-demo-input-1 |
| C13 | `1ad8f234bc0d` | `6b61e6ff98ce` | docs: 记录需求输入候选稿的 Q2/Q3 确认与 Q1 待读状态 |
| C14 | `26e90f82a772` | `5e629ce65745` | fix(text-stats): keep programmatic calls silent on help and error paths |
| C15 | `bff253bc213f` | `599665d341e6` | docs(requirements): add v2 candidate input superseding v1 |
| C16 | `ee3e89e611a6` | `85a004e5e9d3` | docs(requirements): tighten R-07, R-13, R-29 and R-33 wording |
| C17 | `8b2df2804bbe` | `910a81100795` | feat(text-stats): deliver the v0.2-run1 real-pipeline result with its evidence |
| C18 | `3efdd6a67f31` | `186cf5788286` | docs(status): record the v0.2-run1 run, its limits and the Q1 approval |
| C19 | `289714c90bb1` | `87f9694c2cca` | docs(review): add the v0.2-run1 review package and make it byte-recomputable |
| C20 | `a11ae9e4dca9` | `d8de327a7447` | docs(review): untrack the 8b2df28 review package |
| C21 | `d6ae4609758b` | `92863f4951e2` | feat(workflow): make the bytecode write boundary a hard gate |
| C22 | `64942877cdb2` | `5bac86373590` | docs(records): record the AC-24 correction and the v0.2-run1 review materials |
| C23 | `7d57a3fd1e2e` | `a261fb76d1c7` | test(review): reject wrong-typed criteria in the self-test |
| C24 | `847225111de1` | `1ea7066246a7` | test(review): treat record directories as records, keep the check count stable |
| C25 | `e59467b82194` | `34ec7debb6f0` | docs(workflow): gate the run on a whole-run bytecode cache ledger and stop review output from overwriting archives |
| C26 | `8111352e785e` | `d912825036b0` | fix(workflow): judge bytecode rewrites by content identity |
| C27 | `3a61fc990777` | `9eb4469fd042` | docs(roadmap): register multi-model and budget requirements with a study |
| C28 | `3272876be1f1` | `5645bce124e2` | fix(workflow): cap subagent calls and account for usage offline |
| C29 | `3da7172974c7` | `bb410b2633e8` | fix(tools): derive attempt rounds in the usage report |
| C30 | `d6ff484e1fcf` | `b12844da895a` | fix(workflow): close the cache boundary verdict outside the run |
| C31 | `b16d65950b4b` | `8d3ef9e03970` | fix(workflow): detect inline script drift before spending calls |
| C32 | `ad52050d0cd1` | `bce467406ddf` | feat(tools): check the inline script payload before spending calls |
| C33 | `9b03fd41e5e8` | `b439bb1d484f` | docs(run3): archive the pre-flight check that replaces hand transcription |
| C34 | `88b332d715b2` | `46daea778e88` | docs(run4): archive the pre-flight abort caused by an absolute owner-marker path |
| C35 | `c319b5b53e2c` | `bbaa0de474c1` | chore(gitattributes): keep evidence and run-record bytes verbatim on checkout |
| C36 | `371cb1bb926b` | `cbc482a9107b` | docs(run4): record the byte-fidelity check of the exported archive |
| C37 | `0e3490eb38d7` | `d8746fc27f0b` | fix(workflow): accept an absolute owner-marker path that resolves to the same file |
| C38 | `4870e22117ce` | `a7f5628733aa` | docs(run5): archive the first clean five-agent run |
| C39 | `54a19d99c1c8` | `715103a2d2cf` | feat(text-stats): apply the run5 delivery pending human review |
| C40 | `c6b30b9dfb71` | `425eb500be97` | docs(review): replace the run5 verifier with a proof-carrying one |
| C41 | `0c38d72c8026` | `010c1751e00e` | docs(review): move the run5 acceptance package into run-records and close the R-35/R-29 gaps |
| C42 | `06e9f3ffdb62` | `8eeef3a120e3` | docs(acceptance): record the owner acceptance of the demo function |
| C43 | `1125cbcaa0e2` | `028b98be1069` | docs: record the pre-publication check and align the documented test counts |
| C44 | `b2b48ab686c6` | `687b391e4340` | docs: plan the minimal redaction before publishing |

## 4. 文件映射（原件 → 派生副本）

只列**字节发生变化**的文件。`原件` 指本地档案分支 `archive/v0.1-verbatim` 里的字节；`派生` 指本发布分支的字节。

| 文件 | 原件 sha256 | 派生 sha256 | 字节（原→派） | 触发规则 |
| --- | --- | --- | --- | --- |
| `docs/ARCHITECTURE.md` | `9b47f9430377b1325e52f611e7c2ed129bcdd4b4cb87aa274ac1c7cdef687034` | `a133ee34f9113cccab57306f5fe4b0e818a52f5ffe1931e0182203b6f46526a0` | 41157 → 41156 | harness-install×1 |
| `docs/PUBLICATION-READINESS-v0.1.md` | `69c10475eeab062841f5ba47f8dcd8e6430c2914257042c4d220845cd02aa69a` | `8b13e9eb881c33d3bda3bd0fd52cde52885f1c59d5241beabc2e685746837a40` | 25793 → 25652 | repo-parent×2 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/README.md` | `1bdd15f190095f41867e1c9d1e6c375671c6fa54523ca3d1508b08eead529ca3` | `3b17e09f588fa4fde704618b4cc501781b96cd33174e6407ab41778ba952eaec` | 7539 → 7508 | repo-parent×1 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/commands.log` | `63957f22c09337d443151633d094748cc9399f8ba79f008309eb7d8cad5d1787` | `0813ac508d02e39f431bb1dcb238261abc98a339d1e4996a83d4c730e660db6c` | 308 → 260 | repo-root×2 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/human-observation.md` | `93d8d7d023f19d64cc936a00665d4b9a47ae5150e99b99a648fe9bb417df0f31` | `97d5f9b4aa706abebb5e59c854aa38d4b4d64f371cd974e78e02f082f9761448` | 2719 → 2723 | repo-parent×1 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/redacted/approval-evidence.redacted.json` | `f3dcec961a70ac79e7502f3b3ca005c402ead4ce2f9cf346d0db5aadd4201533` | `2432651a36c0e4d8858d9da338687edf763aed13e1329fdbae11ff3f2b27cfce` | 3126 → 3105 | repo-parent×3, repo-root×1 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/redacted/state-after.redacted.json` | `9ade6b3e70e61abcb1287a231dbde3dd76604979e16bd20861bef488ff467f5b` | `1a8395841b49931981b40e6597fd0d8646ee430def2925bcfb032f9d3ac236bc` | 42192 → 42171 | repo-parent×3, repo-root×1 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/redacted/state-before.redacted.json` | `8b6808812395173e7a3db43300975aed16afaeb849726fa42702341393cfa8c1` | `2e0d466cacf262b970971c7c550ce4d72678ed994d6f51e727a1d680543e97da` | 41946 → 41925 | repo-parent×3, repo-root×1 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/run-inputs.json` | `bb5552cd3d1f49035f9c4fe97439ec26b2f231a87a429e92629cef3062140503` | `846fabe91956c684d6724c369350e8f33a5dccea5839d22e6b486019a41fcceb` | 1067 → 1071 | repo-parent×2 |
| `docs/evidence/v0.1-approval-rejection-20261017T112518Z/verification.json` | `22b8249244d6ee6927a724dc81859c29a40dd0bd15034b52bf74dc724845b6eb` | `2fd43a20268b769ef6b45e053e03aed5d978e49cb2a7682c91a9db35b95368c9` | 956 → 929 | repo-root×1 |
| `docs/evidence/v0.2-run1-20261017T121445Z/preflight.json` | `5850288c50c05b3d8ad4de4b81c117604c6b309b3852f23a28c16a34049a92b0` | `bb99e2997aca7d6a0ebff651645a1de126037c70066d1aeb23bf8392d5f5c596` | 2140 → 1789 | repo-root×13 |
| `docs/evidence/v0.2-run2-20261017T133204Z/preflight.json` | `e300c81ccd6af0d410edd52779da077e7907142fb6d76448f38735850e3eb987` | `eaefd05b012227862176b70ef9ae7c12b11266d1759fcd80340a00795a4912fe` | 2043 → 1692 | repo-root×13 |
| `docs/evidence/v0.2-run2-20261017T133204Z/verify-revision-2.json` | `c3f6bd04233be7586f1ca7f16ad298ddf423ce5345e906f3399ae7b9d68e9d85` | `5ef777cac883fb717e544771f1d89091aac5b1b7bc2ee6137aee2ac27031ceb9` | 3321 → 3297 | repo-root×1 |
| `docs/evidence/v0.2-run2-20261017T133204Z/verify.json` | `c5c1c66d4b3c952fde0e70e11290234bb8124511df310aaa9660b92539b13273` | `3855f98a9d636499f947c81b99d7e865c025cd4d824cdd90befcaa0978626542` | 1603 → 1579 | repo-root×1 |
| `docs/evidence/v0.3-run3-20261017T151029Z/preflight.json` | `be171c45d9ee4f8c40285062761bb587f92eef1929ce1d133e4518a70e419b90` | `ccc20aa30140c1e2a7ec5fe8addce4a28a9a444a472476d33397d78f49a0436f` | 2841 → 2217 | repo-root×26 |
| `docs/evidence/v0.3-run3-20261017T151029Z/verify.json` | `927ef0c8365f60510b121ad904145ed9c5ff24a5e19389a57bac149ce6a26fd5` | `84fd48c2fd33947359102027efc518c3472a2cf2edbfc07ac64c237aa24d28e1` | 2713 → 2689 | repo-root×1 |
| `docs/evidence/v0.4-run4-20261017T155454Z/preflight.json` | `114fcc96f838aca6a78e8ea7db90b4be6bc1e96ea220e98225073e8b708e37e2` | `62116ea89a1266ec82fa8a07617a0147aad5f629d9675ce8921228b52f024a9f` | 2921 → 2300 | repo-root×23 |
| `docs/evidence/v0.4-run5-20261017T161034Z/preflight.json` | `30309100712d56b1c90aaea0f2af80e341a77153ccace00ea58df55f4cf88db0` | `77991c7b8a2127192d07d001b7260ee41e9c00378d555a5cd029182c16e371a4` | 2503 → 1990 | repo-root×19 |
| `docs/run-records/v0.2-run1-20261017T121445Z/precheck.json` | `e1277f5acc9f4e13b2808b6831b49ab49ed133f40d5a0e1ab17c38aa6acbb38a` | `2a070fde80f9b8153eef395f8e5f0f3e4da6b83b3005225b7cd8dc4658a1a144` | 3606 → 3579 | repo-root×1 |
| `docs/run-records/v0.2-run1-20261017T121445Z/review-package/test-output/08-preflight-claim.txt` | `1604c3ad606d0a61b812b64059e079309a0954566ae87dba63280caba8fbb190` | `df19bad5cb229047a7c562b8706c1e85a83c0a365d25b36afca33f5a740ace58` | 1042 → 1039 | user-home×1 |
| `docs/run-records/v0.2-run2-20261017T133204Z/review-package/json/probe.json` | `f32acc28eb85fb01c26c703e5da554798687e6c3b0c8996405be35293a31c3de` | `de61788da43e7bb9b249f7dd8075870ba13eadfff4bf2bc0e4673aef73bdd7eb` | 33876 → 33849 | repo-root×1 |
| `docs/run-records/v0.2-run2-20261017T133204Z/review-package/text/12-tests-unittest.txt` | `b1e8c2a0f9e47695cea40a2bca6eb6d21177bcc295630e58fccb19ad761475f9` | `2cc8d31f78008145d41d7353df963005e43e8caf8a49fcd00bb07a36d7ec14dd` | 562 → 538 | repo-root×1 |
| `docs/run-records/v0.4-run4-20261017T155454Z/run-aborted.md` | `b1b26a75172409b5923c2481d03a14657aaaa3a43d07f2b9cb557407a493cc5f` | `446c2d73ab961a87fd8c1301a30223db2e3ff88e0fb8fc2889c3e87f49ff3948` | 11191 → 11135 | repo-root×2 |
| `docs/run-records/v0.4-run5-20261017T161034Z/review-package/MAINTENANCE.md` | `936a28233eff8a5b22b28ab4ec670fbcc5751840461a58c7c170b8aa2284ce86` | `6c09d03d7d066e612a3de8dda36d4bed8dd67563f7883dc7d559881f69c1f60c` | 2870 → 2833 | repo-root×1, user-home×1 |
| `docs/run-records/v0.4-run5-20261017T161034Z/review-package/self-test.json` | `e9dacb96c728abb27d869ecb3afd53c8d529742b5499337b274b8dce869926f4` | `17b1f169376004afae9742c980409e0df43ffa6fd0a032fad878954e92c5d367` | 4276 → 4249 | repo-root×1 |
| `docs/run-records/v0.4-run5-20261017T161034Z/usage/extraction-metadata.json` | `74787187b46df3d91bd94edffd9c5e3da9a5c76fff2600a5d4c12e39700161df` | `fdb38a4c3fbc5d68719db502efc0b32d6864484607d5b8d250e5e36277dfdeff` | 14235 → 14244 | account-name×1 |

另有 28 个文件仅因提交 SHA 改写为标签而变化（无标识替换），完整清单见 `PUBLISHED-SHA256SUMS.txt` 与本目录生成记录。

## 5. 清单同步与自引用边界

- 受影响的清单（`EVIDENCE-MANIFEST.json`、各 `SHA256SUMS.txt`）已按派生字节重新计算；每个提交的树内清单与树内容自洽（本地校验 151 条记录 0 不一致）。
- 本文件**不记录自身哈希**；`PUBLISHED-SHA256SUMS.txt` 记录全树（除自身）的派生哈希，故不存在自引用循环。
- `docs/evidence/**` 里形如 `repo_head`、`change_scope.base/delivery` 的**历史版本字段保持原值**（它们是当时运行的记录），其旧 SHA 与新 SHA 的对应见 §3。
- 中间提交曾临时包含 `docs/review/**` 审查包（其后被移出），发布历史保留该事实；发布分支 tip 的树中不含 `docs/review/`。

## 6. 明确边界

- 发布分支里的证据文件是**脱敏重发副本**，不是运行工具当时写出的字节；逐字原件只存在于本地 `archive/v0.1-verbatim` 标签（未推送）。
- 清单里的哈希是**重新计算**的结果，不能表述为「原运行生成」。
- 28 项复核中的 AC-29 使用发布版真实交付提交及其父提交作为锚点；命令示例中的提交号请按 §3 查表替换。
