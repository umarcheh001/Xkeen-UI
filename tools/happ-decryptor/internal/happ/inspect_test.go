package happ

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fileSHA(t *testing.T, path string) (int64, string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return int64(len(data)), hex.EncodeToString(sum[:])
}

func TestInspectHealthyAssets(t *testing.T) {
	a := newTestAssets(t)
	r := Inspect(a.dir)

	size, sum := fileSHA(t, filepath.Join(a.dir, Crypt5File))
	if want := (FileReport{Present: true, Size: size, SHA256: sum, Keys: 2}); r.Crypt5 != want {
		t.Errorf("Crypt5 = %+v, want %+v", r.Crypt5, want)
	}
	size, sum = fileSHA(t, filepath.Join(a.dir, LegacyFile))
	if want := (FileReport{Present: true, Size: size, SHA256: sum, Keys: 4}); r.Legacy != want {
		t.Errorf("Legacy = %+v, want %+v", r.Legacy, want)
	}
	if want := []string{"crypt", "crypt2", "crypt3", "crypt4", "crypt5"}; !reflect.DeepEqual(r.Formats, want) {
		t.Errorf("Formats = %v, want %v", r.Formats, want)
	}
	if len(r.KeysetSHA256) != 64 || !r.Usable() {
		t.Errorf("KeysetSHA256 = %q, Usable = %v", r.KeysetSHA256, r.Usable())
	}
}

func TestInspectKeysetHashFollowsFiles(t *testing.T) {
	a := newTestAssets(t)
	before := Inspect(a.dir).KeysetSHA256
	shorter := testAssets{dir: a.dir, legacy: a.legacy[:3]}
	shorter.writeLegacy(t)

	if after := Inspect(a.dir).KeysetSHA256; after == before {
		t.Fatal("keyset hash did not change when a key file changed")
	}
}

func TestInspectCountsUnusableKeys(t *testing.T) {
	keys := testKeys(t)
	dir := t.TempDir()
	der, _ := x509.MarshalPKCS8PrivateKey(keys[0])
	writeJSON(t, filepath.Join(dir, Crypt5File), map[string]string{
		markerA:    base64.StdEncoding.EncodeToString(der),
		"BadKey00": base64.StdEncoding.EncodeToString([]byte("not a key")),
	})
	writeJSON(t, filepath.Join(dir, LegacyFile), []string{
		"",
		base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PrivateKey(keys[1])),
		"garbage!!",
	})

	r := Inspect(dir)
	if r.Crypt5.Keys != 2 || r.Crypt5.Invalid != 1 {
		t.Errorf("Crypt5 = %+v, want 2 keys with 1 invalid", r.Crypt5)
	}
	if r.Legacy.Keys != 3 || r.Legacy.Invalid != 2 {
		t.Errorf("Legacy = %+v, want 3 keys with 2 invalid", r.Legacy)
	}
	if want := []string{"crypt2", "crypt5"}; !reflect.DeepEqual(r.Formats, want) {
		t.Errorf("Formats = %v, want %v", r.Formats, want)
	}
}

func TestInspectEmptyDirectory(t *testing.T) {
	r := Inspect(t.TempDir())
	if r.Crypt5.Present || r.Legacy.Present || r.Usable() || r.KeysetSHA256 != "" {
		t.Fatalf("report for empty directory: %+v", r)
	}
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), `"formats":[]`) {
		t.Fatalf("formats must encode as an empty list: %s", b)
	}
}

func TestInspectBrokenFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, Crypt5File), []byte("{oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := Inspect(dir)
	if !r.Crypt5.Present || r.Crypt5.Error == "" || r.Crypt5.Keys != 0 || r.Usable() {
		t.Fatalf("Crypt5 = %+v, Usable = %v", r.Crypt5, r.Usable())
	}
}
