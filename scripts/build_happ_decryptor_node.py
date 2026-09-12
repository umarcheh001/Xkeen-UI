from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM_REPO = "https://github.com/LeeeeT/happ-decryptor.git"
DEFAULT_SOURCE_DIR = REPO_ROOT / ".tmp" / "leeeet-happ-decryptor"
DEFAULT_OUTPUT = REPO_ROOT / "xkeen-ui" / "bin" / "happ-decrypt-universal"
ASSET_DIR_SUFFIX = ".assets"

REQUIRED_ASSETS = (
    ("src/emu/emu_core.js", "emu_core.mjs"),
    ("public/emu/unicorn_aarch64.js", "unicorn_aarch64.js"),
    ("public/emu/unicorn-wrapper.js", "unicorn-wrapper.js"),
    ("public/emu/liberror-code.so", "liberror-code.so"),
    ("public/data/keytable.json", "keytable.json"),
)


LAUNCHER_TEMPLATE = r'''#!/usr/bin/env node
let fs;
let path;
let crypto;
let pathToFileURL;
let requireFn;
let scriptPath;
let scriptDir;

const legacyKeys = __LEGACY_KEYS_JSON__;

async function initRuntime() {
  const [fsMod, pathMod, cryptoMod, urlMod, moduleMod] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:crypto'),
    import('node:url'),
    import('node:module'),
  ]);
  fs = fsMod.default || fsMod;
  path = pathMod.default || pathMod;
  crypto = cryptoMod.default || cryptoMod;
  pathToFileURL = urlMod.pathToFileURL;
  scriptPath = fs.realpathSync(process.argv[1]);
  scriptDir = path.dirname(scriptPath);
  requireFn = moduleMod.createRequire(pathToFileURL(scriptPath).href);
}

function usage() {
  console.error('usage: happ-decrypt-universal <happ://crypt...>');
  console.error('       happ-decrypt-universal -            # read link from stdin');
  console.error('       happ-decrypt-universal @/tmp/link   # read link from file');
}

function decodeBase64Any(value) {
  const raw = String(value || '').trim();
  const candidates = [raw];
  if (raw.includes('-') || raw.includes('_')) {
    candidates.push(raw.replace(/-/g, '+').replace(/_/g, '/'));
  }
  for (const candidate of candidates) {
    const padded = candidate + '='.repeat((4 - (candidate.length % 4)) % 4);
    try {
      return Buffer.from(padded, 'base64');
    } catch (err) {}
  }
  throw new Error('invalid base64');
}

function pemFromBase64(encoded, label) {
  const clean = String(encoded || '').replace(/\s+/g, '');
  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function decryptRSA(encodedCiphertext, pem) {
  const ciphertext = decodeBase64Any(encodedCiphertext);
  const key = crypto.createPrivateKey(pem);
  const size = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
  const chunks = [];
  for (let offset = 0; offset < ciphertext.length; offset += size) {
    chunks.push(crypto.privateDecrypt({
      key,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, ciphertext.subarray(offset, offset + size)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function swapPairs(value) {
  const chars = Array.from(String(value || ''));
  for (let i = 0; i + 1 < chars.length; i += 2) {
    const tmp = chars[i];
    chars[i] = chars[i + 1];
    chars[i + 1] = tmp;
  }
  return chars.join('');
}

function m4831f(value) {
  const s = String(value || '');
  const full = s.length - (s.length % 6);
  let out = '';
  for (let i = 0; i < full; i += 6) {
    const b = s.slice(i, i + 6);
    out += b[1] + b[3] + b[5] + b[0] + b[2] + b[4];
  }
  return out + s.slice(full);
}

function evalCjs(src) {
  const shim = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', src);
  fn(shim, shim.exports, requireFn, scriptDir, scriptPath);
  return shim.exports.default || shim.exports;
}

function parseInput(value) {
  let raw = String(value || '').trim();
  // Some provider panels export the URI with an escaped scheme (`happ\\://`).
  // Canonicalize the leading backslash before selecting the crypt mode.
  if (raw.slice(0, 5).toLowerCase() === 'happ\\') raw = 'happ' + raw.slice(5);
  if (raw.startsWith('happ://')) raw = raw.slice('happ://'.length);
  const modes = [
    ['crypt5/', 'crypt5', 4],
    ['crypt4/', 'crypt4', 3],
    ['crypt3/', 'crypt3', 2],
    ['crypt2/', 'crypt2', 1],
    ['crypt/', 'crypt', 0],
  ];
  for (const [prefix, name, index] of modes) {
    if (raw.startsWith(prefix)) {
      return { name, index, payload: raw.slice(prefix.length) };
    }
  }
  throw new Error('unknown link format');
}

async function decryptCrypt5(payload) {
  const assetDir = path.join(scriptDir, 'happ-decrypt-universal.assets');
  const [emuCore, unicornSrc, wrapperSrc, soBytes, keytable] = await Promise.all([
    import(pathToFileURL(path.join(assetDir, 'emu_core.mjs')).href),
    fs.promises.readFile(path.join(assetDir, 'unicorn_aarch64.js'), 'utf8'),
    fs.promises.readFile(path.join(assetDir, 'unicorn-wrapper.js'), 'utf8'),
    fs.promises.readFile(path.join(assetDir, 'liberror-code.so')),
    fs.promises.readFile(path.join(assetDir, 'keytable.json'), 'utf8').then(JSON.parse),
  ]);

  const MUnicorn = evalCjs(unicornSrc);
  const decryptor = await emuCore.createDecryptor({
    MUnicorn,
    wrapperSrc,
    soBytes: new Uint8Array(soBytes),
    keytable,
    verbose: 0,
  });
  const nativeIn = new TextEncoder().encode(m4831f(payload));
  const outBytes = decryptor.decrypt(nativeIn);
  if (!outBytes || outBytes.length === 0) {
    throw new Error('crypt5 decryption failed');
  }
  const obfuscated = new TextDecoder().decode(outBytes);
  return new TextDecoder().decode(decodeBase64Any(swapPairs(obfuscated)));
}

async function decrypt(link) {
  const input = parseInput(link);
  if (input.name === 'crypt5') {
    return { ...input, result: await decryptCrypt5(input.payload) };
  }
  const key = legacyKeys[input.index];
  if (!key) throw new Error('unknown legacy mode');
  const pem = pemFromBase64(key, 'RSA PRIVATE KEY');
  return { ...input, result: decryptRSA(input.payload, pem) };
}

async function readInputArg() {
  const arg = process.argv[2];
  if (arg && arg !== '-') {
    if (arg.startsWith('@')) {
      return fs.promises.readFile(arg.slice(1), 'utf8').then((value) => value.trim());
    }
    return arg;
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return '';
}

(async () => {
  await initRuntime();
  const input = await readInputArg();
  if (!input) {
    usage();
    process.exit(2);
  }
  let parsed = null;
  try {
    parsed = await decrypt(input);
    console.log();
    console.log('Input');
    console.log(`  mode        : ${parsed.name}`);
    console.log(`  payload len : ${parsed.payload.length}`);
    console.log();
    console.log('Result');
    console.log(`  ${parsed.result}`);
    console.log();
  } catch (err) {
    if (!parsed) {
      try { parsed = parseInput(input); } catch (parseErr) {}
    }
    console.log();
    console.log('Input');
    console.log(`  mode        : ${parsed ? parsed.name : 'unknown'}`);
    console.log(`  payload len : ${parsed ? parsed.payload.length : String(input || '').length}`);
    console.log();
    console.log('Error');
    console.log(`  ${err && err.message ? err.message : String(err)}`);
    console.log();
    process.exit(2);
  }
})();
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a local Happ decryptor drop-in that supports current crypt5 "
            "via the upstream native emulator assets. The generated launcher and "
            "assets are local-only and intentionally ignored by git."
        )
    )
    parser.add_argument("--source", default=str(DEFAULT_SOURCE_DIR), help="LeeeeT/happ-decryptor checkout path.")
    parser.add_argument("--repo", default=DEFAULT_UPSTREAM_REPO, help="Repository to clone when --source is missing.")
    parser.add_argument("--rev", default="origin/main", help="Git revision to use after fetch. Defaults to origin/main.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output launcher path.")
    parser.add_argument("--no-fetch", action="store_true", help="Use the existing checkout without fetching updates.")
    return parser.parse_args()


def run_checked(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("[*] " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def ensure_source(source: Path, *, repo: str, rev: str, no_fetch: bool) -> None:
    if not source.is_dir():
        source.parent.mkdir(parents=True, exist_ok=True)
        run_checked(["git", "clone", "--depth", "1", repo, str(source)], cwd=REPO_ROOT)
    if no_fetch:
        return
    run_checked(["git", "fetch", "--depth", "1", "origin", "main"], cwd=source)
    target = rev or "origin/main"
    run_checked(["git", "checkout", "--detach", target], cwd=source)


def read_legacy_keys(source: Path) -> list[str]:
    decrypt_js = (source / "src" / "decrypt.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+PKCS1_KEYS_B64\s*=\s*\[(.*?)\];", decrypt_js, re.S)
    if not match:
        raise SystemExit("PKCS1_KEYS_B64 array was not found in src/decrypt.js")
    keys = re.findall(r'"([A-Za-z0-9+/=]+)"', match.group(1))
    if len(keys) != 4:
        raise SystemExit(f"expected 4 legacy keys, found {len(keys)}")
    return keys


def copy_assets(source: Path, asset_dir: Path) -> None:
    if asset_dir.exists():
        shutil.rmtree(asset_dir)
    asset_dir.mkdir(parents=True, exist_ok=True)
    for src_rel, dst_name in REQUIRED_ASSETS:
        src = source / src_rel
        if not src.is_file():
            raise SystemExit(f"required upstream asset is missing: {src}")
        shutil.copy2(src, asset_dir / dst_name)


def generate_launcher(output: Path, legacy_keys: list[str]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    launcher = LAUNCHER_TEMPLATE.replace("__LEGACY_KEYS_JSON__", json.dumps(legacy_keys))
    output.write_text(launcher, encoding="utf-8", newline="\n")
    try:
        output.chmod(0o755)
    except Exception:
        pass


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    asset_dir = output.with_name(output.name + ASSET_DIR_SUFFIX)

    ensure_source(source, repo=str(args.repo), rev=str(args.rev or ""), no_fetch=bool(args.no_fetch))
    legacy_keys = read_legacy_keys(source)
    copy_assets(source, asset_dir)
    generate_launcher(output, legacy_keys)

    print(f"[*] output: {output}", flush=True)
    print(f"[*] assets: {asset_dir}", flush=True)
    print("[*] command: XKEEN_HAPP_DECRYPTOR_CMD='{} %LINK%'".format(output.as_posix()), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
