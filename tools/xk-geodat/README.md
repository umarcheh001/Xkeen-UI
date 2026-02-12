# xk-geodat

Tiny helper to parse `geoip.dat` / `geosite.dat` (V2Ray/Xray geodata) using **v2ray-core** protobuf types.

## Commands

### List tags
```bash
./xk-geodat tags --kind geosite --path /opt/etc/xray/geosite.dat --pretty
./xk-geodat tags --kind geoip   --path /opt/etc/xray/geoip.dat   --pretty
```

### Dump tag (paged)
```bash
./xk-geodat dump --kind geosite --path /opt/etc/xray/geosite.dat --tag google --offset 0 --limit 200 --pretty
./xk-geodat dump --kind geoip   --path /opt/etc/xray/geoip.dat   --tag ru     --offset 0 --limit 200 --pretty
```

## Build
```bash
go mod tidy
./build.sh

# Example cross-build for MIPS LE:
GOOS=linux GOARCH=mipsle ./build.sh
```

## Notes
- This tool intentionally stays **stateless**. Cache results in the caller (your Flask endpoint), keyed by file `size+mtime`.
- Data format is read via types in `github.com/v2fly/v2ray-core/v4/app/router`.
