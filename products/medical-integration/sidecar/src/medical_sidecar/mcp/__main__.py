"""CLI entry for the standalone streamable HTTP MCP server."""

from __future__ import annotations

import argparse

from ..config import SidecarSettings
from .server import run_mcp


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the localhost-only medical MCP server")
    parser.add_argument("--config", help="Path to medical YAML config")
    args = parser.parse_args()
    run_mcp(SidecarSettings.load(args.config))


if __name__ == "__main__":
    main()

