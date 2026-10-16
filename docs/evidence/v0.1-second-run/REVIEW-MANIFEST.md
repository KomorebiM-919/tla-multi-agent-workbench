# REVIEW-MANIFEST — 审查材料清单与逐文件哈希

本清单由 `make-review-manifest.py` 生成（只用 Python 标准库）。哈希口径：**提交内容**——`core.autocrlf=true` 时 git 会先把工作区的 CRLF 规范化成 LF 再入库，
所以字节数与哈希都在 LF 规范化后的字节上计算，可直接与 `git rev-parse HEAD:<path>` / `git cat-file blob HEAD:<path>` 比对；
最后一列给出工作区磁盘上的 CRLF 行数（非 0 表示磁盘字节与提交内容不同，仅影响"对磁盘文件直接算哈希"的场景）。

## 1. 当前工作树（即将提交的审查材料）

| 文件 | 字节数（提交内容） | sha256（提交内容） | git blob SHA-1 | 磁盘 CRLF 行数 |
| --- | --- | --- | --- | --- |
| `README.md` | 11689 | `c62f279d90edaad8a9b3037717e1bb69ede743e592b132c183621482b67d5e4a` | `55f2a420b78df968562e79e69b3ecdda7ad79f48` | 131 |
| `docs/ARCHITECTURE.md` | 37091 | `14f4b55251ffa8de40acfafc4b25ad38f8a700448af0d3fff5bae0679b0af6fe` | `f0898c45c594ee3f1ab2a664ae7c35b434569c0d` | 238 |
| `docs/ROADMAP.md` | 14735 | `ca59a949763bd3af8a9089951d381f8e25f960658b90a4812ff763d5ae10dfc4` | `2bf3108b876b4834f6b95a95a32231b8ce970e7f` | 112 |
| `workflows/three-agent-mvp.js` | 78156 | `0c9dd05296e6b6f47f1e16ecfbef7ecf9a681c83419966c07ad92be8a5517c6f` | `a2663595d5ad6def7bb1cbc169783c6026338529` | 0 |
| `workflows/README.md` | 11522 | `84d5108b37d135e175de3172d912329142c9f745d2d4e7b411f17e5d5579c30e` | `1196385fcf24ae3c81213691b264d78aa52b4c47` | 0 |
| `tests/workflow-logic.test.mjs` | 29582 | `da8019ba5cd21a955453d9f1ae98a3392dd089379c71d428d565d557a01b9b3c` | `68fbee62b2f420ae4cdbe35ab369bad8b27eb236` | 0 |
| `tests/README.md` | 5358 | `ccc3612c90af8346bf7cf72b96a9ea2beab52b5ab7da27479b7d035f21f7bb07` | `626c04bd7afa07a2422ace53037362bd23c9902b` | 0 |
| `agents/README.md` | 3153 | `23dde7f5e132ea6405634f47614b45aeea3494d1e25196ddcaf5e5b7604797a6` | `2eff33d59902f7618e8529f87497e7435145ac96` | 0 |
| `agents/requirement-agent.md` | 7351 | `baad1b0a1c5cafc1ac9cf4c0c565dbb82826728656f3c08c154666d0b125692d` | `c8a9faeb09c1664d6b6df1900a457b9455db9ff5` | 0 |
| `agents/coding-agent.md` | 4875 | `eaed7c901da7e7d1ffbad474bb0d7fdae98289270daddf1f73acc7a094d7194f` | `663136309aa59feab2e7344ea5a9782c5dcb9275` | 0 |
| `agents/review-agent.md` | 5793 | `6f070b182cdb9986c73de6c65abf5e176a6cb875c0dba30f18a2a21e981b8364` | `d1ec7c892ead8278980395699bd29d594cba547c` | 0 |
| `agents/verifier-agent.md` | 5019 | `e0fbd0e29d45d43bc093112eaab057fe39cf012ae0ab44e0f85cfb29db66bf7e` | `6ce32c773fb9f1c339d8095f068bc66591a4772d` | 0 |
| `examples/text-stats/text_stats.py` | 11184 | `56fdd9449b4c7b28b427515840e14480cfb352f7795796953ad9086190bc7990` | `1665a6f5a51558d4ef1618c189f226eb75c2ef74` | 0 |
| `examples/text-stats/test_text_stats.py` | 30828 | `39892a7d96ec0f3177c06ccc01bb06e62ab30c4df413277b7c9a18bceb8aa84e` | `4daaedb407205ab591019b4f76e75f1ad1eccfb4` | 0 |
| `examples/text-stats/README.md` | 10267 | `e03fcdc2a180c8fa499b6c0ae8fcb67e0b12752cb511c8d448a290ddb0bfdb3b` | `78e2538ad8f367001d132dcca29281edff7a7f08` | 0 |
| `examples/text-stats/sample_input.txt` | 20 | `d1346fe09eb87e961fcbcd26071c9751e459bcf2e7bbd4e73a732b8ebc8a9f83` | `02ded1879ab080e0cb988837f4a0eaf70d6367ac` | 0 |
| `examples/text-stats/.gitignore` | 344 | `42bfd63261a31d246dbd30c117b722d03b926dbaaabee355d032ac176b54099d` | `c01fa046ccd71e7575c8dec54800d9022fe945bd` | 7 |
| `docs/REQUIREMENT-CALIBER.md` | 8779 | `d2a6cd3b8168f0da16726a20f620c81eb4bcf9f5a2b4ce382e85a96f4310ae68` | `1f28a785464a8436477b799eccf0a5e958d2ec1b` | 0 |
| `docs/evidence/v0.1-first-run/README.md` | 8991 | `5e028483620c3389afcb8e5d39cebb40ebeca7eb852dbd5c916eadd2ab0b9278` | `d378205502247602a5527d39dd098ba5432e73ed` | 0 |
| `docs/evidence/v0.1-first-run/coding-report-revision-2.json` | 11820 | `0d9b95eaa6ecd4ebedb41ef1c693093814da0f8a0fa9e20d610f2c089de15b56` | `33dd2d29e194ce3a59bd12242bdaf09a6a509f30` | 0 |
| `docs/evidence/v0.1-first-run/coding-report.json` | 9594 | `5ea8beac33ba31d7c519ee359af8c4c51d43b9891847724774752a1a2376bdc4` | `d22d39fd66c80c52d69c66ae6e2b32a4885a1b40` | 0 |
| `docs/evidence/v0.1-first-run/orchestrator-verification-output.txt` | 3723 | `e30cf39ab286efed515aed24ab38970eca9351580b99a6e6a0f8dfb8c80dfe01` | `6fd1a5c721c881fd492054f757fabb70f6a5c3aa` | 58 |
| `docs/evidence/v0.1-first-run/orchestrator-verification.py` | 7075 | `20880882f54dd57edd5b036a789828634f70e295795828e408be8a15546e78a1` | `3502c1d3dba7347da330f6439478d5b7651989bb` | 0 |
| `docs/evidence/v0.1-first-run/requirement.json` | 14432 | `a823053270a4e0ee3344aec711f53f0c5180441cbc3039246c4fd9be069200b7` | `95282f93331b945b547754ca63ea849d2cce9b46` | 0 |
| `docs/evidence/v0.1-first-run/review-revision-2.json` | 15569 | `1da3ca2ed5a18fd9486805106530be56145258e39404b304cb68bf250b4d08f9` | `6e58d053d113d0754f5fe8048a4bfe526085335d` | 0 |
| `docs/evidence/v0.1-first-run/review.json` | 14140 | `b05952400b2b480cf0efff6ad6a335035456cae30e21968213c17624a8bb1cbb` | `afd411a646344b5d89aefb123ad5b77cd3b16850` | 106 |
| `docs/evidence/v0.1-first-run/test-output.txt` | 5459 | `595c5d5eee274619f1099382b5f4fe07dc4d65b92e144177d30971a50578a2c7` | `c8211860a0bb4efc27b64ada99f91894083e7a12` | 75 |
| `docs/evidence/v0.1-run3-20261016T150153Z/.run-owner.json` | 182 | `97bf5020b777276144c0d4f52563a7a7507d29eaa9ad2a09ceaf865a55b54d54` | `54820e111b69c2db28b7cf0d77130be4572ae1d3` | 5 |
| `docs/evidence/v0.1-run3-20261016T150153Z/preflight.json` | 6955 | `c86e42886d6bc80ca7b63cfd661446b86d9865b8808ab803d4ea4fd51062aecb` | `e0c13437b39e01f4444186a23b4f878e6fe29255` | 0 |
| `docs/evidence/v0.1-run3-20261016T150153Z/requirement.json` | 23265 | `b1861ea12d1e637315d2e61893f3da0c333df25e9c3e8183dab8e4e9d7d09150` | `06ac91cd0608c86aba1d84a39511ab3c6987daea` | 0 |
| `docs/evidence/v0.1-run4-20261016T150809Z/.run-owner.json` | 186 | `a1a90c02859add89078bab22f5200b6498cea9bec9bae1f874d2a5ee21785c4f` | `2bd9c859468610a0f45a4035f4d41751f62e2828` | 6 |
| `docs/evidence/v0.1-run4-20261016T150809Z/preflight.json` | 8647 | `8af3190324fb98f8f1ee4d8c8ad5f5e472c9c28e1039660244d5381fd42da55b` | `f9e6443512336ff19729aea6697bfe690d51c27a` | 0 |
| `docs/evidence/v0.1-run4-20261016T150809Z/requirement.json` | 20198 | `21db16f7d9742092dd6981aa18b776a0e2af40adaff8647bbea0d81ca819d1ea` | `827fa14a3df5182045404d2923ab3e750e816b3d` | 0 |
| `docs/evidence/v0.1-run4-20261016T150809Z/review.json` | 17920 | `bb8cb38bedf96af0a92554889631ed6b0e4a94989e80c5dd12199f2d3874aa53` | `9dc3defce79a3c8f4b8f629a5fd9eccb67d2d733` | 0 |
| `docs/evidence/v0.1-run4-20261016T150809Z/verify.json` | 2735 | `ecdd19eaba12c6b59c6af561a77e252c020996744b1f3446447899fefb355acc` | `c746e3366a5082a425fb4a9688a4c25ce1c4d065` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/.run-owner.json` | 182 | `c6ffb01036ebcaf081183a639ab39215d45f43822f9bb6bcdb2f4200a4c95380` | `b385f74d0d100d767b4dd54551edbf835fb99e8c` | 5 |
| `docs/evidence/v0.1-run5-20261016T152321Z/coding-report.json` | 11654 | `c8d27f92c74aab91968f4768c3091eff185ecbfed0f3ec776b3949adfee6963e` | `869a887b2d8dd9aab2879cca2234b50cb82f853a` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/cross-check-output.txt` | 8787 | `a912551bc5f23d713dcb8528861324730d8e0de775a93170d8ae170f25f47f72` | `e2cbf6b18d7136f227a98c43075d67699d55ff74` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/preflight.json` | 3835 | `7aa3d3cdc12a7072d628704de118b2874ca91f507310f2b14126d1ed31e75d5d` | `41b768d8228f2e4b505805d2c8e1f9f789386ec8` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/requirement.json` | 19996 | `4ff187ee2c9eeaa1288ca2d7a78446a5723c7187fd540b2757c104a6ab968780` | `a8f3cbb288fec233e890dc8360fd9a4f55631758` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/review.json` | 16068 | `b3e04f5304b215f4f3c22cba68467b030af0999561b39fbb9cb8a3dc2a84b12d` | `3826607ae5d9198324eaacd64cbbba8e6db4ebfa` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/verify.json` | 3445 | `77eafc4584d0a8f306bbae1281ad3e4df92ea72845472f7f344f6f1d1c55b1c1` | `863a8798a429479e7a915200959570cd89526fef` | 0 |
| `docs/evidence/v0.1-run5-20261016T152321Z/workflow-result.json` | 105414 | `769d1cf5580cab3cbe4630a91d34d58381f0206316c246b633758494f1eddded` | `8024572bb85fda92c4796a964fba642cd2f300c9` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/.run-owner.json` | 182 | `d507c2497370dcd4035ca133889506af69fe0718f1a7360ed7acca04e41ff788` | `8efb472e3c8a4eaa68988ae06cccb79cef8ac64c` | 5 |
| `docs/evidence/v0.1-run6-20261016T154400Z/.sanitize-pass.py` | 4239 | `1b8319c631630b1b6bdfd55033c27ac700b5cba794f089051fc24e104976cf0a` | `23ffe48eee80b157b1d26ae6914a570808c534ae` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/README.md` | 18000 | `5c4956c6f4a74b38cdea81f5d5fc99cc1fe73e075619c141a3565d8ed9238566` | `893eadf39eccf90f75a0f91cb07f9dc9a69732ac` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/coding-report-revision-2.json` | 5928 | `b43338700de65ea8548cc816c1cb7d57805b6302eb509c4769988889455741f1` | `27dda52cb21092ae087a417dedfe063eda751a1a` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/coding-report.json` | 7418 | `9ba0407276d022822ede0d056160bbfd23adafdd60f85e9476d06d533781eba3` | `c44429fce06c4ef26bbe696c44eeeabffa4d871a` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/cross-check-output.txt` | 5358 | `1e01d02bda1347d887e7f512299d1dd6f584ee3b803383fa64b54eabf9a15c64` | `9ffb2364f47fa5fa7571c844146a4a0f3667aced` | 57 |
| `docs/evidence/v0.1-run6-20261016T154400Z/dsh-native-events.json` | 12928 | `4b47863a7b6ee31804574dd4e7b839a01a0025c24dfcb09147741c40a59b7d4d` | `594955a6468e65052c1e890c3eeafd3c608c0635` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-demo-test-output.txt` | 12013 | `4858606b75916b81b9d9092b4184763ef04639c824d92a9f2ad63b7654ff8136` | `afd4e059e493184b805870701a38acf828808743` | 86 |
| `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-regression-output.txt` | 3921 | `dc6e87204294350c9403c25798e5dc8adbd7906a4d6be84704ffa82eeff7b331` | `bd943340651245201ccc6d61ccf711a5632846a3` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6-output.txt` | 32662 | `bb907afca4f80aaeaf0000d9d1b244bbd425eeba75975c9055291e777d1d0794` | `fc01c70160ed414e074fcd9ea3f9427402acbc12` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-verification-run6.py` | 58215 | `679847eadd2a9bfed5f493a99162588cf00c8e8e16ae81fd851f85c78a81cb5c` | `f086d9e49791e5dd9fbd2a442e03c7535d31aa0b` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/preflight.json` | 3537 | `3295e5e268e34d272f98e234bc161a9ce4403e7c09596283acb6ef0dd91258dc` | `73ac67c92b05fc20192b8d8fad2b41e27c0e5d40` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/requirement.json` | 24629 | `6b429ac87303b86867e27139647c1985c96b4d43be3ea95869d99702d93c0f61` | `a65f0dc4b0bc8bbd6abee3303d7a5bf6da6382a4` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/review-revision-2.json` | 17649 | `c14d9ba263f3ab0d88db58cea8821e17e2515ba22069ab5fd6c63864c3fb2e4f` | `a41f8ed08c1a722dc7740be9ccc938c3726b34f9` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/review.json` | 19427 | `bf71e0e74890122c3c361eb9083ec885aee4c376b2c5bd31942668b7784f6cc5` | `dafe70420cdae31f19554afd867c98f04c313837` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/verify-revision-2.json` | 2472 | `eefb6a5285fea5b27dfa49e63269de8a947e33c9aa2661b2aff056bea50efde4` | `4b60c78b1d56d718d87688202065ba296a2ed532` | 29 |
| `docs/evidence/v0.1-run6-20261016T154400Z/verify.json` | 1358 | `0832d6b7ec39ca24fddd6d061a09f29663f6556b709d9c0aa101609a50f8ac0b` | `23d974618350681b8c546a2557fa6f323f587656` | 0 |
| `docs/evidence/v0.1-run6-20261016T154400Z/workflow-result.json` | 117638 | `7b90d8a00bb2eabdb181d6849c36d2367d8feb2935cc7707eccf19f2c0bdf9e0` | `8dbefca780d38b483deedd11557b6d7f86364c2c` | 0 |
| `docs/evidence/v0.1-second-run/ACCEPTANCE-STATUS.md` | 18878 | `d771e7ee72f0920261d127253401d21ac9fb9f280e001b20e8083b15aa09b97a` | `536a90a587cfe1fc7a025b6a5b036aa13bf47f37` | 0 |
| `docs/evidence/v0.1-second-run/README.md` | 11442 | `fabeb44c735cf540992d9ce11c9d15f8111f398d7d5719cbb5c635e72421e7bf` | `6f4d35169af48d78b7e47dacc1d192add1a48a4d` | 0 |
| `docs/evidence/v0.1-second-run/coding-report.json` | 7801 | `f1bcd1f4c2f83d3fec766bd45b8bffcaf9081aa3da96ddce575a61277425342e` | `d61cbf9dec71e649b94f41e88848d233db233d79` | 0 |
| `docs/evidence/v0.1-second-run/commit-5034985.diff` | 287730 | `03826ff13942c8ffd1830caa47aa433aaf6a460555f7b137f1c12263b2ce0e88` | `ba6223d76f6839b5f3df8c445eac88a849ede591` | 0 |
| `docs/evidence/v0.1-second-run/cross-check-workflow-result.py` | 13465 | `613617d522aa3e6d2abfb52fed237ff4a2b6f52173b0d17d16892c9ae2256b9e` | `8760d5cd97f00fb59bf56af529a02e61cb2b20a4` | 0 |
| `docs/evidence/v0.1-second-run/dsh-native-events.json` | 8409 | `80bc7952841db69994a74f78861f3dd7ef3e88cee89cf7df0a0f8a8cb5e7572a` | `2b49315a357ef3f14a8d3c02ab3084a6cc448e91` | 0 |
| `docs/evidence/v0.1-second-run/extract-native-events.mjs` | 9233 | `f4660de15d1f293e6d7c822be322d40f5b4f81001d7d37870f216819dde56dfb` | `4250e6e1f5e85f3afc8976b04687ce5cd165b3c7` | 0 |
| `docs/evidence/v0.1-second-run/make-review-manifest.py` | 8633 | `25b1cc5cfd5461db4577bd61589e79c6c3e5b5cb730f03dc5397fe5d2e215042` | `39d3582f79ea13390dd072aed9d6b168d31ba8b7` | 0 |
| `docs/evidence/v0.1-second-run/orchestrator-verification-output.txt` | 1252 | `18a66f39b41a72b6f6925543159ee7a33f5df8e064dee0486a58b8e7f5c29012` | `266acea5aa68face384159305f1e715e29650cb3` | 0 |
| `docs/evidence/v0.1-second-run/orchestrator-verification.py` | 24830 | `1d0b885ba775e08b77f994abcbb2c66ec0eac9cf1eecde86ad551b52ae11fc75` | `bfde8845c97a7957fd1431db9bafffc4e48ee6ea` | 0 |
| `docs/evidence/v0.1-second-run/preflight.json` | 3876 | `dd57556b4295c51525c378e03a9cf8da05ad639c20a4fb2e6cb8e82302a3a21b` | `53f8830e99027bbe5ce71a6b9333ecbf1da752e3` | 47 |
| `docs/evidence/v0.1-second-run/requirement.json` | 25310 | `07091a259f9d13465f028db77e47fc67921c4dd8b81961fd23e1be79076a2b00` | `0eec4f0d8113a3cd4b87fd87fed795305e4ac576` | 0 |
| `docs/evidence/v0.1-second-run/review.json` | 21331 | `1cea3a8a41f33e270ce4bd63f50d06b18b231b705c18c60f06f6b77973ea7222` | `e839b96ad0a1fa85894d3ae1362dff5e2e8351b0` | 0 |
| `docs/evidence/v0.1-second-run/verify.json` | 1524 | `87728f064016ef814f09ba3d76e190647c7e40c2f2617a70fc67eb54c8cc983f` | `c3420f2c5afa708396e76bf89aa89d0b0aec15fc` | 0 |

## 2. 基线检出

未找到基线检出目录 `5034985`；如需比对基线哈希，请先执行：

```powershell
git -c core.autocrlf=false worktree add --detach "$env:TEMP\tla-5034985-tree" 5034985
```

## 3. 警告

以下文件的**工作区磁盘字节**含 CRLF（多由子代理写入工具在 Windows 上产生）。上表已按提交内容（LF 规范化）计算哈希，
因此上表仍可与仓库对象直接比对；但若要"对磁盘文件直接算哈希"，必须先做 LF 规范化或改用 `core.autocrlf=false` 的检出：

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `examples/text-stats/.gitignore`
- `docs/evidence/v0.1-first-run/orchestrator-verification-output.txt`
- `docs/evidence/v0.1-first-run/review.json`
- `docs/evidence/v0.1-first-run/test-output.txt`
- `docs/evidence/v0.1-run3-20261016T150153Z/.run-owner.json`
- `docs/evidence/v0.1-run4-20261016T150809Z/.run-owner.json`
- `docs/evidence/v0.1-run5-20261016T152321Z/.run-owner.json`
- `docs/evidence/v0.1-run6-20261016T154400Z/.run-owner.json`
- `docs/evidence/v0.1-run6-20261016T154400Z/cross-check-output.txt`
- `docs/evidence/v0.1-run6-20261016T154400Z/orchestrator-demo-test-output.txt`
- `docs/evidence/v0.1-run6-20261016T154400Z/verify-revision-2.json`
- `docs/evidence/v0.1-second-run/preflight.json`
