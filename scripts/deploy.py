#!/usr/bin/env python3
"""Install and manage the per-user ChatGPT remote-control service (Python 3.10+)."""
from __future__ import annotations

import argparse
import contextlib
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import zipfile
from dataclasses import dataclass

UNIT = "chatgpt-remote-control.service"
VERSION = "0.0.14"
TUNNEL_URL = f"https://github.com/openai/tunnel-client/releases/download/v{VERSION}/tunnel-client-v{VERSION}-linux-amd64.zip"
TUNNEL_SHA256 = "15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3"
DEFAULT_HEALTH_PORT = 18081
OPERATION_TIMEOUT = 300
REPOSITORY = Path(__file__).resolve().parents[1]


class DeployError(Exception):
    pass


def clean_text(value: str) -> str:
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise DeployError("Control characters are not permitted.")
    return value


@dataclass(frozen=True)
class Paths:
    home: Path
    data: Path
    config: Path
    state: Path
    unit: Path

    @classmethod
    def from_home(cls, home: str | None = None) -> "Paths":
        root = Path(home).expanduser().resolve() if home else Path.home().resolve()
        def base(env: str, fallback: str) -> Path:
            value = os.environ.get(env) if home is None else None
            path = Path(value) if value and Path(value).is_absolute() else root / fallback
            clean_text(str(path))
            return path
        config_base = base("XDG_CONFIG_HOME", ".config")
        return cls(root, base("XDG_DATA_HOME", ".local/share") / "chatgpt-remote-control",
                   config_base / "chatgpt-remote-control",
                   base("XDG_STATE_HOME", ".local/state") / "chatgpt-remote-control",
                   config_base / "systemd/user" / UNIT)

    @property
    def app(self) -> Path:
        return self.data / "app"

    @property
    def deployment(self) -> Path:
        return self.config / "deployment.json"

    @property
    def runtime(self) -> Path:
        return self.config / "runtime.env"


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise DeployError(f"Refusing symlink directory: {path}")
    path.chmod(0o700)


def atomic_write(path: Path, content: str | bytes, mode: int = 0o600) -> None:
    """Same-filesystem replacement; any failure before rename preserves old bytes."""
    data = content.encode("utf-8") if isinstance(content, str) else content
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def write_json(path: Path, value: dict, force: bool = False) -> None:
    if path.exists() and not force:
        print(f"Preserved existing configuration: {path}")
        return
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def load_deployment(paths: Paths) -> dict:
    try:
        value = json.loads(paths.deployment.read_text(encoding="utf-8"))
        for field in ("app", "node", "tunnel", "config"):
            if not isinstance(value[field], str) or not Path(clean_text(value[field])).is_absolute():
                raise ValueError(field)
        validate_port(value["healthPort"])
        validate_proxy(value.get("proxy"))
        return value
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise DeployError("Missing or invalid deployment.json; run install first.") from exc


def validate_port(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise DeployError("Health port must be an integer from 1 to 65535.")
    return value


def validate_proxy(value: str | None) -> str | None:
    if value is None:
        return None
    clean_text(value)
    try:
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError()
        parsed.port
    except ValueError as exc:
        raise DeployError("Proxy must be an http(s) URL without credentials, query, or path.") from exc
    if not re.fullmatch(r"[A-Za-z0-9:/._%\[\]-]+", value):
        raise DeployError("Proxy URL contains unsupported characters.")
    return value


def env_quote(value: str) -> str:
    clean_text(value)
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def credential(value: str, label: str) -> str:
    # A strict ASCII allowlist deliberately rejects shell/env syntax and newlines.
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,4096}", value):
        raise DeployError(f"{label} contains unsupported characters or is empty.")
    return value


def runtime_env(tunnel_id: str, key: str, deployment: dict) -> str:
    values = {
        "CONTROL_PLANE_TUNNEL_ID": credential(tunnel_id, "Tunnel ID"),
        "CONTROL_PLANE_API_KEY": credential(key, "Runtime key"),
        "CRC_CONFIG": clean_text(deployment["config"]),
        "HEALTH_LISTEN_ADDR": f"127.0.0.1:{validate_port(deployment['healthPort'])}",
        "LOG_LEVEL": "info",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
    }
    proxy = validate_proxy(deployment.get("proxy"))
    if proxy:
        values["CONTROL_PLANE_HTTP_PROXY"] = proxy
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            values[name] = proxy
    return "".join(f"{name}={env_quote(value)}\n" for name, value in values.items())


def unit_quote(value: str, command: bool = False) -> str:
    value = clean_text(value).replace("%", "%%")
    # Scalar path settings treat quotes literally; only ExecStart uses word quoting.
    if not command:
        return value
    value = value.replace("$", "$$")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_unit(paths: Paths, python: str | None = None) -> str:
    command = [python or sys.executable, str(paths.app / "scripts/run_tunnel.py"), str(paths.deployment)]
    return "\n".join([
        "[Unit]", "Description=ChatGPT Remote Control (Secure MCP Tunnel)",
        f"ConditionPathExists={unit_quote(str(paths.runtime))}", "", "[Service]", "Type=simple",
        f"EnvironmentFile={unit_quote(str(paths.runtime))}",
        f"ExecStart={' '.join(unit_quote(part, command=True) for part in command)}",
        f"WorkingDirectory={unit_quote(str(paths.app))}", "UMask=0077", "KillMode=control-group",
        "Restart=always", "RestartSec=5", "", "[Install]", "WantedBy=default.target", "",
    ])


def systemctl(*args: str, check: bool = True, timeout: float = 20) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DeployError("Cannot reach systemd user manager.") from exc
    if check and result.returncode:
        raise DeployError(f"systemctl --user {' '.join(args)} failed (exit {result.returncode}).")
    return result


def refuse_active_update(paths: Paths, no_systemd: bool) -> None:
    if not paths.app.exists():
        return
    if no_systemd:
        if paths.unit.exists():
            raise DeployError("Managed installation exists; omit --no-systemd so its stopped state can be verified.")
        return
    result = systemctl("is-active", UNIT, check=False)
    state = result.stdout.strip()
    if state not in ("inactive", "failed", "unknown") or result.returncode not in (3, 4):
        raise DeployError(f"Refusing update: stop or verify the service first: systemctl --user stop {UNIT}")


def memory_guard() -> None:
    try:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            info[key] = int(value.split()[0])
    except (OSError, ValueError):
        return
    if info.get("MemAvailable", info["MemTotal"]) <= info["MemTotal"] * 0.05:
        raise DeployError("Aborted: system memory usage reached the 95% limit.")


def progress(label: str, started: float, detail: str = "") -> None:
    own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    child = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
    print(f"{label}: {time.monotonic() - started:.1f}s; peak RSS self={own:.1f} MiB, completed children={child:.1f} MiB {detail}", flush=True)


@contextlib.contextmanager
def time_limit(seconds: float, label: str):
    """Bound blocking I/O (including DNS and slow responses) in this Linux CLI."""
    if seconds <= 0:
        raise DeployError(f"{label} timed out.")
    def expired(signum, frame):
        raise DeployError(f"{label} timed out.")
    started = time.monotonic()
    previous_handler = signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])


def run_npm(stage: Path, node: str, proxy: str | None = None) -> None:
    proxy = validate_proxy(proxy)
    npm = shutil.which("npm", path=str(Path(node).parent))
    if not npm:
        npm = shutil.which("npm")
    if not npm:
        raise DeployError("npm not found; install npm alongside Node.js or use --skip-npm.")
    npm_script = Path(npm).resolve()
    env = os.environ.copy()
    env["PATH"] = str(Path(node).parent) + os.pathsep + env.get("PATH", "")
    env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    if proxy:
        env["npm_config_proxy"] = proxy
        env["npm_config_https_proxy"] = proxy
    started = time.monotonic()
    deadline = started + OPERATION_TIMEOUT
    memory_guard()
    progress("npm ci", started)
    proc = subprocess.Popen([node, str(npm_script), "ci", "--ignore-scripts"], cwd=stage, env=env, start_new_session=True)
    completed = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeployError("npm ci timed out; installed app was not replaced.")
            try:
                code = proc.wait(timeout=min(2, remaining))
                break
            except subprocess.TimeoutExpired:
                memory_guard()
                progress("npm ci", started)
        if code:
            raise DeployError(f"npm ci failed (exit {code}); installed app was not replaced.")
        completed = True
    finally:
        if not completed:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            finally:
                # The leader may exit before its children; clean the entire group.
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired as exc:
                raise DeployError("npm ci cleanup timed out after terminating its process group.") from exc
    progress("npm ci finished", started)


def extract_tunnel(archive: Path, destination: Path, digest: str = TUNNEL_SHA256) -> None:
    hasher = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    if hasher.hexdigest() != digest:
        raise DeployError("Tunnel archive SHA256 mismatch; nothing was extracted.")
    with zipfile.ZipFile(archive) as package:
        matches = [entry for entry in package.infolist() if entry.filename == "tunnel-client"]
        if len(matches) != 1:
            raise DeployError("Archive must contain exactly one root-level tunnel-client binary.")
        entry = matches[0]
        mode = entry.external_attr >> 16
        if entry.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
            raise DeployError("Tunnel archive binary must be a regular file.")
        if entry.file_size > 512 * 1024 * 1024:
            raise DeployError("Tunnel binary exceeds the size limit.")
        fd, name = tempfile.mkstemp(prefix=".tunnel-", dir=destination.parent)
        temp = Path(name)
        try:
            with os.fdopen(fd, "wb") as out, package.open(entry) as source:
                os.fchmod(out.fileno(), 0o700)
                while block := source.read(1024 * 1024):
                    memory_guard()
                    out.write(block)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, destination)
        finally:
            temp.unlink(missing_ok=True)


def download_tunnel(destination: Path, proxy: str | None = None) -> None:
    proxy = validate_proxy(proxy)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(
        {"http": proxy, "https": proxy} if proxy else {}))
    started = time.monotonic()
    memory_guard()
    progress("Downloading tunnel-client", started)
    fd, name = tempfile.mkstemp(prefix=".tunnel-download-", dir=destination.parent)
    archive = Path(name)
    try:
        total = 0
        report_at = started
        with os.fdopen(fd, "wb") as out, time_limit(OPERATION_TIMEOUT, "Tunnel download"):
            with opener.open(TUNNEL_URL, timeout=min(30, OPERATION_TIMEOUT)) as response:
                while block := response.read(1024 * 1024):
                    memory_guard()
                    total += len(block)
                    if total > 512 * 1024 * 1024:
                        raise DeployError("Tunnel download exceeds the size limit.")
                    out.write(block)
                    if time.monotonic() - report_at >= 2:
                        progress("Downloading tunnel-client", started, f"{total / 1048576:.1f} MiB")
                        report_at = time.monotonic()
            out.close()
            extract_tunnel(archive, destination)
        progress("Verified tunnel-client", started, f"{total / 1048576:.1f} MiB")
    finally:
        archive.unlink(missing_ok=True)


def executable(value: str | None, candidates: tuple[str, ...], required: bool = True) -> str | None:
    found = shutil.which(value) if value else next((p for name in candidates if (p := shutil.which(name))), None)
    if not found:
        if required:
            raise DeployError(f"Executable not found: {value or ', '.join(candidates)}")
        return None
    result = str(Path(found).absolute())  # Keep wrapper/symlink name for multicall launchers.
    clean_text(result)
    return result


def validate_node(node: str) -> None:
    try:
        result = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DeployError("Cannot verify Node.js version; Node.js >=22 is required.") from exc
    version = re.fullmatch(r"v(\d+)\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", result.stdout.strip())
    if result.returncode or not version or int(version.group(1)) < 22:
        raise DeployError("Node.js >=22 is required; the selected executable failed version validation.")


def install(args: argparse.Namespace) -> None:
    if sys.platform != "linux" or platform.machine() not in ("x86_64", "amd64"):
        raise DeployError("This installer supports Linux x86_64 only.")
    paths = Paths.from_home(args.home)
    refuse_active_update(paths, args.no_systemd)
    validate_port(args.health_port)
    validate_proxy(args.proxy)
    retained_config = (paths.config / "config.json").exists() and not args.force_config
    existing = load_deployment(paths) if paths.deployment.exists() and not args.force_config else None
    node = executable(existing["node"] if existing else args.node, ("node",))
    validate_node(node)
    browser_needed = not args.no_browser and (args.force_config or not (paths.config / "browser.json").exists())
    browser = executable(args.browser, ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"), browser_needed)
    for directory in (paths.data, paths.config, paths.state, paths.data / "bin"):
        private_dir(directory)
    deployment = existing or {
        "app": str(paths.app), "node": node, "tunnel": str(paths.data / "bin/tunnel-client"),
        "config": str(paths.config / "config.json"), "proxy": args.proxy, "healthPort": args.health_port,
    }
    for field, expected in (("app", paths.app), ("tunnel", paths.data / "bin/tunnel-client"), ("config", paths.config / "config.json")):
        if deployment[field] != str(expected):
            raise DeployError("Existing deployment paths differ; inspect deployment.json before using --force-config.")
    stage = Path(tempfile.mkdtemp(prefix=".install-", dir=paths.data))
    backup = paths.data / ".app-backup"
    if backup.exists():
        shutil.rmtree(stage)
        raise DeployError(f"Previous recovery backup exists; inspect it before retrying: {backup}")
    try:
        for name in ("src", "scripts"):
            shutil.copytree(REPOSITORY / name, stage / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for name in ("package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(REPOSITORY / name, stage / name)
        if not args.skip_npm:
            run_npm(stage, node, deployment.get("proxy"))
        if not args.skip_download:
            download_tunnel(stage / ".tunnel-client", deployment.get("proxy"))
        # Check again after slow work; never replace the files of a running service.
        refuse_active_update(paths, args.no_systemd)
        had_app = paths.app.exists()
        if had_app:
            paths.app.rename(backup)
        try:
            stage.rename(paths.app)
            if (paths.app / ".tunnel-client").exists():
                os.replace(paths.app / ".tunnel-client", paths.data / "bin/tunnel-client")
        except BaseException:
            if paths.app.exists():
                paths.app.rename(stage)
            if had_app:
                backup.rename(paths.app)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    config = {
        "label": socket.gethostname(), "workspace": str(paths.home),
        "desktop": {"enabled": not args.no_desktop, "spectaclePath": shutil.which("spectacle"), "kscreenDoctorPath": shutil.which("kscreen-doctor")},
        "browser": {"enabled": not args.no_browser, "configFile": str(paths.config / "browser.json")},
        "work": {
            "enabled": args.enable_work,
            "codexHome": str(paths.home / ".codex"),
            "socketPath": str(paths.home / ".codex/ipc/ipc.sock"),
            "stateDirectory": str(paths.state / "work"),
            "allowedThreadIds": [],
            "allowCodexThreads": False,
            "requestTimeoutMs": 10000,
        },
    }
    browser_config = {
        "browser": {"browserName": "chromium", "userDataDir": str(paths.data / "browser-profile"),
                    "launchOptions": {"executablePath": browser, "headless": False, "chromiumSandbox": True},
                    "contextOptions": {"viewport": {"width": 1280, "height": 800}, "acceptDownloads": True}},
        "capabilities": ["core"], "webmcp": False, "imageResponses": "allow",
        "outputDir": str(paths.home / "Downloads/ChatGPTBrowser"),
        "timeouts": {"action": 10000, "navigation": 60000},
    }
    if os.environ.get("WAYLAND_DISPLAY"):
        browser_config["browser"]["launchOptions"]["args"] = ["--ozone-platform=wayland"]
    if deployment.get("proxy"):
        browser_config["browser"]["launchOptions"]["proxy"] = {
            "server": deployment["proxy"], "bypass": "localhost,127.0.0.1,[::1]"}
    write_json(paths.config / "config.json", config, args.force_config)
    write_json(paths.config / "browser.json", browser_config, args.force_config)
    write_json(paths.deployment, deployment, args.force_config)
    if not args.no_systemd:
        paths.unit.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(paths.unit, render_unit(paths))
        systemctl("daemon-reload")
    print(f"Installed app: {paths.app}\nConfiguration: {paths.config}\nState: {paths.state}")
    print("No credentials written and no service started. Run configure from a terminal when ready.")
    if args.skip_download or args.skip_npm:
        print("Skipped components must be supplied before configure can start the service.")
    if existing:
        print("Existing deployment settings retained; --force-config explicitly replaces configuration files.")
    if retained_config and args.enable_work:
        print("Existing config.json retained: enable its work settings explicitly; --enable-work applies when generating configuration.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def healthy(port: int, timeout: float = 2) -> bool:
    validate_port(port)
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with time_limit(deadline - time.monotonic(), "Local health check"):
            for endpoint in ("healthz", "readyz"):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                with opener.open(f"http://127.0.0.1:{port}/{endpoint}", timeout=remaining) as response:
                    if response.status != 200:
                        return False
            return time.monotonic() < deadline
    except (DeployError, OSError, urllib.error.URLError):
        return False


def configure(args: argparse.Namespace) -> None:
    paths = Paths.from_home(args.home)
    deployment = load_deployment(paths)
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise DeployError("configure requires an interactive terminal; credentials are accepted only through hidden prompts.")
    for path in (Path(deployment["node"]), Path(deployment["tunnel"]), Path(deployment["app"]) / "src/bridge.mjs", paths.unit):
        if not path.is_file():
            raise DeployError(f"Missing installed component: {path}")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            tunnel_id = getpass.getpass("Tunnel ID (hidden): ")
            key = getpass.getpass("Runtime API key (hidden): ")
    except getpass.GetPassWarning as exc:
        raise DeployError("Hidden credential input is unavailable; refusing echoed input.") from exc
    content = runtime_env(tunnel_id, key, deployment)
    private_dir(paths.config)
    atomic_write(paths.runtime, content)
    del key, tunnel_id, content
    systemctl("daemon-reload")
    systemctl("enable", UNIT)
    systemctl("restart", UNIT)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if healthy(deployment["healthPort"], timeout=min(2, remaining)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if systemctl("is-active", UNIT, check=False, timeout=min(2, remaining)).stdout.strip() == "active":
                print("Service active; local /healthz and /readyz returned HTTP 200.")
                return
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise DeployError("Credentials saved, but local health check did not succeed within 60 seconds. Inspect the service locally.")


def status(args: argparse.Namespace) -> None:
    paths = Paths.from_home(args.home)
    result = systemctl("is-active", UNIT, check=False)
    # Only report a recognized state, never arbitrary process output or environment.
    state = result.stdout.strip()
    if state not in ("active", "inactive", "failed", "activating", "deactivating", "unknown", "reloading"):
        state = "unavailable"
    print(f"Service: {state}")
    if paths.deployment.exists():
        deployment = load_deployment(paths)
        print("Local /healthz and /readyz: " + ("HTTP 200" if healthy(deployment["healthPort"]) else "unavailable"))
    else:
        print("Local health: not configured")


def uninstall(args: argparse.Namespace) -> None:
    paths = Paths.from_home(args.home)
    if paths.unit.exists():
        systemctl("disable", "--now", UNIT)
        paths.unit.unlink()
        systemctl("daemon-reload")
    print(f"Service unit removed: {paths.unit}")
    print(f"Retained app, binary and browser profile: {paths.data}")
    print(f"Retained configuration and credentials: {paths.config}\nRetained state: {paths.state}")
    print(f"Downloads retained: {paths.home / 'Downloads/ChatGPTBrowser'} (and any configured custom output directory)")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install", help="Prepare files; never start the service or write credentials")
    for name in ("node", "browser", "proxy"):
        install_parser.add_argument(f"--{name}")
    install_parser.add_argument("--health-port", type=int, default=DEFAULT_HEALTH_PORT)
    for name in ("no-browser", "no-desktop", "skip-download", "skip-npm", "no-systemd", "force-config"):
        install_parser.add_argument(f"--{name}", action="store_true")
    install_parser.add_argument("--enable-work", action="store_true", help="Enable local Work tools in newly generated configuration; preserve existing config by default")
    install_parser.set_defaults(func=install)
    for name, function in (("configure", configure), ("status", status), ("uninstall", uninstall)):
        sub = commands.add_parser(name)
        sub.add_argument("--home", help="Isolate all paths under this home; ignore XDG environment")
        sub.set_defaults(func=function)
    install_parser.add_argument("--home", help="Isolate all paths under this home; ignore XDG environment")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if os.geteuid() == 0:
            raise DeployError("Run this per-user installer as your desktop user, not root.")
        args.func(args)
        return 0
    except (DeployError, OSError, zipfile.BadZipFile, EOFError) as exc:
        # Credential validation errors never include the supplied value.
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Cancelled.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
