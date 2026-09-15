package happ

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// FileReport describes one key file of an assets directory.
type FileReport struct {
	Present bool   `json:"present"`
	Size    int64  `json:"size,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
	Keys    int    `json:"keys"`
	Invalid int    `json:"invalid"`
	Error   string `json:"error,omitempty"`
}

// Report describes an assets directory for diagnostics.
type Report struct {
	Dir          string     `json:"assets_dir"`
	Crypt5       FileReport `json:"crypt5_keys"`
	Legacy       FileReport `json:"legacy_keys"`
	Formats      []string   `json:"formats"`                 // formats that have a usable key
	KeysetSHA256 string     `json:"keyset_sha256,omitempty"` // changes whenever a key file changes
}

// Usable reports whether at least one link format can be decrypted.
func (r Report) Usable() bool { return len(r.Formats) > 0 }

// Inspect examines the key files in dir, parsing every key. Problems are
// recorded in the report rather than returned.
func Inspect(dir string) Report {
	r := Report{Dir: dir, Formats: []string{}}

	var legacy []string
	r.Legacy = inspectFile(filepath.Join(dir, LegacyFile), &legacy)
	for i, text := range legacy {
		r.Legacy.Keys++
		if _, err := parseKey(text, false); err != nil {
			r.Legacy.Invalid++
		} else if i < len(legacyFormats) {
			r.Formats = append(r.Formats, legacyFormats[i])
		}
	}

	var crypt5 map[string]string
	r.Crypt5 = inspectFile(filepath.Join(dir, Crypt5File), &crypt5)
	for _, text := range crypt5 {
		r.Crypt5.Keys++
		if _, err := parseKey(text, true); err != nil {
			r.Crypt5.Invalid++
		}
	}
	if r.Crypt5.Keys > r.Crypt5.Invalid {
		r.Formats = append(r.Formats, "crypt5")
	}

	h := sha256.New()
	hashed := false
	for _, f := range []struct {
		name string
		rep  FileReport
	}{{Crypt5File, r.Crypt5}, {LegacyFile, r.Legacy}} {
		if f.rep.SHA256 != "" {
			fmt.Fprintf(h, "%s %s\n", f.name, f.rep.SHA256)
			hashed = true
		}
	}
	if hashed {
		r.KeysetSHA256 = hex.EncodeToString(h.Sum(nil))
	}
	return r
}

// inspectFile hashes the file at path and decodes it into table. On a
// decoding error table is left empty.
func inspectFile[T any](path string, table *T) FileReport {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return FileReport{}
	}
	if err != nil {
		return FileReport{Present: true, Error: err.Error()}
	}
	sum := sha256.Sum256(data)
	rep := FileReport{Present: true, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
	if err := json.Unmarshal(data, table); err != nil {
		var empty T
		*table = empty
		rep.Error = err.Error()
	}
	return rep
}
