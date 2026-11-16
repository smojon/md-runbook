//go:build !unix

// md-runbook-gate runs on Linux and macOS only. (This file lets `go build ./...` and `go vet
// ./...` work on other systems, for the packages that are not system-bound.)
package main

import "os"

func main() {
	os.Stderr.WriteString("md-runbook-gate: runs on Linux and macOS only\n")
	os.Exit(2)
}
