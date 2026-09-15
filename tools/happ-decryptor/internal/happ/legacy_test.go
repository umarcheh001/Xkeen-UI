package happ

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestLegacyFormats(t *testing.T) {
	a := newTestAssets(t)
	k := a.keyring(t)
	// Longer than one RSA block, so several blocks are concatenated.
	url := "https://example.com/legacy?pad=" + strings.Repeat("ab", 200)
	for i, format := range []string{"crypt", "crypt2", "crypt3", "crypt4"} {
		link := sealLegacy(t, format, a.legacy[i], url, base64.StdEncoding)

		got, err := k.Decrypt(link)
		if err != nil {
			t.Fatalf("%s: %v", format, err)
		}
		if want := (Result{Format: format, Text: url}); got != want {
			t.Fatalf("%s: got %+v, want %+v", format, got, want)
		}
	}
}

func TestLegacyURLSafeBase64WithoutPadding(t *testing.T) {
	a := newTestAssets(t)
	link := sealLegacy(t, "crypt4", a.legacy[3], sampleURL, base64.RawURLEncoding)

	got, err := a.keyring(t).Decrypt(link)
	if err != nil || got.Text != sampleURL {
		t.Fatalf("got %q, %v", got.Text, err)
	}
}

func TestLegacyWrongKeyIsCorrupt(t *testing.T) {
	a := newTestAssets(t)
	link := sealLegacy(t, "crypt2", a.legacy[0], sampleURL, base64.StdEncoding)

	_, err := a.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
}

func TestLegacyPartialBlockIsBadLink(t *testing.T) {
	a := newTestAssets(t)
	link := sealLegacy(t, "crypt4", a.legacy[3], sampleURL, base64.StdEncoding)
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(link, "happ://crypt4/"))
	link = "happ://crypt4/" + base64.StdEncoding.EncodeToString(raw[:len(raw)-5])

	_, err := a.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrBadLink) {
		t.Fatalf("err = %v, want ErrBadLink", err)
	}
}

func TestLegacyKeyMissingFromTable(t *testing.T) {
	a := newTestAssets(t)
	short := testAssets{dir: t.TempDir(), legacy: a.legacy[:2]}
	short.writeLegacy(t)
	link := sealLegacy(t, "crypt4", a.legacy[3], sampleURL, base64.StdEncoding)

	_, err := short.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
}

func TestLegacyWithoutKeyFile(t *testing.T) {
	a := newTestAssets(t)
	crypt5Only := testAssets{dir: t.TempDir(), crypt5: a.crypt5}
	crypt5Only.writeCrypt5(t)
	link := sealLegacy(t, "crypt", a.legacy[0], sampleURL, base64.StdEncoding)

	_, err := crypt5Only.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrNoKeys) {
		t.Fatalf("err = %v, want ErrNoKeys", err)
	}
}
