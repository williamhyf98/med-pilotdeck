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
import re
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

# 失败时要回传给 agent 的诊断信息上限。跑不通的时候，agent 唯一能自我修复的依据
# 就是 stderr 末尾几行（Python traceback 的最后一行才是 `KeyError: ...` + 行号）。
# 2026-11-12 实跑教训：只回传 `{"status":"failed"}` 时 agent 看不到原因，只能猜，
# 猜的方式是去 python3 读 run.json，又被自动化策略拦下——白白烧掉 3~4 次工具调用。
STDERR_TAIL_LIMIT = 1600
STDOUT_TAIL_LIMIT = 600

# 每种非 ok 状态给一句"下一步怎么改"，避免 agent 反复重试同一条命令。
FAILURE_HINTS = {
    "failed": (
        "The script raised an exception at runtime; stderrTail ends with the exception and its line. "
        "Fix the script, then rerun (a failed --out directory may be reused in place)."
    ),
    "timeout": (
        "The script exceeded --timeout and was killed. Reduce the workload, or raise --timeout (max 1800)."
    ),
    "oom": (
        "The script exceeded --mem-mb. Read large tables in chunks (pandas chunksize) or raise --mem-mb (max 8192)."
    ),
    "blocked": (
        "The runtime guard denied an operation (see violations). Do not try to work around it: "
        "keep the script inside the workspace and use local computation only."
    ),
}

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


def _tail(text: str, limit: int) -> str:
    """保留末尾 limit 个字符（traceback 的结论在末尾），截断处加省略号。"""
    stripped = text.strip()
    if limit <= 0 or not stripped:
        return ""
    if len(stripped) <= limit:
        return stripped
    return "…" + stripped[-limit:]


def _error_summary(stderr: str, limit: int = 300) -> str:
    """traceback 的最后一行就是结论（`KeyError: 'x'` / `NameError: ...`）。

    stderr 开头往往是执行器自己的引导帧（analysis_guard / runpy），单独拎出最后
    一行，模型不用在噪声里找结论。
    """
    for line in reversed(stderr.strip().splitlines()):
        stripped = line.strip()
        if stripped:
            return stripped[:limit]
    return ""


# ---- 轮次目录与报告骨架（设计书 §6，2026-11-12 改版）------------------------
#
# 单位从「一次运行」改成「一轮对话」：
#   * 同一轮里重试、追加步骤都写同一个根目录（根目录在第一次调用时钉住）；
#   * 下一轮开新目录，旧目录原样保留；
#   * 失败就地重试：半成品留在原地给 agent 读，下一次运行开始前清掉。
# 没有轮次上下文时（终端手跑、测试脚本）退化为 2026-11-11 的旧语义，
# 免得这套规则把 CLI 用法一起绑死。

ROOT_PIN_FILE = ".analysis-root.json"
TIMESTAMP_EDGE = re.compile(r"^\d{8}-\d{6}-")
EXECUTOR_FILES = ("code.py", "run.json", "report.md")

INDEX_START = "<!-- index:start -->"
INDEX_END = "<!-- index:end -->"
CONCLUSION_TODO = "<!-- TODO(agent): 在这里写结论，写完后删除本行 -->"


def _now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _safe_segment(value: str) -> str:
    """目录名片段：去掉控制字符与文件系统非法字符，不许以点开头/结尾。"""
    cleaned = re.sub(r"[\x00-\x1f\x7f<>:\"|?*]", "", value)
    cleaned = cleaned.replace("/", "-").replace("\\", "-").strip().strip(".")
    return cleaned[:40] or "分析"


def _turn_work_dir(root: Path) -> Path | None:
    """本轮的工作目录；没有轮次上下文返回 None。"""
    raw = (os.environ.get("PILOTDECK_WORK_DIR") or "").strip()
    if not raw:
        turn = (os.environ.get("PILOTDECK_TURN_ID") or "").strip()
        if not turn:
            return None
        raw = str(root / "scratch" / "work" / _safe_segment(turn))
    path = Path(raw)
    return path if path.is_absolute() else root / path


def _load_pin(turn_dir: Path | None) -> dict[str, object] | None:
    if turn_dir is None:
        return None
    try:
        data = json.loads((turn_dir / ROOT_PIN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _save_pin(turn_dir: Path | None, data: dict[str, object]) -> None:
    if turn_dir is None:
        return
    turn_dir.mkdir(parents=True, exist_ok=True)
    (turn_dir / ROOT_PIN_FILE).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _plan_out(raw_out: str, turn_dir: Path | None, root: Path) -> tuple[str, str | None, str | None]:
    """把 `--out` 归一到本轮钉住的根目录。

    返回 `(相对路径, 本轮根目录, 备注)`；根目录为 None 表示没有轮次上下文。
    第一段是根目录（钉住后一律改写回），其后的段保留为子目录 —— 同一轮里
    互不相关的第二件事可以写 `exports/<根>/02-<子主题>`，但另起一个根目录不行。
    """
    parts = [seg for seg in raw_out.replace("\\", "/").split("/") if seg not in ("", ".")]
    if len(parts) < 2 or parts[0] != "exports":
        return raw_out, None, None

    topic, rest = parts[1], parts[2:]
    pin = _load_pin(turn_dir)
    if pin and isinstance(pin.get("root"), str) and pin["root"]:
        pinned = str(pin["root"])
        suffix = "".join(f"/{seg}" for seg in rest)
        note = None
        if topic != pinned.split("/", 1)[-1]:
            note = (
                f"本轮根目录已钉住为 {pinned}；要开子目录请写成 {pinned}/02-<子主题>，"
                "不要另起目录"
            )
        return pinned + suffix, pinned, note

    if turn_dir is None:
        return raw_out, None, None

    name = _safe_segment(topic) if TIMESTAMP_EDGE.match(topic) else f"{_now_stamp()}-{_safe_segment(topic)}"
    # 同一秒内起两轮、或上一轮留下同名目录时，避免撞名后写进别人的目录。
    candidate, index = name, 2
    while (root / "exports" / candidate).exists():
        candidate = f"{name}-{index}"
        index += 1
    name = candidate
    root_rel = f"exports/{name}"
    _save_pin(turn_dir, {"root": root_rel, "createdAt": _now_iso()})
    return "/".join([root_rel] + rest), root_rel, None


def _snapshot_outputs(out_dir: Path) -> dict[str, tuple[int, int]]:
    """记录产物区现有文件的 (mtime_ns, size)，用来反算本次运行写出了什么。"""
    snapshot: dict[str, tuple[int, int]] = {}
    if not out_dir.is_dir():
        return snapshot
    for path in out_dir.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(out_dir)
        if len(relative.parts) == 1 and relative.name in EXECUTOR_FILES:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        snapshot[str(relative)] = (int(stat.st_mtime_ns), stat.st_size)
    return snapshot


def _produced_outputs(out_dir: Path, before: dict[str, tuple[int, int]]) -> list[str]:
    after = _snapshot_outputs(out_dir)
    return sorted(rel for rel, meta in after.items() if before.get(rel) != meta)


def _format_size(num: int) -> str:
    value = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.0f} B"


def _index_block(out_dir: Path) -> str:
    rows = ["| 文件 | 类型 | 大小 |", "|---|---|---|"]
    for sub, kind in (("tables", "表"), ("figures", "图")):
        base = out_dir / sub
        if not base.is_dir():
            continue
        for path in sorted(p for p in base.rglob("*") if p.is_file() and not p.is_symlink()):
            rows.append(
                f"| `{path.relative_to(out_dir)}` | {kind} | {_format_size(path.stat().st_size)} |"
            )
    for path in sorted(p for p in out_dir.iterdir() if p.is_file() and p.name not in EXECUTOR_FILES):
        rows.append(f"| `{path.name}` | 其他 | {_format_size(path.stat().st_size)} |")
    return "\n".join(rows)


def _report_skeleton(out_dir: Path, record: dict[str, object]) -> str:
    topic = TIMESTAMP_EDGE.sub("", out_dir.name) or out_dir.name
    inputs = record.get("inputs") or []
    source = "、".join(f"`{item.get('path')}`" for item in inputs[:3]) or "（无 `--input`）"
    dependencies = record.get("dependencies") or {}
    dep_text = "、".join(f"{name} {version}" for name, version in list(dependencies.items())[:6]) or "—"
    sha = str(record.get("scriptSha256") or "")[:12]
    return (
        f"# {topic}\n\n"
        "> 执行器生成的骨架：`## 结论` 由 agent 补写，其余内容不要手改。\n\n"
        "## 数据口径\n\n"
        "| 项 | 内容 |\n"
        "|---|---|\n"
        f"| 输入 | {source} |\n"
        f"| 脚本 | `code.py`（sha256 `{sha}`） |\n"
        f"| 运行 | Python {record.get('python')} · {record.get('durationMs')} ms |\n"
        f"| 依赖 | {dep_text} |\n\n"
        "## 产物索引\n\n"
        f"{INDEX_START}\n{_index_block(out_dir)}\n{INDEX_END}\n\n"
        "## 结论\n\n"
        f"{CONCLUSION_TODO}\n"
    )


def _refresh_report(out_dir: Path, record: dict[str, object]) -> bool:
    """生成/刷新 `report.md`，返回 `reportMissing`（结论是否还没写）。"""
    path = out_dir / "report.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        text = ""

    if not text.strip():
        path.write_text(_report_skeleton(out_dir, record), encoding="utf-8")
        return True

    # 只替换索引块：agent 已经写下的正文和结论一个字都不动。
    if INDEX_START in text and INDEX_END in text:
        head, _, tail = text.partition(INDEX_START)
        _, _, rest = tail.partition(INDEX_END)
        path.write_text(
            f"{head}{INDEX_START}\n{_index_block(out_dir)}\n{INDEX_END}{rest}",
            encoding="utf-8",
        )
        text = path.read_text(encoding="utf-8")
    return CONCLUSION_TODO in text


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
    turn_dir = _turn_work_dir(root)
    planned_out, turn_root, turn_note = _plan_out(args.out, turn_dir, root)
    out_dir = _resolve_inside(root, planned_out, ("exports",), "--out")
    # `exports` 也可读：链式分析（上一次 run 的 tables/*.csv 直接作为下一次输入）不必
    # 先拷回 scratch。写路径仍然只允许 exports（见 analysis_guard 与 --out）。
    input_dir = (
        _resolve_inside(root, args.input, ("inbox", "scratch", "exports"), "--input")
        if args.input
        else None
    )

    # 轮次内允许覆盖（重试 / 追加步骤），跨轮拒绝：没有轮次上下文时（CLI、测试）
    # 维持 2026-11-11 的旧语义——已成功的目录不许被第二次运行覆盖。
    existing = out_dir / "run.json"
    previous: dict[str, object] = {}
    if existing.is_file():
        try:
            loaded = json.loads(existing.read_text(encoding="utf-8"))
            previous = loaded if isinstance(loaded, dict) else {}
        except (OSError, ValueError):
            previous = {}
        if previous.get("status") == "ok" and turn_dir is None:
            return _fail(
                "--out already holds a successful run: "
                f"{args.out}. Run again into a new timestamped directory "
                f"(e.g. exports/{_now_stamp()}-<topic>) "
                "so earlier outputs stay intact and never mix with this run."
            )

    attempts: list[dict[str, object]] = [
        item for item in (previous.get("attempts") or []) if isinstance(item, dict)
    ]
    steps: list[dict[str, object]] = [
        item for item in (previous.get("steps") or []) if isinstance(item, dict)
    ]

    # 就地上一次失败留下的半成品：先清掉，保证本次运行的起点是干净的。
    # 放在"运行前"而不是"成功后"，是为了避免追加写 / `if exists: skip` 把旧内容
    # 混进新结果（见设计书 §6.2）。agent 在两次运行之间有足够时间读这些文件。
    if attempts and attempts[-1].get("status") != "ok" and not attempts[-1].get("cleaned"):
        for relative in attempts[-1].get("produced") or []:
            target = out_dir / str(relative)
            if target.is_file():
                try:
                    target.unlink()
                except OSError:
                    continue
        attempts[-1]["cleaned"] = True

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
    before = _snapshot_outputs(out_dir)

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
    produced = _produced_outputs(out_dir, before)
    if timed_out:
        status = "timeout"
    elif denials:
        status = "blocked"
    elif out_of_memory:
        status = "oom"
    else:
        status = "ok" if exit_code == 0 else "failed"
    script_sha = hashlib.sha256(source.encode("utf-8")).hexdigest()
    record = {
        "status": status,
        "runnerVersion": VERSION,
        "python": sys.version.split()[0],
        "script": str(script.relative_to(root)),
        "scriptSha256": script_sha,
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

    # 轮次目录：同一轮里重试与追加步骤都记在同一个 run.json 里，目录只有一个。
    attempts.append(
        {
            "attempt": len(attempts) + 1,
            "status": status,
            "exitCode": exit_code,
            "scriptSha256": script_sha,
            "produced": produced,
            "at": _now_iso(),
            "cleaned": False,
        }
    )
    record["runMode"] = "turn" if turn_dir is not None else "standalone"
    record["attempt"] = len(attempts)
    record["attempts"] = attempts
    if turn_root:
        record["root"] = turn_root
    if turn_note:
        record["note"] = turn_note

    if status == "ok":
        steps.append(
            {
                "step": len(steps) + 1,
                "scriptSha256": script_sha,
                "produced": produced,
                "at": _now_iso(),
            }
        )
        report_missing = _refresh_report(out_dir, record)
    else:
        try:
            report_missing = CONCLUSION_TODO in (out_dir / "report.md").read_text(encoding="utf-8")
        except OSError:
            report_missing = True
    record["steps"] = steps
    record["reportMissing"] = report_missing

    (out_dir / "run.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    headline = {
        key: record[key]
        for key in ("status", "runnerExitCode", "exitCode", "timedOut", "oom", "durationMs", "out")
    }
    if turn_root:
        headline["root"] = turn_root
    if turn_note:
        headline["note"] = turn_note
    if status == "ok":
        headline["reportMissing"] = report_missing
    elif produced:
        # 半成品留在目录里给 agent 看；下次运行开始前会被自动清掉。
        headline["staleFiles"] = produced
    if denials:
        headline["violations"] = denials
    if status != "ok":
        # 失败时把诊断一起交回去：agent 靠自己写脚本，看不到 traceback 就只能瞎猜。
        # 成功时不打这些字段，避免正常路径平白多出几百 token。
        summary = _error_summary(stderr)
        if summary:
            headline["errorSummary"] = summary
        headline["stderrTail"] = _tail(stderr, STDERR_TAIL_LIMIT)
        stdout_tail = _tail(stdout, STDOUT_TAIL_LIMIT)
        if stdout_tail:
            headline["stdoutTail"] = stdout_tail
        headline["logPath"] = str((out_dir / "run.json").relative_to(root))
        hint = FAILURE_HINTS.get(status)
        if hint:
            headline["hint"] = hint
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
