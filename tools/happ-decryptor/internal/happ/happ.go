// Package happ decrypts Happ subscription deep links (happ://crypt…/).
//
// The package holds no Happ keys: they are read at run time from a directory
// with crypt5-keys.json (marker → PKCS#8 RSA key) and legacy_keys.json
// (PKCS#1 RSA keys for crypt, crypt2, crypt3 and crypt4, in that order).
package happ

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Key file names inside the assets directory.
const (
	Crypt5File = "crypt5-keys.json"
	LegacyFile = "legacy_keys.json"
)

// Errors returned by Decrypt; test with errors.Is. Their text doubles as a
// stable machine-readable code for the command-line tool.
//
// ErrBadLink and ErrCorrupt both mean the link itself is damaged: the first
// is reported when its structure is wrong, the second when the structure is
// fine but the cryptography does not check out.
var (
	ErrBadLink    = errors.New("bad_link")
	ErrUnknownKey = errors.New("unknown_key")
	ErrCorrupt    = errors.New("corrupt")
	ErrNoKeys     = errors.New("no_keys")
)

// Result is a decrypted link.
type Result struct {
	Format string // crypt, crypt2, crypt3, crypt4 or crypt5
	Layout string // crypt5 only: "salted" or "plain"
	Text   string // usually the subscription URL
}

const scheme = "happ://"

// Decrypt decrypts a happ://crypt…/ link. Surrounding whitespace and the
// letter case of the scheme are ignored.
func (k *Keyring) Decrypt(link string) (Result, error) {
	link = strings.TrimSpace(link)
	if len(link) < len(scheme) || !strings.EqualFold(link[:len(scheme)], scheme) {
		return Result{}, fmt.Errorf("%w: expected a %s link", ErrBadLink, scheme)
	}
	format, payload, ok := strings.Cut(link[len(scheme):], "/")
	if !ok {
		return Result{}, fmt.Errorf("%w: link has no payload", ErrBadLink)
	}
	if format == "crypt5" {
		return k.decryptCrypt5(payload)
	}
	if slices.Contains(legacyFormats, format) {
		return k.decryptLegacy(format, payload)
	}
	return Result{}, fmt.Errorf("%w: unsupported link type %q", ErrBadLink, format)
}

func fail(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: %s", kind, fmt.Sprintf(format, args...))
}
