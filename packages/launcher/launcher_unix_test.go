//go:build !windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAutostartEntry(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	exe := "/home/some one/.comfy-gen-mcp/bin/comfy-gen-agent"
	if err := addAutostart(exe); err != nil {
		t.Fatal(err)
	}
	path, _ := autostartFile()
	b, _ := os.ReadFile(path)
	want := `Exec="` + exe + `" --autostart`
	if runtime.GOOS == "darwin" {
		want = "<string>" + exe + "</string><string>--autostart</string>"
	}
	if !strings.Contains(string(b), want) {
		t.Errorf("entry lacks %q:\n%s", want, b)
	}
	if err := removeAutostart(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("the entry is still there")
	}
	if err := removeAutostart(); err != nil {
		t.Errorf("removing twice: %v", err)
	}
}

// A stand-in agent: exits with the restart code on its first run, then 0. Each run records
// COMFY_GEN_OPEN_SETTINGS and its arguments.
func TestSuperviseRestartsOnRequestAndStopsOnZero(t *testing.T) {
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	script := filepath.Join(dir, "agent.sh")
	os.WriteFile(script, []byte(`echo "$COMFY_GEN_OPEN_SETTINGS $*" >> "`+runs+`"
[ "$(wc -l < "`+runs+`")" -ge 2 ] && exit 0
exit 75
`), 0o755)
	var out bytes.Buffer
	supervise("/bin/sh", script, &out, true)
	b, _ := os.ReadFile(runs)
	if got := string(b); got != "1 --app agent\n0 --app agent\n" {
		t.Errorf("runs:\n%s", got)
	}
}
