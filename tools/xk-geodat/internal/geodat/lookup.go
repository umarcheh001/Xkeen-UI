package geodat

import (
  "errors"
  "net"
  "net/url"
  "strings"
)

// normalizeDomainInput accepts:
//  - domain (example.com)
//  - host:port
//  - URL (https://example.com/path)
// and returns a canonical lower-cased hostname without brackets/port.
func normalizeDomainInput(v string) (string, error) {
  s := strings.TrimSpace(v)
  if s == "" {
    return "", errors.New("value_required")
  }

  // URL → host
  if strings.Contains(s, "://") {
    u, err := url.Parse(s)
    if err == nil {
      if u.Host != "" {
        s = u.Host
      } else if u.Hostname() != "" {
        s = u.Hostname()
      }
    }
  }

  // Strip path/query if user pasted something like example.com/path
  if i := strings.IndexAny(s, "/?#"); i >= 0 {
    s = s[:i]
  }

  // Strip brackets for IPv6 literals. For domain lookup, keep as-is.
  s = strings.TrimPrefix(s, "[")
  s = strings.TrimSuffix(s, "]")

  // host:port
  if h, _, err := net.SplitHostPort(s); err == nil {
    s = h
  }

  s = strings.TrimSpace(s)
  s = strings.TrimSuffix(s, ".")
  s = strings.ToLower(s)
  if s == "" {
    return "", errors.New("bad_domain")
  }
  return s, nil
}

// normalizeIPInput accepts:
//  - ip
//  - ip:port
//  - [ipv6]:port
//  - ip/cidr (takes IP part)
//  - URL (takes hostname)
func normalizeIPInput(v string) (net.IP, error) {
  s := strings.TrimSpace(v)
  if s == "" {
    return nil, errors.New("value_required")
  }

  if strings.Contains(s, "://") {
    u, err := url.Parse(s)
    if err == nil {
      if u.Host != "" {
        s = u.Host
      } else if u.Hostname() != "" {
        s = u.Hostname()
      }
    }
  }

  if i := strings.IndexAny(s, "/?#"); i >= 0 {
    s = s[:i]
  }

  // Strip cidr suffix
  if i := strings.IndexByte(s, '/'); i >= 0 {
    s = s[:i]
  }

  // host:port
  if h, _, err := net.SplitHostPort(s); err == nil {
    s = h
  }

  s = strings.TrimPrefix(s, "[")
  s = strings.TrimSuffix(s, "]")
  s = strings.TrimSpace(s)

  ip := net.ParseIP(s)
  if ip == nil {
    return nil, errors.New("bad_ip")
  }
  return ip, nil
}

func matchDomainRule(ruleType, ruleValue, domain string) bool {
  raw := strings.TrimSpace(ruleValue)
  if raw == "" {
    return false
  }

  // Regex patterns should NOT be lower-cased (would change semantics).
  if ruleType == "regex" {
    return matchRegex(raw, domain)
  }

  v := strings.ToLower(raw)
  switch ruleType {
  case "full":
    return domain == v
  case "domain":
    return domain == v || strings.HasSuffix(domain, "."+v)
  case "plain":
    return strings.Contains(domain, v)
  default:
    // treat unknown as suffix match
    return domain == v || strings.HasSuffix(domain, "."+v)
  }
}
