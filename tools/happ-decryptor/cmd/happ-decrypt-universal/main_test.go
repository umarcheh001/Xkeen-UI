package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const testURL = "https://example.com/sub/cli"

var (
	cliKeyOnce sync.Once
	cliKey     *rsa.PrivateKey
)

// fixture writes an assets directory whose four legacy slots share one key
// and returns it with a crypt4 link for testURL.
func fixture(t *testing.T) (dir, link string) {
	t.Helper()
	cliKeyOnce.Do(func() {
		var err error
		if cliKey, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
			panic(err)
		}
	})
	dir = t.TempDir()
	keyText := base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PrivateKey(cliKey))
	writeFile(t, filepath.Join(dir, "legacy_keys.json"), `["`+keyText+`","`+keyText+`","`+keyText+`","`+keyText+`"]`)
	writeFile(t, filepath.Join(dir, "crypt5-keys.json"), `{}`)

	block, err := rsa.EncryptPKCS1v15(rand.Reader, &cliKey.PublicKey, []byte(testURL))
	if err != nil {
		t.Fatal(err)
	}
	return dir, "happ://crypt4/" + base64.StdEncoding.EncodeToString(block)
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

type outcome struct {
	code           int
	stdout, stderr string
}

func invoke(stdin io.Reader, args ...string) outcome {
	var out, errOut bytes.Buffer
	code := run(args, stdin, &out, &errOut)
	return outcome{code, out.String(), errOut.String()}
}

func TestPrintsDecryptedURL(t *testing.T) {
	dir, link := fixture(t)
	got := invoke(nil, "-assets", dir, link)
	if got != (outcome{0, testURL + "\n", ""}) {
		t.Fatalf("got %+v", got)
	}
}

func TestReadsLinkFromStdin(t *testing.T) {
	dir, link := fixture(t)
	got := invoke(strings.NewReader(link+"\n"), "-assets", dir)
	if got.code != 0 || got.stdout != testURL+"\n" {
		t.Fatalf("got %+v", got)
	}
}

func TestReadsLinkFromFile(t *testing.T) {
	dir, link := fixture(t)
	path := filepath.Join(t.TempDir(), "link.txt")
	writeFile(t, path, link+"\r\n")
	got := invoke(nil, "-assets", dir, "@"+path)
	if got.code != 0 || got.stdout != testURL+"\n" {
		t.Fatalf("got %+v", got)
	}
}

func TestAssetsFromEnvironment(t *testing.T) {
	dir, link := fixture(t)
	t.Setenv("HAPP_DECRYPT_ASSETS", dir)
	if got := invoke(nil, link); got.code != 0 || got.stdout != testURL+"\n" {
		t.Fatalf("got %+v", got)
	}
}

func TestJSONSuccess(t *testing.T) {
	dir, link := fixture(t)
	got := invoke(nil, "-assets", dir, "-json", link)
	var body map[string]any
	if err := json.Unmarshal([]byte(got.stdout), &body); err != nil || got.code != 0 {
		t.Fatalf("got %+v (%v)", got, err)
	}
	if body["ok"] != true || body["format"] != "crypt4" || body["url"] != testURL {
		t.Fatalf("body = %v", body)
	}
	if _, has := body["layout"]; has {
		t.Fatalf("legacy result must not carry a layout: %v", body)
	}
}

func TestFailuresHaveDistinctExitCodes(t *testing.T) {
	dir, link := fixture(t)
	cases := []struct {
		name, assets, link, code string
		exit                     int
	}{
		{"damaged link", dir, "happ://crypt4/!!!", "bad_link", 1},
		{"not a happ link", dir, "https://example.com", "bad_link", 1},
		{"no key files", t.TempDir(), link, "no_keys", 3},
		{"unknown crypt5 marker", dir, "happ://crypt5/" + strings.Repeat("A", 40), "unknown_key", 4},
	}
	for _, c := range cases {
		got := invoke(nil, "-assets", c.assets, c.link)
		if got.code != c.exit || got.stdout != "" || !strings.Contains(got.stderr, c.code+":") {
			t.Errorf("%s: got %+v, want exit %d with %q", c.name, got, c.exit, c.code)
		}
	}
}

func TestJSONFailure(t *testing.T) {
	dir, _ := fixture(t)
	got := invoke(nil, "-json", "-assets", dir, "happ://crypt5/"+strings.Repeat("A", 40))
	var body map[string]any
	if err := json.Unmarshal([]byte(got.stdout), &body); err != nil || got.code != 4 {
		t.Fatalf("got %+v (%v)", got, err)
	}
	if body["ok"] != false || body["error"] != "unknown_key" || body["message"] == "" {
		t.Fatalf("body = %v", body)
	}
}

func TestSelftest(t *testing.T) {
	dir, _ := fixture(t)
	got := invoke(nil, "-selftest", "-assets", dir)
	var body struct {
		Version string   `json:"version"`
		Dir     string   `json:"assets_dir"`
		Formats []string `json:"formats"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &body); err != nil || got.code != 0 {
		t.Fatalf("got %+v (%v)", got, err)
	}
	if body.Version == "" || body.Dir != dir || strings.Join(body.Formats, ",") != "crypt,crypt2,crypt3,crypt4" {
		t.Fatalf("body = %+v", body)
	}

	if empty := invoke(nil, "-selftest", "-assets", t.TempDir()); empty.code != 3 {
		t.Fatalf("selftest on empty assets: got %+v, want exit 3", empty)
	}
}

func TestDefaultAssetsDirSitsNextToExecutable(t *testing.T) {
	t.Setenv("HAPP_DECRYPT_ASSETS", "")
	got := invoke(nil, "-selftest")
	var body struct {
		Dir string `json:"assets_dir"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &body); err != nil {
		t.Fatalf("got %+v (%v)", got, err)
	}
	exe, _ := os.Executable()
	if exe, err := filepath.EvalSymlinks(exe); err == nil && body.Dir != exe+".assets" {
		t.Fatalf("assets_dir = %q, want %q", body.Dir, exe+".assets")
	}
}

func TestVersion(t *testing.T) {
	got := invoke(nil, "-version")
	if got.code != 0 || !strings.HasPrefix(got.stdout, "happ-decrypt-universal dev") {
		t.Fatalf("got %+v", got)
	}
}

func TestMissingLinkIsUsageError(t *testing.T) {
	got := invoke(nil)
	if got.code != 2 || !strings.Contains(got.stderr, "usage") {
		t.Fatalf("got %+v", got)
	}
	if two := invoke(nil, "a", "b"); two.code != 2 {
		t.Fatalf("two links: got %+v", two)
	}
}
