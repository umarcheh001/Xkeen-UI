package geodat

import "regexp"

// matchRegex compiles pattern and matches it against s.
// On invalid patterns, it returns false.
//
// Note: we intentionally keep this minimal (no caching) to keep the binary small.
func matchRegex(pattern, s string) bool {
  re, err := regexp.Compile(pattern)
  if err != nil {
    return false
  }
  return re.MatchString(s)
}
