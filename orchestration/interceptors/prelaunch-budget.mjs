// orchestration/interceptors/prelaunch-budget.mjs
//
// 兼容入口：核心逻辑已迁移到可直接安装的本地插件包
// `orchestration/interceptor-plugin/`（`lib/budget.mjs` 纯逻辑 + `index.js`
// 的真实宿主接线）。历史路径保留为重导出，避免既有测试与文档链接失效。
//
// 宿主接线的状态（见 docs/V0.2-INTEGRATION-PLAN.md 阶段 2）：
// - 源码级语义论证：已完成（`dsh-agent-loop/lib/index.js:1179` 在
//   `llm.prepareCall()` 之前触发；`:1134 continue` 回到 `:1050`；`:1008` turn 级 catch）；
// - 夹具级验证：`tests/v02-prelaunch-budget.test.mjs`（模拟宿主，不等于真实宿主验收）；
// - 真实宿主验证：阶段 2 隔离 profile 实验，结果单独记录。

export {
  INTERCEPTOR_ID,
  PrelaunchBudgetError,
  createRequestBudget,
  createAgentRequestListener,
} from '../interceptor-plugin/lib/budget.mjs';
