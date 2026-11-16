//go:build unix

package report

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
)

// SenderMode is the argument that makes the gate's program the report sender: the gate starts
// itself so, in a session of its own, after a session. Its input (stdin) is a Batch in JSON.
const SenderMode = "__send-reports"

// Batch is what the sender gets: where to send, the token, how to log, and the summaries.
// ([]byte: JSON keeps every byte of them, valid UTF-8 or not.)
type Batch struct {
	To      []byte
	Token   []byte
	Log     []byte
	Account []byte
	Who     []byte
	Client  []byte
	Reports []Item
}

// Item is one summary.
type Item struct {
	Body    []byte
	Name    []byte
	Version []byte
}

// Pauses before each of the 3 tries.
var pauses = []time.Duration{0, 2 * time.Second, 5 * time.Second}

// SenderMain sends a batch read from in: up to 3 tries each, a `report` event per summary
// (sent or failed, with the HTTP status). It never holds up a session: the gate starts it
// detached, with nothing of the SSH channel.
func SenderMain(in io.Reader) int {
	signal.Ignore(syscall.SIGHUP)
	data, err := io.ReadAll(io.LimitReader(in, 64<<20))
	if err != nil {
		return 1
	}
	var b Batch
	if json.Unmarshal(data, &b) != nil {
		return 1
	}
	l := &logx.Logger{Dest: string(b.Log), Account: string(b.Account), Who: string(b.Who), Client: string(b.Client)}
	client := Client()
	for _, it := range b.Reports {
		code := "000"
		for _, p := range pauses {
			time.Sleep(p)
			code = post(client, string(b.To), b.Token, it.Body)
			if code[0] == '2' || (code[0] == '4' && code != "408" && code != "429") {
				break
			}
		}
		status := "failed"
		if code[0] == '2' {
			status = "sent"
		}
		l.Event("event", "report", "status", status, "http", code, "url", string(b.To), "runbook", string(it.Name), "version", string(it.Version))
	}
	return 0
}

// Client is the HTTP client of the reports: 10 seconds a try, no proxy from the environment, no
// redirects (curl -q --max-time 10, as the shell gate sent them), no file of the account read.
func Client() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: t,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// post sends one summary; the HTTP status as 3 digits, 000 when there was none.
func post(c *http.Client, to string, token, body []byte) string {
	req, err := http.NewRequest(http.MethodPost, to, bytes.NewReader(body))
	if err != nil {
		return "000"
	}
	if len(token) > 0 {
		req.Header.Set("authorization", "Bearer "+string(token))
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", "md-runbook-gate")
	res, err := c.Do(req)
	if err != nil {
		return "000"
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if res.StatusCode < 100 || res.StatusCode > 999 {
		return "000"
	}
	return fmt.Sprintf("%03d", res.StatusCode)
}

// Encode is the batch as the sender reads it.
func (b Batch) Encode() []byte {
	data, _ := json.Marshal(b)
	return data
}
