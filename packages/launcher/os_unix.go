//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The login entry: a LaunchAgent on macOS, an XDG autostart entry elsewhere.
func autostartFile() (string, error) {
	if runtime.GOOS == "darwin" {
		h, err := os.UserHomeDir()
		return filepath.Join(h, "Library", "LaunchAgents", "com.lugia19.comfy-gen-agent.plist"), err
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(h, ".config")
	}
	return filepath.Join(dir, "autostart", "comfy-gen-agent.desktop"), nil
}

func autostartEntry(exe string) string {
	if runtime.GOOS == "darwin" {
		return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lugia19.comfy-gen-agent</string>
  <key>ProgramArguments</key>
  <array><string>%s</string><string>--autostart</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`, xmlEscape(exe))
	}
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Comfy-Gen agent
Comment=Generates images on this PC for Claude
Exec="%s" --autostart
Terminal=false
X-GNOME-Autostart-enabled=true
`, strings.NewReplacer(`\`, `\\\\`, `"`, `\\"`, "`", "\\\\`", "$", `\\$`).Replace(exe))
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func addAutostart(exe string) error {
	path, err := autostartFile()
	if err != nil {
		return err
	}
	return writeIfChanged(path, []byte(autostartEntry(exe)))
}

func removeAutostart() error {
	path, err := autostartFile()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func hideWindow(*exec.Cmd) {}

// endOtherLaunchers asks every other running launcher to stop (SIGTERM: it stops its agent, which
// stops ComfyUI) and waits up to 20 s for them to exit. It returns how many there were.
func endOtherLaunchers() int {
	out, _ := exec.Command("pgrep", "-x", exeName()).Output() // exit 1 when there are none
	var pids []int
	for _, f := range strings.Fields(string(out)) {
		if pid, err := strconv.Atoi(f); err == nil && pid > 1 && pid != os.Getpid() && syscall.Kill(pid, syscall.SIGTERM) == nil {
			pids = append(pids, pid)
		}
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		alive := false
		for _, pid := range pids {
			alive = alive || syscall.Kill(pid, 0) == nil
		}
		if !alive {
			break
		}
	}
	return len(pids)
}

func interrupt(cmd *exec.Cmd) {
	_ = cmd.Process.Signal(syscall.SIGTERM)
}

// alert shows msg in a dialog where one can be raised (the launcher is usually started from a
// file manager, with nowhere to print), and on stderr.
func alert(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("osascript", "-e", fmt.Sprintf("display alert %q message %q", "Comfy-Gen", msg)).Run()
	} else if _, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command("zenity", "--error", "--title=Comfy-Gen", "--text="+msg).Run()
	}
}

func notify(msg string) {
	fmt.Println(msg)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("osascript", "-e", fmt.Sprintf("display dialog %q buttons {\"OK\"} with title %q", msg, "Comfy-Gen")).Run()
	} else if _, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command("zenity", "--info", "--title=Comfy-Gen", "--text="+msg).Run()
	}
}
