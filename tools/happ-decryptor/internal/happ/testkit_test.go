package happ

// Test kit: produces links in Happ's formats with keys generated on the fly,
// so the tests never need the real Happ key files.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"golang.org/x/crypto/chacha20poly1305"
)

var (
	testRSAOnce sync.Once
	testRSA     []*rsa.PrivateKey
)

// testKeys returns four RSA keys shared by all tests; 2048 bits keeps generation fast.
func testKeys(t *testing.T) []*rsa.PrivateKey {
	t.Helper()
	testRSAOnce.Do(func() {
		for i := 0; i < 4; i++ {
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				panic(err)
			}
			testRSA = append(testRSA, key)
		}
	})
	return testRSA
}

const (
	markerA = "vdAbCdEf"
	markerB = "Zx09Qw12"
)

type testAssets struct {
	dir    string
	crypt5 map[string]*rsa.PrivateKey
	legacy []*rsa.PrivateKey
}

// newTestAssets writes both key files: markerA → key 0, markerB → key 1,
// legacy keys crypt…crypt4 → keys 0…3.
func newTestAssets(t *testing.T) testAssets {
	t.Helper()
	keys := testKeys(t)
	a := testAssets{
		dir:    t.TempDir(),
		crypt5: map[string]*rsa.PrivateKey{markerA: keys[0], markerB: keys[1]},
		legacy: keys,
	}
	a.writeCrypt5(t)
	a.writeLegacy(t)
	return a
}

func (a testAssets) writeCrypt5(t *testing.T) {
	t.Helper()
	table := map[string]string{}
	for marker, key := range a.crypt5 {
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		table[marker] = base64.StdEncoding.EncodeToString(der)
	}
	writeJSON(t, filepath.Join(a.dir, Crypt5File), table)
}

func (a testAssets) writeLegacy(t *testing.T) {
	t.Helper()
	list := []string{}
	for _, key := range a.legacy {
		list = append(list, base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PrivateKey(key)))
	}
	writeJSON(t, filepath.Join(a.dir, LegacyFile), list)
}

func (a testAssets) keyring(t *testing.T) *Keyring {
	t.Helper()
	k, err := LoadKeyring(a.dir)
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	return k
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// crypt5Parts are the pieces of a crypt5 body before the marker is wrapped
// around it and the quads are swapped. Tests may damage any of them.
type crypt5Parts struct {
	Header  string // nonce, plus tag and salt in the salted layout
	Length  string // decimal length of EncURL
	Sep     string // one non-digit separator
	EncURL  string // base64 of the ChaCha20-Poly1305 ciphertext
	Wrapped string // base64 of the RSA-encrypted ChaCha key
}

type crypt5Seal struct {
	URL    string
	Marker string
	Key    *rsa.PrivateKey
	Salted bool
	Tag    string // salted layout only; defaults to "Wr"
	Damage func(p *crypt5Parts)
}

func (s crypt5Seal) link(t *testing.T) string {
	t.Helper()
	const nonce = "n0Nce/Test+2"
	const salt = "s4LtSalt"
	tag := s.Tag
	if tag == "" {
		tag = "Wr"
	}

	secret := make([]byte, chacha20poly1305.KeySize)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	aead, err := chacha20poly1305.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	inner := swapPairs([]byte(base64.StdEncoding.EncodeToString([]byte(s.URL))))
	sealed := aead.Seal(nil, []byte(nonce), inner, nil)

	p := crypt5Parts{Header: nonce, Sep: "K", EncURL: base64.StdEncoding.EncodeToString(sealed)}
	sent := append([]byte(nil), secret...)
	if s.Salted {
		p.Header += tag + salt
		for i := range sent {
			sent[i] ^= salt[i%len(salt)]
		}
	}
	wrapped, err := rsa.EncryptPKCS1v15(rand.Reader, &s.Key.PublicKey, swapPairs([]byte(base64.StdEncoding.EncodeToString(sent))))
	if err != nil {
		t.Fatal(err)
	}
	p.Wrapped = base64.StdEncoding.EncodeToString(wrapped)
	p.Length = strconv.Itoa(len(p.EncURL))
	if s.Damage != nil {
		s.Damage(&p)
	}

	body := p.Header + p.Length + p.Sep + p.EncURL + p.Wrapped
	return "happ://crypt5/" + string(swapQuads([]byte(s.Marker[:4]+body+s.Marker[4:])))
}

// sealLegacy encrypts url the way crypt…crypt4 links carry it: PKCS#1 v1.5
// blocks of the key size, concatenated and base64-encoded.
func sealLegacy(t *testing.T, format string, key *rsa.PrivateKey, url string, enc *base64.Encoding) string {
	t.Helper()
	var out []byte
	data := []byte(url)
	for len(data) > 0 {
		n := min(key.Size()-11, len(data))
		block, err := rsa.EncryptPKCS1v15(rand.Reader, &key.PublicKey, data[:n])
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, block...)
		data = data[n:]
	}
	return "happ://" + format + "/" + enc.EncodeToString(out)
}
