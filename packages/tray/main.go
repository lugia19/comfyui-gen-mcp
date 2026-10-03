// The tray helper (design §2): the small native program that shows the tray icon of the PC agent
// and of the Claude Desktop extension. Node cannot draw one itself, so packages/local/src/tray.ts
// runs this and talks to it in JSON lines:
//
//	out: {"type":"ready"}                    the tray is up; the menu may come
//	     {"type":"clicked","__id":N}         item N was clicked
//	in:  {icon, title, tooltip, items}       the menu (the first line); icon is base64 (.ico on
//	                                         Windows, .png elsewhere); an item is {title, tooltip,
//	                                         enabled, __id}, "<SEPARATOR>" as its title for a line
//	     {"type":"update-item","item":{…}}   change the item with that __id
//	     {"type":"update-menu","menu":{…}}   change the icon, tooltip and items
//	     {"type":"exit"}                     end; so does stdin closing (Node ended)
//
// fyne.io/systray draws it: StatusNotifierItem over D-Bus on Linux (no GTK or libappindicator),
// Win32 on Windows, Cocoa on macOS (the one build that needs cgo, so a Mac builds it).
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"fyne.io/systray"
)

const separator = "<SEPARATOR>"

type item struct {
	Title   string `json:"title"`
	Tooltip string `json:"tooltip"`
	Enabled bool   `json:"enabled"`
	ID      int    `json:"__id"`
}

type menu struct {
	Icon    string `json:"icon"`
	Title   string `json:"title"`
	Tooltip string `json:"tooltip"`
	Items   []item `json:"items"`
}

type message struct {
	Type string `json:"type"`
	menu        // the first line: the menu itself, with no type
	Item *item  `json:"item"`
	Menu *menu  `json:"menu"`
}

// What the helper draws on, so the tests need no desktop.
type tray interface {
	SetIcon(icon []byte)
	SetTitle(title string)
	SetTooltip(tooltip string)
	AddItem(title, tooltip string) entry
	AddSeparator()
}

type entry interface {
	SetTitle(title string)
	SetTooltip(tooltip string)
	Enable()
	Disable()
	Clicked() <-chan struct{}
}

type helper struct {
	t     tray
	mu    sync.Mutex // one writer of out at a time (clicks come from several goroutines)
	out   io.Writer
	items map[int]entry
}

func newHelper(t tray, out io.Writer) *helper {
	return &helper{t: t, out: out}
}

func (h *helper) emit(msg map[string]any) {
	line, _ := json.Marshal(msg)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.out.Write(append(line, '\n'))
}

// handle acts on one line from Node; true means end.
func (h *helper) handle(line []byte) bool {
	var msg message
	if err := json.Unmarshal(line, &msg); err != nil {
		return false
	}
	switch msg.Type {
	case "":
		h.setMenu(msg.menu)
	case "update-menu":
		if msg.Menu != nil {
			h.setMenu(*msg.Menu)
		}
	case "update-item":
		if msg.Item != nil {
			h.setItem(*msg.Item)
		}
	case "exit":
		return true
	}
	return false
}

func (h *helper) setMenu(m menu) {
	if icon, err := base64.StdEncoding.DecodeString(m.Icon); err == nil && len(icon) > 0 {
		h.t.SetIcon(icon)
	}
	h.t.SetTitle(m.Title)
	h.t.SetTooltip(m.Tooltip)
	if h.items != nil {
		for _, it := range m.Items {
			h.setItem(it)
		}
		return
	}
	// The items are added once; later menus change them by __id.
	h.items = map[int]entry{}
	for _, it := range m.Items {
		if it.Title == separator {
			h.t.AddSeparator()
			continue
		}
		e := h.t.AddItem(it.Title, it.Tooltip)
		if !it.Enabled {
			e.Disable()
		}
		h.items[it.ID] = e
		go func(id int, clicked <-chan struct{}) {
			for range clicked {
				h.emit(map[string]any{"type": "clicked", "__id": id})
			}
		}(it.ID, e.Clicked())
	}
}

func (h *helper) setItem(it item) {
	e, ok := h.items[it.ID]
	if !ok {
		return
	}
	e.SetTitle(it.Title)
	e.SetTooltip(it.Tooltip)
	if it.Enabled {
		e.Enable()
	} else {
		e.Disable()
	}
}

// read handles Node's lines until "exit" or the end of stdin.
func (h *helper) read(in io.Reader) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16<<20) // an icon is a few KB of base64
	for scanner.Scan() {
		if h.handle(scanner.Bytes()) {
			return
		}
	}
}

// fyne.io/systray as a tray.
type fyneTray struct{}

func (fyneTray) SetIcon(icon []byte)       { systray.SetIcon(icon) }
func (fyneTray) SetTitle(title string)     { systray.SetTitle(title) }
func (fyneTray) SetTooltip(tooltip string) { systray.SetTooltip(tooltip) }
func (fyneTray) AddSeparator()             { systray.AddSeparator() }
func (fyneTray) AddItem(title, tooltip string) entry {
	return fyneEntry{systray.AddMenuItem(title, tooltip)}
}

type fyneEntry struct{ *systray.MenuItem }

func (e fyneEntry) Clicked() <-chan struct{} { return e.ClickedCh }

func main() {
	if err := trayAvailable(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	systray.Run(func() {
		h := newHelper(fyneTray{}, os.Stdout)
		h.emit(map[string]any{"type": "ready"})
		go func() {
			h.read(os.Stdin)
			systray.Quit()
		}()
	}, func() {})
}
