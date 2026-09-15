package happ

import (
	"encoding/base64"
	"strings"
)

// swapPairs returns a copy with every two neighbouring bytes exchanged
// ("abcde" → "badce"). It is its own inverse.
func swapPairs(b []byte) []byte {
	out := append([]byte(nil), b...)
	for i := 1; i < len(out); i += 2 {
		out[i-1], out[i] = out[i], out[i-1]
	}
	return out
}

// swapQuads returns a copy with the halves of every complete four-byte group
// exchanged ("ABCDEFGHij" → "CDABGHEFij"). It is its own inverse.
func swapQuads(b []byte) []byte {
	out := append([]byte(nil), b...)
	for i := 3; i < len(out); i += 4 {
		g := out[i-3 : i+1]
		g[0], g[1], g[2], g[3] = g[2], g[3], g[0], g[1]
	}
	return out
}

var base64Loose = strings.NewReplacer("-", "+", "_", "/", "=", "", " ", "", "\t", "", "\r", "", "\n", "")

// decodeBase64 accepts standard and URL-safe alphabets, with or without
// padding and with stray whitespace — Happ providers are not consistent.
func decodeBase64(b []byte) ([]byte, error) {
	return base64.RawStdEncoding.DecodeString(base64Loose.Replace(string(b)))
}
