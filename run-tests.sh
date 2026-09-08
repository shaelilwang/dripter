#!/usr/bin/env bash
# Article Drip test runner. No dependencies beyond node and python3.
set -u
cd "$(dirname "$0")"

fail=0
for t in tests/*.test.js; do
  echo "── $t"
  node "$t" || fail=1
done

echo
if [ $fail -ne 0 ]; then
  echo "offline suites FAILED"
else
  echo "offline suites passed"
fi

cat <<'MSG'

Injection tests need a real browser (they exercise DOM behaviour):

    python3 tests/serve.py
    open http://localhost:8777/tests/harness.html

The page title reads PASS (n) or FAIL (n).
MSG

exit $fail
