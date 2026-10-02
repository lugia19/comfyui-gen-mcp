package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runKey    = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue  = "Comfy-Gen agent"
	noWindow  = 0x08000000 // CREATE_NO_WINDOW: Node is a console program; the launcher has none
	mbIconErr = 0x10
	mbIconInf = 0x40
)

func addAutostart(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(runValue, `"`+exe+`" --autostart`)
}

func removeAutostart() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
}

// endOtherLaunchers ends every other running launcher. Windows has no signal to ask it, so it is
// terminated; its agent watches it and stops ComfyUI and itself within 2 s. Returns how many.
func endOtherLaunchers() int {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0
	}
	defer windows.CloseHandle(snap)
	self := uint32(os.Getpid())
	n := 0
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if e.ProcessID == self || !strings.EqualFold(windows.UTF16ToString(e.ExeFile[:]), exeName()) {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, e.ProcessID)
		if err != nil {
			continue
		}
		if windows.TerminateProcess(h, 1) == nil {
			n++
		}
		windows.CloseHandle(h)
	}
	return n
}

// interrupt: Windows has no signal for another process; the agent's ComfyUI has a watchdog on it.
func interrupt(cmd *exec.Cmd) {
	_ = cmd.Process.Kill()
}

var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func box(msg string, icon uintptr) {
	text, _ := syscall.UTF16PtrFromString(msg)
	title, _ := syscall.UTF16PtrFromString("Comfy-Gen")
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), icon)
}

func alert(msg string)  { box(msg, mbIconErr) }
func notify(msg string) { box(msg, mbIconInf) }
