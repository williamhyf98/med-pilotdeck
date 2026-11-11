#!/usr/bin/env python3
"""data-analysis 执行器（唯一入口）。

只做三件事：静态体检 → 受限执行 → 落产物。设计见
docs/data-analysis-skill-design.zh.md（§2 契约 / §4 安全 / §6 产物）。

安全边界：
- 静态：AST 黑名单（S1–S12）+ 字面量路径检查，**执行前**拒绝；
- 运行：子进程 + RLIMIT_* + 墙钟超时，另由 analysis_guard.py 装 audit hook
  拦住"算出来的"越界路径与网络/起进程（静态检查只能看字面量）；
- 环境：`python -I`（忽略 PYTHONPATH/用户 site），cwd 固定为脚本所在目录；
- 出网：由外层沙箱 `network: none` 兜底，本文件不再重复实现。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

VERSION = "1.0.0"

SCRIPT_DIR = Path(__file__).resolve().parent
GUARD_MODULE = SCRIPT_DIR / "analysis_guard.py"

# 用 -c 引导：`-I` 模式不会把 cwd 放进 sys.path，所以显式把技能脚本目录插进去。
GUARD_BOOTSTRAP = (
    "import sys;"
    "sys.path.insert(0, {dir!r});"
    "import analysis_guard;"
    "analysis_guard.main(sys.argv[1:])"
)

# 与 analysis_guard.DENIAL_MARKER 保持一致
GUARD_DENIAL_MARKER = "ANALYSIS_GUARD_DENIED "

EXIT_REJECTED = 3
EXIT_FAILED = 4
EXIT_TIMEOUT = 5
EXIT_OOM = 6
EXIT_RUNTIME_ERROR = 7
EXIT_BLOCKED = 8

# ---- 静态黑名单（spec §4 S1–S12）------------------------------------------

BLOCKED_MODULES = {
    "subprocess", "socket", "socketserver", "ctypes", "multiprocessing",
    "urllib", "urllib2", "http", "httplib", "requests", "httpx",
    "ftplib", "smtplib", "telnetlib", "xmlrpc", "pty", "asyncio",
    "importlib", "pickle", "shelve", "marshal",
}

BLOCKED_DOTTED_CALLS = {
    "os.system", "os.popen", "os.fork", "os.forkpty", "os.execv", "os.execve",
    "os.execl", "os.execle", "os.execlp", "os.execlpe", "os.execvp", "os.execvpe",
    "os.spawnv", "os.spawnve", "os.spawnl", "os.spawnle", "os.spawnlp", "os.spawnlpe",
    "os.spawnvp", "os.spawnvpe", "os.posix_spawn", "os.posix_spawnp",
    "os.startfile", "shutil.rmtree", "shutil.move",
    "importlib.import_module", "importlib.__import__",
    "builtins.eval", "builtins.exec", "builtins.compile", "builtins.__import__",
    "code.InteractiveInterpreter", "code.compile_command",
}

BLOCKED_BARE_CALLS = {"eval", "exec", "compile", "__import__", "breakpoint", "input"}

# 这些函数/构造器的第一个参数若为字面量，必须是工作区内的相对路径
PATHISH_CALLS = {
    "open", "io.open", "codecs.open", "gzip.open", "bz2.open", "lzma.open",
    "Path", "PurePath", "PosixPath", "WindowsPath",
    "pandas.read_csv", "pandas.read_excel", "pandas.read_json", "pandas.read_parquet",
    "numpy.load", "numpy.loadtxt", "numpy.genfromtxt", "json.load", "csv.open",
    "pydicom.dcmread", "wfdb.rdrecord", "nibabel.load",
}


class Rejection(Exception):
    def __init__(self, violations: list[dict[str, object]]):
        super().__init__("rejected")
        self.violations = violations


def _root(name: str) -> str:
    return name.split(".", 1)[0]


def _dotted(node: ast.AST) -> str:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    return ""


def _literal_path_violation(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if "\0" in value:
        return "path contains a null byte"
    normalized = value.replace("\\", "/")
    if normalized.startswith("~") or normalized.startswith("/") or (len(normalized) > 1 and normalized[1] == ":"):
        return f"absolute path literal: {value}"
    if ".." in normalized.split("/"):
        return f"parent-directory escape in path literal: {value}"
    return None


def scan_source(source: str) -> list[dict[str, object]]:
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return [{"line": error.lineno or 0, "rule": "syntax", "detail": str(error.msg)}]

    violations: list[dict[str, object]] = []

    def hit(node: ast.AST, rule: str, detail: str) -> None:
        violations.append({"line": getattr(node, "lineno", 0), "rule": rule, "detail": detail})

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _root(alias.name) in BLOCKED_MODULES:
                    hit(node, "blocked-import", alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if _root(module) in BLOCKED_MODULES:
                hit(node, "blocked-import", module)
            if module in {"os", "shutil", "code", "builtins"}:
                for alias in node.names:
                    if f"{module}.{alias.name}" in BLOCKED_DOTTED_CALLS:
                        hit(node, "blocked-import", f"{module}.{alias.name}")
        elif isinstance(node, ast.Call):
            dotted = _dotted(node.func)
            bare = dotted.rsplit(".", 1)[-1] if dotted else ""
            if dotted in BLOCKED_DOTTED_CALLS or (bare in BLOCKED_BARE_CALLS and "." not in dotted):
                hit(node, "blocked-call", dotted or bare)
            if dotted in PATHISH_CALLS and node.args:
                problem = _literal_path_violation(node.args[0].value if isinstance(node.args[0], ast.Constant) else None)
                if problem:
                    hit(node, "path-literal", problem)
        elif isinstance(node, ast.Attribute):
            dotted = _dotted(node)
            if dotted in BLOCKED_DOTTED_CALLS:
                hit(node, "blocked-attribute", dotted)

    return violations


# ---- 路径与产物 ------------------------------------------------------------


def _within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_inside(root: Path, value: str, allowed: tuple[str, ...], label: str) -> Path:
    target = Path(value)
    resolved = (root / target).resolve() if not target.is_absolute() else target.resolve()
    if not _within(root, resolved):
        raise SystemExit(_fail(f"{label} must stay inside the workspace: {value}"))
    first = resolved.relative_to(root).parts[0] if resolved != root else ""
    if first not in allowed:
        raise SystemExit(_fail(f"{label} must be under {'|'.join(allowed)}: {value}"))
    return resolved


def _fail(message: str, code: int = 2) -> int:
    print(json.dumps({"status": "error", "error": message}, ensure_ascii=False))
    return code


def _sha256(path: Path, limit_bytes: int = 64 * 1024 * 1024) -> str | None:
    try:
        if path.stat().st_size > limit_bytes:
            return None
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _input_fingerprint(root: Path, target: Path | None, max_files: int = 400) -> list[dict[str, object]]:
    if target is None or not target.exists():
        return []
    files: list[Path] = [target] if target.is_file() else sorted(
        path for path in target.rglob("*") if path.is_file()
    )[:max_files]
    return [
        {
            "path": str(path.relative_to(root)),
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
        for path in files
    ]


def _dependencies() -> dict[str, str]:
    wanted = [
        "pandas", "numpy", "scipy", "scikit-learn", "statsmodels", "lifelines",
        "pingouin", "matplotlib", "seaborn", "openpyxl", "pyarrow", "pydicom", "nibabel", "wfdb",
    ]
    result: dict[str, str] = {}
    try:
        from importlib import metadata
    except Exception:  # pragma: no cover
        return result
    for name in wanted:
        try:
            result[name] = metadata.version(name)
        except Exception:
            continue
    return result


def _guard_denials(stderr: str) -> list[dict[str, object]]:
    """从 stderr 里捞出运行期护栏的拒绝记录（可能有多条）。"""
    denials: list[dict[str, object]] = []
    for line in stderr.splitlines():
        if not line.startswith(GUARD_DENIAL_MARKER):
            continue
        try:
            payload = json.loads(line[len(GUARD_DENIAL_MARKER):])
        except json.JSONDecodeError:
            continue
        denials.append(
            {
                "rule": "runtime-guard",
                "event": payload.get("event", ""),
                "detail": payload.get("detail", ""),
            }
        )
    return denials


# ---- 执行 ------------------------------------------------------------------


def _limits(mem_mb: int, cpu_seconds: int):
    """preexec_fn：逐项尽力设置资源上限。

    macOS 不支持 RLIMIT_AS（setrlimit 直接抛 OSError），而 preexec_fn 里抛任何
    异常都会让整个 subprocess 启动失败——连正常脚本都跑不起来。所以每一项
    单独 try，失败就跳过：Linux 交付环境 RLIMIT_AS 生效，macOS 开发机退化成
    RLIMIT_DATA。内存上限的权威兜底仍是容器 cgroup（spec §4 R2）。
    """
    mem_bytes = mem_mb * 1024 * 1024
    table = (
        ("RLIMIT_AS", mem_bytes, mem_bytes),
        ("RLIMIT_DATA", mem_bytes, mem_bytes),
        ("RLIMIT_CPU", cpu_seconds, cpu_seconds + 1),
        ("RLIMIT_CORE", 0, 0),
        ("RLIMIT_NOFILE", 256, 256),
    )

    def apply() -> None:
        for name, soft, hard in table:
            limit = getattr(resource, name, None)
            if limit is None:
                continue
            try:
                resource.setrlimit(limit, (soft, hard))
            except (OSError, ValueError):
                continue

    return apply


def run(args: argparse.Namespace) -> int:
    root = Path.cwd().resolve()
    script = _resolve_inside(root, args.script, ("scratch",), "--script")
    if script.suffix != ".py":
        return _fail("--script must be a .py file")
    if not script.is_file():
        return _fail(f"--script not found: {args.script}")
    out_dir = _resolve_inside(root, args.out, ("exports",), "--out")
    input_dir = _resolve_inside(root, args.input, ("inbox", "scratch"), "--input") if args.input else None

    if not GUARD_MODULE.is_file():
        return _fail(f"runtime guard is missing: {GUARD_MODULE}", code=EXIT_RUNTIME_ERROR)

    source = script.read_text(encoding="utf-8", errors="replace")
    violations = scan_source(source)
    if violations:
        print(json.dumps({"status": "rejected", "violations": violations}, ensure_ascii=False))
        return EXIT_REJECTED

    (out_dir / "figures").mkdir(parents=True, exist_ok=True)
    (out_dir / "tables").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(script, out_dir / "code.py")

    started = time.time()
    # 字体缓存由 analysis.sh 统一给出并预热（与服务端共享），没给就退回工作区内
    mpl_config = os.environ.get("MPLCONFIGDIR") or str(root / "scratch" / ".analysis-cache" / "mpl")
    Path(mpl_config).mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", str(root)),
        "LANG": "C.UTF-8",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": mpl_config,
        "PYTHONHASHSEED": "0",
        "PILOTDECK_ANALYSIS_ROOT": str(root),
        "PILOTDECK_ANALYSIS_INPUT": str(input_dir) if input_dir else "",
        "PILOTDECK_ANALYSIS_OUT": str(out_dir),
        "PILOTDECK_ANALYSIS_FONTS": os.environ.get("PILOTDECK_ANALYSIS_FONTS", ""),
    }
    timed_out = False
    try:
        completed = subprocess.run(
            [
                sys.executable, "-I", "-B",
                "-c", GUARD_BOOTSTRAP.format(dir=str(SCRIPT_DIR)),
                str(script),
            ],
            cwd=str(script.parent),
            env=env,
            capture_output=True,
            text=True,
            timeout=args.timeout,
            start_new_session=True,
            preexec_fn=_limits(args.mem_mb, args.timeout + 1),
        )
        exit_code = completed.returncode
        stdout, stderr = completed.stdout, completed.stderr
    except subprocess.TimeoutExpired as expired:
        timed_out = True
        exit_code = -signal.SIGKILL
        stdout = (expired.stdout or "").decode() if isinstance(expired.stdout, bytes) else (expired.stdout or "")
        stderr = (expired.stderr or "").decode() if isinstance(expired.stderr, bytes) else (expired.stderr or "")
    except subprocess.SubprocessError as error:
        return _fail(f"failed to start analysis subprocess: {error}", code=EXIT_RUNTIME_ERROR)

    out_of_memory = (not timed_out) and (exit_code in (-9, 137) or "MemoryError" in stderr)
    denials = _guard_denials(stderr)
    record = {
        "status": "timeout" if timed_out else ("blocked" if denials else ("ok" if exit_code == 0 else "failed")),
        "runnerVersion": VERSION,
        "python": sys.version.split()[0],
        "script": str(script.relative_to(root)),
        "scriptSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "out": str(out_dir.relative_to(root)),
        "input": str(input_dir.relative_to(root)) if input_dir else None,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "oom": out_of_memory,
        "durationMs": int((time.time() - started) * 1000),
        "limits": {"timeoutSeconds": args.timeout, "memMb": args.mem_mb, "enforcement": "best-effort"},
        "guard": GUARD_MODULE.name,
        "inputs": _input_fingerprint(root, input_dir),
        "dependencies": _dependencies(),
        "stdoutTail": stdout[-4000:],
        "stderrTail": stderr[-4000:],
    }
    if timed_out:
        runner_exit = EXIT_TIMEOUT
    elif out_of_memory:
        runner_exit = EXIT_OOM
    elif denials:
        runner_exit = EXIT_BLOCKED
    else:
        runner_exit = 0 if exit_code == 0 else EXIT_FAILED

    record["runnerExitCode"] = runner_exit
    if denials:
        record["violations"] = denials
    (out_dir / "run.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    headline = {
        key: record[key]
        for key in ("status", "runnerExitCode", "exitCode", "timedOut", "oom", "durationMs", "out")
    }
    if denials:
        headline["violations"] = denials
    print(json.dumps(headline, ensure_ascii=False))
    return runner_exit


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="run_analysis.py", add_help=True)
    parser.add_argument("--script", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--input")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--mem-mb", dest="mem_mb", type=int, default=4096)
    args = parser.parse_args(argv)

    args.timeout = max(1, min(int(args.timeout), 1800))
    args.mem_mb = max(256, min(int(args.mem_mb), 8192))
    return run(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
