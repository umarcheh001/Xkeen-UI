from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM_REPO = "https://github.com/LeeeeT/happ-decryptor.git"
DEFAULT_SOURCE_DIR = REPO_ROOT / ".tmp" / "leeeet-happ-decryptor"
DEFAULT_OUTPUT = REPO_ROOT / "xkeen-ui" / "bin" / "happ-decrypt-universal"
CRYPT5_KEYS_REL = Path("public/data/expanded_rsa_keys.json")
DECRYPT_JS_REL = Path("src/decrypt.js")


GO_MAIN_TEMPLATE = r'''
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"golang.org/x/crypto/chacha20poly1305"
)

const legacyKeysJSON = __LEGACY_KEYS_JSON__
const crypt5KeysJSON = __CRYPT5_KEYS_JSON__

func decodeBase64Any(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	candidates := []string{value}
	if strings.ContainsAny(value, "-_") {
		candidates = append(candidates, strings.NewReplacer("-", "+", "_", "/").Replace(value))
	}
	for _, candidate := range candidates {
		for _, enc := range []*base64.Encoding{
			base64.StdEncoding,
			base64.URLEncoding,
			base64.RawStdEncoding,
			base64.RawURLEncoding,
		} {
			if out, err := enc.DecodeString(candidate); err == nil {
				return out, nil
			}
		}
		padded := candidate + strings.Repeat("=", (4-len(candidate)%4)%4)
		if out, err := base64.StdEncoding.DecodeString(padded); err == nil {
			return out, nil
		}
		if out, err := base64.URLEncoding.DecodeString(padded); err == nil {
			return out, nil
		}
	}
	return nil, errors.New("invalid base64")
}

func swapPairs(value string) string {
	buf := []byte(value)
	for i := 0; i+1 < len(buf); i += 2 {
		buf[i], buf[i+1] = buf[i+1], buf[i]
	}
	return string(buf)
}

func blockPairSwap(value string) string {
	buf := []byte(value)
	out := make([]byte, 0, len(buf))
	full := len(buf) / 4 * 4
	for offset := 0; offset < full; offset += 4 {
		out = append(out, buf[offset+2], buf[offset+3], buf[offset], buf[offset+1])
	}
	out = append(out, buf[full:]...)
	return string(out)
}

func parsePKCS1PrivateKey(encoded string) (*rsa.PrivateKey, error) {
	der, err := decodeBase64Any(encoded)
	if err != nil {
		return nil, err
	}
	return x509.ParsePKCS1PrivateKey(der)
}

func parsePKCS8PrivateKey(encoded string) (*rsa.PrivateKey, error) {
	der, err := decodeBase64Any(encoded)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not RSA")
	}
	return rsaKey, nil
}

func decryptRSA(encodedCiphertext string, key *rsa.PrivateKey) ([]byte, error) {
	ciphertext, err := decodeBase64Any(encodedCiphertext)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) <= key.Size() {
		return rsa.DecryptPKCS1v15(rand.Reader, key, ciphertext)
	}
	var out []byte
	for offset := 0; offset < len(ciphertext); offset += key.Size() {
		end := offset + key.Size()
		if end > len(ciphertext) {
			return nil, errors.New("truncated RSA block")
		}
		block, err := rsa.DecryptPKCS1v15(rand.Reader, key, ciphertext[offset:end])
		if err != nil {
			return nil, err
		}
		out = append(out, block...)
	}
	return out, nil
}

func decryptLegacy(mode int, payload string) (string, error) {
	var keys []string
	if err := json.Unmarshal([]byte(legacyKeysJSON), &keys); err != nil {
		return "", err
	}
	if mode < 0 || mode >= len(keys) {
		return "", errors.New("unknown legacy mode")
	}
	key, err := parsePKCS1PrivateKey(keys[mode])
	if err != nil {
		return "", err
	}
	plain, err := decryptRSA(payload, key)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decryptCrypt5(payload string) (string, error) {
	shuffled := blockPairSwap(payload)
	if len(shuffled) < 8 {
		return "", errors.New("crypt5 payload too short")
	}
	marker := shuffled[:4] + shuffled[len(shuffled)-4:]
	body := shuffled[4 : len(shuffled)-4]
	if len(body) < 13 {
		return "", errors.New("crypt5 body too short")
	}
	nonce := []byte(body[:12])
	rest := body[12:]
	digitCount := 0
	for digitCount < len(rest) && rest[digitCount] >= '0' && rest[digitCount] <= '9' {
		digitCount++
	}
	if digitCount == 0 {
		return "", errors.New("crypt5 segment length missing")
	}
	segmentLen, err := strconv.Atoi(rest[:digitCount])
	if err != nil {
		return "", err
	}
	packed := rest[digitCount:]
	if len(packed) < 1+segmentLen {
		return "", errors.New("crypt5 segment truncated")
	}
	urlB64 := packed[1 : 1+segmentLen]
	rsaCiphertext := packed[1+segmentLen:]

	var keys map[string]string
	if err := json.Unmarshal([]byte(crypt5KeysJSON), &keys); err != nil {
		return "", err
	}
	encodedKey, ok := keys[marker]
	if !ok {
		return "", fmt.Errorf("unknown crypt5 key marker: %s", marker)
	}
	key, err := parsePKCS8PrivateKey(encodedKey)
	if err != nil {
		return "", err
	}
	rsaPlain, err := decryptRSA(rsaCiphertext, key)
	if err != nil {
		return "", err
	}
	chachaKey, err := decodeBase64Any(swapPairs(string(rsaPlain)))
	if err != nil {
		return "", err
	}
	if len(chachaKey) != chacha20poly1305.KeySize {
		return "", fmt.Errorf("invalid ChaCha20-Poly1305 key length: %d", len(chachaKey))
	}
	aead, err := chacha20poly1305.New(chachaKey)
	if err != nil {
		return "", err
	}
	ciphertext, err := decodeBase64Any(urlB64)
	if err != nil {
		return "", err
	}
	intermediate, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	finalBytes, err := decodeBase64Any(swapPairs(string(intermediate)))
	if err != nil {
		return "", err
	}
	return string(finalBytes), nil
}

func decrypt(link string) (string, string, int, error) {
	value := strings.TrimSpace(link)
	if strings.HasPrefix(strings.ToLower(value), "happ\\") {
		value = "happ" + value[5:]
	}
	if strings.HasPrefix(value, "happ://") {
		value = strings.TrimPrefix(value, "happ://")
	}
	switch {
	case strings.HasPrefix(value, "crypt5/"):
		payload := strings.TrimPrefix(value, "crypt5/")
		result, err := decryptCrypt5(payload)
		return "crypt5", result, len(payload), err
	case strings.HasPrefix(value, "crypt4/"):
		payload := strings.TrimPrefix(value, "crypt4/")
		result, err := decryptLegacy(3, payload)
		return "crypt4", result, len(payload), err
	case strings.HasPrefix(value, "crypt3/"):
		payload := strings.TrimPrefix(value, "crypt3/")
		result, err := decryptLegacy(2, payload)
		return "crypt3", result, len(payload), err
	case strings.HasPrefix(value, "crypt2/"):
		payload := strings.TrimPrefix(value, "crypt2/")
		result, err := decryptLegacy(1, payload)
		return "crypt2", result, len(payload), err
	case strings.HasPrefix(value, "crypt/"):
		payload := strings.TrimPrefix(value, "crypt/")
		result, err := decryptLegacy(0, payload)
		return "crypt", result, len(payload), err
	default:
		return "unknown", "", len(value), errors.New("unknown link format")
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: happ-decrypt-universal <happ://crypt...>")
		os.Exit(2)
	}
	input := os.Args[1]
	mode, result, payloadLen, err := decrypt(input)
	fmt.Println()
	fmt.Println("Input")
	fmt.Printf("  mode        : %s\n", mode)
	fmt.Printf("  payload len : %d\n", payloadLen)
	fmt.Println()
	if err != nil {
		fmt.Println("Error")
		fmt.Printf("  %v\n", err)
		fmt.Println()
		os.Exit(2)
	}
	fmt.Println("Result")
	fmt.Printf("  %s\n", result)
	fmt.Println()
}
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a local-only Happ decryptor for aarch64 routers from a local "
            "LeeeeT/happ-decryptor checkout. The generated key-bearing source and "
            "binary are intentionally ignored by git."
        )
    )
    parser.add_argument("--source", default=str(DEFAULT_SOURCE_DIR), help="LeeeeT/happ-decryptor checkout path.")
    parser.add_argument("--repo", default=DEFAULT_UPSTREAM_REPO, help="Repository to clone when --source is missing.")
    parser.add_argument("--rev", default="", help="Optional git revision to checkout after clone/fetch.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output binary path.")
    parser.add_argument("--goos", default="linux", help="GOOS for the output binary.")
    parser.add_argument("--goarch", default="arm64", help="GOARCH for the output binary.")
    parser.add_argument("--keep-build-dir", action="store_true", help="Keep generated Go source under .tmp for debugging.")
    parser.add_argument("--no-clone", action="store_true", help="Fail if --source does not already exist.")
    return parser.parse_args()


def run_checked(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("[*] " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=True)


def ensure_source(source: Path, *, repo: str, rev: str, no_clone: bool) -> None:
    if source.is_dir():
        if rev:
            run_checked(["git", "fetch", "--depth", "1", "origin", rev], cwd=source)
            run_checked(["git", "checkout", "FETCH_HEAD"], cwd=source)
        return
    if no_clone:
        raise SystemExit(f"source directory is missing: {source}")
    source.parent.mkdir(parents=True, exist_ok=True)
    run_checked(["git", "clone", "--depth", "1", repo, str(source)], cwd=REPO_ROOT)
    if rev:
        run_checked(["git", "fetch", "--depth", "1", "origin", rev], cwd=source)
        run_checked(["git", "checkout", "FETCH_HEAD"], cwd=source)


def read_legacy_keys(source: Path) -> list[str]:
    decrypt_js = (source / DECRYPT_JS_REL).read_text(encoding="utf-8")
    match = re.search(r"const\s+PKCS1_KEYS_B64\s*=\s*\[(.*?)\];", decrypt_js, re.S)
    if not match:
        raise SystemExit("PKCS1_KEYS_B64 array was not found in src/decrypt.js")
    keys = re.findall(r'"([A-Za-z0-9+/=]+)"', match.group(1))
    if len(keys) != 4:
        raise SystemExit(f"expected 4 legacy keys, found {len(keys)}")
    return keys


def read_crypt5_keys(source: Path) -> dict[str, str]:
    path = source / CRYPT5_KEYS_REL
    if not path.is_file():
        raise SystemExit(f"crypt5 keys file is missing: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or len(data) < 1:
        raise SystemExit("crypt5 keys file is not a non-empty object")
    return {str(k): str(v) for k, v in data.items()}


def generate_go_source(build_dir: Path, legacy_keys: list[str], crypt5_keys: dict[str, str]) -> None:
    build_dir.mkdir(parents=True, exist_ok=True)
    main_go = GO_MAIN_TEMPLATE.replace("__LEGACY_KEYS_JSON__", json.dumps(json.dumps(legacy_keys)))
    main_go = main_go.replace("__CRYPT5_KEYS_JSON__", json.dumps(json.dumps(crypt5_keys, sort_keys=True)))
    (build_dir / "main.go").write_text(main_go.strip() + "\n", encoding="utf-8")
    (build_dir / "go.mod").write_text(
        "module xkeen-local-happ-decryptor\n\n"
        "go 1.23\n\n"
        "require golang.org/x/crypto v0.45.0\n",
        encoding="utf-8",
    )


def build_go_binary(build_dir: Path, output: Path, *, goos: str, goarch: str) -> None:
    if shutil.which("go") is None:
        raise SystemExit("go is required to build the local Happ decryptor")
    env = os.environ.copy()
    env.update({
        "CGO_ENABLED": "0",
        "GOOS": goos,
        "GOARCH": goarch,
    })
    run_checked(["go", "mod", "tidy"], cwd=build_dir, env=env)
    run_checked(["go", "build", "-trimpath", "-ldflags=-s -w", "-o", str(output), "."], cwd=build_dir, env=env)
    try:
        output.chmod(0o755)
    except Exception:
        pass


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    output = Path(args.output).resolve()

    ensure_source(source, repo=str(args.repo), rev=str(args.rev or ""), no_clone=bool(args.no_clone))
    legacy_keys = read_legacy_keys(source)
    crypt5_keys = read_crypt5_keys(source)

    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = REPO_ROOT / ".tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    if args.keep_build_dir:
        build_dir = tmp_root / "happ-decryptor-go-build"
        if build_dir.exists():
            shutil.rmtree(build_dir)
        generate_go_source(build_dir, legacy_keys, crypt5_keys)
        build_go_binary(build_dir, output, goos=str(args.goos), goarch=str(args.goarch))
    else:
        with tempfile.TemporaryDirectory(prefix="happ-decryptor-go-build-", dir=str(tmp_root)) as tmp:
            build_dir = Path(tmp)
            generate_go_source(build_dir, legacy_keys, crypt5_keys)
            build_go_binary(build_dir, output, goos=str(args.goos), goarch=str(args.goarch))

    print(f"[*] output: {output}", flush=True)
    print("[*] command: XKEEN_HAPP_DECRYPTOR_CMD='{} %LINK%'".format(output.as_posix()), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
