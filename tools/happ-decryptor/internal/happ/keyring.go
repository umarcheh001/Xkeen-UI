package happ

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Keyring holds the key tables loaded from an assets directory. Keys stay
// base64 text until a link needs one: a single run parses a single key.
type Keyring struct {
	crypt5 map[string]string // marker → base64 PKCS#8; nil when the file is absent
	legacy []string          // base64 PKCS#1 in legacyFormats order; nil when the file is absent
}

// LoadKeyring reads the key tables from dir. A missing file is not an error:
// links that need it fail later with ErrNoKeys. A file that exists but cannot
// be read as a table is reported right away.
func LoadKeyring(dir string) (*Keyring, error) {
	k := &Keyring{}
	if err := readTable(filepath.Join(dir, Crypt5File), &k.crypt5); err != nil {
		return nil, err
	}
	if err := readTable(filepath.Join(dir, LegacyFile), &k.legacy); err != nil {
		return nil, err
	}
	return k, nil
}

func readTable(path string, into any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fail(ErrNoKeys, "%v", err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		return fail(ErrNoKeys, "%s: %v", filepath.Base(path), err)
	}
	return nil
}

// parseKey decodes a base64 DER RSA private key, PKCS#8 or PKCS#1.
func parseKey(text string, pkcs8 bool) (*rsa.PrivateKey, error) {
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(text), ""))
	if err != nil {
		return nil, fmt.Errorf("not base64: %v", err)
	}
	if !pkcs8 {
		return x509.ParsePKCS1PrivateKey(der)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("not an RSA key")
	}
	return key, nil
}
