package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/godbus/dbus/v5"
)

// trayAvailable fails only without a D-Bus session (a server, an SSH login), where no tray can ever
// appear. A desktop that shows no StatusNotifierItems yet is noted, and the helper stays: at login
// the agent can start before the panel, and plain GNOME gets one with the AppIndicator extension;
// fyne registers the icon as soon as a watcher appears.
func trayAvailable() error {
	// Only a session that exists: with neither, godbus would start a bus of its own (dbus-launch).
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		if _, err := os.Stat(filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "bus")); os.Getenv("XDG_RUNTIME_DIR") == "" || err != nil {
			return errors.New("no tray: no D-Bus session")
		}
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return errors.New("no tray: no D-Bus session: " + err.Error())
	}
	defer conn.Close()
	var has bool
	if err := conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has); err != nil || !has {
		fmt.Fprintln(os.Stderr, "no tray on this desktop yet (on GNOME, the AppIndicator extension adds one); the icon appears when one starts")
	}
	return nil
}
