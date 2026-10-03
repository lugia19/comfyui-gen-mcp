//go:build !linux

package main

// trayAvailable: Windows and macOS always have a tray.
func trayAvailable() error { return nil }
