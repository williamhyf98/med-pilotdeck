import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Task 10 —— 全局画像写锁。
 *
 * **作用域：跨项目、跨进程、跨类型。** 全局画像是两种模式（通用医学 / 战创伤）
 * 共用的单一文件（§3.8），所以锁必须全局生效，而不是按项目类型划分。
 *
 * **实现：** 原子性目录创建（`mkdirSync` with `recursive: false`）作为互斥锁。
 * 锁文件内存 `{ pid, hostname, acquiredAt }`，用于诊断和超时清理。
 *
 * **超时策略：** 锁超过 10 分钟视为陈旧，下一个请求者强制打破。
 * Dream 失败或中断时主动释放；进程退出时自动失效（目录留着但下次启动无视）。
 *
 * **拿不到锁时的行为：** **跳过本次 Dream，不排队**——堆积多个 Dream 只会
 * 造成成本堆积和锁竞争，immediate 模式下尤其如此。返回 `status: "skipped"`,
 * `reason: "global_profile_locked"`。
 */

export interface GlobalProfileLockMetadata {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface GlobalProfileLockOptions {
  /** 全局根目录（`$PILOT_HOME/memory/global`）。 */
  globalRootDir: string;
  /** 锁超时时长（毫秒），超过此时间视为陈旧并可强制打破。默认 10 分钟。 */
  staleLockTimeoutMs?: number;
}

const DEFAULT_STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

export class GlobalProfileLock {
  private readonly lockDir: string;
  private readonly lockMetaFile: string;
  private readonly staleLockTimeoutMs: number;
  private acquired: boolean = false;

  constructor(options: GlobalProfileLockOptions) {
    this.lockDir = join(options.globalRootDir, ".dream_lock");
    this.lockMetaFile = join(this.lockDir, "metadata.json");
    this.staleLockTimeoutMs = options.staleLockTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  }

  /**
   * 尝试获取锁。成功返回 `true`，失败返回 `false`（此时应跳过 Dream）。
   *
   * 失败原因：
   * - 锁被其他进程持有且未超时
   * - 文件系统错误（权限不足、磁盘满等）
   */
  tryAcquire(): boolean {
    if (this.acquired) {
      // 已经持有锁，幂等返回成功
      return true;
    }

    try {
      // 检查现有锁是否陈旧
      if (existsSync(this.lockDir)) {
        const shouldBreak = this.isLockStale();
        if (!shouldBreak) {
          // 锁仍然有效，无法获取
          return false;
        }
        // 锁已陈旧，强制打破
        rmSync(this.lockDir, { recursive: true, force: true });
      }

      // 原子性创建锁目录（`recursive: false` 保证排他）
      mkdirSync(this.lockDir, { recursive: false });

      // 写入元数据
      const meta: GlobalProfileLockMetadata = {
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(this.lockMetaFile, JSON.stringify(meta, null, 2), "utf8");

      this.acquired = true;
      return true;
    } catch (error) {
      // EEXIST: 另一个进程在我们检查和创建之间抢先了
      // 其他错误（权限、磁盘）：同样无法获取
      return false;
    }
  }

  /**
   * 释放锁。幂等——多次调用无副作用。
   */
  release(): void {
    if (!this.acquired) {
      return;
    }
    try {
      if (existsSync(this.lockDir)) {
        rmSync(this.lockDir, { recursive: true, force: true });
      }
    } finally {
      this.acquired = false;
    }
  }

  /**
   * 检查当前锁是否陈旧（超过超时时间）。
   */
  private isLockStale(): boolean {
    try {
      if (!existsSync(this.lockMetaFile)) {
        // 锁目录存在但元数据丢失，视为陈旧
        return true;
      }

      const raw = readFileSync(this.lockMetaFile, "utf8");
      const meta = JSON.parse(raw) as GlobalProfileLockMetadata;
      const acquiredMs = Date.parse(meta.acquiredAt);
      if (!Number.isFinite(acquiredMs)) {
        // 时间戳非法，视为陈旧
        return true;
      }

      const ageMs = Date.now() - acquiredMs;
      return ageMs >= this.staleLockTimeoutMs;
    } catch {
      // 读取或解析失败，视为陈旧
      return true;
    }
  }

  /**
   * 读取当前锁的元数据（如果存在）。用于诊断和 Dashboard 展示。
   */
  currentLockMetadata(): GlobalProfileLockMetadata | null {
    try {
      if (!existsSync(this.lockMetaFile)) {
        return null;
      }
      const raw = readFileSync(this.lockMetaFile, "utf8");
      return JSON.parse(raw) as GlobalProfileLockMetadata;
    } catch {
      return null;
    }
  }
}
