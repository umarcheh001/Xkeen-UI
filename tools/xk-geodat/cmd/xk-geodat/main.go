package main

import (
  "flag"
  "fmt"
  "os"

  "xk-geodat/internal/geodat"
)

type ErrOut struct {
  OK     bool   `json:"ok"`
  Error  string `json:"error"`
  Detail string `json:"details,omitempty"`
}

func printJSON(v any, pretty bool, exitCode int) {
  b, err := geodat.ToJSON(v, pretty)
  if err != nil {
    fmt.Fprintf(os.Stderr, "json_marshal_failed: %v\n", err)
    os.Exit(2)
  }
  os.Stdout.Write(b)
  os.Stdout.Write([]byte("\n"))
  os.Exit(exitCode)
}

func main() {
  if len(os.Args) < 2 {
    fmt.Fprintln(os.Stderr, "usage: xk-geodat <tags|dump> [flags]")
    os.Exit(2)
  }

  cmd := os.Args[1]

  switch cmd {
  case "tags":
    fs := flag.NewFlagSet("tags", flag.ContinueOnError)
    fs.SetOutput(os.Stderr)
    kind := fs.String("kind", "", "geosite|geoip")
    path := fs.String("path", "", "path to .dat")
    pretty := fs.Bool("pretty", false, "pretty JSON")
    if err := fs.Parse(os.Args[2:]); err != nil {
      printJSON(ErrOut{OK: false, Error: "bad_args", Detail: err.Error()}, *pretty, 2)
    }
    if *kind == "" || *path == "" {
      printJSON(ErrOut{OK: false, Error: "kind_and_path_required"}, *pretty, 2)
    }

    res, err := geodat.Tags(*kind, *path)
    if err != nil {
      printJSON(ErrOut{OK: false, Error: "tags_failed", Detail: err.Error()}, *pretty, 1)
    }
    printJSON(res, *pretty, 0)

  case "dump":
    fs := flag.NewFlagSet("dump", flag.ContinueOnError)
    fs.SetOutput(os.Stderr)
    kind := fs.String("kind", "", "geosite|geoip")
    path := fs.String("path", "", "path to .dat")
    tag := fs.String("tag", "", "tag/country_code")
    offset := fs.Int("offset", 0, "offset")
    limit := fs.Int("limit", 200, "limit (max 2000)")
    pretty := fs.Bool("pretty", false, "pretty JSON")
    if err := fs.Parse(os.Args[2:]); err != nil {
      printJSON(ErrOut{OK: false, Error: "bad_args", Detail: err.Error()}, *pretty, 2)
    }
    if *kind == "" || *path == "" || *tag == "" {
      printJSON(ErrOut{OK: false, Error: "kind_path_tag_required"}, *pretty, 2)
    }

    res, err := geodat.Dump(*kind, *path, *tag, *offset, *limit)
    if err != nil {
      printJSON(ErrOut{OK: false, Error: "dump_failed", Detail: err.Error()}, *pretty, 1)
    }
    printJSON(res, *pretty, 0)

  default:
    fmt.Fprintf(os.Stderr, "unknown command: %s\n", cmd)
    os.Exit(2)
  }
}
