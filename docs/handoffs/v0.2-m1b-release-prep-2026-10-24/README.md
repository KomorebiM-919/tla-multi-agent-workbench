# M1B 发布前整理与真实进程证据可行性

日期：2026-10-24（Asia/Shanghai）。状态：仅离线准备，未发布、未安装、未启动。
代码基线：`eafffeab793661d7d7e0fe0c5dfa794f5139738a`。本包新增文档，不改变该已审代码树。

## 1. 可核验结论与来源

- 用户转发的 DSH 独立复核接受了 eafffea 对 b4e9cb6 的后代证据 P1 修复。
  不能将有条件接受的旧父提交单独记为完整收口，也不能升级 V0.2 整体验收。
- 已有实际复算：M1B 95/95、runner 131 checks、12 文件 envelope 保真；
  三个精确反向变异被捕获，源文件恢复。记录见实现文档 correction round 5。
- 此次只整理文档与公开/本地 refs，没有重新运行这些代码套件；上述是既有验证
  与用户转发的独立复核，不冒充本轮新运行。转发报告不是原始日志文件。
- 包的 sourceBase 为 9cb81bbf760df94a4d3847701e519a72a92ff7a6，
  12 文件 digest 为 dc68af4508722c8452e84f4538dc215126c649771ea49d479f10be948e16f619。
  它是打包来源，不是当前执行源码 HEAD；历史清单没有刷新。
- 本轮通过公开、无凭据 GitHub API 读取分支 SHA 和 PR 列表。值只是读取时快照，
  发布前必须刷新；本地 tracking ref 本身不能替代服务端确认。

## 2. 分支事实及发布范围

| 项目 | 本轮读取值 |
|---|---|
| GitHub fix/v0.2-core-acceptance | 21729f63d9a1c09234a96d1d958b94d6b75d7af4 |
| GitHub feat/v0.2-component-reuse | 518979508f1838fe07342d0f4700d2e6f9477a7b |
| GitHub main | 2f019920c8667378065fee947eeaa8636ca49bf4 |
| DSH 本地 fix 分支 | d05e9c088df4977f444740fd349ba8878deeee10 |
| Codex 本地 fix/v0.2-m1b-teardown | eafffeab793661d7d7e0fe0c5dfa794f5139738a |
| fix / feature 的 PR 列表（state=all） | 均为原始 JSON 空数组 [] |

发布到既有 fix 分支的**代码候选范围为 9 笔**，不是最后一笔 P1 提交：

| 顺序 | 完整 SHA | 主题 |
|---|---|---|
| 1 | `05920ebdc075c68fde3e0175676c8bd1daba8ef0` | docs: prepare M1B install scope and supervised wiring contract |
| 2 | `6c20b4e39740c88c096b596188f9ac5cbe8fe419` | feat: add M1B observer envelope and mount probe |
| 3 | `3979febb6e9fd3141a9baae758b80dd81bb21ca4` | docs: record M1B offline envelope and approval packet |
| 4 | `9cb81bbf760df94a4d3847701e519a72a92ff7a6` | fix(package): pin envelope root package line endings |
| 5 | `fc583aac0934bef8826828353931fc3f7ad87a59` | fix: consume real mount-probe evidence and pin M1B envelope |
| 6 | `ef1381e51110ddda3523d77d9c5a41b3ca889912` | fix: reject incomplete mount-probe evidence |
| 7 | `d05e9c088df4977f444740fd349ba8878deeee10` | fix: require success evidence in mount probe |
| 8 | `b4e9cb6c40ea4a7fba9a6e690030338c691ef3b7` | fix: validate complete runner teardown evidence |
| 9 | `eafffeab793661d7d7e0fe0c5dfa794f5139738a` | fix: preserve unverified host descendant evidence |

这九笔是从远端 fix 到已审代码 tip 的线性快进范围，共 23 文件 +2605/-10。
它们包含设计、实现与修复，不将每笔都等同于单独的真实宿主验收。
本整理包提交将额外增加一笔文档提交；若获准一起发布，应重新列出完整范围，
不能继续用“仅九笔”描述含文档的实际推送。

- 已审代码 tip 相对 feature：feature 独有 9 笔，代码线独有 52 笔；
  merge-base=afead09bdbc996b4d428dbf95fc01dcf002f3e1f。两线已经分叉，feature 不能快进到该 tip。
- 已审代码 tip 相对 main：main 独有 0 笔，代码线独有 192 笔。
  这不是合并 main 的授权，也不是 192 笔都已经完成真实验收。
- DSH 本地 fix=d05e9c0 是 eafffea 的祖先，但本轮不移动该分支。

**发布风险**：本地 Codex 副本的 origin 指向本机 TLA 仓库，不是 GitHub。
未来发布必须用重新核验的 GitHub 地址或已确认指向它的发布仓库，不能盲用
本副本的 origin。目标仍是 fix/v0.2-core-acceptance；不改 feature/main、
不推其他分支或标签、不强推。没有现成 PR 可更新；创建 PR 另需批准。

发布前关卡：核对最终固定 SHA、clean、完整候选范围、敏感信息、远端 URL 和
服务端旧 tip；旧 tip 若改变则重新判断祖先关系，分叉即停。只走标准 Git 凭据
流程；认证失败停止，不读取或重组秘密。成功后独立回读服务端 SHA。
本文件没有发出 push 命令，也不赋予发布权限。

## 3. 当前真实实验的硬阻塞

runner 在宿主 launcher 自行退出后进入 teardown，可能只能记录
exited-before-teardown；枚举不可用则是 descendants-unverified。M1B 现在
正确地把这些情况判为 incomplete。空 survivors、父 PID 消失、端口空闲、
正常退出码或 observer stopped 都不能代替缺失的后代证据。

因此，重复执行原真实实验仍可能得不到可接受证据。不能通过重试、提升模型
额度、要求模型多等一会儿或把 unknown 改成 collected 来消除这个阻塞。

### 其他安装前未收口项（本轮只记录）

- 审批设计要求有界的 observer attached 等待/运行监视，但 eafffea 的 runner/gate
  只见 observer plan/patch 接线，未见 journal 身份校验和挂载 deadline watcher。
  缺失附着的事后判定不能代替运行中的停机机制；这部分仍待实现与本地替身测试。
- 旧安装文档的“no synthetic record can set binding=consistent”表述过宽。
  精确边界是 receipt origin=simulated 保持 unproven；虚构但填写 local-runtime
  的记录仍能结构上 consistent，所以该字段没有来源真伪鉴别能力。
- 旧保留实验根位于 TLA 目录；今后的新产物应遵循用户当前 Codex 固定根规则。
  新安装提案应先改为 <codex-root>/experiments/observer-m1b/<attemptId> 并审核，
  不创建目录、不迁移历史材料，也不直接执行旧文档中的路径。

这些项目不否定已接受的 P1 修复，但使“完整 M1B 设计已实现/可直接安装运行”
仍不成立。此交接不实现 watcher、native helper 或新 evidence consumer。

## 4. 开源与平台能力调查（只读，未采用）

| 候选 | 本轮核对到的能力 | 限制与结论 |
|---|---|---|
| Microsoft hcsshim internal/jobobject | 有 Job Object 创建、归属、查询和终止的实现 | Go internal 包且带依赖，不是 Node 可直接导入的库；只作架构参考，不引入容器栈 |
| pywin32 win32job / win32process | 已有 Python 的创建、关联、查询及进程创建绑定 | 本机是否可用、运行时/位数/权限未验证；不安装、不选定版本 |
| Microsoft Win32 Job Object API | 管理已归属的一组进程，查询 accounting/PID list | 既有 job、嵌套权限、breakaway 和非标准创建方式必须核验；不是全部系统进程的证明 |

资料来源（阅读于 2026-10-24；分支链接未固定，不是安装来源 pin）：

- [hcsshim 实现](https://github.com/microsoft/hcsshim/blob/main/internal/jobobject/jobobject.go)
- [pywin32 绑定](https://github.com/mhammond/pywin32/blob/main/win32/src/win32job.i)
- [Job Objects 官方语义](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
- [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- [进程创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

特别限制：默认 CreateProcess 子进程可继承 job，但 breakaway 配置、嵌套 job
和由 Win32_Process.Create 等方式创建的进程不能被忽略。官方说明多数完成端口
消息不保证投递，不能把未收到退出消息当作没有活动进程。

## 5. 推荐的下一步：先验证外部监督器，暂不接宿主

这是待实现设计，不是新能力，也不冻结新的证据 schema。优先复用 Windows
Job Object 能力；不将 hcsshim 整体移植入项目。具体选择既有 Python 绑定还是
小型 native helper，须先完成本地依赖/工具链和许可证检查；需要安装或新依赖
时单独申请。PowerShell/FFI 不是自动获得权限的替代路线。

拟验证流程：

1. 监督器在目标进程之外存活，创建本次独占的 job，句柄不向被监督进程继承。
2. 在运行任何目标代码前建立归属；候选方法是 CREATE_SUSPENDED 创建本地替身，
   关联 job 成功并查询确认后再恢复线程。先启动再补关联存在竞态，不作为成功路径。
3. 仅观察/终止本次拥有的 job；不接管桌面、旧 profile 或系统中其他进程。
4. 目标退出后仍持有 job 句柄，查询活动数和 PID 列表，处理仍活着的子/孙进程；
   有界终止并再次查询，只有成功观测到 job 内为空才记录该有限范围的清理结论。
5. kill-on-close 可用于崩溃兜底，但 CloseHandle 成功不代替清理查询；
   不能先关闭最后句柄再声称查到了已销毁 job 的空状态。通知只辅助，不代替查询。
6. 归属、查询、权限或终止失败：有界停止，保留首要错误，明确 incomplete/failed，
   不降级为 PID 轮询成功；父进程退出不截断监督器的收尾。
7. 证据至少关联实际 runner/launch/gate 身份、拥有者和归属阶段、查询结果/错误及
   收尾结果。它仍是本机相关证据，不是签名认证。格式及 consumer 需独立审核。

新 job 证据不能伪装成旧 descendantsProof=collected 或填造历史 PID 快照。
当前 mount-probe 未支持这类新证据；需要独立版本/来源规则与消费者测试后才能
作为新的清理证据。B0、observer origin、模型预算和 provider 覆盖规则保持原义。

仅本地 Node 替身的最小验证矩阵（下一工作包才实施）：

- 父进程正常退出，孙进程仍运行：监督器必须发现并回收；
- 父进程快速启动子进程，检验“先关联后运行”的归属窗口；
- 单进程及普通多层进程正常退出，归属查询和空 job 收尾成立；
- 既有/嵌套 job、无关联或查询权限、明确拒绝的 breakaway 路径；
- 查询超时、终止失败、监督器异常/重复收尾，保留错误且不挂起；
- 归属外的 canary 进程不被回收；已拥有的测试进程和句柄无遗留。

是否支持这些本地启动路径、是否允许嵌套 job、本机工具链是否可用，本轮均未知。
若不能满足，不启动真实 DSH，不声称全局进程无残留，也不改 ACL 让测试变绿。

## 6. 后续关卡与交接

| 顺序 | 工作包 | 当前状态/授权 |
|---|---|---|
| A | 发布已审代码及本整理包 | 待单独批准；本轮未推送 |
| B | 选型并验证本地替身的 job 归属/收尾 | 待批准实施；不含宿主、安装或模型 |
| C | 审查证据格式及接线 | 尚未实现，不预设 schema 改动已经完成 |
| D | 隔离 profile 安装 | 未授权；精确依赖骨架/字节和最小文件列表还需核验 |
| E | 一次真实挂载探针 | 未授权，启动授权 0；每次独立审批，不自动重试 |
| F | 成员覆盖与真实返工闭环 | 未验证，不能从离线包或 mount probe 推导 |

发布与 B 的本地研究可独立决策；前者不授权后者，更不授权安装/宿主启动。
Codex 负责关键归属/证据设计及反复出错部位；DSH 承担多数实现、独立复核、
测试、文档和环境整理，沿用约 25%/75% 分工。

DSH 本地 fix、feature 工作区、六份 probe JSON 及未审 handoff 均未改变。
主仓库的六项历史未跟踪文件/目录未读取内容、未清理。
当前宿主和插件版本未在本轮重新验证，安装前必须从实际来源确认，不能沿用
旧报告冒充当前值。本轮没有新增 Skill/插件的安装或使用验证，因此台账不改。

新会话先核对 MANIFEST、实际 HEAD/clean 和服务端 refs，再报告偏差；
阅读本文件不是任何发布、安装或真实启动授权。
