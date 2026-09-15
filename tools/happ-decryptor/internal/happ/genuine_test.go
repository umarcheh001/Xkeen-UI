package happ

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestGenuineHappFiles checks the real Happ key files and real links, which
// never enter the repository. Point it at local copies:
//
//	HAPP_DECRYPT_TEST_ASSETS=<dir with crypt5-keys.json and legacy_keys.json>
//	HAPP_DECRYPT_TEST_CASES=<cases.json>[<path list separator><more.json>]
//
// A cases file is a JSON list of {"id", "link", "expect", "expect_ok"}.
func TestGenuineHappFiles(t *testing.T) {
	dir := os.Getenv("HAPP_DECRYPT_TEST_ASSETS")
	cases := os.Getenv("HAPP_DECRYPT_TEST_CASES")
	if dir == "" || cases == "" {
		t.Skip("set HAPP_DECRYPT_TEST_ASSETS and HAPP_DECRYPT_TEST_CASES to check genuine Happ files")
	}
	k, err := LoadKeyring(dir)
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	for _, path := range filepath.SplitList(cases) {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var list []struct {
			ID       string `json:"id"`
			Link     string `json:"link"`
			Expect   string `json:"expect"`
			ExpectOK bool   `json:"expect_ok"`
		}
		if err := json.Unmarshal(data, &list); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(list) == 0 {
			t.Fatalf("%s: no cases", path)
		}
		for _, c := range list {
			t.Run(c.ID, func(t *testing.T) {
				got, err := k.Decrypt(c.Link)
				switch {
				case c.ExpectOK && err != nil:
					t.Fatalf("Decrypt: %v", err)
				case c.ExpectOK && got.Text != c.Expect:
					t.Fatalf("decrypted text differs from the expected one (%d vs %d bytes)", len(got.Text), len(c.Expect))
				case !c.ExpectOK && err == nil:
					t.Fatal("damaged link was accepted")
				}
			})
		}
	}
}
