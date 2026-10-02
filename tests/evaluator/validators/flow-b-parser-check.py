"""Untrusted-module adapter. Expected results are checked outside this process."""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("candidate", sys.argv[1])
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
request = json.loads(sys.stdin.read())
result = candidate.parse_csv(request["csv"])
sys.stdout.write(json.dumps({"result": result}))
