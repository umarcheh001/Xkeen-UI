package geodat

import (
  "encoding/json"
  "errors"
  "fmt"
  "net"
  "os"
  "sort"
  "strings"

  router "github.com/v2fly/v2ray-core/v4/app/router"
  "google.golang.org/protobuf/proto"
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
    var list router.GeoSiteList
    if err := proto.Unmarshal(b, &list); err != nil {
      return TagsResult{}, err
    }
    entry := list.GetEntry()
    out.Tags = make([]TagStat, 0, len(entry))
    for _, gs := range entry {
      if gs == nil {
        continue
      }
      tag := strings.TrimSpace(gs.GetCountryCode())
      if tag == "" {
        continue
      }
      out.Tags = append(out.Tags, TagStat{Tag: tag, Count: len(gs.GetDomain())})
    }
  } else {
    var list router.GeoIPList
    if err := proto.Unmarshal(b, &list); err != nil {
      return TagsResult{}, err
    }
    entry := list.GetEntry()
    out.Tags = make([]TagStat, 0, len(entry))
    for _, gi := range entry {
      if gi == nil {
        continue
      }
      tag := strings.TrimSpace(gi.GetCountryCode())
      if tag == "" {
        continue
      }
      out.Tags = append(out.Tags, TagStat{Tag: tag, Count: len(gi.GetCidr())})
    }
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
    var list router.GeoSiteList
    if err := proto.Unmarshal(b, &list); err != nil {
      return DumpResult{}, err
    }
    var found *router.GeoSite
    for _, gs := range list.GetEntry() {
      if gs == nil {
        continue
      }
      if strings.EqualFold(gs.GetCountryCode(), tag) {
        found = gs
        break
      }
    }
    if found == nil {
      return DumpResult{}, fmt.Errorf("tag_not_found")
    }

    domains := found.GetDomain()
    out.Total = len(domains)
    if offset >= out.Total {
      out.Items = []DumpItem{}
      return out, nil
    }
    end := offset + limit
    if end > out.Total {
      end = out.Total
    }

    out.Items = make([]DumpItem, 0, end-offset)
    for _, d := range domains[offset:end] {
      if d == nil {
        continue
      }
      t := strings.ToLower(d.GetType().String())
      if t == "" {
        t = "domain"
      }
      out.Items = append(out.Items, DumpItem{T: t, V: d.GetValue()})
    }

  } else {
    var list router.GeoIPList
    if err := proto.Unmarshal(b, &list); err != nil {
      return DumpResult{}, err
    }
    var found *router.GeoIP
    for _, gi := range list.GetEntry() {
      if gi == nil {
        continue
      }
      if strings.EqualFold(gi.GetCountryCode(), tag) {
        found = gi
        break
      }
    }
    if found == nil {
      return DumpResult{}, fmt.Errorf("tag_not_found")
    }

    cidrs := found.GetCidr()
    out.Total = len(cidrs)
    if offset >= out.Total {
      out.Items = []DumpItem{}
      return out, nil
    }
    end := offset + limit
    if end > out.Total {
      end = out.Total
    }

    out.Items = make([]DumpItem, 0, end-offset)
    for _, c := range cidrs[offset:end] {
      if c == nil {
        continue
      }
      ip := net.IP(c.GetIp())
      ipStr := ""
      if len(ip) == 4 || len(ip) == 16 {
        ipStr = ip.String()
      } else if len(ip) > 0 {
        // Attempt to normalize unknown lengths
        ipStr = net.IP(ip).String()
      }
      p := int(c.GetPrefix())
      cidrStr := ""
      if ipStr != "" && p >= 0 {
        cidrStr = fmt.Sprintf("%s/%d", ipStr, p)
      }
      out.Items = append(out.Items, DumpItem{T: "cidr", V: cidrStr, IP: ipStr, Prefix: p, CIDR: cidrStr})
    }
  }

  return out, nil
}

func ToJSON(v any, pretty bool) ([]byte, error) {
  if pretty {
    return json.MarshalIndent(v, "", "  ")
  }
  return json.Marshal(v)
}
