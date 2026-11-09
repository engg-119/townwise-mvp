"""townwise_lab job: GET the input from the API, calibrate, POST the result. A fake API on localhost stands in."""

import json
import re
import threading
import urllib.error
import urllib.request
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from townwise_lab import job
from townwise_lab.__main__ import main

GOLDEN_INPUT = Path(__file__).resolve().parent / "golden" / "input.json"
CALIBRATION_ID = "a" * 24
TOKEN = "t0k3n-" + "b" * 40
CODE = "0" * 40


class FakeApi:
    def __init__(self, input_status: int = 200, result_status: int = 204, body: bytes | None = None,
                 location: str | None = None):
        self.requests: list[dict] = []
        self.body = GOLDEN_INPUT.read_bytes() if body is None else body
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _record(self, data: bytes | None):
                outer.requests.append({"method": self.command, "path": self.path, "data": data,
                                       "auth": self.headers.get("Authorization"),
                                       "headers": dict(self.headers.items())})

            def do_GET(self):
                self._record(None)
                self.send_response(input_status)
                self.send_header("Content-Type", "application/json")
                if location:
                    self.send_header("Location", location)
                payload = outer.body if input_status == 200 else b"{}"
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self._record(data)
                self.send_response(result_status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    def env(self, **over) -> dict:
        env = {"TOWNWISE_LAB_API_URL": self.url, "TOWNWISE_LAB_CALIBRATION_ID": CALIBRATION_ID,
               "TOWNWISE_LAB_TOKEN": TOKEN, "TOWNWISE_LAB_CODE_VERSION": CODE}
        env.update(over)
        return env


def test_job_fetches_input_and_posts_result():
    with FakeApi() as api:
        assert job.main(api.env()) == 0
    get, post = api.requests
    assert (get["method"], get["path"]) == ("GET", f"/lab/calibrations/{CALIBRATION_ID}/input")
    assert (post["method"], post["path"]) == ("POST", f"/lab/calibrations/{CALIBRATION_ID}/result")
    assert get["auth"] == post["auth"] == f"Bearer {TOKEN}"
    assert post["headers"]["Content-Type"] == "application/json"
    result = json.loads(post["data"])
    assert result["ok"] is True and result["codeVersion"] == CODE


OK_RESULT = {"schema": "townwise.lab-result/1", "calibrationId": CALIBRATION_ID, "ok": True}


def test_job_posts_failure_code_and_exits_1_on_error(monkeypatch, capsys):
    def boom(inp, code_version):
        raise RuntimeError("secret 12345")

    monkeypatch.setattr(job, "calibrate", boom)
    with FakeApi() as api:
        assert job.main(api.env()) == 1
    posted = json.loads(api.requests[1]["data"])
    assert posted["ok"] is False and posted["code"] == "internal"
    assert "secret" not in api.requests[1]["data"].decode()
    printed = capsys.readouterr()
    for word in ("secret", "12345"):
        assert word not in printed.out and word not in printed.err
    assert printed.err == "failed: RuntimeError\n"


def test_job_posts_internal_when_the_result_cannot_be_serialized(monkeypatch, capsys):
    monkeypatch.setattr(job, "calibrate", lambda inp, code_version: {**OK_RESULT, "wape": float("nan")})
    with FakeApi() as api:
        assert job.main(api.env()) == 1
    assert [r["method"] for r in api.requests] == ["GET", "POST"]
    assert json.loads(api.requests[1]["data"]) == {"schema": "townwise.lab-result/1", "calibrationId": CALIBRATION_ID,
                                                   "ok": False, "code": "internal"}
    printed = capsys.readouterr()
    assert printed.err == "failed: ValueError\n" and printed.out.splitlines()[-1] == "posted result: failed internal"


@pytest.mark.parametrize("body", [b"{}", b"[]", b'{"days": "seven"}'])
def test_job_reports_a_malformed_input_as_invalid_input(body, capsys):
    with FakeApi(body=body) as api:
        assert job.main(api.env()) == 1
    assert json.loads(api.requests[1]["data"])["code"] == "invalid_input"
    printed = capsys.readouterr()
    assert printed.out == "posted result: failed invalid_input\n" and printed.err == ""


def test_job_keeps_library_warnings_off_stderr(monkeypatch):
    def noisy(inp, code_version):
        warnings.warn("value 12345", RuntimeWarning)
        return OK_RESULT

    monkeypatch.setattr(job, "calibrate", noisy)
    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        with FakeApi() as api:
            assert job.main(api.env()) == 0
    assert seen == []


def test_job_posts_a_calibration_failure_as_is(monkeypatch, capsys):
    failure = {"schema": "townwise.lab-result/1", "calibrationId": CALIBRATION_ID, "ok": False,
               "code": "insufficient_history"}
    monkeypatch.setattr(job, "calibrate", lambda inp, code_version: failure)
    with FakeApi() as api:
        assert job.main(api.env()) == 1
    assert json.loads(api.requests[1]["data"]) == failure
    assert "posted result: failed insufficient_history" in capsys.readouterr().out


def test_job_output_is_counts_only(capsys):
    with FakeApi() as api:
        assert job.main(api.env()) == 0
    out = capsys.readouterr()
    lines = out.out.splitlines()
    assert lines and all(re.fullmatch(r"fetched input: \d+ days|posted result: (ok|failed [a-z_]+)", l)
                         for l in lines)
    assert out.err == ""
    assert lines[0] == f"fetched input: {len(json.loads(GOLDEN_INPUT.read_text())['days'])} days"


def test_job_refuses_missing_env_without_echoing_values(capsys):
    env = {"TOWNWISE_LAB_API_URL": "http://127.0.0.1:1", "TOWNWISE_LAB_CALIBRATION_ID": CALIBRATION_ID,
           "TOWNWISE_LAB_CODE_VERSION": CODE}
    assert job.main(env) == 1
    printed = capsys.readouterr()
    assert "TOWNWISE_LAB_TOKEN" in printed.err
    assert CALIBRATION_ID not in printed.out + printed.err and "127.0.0.1" not in printed.out + printed.err
    assert job.main({**env, "TOWNWISE_LAB_TOKEN": ""}) == 1
    assert "TOWNWISE_LAB_TOKEN" in capsys.readouterr().err


def test_job_never_sends_the_token_anywhere_but_the_header():
    with FakeApi() as api:
        job.main(api.env())
    for request in api.requests:
        assert TOKEN not in request["path"]
        assert TOKEN not in (request["data"] or b"").decode()
        others = {k: v for k, v in request["headers"].items() if k.lower() != "authorization"}
        assert TOKEN not in json.dumps(others)


def test_job_does_not_retry_an_http_status_and_prints_no_message(capsys):
    with FakeApi(result_status=500) as api:
        assert job.main(api.env()) == 1
    assert [r["method"] for r in api.requests] == ["GET", "POST"]
    assert re.fullmatch(r"failed: \w+\n", capsys.readouterr().err)


def test_job_reports_internal_when_the_input_is_refused(capsys):
    with FakeApi(input_status=404) as api:
        assert job.main(api.env()) == 1
    assert [r["method"] for r in api.requests] == ["GET", "POST"]  # a best-effort failure post
    assert json.loads(api.requests[1]["data"])["code"] == "internal"
    assert re.fullmatch(r"failed: \w+\n", capsys.readouterr().err)


@pytest.mark.parametrize("redirected", ["input", "result"])
def test_job_follows_no_redirect(redirected, monkeypatch, capsys):
    monkeypatch.setattr(job, "calibrate", lambda inp, code_version: OK_RESULT)
    with FakeApi() as elsewhere:
        statuses = {"input_status": 302} if redirected == "input" else {"result_status": 302}
        with FakeApi(location=f"{elsewhere.url}/elsewhere", **statuses) as api:
            assert job.main(api.env()) == 1
    assert elsewhere.requests == []  # neither the token nor a request went to the Location host
    assert [(r["method"], r["path"].rsplit("/", 1)[-1]) for r in api.requests] == [("GET", "input"), ("POST", "result")]
    if redirected == "input":
        assert json.loads(api.requests[1]["data"])["code"] == "internal"
    assert re.fullmatch(r"failed: HTTPError\n", capsys.readouterr().err)


def test_job_gives_up_after_two_connection_errors(capsys):
    calls = []

    def opener(request, timeout):
        calls.append(request.get_method())
        if request.get_method() == "GET":
            return urllib.request.urlopen(request, timeout=timeout)
        raise urllib.error.URLError("reset")

    with FakeApi() as api:
        assert job.main(api.env(), opener) == 1
    assert calls == ["GET", "POST", "POST"]
    assert capsys.readouterr().err == "failed: URLError\n"


def test_job_retries_the_post_once_on_a_connection_error():
    calls = []

    def opener(request, timeout):
        calls.append((request.get_method(), timeout))
        if request.get_method() == "GET":
            return urllib.request.urlopen(request, timeout=timeout)
        if len([c for c in calls if c[0] == "POST"]) == 1:
            raise urllib.error.URLError("reset")

        class Ok:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b""

        return Ok()

    with FakeApi() as api:
        assert job.main(api.env(), opener) == 0
    assert [c[0] for c in calls] == ["GET", "POST", "POST"] and {c[1] for c in calls} == {30}


def test_cli_job_subcommand_reads_the_environment(monkeypatch):
    with FakeApi() as api:
        for name, value in api.env().items():
            monkeypatch.setenv(name, value)
        assert main(["job"]) == 0
    assert len(api.requests) == 2
