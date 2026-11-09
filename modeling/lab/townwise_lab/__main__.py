"""python -m townwise_lab run --input PATH --output PATH --code-version 40HEX

Reads a LabInput, writes its LabResult, and prints one line of counts. It never prints a figure, a date, a name or an
error's message: a failure prints the exception's class, or the result's code, and exits 1.
"""

import argparse
import json
import sys

from townwise_lab.pipeline import calibrate


def _run(args: argparse.Namespace) -> int:
    try:
        with open(args.input, encoding="utf-8") as source:
            inp = json.load(source)
        result = calibrate(inp, args.code_version)
        text = json.dumps(result, allow_nan=False)
        with open(args.output, "w", encoding="utf-8") as out:
            out.write(text + "\n")
    except Exception as error:  # the class only: a message can hold a value from the input
        print(f"failed: {type(error).__name__}", file=sys.stderr)
        return 1
    if not result["ok"]:
        print(f"failed: {result['code']}", file=sys.stderr)
        return 1
    card = result["scorecard"]
    print(f"calibrated: {card['history']['days']} history days, {card['backtest']['weeks']} backtest weeks, "
          f"{len(result['run']['days'])} forecast days")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m townwise_lab")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="calibrate a LabInput file into a LabResult file")
    run.add_argument("--input", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--code-version", required=True, help="the 40-character commit of the lab's code")
    args = parser.parse_args(argv)
    return _run(args)


if __name__ == "__main__":
    sys.exit(main())
