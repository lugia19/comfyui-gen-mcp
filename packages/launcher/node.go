package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The Node the agent runs on: an LTS release, its archives' SHA-256 from the release's
// SHASUMS256.txt. Moving to a newer Node means a new launcher release.
const nodeVersion = "v24.21.0"

var nodeArchives = map[string]struct{ name, sha256 string }{
	"windows/amd64": {"node-v24.21.0-win-x64.zip", "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"},
	"darwin/arm64":  {"node-v24.21.0-darwin-arm64.tar.gz", "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"},
	"linux/amd64":   {"node-v24.21.0-linux-x64.tar.gz", "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"},
}

var nodeDist = "https://nodejs.org/dist" // tests point it at a local server

// ensureNode returns the pinned Node's executable under dir/<version>, downloading it first if
// needed, and removes other versions.
func ensureNode(dir string) (string, error) {
	archive, ok := nodeArchives[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return "", fmt.Errorf("no Node.js for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	root := filepath.Join(dir, nodeVersion)
	exe := nodeExe(root)
	if _, err := os.Stat(exe); err != nil {
		say("Setting up Node.js %s, which runs the agent (first start only, about 30 MB)...", nodeVersion)
		if err := fetchNode(dir, root, archive.name, archive.sha256); err != nil {
			return "", err
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != nodeVersion {
			_ = os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
	return exe, nil
}

func nodeExe(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "node.exe")
	}
	return filepath.Join(root, "bin", "node")
}

// fetchNode downloads the archive, checks its hash and unpacks it into root.
func fetchNode(dir, root, name, sum string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file := filepath.Join(dir, name+".part")
	defer os.Remove(file)
	if err := download(fmt.Sprintf("%s/%s/%s", nodeDist, nodeVersion, name), file, sum); err != nil {
		return err
	}
	tmp := root + ".part"
	_ = os.RemoveAll(tmp)
	var err error
	if strings.HasSuffix(name, ".zip") {
		err = unzip(file, tmp)
	} else {
		err = untar(file, tmp)
	}
	if err != nil {
		_ = os.RemoveAll(tmp)
		return fmt.Errorf("unpacking %s: %w", name, err)
	}
	_ = os.RemoveAll(root)
	return os.Rename(tmp, root)
}

var client = &http.Client{Timeout: 10 * time.Minute}

// download saves url to path, failing unless its SHA-256 is sum.
func download(url, path, sum string) error {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "comfy-gen-launcher/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("%s: %w", url, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sum {
		return fmt.Errorf("%s: checksum mismatch (got %s)", url, got)
	}
	return nil
}

// inside maps an archive entry to a path under dest, dropping the archive's top folder
// (node-vX-os-arch/); "" for the top folder itself.
func inside(dest, name string) (string, error) {
	name = strings.TrimPrefix(filepath.ToSlash(name), "./")
	_, rest, _ := strings.Cut(name, "/")
	rest = strings.TrimSuffix(rest, "/")
	if rest == "" {
		return "", nil
	}
	path := filepath.Join(dest, filepath.FromSlash(rest))
	if !within(dest, path) {
		return "", fmt.Errorf("an entry outside the archive: %s", name)
	}
	return path, nil
}

func within(dest, path string) bool {
	return strings.HasPrefix(filepath.Clean(path), filepath.Clean(dest)+string(filepath.Separator))
}

func unzip(archive, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		path, err := inside(dest, f.Name)
		if err != nil || path == "" {
			if err != nil {
				return err
			}
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
			continue
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		err = writeFile(path, src, f.Mode()|0o644)
		src.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func untar(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		path, err := inside(dest, hdr.Name)
		if err != nil {
			return err
		}
		if path == "" {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o755)
		case tar.TypeReg:
			err = writeFile(path, tr, hdr.FileInfo().Mode()|0o644)
		case tar.TypeSymlink:
			// npm and npx: relative links within the archive
			target := filepath.Join(filepath.Dir(path), filepath.FromSlash(hdr.Linkname))
			if strings.HasPrefix(hdr.Linkname, "/") || filepath.IsAbs(hdr.Linkname) || !within(dest, target) {
				return fmt.Errorf("a link out of the archive: %s -> %s", hdr.Name, hdr.Linkname)
			}
			if err = os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
				err = os.Symlink(hdr.Linkname, path)
			}
		}
		if err != nil {
			return err
		}
	}
}

func writeFile(path string, src io.Reader, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode.Perm())
	if err != nil {
		return err
	}
	_, err = io.Copy(out, src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}
