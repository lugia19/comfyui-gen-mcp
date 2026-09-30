// The PC agent's launcher (design §2, §9): the small native program a GPU owner downloads once.
// It installs itself into ~/.comfy-gen-mcp/bin, registers itself to start at login, fetches a
// pinned Node (checked against hashes pinned in node.go) and keeps the agent running: Node runs the
// embedded shim in agent mode, and the shim loads the agent bundle from the releases and keeps it
// up to date. The launcher itself changes rarely; a new one is installed by running it.
//
//	comfy-gen-agent              install or repair, then run the agent and open its settings page
//	comfy-gen-agent --autostart  what the login entry runs: the same, without opening the page
//	comfy-gen-agent --uninstall  remove the login entry (the folder, with ComfyUI and models, stays)
//
// Its contract with the agent (packages/agent/src/main.ts): COMFY_GEN_OPEN_SETTINGS says whether
// to open the settings page; exit code restartCode asks to be started again at once (into a newer
// bundle), 0 to stay stopped (another agent already runs), anything else is a crash, retried with
// a backoff.
package main

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

//go:embed shim.mjs
var shim []byte

var version = "dev" // set at build time: -X main.version=vX.Y.Z

const restartCode = 75

func main() {
	autostart := flag.Bool("autostart", false, "started at login: don't open the settings page")
	uninstall := flag.Bool("uninstall", false, "stop starting at login")
	flag.Parse()

	home := homeDir()
	logs := filepath.Join(home, "logs")
	out := openLog(logs)
	log.SetOutput(out)
	log.Printf("Comfy-Gen launcher %s (%s/%s)", version, runtime.GOOS, runtime.GOARCH)

	if *uninstall {
		if err := removeAutostart(); err != nil {
			fail("Could not remove Comfy-Gen from the programs started at login: %v", err)
		}
		notify(fmt.Sprintf("Comfy-Gen will no longer start at login. %s still holds ComfyUI and its models; delete it to free the space.", home))
		return
	}

	exe, err := install(filepath.Join(home, "bin"))
	if err != nil {
		log.Printf("Could not copy the launcher into %s (running from where it is): %v", home, err)
	}
	if err := addAutostart(exe); err != nil {
		log.Printf("Could not register the start at login: %v", err)
	}
	node, err := ensureNode(filepath.Join(home, "node"))
	if err != nil {
		fail("Could not set up Node.js, which runs Comfy-Gen: %v\n\nThe details are in %s.", err, filepath.Join(logs, "launcher.log"))
	}
	shimPath := filepath.Join(home, "bin", "shim.mjs")
	if err := writeIfChanged(shimPath, shim); err != nil {
		fail("Could not write %s: %v", shimPath, err)
	}
	supervise(node, shimPath, out, !*autostart)
}

func homeDir() string {
	if h := os.Getenv("COMFY_GEN_HOME"); h != "" {
		return h
	}
	h, err := os.UserHomeDir()
	if err != nil {
		fail("Could not find your home folder: %v", err)
	}
	return filepath.Join(h, ".comfy-gen-mcp")
}

// openLog appends to logs/launcher.log (starting over past 5 MB), which also takes Node's output.
func openLog(dir string) io.Writer {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return os.Stderr
	}
	path := filepath.Join(dir, "launcher.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return os.Stderr
	}
	return f
}

// fail tells the user (there is no console on Windows) and exits.
func fail(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	alert(msg)
	os.Exit(1)
}

// install copies this program into bin (when it runs from elsewhere) and returns the path the
// login entry should start. A running copy there is renamed aside, which every OS allows.
func install(bin string) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	if s, err := filepath.EvalSymlinks(self); err == nil {
		self = s
	}
	target := filepath.Join(bin, exeName())
	if samePath(self, target) {
		return target, nil
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return self, err
	}
	if old, err := os.ReadFile(target); err == nil && string(old) == string(data) {
		return target, nil
	}
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return self, err
	}
	_ = os.Remove(target + ".old") // left by the previous update, once that copy stopped
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, target+".old"); err != nil {
			return self, err
		}
		_ = os.Remove(target + ".old")
	}
	if err := writeAtomic(target, data, 0o755); err != nil {
		return self, err
	}
	log.Printf("Installed the launcher as %s", target)
	return target, nil
}

func exeName() string {
	if runtime.GOOS == "windows" {
		return "comfy-gen-agent.exe"
	}
	return "comfy-gen-agent"
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func writeIfChanged(path string, data []byte) error {
	if old, err := os.ReadFile(path); err == nil && string(old) == string(data) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeAtomic(path, data, 0o644)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".part"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Waits between crashes; one that ran for long enough starts the sequence over.
var backoff = []time.Duration{5 * time.Second, 30 * time.Second, time.Minute, 5 * time.Minute}

const stableRun = 10 * time.Minute

// supervise runs the agent until it exits with 0 or the launcher is told to stop.
func supervise(node, shimPath string, out io.Writer, open bool) {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	crashes := 0
	for {
		cmd := exec.Command(node, shimPath, "--app", "agent")
		// The agent watches this pid and ends with the launcher (on Windows, ending a process leaves
		// its children running).
		cmd.Env = append(os.Environ(), "COMFY_GEN_OPEN_SETTINGS="+map[bool]string{true: "1", false: "0"}[open],
			fmt.Sprintf("COMFY_GEN_LAUNCHER_PID=%d", os.Getpid()))
		cmd.Stdout, cmd.Stderr = out, out
		hideWindow(cmd)
		open = false
		started := time.Now()
		if err := cmd.Start(); err != nil {
			fail("Could not start Node.js (%s): %v", node, err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		var err error
		select {
		case sig := <-stop:
			log.Printf("Stopping the agent (%v)", sig)
			interrupt(cmd)
			select {
			case <-done:
			case <-time.After(15 * time.Second):
				_ = cmd.Process.Kill()
			}
			return
		case err = <-done:
		}
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		switch {
		case code == 0:
			log.Print("The agent stopped")
			return
		case code == restartCode:
			log.Print("The agent is restarting")
			crashes = 0
			continue
		}
		if time.Since(started) > stableRun {
			crashes = 0
		}
		wait := backoff[min(crashes, len(backoff)-1)]
		crashes++
		log.Printf("The agent exited (%v); starting it again in %s", err, wait)
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
	}
}
