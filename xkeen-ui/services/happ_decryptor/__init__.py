"""Installing and checking the Happ link decryptor (happ-decrypt-universal).

``engine`` puts the Go binary in place, ``keys`` fetches and installs the Happ
key files next to it. Neither the panel nor this package ships Happ keys: they
are downloaded from the upstream research repository at a pinned commit and
checked against sha256 values from ``keys_manifest.json``.
"""
