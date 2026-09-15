package happ

import (
	"crypto/rsa"
	"strconv"

	"golang.org/x/crypto/chacha20poly1305"
)

// A crypt5 payload is ASCII. After swapQuads it reads
//
//	marker[0:4] | body | marker[4:8]
//
// where the marker selects the RSA key and the body is
//
//	plain:  nonce(12) |                    length | sep | sealedURL | wrappedKey
//	salted: nonce(12) | tag(2) | salt(8) | length | sep | sealedURL | wrappedKey
//
//	sealedURL  = base64(ChaCha20-Poly1305(contentKey, nonce, swapPairs(base64(url))))
//	wrappedKey = base64(RSA-PKCS1v15(swapPairs(base64(contentKey XOR salt))))
//
// length is the decimal size of sealedURL; the plain layout has no XOR.
const (
	markerHalf = 4
	nonceSize  = 12
	tagSize    = 2
	saltSize   = 8
)

type envelope struct {
	nonce, salt, sealedURL, wrappedKey []byte
}

func (k *Keyring) decryptCrypt5(payload string) (Result, error) {
	if k.crypt5 == nil {
		return Result{}, fail(ErrNoKeys, "%s is not installed", Crypt5File)
	}
	data := swapQuads([]byte(payload))
	if len(data) < 2*markerHalf {
		return Result{}, fail(ErrBadLink, "crypt5 payload is too short")
	}
	marker := string(data[:markerHalf]) + string(data[len(data)-markerHalf:])
	keyText, ok := k.crypt5[marker]
	if !ok {
		return Result{}, fail(ErrUnknownKey, "crypt5 marker %q is not in %s; update the Happ keys", marker, Crypt5File)
	}
	key, err := parseKey(keyText, true)
	if err != nil {
		return Result{}, fail(ErrNoKeys, "crypt5 key for marker %q is unusable: %v", marker, err)
	}
	body := data[markerHalf : len(data)-markerHalf]

	// Only the plain layout has a digit (the length field) right after the
	// nonce. The guess decides which error to report; both layouts are tried.
	order := []bool{true, false}
	if len(body) > nonceSize && isDigit(body[nonceSize]) {
		order = []bool{false, true}
	}
	var firstErr error
	for _, salted := range order {
		text, err := openCrypt5(body, salted, key)
		if err == nil {
			layout := "plain"
			if salted {
				layout = "salted"
			}
			return Result{Format: "crypt5", Layout: layout, Text: text}, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return Result{}, firstErr
}

func splitEnvelope(body []byte, salted bool) (envelope, error) {
	var env envelope
	pos := nonceSize
	if salted {
		pos += tagSize + saltSize
	}
	if len(body) <= pos {
		return env, fail(ErrBadLink, "crypt5 header is too short")
	}
	env.nonce = body[:nonceSize]
	if salted {
		env.salt = body[nonceSize+tagSize : pos]
	}

	end := pos
	for end < len(body) && isDigit(body[end]) {
		end++
	}
	if end == pos {
		return env, fail(ErrBadLink, "crypt5 length field is missing")
	}
	size, err := strconv.Atoi(string(body[pos:end]))
	rest := body[end:] // separator, sealed URL, wrapped key
	if err != nil || size > len(rest)-2 {
		return env, fail(ErrBadLink, "crypt5 body is truncated")
	}
	env.sealedURL = rest[1 : 1+size]
	env.wrappedKey = rest[1+size:]
	return env, nil
}

func openCrypt5(body []byte, salted bool, key *rsa.PrivateKey) (string, error) {
	env, err := splitEnvelope(body, salted)
	if err != nil {
		return "", err
	}
	wrapped, err := decodeBase64(env.wrappedKey)
	if err != nil {
		return "", fail(ErrBadLink, "crypt5 key block is not base64")
	}
	sealed, err := decodeBase64(env.sealedURL)
	if err != nil {
		return "", fail(ErrBadLink, "crypt5 URL block is not base64")
	}

	unwrapped, err := rsa.DecryptPKCS1v15(nil, key, wrapped)
	if err != nil {
		return "", fail(ErrCorrupt, "crypt5 key block does not match the marker's key")
	}
	contentKey, err := decodeBase64(swapPairs(unwrapped))
	if err != nil || len(contentKey) != chacha20poly1305.KeySize {
		return "", fail(ErrCorrupt, "crypt5 content key is malformed")
	}
	for i := range contentKey {
		if len(env.salt) > 0 {
			contentKey[i] ^= env.salt[i%len(env.salt)]
		}
	}

	aead, err := chacha20poly1305.New(contentKey)
	if err != nil {
		return "", fail(ErrCorrupt, "crypt5 content key: %v", err)
	}
	inner, err := aead.Open(nil, env.nonce, sealed, nil)
	if err != nil {
		return "", fail(ErrCorrupt, "crypt5 authentication failed")
	}
	text, err := decodeBase64(swapPairs(inner))
	if err != nil {
		return "", fail(ErrCorrupt, "crypt5 plaintext is not base64")
	}
	return string(text), nil
}

func isDigit(c byte) bool { return '0' <= c && c <= '9' }
