"""python -m townwise_lab job: the lab's Azure entrypoint.

Reads four environment variables, GETs the calibration's LabInput from the API, calibrates, and POSTs the LabResult
back. The bearer token only ever goes in the Authorization header, and no redirect is followed (urllib's default
handler would carry that header to whatever host Location names and turn the result POST into a GET). Standard library
only (urllib), 30 seconds per request, one retry of the POST on a connection error and none on an HTTP status.

It prints only `fetched input: {n} days` and `posted result: ok|failed {code}`; an error prints its class name, never
its message, because a message can hold a value from the input. Library warnings are ignored for the same reason.
"""

import json
import sys
import urllib.error
import urllib.request
import warnings
from collections.abc import Mapping

from townwise_lab import schema
from townwise_lab.pipeline import calibrate

TIMEOUT_SECONDS = 30
NAMES = ("TOWNWISE_LAB_API_URL", "TOWNWISE_LAB_CALIBRATION_ID", "TOWNWISE_LAB_TOKEN", "TOWNWISE_LAB_CODE_VERSION")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Every 3xx becomes an HTTPError."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _post(opener, url: str, token: str, data: bytes) -> None:
    for attempt in (1, 2):
        request = urllib.request.Request(url, data=data, method="POST", headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        try:
            with opener(request, timeout=TIMEOUT_SECONDS) as response:
                response.read()
            return
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError:  # a connection error: the only case worth one retry
            if attempt == 2:
                raise


def main(env: Mapping[str, str], opener=_OPENER.open) -> int:
    warnings.simplefilter("ignore")  # a warning prints a file path and a source line to stderr
    missing = [name for name in NAMES if not env.get(name)]
    if missing:
        print(f"missing environment variable: {', '.join(missing)}", file=sys.stderr)
        return 1
    base = env["TOWNWISE_LAB_API_URL"].rstrip("/")
    calibration_id = env["TOWNWISE_LAB_CALIBRATION_ID"]
    token = env["TOWNWISE_LAB_TOKEN"]
    root = f"{base}/lab/calibrations/{calibration_id}"
    try:
        request = urllib.request.Request(f"{root}/input", method="GET", headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json"})
        with opener(request, timeout=TIMEOUT_SECONDS) as response:
            inp = json.loads(response.read())
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
        _post(opener, f"{root}/result", token, data)
    except Exception as error:
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        return 1
    if result["ok"]:
        print("posted result: ok")
        return 0
    print(f"posted result: failed {result['code']}")
    return 1
