package vectors

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
	"github.com/smojon/md-runbook/apps/gate/internal/names"
	"github.com/smojon/md-runbook/apps/gate/internal/proto"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// The file core writes (npm run gate-vectors); never edited by hand.
const file = "../../testdata/vectors.json"

type vector struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id"`
	Input json.RawMessage `json:"input"`
	Core  json.RawMessage `json:"core"`
}

// input is a vector's input: a string, or {"parts": [[text, times], ...]} for a long one.
func input(t *testing.T, raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var p struct {
		Parts [][2]json.RawMessage `json:"parts"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("bad input %s", raw)
	}
	var b strings.Builder
	for _, part := range p.Parts {
		var text string
		var times int
		if json.Unmarshal(part[0], &text) != nil || json.Unmarshal(part[1], &times) != nil {
			t.Fatalf("bad part %s", part)
		}
		b.WriteString(strings.Repeat(text, times))
	}
	return b.String()
}

// long is a long string as core's vectors write it: its length and hash.
func long(s string) any {
	if len(s) <= 512 {
		return s
	}
	h := sha256.Sum256([]byte(s))
	return map[string]any{"bytes": len(s), "sha256": hex.EncodeToString(h[:])}
}

func dec(b64 string) string {
	b, _ := proto.Decode(b64)
	return string(b)
}

// readManifest is the gate's reading of a manifest: Check, then the reads the gate's requests
// make (Field, Param, Env, Step: the first item of each key).
func readManifest(text string) map[string]any {
	if manifest.Check(text) != nil {
		return map[string]any{"ok": false}
	}
	m := manifest.Parse(text)
	params := []any{}
	for _, n := range m.All("param", "", 2) {
		params = append(params, []any{n, long(dec(m.Param(n)))})
	}
	cells := []any{}
	for _, c := range m.Cells() {
		info := dec(m.Field("info", c, 2))
		env := []any{}
		for _, e := range m.Env(c) {
			env = append(env, []any{e.Name, long(dec(e.Value))})
		}
		steps := []any{}
		for k := 0; k <= m.LastStep(c); k++ {
			steps = append(steps, long(dec(m.Step(c, k))))
		}
		needs := []any{}
		for _, n := range m.All("needs", c, 2) {
			needs = append(needs, n)
		}
		kube, _ := manifest.KubeWant(info)
		cells = append(cells, map[string]any{
			"n": c, "lines": m.Field("cell", c, 3), "info": long(info), "code": long(dec(m.Field("code", c, 2))),
			"needs": needs, "cwd": dec(m.Field("cwd", c, 2)), "env": env, "steps": steps, "kube": kube,
		})
	}
	scopes := []any{}
	for _, s := range textutil.Fields(m.Scopes()) {
		scopes = append(scopes, s)
	}
	return map[string]any{
		"ok": true, "name": m.Field("name", "", 2), "version": m.Field("version", "", 2), "expires": m.Field("expires", "", 2),
		"scopes": scopes, "text": m.Field("text", "", 2), "params": params, "cells": cells,
	}
}

// coreManifest is core's reading without what the gate never reads: the calls (the gate runs no
// runbook calls) and core's message.
func coreManifest(t *testing.T, raw json.RawMessage) map[string]any {
	var r map[string]any
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	delete(r, "calls")
	delete(r, "why")
	return r
}

// same compares two readings as JSON.
func same(t *testing.T, v vector, got, want any) bool {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	var gv, wv any
	json.Unmarshal(g, &gv)
	json.Unmarshal(w, &wv)
	if !reflect.DeepEqual(gv, wv) {
		t.Errorf("%s %q: the gate reads\n  %s\ncore reads\n  %s", v.Kind, v.ID, cut(g), cut(w))
		return false
	}
	return true
}

func cut(b []byte) string {
	if len(b) > 2000 {
		return string(b[:2000]) + "..."
	}
	return string(b)
}

func TestVectors(t *testing.T) {
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Counts  map[string]int `json:"counts"`
		Vectors []vector       `json:"vectors"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	checked := map[string]int{}
	for _, v := range f.Vectors {
		in := input(t, v.Input)
		switch v.Kind {
		case "manifest":
			same(t, v, readManifest(in), coreManifest(t, v.Core))
		case "info":
			checkInfo(t, v, in)
		case "name":
			var c struct{ Var, Reserved, Settable bool }
			json.Unmarshal(v.Core, &c)
			isVar := textutil.IsVar(in)
			same(t, v, map[string]bool{"var": isVar, "reserved": names.IsReserved(in), "settable": isVar && !names.IsReserved(in)},
				map[string]bool{"var": c.Var, "reserved": c.Reserved, "settable": c.Settable})
		case "runbook":
			var c struct {
				Manifest *string         `json:"manifest"`
				Reading  json.RawMessage `json:"reading"`
				Errors   []string        `json:"errors"`
			}
			json.Unmarshal(v.Core, &c)
			if c.Manifest == nil {
				// Core refuses to sign it: no manifest reaches a gate.
				if len(c.Errors) == 0 {
					t.Errorf("runbook %q: neither a manifest nor errors", v.ID)
				}
				break
			}
			got := readManifest(*c.Manifest)
			if same(t, v, got, coreManifest(t, c.Reading)) && got["ok"] != true {
				t.Errorf("runbook %q: core signs a manifest neither reads", v.ID)
			}
		case "request":
			checkRequest(t, v, in)
		case "length":
			checkLength(t, v, in)
		default:
			t.Errorf("unknown kind %q", v.Kind)
		}
		checked[v.Kind]++
	}
	if !reflect.DeepEqual(checked, f.Counts) {
		t.Errorf("checked %v, the file has %v", checked, f.Counts)
	}
	t.Logf("%d vectors: %v", len(f.Vectors), checked)
}

func checkInfo(t *testing.T, v vector, info string) {
	var c struct {
		Has, Ok bool
		Want    string
	}
	json.Unmarshal(v.Core, &c)
	want, has, problem := manifest.KubeContext(info)
	got := map[string]any{"has": has, "ok": problem == ""}
	if has && problem == "" {
		got["want"] = want
	}
	exp := map[string]any{"has": c.Has, "ok": c.Ok}
	if c.Has && c.Ok {
		exp["want"] = c.Want
	}
	if same(t, v, got, exp) && has && problem == "" {
		// What the gate checks before a run (once Check took the manifest).
		if w, ok := manifest.KubeWant(info); !ok || w != c.Want {
			t.Errorf("info %q: KubeWant reads %q", v.ID, w)
		}
	}
}

// checkRequest reads a request line as the gate's session does (proto.Reader, then words split at
// blanks, then each request's checks: gate/session.go handle and gate/requests.go).
func checkRequest(t *testing.T, v vector, in string) {
	r := proto.NewReader(strings.NewReader(in))
	line, err := r.Next()
	if err != nil {
		t.Errorf("request %q: %v", v.ID, err)
		return
	}
	if _, err := r.Next(); err != io.EOF {
		t.Errorf("request %q: more than one line", v.ID)
	}
	var c map[string]any
	json.Unmarshal(v.Core, &c)
	f := textutil.Fields(line)
	if len(f) < 2 || !textutil.IsID(f[1]) {
		t.Errorf("request %q: no request id", v.ID)
		return
	}
	verb, args := f[0], f[2:]
	got := map[string]any{"verb": verb}
	ok := true
	switch verb {
	case "load":
		ok = len(args) >= 2 && len(args) <= 6
		for _, a := range args {
			ok = ok && textutil.IsB64(a)
		}
		if ok {
			got["manifest"] = dec(args[0])
			got["signatures"] = len(args) - 1
			if manifest.Check(dec(args[0])) != nil {
				t.Errorf("request %q: the gate can't read the manifest", v.ID)
			}
		}
	case "param":
		if len(args) == 1 {
			args = append(args, "")
		}
		ok = len(args) == 2 && textutil.IsVar(args[0]) && textutil.IsB64(args[1])
		if ok {
			got["name"], got["value"] = args[0], dec(args[1])
			got["oneLine"] = textutil.IsOneLine(dec(args[1]))
		}
	case "run":
		ok = len(args) == 1 && textutil.IsNum(args[0])
		if ok {
			got["cell"] = args[0]
		}
	case "step":
		ok = len(args) == 2 && textutil.IsNum(args[0]) && textutil.IsNum(args[1])
		if ok {
			got["cell"], got["step"] = args[0], args[1]
		}
	case "called":
		ok = len(args) == 2 && textutil.IsHex64(args[0]) && textutil.IsNum(args[1])
		if ok {
			got["hash"], got["call"] = args[0], args[1]
		}
	case "context":
		ok = len(args) == 0
	case "raw":
		if len(args) == 0 {
			args = []string{""}
		}
		ok = len(args) == 1 && textutil.IsB64(args[0])
		if ok {
			got["text"] = dec(args[0])
		}
	case "note":
		n, nok := proto.ParseNote(args)
		ok = nok
		got["alert"], got["fingerprint"], got["startsAt"] = n.Alert, n.Fingerprint, n.StartsAt
	}
	if !ok {
		t.Errorf("request %q: the gate refuses %q", v.ID, cut([]byte(line)))
		return
	}
	same(t, v, got, c)
}

// checkLength: the gate reads a request line up to proto.MaxLine bytes, and no last line without
// its newline.
func checkLength(t *testing.T, v vector, in string) {
	var c struct {
		Bytes int
		Read  bool
	}
	json.Unmarshal(v.Core, &c)
	line, err := proto.NewReader(strings.NewReader(in)).Next()
	read := err == nil
	if read != c.Read || (read && len(line) != c.Bytes) {
		t.Errorf("length %q: the gate reads %d bytes (%v), core says %d (%v)", v.ID, len(line), err, c.Bytes, c.Read)
	}
	if !read && c.Bytes > proto.MaxLine && !errors.Is(err, proto.ErrTooLong) {
		t.Errorf("length %q: %v, not ErrTooLong", v.ID, err)
	}
}
