/**
 * 工作区路径校验（第二批：新建目录）。
 *
 * 抽成独立模块的原因和 `routeErrors.js` 一样：`index.js` 在 import 时就启动
 * 服务器，路由级逻辑只能靠起服务测；这里的规则是纯函数 + 一次 lstat 遍历，
 * 单独测更省事，也避免规则散落在 index.js 里被改歪。
 *
 * 规则（对应设计书 §5.3.1）：
 * - 只接受工作区内的相对路径；
 * - 不允许 `..`、绝对路径、盘符；
 * - 每一段都不能以 `.` 开头（否则会造出面板看不见的 `.trash` / `.tmp`）；
 * - 顶层不能是系统保留项；
 * - 层级 ≤ 16、单段 ≤ 120 字符、不含 `<>:"|?*` 与控制字符；
 * - 路径上任何一段是软链都拒绝，防止写到工作区外面。
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

export const WORKSPACE_MAX_PATH_SEGMENTS = 16;
export const WORKSPACE_MAX_SEGMENT_LENGTH = 120;

/** 面板不展示、也不允许用户直接创建的系统项。 */
export const WORKSPACE_PANEL_HIDDEN_NAMES = Object.freeze(new Set([
    '.trash',
    '.usage.json',
    '.pinned',
    '.tmp',
]));

export function badRequest(message, code = 'invalid_input') {
    const error = new Error(message);
    error.code = code;
    error.httpStatus = 400;
    return error;
}

/**
 * 把用户输入拆成安全的路径段。
 *
 * @param {unknown} relativePath
 * @returns {string[]}
 */
export function normalizeNewPath(relativePath) {
    if (typeof relativePath !== 'string') throw badRequest('请提供目录名');
    const raw = relativePath.replace(/\\/g, '/').trim();
    if (!raw) throw badRequest('请提供目录名');
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw badRequest('只支持工作区内的相对路径');
    const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) throw badRequest('请提供目录名');
    if (segments.length > WORKSPACE_MAX_PATH_SEGMENTS) throw badRequest('目录层级过深');
    for (const segment of segments) {
        if (segment === '..') throw badRequest('路径不能包含 ..');
        if (segment.startsWith('.')) throw badRequest('目录名不能以 . 开头');
        if (/[<>:"|?*\x00-\x1f]/.test(segment)) throw badRequest('目录名包含非法字符');
        if (segment.length > WORKSPACE_MAX_SEGMENT_LENGTH) throw badRequest('目录名过长');
    }
    if (WORKSPACE_PANEL_HIDDEN_NAMES.has(segments[0])) throw badRequest('该名称是系统保留项');
    return segments;
}

/**
 * 文本保存（`PUT /:projectName/file`）用的路径校验。
 *
 * 刻意**不**拦 `inbox/`：inbox 只对 **agent** 只读（`src/tool/builtin/filesystem/pathSafety.ts`
 * 的 `READ_ONLY_WORKSPACE_ROOTS`，那条规则仍然生效），而文件的主人是用户本人——
 * 用户在上传件上改个表头、补一列再保存是正常操作，没有理由让他在页面上被拦。
 *
 * 保留这个具名包装而不是直接调 `normalizeNewPath`：写入规则（保留项/隐藏名/`..`）
 * 将来若与"新建目录"分叉，改动只落在这里，不必回头找调用点。
 *
 * @param {unknown} relativePath
 * @returns {string[]}
 */
export function normalizeWritePath(relativePath) {
    return normalizeNewPath(relativePath);
}

/**
 * 目标路径必须落在 root 内（词法层面）。
 *
 * @returns {string} 规范化后的绝对路径
 */
export function resolveInsideRoot(root, segments) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, ...segments);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
        throw badRequest('路径必须位于工作区内', 'path_out_of_bounds');
    }
    return target;
}

/** 拒绝穿过软链：逐段 lstat，遇到软链就报错（否则可能写到工作区外面去）。 */
export async function assertNoSymlinkOnPath(root, target) {
    const relative = path.relative(root, target);
    let current = root;
    for (const segment of relative.split(path.sep)) {
        if (!segment) continue;
        current = path.join(current, segment);
        const stat = await fsPromises.lstat(current).catch(() => null);
        if (!stat) break;
        if (stat.isSymbolicLink()) throw badRequest('路径中包含符号链接，已拒绝');
    }
}
