//go:build unix

// md-runbook-gate: the forced command of SSH keys that may only run signed runbooks. See
// apps/gate/README.md and the gate package.
package main

import (
	"os"

	"github.com/smojon/md-runbook/apps/gate/internal/gate"
)

func main() { os.Exit(gate.Main(os.Args)) }
