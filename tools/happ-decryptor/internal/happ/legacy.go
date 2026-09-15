package happ

import (
	"crypto/rsa"
	"slices"
	"strings"
)

// Legacy formats in the order of their keys in legacy_keys.json.
var legacyFormats = []string{"crypt", "crypt2", "crypt3", "crypt4"}

// decryptLegacy handles crypt…crypt4: the payload is base64 of RSA PKCS#1 v1.5
// blocks, each exactly the key size, whose plaintexts are concatenated.
func (k *Keyring) decryptLegacy(format, payload string) (Result, error) {
	if k.legacy == nil {
		return Result{}, fail(ErrNoKeys, "%s is not installed", LegacyFile)
	}
	i := slices.Index(legacyFormats, format)
	if i >= len(k.legacy) || strings.TrimSpace(k.legacy[i]) == "" {
		return Result{}, fail(ErrUnknownKey, "%s has no key for %s; update the Happ keys", LegacyFile, format)
	}
	key, err := parseKey(k.legacy[i], false)
	if err != nil {
		return Result{}, fail(ErrNoKeys, "%s key is unusable: %v", format, err)
	}

	data, err := decodeBase64([]byte(payload))
	if err != nil {
		return Result{}, fail(ErrBadLink, "%s payload is not base64", format)
	}
	size := key.Size()
	if len(data) == 0 || len(data)%size != 0 {
		return Result{}, fail(ErrBadLink, "%s payload is not a whole number of %d-byte blocks", format, size)
	}
	var text []byte
	for len(data) > 0 {
		block, err := rsa.DecryptPKCS1v15(nil, key, data[:size])
		if err != nil {
			return Result{}, fail(ErrCorrupt, "%s block does not match the key", format)
		}
		text = append(text, block...)
		data = data[size:]
	}
	return Result{Format: format, Text: string(text)}, nil
}
