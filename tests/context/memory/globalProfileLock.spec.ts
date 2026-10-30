/**
 * Task 10 —— GlobalProfileLock 测试。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GlobalProfileLock } from "../../../src/context/memory/edgeclaw-memory-core/src/core/GlobalProfileLock.js";

test("获取锁成功后其他进程无法再获取", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lock1 = new GlobalProfileLock({ globalRootDir });
    const lock2 = new GlobalProfileLock({ globalRootDir });

    assert.ok(lock1.tryAcquire(), "第一个锁应该成功");
    assert.ok(!lock2.tryAcquire(), "第二个锁应该失败");

    lock1.release();
    assert.ok(lock2.tryAcquire(), "释放后第二个锁应该成功");
    lock2.release();
  } finally {
    rmSync(globalRootDir, { recursive: true, force: true });
  }
});

test("锁超时后下一个请求者可以强制打破", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lock1 = new GlobalProfileLock({ globalRootDir, staleLockTimeoutMs: 100 });
    const lock2 = new GlobalProfileLock({ globalRootDir, staleLockTimeoutMs: 100 });

    assert.ok(lock1.tryAcquire(), "第一个锁应该成功");
    assert.ok(!lock2.tryAcquire(), "第二个锁立即应该失败");

    // 等待超时
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.ok(lock2.tryAcquire(), "超时后第二个锁应该成功");
        lock2.release();
        lock1.release();
        resolve();
      }, 150);
    });
  } finally {
    setTimeout(() => rmSync(globalRootDir, { recursive: true, force: true }), 200);
  }
});

test("release 幂等——多次调用无副作用", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lock = new GlobalProfileLock({ globalRootDir });
    assert.ok(lock.tryAcquire());
    lock.release();
    lock.release();
    lock.release();
    // 不应该抛错
  } finally {
    rmSync(globalRootDir, { recursive: true, force: true });
  }
});

test("锁目录存在但元数据丢失时视为陈旧", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lockDir = join(globalRootDir, ".dream_lock");
    mkdirSync(lockDir, { recursive: true });
    // 不写元数据文件

    const lock = new GlobalProfileLock({ globalRootDir });
    assert.ok(lock.tryAcquire(), "应该打破陈旧锁");
    lock.release();
  } finally {
    rmSync(globalRootDir, { recursive: true, force: true });
  }
});

test("tryAcquire 已持有锁时幂等返回成功", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lock = new GlobalProfileLock({ globalRootDir });
    assert.ok(lock.tryAcquire());
    assert.ok(lock.tryAcquire(), "再次尝试应该幂等返回成功");
    lock.release();
  } finally {
    rmSync(globalRootDir, { recursive: true, force: true });
  }
});

test("currentLockMetadata 返回锁的元数据", () => {
  const globalRootDir = mkdtempSync(join(tmpdir(), "lock-test-"));
  try {
    const lock = new GlobalProfileLock({ globalRootDir });
    assert.strictEqual(lock.currentLockMetadata(), null, "未获取锁时应该返回 null");

    assert.ok(lock.tryAcquire());
    const meta = lock.currentLockMetadata();
    assert.ok(meta, "获取锁后应该有元数据");
    assert.strictEqual(meta!.pid, process.pid);
    assert.ok(meta!.hostname);
    assert.ok(meta!.acquiredAt);

    lock.release();
    assert.strictEqual(lock.currentLockMetadata(), null, "释放后应该返回 null");
  } finally {
    rmSync(globalRootDir, { recursive: true, force: true });
  }
});
