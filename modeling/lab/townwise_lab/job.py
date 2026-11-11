"""python -m townwise_lab job: the lab's Azure entrypoint.

Signs in, GETs the calibration's LabInput from the API once, calibrates, and POSTs the LabResult back. In Azure the job
signs in with its managed identity: before each callback request it asks the Container Apps identity endpoint
(IDENTITY_ENDPOINT, with IDENTITY_HEADER) for a token for the lab callback app (TOWNWISE_LAB_TOKEN_RESOURCE) as the lab
identity (AZURE_CLIENT_ID), so no secret sits in its environment or in the job's execution history. A local run
(api/src/lab/runner.ts) has no identity endpoint and signs in with TOWNWISE_LAB_TOKEN, the API process's own secret.
The result also carries the result token the input answer named (X-Townwise-Result-Token), which ties it to that fetch.

A token only ever goes in its own header (the identity token in Authorization, the result token in
X-Townwise-Result-Token), and no redirect is followed (urllib's default handler would carry those headers to whatever
host Location names and turn the result POST into a GET). Standard library only (urllib), 30 seconds per request, and
one retry of the POST, with a fresh identity token, on a connection error, a lost or timed-out answer or a 5xx (the API
stores a result once however often it comes), none on a 4xx. A job that cannot sign in or fetch its input has no
result token, so it posts nothing and exits 1, and the API times the calibration out.

It prints only `fetched input: {n} days` and `posted result: ok|failed {code}`; an error prints its class name, never
its message, because a message can hold a value from the input. Library warnings are ignored for the same reason.
"""

import http.client
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections.abc import Mapping

from townwise_lab import schema
from townwise_lab.pipeline import calibrate

TIMEOUT_SECONDS = 30
NAMES = ("TOWNWISE_LAB_API_URL", "TOWNWISE_LAB_CALIBRATION_ID", "TOWNWISE_LAB_CODE_VERSION")
# With IDENTITY_ENDPOINT (set by Container Apps, as IDENTITY_HEADER is): lab.tf sets the other two.
AZURE_NAMES = ("IDENTITY_HEADER", "AZURE_CLIENT_ID", "TOWNWISE_LAB_TOKEN_RESOURCE")
RESULT_TOKEN_HEADER = "X-Townwise-Result-Token"  # api/src/lab/callback.ts
IDENTITY_API_VERSION = "2019-08-01"


class IdentityError(Exception):
    """The identity endpoint answered without a token."""


class NoResultToken(Exception):
    """The input answer named no result token."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Every 3xx becomes an HTTPError."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _missing(env: Mapping[str, str]) -> list[str]:
    missing = [name for name in NAMES if not env.get(name)]
    if env.get("IDENTITY_ENDPOINT"):
        missing += [name for name in AZURE_NAMES if not env.get(name)]
    elif not env.get("TOWNWISE_LAB_TOKEN"):
        missing.append("IDENTITY_ENDPOINT (or TOWNWISE_LAB_TOKEN for a local run)")
    return missing


def _bearer(env: Mapping[str, str], opener) -> str:
    """The lab identity's token for the lab callback app, fresh from the identity endpoint; locally, the given one."""
    if not env.get("IDENTITY_ENDPOINT"):
        return env["TOWNWISE_LAB_TOKEN"]
    query = urllib.parse.urlencode({"resource": env["TOWNWISE_LAB_TOKEN_RESOURCE"], "api-version": IDENTITY_API_VERSION,
                                    "client_id": env["AZURE_CLIENT_ID"]})
    request = urllib.request.Request(f"{env['IDENTITY_ENDPOINT']}?{query}", method="GET",
                                     headers={"X-IDENTITY-HEADER": env["IDENTITY_HEADER"]})
    with opener(request, timeout=TIMEOUT_SECONDS) as response:
        answer = json.loads(response.read())
    token = answer.get("access_token") if isinstance(answer, dict) else None
    if not isinstance(token, str) or not token:
        raise IdentityError
    return token


def _post(opener, url: str, env: Mapping[str, str], result_token: str, data: bytes) -> None:
    for attempt in (1, 2):
        try:
            request = urllib.request.Request(url, data=data, method="POST", headers={
                "Authorization": f"Bearer {_bearer(env, opener)}", RESULT_TOKEN_HEADER: result_token,
                "Content-Type": "application/json"})
            with opener(request, timeout=TIMEOUT_SECONDS) as response:
                response.read()
            return
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == 2:  # a 4xx is final
                raise
        # A connection error before sending (URLError), or an answer lost or late after it (RemoteDisconnected is a
        # ConnectionError; a read past the timeout a TimeoutError; a garbled one an HTTPException)
        except (urllib.error.URLError, ConnectionError, TimeoutError, http.client.HTTPException):
            if attempt == 2:
                raise


def main(env: Mapping[str, str], opener=_OPENER.open) -> int:
    warnings.simplefilter("ignore")  # a warning prints a file path and a source line to stderr
    missing = _missing(env)
    if missing:
        print(f"missing environment variable: {', '.join(missing)}", file=sys.stderr)
        return 1
    base = env["TOWNWISE_LAB_API_URL"].rstrip("/")
    calibration_id = env["TOWNWISE_LAB_CALIBRATION_ID"]
    root = f"{base}/lab/calibrations/{calibration_id}"
    try:  # no input answer means no result token, so nothing can be posted
        request = urllib.request.Request(f"{root}/input", method="GET", headers={
            "Authorization": f"Bearer {_bearer(env, opener)}", "Accept": "application/json"})
        with opener(request, timeout=TIMEOUT_SECONDS) as response:
            result_token = response.headers.get(RESULT_TOKEN_HEADER)
            raw = response.read()
        if not result_token:
            raise NoResultToken
    except Exception as error:  # the class only
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        return 1
    try:
        inp = json.loads(raw)
        days = inp.get("days") if isinstance(inp, dict) else None
        if isinstance(days, list):  # otherwise calibrate answers invalid_input
            print(f"fetched input: {len(days)} days")
        result = calibrate(inp, env["TOWNWISE_LAB_CODE_VERSION"])
        data = json.dumps(result, allow_nan=False).encode("utf-8")
    except Exception as error:  # the class only
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        result = {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": False, "code": "internal"}
        data = json.dumps(result).encode("utf-8")
    try:
        _post(opener, f"{root}/result", env, result_token, data)
    except Exception as error:
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        return 1
    if result["ok"]:
        print("posted result: ok")
        return 0
    print(f"posted result: failed {result['code']}")
    return 1
