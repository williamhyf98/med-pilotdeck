#!/usr/bin/env python3
"""data-analysis 运行期护栏（spec §4 的动态部分）。

静态 AST 体检只能看见**字面量**：`open("../" * 4 + "etc/passwd")`、`open('inbox/x.csv','w')`
这类写法它看不出来。这个文件补上运行期那一层——进用户脚本之前装一个
`sys.addaudithook`，把四类动作当场拒掉：

1. 出网：`socket.*` / `urllib.Request` / `http.client.*` / `ftplib` / `smtplib` …
2. 起进程：`subprocess.*` / `os.system` / `os.exec*` / `os.spawn*` / `os.fork` / `pty.*`
3. 原生代码：`ctypes.dlopen` 只放行系统/解释器自带的库（numpy、scipy 在 import 期
   就会 dlopen 自己的 .so，一刀切会连 pandas 都起不来）；`import ctypes` 本身
   已由静态体检拒掉，这里只防"绕过静态检查后再加载外部库"
4. 写盘越界：只允许写 `exports/`、`scratch/` 和进程私有 TMPDIR；
   `inbox/` 与保留项（`.trash` / `.usage.json` …）一律拒

**读盘不设限**是有意的：pandas / matplotlib 要读 site-packages 和系统字体，
拦读会把正常分析直接搞死；越界读由静态字面量检查（S7/S8）和外层沙箱兜底。

audit hook 一旦装上就摘不掉（CPython 语义），脚本里没有"卸护栏"的写法。
"""

from __future__ import annotations

import json
import os
import runpy
import sys

# 事件名前缀 → 直接拒绝（socket / subprocess 单独判定，见下面两个白名单）
DENIED_EVENT_PREFIXES = (
    "os.system",
    "os.exec",
    "os.spawn",
    "os.posix_spawn",
    "os.fork",
    "pty.",
    "urllib.Request",
    "http.client.",
    "ftplib.",
    "smtplib.",
    "imaplib.",
    "poplib.",
    "telnetlib.",
    "webbrowser.",
    "os.add_dll_directory",
)

# 只拦**真的会出网**的 socket 事件。创建 socket 对象本身不算：
# urllib3 在 import 期就 `socket.socket(AF_INET6)` + bind('::1') 探测 IPv6，
# 一刀切会把所有用到 requests/urllib3 的库（wfdb 就依赖 requests）判成 blocked。
DENIED_SOCKET_EVENTS = {
    "socket.connect",
    "socket.sendto",
    "socket.sendmsg",
    "socket.getaddrinfo",
    "socket.gethostbyname",
    "socket.gethostbyaddr",
    "socket.getnameinfo",
    "socket.sethostname",
}

# 注意不含 0.0.0.0 / ::：那是对外监听，不是自检
LOOPBACK_HOSTS = {"", "localhost", "127.0.0.1", "::1"}

# 这些**只读探针**是第三方库自己会跑的，不是用户脚本在"起进程"：
#   matplotlib 扫字体（fc-list / fc-match / system_profiler）
#   numpy.testing 探测 ARM SVE（lscpu，statsmodels 会带进 numpy.testing）
#   平台信息（uname / sw_vers / sysctl 查询）
# 不放行它们，正常脚本会被误判成 blocked —— 这比"少一层防护"更糟，
# 因为 agent 会把正常分析当成被拦截而停手。除此之外任何 Popen 都拒。
SAFE_SUBPROCESS_HELPERS = {
    "fc-list", "fc-match", "system_profiler", "lscpu",
    "uname", "sw_vers", "nproc", "sysctl",
}

# argv[1] 命中这些就当"不是单纯枚举"
FORBIDDEN_HELPER_ARGS = {"-c", "-e", "--exec"}

# sysctl 还能写内核参数，查询才放行
FORBIDDEN_SYSCTL_ARGS = {"-w", "--write", "-p", "--load"}

# 事件名 → 需要做"可写目录"校验的路径参数下标（0-based）
WRITE_EVENT_PATHS = {
    "os.remove": (0,),
    "os.rmdir": (0,),
    "os.mkdir": (0,),
    "os.truncate": (0,),
    "os.chmod": (0,),
    "os.chown": (0,),
    "os.chflags": (0,),
    "os.utime": (0,),
    "os.setxattr": (0,),
    "os.removexattr": (0,),
    "os.rename": (0, 1),
    "os.replace": (0, 1),
    "os.link": (1,),
    "os.symlink": (1,),
    "shutil.rmtree": (0,),
    "shutil.copyfile": (1,),
    "shutil.copymode": (1,),
    "shutil.copystat": (1,),
    "shutil.move": (1,),
    "shutil.make_archive": (0,),
    "shutil.unpack_archive": (1,),
}

WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

# dlopen 放行目录：解释器自带的 lib 目录、系统库目录
_SAFE_LIBRARY_PREFIXES = (
    "/usr/lib", "/usr/local/lib", "/lib", "/lib64",
    "/System/Library", "/Library/Frameworks", "/opt/homebrew/lib",
)
_SAFE_LIBRARY_NAMES = {
    "libSystem.B.dylib", "libc.dylib", "libc.so.6", "libc.so", "libm.so.6",
}

ROOT = ""
WRITABLE: tuple[str, ...] = ()
_busy = False


class AnalysisViolation(PermissionError):
    """脚本做了技能契约之外的事。"""


DENIAL_MARKER = "ANALYSIS_GUARD_DENIED "


def _deny(detail: str, event: str = "") -> None:
    # 给执行器留一行机器可读的凭据：执行器据此把结果标成 blocked 并写审计
    sys.stderr.write(DENIAL_MARKER + json.dumps({"event": event, "detail": detail}, ensure_ascii=False) + "\n")
    sys.stderr.flush()
    raise AnalysisViolation(f"blocked by data-analysis guard: {detail}")


def _as_text(value: object) -> str | None:
    if isinstance(value, bytes):
        return os.fsdecode(value)
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return None
    try:
        return os.fspath(value)  # type: ignore[arg-type]
    except TypeError:
        return None


def _real(path: str) -> str:
    try:
        return os.path.realpath(path)
    except OSError:
        return os.path.abspath(path)


def _inside(path: str, root: str) -> bool:
    if not root:
        return False
    return path == root or path.startswith(root + os.sep)


def _check_writable(raw: object, event: str = "open") -> None:
    path = _as_text(raw)
    if not path:
        return
    resolved = _real(path)
    if any(_inside(resolved, root) for root in WRITABLE):
        return
    _deny(f"writing outside exports/ or scratch/: {path}", event)


def _wants_write(mode: object, flags: object) -> bool:
    if isinstance(mode, str):
        return any(marker in mode for marker in "wax+")
    if isinstance(flags, int) and flags >= 0:
        return bool(flags & WRITE_FLAGS)
    return False


def _dlopen_allowed(raw: object) -> bool:
    name = _as_text(raw)
    if not name:
        # PyDLL(None) / CDLL(None)：拿到主程序句柄，numpy 就是这么干的
        return True
    if not os.path.isabs(name):
        return name in _SAFE_LIBRARY_NAMES
    resolved = _real(name)
    prefixes = (sys.prefix, sys.base_prefix, *_SAFE_LIBRARY_PREFIXES)
    return any(_inside(resolved, _real(prefix)) for prefix in prefixes if prefix)


def _popen_allowed(executable: object, argv: object) -> bool:
    name = _as_text(executable)
    if not name:
        return False
    helper = os.path.basename(name)
    if helper not in SAFE_SUBPROCESS_HELPERS:
        return False
    if not isinstance(argv, (list, tuple)) or len(argv) <= 1:
        return True
    for argument in argv[1:]:
        text = str(argument)
        if text in FORBIDDEN_HELPER_ARGS:
            return False
        if helper == "sysctl":
            if text in FORBIDDEN_SYSCTL_ARGS or "=" in text:
                return False
    return True


def _inspect(event: str, args: tuple[object, ...]) -> None:
    if event == "subprocess.Popen":
        if not _popen_allowed(args[0] if args else None, args[1] if len(args) > 1 else None):
            _deny(f"starting a process is not available in data-analysis: {args[0]!r}", event)
        return

    if event in DENIED_SOCKET_EVENTS:
        _deny(f"{event}() is not available in data-analysis", event)

    if event == "socket.bind":
        address = args[1] if len(args) > 1 else None
        host = ""
        if isinstance(address, (tuple, list)) and address:
            host = _as_text(address[0]) or ""
        if host not in LOOPBACK_HOSTS:
            _deny(f"binding a socket outside loopback is not allowed: {address!r}", event)
        return

    for prefix in DENIED_EVENT_PREFIXES:
        if event == prefix or event.startswith(prefix):
            _deny(f"{event}() is not available in data-analysis", event)

    if event == "ctypes.dlopen" and not _dlopen_allowed(args[0] if args else None):
        _deny(f"loading a native library from outside the runtime: {args[0]!r}", event)

    if event in ("open", "os.open"):
        if _wants_write(args[1] if len(args) > 1 else None, args[2] if len(args) > 2 else None):
            _check_writable(args[0] if args else None, event)
        return

    indexes = WRITE_EVENT_PATHS.get(event)
    if indexes:
        for index in indexes:
            if len(args) > index:
                _check_writable(args[index], event)
        return

    if event == "os.chdir":
        target = _as_text(args[0] if args else None)
        if target and not _inside(_real(target), ROOT):
            _deny(f"chdir outside the workspace: {target}", event)


def _hook(event: str, args: tuple[object, ...]) -> None:
    global _busy
    if _busy:
        # 护栏自己会调 realpath（触发 os.listdir/lstat），别把自己再拦一遍
        return
    _busy = True
    try:
        _inspect(event, args)
    finally:
        _busy = False


def configure() -> None:
    """从环境变量读出边界；执行器一定会设好这几个变量。"""
    global ROOT, WRITABLE
    root = os.environ.get("PILOTDECK_ANALYSIS_ROOT", "")
    if not root:
        raise SystemExit("analysis_guard: PILOTDECK_ANALYSIS_ROOT is not set")
    ROOT = _real(root)
    writable = [os.path.join(ROOT, "exports"), os.path.join(ROOT, "scratch")]
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        writable.append(tmpdir)
    mplconfig = os.environ.get("MPLCONFIGDIR")
    if mplconfig:
        writable.append(mplconfig)
    WRITABLE = tuple(dict.fromkeys(_real(str(path)) for path in writable))


def main(argv: list[str]) -> int:
    if not argv:
        raise SystemExit("analysis_guard: missing script path")
    script = argv[0]
    configure()
    sys.addaudithook(_hook)
    sys.argv = [script, *argv[1:]]
    runpy.run_path(script, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
