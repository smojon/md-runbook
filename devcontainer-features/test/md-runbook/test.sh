#!/bin/bash
# The feature's test (devcontainer features test): the command line runs and checks a runbook.
set -e
source dev-container-features-test-lib

check "md-runbook is on the PATH" md-runbook --version
printf '# T\n\n```bash retires=3\necho hi\n```\n' > /tmp/t.md
check "lint suggests the option a typo meant" bash -c 'md-runbook lint /tmp/t.md | grep -q "did you mean \"retry\""'
check "run runs a block and keeps its output" bash -c 'md-runbook run /tmp/t.md --out /tmp/t.out.md && grep -q "^hi$" /tmp/t.out.md'

reportResults
