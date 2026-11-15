import importlib.util
import io
import os
import stat
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("heartbeat", HERE / "himawari-heartbeat.py")
heartbeat = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat)

PING = "https://hc-ping.com/0d5f7c0e-1111-4222-8333-444455556666"


class ReadyServer:
    def __init__(self, status):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.paths.append(self.path)
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b'{"status":"x"}')

            def log_message(self, *arguments):
                pass

        self.paths = []
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/health/ready" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *arguments):
        self.server.shutdown()
        self.server.server_close()


class Pings:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def opener(self, request, timeout):
        if request.full_url.startswith("http://127.0.0.1"):
            return urllib.request.urlopen(request, timeout=timeout)
        self.calls.append((request.get_method(), request.full_url, request.data))
        if self.fail:
            raise urllib.error.URLError("network down")
        return io.BytesIO(b"OK")


class HeartbeatScriptTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.url_file = Path(self.directory.name) / "url"
        self.url_file.write_text(PING + "\n")

    def tearDown(self):
        self.directory.cleanup()

    def run_main(self, ready_url, pings, extra=()):
        output, errors = io.StringIO(), io.StringIO()
        code = heartbeat.main(["--url-file", str(self.url_file), "--ready-url", ready_url, "--timeout", "2", *extra], pings.opener, output, errors)
        return code, output.getvalue(), errors.getvalue()

    def test_ready_service_sends_the_plain_heartbeat(self):
        pings = Pings()
        with ReadyServer(200) as ready:
            code, output, _ = self.run_main(ready.url, pings)
        self.assertEqual(code, 0)
        self.assertEqual(pings.calls, [("GET", PING, None)])
        self.assertEqual(output.strip(), "HEARTBEAT ok")

    def test_not_ready_service_sends_no_heartbeat_and_logs_the_reason(self):
        pings = Pings()
        with ReadyServer(503) as ready:
            code, output, _ = self.run_main(ready.url, pings)
        self.assertEqual(code, 0)
        self.assertEqual(pings.calls, [("POST", PING + "/log", b"ready answered HTTP 503")])
        self.assertEqual(output.strip(), "HEARTBEAT skipped ready answered HTTP 503")

    def test_a_service_that_does_not_answer_sends_no_heartbeat(self):
        with ReadyServer(200) as ready:
            dead = ready.url
        pings = Pings()
        code, _, _ = self.run_main(dead, pings)
        self.assertEqual(code, 0)
        self.assertEqual(pings.calls, [("POST", PING + "/log", b"ready did not answer")])

    def test_a_ready_answer_other_than_200_is_not_ready(self):
        class Answer(io.BytesIO):
            status = 204

        def opener(request, timeout):
            if request.full_url.startswith("http://127.0.0.1"):
                return Answer(b"")
            calls.append((request.get_method(), request.full_url, request.data))
            return io.BytesIO(b"OK")

        calls = []
        output = io.StringIO()
        code = heartbeat.main(["--url-file", str(self.url_file), "--ready-url", "http://127.0.0.1:9/health/ready"], opener, output, io.StringIO())
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("POST", PING + "/log", b"ready answered HTTP 204")])

    def test_a_failed_ping_is_an_error_exit_without_the_url(self):
        pings = Pings(fail=True)
        with ReadyServer(200) as ready:
            code, output, errors = self.run_main(ready.url, pings)
        self.assertEqual(code, 1)
        self.assertNotIn(PING, output + errors)
        self.assertIn("HEARTBEAT_PING_FAILED", errors)

    def test_an_invalid_url_file_makes_no_network_call(self):
        bad = [
            "http://hc-ping.com/abc\n",
            "https://example.com/abc\n",
            "https://hc-ping.com/abc?x=1\n",
            "https://hc-ping.com/abc\nhttps://evil.example/\n",
            "https://hc-ping.com/abc def\n",
            "https://hc-ping.com/\n",
            "",
            "https://hc-ping.com/" + "a" * 600 + "\n",
            "https://hc-ping.com/ab\xe9\n",
            "https://hc-ping.com/abc/fail\n",
            "https://hc-ping.com/abc/log\n",
            "https://hc-ping.com/abc/start\n",
        ]
        for text in bad:
            self.url_file.write_bytes(text.encode("utf-8"))
            pings = Pings()
            with ReadyServer(200) as ready:
                code, _, errors = self.run_main(ready.url, pings)
                self.assertEqual(ready.paths, [], text)
            self.assertEqual(code, 2, text)
            self.assertEqual(pings.calls, [], text)
            self.assertIn("HEARTBEAT_URL_INVALID", errors)

    def test_a_missing_url_file_is_reported(self):
        self.url_file.unlink()
        pings = Pings()
        code, _, errors = self.run_main("http://127.0.0.1:9/health/ready", pings)
        self.assertEqual((code, pings.calls), (2, []))
        self.assertIn("HEARTBEAT_URL_UNREADABLE", errors)

    def test_a_project_ping_key_url_with_a_slug_is_accepted(self):
        self.url_file.write_text("https://hc-ping.com/aBcDeF123/himawari-prod\n")
        pings = Pings()
        with ReadyServer(200) as ready:
            code, _, _ = self.run_main(ready.url, pings)
        self.assertEqual((code, pings.calls[0][1]), (0, "https://hc-ping.com/aBcDeF123/himawari-prod"))

    def test_a_non_http_answer_from_the_local_port_is_not_ready_and_does_not_crash(self):
        import http.client

        calls = []

        def opener(request, timeout):
            if request.full_url.startswith("http://127.0.0.1"):
                raise http.client.BadStatusLine("garbage")
            calls.append((request.get_method(), request.full_url, request.data))
            return io.BytesIO(b"OK")

        code = heartbeat.main(["--url-file", str(self.url_file), "--ready-url", "http://127.0.0.1:9/health/ready"], opener, io.StringIO(), io.StringIO())
        self.assertEqual((code, calls), (0, [("POST", PING + "/log", b"ready did not answer")]))

    def test_check_url_file_only_validates(self):
        pings = Pings()
        code, output, _ = self.run_main("http://127.0.0.1:9/health/ready", pings, ["--check-url-file"])
        self.assertEqual((code, pings.calls, output.strip()), (0, [], "HEARTBEAT_URL_OK"))


class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.root = base / "root"
        self.calls = base / "calls"
        fake = base / "systemctl"
        fake.write_text('#!/bin/bash\necho "$*" >> %s\n' % self.calls)
        fake.chmod(0o755)
        self.environment = {**os.environ, "HEARTBEAT_ROOT": str(self.root), "HEARTBEAT_SYSTEMCTL": str(fake)}

    def tearDown(self):
        self.directory.cleanup()

    def run_script(self, *arguments, stdin=""):
        return subprocess.run(["bash", str(HERE / "install-heartbeat.sh"), *arguments], input=stdin, capture_output=True, text=True, env=self.environment, check=False)

    def test_install_writes_the_files_with_the_right_modes_and_enables_the_timer(self):
        child = self.run_script("install", stdin=PING + "\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn("HEARTBEAT_INSTALLED", child.stdout)
        url = self.root / "etc/himawari-heartbeat/healthcheck-url"
        self.assertEqual(url.read_text(), PING + "\n")
        self.assertEqual(stat.S_IMODE(url.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.root / "usr/local/sbin/himawari-heartbeat").stat().st_mode), 0o755)
        service = (self.root / "etc/systemd/system/himawari-heartbeat.service").read_text()
        self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat", service)
        self.assertNotIn("hc-ping", service)
        timer = (self.root / "etc/systemd/system/himawari-heartbeat.timer").read_text()
        self.assertIn("OnUnitActiveSec=1min", timer)
        self.assertEqual(self.calls.read_text().splitlines(), ["daemon-reload", "enable --now himawari-heartbeat.timer"])
        self.assertNotIn(PING, child.stdout + child.stderr)

    def test_url_file_lives_in_its_own_0700_directory_and_the_old_copy_is_removed(self):
        self.assertEqual(heartbeat.DEFAULT_URL_FILE, "/etc/himawari-heartbeat/healthcheck-url")
        self.assertFalse(heartbeat.DEFAULT_URL_FILE.startswith("/etc/himawari/"))
        legacy = self.root / "etc/himawari/healthcheck-url"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(PING + "\n")
        self.assertEqual(self.run_script("install", stdin=PING + "\n").returncode, 0)
        self.assertFalse(legacy.exists())
        self.assertEqual(stat.S_IMODE((self.root / "etc/himawari-heartbeat").stat().st_mode), 0o700)
        service = (self.root / "etc/systemd/system/himawari-heartbeat.service").read_text()
        self.assertIn("CapabilityBoundingSet=\n", service)
        self.assertNotIn("/etc/himawari/", service)

    def test_install_refuses_an_invalid_url_and_changes_nothing(self):
        for text in ("", "https://example.com/x\n", "http://hc-ping.com/x\n"):
            child = self.run_script("install", stdin=text)
            self.assertNotEqual(child.returncode, 0, text)
            self.assertFalse((self.root / "usr").exists(), text)
            self.assertFalse(self.calls.exists(), text)

    def test_install_is_idempotent_and_keep_url_keeps_the_stored_url(self):
        self.run_script("install", stdin=PING + "\n")
        self.assertEqual(self.run_script("install", "--keep-url").returncode, 0)
        self.assertEqual((self.root / "etc/himawari-heartbeat/healthcheck-url").read_text(), PING + "\n")
        self.assertEqual(self.run_script("install", stdin="https://hc-ping.com/newkey\n").returncode, 0)
        self.assertEqual((self.root / "etc/himawari-heartbeat/healthcheck-url").read_text(), "https://hc-ping.com/newkey\n")

    def test_keep_url_repairs_loose_permissions_on_the_stored_url(self):
        self.run_script("install", stdin=PING + "\n")
        url = self.root / "etc/himawari-heartbeat/healthcheck-url"
        url.chmod(0o644)
        self.assertEqual(self.run_script("install", "--keep-url").returncode, 0)
        self.assertEqual(stat.S_IMODE(url.stat().st_mode), 0o600)

    def test_keep_url_migrates_the_url_from_the_old_location(self):
        legacy = self.root / "etc/himawari/healthcheck-url"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(PING + "\n")
        self.assertEqual(self.run_script("install", "--keep-url").returncode, 0)
        self.assertEqual((self.root / "etc/himawari-heartbeat/healthcheck-url").read_text(), PING + "\n")
        self.assertFalse(legacy.exists())

    def test_remove_without_purge_keeps_the_old_location_url(self):
        legacy = self.root / "etc/himawari/healthcheck-url"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(PING + "\n")
        self.assertEqual(self.run_script("remove").returncode, 0)
        self.assertTrue(legacy.exists())
        self.assertEqual(self.run_script("remove", "--purge").returncode, 0)
        self.assertFalse(legacy.exists())

    def test_status_asks_systemd_and_changes_nothing(self):
        child = self.run_script("status")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(self.calls.read_text().splitlines(), ["is-active himawari-heartbeat.timer", "list-timers himawari-heartbeat.timer --no-pager"])
        self.assertFalse((self.root / "usr").exists())

    def test_keep_url_without_a_stored_url_fails(self):
        child = self.run_script("install", "--keep-url")
        self.assertEqual(child.returncode, 2)
        self.assertIn("HEARTBEAT_URL_MISSING", child.stderr)

    def test_remove_deletes_units_and_keeps_the_url_unless_purged(self):
        self.run_script("install", stdin=PING + "\n")
        self.assertEqual(self.run_script("remove").returncode, 0)
        self.assertFalse((self.root / "etc/systemd/system/himawari-heartbeat.timer").exists())
        self.assertFalse((self.root / "usr/local/sbin/himawari-heartbeat").exists())
        self.assertTrue((self.root / "etc/himawari-heartbeat/healthcheck-url").exists())
        self.assertEqual(self.run_script("remove", "--purge").returncode, 0)
        self.assertFalse((self.root / "etc/himawari-heartbeat/healthcheck-url").exists())

    def test_installed_script_runs_against_the_stored_url(self):
        self.run_script("install", stdin=PING + "\n")
        installed = self.root / "usr/local/sbin/himawari-heartbeat"
        child = subprocess.run(["python3", "-I", str(installed), "--url-file", str(self.root / "etc/himawari-heartbeat/healthcheck-url"), "--check-url-file"], capture_output=True, text=True, check=False)
        self.assertEqual((child.returncode, child.stdout.strip()), (0, "HEARTBEAT_URL_OK"))


if __name__ == "__main__":
    unittest.main()
