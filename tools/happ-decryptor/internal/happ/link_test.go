package happ

import (
	"encoding/base64"
	"errors"
	"testing"
)

func TestSwapPairs(t *testing.T) {
	if got := string(swapPairs([]byte("abcde"))); got != "badce" {
		t.Fatalf("got %q", got)
	}
}

func TestSwapQuads(t *testing.T) {
	if got := string(swapQuads([]byte("ABCDEFGHij"))); got != "CDABGHEFij" {
		t.Fatalf("got %q", got)
	}
}

func TestDecryptToleratesSpaceAndSchemeCase(t *testing.T) {
	a := newTestAssets(t)
	link := sealLegacy(t, "crypt3", a.legacy[2], sampleURL, base64.StdEncoding)
	link = "  HAPP://" + link[len("happ://"):] + "\r\n"

	got, err := a.keyring(t).Decrypt(link)
	if err != nil || got.Text != sampleURL {
		t.Fatalf("got %q, %v", got.Text, err)
	}
}

func TestDecryptRejectsOtherLinks(t *testing.T) {
	a := newTestAssets(t)
	for _, link := range []string{"", "happ://crypt9/abc", "happ://add/abc", "https://example.com/sub", "crypt4"} {
		if _, err := a.keyring(t).Decrypt(link); !errors.Is(err, ErrBadLink) {
			t.Errorf("%q: err = %v, want ErrBadLink", link, err)
		}
	}
}

func TestLoadKeyringRejectsBrokenFile(t *testing.T) {
	a := newTestAssets(t)
	writeJSON(t, a.dir+"/"+Crypt5File, []int{1, 2})

	if _, err := LoadKeyring(a.dir); err == nil {
		t.Fatal("LoadKeyring accepted a crypt5 table that is not an object")
	}
}
