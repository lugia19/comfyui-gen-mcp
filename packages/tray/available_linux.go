package main

import (
	"errors"

	"github.com/godbus/dbus/v5"
)

// trayAvailable checks that the desktop shows StatusNotifierItems: without a watcher on the session
// bus (plain GNOME, a server, WSLg), fyne would run on with no icon, printing only its own error.
func trayAvailable() error {
	const none = "no tray on this desktop (on GNOME, the AppIndicator extension adds one)"
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return errors.New(none + ": no D-Bus session: " + err.Error())
	}
	defer conn.Close()
	var has bool
	if err := conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has); err != nil || !has {
		return errors.New(none)
	}
	return nil
}
