"""CLI entry for the localhost-only FastAPI capability service."""

from __future__ import annotations

import argparse

from ..config import SidecarSettings, require_loopback_host
from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the localhost-only medical API")
    parser.add_argument("--config", help="Path to medical YAML config")
    args = parser.parse_args()
    settings = SidecarSettings.load(args.config)
    require_loopback_host(settings.api_host)

    try:
        import uvicorn
    except ImportError as exc:
        raise RuntimeError("Uvicorn is not installed; install the base sidecar requirements") from exc
    uvicorn.run(
        create_app(settings),
        host=settings.api_host,
        port=settings.api_port,
        reload=False,
        access_log=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()

