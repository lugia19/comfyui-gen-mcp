package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeEntry struct {
	title, tooltip string
	disabled       bool
	clicked        chan struct{}
}

func (e *fakeEntry) SetTitle(t string)        { e.title = t }
func (e *fakeEntry) SetTooltip(t string)      { e.tooltip = t }
func (e *fakeEntry) Enable()                  { e.disabled = false }
func (e *fakeEntry) Disable()                 { e.disabled = true }
func (e *fakeEntry) Clicked() <-chan struct{} { return e.clicked }
func (t *fakeTray) SetIcon(icon []byte)       { t.icon = string(icon) }
func (t *fakeTray) SetTitle(title string)     { t.title = title }
func (t *fakeTray) SetTooltip(tooltip string) { t.tooltip = tooltip }
func (t *fakeTray) AddSeparator()             { t.order = append(t.order, separator) }
func (t *fakeTray) AddItem(title, tip string) entry {
	e := &fakeEntry{title: title, tooltip: tip, clicked: make(chan struct{})}
	t.entries = append(t.entries, e)
	t.order = append(t.order, title)
	return e
}

type fakeTray struct {
	icon, title, tooltip string
	entries              []*fakeEntry
	order                []string
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// The menu as tray.ts sends it (machineTray's items, abridged).
const firstMenu = `{"icon":"aWNvbg==","title":"","tooltip":"Comfy-Gen agent: ComfyUI: stopped","items":[` +
	`{"title":"Open settings","tooltip":"Open settings","enabled":true,"checked":false,"__id":1},` +
	`{"title":"ComfyUI: stopped","tooltip":"ComfyUI: stopped","enabled":false,"checked":false,"__id":2},` +
	`{"title":"<SEPARATOR>","tooltip":"","enabled":true,"checked":false,"__id":3},` +
	`{"title":"Stop ComfyUI","tooltip":"Stop ComfyUI","enabled":false,"checked":false,"__id":4}]}`

func TestMenu(t *testing.T) {
	ft := &fakeTray{}
	h := newHelper(ft, &syncBuffer{})
	if h.handle([]byte(firstMenu)) {
		t.Fatal("the menu ended the helper")
	}
	if ft.icon != "icon" || ft.tooltip != "Comfy-Gen agent: ComfyUI: stopped" {
		t.Fatalf("icon %q, tooltip %q", ft.icon, ft.tooltip)
	}
	if got := strings.Join(ft.order, "|"); got != "Open settings|ComfyUI: stopped|<SEPARATOR>|Stop ComfyUI" {
		t.Fatalf("items: %s", got)
	}
	if ft.entries[0].disabled || !ft.entries[1].disabled || !ft.entries[2].disabled {
		t.Fatal("enabled state not applied")
	}
}

func TestUpdates(t *testing.T) {
	ft := &fakeTray{}
	h := newHelper(ft, &syncBuffer{})
	h.handle([]byte(firstMenu))
	h.handle([]byte(`{"type":"update-item","item":{"title":"Stop ComfyUI","tooltip":"Stop ComfyUI","enabled":true,"__id":4},"seq_id":-1}`))
	if ft.entries[2].disabled {
		t.Fatal("update-item did not enable")
	}
	h.handle([]byte(`{"type":"update-menu","menu":{"icon":"Z3JlZW4=","title":"","tooltip":"running","items":[` +
		`{"title":"ComfyUI: running","tooltip":"ComfyUI: running","enabled":false,"__id":2}]}}`))
	if ft.icon != "green" || ft.tooltip != "running" || ft.entries[1].title != "ComfyUI: running" {
		t.Fatalf("update-menu: icon %q tooltip %q item %q", ft.icon, ft.tooltip, ft.entries[1].title)
	}
	if len(ft.order) != 4 {
		t.Fatalf("update-menu added items: %v", ft.order)
	}
	h.handle([]byte(`{"type":"update-item","item":{"title":"x","__id":99}}`)) // unknown: ignored
	h.handle([]byte(`not json`))
	h.handle([]byte(`{"type":"something-new"}`))
	if !h.handle([]byte(`{"type":"exit"}`)) {
		t.Fatal("exit did not end")
	}
}

func TestClicked(t *testing.T) {
	ft := &fakeTray{}
	out := &syncBuffer{}
	h := newHelper(ft, out)
	h.handle([]byte(firstMenu))
	ft.entries[2].clicked <- struct{}{} // Stop ComfyUI, __id 4
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(out.String(), "\n") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	var msg map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out.String())), &msg); err != nil {
		t.Fatalf("output %q: %v", out.String(), err)
	}
	if msg["type"] != "clicked" || msg["__id"] != float64(4) {
		t.Fatalf("got %v", msg)
	}
}

func TestReadEndsWithInput(t *testing.T) {
	ft := &fakeTray{}
	h := newHelper(ft, &syncBuffer{})
	h.read(strings.NewReader(firstMenu + "\n")) // returns when stdin ends (Node gone)
	if len(ft.entries) != 3 {
		t.Fatalf("entries: %d", len(ft.entries))
	}
}
