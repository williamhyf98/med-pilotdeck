/**
 * Dashboard 作用域身份（Task 8）。
 *
 * 改造前 Dashboard 的唯一身份是 `projectPath`——一个**可变的展示路径**。
 * 项目改名、workspace 迁移、linked repo 换位置都会改变它，而记忆数据是按
 * 稳定 projectId 存的，于是「面板指向 A、写入落到 B」在结构上是可能的。
 *
 * 本模块把身份收敛成 `projectId + projectType + sessionId` 三元组，
 * `projectPath` 降级为**兼容参数**：它仍可出现在 URL 中，但不再展示，也不参与
 * 任何定位或写入寻址。
 *
 * 单独成文件而不是写在 app.js 里，是为了让这段逻辑能被子包测试直接覆盖——
 * app.js 是一整个 DOM 应用，为它搭测试环境的成本远大于收益。
 */

/**
 * @typedef {Object} DashboardScope
 * @property {string} projectId     稳定 storage id，唯一主键
 * @property {string} projectType   `general_medicine` | `war_trauma` | ''
 * @property {string} sessionId     当前 session（可为空）
 * @property {string} projectPath   仅供展示，禁止用于定位
 */

/**
 * 从 URL 查询参数读出作用域。
 *
 * @param {URLSearchParams} params
 * @returns {DashboardScope}
 */
export function readDashboardScope(params) {
  const read = (key) => (params.get(key) || "").trim();
  return {
    projectId: read("projectId"),
    projectType: read("projectType"),
    sessionId: read("sessionId"),
    projectPath: read("projectPath"),
  };
}

/**
 * 本作用域是否可用于寻址。
 *
 * 没有 projectId 时**不回落到 projectPath**：回落正是改造前那条错误路径，
 * 它会让面板在身份缺失时安静地指向某个「看起来对」的项目。
 *
 * @param {DashboardScope} scope
 * @returns {boolean}
 */
export function hasAddressableScope(scope) {
  return Boolean(scope && scope.projectId);
}

/**
 * 给请求 URL 追加作用域参数。
 *
 * `projectId` 是寻址键，`projectPath` 只为兼容尚未迁移的旧接口而附带；
 * 服务端以 projectId 优先，两者不一致时直接拒绝（见 memoryService.js）。
 *
 * @param {string} url 相对或绝对 URL
 * @param {DashboardScope} scope
 * @param {string} [origin] 解析相对 URL 用的 base
 * @returns {string} `pathname + search`
 */
export function withScope(url, scope, origin = "http://localhost") {
  const next = new URL(url, origin);
  if (scope?.projectId) next.searchParams.set("projectId", scope.projectId);
  if (scope?.projectType) next.searchParams.set("projectType", scope.projectType);
  if (scope?.sessionId) next.searchParams.set("sessionId", scope.sessionId);
  if (scope?.projectPath) next.searchParams.set("projectPath", scope.projectPath);
  return `${next.pathname}${next.search}`;
}

/**
 * 给写请求的 body 附上作用域。
 *
 * 写入必须带 projectId：服务端据此校验「这次写入的目标项目 == 面板绑定的项目」，
 * 这是阻止「在项目 A 的面板里改到项目 B」的那道闸。
 *
 * @template {Record<string, unknown>} T
 * @param {T} body
 * @param {DashboardScope} scope
 * @returns {T & { projectId: string; projectPath: string }}
 */
export function withScopeBody(body, scope) {
  return {
    ...body,
    projectId: scope?.projectId || "",
    projectPath: scope?.projectPath || "",
  };
}
