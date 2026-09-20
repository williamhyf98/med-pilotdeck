/**
 * `dashboard-scope.js` 的类型声明。
 *
 * 手写 `.d.ts` 而不是把实现改成 TS：`ui-source/` 是浏览器直接加载的静态资源，
 * 不经过本包的 `tsc` 产出（build 的 rootDir 是 `./src`）。声明文件只为让
 * `test/` 下的 TS 测试能类型安全地 import 它。
 */

export type DashboardScope = {
  /** 稳定 storage id，唯一主键 */
  projectId: string;
  /** `general_medicine` | `war_trauma` | '' */
  projectType: string;
  /** 当前 session（可为空） */
  sessionId: string;
  /** 仅供展示，禁止用于定位 */
  projectPath: string;
};

export function readDashboardScope(params: URLSearchParams): DashboardScope;

export function hasAddressableScope(scope: DashboardScope | null | undefined): boolean;

export function withScope(url: string, scope: DashboardScope, origin?: string): string;

export function withScopeBody<T extends Record<string, unknown>>(
  body: T,
  scope: DashboardScope,
): T & { projectId: string; projectPath: string };
