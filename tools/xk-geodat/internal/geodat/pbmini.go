package geodat

import (
  "errors"
  "fmt"
  "net"
  "sort"
  "strings"
)

// Minimal protobuf decoder for V2Ray/Xray GeoSite/GeoIP DAT files.
//
// We intentionally avoid pulling v2ray-core + protobuf runtime here because:
//   1) It bloats the binary.
//   2) It drags in go4.org/unsafe/assume-no-moving-gc, which may panic on new Go versions.
//
// Schema reference (field numbers):
//   GeoSiteList: entry (1)
//   GeoSite: country_code (1), domain (2)
//   Domain: type (1), value (2)  [attributes ignored]
//   GeoIPList: entry (1)
//   GeoIP: country_code (1), cidr (2)  [reverse_match ignored]
//   CIDR: ip (1), prefix (2)

const (
  wtVarint  = 0
  wtFixed64 = 1
  wtBytes   = 2
  wtFixed32 = 5
)

func readVarint(b []byte, i int) (uint64, int, error) {
  var x uint64
  var s uint
  for {
    if i >= len(b) {
      return 0, i, errors.New("unexpected_eof")
    }
    c := b[i]
    i++
    if c < 0x80 {
      if s >= 64 {
        return 0, i, errors.New("varint_overflow")
      }
      return x | uint64(c)<<s, i, nil
    }
    x |= uint64(c&0x7f) << s
    s += 7
    if s >= 64 {
      return 0, i, errors.New("varint_overflow")
    }
  }
}

func readKey(b []byte, i int) (fieldNum int, wireType int, next int, err error) {
  k, j, err := readVarint(b, i)
  if err != nil {
    return 0, 0, i, err
  }
  fn := int(k >> 3)
  wt := int(k & 0x7)
  if fn <= 0 {
    return 0, 0, i, errors.New("bad_field_number")
  }
  return fn, wt, j, nil
}

func skip(b []byte, i int, wireType int) (int, error) {
  switch wireType {
  case wtVarint:
    _, j, err := readVarint(b, i)
    return j, err
  case wtFixed64:
    if i+8 > len(b) {
      return i, errors.New("unexpected_eof")
    }
    return i + 8, nil
  case wtBytes:
    ln, j, err := readVarint(b, i)
    if err != nil {
      return i, err
    }
    end := j + int(ln)
    if end > len(b) {
      return i, errors.New("unexpected_eof")
    }
    return end, nil
  case wtFixed32:
    if i+4 > len(b) {
      return i, errors.New("unexpected_eof")
    }
    return i + 4, nil
  default:
    return i, fmt.Errorf("bad_wire_type:%d", wireType)
  }
}

func readBytesField(b []byte, i int) (val []byte, next int, err error) {
  ln, j, err := readVarint(b, i)
  if err != nil {
    return nil, i, err
  }
  end := j + int(ln)
  if end > len(b) {
    return nil, i, errors.New("unexpected_eof")
  }
  return b[j:end], end, nil
}

// ---- GeoSite ----


// parseGeoSiteLookup scans all tags and returns those that match the given domain.
func parseGeoSiteLookup(b []byte, domain string, maxTags int) ([]LookupMatch, error) {
  out := make([]LookupMatch, 0, 32)

  // GeoSiteList.entry = 1 (bytes)
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, err
      }
      i = next

      tag, cnt, err := parseGeoSiteEntryLookup(entryBytes, domain)
      if err != nil {
        return nil, err
      }
      if tag != "" && cnt > 0 {
        out = append(out, LookupMatch{Tag: tag, Count: cnt})
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, err
    }
    i = ni
  }

  sort.Slice(out, func(i, j int) bool {
    if out[i].Count != out[j].Count {
      return out[i].Count > out[j].Count
    }
    return strings.ToLower(out[i].Tag) < strings.ToLower(out[j].Tag)
  })

  if maxTags > 0 && len(out) > maxTags {
    out = out[:maxTags]
  }
  return out, nil
}

func parseGeoSiteEntryLookup(b []byte, domain string) (tag string, count int, err error) {
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", 0, err
    }
    i = j

    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      tag = strings.TrimSpace(string(raw))

    case fn == 2 && wt == wtBytes: // domain
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      t, v, err := parseDomainItem(raw)
      if err != nil {
        return "", 0, err
      }
      if matchDomainRule(t, v, domain) {
        count++
      }

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", 0, err
      }
      i = ni
    }
  }
  return tag, count, nil
}


func parseGeoSiteTags(b []byte) ([]TagStat, error) {
  out := make([]TagStat, 0, 256)
  // GeoSiteList.entry = 1 (bytes)
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, err
      }
      i = next

      tag, cnt, err := parseGeoSiteEntryTagAndCount(entryBytes)
      if err != nil {
        return nil, err
      }
      if tag != "" {
        out = append(out, TagStat{Tag: tag, Count: cnt})
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, err
    }
    i = ni
  }
  return out, nil
}

func parseGeoSiteEntryTagAndCount(b []byte) (tag string, domains int, err error) {
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", 0, err
    }
    i = j

    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      tag = strings.TrimSpace(string(raw))

    case fn == 2 && wt == wtBytes: // domain (repeated)
      // Just count here; actual domain parsing is for Dump.
      _, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      domains++

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", 0, err
      }
      i = ni
    }
  }
  return tag, domains, nil
}

func parseDomainItem(b []byte) (t string, v string, err error) {
  dtype := uint64(0) // default enum value in proto3: plain
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", "", err
    }
    i = j
    switch {
    case fn == 1 && wt == wtVarint: // type
      vv, next, err := readVarint(b, i)
      if err != nil {
        return "", "", err
      }
      i = next
      dtype = vv
    case fn == 2 && wt == wtBytes: // value
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", "", err
      }
      i = next
      v = string(raw)
    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", "", err
      }
      i = ni
    }
  }

  switch dtype {
  case 0:
    t = "plain"
  case 1:
    t = "regex"
  case 2:
    t = "domain"
  case 3:
    t = "full"
  default:
    t = "domain"
  }
  return t, v, nil
}

func parseGeoSiteDump(b []byte, tag string, offset, limit int) ([]DumpItem, int, error) {
  tag = strings.TrimSpace(tag)
  if tag == "" {
    return nil, 0, errors.New("tag_required")
  }

  // Find entry with country_code == tag (case-insensitive)
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, 0, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, 0, err
      }
      i = next
      // Check tag first, and if matches parse domains with paging.
      ok, items, total, err := parseGeoSiteEntryDump(entryBytes, tag, offset, limit)
      if err != nil {
        return nil, 0, err
      }
      if ok {
        return items, total, nil
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, 0, err
    }
    i = ni
  }
  return nil, 0, fmt.Errorf("tag_not_found")
}

func parseGeoSiteEntryDump(b []byte, wantTag string, offset, limit int) (matched bool, items []DumpItem, total int, err error) {
  i := 0
  // One pass: once we know tag matches, we stream domains & collect page.
  items = make([]DumpItem, 0, limit)
  end := offset + limit
  idx := 0

  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return false, nil, 0, err
    }
    i = j
    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return false, nil, 0, err
      }
      i = next
      matched = strings.EqualFold(strings.TrimSpace(string(raw)), wantTag)

    case fn == 2 && wt == wtBytes: // domain
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return false, nil, 0, err
      }
      i = next
      if !matched {
        continue
      }
      t, v, err := parseDomainItem(raw)
      if err != nil {
        return false, nil, 0, err
      }
      if idx >= offset && idx < end {
        items = append(items, DumpItem{T: t, V: v})
      }
      idx++
      total++

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return false, nil, 0, err
      }
      i = ni
    }
  }

  if !matched {
    return false, nil, 0, nil
  }
  if offset >= total {
    return true, []DumpItem{}, total, nil
  }
  return true, items, total, nil
}

// ---- GeoIP ----


func parseCIDRForLookup(b []byte) (ip net.IP, prefix int, err error) {
  var ipBytes []byte
  var p uint64
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, 0, err
    }
    i = j
    switch {
    case fn == 1 && wt == wtBytes: // ip
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return nil, 0, err
      }
      i = next
      ipBytes = raw
    case fn == 2 && wt == wtVarint: // prefix
      vv, next, err := readVarint(b, i)
      if err != nil {
        return nil, 0, err
      }
      i = next
      p = vv
    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return nil, 0, err
      }
      i = ni
    }
  }
  if len(ipBytes) == 0 {
    return nil, 0, errors.New("bad_cidr_ip")
  }
  return net.IP(ipBytes), int(p), nil
}

// parseGeoIPLookup scans all tags and returns those that match the given IP.
func parseGeoIPLookup(b []byte, ip net.IP, maxTags int) ([]LookupMatch, error) {
  out := make([]LookupMatch, 0, 32)

  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, err
      }
      i = next

      tag, cnt, err := parseGeoIPEntryLookup(entryBytes, ip)
      if err != nil {
        return nil, err
      }
      if tag != "" && cnt > 0 {
        out = append(out, LookupMatch{Tag: tag, Count: cnt})
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, err
    }
    i = ni
  }

  sort.Slice(out, func(i, j int) bool {
    if out[i].Count != out[j].Count {
      return out[i].Count > out[j].Count
    }
    return strings.ToLower(out[i].Tag) < strings.ToLower(out[j].Tag)
  })
  if maxTags > 0 && len(out) > maxTags {
    out = out[:maxTags]
  }
  return out, nil
}

func parseGeoIPEntryLookup(b []byte, ipIn net.IP) (tag string, count int, err error) {
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", 0, err
    }
    i = j

    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      tag = strings.TrimSpace(string(raw))

    case fn == 2 && wt == wtBytes: // cidr
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next

      cidrIP, prefix, err := parseCIDRForLookup(raw)
      if err != nil {
        return "", 0, err
      }

      base := cidrIP
      bits := 128
      tip := ipIn

      // Determine address family based on CIDR base IP.
      if base4 := base.To4(); base4 != nil {
        bits = 32
        base = base4
        tip4 := tip.To4()
        if tip4 == nil {
          continue
        }
        tip = tip4
      } else {
        base = base.To16()
        if base == nil {
          continue
        }
        tip16 := tip.To16()
        if tip16 == nil {
          continue
        }
        tip = tip16
      }

      if prefix < 0 {
        continue
      }
      if bits == 32 && prefix > 32 {
        continue
      }
      if bits == 128 && prefix > 128 {
        continue
      }

      mask := net.CIDRMask(prefix, bits)
      if mask == nil {
        continue
      }
      netw := net.IPNet{IP: base.Mask(mask), Mask: mask}
      if netw.Contains(tip) {
        count++
      }

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", 0, err
      }
      i = ni
    }
  }
  return tag, count, nil
}


func parseGeoIPTags(b []byte) ([]TagStat, error) {
  out := make([]TagStat, 0, 256)
  // GeoIPList.entry = 1 (bytes)
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, err
      }
      i = next

      tag, cnt, err := parseGeoIPEntryTagAndCount(entryBytes)
      if err != nil {
        return nil, err
      }
      if tag != "" {
        out = append(out, TagStat{Tag: tag, Count: cnt})
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, err
    }
    i = ni
  }
  return out, nil
}

func parseGeoIPEntryTagAndCount(b []byte) (tag string, cidrs int, err error) {
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", 0, err
    }
    i = j

    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      tag = strings.TrimSpace(string(raw))

    case fn == 2 && wt == wtBytes: // cidr (repeated)
      _, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, err
      }
      i = next
      cidrs++

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", 0, err
      }
      i = ni
    }
  }
  return tag, cidrs, nil
}

func parseCIDRItem(b []byte) (ipStr string, prefix int, cidrStr string, err error) {
  var ipBytes []byte
  var p uint64
  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return "", 0, "", err
    }
    i = j
    switch {
    case fn == 1 && wt == wtBytes: // ip
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return "", 0, "", err
      }
      i = next
      ipBytes = raw
    case fn == 2 && wt == wtVarint: // prefix
      vv, next, err := readVarint(b, i)
      if err != nil {
        return "", 0, "", err
      }
      i = next
      p = vv
    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return "", 0, "", err
      }
      i = ni
    }
  }

  ip := net.IP(ipBytes)
  if len(ip) > 0 {
    ipStr = ip.String()
  }
  prefix = int(p)
  if ipStr != "" {
    cidrStr = fmt.Sprintf("%s/%d", ipStr, prefix)
  }
  return ipStr, prefix, cidrStr, nil
}

func parseGeoIPDump(b []byte, tag string, offset, limit int) ([]DumpItem, int, error) {
  tag = strings.TrimSpace(tag)
  if tag == "" {
    return nil, 0, errors.New("tag_required")
  }

  i := 0
  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return nil, 0, err
    }
    i = j
    if fn == 1 && wt == wtBytes {
      entryBytes, next, err := readBytesField(b, i)
      if err != nil {
        return nil, 0, err
      }
      i = next

      ok, items, total, err := parseGeoIPEntryDump(entryBytes, tag, offset, limit)
      if err != nil {
        return nil, 0, err
      }
      if ok {
        return items, total, nil
      }
      continue
    }
    ni, err := skip(b, i, wt)
    if err != nil {
      return nil, 0, err
    }
    i = ni
  }
  return nil, 0, fmt.Errorf("tag_not_found")
}

func parseGeoIPEntryDump(b []byte, wantTag string, offset, limit int) (matched bool, items []DumpItem, total int, err error) {
  i := 0
  items = make([]DumpItem, 0, limit)
  end := offset + limit
  idx := 0

  for i < len(b) {
    fn, wt, j, err := readKey(b, i)
    if err != nil {
      return false, nil, 0, err
    }
    i = j
    switch {
    case fn == 1 && wt == wtBytes: // country_code
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return false, nil, 0, err
      }
      i = next
      matched = strings.EqualFold(strings.TrimSpace(string(raw)), wantTag)

    case fn == 2 && wt == wtBytes: // cidr
      raw, next, err := readBytesField(b, i)
      if err != nil {
        return false, nil, 0, err
      }
      i = next
      if !matched {
        continue
      }
      ipStr, p, cidrStr, err := parseCIDRItem(raw)
      if err != nil {
        return false, nil, 0, err
      }
      if idx >= offset && idx < end {
        items = append(items, DumpItem{T: "cidr", V: cidrStr, IP: ipStr, Prefix: p, CIDR: cidrStr})
      }
      idx++
      total++

    default:
      ni, err := skip(b, i, wt)
      if err != nil {
        return false, nil, 0, err
      }
      i = ni
    }
  }

  if !matched {
    return false, nil, 0, nil
  }
  if offset >= total {
    return true, []DumpItem{}, total, nil
  }
  return true, items, total, nil
}
