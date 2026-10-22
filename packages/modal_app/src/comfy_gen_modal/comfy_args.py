"""The Modal GPU's own ComfyUI flags: a list of arguments, after ours, so ours can be overridden.
The Worker checks them with core comfy-args.ts; this repeats its rules, since the admin endpoint
takes them from the network."""

from __future__ import annotations

import re

# Where ComfyUI listens and keeps its files is ours to set (as REFUSED_COMFY_FLAGS in core).
REFUSED = (
    "--listen", "--port", "--tls-keyfile", "--tls-certfile", "--enable-cors-header",
    "--input-directory", "--output-directory", "--temp-directory", "--user-directory", "--base-directory",
    "--extra-model-paths-config",
)
MAX_ARGS = 40
MAX_ARG_LENGTH = 300
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def validate_comfy_args(args) -> list[str]:
    """*args* if they can be the ComfyUI flags, else ValueError."""
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ValueError("args must be a list of strings")
    if len(args) > MAX_ARGS:
        raise ValueError(f"at most {MAX_ARGS} arguments")
    for a in args:
        if len(a) > MAX_ARG_LENGTH or _CONTROL.search(a):
            raise ValueError("an argument is too long or has a control character")
        if a.startswith("--"):
            name = a.split("=")[0]
            # argparse takes any unambiguous start of a flag's name: --liste is --listen.
            refused = next((f for f in REFUSED if len(name) > 3 and f.startswith(name)), None)
            if refused:
                raise ValueError(f"{refused} can't be set")
    if args and not args[0].startswith("-"):
        raise ValueError("the flags must start with a flag")
    return args
