"""townwise_lab job: sign in, GET the input from the API, calibrate, POST the result. A fake API on localhost stands in,
and also serves the Container Apps identity endpoint (/msi/token) the job asks for its managed identity's token."""

import http.client
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from townwise_lab import job
from townwise_lab.__main__ import main

GOLDEN_INPUT = Path(__file__).resolve().parent / "golden" / "input.json"
CALIBRATION_ID = "a" * 24
MI_TOKEN = "eyJ" + "m" * 30 + ".m1-" + "d" * 40 + ".s1g"  # the lab identity's token, as Entra hands it out
LOCAL_TOKEN = "t0k3n-" + "b" * 40  # a local run's API process secret
RESULT_TOKEN = "r3sult-" + "c" * 40
IDENTITY_HEADER = "1dh-" + "e" * 30
CLIENT_ID = "00000000-0000-0000-0000-0000000001d1"
RESOURCE = "api://22222222-2222-4222-8222-222222222222"
CODE = "0" * 40
IDENTITY_PATH = "/msi/token"


class FakeApi:
    def __init__(self, input_status: int = 200, result_status: int | list[int] = 204, body: bytes | None = None,
                 location: str | None = None, result_token: str | None = RESULT_TOKEN, identity_status: int = 200,
                 identity_body: bytes | None = None, identity_location: str | None = None):
        self.requests: list[dict] = []  # the callback's
        self.identity: list[dict] = []  # the identity endpoint's
        self.body = GOLDEN_INPUT.read_bytes() if body is None else body
        answer = {"access_token": MI_TOKEN, "expires_on": "1780000000", "resource": RESOURCE, "token_type": "Bearer",
                  "client_id": CLIENT_ID}
        identity_payload = json.dumps(answer).encode() if identity_body is None else identity_body
        statuses = list(result_status) if isinstance(result_status, list) else None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _record(self, data: bytes | None):
                outer.requests.append({"method": self.command, "path": self.path, "data": data,
                                       "auth": self.headers.get("Authorization"),
                                       "result_token": self.headers.get("X-Townwise-Result-Token"),
                                       "headers": dict(self.headers.items())})

            def _identity(self):
                outer.identity.append({"path": self.path, "headers": dict(self.headers.items())})
                self.send_response(identity_status)
                if identity_location:
                    self.send_header("Location", identity_location)
                payload = identity_payload if identity_status == 200 else b"{}"
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path.startswith(IDENTITY_PATH):
                    self._identity()
                    return
                self._record(None)
                self.send_response(input_status)
                self.send_header("Content-Type", "application/json")
                if location:
                    self.send_header("Location", location)
                if input_status == 200 and result_token is not None:
                    self.send_header("X-Townwise-Result-Token", result_token)
                payload = outer.body if input_status == 200 else b"{}"
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self._record(data)
                self.send_response(statuses.pop(0) if statuses else result_status if isinstance(result_status, int) else 204)
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
        """The job's environment in Azure: lab.tf's variables, the start's calibration id, and the platform's two."""
        env = {"TOWNWISE_LAB_API_URL": self.url, "TOWNWISE_LAB_CALIBRATION_ID": CALIBRATION_ID,
               "TOWNWISE_LAB_CODE_VERSION": CODE, "IDENTITY_ENDPOINT": f"{self.url}{IDENTITY_PATH}",
               "IDENTITY_HEADER": IDENTITY_HEADER, "AZURE_CLIENT_ID": CLIENT_ID, "TOWNWISE_LAB_TOKEN_RESOURCE": RESOURCE}
        env.update(over)
        return env

    def local_env(self, **over) -> dict:
        """A local run's environment (api/src/lab/runner.ts createLocalLabRunner)."""
        env = {"TOWNWISE_LAB_API_URL": self.url, "TOWNWISE_LAB_CALIBRATION_ID": CALIBRATION_ID,
               "TOWNWISE_LAB_CODE_VERSION": CODE, "TOWNWISE_LAB_TOKEN": LOCAL_TOKEN}
        env.update(over)
        return env


def calls(api: FakeApi) -> list[str]:
    return [r["method"] for r in api.requests]


def test_job_signs_in_fetches_input_and_posts_result():
    with FakeApi() as api:
        assert job.main(api.env()) == 0
    get, post = api.requests
    assert (get["method"], get["path"]) == ("GET", f"/lab/calibrations/{CALIBRATION_ID}/input")
    assert (post["method"], post["path"]) == ("POST", f"/lab/calibrations/{CALIBRATION_ID}/result")
    # Both go as the lab identity; the result also with the token the input answer named, and only it.
    assert get["auth"] == f"Bearer {MI_TOKEN}" and post["auth"] == f"Bearer {MI_TOKEN}"
    assert get["result_token"] is None and post["result_token"] == RESULT_TOKEN
    assert post["headers"]["Content-Type"] == "application/json"
    result = json.loads(post["data"])
    assert result["ok"] is True and result["codeVersion"] == CODE
    # One identity request before each callback request.
    assert len(api.identity) == 2


def test_job_asks_the_identity_endpoint_for_the_lab_callback_app_as_the_lab_identity():
    with FakeApi() as api:
        assert job.main(api.env()) == 0
    for request in api.identity:
        path, _, query = request["path"].partition("?")
        assert path == IDENTITY_PATH
        assert urllib.parse.parse_qs(query, strict_parsing=True) == {
            "resource": [RESOURCE], "api-version": ["2019-08-01"], "client_id": [CLIENT_ID]}
        assert request["headers"]["X-Identity-Header"] == IDENTITY_HEADER
        assert "Authorization" not in request["headers"]


@pytest.mark.parametrize("identity, printed", [
    ({"identity_status": 500}, "HTTPError"),
    ({"identity_status": 400}, "HTTPError"),
    ({"identity_body": b"not json"}, "JSONDecodeError"),
    ({"identity_body": b"[]"}, "IdentityError"),
    ({"identity_body": b"{}"}, "IdentityError"),
    ({"identity_body": b'{"access_token": ""}'}, "IdentityError"),
    ({"identity_body": b'{"access_token": 5}'}, "IdentityError"),
])
def test_job_that_cannot_sign_in_calls_nothing_and_exits_1(identity, printed, capsys):
    with FakeApi(**identity) as api:
        assert job.main(api.env()) == 1
    assert api.requests == []  # no input fetched, so no result token: nothing to post
    assert capsys.readouterr().err == f"failed: {printed}\n"


def test_job_that_cannot_reach_the_identity_endpoint_calls_nothing(capsys):
    with FakeApi() as api:
        assert job.main(api.env(IDENTITY_ENDPOINT="http://127.0.0.1:1/msi/token")) == 1
    assert api.requests == []
    assert capsys.readouterr().err == "failed: URLError\n"


def test_job_follows_no_redirect_from_the_identity_endpoint(capsys):
    with FakeApi() as elsewhere:
        with FakeApi(identity_status=302, identity_location=f"{elsewhere.url}/elsewhere") as api:
            assert job.main(api.env()) == 1
    assert elsewhere.requests == [] and elsewhere.identity == []
    assert api.requests == []
    assert capsys.readouterr().err == "failed: HTTPError\n"


OK_RESULT = {"schema": "townwise.lab-result/1", "calibrationId": CALIBRATION_ID, "ok": True}


def test_job_posts_failure_code_and_exits_1_on_error(monkeypatch, capsys):
    def boom(inp, code_version):
        raise RuntimeError("secret 12345")

    monkeypatch.setattr(job, "calibrate", boom)
    with FakeApi() as api:
        assert job.main(api.env()) == 1
    posted = json.loads(api.requests[1]["data"])
    assert posted["ok"] is False and posted["code"] == "internal"
    assert api.requests[1]["result_token"] == RESULT_TOKEN
    assert "secret" not in api.requests[1]["data"].decode()
    printed = capsys.readouterr()
    for word in ("secret", "12345"):
        assert word not in printed.out and word not in printed.err
    assert printed.err == "failed: RuntimeError\n"


def test_job_posts_internal_when_the_result_cannot_be_serialized(monkeypatch, capsys):
    monkeypatch.setattr(job, "calibrate", lambda inp, code_version: {**OK_RESULT, "wape": float("nan")})
    with FakeApi() as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET", "POST"]
    assert json.loads(api.requests[1]["data"]) == {"schema": "townwise.lab-result/1", "calibrationId": CALIBRATION_ID,
                                                   "ok": False, "code": "internal"}
    printed = capsys.readouterr()
    assert printed.err == "failed: ValueError\n" and printed.out.splitlines()[-1] == "posted result: failed internal"


def test_job_posts_internal_when_the_input_is_not_json(capsys):
    """Once the input was fetched the job holds its result token, so any failure after it is posted."""
    with FakeApi(body=b"not json") as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET", "POST"]
    assert json.loads(api.requests[1]["data"])["code"] == "internal"
    assert capsys.readouterr().err == "failed: JSONDecodeError\n"


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
    common = {"TOWNWISE_LAB_API_URL": "http://127.0.0.1:1", "TOWNWISE_LAB_CALIBRATION_ID": CALIBRATION_ID,
              "TOWNWISE_LAB_CODE_VERSION": CODE}
    seen = []

    def printed() -> str:
        out = capsys.readouterr()
        seen.append(out.out + out.err)
        return out.err

    # Neither way to sign in.
    assert job.main(common) == 1
    assert printed() == "missing environment variable: IDENTITY_ENDPOINT (or TOWNWISE_LAB_TOKEN for a local run)\n"
    assert job.main({**common, "TOWNWISE_LAB_TOKEN": ""}) == 1
    assert "IDENTITY_ENDPOINT" in printed()
    # Azure, without the rest of what signing in needs.
    azure = {**common, "IDENTITY_ENDPOINT": "http://127.0.0.1:1/msi/token", "IDENTITY_HEADER": IDENTITY_HEADER,
             "AZURE_CLIENT_ID": CLIENT_ID, "TOWNWISE_LAB_TOKEN_RESOURCE": RESOURCE}
    for name in ("IDENTITY_HEADER", "AZURE_CLIENT_ID", "TOWNWISE_LAB_TOKEN_RESOURCE", "TOWNWISE_LAB_CALIBRATION_ID"):
        assert job.main({**azure, name: ""}) == 1
        assert printed() == f"missing environment variable: {name}\n"
    assert job.main({k: v for k, v in azure.items() if k not in ("IDENTITY_HEADER", "AZURE_CLIENT_ID")}) == 1
    assert printed() == "missing environment variable: IDENTITY_HEADER, AZURE_CLIENT_ID\n"
    for value in (CALIBRATION_ID, "127.0.0.1", IDENTITY_HEADER, CLIENT_ID, RESOURCE):
        assert all(value not in text for text in seen)


def test_local_job_signs_in_with_the_api_process_secret():
    with FakeApi() as api:
        assert job.main(api.local_env()) == 0
    assert api.identity == []
    assert [(r["method"], r["auth"], r["result_token"]) for r in api.requests] == [
        ("GET", f"Bearer {LOCAL_TOKEN}", None), ("POST", f"Bearer {LOCAL_TOKEN}", RESULT_TOKEN)]


def test_job_never_sends_a_token_anywhere_but_its_own_header(capsys):
    with FakeApi() as api:
        job.main(api.env())
    for request in api.requests:
        for token, header in ((MI_TOKEN, "authorization"), (RESULT_TOKEN, "x-townwise-result-token")):
            assert token not in request["path"]
            assert token not in (request["data"] or b"").decode()
            others = {k: v for k, v in request["headers"].items() if k.lower() != header}
            assert token not in json.dumps(others)
    for request in api.identity:
        assert MI_TOKEN not in json.dumps(request) and RESULT_TOKEN not in json.dumps(request)
    printed = capsys.readouterr()
    for secret in (MI_TOKEN, RESULT_TOKEN, IDENTITY_HEADER):
        assert secret not in printed.out + printed.err


def test_job_does_not_retry_a_4xx_and_prints_no_message(capsys):
    with FakeApi(result_status=400) as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET", "POST"]
    assert re.fullmatch(r"failed: \w+\n", capsys.readouterr().err)


def test_job_retries_the_post_once_on_a_5xx_with_a_fresh_identity_token(capsys):
    with FakeApi(result_status=[503, 204]) as api:
        assert job.main(api.env()) == 0
    assert calls(api) == ["GET", "POST", "POST"]
    assert api.requests[1]["data"] == api.requests[2]["data"]
    assert {(r["auth"], r["result_token"]) for r in api.requests[1:]} == {(f"Bearer {MI_TOKEN}", RESULT_TOKEN)}
    assert len(api.identity) == 3
    with FakeApi(result_status=[500, 502]) as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET", "POST", "POST"]
    assert capsys.readouterr().err.endswith("failed: HTTPError\n")


@pytest.mark.parametrize("status", [404, 503])
def test_job_whose_input_is_refused_posts_nothing(status, capsys):
    with FakeApi(input_status=status) as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET"]  # no input answer, so no result token: the API times the calibration out
    assert capsys.readouterr().err == "failed: HTTPError\n"


def test_job_whose_input_answer_names_no_result_token_posts_nothing(capsys):
    with FakeApi(result_token=None) as api:
        assert job.main(api.env()) == 1
    assert calls(api) == ["GET"]
    printed = capsys.readouterr()
    assert printed.err == "failed: NoResultToken\n" and printed.out == ""


@pytest.mark.parametrize("redirected", ["input", "result"])
def test_job_follows_no_redirect(redirected, monkeypatch, capsys):
    monkeypatch.setattr(job, "calibrate", lambda inp, code_version: OK_RESULT)
    with FakeApi() as elsewhere:
        statuses = {"input_status": 302} if redirected == "input" else {"result_status": 302}
        with FakeApi(location=f"{elsewhere.url}/elsewhere", **statuses) as api:
            assert job.main(api.env()) == 1
    assert elsewhere.requests == []  # neither a token nor a request went to the Location host
    expected = [("GET", "input")] if redirected == "input" else [("GET", "input"), ("POST", "result")]
    assert [(r["method"], r["path"].rsplit("/", 1)[-1]) for r in api.requests] == expected
    assert re.fullmatch(r"failed: HTTPError\n", capsys.readouterr().err)


def callback_opener(post):
    """An opener that sends the identity request and the GET as they are, and hands each POST to `post`."""
    def opener(request, timeout):
        if request.get_method() == "POST":
            return post(request, timeout)
        return urllib.request.urlopen(request, timeout=timeout)
    return opener


class Ok:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return b""


def test_job_gives_up_after_two_connection_errors(capsys):
    posts = []

    def post(request, timeout):
        posts.append(request.get_method())
        raise urllib.error.URLError("reset")

    with FakeApi() as api:
        assert job.main(api.env(), callback_opener(post)) == 1
    assert calls(api) == ["GET"] and posts == ["POST", "POST"]
    assert capsys.readouterr().err == "failed: URLError\n"


def test_job_retries_the_post_once_on_a_connection_error():
    posts = []

    def post(request, timeout):
        posts.append(timeout)
        if len(posts) == 1:
            raise urllib.error.URLError("reset")
        return Ok()

    with FakeApi() as api:
        assert job.main(api.env(), callback_opener(post)) == 0
    assert posts == [30, 30]
    assert len(api.identity) == 3  # the input, the first post and its retry


@pytest.mark.parametrize("lost", [http.client.RemoteDisconnected("gone"), TimeoutError("late")])
def test_job_retries_the_post_once_when_its_answer_is_lost(lost):
    """urllib does not wrap an error after the request went (the API may have it), so the job retries these too."""
    posts = []

    def post(request, timeout):
        posts.append((request.get_header("Authorization"), request.get_header("X-townwise-result-token")))
        if len(posts) == 1:
            raise lost
        return urllib.request.urlopen(request, timeout=timeout)

    with FakeApi() as api:
        assert job.main(api.env(), callback_opener(post)) == 0
    assert posts == [(f"Bearer {MI_TOKEN}", RESULT_TOKEN)] * 2
    assert calls(api) == ["GET", "POST"]


def test_cli_job_subcommand_reads_the_environment(monkeypatch):
    with FakeApi() as api:
        for name, value in api.env().items():
            monkeypatch.setenv(name, value)
        assert main(["job"]) == 0
    assert calls(api) == ["GET", "POST"] and len(api.identity) == 2
