package geodat

import (
  "encoding/json"
  "errors"
  "fmt"
  "os"
  "sort"
  "strings"
)

type Meta struct {
  Size  int64 `json:"size"`
  MTime int64 `json:"mtime"`
}

type TagStat struct {
  Tag   string `json:"tag"`
  Count int    `json:"count"`
}

type TagsResult struct {
  OK   bool      `json:"ok"`
  Kind string    `json:"kind"`
  Path string    `json:"path"`
  Meta Meta      `json:"meta"`
  Tags []TagStat `json:"tags"`
}

type DumpItem struct {
  T string `json:"t"`
  V string `json:"v"`
  // GeoIP extras
  IP     string `json:"ip,omitempty"`
  Prefix int    `json:"prefix,omitempty"`
  CIDR   string `json:"cidr,omitempty"`
}

type DumpResult struct {
  OK     bool       `json:"ok"`
  Kind   string     `json:"kind"`
  Path   string     `json:"path"`
  Tag    string     `json:"tag"`
  Offset int        `json:"offset"`
  Limit  int        `json:"limit"`
  Total  int        `json:"total"`
  Items  []DumpItem `json:"items"`
  Meta   Meta       `json:"meta"`
}


type LookupMatch struct {
  Tag   string `json:"tag"`
  Count int    `json:"count"`
}

type LookupResult struct {
  OK      bool          `json:"ok"`
  Kind    string        `json:"kind"`
  Path    string        `json:"path"`
  Value   string        `json:"value"`
  Meta    Meta          `json:"meta"`
  Matches []LookupMatch `json:"matches"`
}

func statMeta(path string) (Meta, error) {
  st, err := os.Stat(path)
  if err != nil {
    return Meta{}, err
  }
  return Meta{Size: st.Size(), MTime: st.ModTime().Unix()}, nil
}

func readFile(path string) ([]byte, Meta, error) {
  meta, err := statMeta(path)
  if err != nil {
    return nil, Meta{}, err
  }
  b, err := os.ReadFile(path)
  if err != nil {
    return nil, Meta{}, err
  }
  return b, meta, nil
}

func NormalizeKind(kind string) (string, error) {
  k := strings.ToLower(strings.TrimSpace(kind))
  switch k {
  case "geosite", "geoip":
    return k, nil
  default:
    return "", fmt.Errorf("bad_kind")
  }
}

func Tags(kind, path string) (TagsResult, error) {
  k, err := NormalizeKind(kind)
  if err != nil {
    return TagsResult{}, err
  }
  b, meta, err := readFile(path)
  if err != nil {
    return TagsResult{}, err
  }

  out := TagsResult{OK: true, Kind: k, Path: path, Meta: meta}

  if k == "geosite" {
    tags, err := parseGeoSiteTags(b)
    if err != nil {
      return TagsResult{}, err
    }
    out.Tags = tags
  } else {
    tags, err := parseGeoIPTags(b)
    if err != nil {
      return TagsResult{}, err
    }
    out.Tags = tags
  }

  sort.Slice(out.Tags, func(i, j int) bool {
    return strings.ToLower(out.Tags[i].Tag) < strings.ToLower(out.Tags[j].Tag)
  })

  return out, nil
}

func Dump(kind, path, tag string, offset, limit int) (DumpResult, error) {
  k, err := NormalizeKind(kind)
  if err != nil {
    return DumpResult{}, err
  }
  tag = strings.TrimSpace(tag)
  if tag == "" {
    return DumpResult{}, errors.New("tag_required")
  }
  if offset < 0 {
    offset = 0
  }
  if limit <= 0 {
    limit = 200
  }
  if limit > 2000 {
    limit = 2000
  }

  b, meta, err := readFile(path)
  if err != nil {
    return DumpResult{}, err
  }

  out := DumpResult{OK: true, Kind: k, Path: path, Tag: tag, Offset: offset, Limit: limit, Meta: meta}

  if k == "geosite" {
    items, total, err := parseGeoSiteDump(b, tag, offset, limit)
    if err != nil {
      return DumpResult{}, err
    }
    out.Total = total
    out.Items = items
  } else {
    items, total, err := parseGeoIPDump(b, tag, offset, limit)
    if err != nil {
      return DumpResult{}, err
    }
    out.Total = total
    out.Items = items
  }

  return out, nil

}

// Lookup finds matching tags for a domain (geosite) or ip (geoip).
// maxTags limits the result size (0 = unlimited).
func Lookup(kind, path, value string, maxTags int) (LookupResult, error) {
  k, err := NormalizeKind(kind)
  if err != nil {
    return LookupResult{}, err
  }
  value = strings.TrimSpace(value)
  if value == "" {
    return LookupResult{}, errors.New("value_required")
  }

  b, meta, err := readFile(path)
  if err != nil {
    return LookupResult{}, err
  }

  out := LookupResult{OK: true, Kind: k, Path: path, Value: value, Meta: meta}

  if k == "geosite" {
    dom, err := normalizeDomainInput(value)
    if err != nil {
      return LookupResult{}, err
    }
    matches, err := parseGeoSiteLookup(b, dom, maxTags)
    if err != nil {
      return LookupResult{}, err
    }
    out.Matches = matches
  } else {
    ip, err := normalizeIPInput(value)
    if err != nil {
      return LookupResult{}, err
    }
    matches, err := parseGeoIPLookup(b, ip, maxTags)
    if err != nil {
      return LookupResult{}, err
    }
    out.Matches = matches
  }

  return out, nil
}


func ToJSON(v any, pretty bool) ([]byte, error) {
  if pretty {
    return json.MarshalIndent(v, "", "  ")
  }
  return json.Marshal(v)
}
