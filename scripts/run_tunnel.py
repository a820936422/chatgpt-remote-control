#!/usr/bin/env python3
"""Exec the tunnel without shell or systemd nested command interpolation."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import re
import sys
import urllib.parse


def launch(deployment_path: str) -> None:
    deployment = json.loads(Path(deployment_path).read_text(encoding="utf-8"))
    for key in ("app", "node", "tunnel", "config"):
        value = deployment[key]
        if not isinstance(value, str) or not Path(value).is_absolute() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError(f"Invalid deployment path: {key}")
    port = deployment["healthPort"]
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("Invalid health port")
    proxy = deployment.get("proxy")
    if proxy is not None:
        if not isinstance(proxy, str) or not re.fullmatch(r"[A-Za-z0-9:/._%\[\]-]+", proxy):
            raise ValueError("Invalid proxy")
        parsed = urllib.parse.urlsplit(proxy)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError("Invalid proxy")
        parsed.port
    # deployment.json is authoritative even when runtime.env predates --force-config.
    for name in ("CONTROL_PLANE_HTTP_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                 "http_proxy", "https_proxy", "all_proxy"):
        if proxy:
            os.environ[name] = proxy
        else:
            os.environ.pop(name, None)
    for name in ("NO_PROXY", "no_proxy"):
        os.environ[name] = "localhost,127.0.0.1,::1"
    os.environ["HEALTH_LISTEN_ADDR"] = f"127.0.0.1:{port}"
    os.environ["LOG_LEVEL"] = "info"
    os.environ["CRC_CONFIG"] = deployment["config"]
    command = shlex.join([deployment["node"], str(Path(deployment["app"]) / "src/bridge.mjs")])
    tunnel = deployment["tunnel"]
    os.execv(tunnel, [tunnel, "run", "--mcp.command", command, "--health.listen-addr", f"127.0.0.1:{port}"])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: run_tunnel.py /absolute/path/to/deployment.json")
    try:
        launch(sys.argv[1])
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit("Cannot launch tunnel: check installed files and deployment.json.")
