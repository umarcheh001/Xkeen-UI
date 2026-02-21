#!/bin/sh
set -eu

REPO="umarcheh001/Xkeen-UI"

# Where to install the binary. Backend/UI may override this via XKEEN_GEODAT_BIN.
DEST_DEFAULT="/opt/etc/xkeen-ui/bin/xk-geodat"
DEST="${XKEEN_GEODAT_BIN:-$DEST_DEFAULT}"
DEST_DIR="$(dirname "$DEST")"

# -------------------- Hash helpers --------------------

have_hash_tool() {
  command -v sha256sum >/dev/null 2>&1 && return 0
  command -v openssl >/dev/null 2>&1 && return 0
  command -v shasum >/dev/null 2>&1 && return 0
  return 1
}

file_sha256() {
  F="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$F" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    # openssl dgst -sha256 file  => "SHA256(file)= <hash>"
    openssl dgst -sha256 "$F" | awk '{print $NF}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$F" | awk '{print $1}'
  else
    return 1
  fi
}

# -------------------- ELF helpers (BusyBox-safe) --------------------

PY_BIN=""
if [ -x /opt/bin/python3 ]; then
  PY_BIN="/opt/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
  PY_BIN="$(command -v python3)"
elif [ -x /opt/bin/python ]; then
  PY_BIN="/opt/bin/python"
elif command -v python >/dev/null 2>&1; then
  PY_BIN="$(command -v python)"
fi

file_magic_hex() {
  F="$1"
  [ -f "$F" ] || return 1

  if [ -n "$PY_BIN" ]; then
    "$PY_BIN" -c 'import sys,binascii; p=sys.argv[1]; b=open(p,"rb").read(4); sys.stdout.write(binascii.hexlify(b).decode("ascii"))' "$F" 2>/dev/null || true
    return 0
  fi

  # Fallback: parse first 4 bytes from hexdump -C.
  if command -v hexdump >/dev/null 2>&1; then
    hexdump -n 4 -C "$F" 2>/dev/null | head -n1 | awk '{print $2 $3 $4 $5}' | tr -d ' \t\r\n'
    return 0
  fi

  echo ""
  return 0
}

is_elf_file() {
  F="$1"
  MAGIC="$(file_magic_hex "$F" 2>/dev/null || true)"
  [ "$MAGIC" = "7f454c46" ]
}

head_snippet() {
  F="$1"
  head -c 120 "$F" 2>/dev/null | tr '\r\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g'
}

elf_diag() {
  F="$1"
  SZ="$(wc -c < "$F" 2>/dev/null || echo "?")"
  MAGIC="$(file_magic_hex "$F" 2>/dev/null || true)"
  HEAD1="$(head_snippet "$F")"
  echo "size=$SZ magic=${MAGIC:-?} head='${HEAD1:-}'"
}

# -------------------- Download helpers --------------------

fetch_url() {
  URL="$1"
  OUT="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL -o "$OUT" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$OUT" "$URL"
  else
    return 127
  fi
}

verify_sha256sums_if_available() {
  BIN_FILE="$1"
  ASSET_NAME="$2"
  SUMS_URL="$3"
  SUMS_TMP="$4"

  if ! have_hash_tool; then
    echo "xk-geodat: sha256 tool not found — skip checksum"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  # 1) Preferred: SHA256SUMS
  if fetch_url "$SUMS_URL" "$SUMS_TMP" 2>/dev/null; then
    EXPECTED="$(grep -E "[[:space:]\*]${ASSET_NAME}\$" "$SUMS_TMP" | awk '{print $1}' | head -n1 || true)"
    if [ -z "$EXPECTED" ]; then
      echo "xk-geodat: SHA256SUMS missing entry for $ASSET_NAME — continue"
      rm -f "$SUMS_TMP" 2>/dev/null || true
      return 0
    fi

    ACTUAL="$(file_sha256 "$BIN_FILE" 2>/dev/null || true)"
    if [ -z "$ACTUAL" ]; then
      echo "xk-geodat: failed to compute sha256 — continue"
      rm -f "$SUMS_TMP" 2>/dev/null || true
      return 0
    fi

    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "xk-geodat: SHA256 mismatch for $ASSET_NAME"
      echo "  expected: $EXPECTED"
      echo "  actual:   $ACTUAL"
      rm -f "$SUMS_TMP" 2>/dev/null || true
      return 1
    fi

    echo "xk-geodat: SHA256 OK"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  # 2) Fallback: per-asset checksum files
  BASE_DIR="${SUMS_URL%/*}/"
  for suf in ".sha256" ".sha256sum" ".sha256.txt"; do
    CAND_URL="${BASE_DIR}${ASSET_NAME}${suf}"
    if fetch_url "$CAND_URL" "$SUMS_TMP" 2>/dev/null; then
      EXPECTED="$(awk '{print $1}' "$SUMS_TMP" | head -n1 || true)"
      if [ -z "$EXPECTED" ]; then
        echo "xk-geodat: checksum file empty (${ASSET_NAME}${suf}) — continue"
        rm -f "$SUMS_TMP" 2>/dev/null || true
        return 0
      fi

      ACTUAL="$(file_sha256 "$BIN_FILE" 2>/dev/null || true)"
      if [ -z "$ACTUAL" ]; then
        echo "xk-geodat: failed to compute sha256 — continue"
        rm -f "$SUMS_TMP" 2>/dev/null || true
        return 0
      fi

      if [ "$ACTUAL" != "$EXPECTED" ]; then
        echo "xk-geodat: SHA256 mismatch for $ASSET_NAME"
        echo "  expected: $EXPECTED"
        echo "  actual:   $ACTUAL"
        rm -f "$SUMS_TMP" 2>/dev/null || true
        return 1
      fi

      echo "xk-geodat: SHA256 OK"
      rm -f "$SUMS_TMP" 2>/dev/null || true
      return 0
    fi
  done

  echo "xk-geodat: checksum file not available — continue"
  rm -f "$SUMS_TMP" 2>/dev/null || true
  return 0
}

# -------------------- Sanity check --------------------

# Some Go binaries built with newer Go versions may refuse to run on older
# kernels without an explicit opt-in env var.
#
# NOTE: your NEW xk-geodat build should NOT require this. We keep retry logic
# to avoid false negatives if user installs an older binary manually.
geodat_sanity_check() {
  BIN="$1"

  # Must be an ELF file.
  if ! is_elf_file "$BIN"; then
    return 1
  fi

  # Some MIPS firmwares are flaky with Go runtime preemption/scheduling.
  PREFIX=""
  ARCH_SANITY="$(uname -m 2>/dev/null || echo unknown)"
  if echo "$ARCH_SANITY" | grep -qi mips; then
    PREFIX="GODEBUG=asyncpreemptoff=1 GOMAXPROCS=1"
  fi

  # capture output + code
  set +e
  # shellcheck disable=SC2086
  OUT="$($PREFIX "$BIN" --help 2>&1)"
  RC=$?
  set -e

  if [ "$RC" -eq 0 ]; then
    return 0
  fi

  # Retry on assume-no-moving-gc warning (legacy binaries)
  if echo "$OUT" | grep -q "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="; then
    VER="$(echo "$OUT" | sed -n 's/.*ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=\(go[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n1)"
    if [ -n "$VER" ]; then
      set +e
      # shellcheck disable=SC2086
      OUT2="$(ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="$VER" $PREFIX "$BIN" --help 2>&1)"
      RC2=$?
      set -e

      if [ "$RC2" -eq 126 ] || [ "$RC2" -eq 127 ] || echo "$OUT2" | grep -qi -e "Exec format error" -e "not found" -e "No such file" -e "syntax error" -e "unexpected" -e "SIGSEGV" -e "segmentation" -e "SIGILL" -e "illegal instruction" -e "futexwakeup"; then
        SHORT="$(echo "$OUT2" | sed -n '1,2p' | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
        echo "xk-geodat: sanity failed (rc=$RC2) — $SHORT"
        return 1
      fi

      return 0
    fi
  fi

  # Hard failures.
  if [ "$RC" -eq 126 ] || [ "$RC" -eq 127 ] || echo "$OUT" | grep -qi -e "Exec format error" -e "not found" -e "No such file" -e "syntax error" -e "unexpected" -e "SIGSEGV" -e "segmentation" -e "SIGILL" -e "illegal instruction" -e "futexwakeup"; then
    return 1
  fi

  # Non-fatal: treat as OK (some builds exit non-zero on --help).
  return 0
}

# -------------------- Backup/restore (never fail outer installer) --------------------

BAK=""
backup_existing() {
  BAK=""
  if [ -f "$DEST" ]; then
    TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo $$)"
    BAK="${DEST}.bak-${TS}"
    echo "xk-geodat: backup existing -> $BAK"
    mv "$DEST" "$BAK" || { echo "xk-geodat: backup failed — пропуск"; exit 0; }
  fi
}

restore_backup() {
  if [ -n "$BAK" ] && [ -f "$BAK" ]; then
    mv "$BAK" "$DEST" 2>/dev/null || true
  fi
}

# -------------------- Control --------------------

#   XKEEN_GEODAT_INSTALL=1  -> install without asking
#   XKEEN_GEODAT_INSTALL=0  -> skip
#   (unset) -> ask if TTY, else try install (non-blocking)
INSTALL="${XKEEN_GEODAT_INSTALL:-}"

if [ -z "$INSTALL" ] && [ -t 0 ]; then
  echo ""
  echo "Установить xk-geodat (включит 'Содержимое' и 'В routing' для DAT GeoIP/GeoSite)?"
  printf "Введите Y/n: "
  read ans || ans=""
  case "$ans" in
    n|N|no|NO) INSTALL="0" ;;
    *)         INSTALL="1" ;;
  esac
fi

if [ -z "$INSTALL" ]; then
  INSTALL="1"
fi

[ "$INSTALL" = "1" ] || { echo "xk-geodat: пропущено"; exit 0; }

mkdir -p "$DEST_DIR"

# -------------------- Detect arch --------------------

ARCH="$(uname -m 2>/dev/null || echo unknown)"
OPKG_ARCH=""
if command -v opkg >/dev/null 2>&1; then
  OPKG_ARCH="$(opkg print-architecture 2>/dev/null | awk '
    $1=="arch" && NR==1 { first=$2 }
    $1=="arch" {
      a=tolower($2)
      if (a!="all" && a!="noarch" && chosen=="") chosen=$2
    }
    END {
      if (chosen!="") print chosen;
      else if (first!="") print first;
    }' || true)"
fi

ENDIAN=""
if [ -r /proc/cpuinfo ]; then
  CPUINFO="$(tr 'A-Z' 'a-z' < /proc/cpuinfo 2>/dev/null || true)"
  case "$CPUINFO" in
    *"little endian"*) ENDIAN="le" ;;
    *"big endian"*)    ENDIAN="be" ;;
    *"byte order"*little*) ENDIAN="le" ;;
    *"byte order"*big*)    ENDIAN="be" ;;
    *"endian"*little*) ENDIAN="le" ;;
    *"endian"*big*)    ENDIAN="be" ;;
  esac
fi

if [ -z "$ENDIAN" ]; then
  PYEND=""
  if [ -n "$PY_BIN" ]; then
    PYEND="$("$PY_BIN" -c 'import sys; print(sys.byteorder)' 2>/dev/null || true)"
  fi
  case "$PYEND" in
    little*) ENDIAN="le" ;;
    big*)    ENDIAN="be" ;;
  esac
fi

ASSET=""
case "${ARCH}/${OPKG_ARCH}" in
  *aarch64*|*arm64*) ASSET="xk-geodat-linux-arm64" ;;
  *mips*)
    if echo "${OPKG_ARCH}" | grep -qiE 'mipsel|mipsle'; then
      ASSET="xk-geodat-linux-mipsle"
    else
      if [ "${ENDIAN}" = "be" ]; then
        ASSET="xk-geodat-linux-mips"
      else
        ASSET="xk-geodat-linux-mipsle"
      fi
    fi
    ;;
  *) echo "xk-geodat: unsupported arch: $ARCH ($OPKG_ARCH) — пропуск"; exit 0 ;;
esac

# NOTE: we do NOT publish a big-endian MIPS binary.
if [ "$ASSET" = "xk-geodat-linux-mips" ] && [ "${ENDIAN}" = "be" ]; then
  echo "xk-geodat: unsupported MIPS big-endian (mips). Этот проект публикует xk-geodat только для arm64/aarch64 и mipsle/mipsel."
  echo "xk-geodat: arch=$ARCH opkg_arch=${OPKG_ARCH:-} endian=${ENDIAN:-unknown}"
  exit 0
fi

# Optional overrides:
#   XKEEN_GEODAT_ASSET          -> override asset name
#   XKEEN_GEODAT_TAG            -> download from specific tag
#   XKEEN_GEODAT_URL            -> full URL to binary
#   XKEEN_GEODAT_LOCAL          -> install from existing local file
#   XKEEN_GEODAT_SHA256SUMS_URL -> override URL to SHA256SUMS
if [ -n "${XKEEN_GEODAT_ASSET:-}" ]; then
  ASSET="$XKEEN_GEODAT_ASSET"
fi

# -------------------- Install from local file --------------------

if [ -n "${XKEEN_GEODAT_LOCAL:-}" ] && [ -f "$XKEEN_GEODAT_LOCAL" ]; then
  echo "xk-geodat: installing from local file $XKEEN_GEODAT_LOCAL"
  backup_existing

  cp "$XKEEN_GEODAT_LOCAL" "$DEST" || { echo "xk-geodat: copy failed — пропуск"; restore_backup; exit 0; }
  chmod +x "$DEST" || { echo "xk-geodat: chmod failed — пропуск"; restore_backup; exit 0; }

  if ! is_elf_file "$DEST"; then
    echo "xk-geodat: bad local binary (not ELF) — пропуск"
    echo "xk-geodat: вероятно, файл скачан не как бинарник (например, HTML-страница блокировки/редиректа). $(elf_diag "$DEST")"
    rm -f "$DEST"
    restore_backup
    exit 0
  fi

  if ! geodat_sanity_check "$DEST"; then
    set +e
    DIAG_OUT="$("$DEST" --help 2>&1)"
    DIAG_RC=$?
    set -e
    DIAG_OUT="$(echo "$DIAG_OUT" | sed -n '1,2p' | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
    SZ="$(wc -c < "$DEST" 2>/dev/null || echo 0)"
    HD="$(head_snippet "$DEST")"
    echo "xk-geodat: bad local binary — пропуск"
    echo "xk-geodat: диагност.: size=${SZ}B head='${HD}'"
    echo "xk-geodat: диагностика: rc=$DIAG_RC arch=$ARCH opkg_arch=${OPKG_ARCH:-} endian=${ENDIAN:-unknown} expected_asset=$ASSET"
    [ -n "$DIAG_OUT" ] && echo "xk-geodat: вывод: $DIAG_OUT"
    rm -f "$DEST"
    restore_backup
    exit 0
  fi

  echo "xk-geodat: installed to $DEST"
  exit 0
fi

# -------------------- Download & install --------------------

BASE=""
if [ -n "${XKEEN_GEODAT_URL:-}" ]; then
  URL="$XKEEN_GEODAT_URL"
elif [ -n "${XKEEN_GEODAT_TAG:-}" ]; then
  BASE="https://github.com/$REPO/releases/download/$XKEEN_GEODAT_TAG/"
  URL="${BASE}${ASSET}"
else
  BASE="https://github.com/$REPO/releases/latest/download/"
  URL="${BASE}${ASSET}"
fi

TMP="/tmp/$ASSET.$$"
SUMS_TMP="/tmp/SHA256SUMS.$$"

echo "xk-geodat: downloading $URL"

set +e
fetch_url "$URL" "$TMP"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  if [ "$RC" -eq 127 ]; then
    echo "xk-geodat: curl/wget not found — пропуск"
  else
    echo "xk-geodat: download failed — пропуск"
  fi
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi

chmod +x "$TMP"

if ! is_elf_file "$TMP"; then
  echo "xk-geodat: bad binary (not ELF) — пропуск"
  echo "xk-geodat: вероятно, GitHub недоступен/заблокирован и вместо бинарника скачана HTML-страница. $(elf_diag "$TMP")"
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi

# Soft checksum verification (if SHA256SUMS is available)
if [ -n "${XKEEN_GEODAT_SHA256SUMS_URL:-}" ]; then
  SUMS_URL="$XKEEN_GEODAT_SHA256SUMS_URL"
elif [ -n "$BASE" ]; then
  SUMS_URL="${BASE}SHA256SUMS"
else
  SUMS_URL="${URL%/*}/SHA256SUMS"
fi

verify_sha256sums_if_available "$TMP" "$ASSET" "$SUMS_URL" "$SUMS_TMP" || {
  echo "xk-geodat: checksum failed — пропуск"
  rm -f "$TMP" 2>/dev/null || true
  exit 0
}

if ! geodat_sanity_check "$TMP"; then
  echo "xk-geodat: bad binary — пропуск"
  SZ="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
  HD="$(head_snippet "$TMP")"
  echo "xk-geodat: диагност.: size=${SZ}B head='${HD}'"
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi

backup_existing
if mv "$TMP" "$DEST"; then
  echo "xk-geodat: installed to $DEST"
else
  echo "xk-geodat: install failed — пропуск"
  rm -f "$TMP" 2>/dev/null || true
  restore_backup
fi

exit 0