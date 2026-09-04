"""Optional loopback-only Streamable HTTP entrypoint for mineru-ingest-tools.

The tool definitions live in :mod:`server.mineru_ingest_app`; this module only
changes the MCP transport.  Keeping the entrypoints separate lets the default
PilotDeck stdio integration remain lightweight and port-free.
"""

from __future__ import annotations

from .mineru_ingest_app import mcp


def main() -> None:
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
