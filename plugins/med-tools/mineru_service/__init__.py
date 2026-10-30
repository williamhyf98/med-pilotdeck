"""HTTP service wrapper for the node12 MinerU runtime."""

__all__ = ["create_app"]


def create_app(*args, **kwargs):
    from .app import create_app as _create_app

    return _create_app(*args, **kwargs)
