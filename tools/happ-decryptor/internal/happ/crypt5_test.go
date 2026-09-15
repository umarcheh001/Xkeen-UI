package happ

import (
	"errors"
	"strings"
	"testing"
)

const sampleURL = "https://example.com/sub/7f3a?token=abc"

func TestCrypt5SaltedLayout(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerA], Salted: true}.link(t)

	got, err := a.keyring(t).Decrypt(link)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	want := Result{Format: "crypt5", Layout: "salted", Text: sampleURL}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestCrypt5PlainLayout(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: markerB, Key: a.crypt5[markerB]}.link(t)

	got, err := a.keyring(t).Decrypt(link)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	want := Result{Format: "crypt5", Layout: "plain", Text: sampleURL}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// The quad swap leaves a tail of up to three bytes untouched; every tail length must work.
func TestCrypt5EveryPayloadLengthResidue(t *testing.T) {
	a := newTestAssets(t)
	k := a.keyring(t)
	seen := map[int]bool{}
	for extra := 0; extra < 12; extra++ {
		for _, salted := range []bool{false, true} {
			url := sampleURL + strings.Repeat("x", extra)
			link := crypt5Seal{URL: url, Marker: markerA, Key: a.crypt5[markerA], Salted: salted}.link(t)
			seen[len(strings.TrimPrefix(link, "happ://crypt5/"))%4] = true

			got, err := k.Decrypt(link)
			if err != nil || got.Text != url {
				t.Fatalf("extra=%d salted=%v: got %q, %v", extra, salted, got.Text, err)
			}
		}
	}
	if len(seen) != 4 {
		t.Fatalf("payload length residues covered: %v, want all four", seen)
	}
}

func TestCrypt5NonASCIIAndLongURL(t *testing.T) {
	a := newTestAssets(t)
	url := "https://пример.рф/подписка?имя=Тест&pad=" + strings.Repeat("0123456789", 60)
	link := crypt5Seal{URL: url, Marker: markerA, Key: a.crypt5[markerA], Salted: true}.link(t)

	got, err := a.keyring(t).Decrypt(link)
	if err != nil || got.Text != url {
		t.Fatalf("got %q, %v", got.Text, err)
	}
}

// Happ itself rejects a salted tag that starts with a digit, but reading it is harmless.
func TestCrypt5SaltedTagStartingWithDigit(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerA], Salted: true, Tag: "9r"}.link(t)

	got, err := a.keyring(t).Decrypt(link)
	if err != nil || got.Text != sampleURL || got.Layout != "salted" {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestCrypt5UnknownMarker(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: "NoSuchMk", Key: a.crypt5[markerA], Salted: true}.link(t)

	_, err := a.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}
	if !strings.Contains(err.Error(), "NoSuchMk") {
		t.Fatalf("error %q does not name the marker", err)
	}
}

func TestCrypt5WrongKeyForMarkerIsCorrupt(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerB], Salted: true}.link(t)

	_, err := a.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("err = %v, want ErrCorrupt", err)
	}
}

func TestCrypt5DamagedCiphertextIsCorrupt(t *testing.T) {
	a := newTestAssets(t)
	for _, salted := range []bool{false, true} {
		link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerA], Salted: salted,
			Damage: func(p *crypt5Parts) {
				b := []byte(p.EncURL)
				if b[3] == 'A' {
					b[3] = 'B'
				} else {
					b[3] = 'A'
				}
				p.EncURL = string(b)
			}}.link(t)

		_, err := a.keyring(t).Decrypt(link)
		if !errors.Is(err, ErrCorrupt) {
			t.Fatalf("salted=%v: err = %v, want ErrCorrupt", salted, err)
		}
	}
}

func TestCrypt5MalformedBodyIsBadLink(t *testing.T) {
	a := newTestAssets(t)
	k := a.keyring(t)
	cases := map[string]func(p *crypt5Parts){
		"missing length":   func(p *crypt5Parts) { p.Length = "" },
		"length too large": func(p *crypt5Parts) { p.Length = "99999" },
		"no rsa block":     func(p *crypt5Parts) { p.Wrapped = "" },
	}
	// Salted layout: a plain body without its length field is ambiguous and
	// may just as well be read as a salted one that fails its checksum.
	for name, damage := range cases {
		link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerA], Salted: true, Damage: damage}.link(t)
		if _, err := k.Decrypt(link); !errors.Is(err, ErrBadLink) {
			t.Errorf("%s: err = %v, want ErrBadLink", name, err)
		}
	}
}

func TestCrypt5TooShortPayloadIsBadLink(t *testing.T) {
	a := newTestAssets(t)
	for _, link := range []string{"happ://crypt5/", "happ://crypt5/abcdefg"} {
		if _, err := a.keyring(t).Decrypt(link); !errors.Is(err, ErrBadLink) {
			t.Errorf("%q: err = %v, want ErrBadLink", link, err)
		}
	}
}

func TestCrypt5WithoutKeyFile(t *testing.T) {
	a := newTestAssets(t)
	link := crypt5Seal{URL: sampleURL, Marker: markerA, Key: a.crypt5[markerA], Salted: true}.link(t)
	legacyOnly := testAssets{dir: t.TempDir(), legacy: a.legacy}
	legacyOnly.writeLegacy(t)

	_, err := legacyOnly.keyring(t).Decrypt(link)
	if !errors.Is(err, ErrNoKeys) {
		t.Fatalf("err = %v, want ErrNoKeys", err)
	}
}
