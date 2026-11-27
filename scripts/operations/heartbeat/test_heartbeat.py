import importlib.util
import datetime
import io
import json
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
PUSH_SPEC = importlib.util.spec_from_file_location("outage_push", HERE / "himawari-outage-push.py")
outage_push = importlib.util.module_from_spec(PUSH_SPEC)
PUSH_SPEC.loader.exec_module(outage_push)

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


class Minutes:
    def __init__(self):
        self.moment = datetime.datetime(2026, 11, 27, 2, 0, tzinfo=datetime.timezone.utc)

    def __call__(self):
        current = self.moment
        self.moment = self.moment + datetime.timedelta(minutes=1)
        return current


class OutageStateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.url_file = Path(self.directory.name) / "url"
        self.url_file.write_text(PING + "\n")
        self.state = Path(self.directory.name) / "state"
        self.state.mkdir()
        self.clock = Minutes()

    def tearDown(self):
        self.directory.cleanup()

    def beat(self, status, alert_after="5"):
        pings = Pings()
        output, errors = io.StringIO(), io.StringIO()
        with ReadyServer(status) as ready:
            code = heartbeat.main(["--url-file", str(self.url_file), "--ready-url", ready.url, "--timeout", "2", "--state-dir", str(self.state), "--alert-after", alert_after], pings.opener, output, errors, self.clock)
        return code, output.getvalue(), errors.getvalue(), pings.calls

    def outage(self):
        path = self.state / "outage.json"
        return json.loads(path.read_text()) if path.exists() else None

    def test_an_outage_is_announced_once_after_the_threshold_and_the_recovery_once(self):
        for _ in range(4):
            code, output, _, calls = self.beat(503)
            self.assertEqual(code, 0)
            self.assertNotIn("HEARTBEAT_OUTAGE", output)
            self.assertEqual(calls[-1][1], PING + "/log")
        self.assertIsNone(self.outage())
        code, output, _, _ = self.beat(503)
        self.assertIn("HEARTBEAT_OUTAGE down", output)
        self.assertEqual(self.outage(), {"schemaVersion": 1, "state": "down", "failedChecks": 5, "since": "2026-11-27T02:00:00.000Z", "at": "2026-11-27T02:04:00.000Z"})
        before = (self.state / "outage.json").stat().st_mtime_ns
        for _ in range(7):
            self.assertNotIn("HEARTBEAT_OUTAGE", self.beat(503)[1])
        self.assertEqual((self.state / "outage.json").stat().st_mtime_ns, before)
        code, output, _, calls = self.beat(200)
        self.assertIn("HEARTBEAT_OUTAGE up", output)
        self.assertEqual(calls[-1], ("GET", PING, None))
        self.assertEqual(self.outage(), {"schemaVersion": 1, "state": "up", "failedChecks": 12, "since": "2026-11-27T02:00:00.000Z", "at": "2026-11-27T02:12:00.000Z"})
        self.assertNotIn("HEARTBEAT_OUTAGE", self.beat(200)[1])
        self.assertEqual(self.outage()["at"], "2026-11-27T02:12:00.000Z")

    def test_failures_below_the_threshold_send_nothing_and_start_over_after_a_success(self):
        for _ in range(4):
            self.beat(503)
        self.beat(200)
        for _ in range(4):
            self.beat(503)
        self.assertIsNone(self.outage())
        self.assertEqual(json.loads((self.state / "streak.json").read_text())["failures"], 4)

    def test_the_threshold_comes_from_the_option(self):
        self.assertIn("HEARTBEAT_OUTAGE down", self.beat(503, alert_after="1")[1])

    def test_without_a_state_directory_nothing_is_recorded(self):
        pings = Pings()
        with ReadyServer(503) as ready:
            code = heartbeat.main(["--url-file", str(self.url_file), "--ready-url", ready.url, "--timeout", "2"], pings.opener, io.StringIO(), io.StringIO(), self.clock)
        self.assertEqual(code, 0)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_an_unwritable_state_directory_still_pings_but_fails_the_run(self):
        self.state.chmod(0o500)
        try:
            if os.access(self.state, os.W_OK):
                self.skipTest("running as a user that ignores directory modes")
            code, _, errors, calls = self.beat(200)
        finally:
            self.state.chmod(0o700)
        self.assertEqual(code, 1)
        self.assertIn("HEARTBEAT_STATE_FAILED", errors)
        self.assertEqual(calls, [("GET", PING, None)])


class OutagePushScriptTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        self.releases = base / "releases"
        release = self.releases / "2026-11-27-0123456789abcdef0123456789abcdef01234567"
        (release / "bin").mkdir(parents=True)
        self.record = base / "record"
        cli = release / "bin" / "himawari"
        cli.write_text('#!/bin/bash\nprintf "%%s\\n" "$PATH" "$@" > %s\nexit 3\n' % self.record)
        cli.chmod(0o755)
        self.unit = base / "himawari-prod.service"
        self.unit.write_text("[Service]\nEnvironment=PATH=/opt/himawari/node/bin:/usr/bin:/bin\nExecStart=%s/bin/himawari-agent-service\n" % release)
        self.release = release

    def tearDown(self):
        self.directory.cleanup()

    def arguments(self):
        return ["--unit-path", str(self.unit), "--releases-root", str(self.releases), "--config", "/etc/himawari/config.json", "--secret-dir", "/var/lib/himawari/state/secrets", "--event-file", "/var/lib/himawari-heartbeat/outage.json"]

    def test_it_runs_the_serving_release_with_the_service_path_and_passes_its_exit_code(self):
        self.assertEqual(outage_push.main(self.arguments()), 3)
        self.assertEqual(self.record.read_text().splitlines(), ["/opt/himawari/node/bin:/usr/bin:/bin", "push", "outage", "--config", "/etc/himawari/config.json", "--secret-dir", "/var/lib/himawari/state/secrets", "--event-file", "/var/lib/himawari-heartbeat/outage.json"])

    def test_it_refuses_when_the_release_cannot_be_found(self):
        self.unit.write_text("[Service]\nEnvironment=PATH=/usr/bin\n")
        errors = io.StringIO()
        self.assertEqual(outage_push.main(self.arguments(), errors=errors), 2)
        self.assertIn("OUTAGE_PUSH_RELEASE_UNKNOWN", errors.getvalue())
        self.assertFalse(self.record.exists())


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

    def write_instance(self, **overrides):
        fixed = {"serviceAccount": "himawari-prod", "unitPath": "/etc/systemd/system/himawari-prod.service", "releasesRoot": "/opt/himawari/releases", "config": "/etc/himawari/config.json", "stateRoot": "/var/lib/himawari/state", **overrides}
        path = Path(self.directory.name) / "instance.json"
        path.write_text(json.dumps({"fixedByTemplate": fixed}))
        return str(path)

    def test_install_with_an_instance_adds_the_outage_push_and_keeps_the_url_locked_down(self):
        child = self.run_script("install", "--instance", self.write_instance(), "--alert-after", "7", stdin=PING + "\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn("HEARTBEAT_OUTAGE_PUSH_INSTALLED alert-after=7", child.stdout)
        service = (self.root / "etc/systemd/system/himawari-heartbeat.service").read_text()
        self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-heartbeat --state-dir /var/lib/himawari-heartbeat --alert-after 7\n", service)
        self.assertIn("StateDirectory=himawari-heartbeat\nStateDirectoryMode=0755\n", service)
        self.assertIn("CapabilityBoundingSet=\n", service)
        self.assertIn("RestrictAddressFamilies=AF_INET AF_INET6\n", service)
        push = (self.root / "etc/systemd/system/himawari-outage-push.service").read_text()
        self.assertIn("User=himawari-prod\n", push)
        self.assertIn("ExecStart=/usr/bin/python3 -I /usr/local/sbin/himawari-outage-push --unit-path /etc/systemd/system/himawari-prod.service --releases-root /opt/himawari/releases --config /etc/himawari/config.json --secret-dir /var/lib/himawari/state/secrets --event-file /var/lib/himawari-heartbeat/outage.json\n", push)
        self.assertNotIn("healthcheck-url", push)
        watch = (self.root / "etc/systemd/system/himawari-outage-push.path").read_text()
        self.assertIn("PathChanged=/var/lib/himawari-heartbeat/outage.json\n", watch)
        self.assertEqual(stat.S_IMODE((self.root / "usr/local/sbin/himawari-outage-push").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.root / "etc/himawari-heartbeat").stat().st_mode), 0o700)
        self.assertEqual(self.calls.read_text().splitlines(), ["daemon-reload", "enable --now himawari-heartbeat.timer", "enable --now himawari-outage-push.path"])

    def test_install_refuses_a_bad_instance_or_threshold_and_changes_nothing(self):
        for arguments in (["--instance", self.write_instance(serviceAccount="root; rm")], ["--instance", self.write_instance(config="etc/relative")], ["--instance", "/missing.json"], ["--alert-after", "0"], ["--alert-after", "x"]):
            child = self.run_script("install", *arguments, stdin=PING + "\n")
            self.assertNotEqual(child.returncode, 0, arguments)
            self.assertFalse((self.root / "usr").exists(), arguments)
            self.assertFalse(self.calls.exists(), arguments)

    def test_install_without_an_instance_takes_the_outage_push_away_again(self):
        self.run_script("install", "--instance", self.write_instance(), stdin=PING + "\n")
        self.assertEqual(self.run_script("install", "--keep-url").returncode, 0)
        self.assertFalse((self.root / "etc/systemd/system/himawari-outage-push.path").exists())
        self.assertFalse((self.root / "usr/local/sbin/himawari-outage-push").exists())
        self.assertNotIn("--state-dir", (self.root / "etc/systemd/system/himawari-heartbeat.service").read_text())
        self.assertIn("disable --now himawari-outage-push.path", self.calls.read_text())

    def test_installed_script_runs_against_the_stored_url(self):
        self.run_script("install", stdin=PING + "\n")
        installed = self.root / "usr/local/sbin/himawari-heartbeat"
        child = subprocess.run(["python3", "-I", str(installed), "--url-file", str(self.root / "etc/himawari-heartbeat/healthcheck-url"), "--check-url-file"], capture_output=True, text=True, check=False)
        self.assertEqual((child.returncode, child.stdout.strip()), (0, "HEARTBEAT_URL_OK"))


if __name__ == "__main__":
    unittest.main()
