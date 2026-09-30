package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type entry struct{ name, body, link string }

func tarGz(t *testing.T, entries []entry) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o755, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
		if strings.HasSuffix(e.name, "/") {
			hdr.Typeflag, hdr.Size = tar.TypeDir, 0
		} else if e.link != "" {
			hdr.Typeflag, hdr.Linkname, hdr.Size = tar.TypeSymlink, e.link, 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipped(t *testing.T, entries []entry) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.body))
	}
	zw.Close()
	return buf.Bytes()
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestInsideDropsTheTopFolderAndRefusesEscapes(t *testing.T) {
	dest := t.TempDir()
	if p, _ := inside(dest, "node-v1-linux-x64/"); p != "" {
		t.Errorf("top folder mapped to %q", p)
	}
	if p, _ := inside(dest, "node-v1-linux-x64/bin/node"); p != filepath.Join(dest, "bin", "node") {
		t.Errorf("got %q", p)
	}
	if _, err := inside(dest, "node-v1/../../evil"); err == nil {
		t.Error("an escaping entry was accepted")
	}
}

func TestUnpacksBothArchiveKinds(t *testing.T) {
	dir := t.TempDir()
	tgz := filepath.Join(dir, "a.tar.gz")
	os.WriteFile(tgz, tarGz(t, []entry{{name: "node-v1/"}, {name: "node-v1/bin/node", body: "#!node"}, {name: "node-v1/bin/npx", link: "../lib/npx"}}), 0o644)
	if err := untar(tgz, filepath.Join(dir, "t")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "t", "bin", "node")); string(b) != "#!node" {
		t.Errorf("node: %q", b)
	}
	if l, _ := os.Readlink(filepath.Join(dir, "t", "bin", "npx")); l != filepath.FromSlash("../lib/npx") {
		t.Errorf("npx link: %q", l)
	}
	z := filepath.Join(dir, "a.zip")
	os.WriteFile(z, zipped(t, []entry{{name: "node-v1/node.exe", body: "MZ"}}), 0o644)
	if err := unzip(z, filepath.Join(dir, "z")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "z", "node.exe")); string(b) != "MZ" {
		t.Errorf("node.exe: %q", b)
	}
	for _, link := range []string{"/etc/passwd", "../../outside"} {
		evil := filepath.Join(dir, "evil.tar.gz")
		os.WriteFile(evil, tarGz(t, []entry{{name: "node-v1/bin/x", link: link}}), 0o644)
		if err := untar(evil, filepath.Join(dir, "e")); err == nil {
			t.Errorf("a link to %s was accepted", link)
		}
	}
}

func TestEnsureNodeDownloadsChecksAndKeepsOneVersion(t *testing.T) {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	orig, ok := nodeArchives[platform]
	if !ok {
		t.Skip("no Node pinned for this platform")
	}
	var archive []byte
	if strings.HasSuffix(orig.name, ".zip") {
		archive = zipped(t, []entry{{name: "node/node.exe", body: "MZ"}})
	} else {
		archive = tarGz(t, []entry{{name: "node/bin/node", body: "#!node"}})
	}
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path != "/"+nodeVersion+"/"+orig.name || !strings.HasPrefix(r.UserAgent(), "comfy-gen-launcher/") {
			http.NotFound(w, r)
			return
		}
		w.Write(archive)
	}))
	defer srv.Close()
	nodeDist = srv.URL
	defer func() { nodeDist, nodeArchives[platform] = "https://nodejs.org/dist", orig }()

	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "v1.0.0"), 0o755) // an older one, removed

	nodeArchives[platform] = struct{ name, sha256 string }{orig.name, strings.Repeat("0", 64)}
	if _, err := ensureNode(dir); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("a wrong checksum: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, nodeVersion)); err == nil {
		t.Fatal("a mismatched archive was unpacked")
	}

	nodeArchives[platform] = struct{ name, sha256 string }{orig.name, sum(archive)}
	exe, err := ensureNode(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureNode(dir); err != nil || hits != 2 {
		t.Fatalf("a second call downloaded again (%d hits, %v)", hits, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != nodeVersion {
		t.Errorf("left in the node folder: %v", entries)
	}
}

func TestInstallCopiesItselfOnce(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "bin")
	target, err := install(bin)
	if err != nil {
		t.Fatal(err)
	}
	if target != filepath.Join(bin, exeName()) {
		t.Fatalf("installed as %s", target)
	}
	st, _ := os.Stat(target)
	if again, err := install(bin); err != nil || again != target {
		t.Fatalf("second install: %s, %v", again, err)
	}
	st2, _ := os.Stat(target)
	if !st.ModTime().Equal(st2.ModTime()) {
		t.Error("an identical copy was rewritten")
	}
}
