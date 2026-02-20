#!/bin/sh
set -eu

REPO="umarcheh001/Xkeen-UI"

# Where to install the binary. Backend/UI may override this via XKEEN_GEODAT_BIN.
DEST_DEFAULT="/opt/etc/xkeen-ui/bin/xk-geodat"
DEST="${XKEEN_GEODAT_BIN:-$DEST_DEFAULT}"
DEST_DIR="$(dirname "$DEST")"

# Some Go binaries built with newer Go versions may refuse to run on older
# kernels without an explicit opt-in env var.
#
# The panel backend (_geodat_run_help) already knows how to detect this message
# and retry with ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=goX.Y.
#
# This installer also runs "--help" as a sanity check to validate the binary.
# Without the retry logic, a perfectly fine xk-geodat might be treated as
# "bad" and deleted, making "install from file" fail while manual copy works.

geodat_sanity_check() {
  BIN="$1"
# Reject non-ELF files (e.g. HTML/captive portal pages saved as a file).
if ! is_elf_file "$BIN"; then
  return 1
fi


  # Some MIPS firmwares are flaky with Go runtime preemption/scheduling.
  # Running with these envs is safe and improves stability.
  PREFIX=""
  ARCH_SANITY="$(uname -m 2>/dev/null || echo unknown)"
  if echo "$ARCH_SANITY" | grep -qi mips; then
    PREFIX="GODEBUG=asyncpreemptoff=1 GOMAXPROCS=1"
  fi

  # We need the exit code + output, so temporarily disable "set -e".
  set +e
  # shellcheck disable=SC2086
  OUT="$($PREFIX $BIN --help 2>&1)"
  RC=$?
  set -e

  # Success.
  if [ "$RC" -eq 0 ]; then
    return 0
  fi

  # Retry when Go runtime requests ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH.
  if echo "$OUT" | grep -q "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="; then
    VER="$(echo "$OUT" | sed -n 's/.*ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=\(go[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n1)"
    if [ -n "$VER" ]; then
      set +e
      # shellcheck disable=SC2086
      OUT2="$(ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH="$VER" $PREFIX $BIN --help 2>&1)"
      RC2=$?
      set -e

      # Hard failures (wrong arch / missing loader / noexec, etc.).
      if [ "$RC2" -eq 126 ] || [ "$RC2" -eq 127 ] || echo "$OUT2" | grep -qi -e "Exec format error" -e "not found" -e "No such file" -e "syntax error" -e "unexpected" -e "SIGSEGV" -e "segmentation" -e "SIGILL" -e "illegal instruction" -e "futexwakeup"; then
  SHORT="$(echo "$OUT2" | sed -n '1,2p' | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
  echo "xk-geodat: sanity failed (rc=$RC2) — $SHORT"
  return 1
fi
      # Any other non-zero is considered acceptable (some builds exit non-zero on --help).
      return 0
    fi
  fi

  # Hard failures.
  if [ "$RC" -eq 126 ] || [ "$RC" -eq 127 ] || echo "$OUT" | grep -qi -e "Exec format error" -e "not found" -e "No such file" -e "syntax error" -e "unexpected" -e "SIGSEGV" -e "segmentation" -e "SIGILL" -e "illegal instruction" -e "futexwakeup" -e "syntax error" -e "unexpected"; then
    return 1
  fi

  # Non-fatal (treat as OK).
  return 0
}

# Backup/restore helpers (never fail the outer installer).
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


is_elf_file() {
  F="$1"
  # Check ELF magic 0x7f 'E' 'L' 'F'
  if [ ! -f "$F" ]; then return 1; fi

  MAGIC="$(dd if="$F" bs=1 count=4 2>/dev/null | hexdump -v -e '1/1 "%02x"' 2>/dev/null || true)"
  # BusyBox hexdump may not support -e; fallback to od.
  if [ -z "$MAGIC" ]; then
    MAGIC="$(dd if="$F" bs=1 count=4 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n\t' || true)"
  fi

  [ "$MAGIC" = "7f454c46" ] && return 0
  return 1
}

elf_diag() {
  F="$1"
  SZ="$(wc -c < "$F" 2>/dev/null || echo "?")"
  MAGIC="$(dd if="$F" bs=1 count=4 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n\t' || true)"
  HEAD1="$(dd if="$F" bs=1 count=64 2>/dev/null | tr '\r\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-120)"
  echo "size=$SZ magic=${MAGIC:-?} head='${HEAD1:-}'"
}


is_elf_binary() {
  F="$1"
  # Expect 0x7F 'E' 'L' 'F' => 7f454c46
  MAGIC="$(dd if="$F" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n\t' || true)"
  [ "$MAGIC" = "7f454c46" ]
}

head_snippet() {
  F="$1"
  head -c 120 "$F" 2>/dev/null | tr '\r\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g'
}

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

  # Try to download SHA256SUMS. If not available — warn and continue (soft).
  if ! fetch_url "$SUMS_URL" "$SUMS_TMP" 2>/dev/null; then
    echo "xk-geodat: SHA256SUMS not available — continue"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  if ! have_hash_tool; then
    echo "xk-geodat: sha256 tool not found — skip checksum"
    rm -f "$SUMS_TMP" 2>/dev/null || true
    return 0
  fi

  # sha256sum format: "<hash>  <file>" or "<hash> *<file>"
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
}

# Control:
#   XKEEN_GEODAT_INSTALL=1  -> install without asking
#   XKEEN_GEODAT_INSTALL=0  -> skip
#   (unset) -> ask if TTY, else try install (non-blocking)
INSTALL="${XKEEN_GEODAT_INSTALL:-}"

# Ask user only in interactive terminal
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

# Non-interactive default: try install (but never fail install.sh)
if [ -z "$INSTALL" ]; then
  INSTALL="1"
fi

[ "$INSTALL" = "1" ] || { echo "xk-geodat: пропущено"; exit 0; }

mkdir -p "$DEST_DIR"

ARCH="$(uname -m 2>/dev/null || echo unknown)"
OPKG_ARCH=""
if command -v opkg >/dev/null 2>&1; then
  # Prefer a specific arch over "all"/"noarch". Example lines:
  #   arch all 1
  #   arch mipsel_24kc 10
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

# Best-effort endianness detection. Some firmwares may report only "mips" in uname.
# /proc/cpuinfo usually contains "byte order" / "endian" hints.
ENDIAN=""
if [ -r /proc/cpuinfo ]; then
  # Robust (no grep -E dependency): detect endian hints from /proc/cpuinfo text.
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


# Fallback: detect endianness via Python (native byteorder) if cpuinfo has no hints.
if [ -z "$ENDIAN" ]; then
  PYEND=""
  if command -v python3 >/dev/null 2>&1; then
    PYEND="$(python3 -c 'import sys; print(sys.byteorder)' 2>/dev/null || true)"
  elif [ -x /opt/bin/python3 ]; then
    PYEND="$(/opt/bin/python3 -c 'import sys; print(sys.byteorder)' 2>/dev/null || true)"
  elif command -v python >/dev/null 2>&1; then
    PYEND="$(python -c 'import sys; print(sys.byteorder)' 2>/dev/null || true)"
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
  # Prefer opkg arch when it explicitly says little-endian (mipsel/mipsle).
  if echo "${OPKG_ARCH}" | grep -qiE 'mipsel|mipsle'; then
    ASSET="xk-geodat-linux-mipsle"
  else
    # Otherwise rely on endianness detection (cpuinfo/python). If unknown, assume little-endian
    # (most consumer routers), but do NOT claim big-endian without evidence.
    if [ "${ENDIAN}" = "be" ]; then
      ASSET="xk-geodat-linux-mips"
    else
      ASSET="xk-geodat-linux-mipsle"
    fi
  fi
  ;;
  *) echo "xk-geodat: unsupported arch: $ARCH ($OPKG_ARCH) — пропуск"; exit 0 ;;
esac
# If router is MIPS big-endian, this project does not publish a compatible binary.
# Avoid pointless GitHub downloads and show a clear explanation in the UI.
# If router is MIPS big-endian, this project does not publish a compatible binary.
# Avoid pointless GitHub downloads and show a clear explanation in the UI.
if [ "$ASSET" = "xk-geodat-linux-mips" ] && [ "${ENDIAN}" = "be" ]; then
  echo "xk-geodat: unsupported MIPS big-endian (mips). Этот проект публикует xk-geodat только для arm64/aarch64 и mipsle/mipsel."
  echo "xk-geodat: arch=$ARCH opkg_arch=${OPKG_ARCH:-} endian=${ENDIAN:-unknown}"
  exit 0
fi



# Optional overrides (useful for testing before publishing a Release):
#   XKEEN_GEODAT_ASSET         -> override asset name (default is detected by arch)
#   XKEEN_GEODAT_TAG           -> download from a specific GitHub release tag (instead of latest)
#   XKEEN_GEODAT_URL           -> full URL to binary (overrides TAG/latest logic)
#   XKEEN_GEODAT_LOCAL         -> install from an existing local file (skip download)
#   XKEEN_GEODAT_SHA256SUMS_URL-> override URL to SHA256SUMS
if [ -n "${XKEEN_GEODAT_ASSET:-}" ]; then
  ASSET="$XKEEN_GEODAT_ASSET"
fi

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
  # Try to provide a short diagnostic to help the user pick the right binary.
  set +e
  DIAG_OUT="$($DEST --help 2>&1)"
  DIAG_RC=$?
  set -e
  DIAG_OUT="$(echo "$DIAG_OUT" | sed -n '1,2p' | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
  SZ="$(wc -c < "$DEST" 2>/dev/null || echo 0)"
    HD="$(head_snippet "$DEST")"
    echo "xk-geodat: bad local binary — пропуск"
    echo "xk-geodat: диагност.: size=${SZ}B head='${HD}'"
  echo "xk-geodat: диагностика: rc=$DIAG_RC arch=$ARCH opkg_arch=${OPKG_ARCH:-} endian=${ENDIAN:-unknown} expected_asset=$ASSET"
  if [ -n "$DIAG_OUT" ]; then
    echo "xk-geodat: вывод: $DIAG_OUT"
  fi
  rm -f "$DEST"
  restore_backup
  exit 0
fi

  echo "xk-geodat: installed to $DEST"
  exit 0
fi

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

# Download the binary (never fail the outer installer).
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
# Reject captive portal / block pages: must be an ELF binary.
if ! is_elf_file "$TMP"; then
  echo "xk-geodat: bad binary (not ELF) — пропуск"
  echo "xk-geodat: вероятно, GitHub недоступен/заблокирован и вместо бинарника скачана HTML-страница. $(elf_diag "$TMP")"
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi

fi

chmod +x "$TMP"
if ! is_elf_binary "$TMP"; then
  SNIP="$(head_snippet "$TMP")"
  echo "xk-geodat: downloaded file is not a valid ELF binary — пропуск"
  echo "xk-geodat: size=$(wc -c < "$TMP" 2>/dev/null || echo 0) arch=$ARCH opkg_arch=${OPKG_ARCH:-} endian=${ENDIAN:-unknown} expected_asset=$ASSET"
  if [ -n "$SNIP" ]; then echo "xk-geodat: head: $SNIP"; fi
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi


# Validate that the downloaded file is an ELF binary.
if ! is_elf_file "$TMP"; then
  echo "xk-geodat: downloaded file is not an ELF binary — пропуск"
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

verify_sha256sums_if_available "$TMP" "$ASSET" "$SUMS_URL" "$SUMS_TMP" || { echo "xk-geodat: checksum failed — пропуск"; rm -f "$TMP"; exit 0; }

# sanity check
if ! geodat_sanity_check "$TMP"; then
  echo "xk-geodat: bad binary — пропуск"
  SZ="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
  HD="$(head_snippet "$TMP")"
  echo "xk-geodat: диагност.: size=${SZ}B head='${HD}'"
  rm -f "$TMP"
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
