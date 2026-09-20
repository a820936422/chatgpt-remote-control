"""Offline deployment tests: fake credentials and install files live only in temp dirs."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import warnings
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


deploy = load_module("crc_deploy_test", ROOT / "scripts/deploy.py")
launcher = load_module("crc_launcher_test", ROOT / "scripts/run_tunnel.py")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crc-deploy-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home with spaces %u $dollar"
        self.home.mkdir()
        self.paths = deploy.Paths.from_home(str(self.home))
        self.repo = self.root / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "scripts").mkdir()
        (self.repo / "src/bridge.mjs").write_text("// test fixture\n")
        for name in ("deploy.py", "run_tunnel.py"):
            (self.repo / "scripts" / name).write_text("# fixture\n")
        (self.repo / "package.json").write_text('{"name":"fixture","version":"1.0.0"}')
        (self.repo / "package-lock.json").write_text('{"lockfileVersion":3}')
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            (self.repo / name).write_text(f"Fixture {name}\n")
        self.node = self.root / "fake node"
        self.node.write_text("#!/bin/sh\nexit 99\n")
        self.node.chmod(0o700)
        self.patch(deploy, "REPOSITORY", self.repo)
        self.node_check = self.patch(deploy, "validate_node", mock.Mock())
        self.opener = self.patch(deploy.urllib.request, "build_opener", mock.Mock(side_effect=AssertionError("unexpected network call")))
        self.systemctl = self.patch(deploy, "systemctl", mock.Mock(side_effect=AssertionError("unexpected systemd call")))
        self.network = self.patch(deploy.urllib.request, "urlopen", mock.Mock(side_effect=AssertionError("unexpected network call")))
        self.npm = self.patch(deploy, "run_npm", mock.Mock(side_effect=AssertionError("unexpected npm call")))
        self.output = io.StringIO()
        out = contextlib.redirect_stdout(self.output)
        out.__enter__()
        self.addCleanup(out.__exit__, None, None, None)

    def patch(self, obj, name, value):
        patcher = mock.patch.object(obj, name, value)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def args(self, *extra):
        return deploy.parser().parse_args([
            "install", "--home", str(self.home), "--node", str(self.node),
            "--no-browser", "--no-desktop", "--skip-download", "--skip-npm", "--no-systemd", *extra,
        ])

    def install(self, *extra):
        deploy.install(self.args(*extra))
        return json.loads(self.paths.deployment.read_text())

    def configure_fixture(self):
        deployment = self.install()
        Path(deployment["tunnel"]).write_text("fake binary")
        self.paths.unit.parent.mkdir(parents=True)
        self.paths.unit.write_text(deploy.render_unit(self.paths))
        deploy.atomic_write(self.paths.runtime, "OLD_FAKE_CREDENTIALS\n")
        self.patch(deploy.sys.stdin, "isatty", lambda: True)
        self.patch(deploy.sys.stderr, "isatty", lambda: True)
        return deployment

    def test_isolated_install_skips_external_actions_and_credentials(self):
        deployment = self.install()
        self.assertTrue((self.paths.app / "src/bridge.mjs").exists())
        self.assertTrue((self.paths.app / "package-lock.json").exists())
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            self.assertEqual((self.paths.app / name).read_text(), (self.repo / name).read_text())
        self.node_check.assert_called_once_with(str(self.node))
        self.assertFalse(self.paths.runtime.exists())
        self.assertFalse(self.paths.unit.exists())
        self.systemctl.assert_not_called()
        self.network.assert_not_called()
        self.npm.assert_not_called()
        self.assertEqual(deployment["healthPort"], 18081)
        self.assertEqual(deployment["node"], str(self.node))
        self.assertEqual(stat.S_IMODE(self.paths.config.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.paths.deployment.stat().st_mode), 0o600)
        config = json.loads((self.paths.config / "config.json").read_text())
        self.assertFalse(config["browser"]["enabled"])
        self.assertFalse(config["desktop"]["enabled"])
        self.assertEqual(config["workspace"], str(self.home))

    def test_xdg_ignored_with_explicit_home(self):
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": "/unexpected", "XDG_DATA_HOME": "/unexpected", "XDG_STATE_HOME": "/unexpected"}):
            paths = deploy.Paths.from_home(str(self.home))
        self.assertEqual(paths.config, self.home / ".config/chatgpt-remote-control")
        self.assertEqual(paths.data, self.home / ".local/share/chatgpt-remote-control")

    def test_xdg_honored_without_home(self):
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / "cfg"), "XDG_DATA_HOME": str(self.root / "data"), "XDG_STATE_HOME": str(self.root / "state")}):
            with mock.patch.object(deploy.Path, "home", return_value=self.home):
                paths = deploy.Paths.from_home()
        self.assertEqual(paths.config, self.root / "cfg/chatgpt-remote-control")
        self.assertEqual(paths.unit, self.root / "cfg/systemd/user" / deploy.UNIT)

    def test_existing_config_and_runtime_preserved(self):
        self.install()
        files = [self.paths.config / "config.json", self.paths.config / "browser.json", self.paths.deployment]
        for path in files[:2]:
            path.write_text('{"custom":true}\n')
        self.paths.runtime.write_text("FAKE_KEY=never-overwrite\n")
        files.append(self.paths.runtime)
        original = {path: path.read_bytes() for path in files}
        self.install("--health-port", "12345", "--proxy", "http://127.0.0.1:1234")
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)

    def test_force_config_is_explicit_and_does_not_touch_credentials(self):
        self.install()
        self.paths.runtime.write_text("FAKE_KEY=retain\n")
        self.install("--force-config", "--health-port", "12345")
        self.assertEqual(json.loads(self.paths.deployment.read_text())["healthPort"], 12345)
        self.assertEqual(self.paths.runtime.read_text(), "FAKE_KEY=retain\n")

    def test_browser_schema_and_wayland(self):
        args = self.args("--browser", str(self.node))
        args.no_browser = False
        with mock.patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-0"}):
            deploy.install(args)
        config = json.loads((self.paths.config / "browser.json").read_text())
        self.assertEqual(config["browser"]["browserName"], "chromium")
        self.assertEqual(config["browser"]["userDataDir"], str(self.paths.data / "browser-profile"))
        launch = config["browser"]["launchOptions"]
        self.assertEqual(launch["executablePath"], str(self.node))
        self.assertFalse(launch["headless"])
        self.assertTrue(launch["chromiumSandbox"])
        self.assertEqual(launch["args"], ["--ozone-platform=wayland"])
        self.assertEqual(config["capabilities"], ["core"])
        self.assertFalse(config["webmcp"])

    def test_no_wayland_flag_without_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.install()
        config = json.loads((self.paths.config / "browser.json").read_text())
        self.assertNotIn("args", config["browser"]["launchOptions"])

    def test_env_injection_is_rejected_without_echo(self):
        deployment = {"config": str(self.paths.config / "config.json"), "proxy": None}
        for value in ("", "fake\nEXTRA=value", "fake\rkey", "a b", "x'", 'x"', "$KEY", "`id`", "a\\b", "é", "x=1", "a\x00"):
            for position in (0, 1):
                with self.subTest(value=value, position=position):
                    values = ["tunnel_fake", "sk-fake_TEST.123"]
                    values[position] = value
                    with self.assertRaises(deploy.DeployError) as raised:
                        deploy.runtime_env(*values, deployment)
                    self.assertNotIn("EXTRA=value", str(raised.exception))

    def test_proxy_validation(self):
        for value in ("http://127.0.0.1:4567", "https://[::1]:444"):
            self.assertEqual(deploy.validate_proxy(value), value)
        for value in ("socks5://localhost:9999", "socks5h://localhost:9999", "http://user:secret@example.com", "http://host\nKEY=bad", "file:///tmp/x", "http://host:bad", "http://host/path", "http://host?a=1"):
            with self.assertRaises(deploy.DeployError):
                deploy.validate_proxy(value)

    def test_atomic_write_permissions_and_failure_preserves_old_file(self):
        deploy.private_dir(self.paths.config)
        deploy.atomic_write(self.paths.runtime, "FAKE_OLD\n")
        self.assertEqual(stat.S_IMODE(self.paths.runtime.stat().st_mode), 0o600)
        with mock.patch.object(deploy.os, "replace", side_effect=OSError("simulated rename failure")):
            with self.assertRaises(OSError):
                deploy.atomic_write(self.paths.runtime, "FAKE_NEW\n")
        self.assertEqual(self.paths.runtime.read_text(), "FAKE_OLD\n")
        self.assertEqual(list(self.paths.config.iterdir()), [self.paths.runtime])
        with mock.patch.object(deploy.os, "fsync", side_effect=OSError("simulated fsync failure")):
            with self.assertRaises(OSError):
                deploy.atomic_write(self.paths.runtime, "FAKE_NEW\n")
        self.assertEqual(self.paths.runtime.read_text(), "FAKE_OLD\n")

    def test_configure_second_prompt_failure_preserves_old_credentials(self):
        self.configure_fixture()
        self.patch(deploy.getpass, "getpass", mock.Mock(side_effect=["tunnel_fake", EOFError()]))
        with self.assertRaises(EOFError):
            deploy.configure(argparse.Namespace(home=str(self.home)))
        self.assertEqual(self.paths.runtime.read_text(), "OLD_FAKE_CREDENTIALS\n")
        self.systemctl.assert_not_called()

    def test_configure_invalid_second_input_preserves_old_credentials(self):
        self.configure_fixture()
        self.patch(deploy.getpass, "getpass", mock.Mock(side_effect=["tunnel_fake", "fake\nINJECT=yes"]))
        with self.assertRaises(deploy.DeployError):
            deploy.configure(argparse.Namespace(home=str(self.home)))
        self.assertEqual(self.paths.runtime.read_text(), "OLD_FAKE_CREDENTIALS\n")
        self.systemctl.assert_not_called()

    def test_configure_requires_tty(self):
        self.install()
        self.patch(deploy.sys.stdin, "isatty", lambda: False)
        prompt = self.patch(deploy.getpass, "getpass", mock.Mock())
        with self.assertRaises(deploy.DeployError):
            deploy.configure(argparse.Namespace(home=str(self.home)))
        prompt.assert_not_called()

    def test_configure_success_uses_hidden_prompts_and_only_own_service(self):
        self.configure_fixture()
        prompt = self.patch(deploy.getpass, "getpass", mock.Mock(side_effect=["tunnel_fake", "sk-fake-key"]))
        self.systemctl.side_effect = None
        self.systemctl.return_value = subprocess.CompletedProcess([], 0, "active\n", "")
        self.patch(deploy, "healthy", mock.Mock(return_value=True))
        deploy.configure(argparse.Namespace(home=str(self.home)))
        self.assertEqual(prompt.call_count, 2)
        self.assertEqual(stat.S_IMODE(self.paths.runtime.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.paths.config.stat().st_mode), 0o700)
        self.assertIn('CONTROL_PLANE_API_KEY="sk-fake-key"', self.paths.runtime.read_text())
        self.assertNotIn("sk-fake-key", self.output.getvalue())
        self.systemctl.assert_any_call("enable", deploy.UNIT)
        self.systemctl.assert_any_call("restart", deploy.UNIT)
        for call in self.systemctl.call_args_list:
            self.assertNotIn("sk-fake-key", repr(call))

    def test_unit_escapes_spaces_percent_dollar_and_has_hardening(self):
        unit = deploy.render_unit(self.paths, python="/custom python/bin/python3")
        self.assertIn('ExecStart="/custom python/bin/python3" "', unit)
        self.assertIn("spaces %%u $$dollar", unit.split("ExecStart=", 1)[1].splitlines()[0])
        self.assertIn("spaces %%u $dollar", unit.split("EnvironmentFile=", 1)[1].splitlines()[0])
        for text in ("ConditionPathExists=", "UMask=0077", "KillMode=control-group", "Restart=always", "RestartSec=5", "WantedBy=default.target"):
            self.assertIn(text, unit)
        self.assertNotIn("--mcp.command", unit)

    @unittest.skipUnless(deploy.shutil.which("systemd-analyze"), "systemd-analyze is not installed")
    def test_generated_unit_passes_real_systemd_parser(self):
        self.install()
        unit = self.root / deploy.UNIT
        unit.write_text(deploy.render_unit(self.paths))
        result = subprocess.run(["systemd-analyze", "verify", str(unit)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ignoring", result.stderr.lower())

    def test_active_install_refused_before_mutations(self):
        self.install()
        before = (self.paths.app / "src/bridge.mjs").read_bytes()
        self.systemctl.side_effect = None
        self.systemctl.return_value = subprocess.CompletedProcess([], 0, "active\n", "")
        args = self.args()
        args.no_systemd = False
        with self.assertRaisesRegex(deploy.DeployError, "stop"):
            deploy.install(args)
        self.assertEqual((self.paths.app / "src/bridge.mjs").read_bytes(), before)
        self.npm.assert_not_called()

    def test_no_systemd_cannot_bypass_managed_update_guard(self):
        self.install()
        self.paths.unit.parent.mkdir(parents=True)
        self.paths.unit.write_text("fixture")
        with self.assertRaises(deploy.DeployError):
            self.install()
        self.systemctl.assert_not_called()

    def test_staging_npm_failure_preserves_installed_app(self):
        self.install()
        (self.paths.app / "sentinel").write_text("old")
        args = self.args()
        args.skip_npm = False
        self.npm.side_effect = deploy.DeployError("simulated npm failure")
        with self.assertRaises(deploy.DeployError):
            deploy.install(args)
        self.assertEqual((self.paths.app / "sentinel").read_text(), "old")
        self.assertFalse(any(self.paths.data.glob(".install-*")))

    def test_npm_uses_explicit_node_ignores_scripts_and_skips_browser_download(self):
        # Test the real function from a fresh module; global run_npm is blocked elsewhere.
        module = load_module("crc_deploy_npm_test", ROOT / "scripts/deploy.py")
        process = mock.Mock()
        process.wait.return_value = 0
        process.poll.return_value = 0
        npm = self.root / "npm-cli.js"
        npm.write_text("// fake")
        with mock.patch.object(module.shutil, "which", return_value=str(npm)), mock.patch.object(module.subprocess, "Popen", return_value=process) as popen, mock.patch.object(module, "memory_guard"):
            module.run_npm(self.repo, str(self.node), "http://127.0.0.1:1234")
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [str(self.node), str(npm), "ci", "--ignore-scripts"])
        self.assertEqual(kwargs["env"]["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"], "1")
        self.assertEqual(kwargs["env"]["npm_config_proxy"], "http://127.0.0.1:1234")
        self.assertEqual(kwargs["env"]["npm_config_https_proxy"], "http://127.0.0.1:1234")
        self.assertTrue(kwargs["env"]["PATH"].startswith(str(self.node.parent) + os.pathsep))

    def test_binary_promotion_failure_rolls_back_app(self):
        self.install()
        (self.paths.app / "sentinel").write_text("old")
        args = self.args()
        args.skip_download = False
        with mock.patch.object(deploy, "download_tunnel", side_effect=lambda path, proxy: path.write_bytes(b"fake tunnel")):
            with mock.patch.object(deploy.os, "replace", side_effect=OSError("simulated promotion failure")):
                with self.assertRaises(OSError):
                    deploy.install(args)
        self.assertEqual((self.paths.app / "sentinel").read_text(), "old")
        self.assertFalse(any(self.paths.data.glob(".install-*")))
        self.assertFalse((self.paths.data / ".app-backup").exists())

    def test_health_deadline_does_not_start_late_systemd_call(self):
        self.configure_fixture()
        self.patch(deploy.getpass, "getpass", mock.Mock(side_effect=["tunnel_fake", "sk-fake-key"]))
        self.systemctl.side_effect = None
        self.patch(deploy, "healthy", mock.Mock(return_value=True))
        with mock.patch.object(deploy.time, "monotonic", side_effect=[100, 100, 100, 161]):
            with self.assertRaisesRegex(deploy.DeployError, "60 seconds"):
                deploy.configure(argparse.Namespace(home=str(self.home)))
        self.assertEqual(self.systemctl.call_args_list, [mock.call("daemon-reload"), mock.call("enable", deploy.UNIT), mock.call("restart", deploy.UNIT)])

    def test_memory_guard_aborts_at_95_percent(self):
        with mock.patch.object(deploy.Path, "read_text", return_value="MemTotal: 1000 kB\nMemAvailable: 50 kB\n"):
            with self.assertRaisesRegex(deploy.DeployError, "95%"):
                deploy.memory_guard()

    def make_zip(self, entries):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for name, content in entries:
                output.writestr(name, content)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_malicious_zip_paths_are_never_extracted(self):
        escaped = self.root / "escaped"
        archive, digest = self.make_zip([
            ("../escaped", b"bad"), (str(escaped), b"bad"),
            ("nested/../../escaped", b"bad"), ("tunnel-client", b"expected binary"),
        ])
        destination = self.root / "safe/tunnel-client"
        destination.parent.mkdir()
        deploy.extract_tunnel(archive, destination, digest)
        self.assertFalse(escaped.exists())
        self.assertEqual(destination.read_bytes(), b"expected binary")
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
        self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_wrong_digest_preserves_existing_binary(self):
        archive, _ = self.make_zip([("tunnel-client", b"new")])
        destination = self.root / "tunnel-client"
        destination.write_bytes(b"old")
        with self.assertRaises(deploy.DeployError):
            deploy.extract_tunnel(archive, destination)
        self.assertEqual(destination.read_bytes(), b"old")

    def test_symlink_and_nonexact_zip_binary_are_rejected(self):
        info = zipfile.ZipInfo("tunnel-client")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([(info, b"../../escape")], [("../tunnel-client", b"bad")]):
            archive, digest = self.make_zip(entries)
            with self.assertRaises(deploy.DeployError):
                deploy.extract_tunnel(archive, self.root / "tunnel-client", digest)
        self.assertFalse((self.root / "tunnel-client").exists())

    def test_launcher_exec_uses_exact_paths_and_shlex(self):
        deployment = self.install()
        with mock.patch.object(launcher.os, "execv") as execv, mock.patch.dict(os.environ, {}, clear=True):
            launcher.launch(str(self.paths.deployment))
            self.assertEqual(os.environ["CRC_CONFIG"], deployment["config"])
        program, argv = execv.call_args.args
        self.assertEqual(program, deployment["tunnel"])
        self.assertEqual(argv[:3], [program, "run", "--mcp.command"])
        self.assertEqual(shlex.split(argv[3]), [str(self.node), str(self.paths.app / "src/bridge.mjs")])
        self.assertEqual(argv[4:], ["--health.listen-addr", "127.0.0.1:18081"])

    def test_health_disables_proxy_and_redirects(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener) as build:
            self.assertTrue(deploy.healthy(12345))
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], deploy.NoRedirect)
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, "", {}, "https://example.invalid"))
        self.assertEqual([call.args[0] for call in opener.open.call_args_list], [
            "http://127.0.0.1:12345/healthz", "http://127.0.0.1:12345/readyz"])
        for call in opener.open.call_args_list:
            self.assertGreater(call.kwargs["timeout"], 0)
            self.assertLessEqual(call.kwargs["timeout"], 2)

    def test_install_passes_retained_proxy_to_network_steps(self):
        proxy = "http://127.0.0.1:1234"
        self.install("--proxy", proxy)
        args = self.args("--proxy", "https://127.0.0.1:5678")
        args.skip_npm = args.skip_download = False
        self.npm.side_effect = None
        with mock.patch.object(deploy, "download_tunnel") as download:
            deploy.install(args)
        self.assertEqual(self.npm.call_args.args[1:], (str(self.node), proxy))
        self.assertEqual(download.call_args.args[1], proxy)
        config = json.loads((self.paths.config / "browser.json").read_text())
        self.assertEqual(config["browser"]["launchOptions"]["proxy"], {
            "server": proxy, "bypass": "localhost,127.0.0.1,[::1]"})

    def test_runtime_env_explicit_tunnel_settings(self):
        deployment = self.install("--proxy", "https://127.0.0.1:1234", "--health-port", "12345")
        content = deploy.runtime_env("tunnel_fake", "sk-fake", deployment)
        self.assertIn('CONTROL_PLANE_HTTP_PROXY="https://127.0.0.1:1234"\n', content)
        self.assertIn('HEALTH_LISTEN_ADDR="127.0.0.1:12345"\n', content)
        self.assertIn('LOG_LEVEL="info"\n', content)
        deployment["proxy"] = None
        self.assertNotIn("CONTROL_PLANE_HTTP_PROXY", deploy.runtime_env("tunnel_fake", "sk-fake", deployment))

    def test_launcher_replaces_or_clears_stale_proxy_after_force_config(self):
        self.install("--proxy", "http://127.0.0.1:1234")
        for proxy in ("https://127.0.0.1:5678", None):
            with self.subTest(proxy=proxy):
                self.install("--force-config", "--health-port", "12345", *(["--proxy", proxy] if proxy else []))
                stale = {name: "http://127.0.0.1:1234" for name in (
                    "CONTROL_PLANE_HTTP_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")}
                stale["HEALTH_LISTEN_ADDR"] = "0.0.0.0:9999"
                with mock.patch.dict(os.environ, stale, clear=True), mock.patch.object(launcher.os, "execv"):
                    launcher.launch(str(self.paths.deployment))
                    for name in stale:
                        if name != "HEALTH_LISTEN_ADDR":
                            self.assertEqual(os.environ.get(name), proxy)
                    self.assertEqual(os.environ["HEALTH_LISTEN_ADDR"], "127.0.0.1:12345")
                    self.assertEqual(os.environ["LOG_LEVEL"], "info")

    def test_launcher_rejects_socks_proxy(self):
        deployment = self.install()
        deployment["proxy"] = "socks5://127.0.0.1:1234"
        self.paths.deployment.write_text(json.dumps(deployment))
        with mock.patch.object(launcher.os, "execv") as execute:
            with self.assertRaises(ValueError):
                launcher.launch(str(self.paths.deployment))
        execute.assert_not_called()

    def test_getpass_warning_aborts_before_echo_fallback(self):
        self.configure_fixture()
        fallback = mock.Mock()
        def hidden_input(prompt):
            warnings.warn("Cannot control echo", deploy.getpass.GetPassWarning)
            fallback()
            return "fake"
        self.patch(deploy.getpass, "getpass", hidden_input)
        with self.assertRaisesRegex(deploy.DeployError, "refusing echoed input"):
            deploy.configure(argparse.Namespace(home=str(self.home)))
        fallback.assert_not_called()
        self.assertEqual(self.paths.runtime.read_text(), "OLD_FAKE_CREDENTIALS\n")
        self.systemctl.assert_not_called()

    def test_main_refuses_root_before_any_action(self):
        with mock.patch.object(deploy.os, "geteuid", return_value=0), mock.patch.object(deploy, "install") as install, contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(deploy.main(["install"]), 1)
        install.assert_not_called()
        self.assertIn("not root", errors.getvalue())

    def test_node_version_validation(self):
        module = load_module("crc_deploy_node_test", ROOT / "scripts/deploy.py")
        for version, code, accepted in (("v22.0.0\n", 0, True), ("v24.4.1", 0, True), ("v20.19.0", 0, False), ("not node", 0, False), ("v22.0.0", 1, False)):
            with self.subTest(version=version, code=code), mock.patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], code, version, "")) as run:
                if accepted:
                    module.validate_node(str(self.node))
                else:
                    with self.assertRaises(module.DeployError):
                        module.validate_node(str(self.node))
                run.assert_called_once_with([str(self.node), "--version"], capture_output=True, text=True, timeout=10)
        for failure in (OSError("unavailable"), subprocess.TimeoutExpired("node", 10)):
            with mock.patch.object(module.subprocess, "run", side_effect=failure):
                with self.assertRaises(module.DeployError):
                    module.validate_node(str(self.node))

    def test_install_node_failure_precedes_file_changes(self):
        self.node_check.side_effect = deploy.DeployError("Node.js >=22 is required")
        with self.assertRaises(deploy.DeployError):
            self.install()
        self.assertFalse(self.paths.data.exists())

    def test_download_uses_explicit_proxy_and_cleans_archive(self):
        destination = self.root / "tunnel-client"
        for proxy in (None, "http://127.0.0.1:1234", "https://127.0.0.1:5678"):
            with self.subTest(proxy=proxy):
                response = mock.MagicMock()
                response.__enter__.return_value.read.side_effect = [b"fake zip", b""]
                opener = mock.Mock()
                opener.open.return_value = response
                with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener) as build, mock.patch.object(deploy, "extract_tunnel") as extract:
                    deploy.download_tunnel(destination, proxy)
                self.assertEqual(build.call_args.args[0].proxies, {"http": proxy, "https": proxy} if proxy else {})
                opener.open.assert_called_once_with(deploy.TUNNEL_URL, timeout=30)
                extract.assert_called_once()
                self.assertFalse(any(self.root.glob(".tunnel-download-*")))

    def test_download_failure_preserves_binary_and_removes_partial_archive(self):
        destination = self.root / "tunnel-client"
        destination.write_bytes(b"old")
        response = mock.MagicMock()
        response.__enter__.return_value.read.side_effect = [b"partial", OSError("lost connection")]
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(OSError):
                deploy.download_tunnel(destination)
        self.assertEqual(destination.read_bytes(), b"old")
        self.assertFalse(any(self.root.glob(".tunnel-download-*")))

    def test_download_total_timeout_interrupts_stalled_read(self):
        destination = self.root / "tunnel-client"
        destination.write_bytes(b"old")
        response = mock.MagicMock()
        response.__enter__.return_value.read.side_effect = lambda size: time.sleep(1)
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener), mock.patch.object(deploy, "OPERATION_TIMEOUT", 0.03):
            started = time.monotonic()
            with self.assertRaisesRegex(deploy.DeployError, "timed out"):
                deploy.download_tunnel(destination)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(destination.read_bytes(), b"old")
        self.assertFalse(any(self.root.glob(".tunnel-download-*")))

    def test_npm_timeout_kills_process_group(self):
        module = load_module("crc_deploy_npm_timeout_test", ROOT / "scripts/deploy.py")
        process = mock.Mock(pid=123456)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("npm", 2), subprocess.TimeoutExpired("npm", 5), 0]
        clock = iter([0, 0, 0, 0, 301])
        with mock.patch.object(module.shutil, "which", return_value=str(self.node)), mock.patch.object(module.subprocess, "Popen", return_value=process), mock.patch.object(module, "memory_guard"), mock.patch.object(module.time, "monotonic", side_effect=lambda: next(clock)), mock.patch.object(module.os, "killpg") as kill:
            with self.assertRaisesRegex(module.DeployError, "timed out"):
                module.run_npm(self.repo, str(self.node))
        self.assertEqual(kill.call_args_list, [mock.call(process.pid, module.signal.SIGTERM), mock.call(process.pid, module.signal.SIGKILL)])
        self.assertEqual(process.wait.call_args_list, [mock.call(timeout=2), mock.call(timeout=5), mock.call(timeout=5)])

    def test_npm_failure_cleans_children_even_if_leader_exited(self):
        module = load_module("crc_deploy_npm_failure_test", ROOT / "scripts/deploy.py")
        process = mock.Mock(pid=123456)
        process.wait.return_value = 1
        process.poll.return_value = 1
        with mock.patch.object(module.shutil, "which", return_value=str(self.node)), mock.patch.object(module.subprocess, "Popen", return_value=process), mock.patch.object(module, "memory_guard"), mock.patch.object(module.os, "killpg") as kill:
            with self.assertRaisesRegex(module.DeployError, "exit 1"):
                module.run_npm(self.repo, str(self.node))
        self.assertEqual(kill.call_args_list, [mock.call(process.pid, module.signal.SIGTERM), mock.call(process.pid, module.signal.SIGKILL)])

    def test_health_requires_readiness(self):
        responses = [mock.MagicMock(), mock.MagicMock()]
        responses[0].__enter__.return_value.status = 200
        responses[1].__enter__.return_value.status = 503
        opener = mock.Mock()
        opener.open.side_effect = responses
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener):
            self.assertFalse(deploy.healthy(12345))
        self.assertEqual(opener.open.call_count, 2)

    def test_health_endpoints_share_one_request_budget(self):
        clock = [100.0]
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        opener = mock.Mock()
        def respond(*args, **kwargs):
            clock[0] += 0.75
            return response
        opener.open.side_effect = respond
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener), mock.patch.object(deploy.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertTrue(deploy.healthy(12345, timeout=2))
        self.assertEqual([call.kwargs["timeout"] for call in opener.open.call_args_list], [2, 1.25])

    def test_health_total_timeout_interrupts_stalled_response(self):
        opener = mock.Mock()
        opener.open.side_effect = lambda *args, **kwargs: time.sleep(1)
        with mock.patch.object(deploy.urllib.request, "build_opener", return_value=opener):
            started = time.monotonic()
            self.assertFalse(deploy.healthy(12345, timeout=0.03))
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(opener.open.call_count, 1)

    def test_configure_caps_health_probe_at_remaining_deadline(self):
        self.configure_fixture()
        self.patch(deploy.getpass, "getpass", mock.Mock(side_effect=["tunnel_fake", "sk-fake-key"]))
        self.systemctl.side_effect = None
        with mock.patch.object(deploy, "healthy", return_value=False) as healthy, mock.patch.object(deploy.time, "monotonic", side_effect=[100, 159.5, 159.5, 160, 160]), mock.patch.object(deploy.time, "sleep"):
            with self.assertRaisesRegex(deploy.DeployError, "60 seconds"):
                deploy.configure(argparse.Namespace(home=str(self.home)))
        healthy.assert_called_once_with(18081, timeout=0.5)

    def test_uninstall_retains_app_credentials_and_downloads(self):
        self.install()
        self.paths.runtime.write_text("FAKE_KEEP\n")
        self.paths.unit.parent.mkdir(parents=True)
        self.paths.unit.write_text("unit")
        profile = self.paths.data / "browser-profile"
        profile.mkdir()
        (profile / "sentinel").write_text("keep")
        self.systemctl.side_effect = None
        deploy.uninstall(argparse.Namespace(home=str(self.home)))
        self.assertFalse(self.paths.unit.exists())
        self.assertTrue(self.paths.app.exists())
        self.assertEqual(self.paths.runtime.read_text(), "FAKE_KEEP\n")
        self.assertTrue((profile / "sentinel").exists())
        self.systemctl.assert_any_call("disable", "--now", deploy.UNIT)
        self.assertIn("Retained", self.output.getvalue())
        self.assertNotIn("FAKE_KEEP", self.output.getvalue())

    def test_status_never_reads_runtime_env(self):
        self.install()
        self.paths.runtime.write_text("FAKE_SECRET_STATUS\n")
        self.systemctl.side_effect = None
        self.systemctl.return_value = subprocess.CompletedProcess([], 0, "active\n", "")
        self.patch(deploy, "healthy", mock.Mock(return_value=True))
        original = Path.read_text
        def guard(path, *args, **kwargs):
            self.assertNotEqual(path, self.paths.runtime)
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "read_text", guard):
            deploy.status(argparse.Namespace(home=str(self.home)))
        self.assertNotIn("FAKE_SECRET_STATUS", self.output.getvalue())
        self.assertIn("Service: active", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()
