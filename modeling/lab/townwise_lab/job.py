"""python -m townwise_lab job: the lab's Azure entrypoint.

Reads four environment variables, GETs the calibration's LabInput from the API, calibrates, and POSTs the LabResult
back. The bearer token only ever goes in the Authorization header. Standard library only (urllib), 30 seconds per
request, one retry of the POST on a connection error and none on an HTTP status.

It prints only `fetched input: {n} days` and `posted result: ok|failed {code}`; an error prints its class name, never
its message, because a message can hold a value from the input.
"""

import json
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping

from townwise_lab import schema
from townwise_lab.pipeline import calibrate

TIMEOUT_SECONDS = 30
NAMES = ("TOWNWISE_LAB_API_URL", "TOWNWISE_LAB_CALIBRATION_ID", "TOWNWISE_LAB_TOKEN", "TOWNWISE_LAB_CODE_VERSION")


def _post(opener, url: str, token: str, body: dict) -> None:
    data = json.dumps(body, allow_nan=False).encode("utf-8")
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


def main(env: Mapping[str, str], opener=urllib.request.urlopen) -> int:
    missing = [name for name in NAMES if not env.get(name)]
    if missing:
        print(f"missing environment variable: {', '.join(missing)}", file=sys.stderr)
        return 1
    base = env["TOWNWISE_LAB_API_URL"].rstrip("/")
    calibration_id = env["TOWNWISE_LAB_CALIBRATION_ID"]
    token = env["TOWNWISE_LAB_TOKEN"]
    root = f"{base}/lab/calibrations/{calibration_id}"
    result: dict | None = None
    try:
        request = urllib.request.Request(f"{root}/input", method="GET", headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json"})
        with opener(request, timeout=TIMEOUT_SECONDS) as response:
            inp = json.loads(response.read())
        print(f"fetched input: {len(inp['days'])} days")
        result = calibrate(inp, env["TOWNWISE_LAB_CODE_VERSION"])
    except Exception as error:  # the class only
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        result = {"schema": schema.RESULT_SCHEMA, "calibrationId": calibration_id, "ok": False, "code": "internal"}
    try:
        _post(opener, f"{root}/result", token, result)
    except Exception as error:
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        return 1
    if result["ok"]:
        print("posted result: ok")
        return 0
    print(f"posted result: failed {result['code']}")
    return 1
