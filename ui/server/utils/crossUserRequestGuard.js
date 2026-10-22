import { resolve, sep } from 'node:path';
import { resolvePilotRoot } from './pilotPaths.js';

// A narrow, deterministic preflight for explicit access to another account's
// private files. The OS sandbox and tool guards remain the authority for paths
// the model constructs itself or paths hidden in attachments.
export function isExplicitCrossUserAccessRequest(text, { userId, pilotRoot = resolvePilotRoot() }) {
    if (typeof text !== 'string' || !text || userId == null) return false;
    const root = resolve(pilotRoot);
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const id = String(userId);
    const userPaths = new RegExp(`${escapedRoot}/users/(\\d+)(?=/|(?=$|[\\s"'<>)}\\]]))`, 'g');
    const otherUser = [...text.matchAll(userPaths)].some((match) => match[1] !== id);
    const system = text.includes(`${root}${sep}system${sep}`)
        || text.includes(`${root}${sep}pilotdeck.yaml`);
    if (!otherUser && !system) return false;
    return /读取|访问|查看|获取|复制|拷贝|修改|编辑|写入|解析|分析|打开|调用|执行|运行|绕过|办法|怎么|如何|cat\b|find\b|grep\b|glob\b|read\b|write\b|edit\b|ls\b|node\b|python\b|bash\b/i.test(text);
}
