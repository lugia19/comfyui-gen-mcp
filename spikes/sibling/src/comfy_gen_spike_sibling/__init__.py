"""Spike S7: if the worker can import this, pywrangler vendored a uv workspace sibling."""

import sys


def hello() -> str:
    return f"sibling package imported OK (Python {sys.version.split()[0]}, platform {sys.platform})"
