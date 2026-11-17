//go:build linux

package gate

import (
	"bytes"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The cells' mode's exec sets no_new_privs when asked (separated mode: review of 0.30.0, H1), and
// the shell it starts has it. The test binary runs as the cells' mode in a child (no root needed),
// which execs a shell that reads its own NoNewPrivs.
func TestCellsExecNoNewPrivs(t *testing.T) {
	if os.Getenv("MDRB_TEST_CELLS_MODE") == "1" {
		os.Exit(cellsMain())
	}
	own, err := os.ReadFile("/proc/self/status")
	if err != nil || !bytes.Contains(own, []byte("\nNoNewPrivs:")) {
		t.Skip("no NoNewPrivs in /proc/self/status")
	}
	run := func(nnp bool) string {
		cmd := exec.Command(os.Args[0], "-test.run=^TestCellsExecNoNewPrivs$")
		cmd.Env = append(os.Environ(), "MDRB_TEST_CELLS_MODE=1")
		req := cellsReq{Op: "exec", Argv: []string{"/bin/sh", "-c", "grep NoNewPrivs /proc/self/status"}, Env: []string{"PATH=/usr/bin:/bin"}, Dir: "/", NoNewPrivs: nnp}
		cmd.Stdin = bytes.NewReader(req.encode())
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("cells' mode (no_new_privs %v): %v", nnp, err)
		}
		return strings.Join(strings.Fields(string(out)), " ")
	}
	if got := run(true); got != "NoNewPrivs: 1" {
		t.Errorf("asked: %q", got)
	}
	// Not asked: as its parent has it (shared mode keeps sudo and setuid programs working).
	if !bytes.Contains(own, []byte("\nNoNewPrivs:\t1")) {
		if got := run(false); got != "NoNewPrivs: 0" {
			t.Errorf("not asked: %q", got)
		}
	}
}
