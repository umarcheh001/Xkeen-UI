package main

import (
	"flag"
	"fmt"
	"io"
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
	_, _ = os.Stdout.Write(b)
	_, _ = os.Stdout.Write([]byte("\n"))
	os.Exit(exitCode)
}

func isHelpToken(s string) bool {
	switch s {
	case "-h", "--help", "-help", "help":
		return true
	default:
		return false
	}
}

func hasHelp(args []string) bool {
	for _, a := range args {
		if isHelpToken(a) {
			return true
		}
	}
	return false
}

func printRootUsage(w io.Writer) {
	fmt.Fprintln(w, "xk-geodat — GeoIP/GeoSite .dat inspector for Xray/Xkeen-UI")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  xk-geodat <command> [flags]")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Commands:")
	fmt.Fprintln(w, "  tags        List tags inside DAT (GeoSite/GeoIP)")
	fmt.Fprintln(w, "  dump        Dump items for a tag (paged)")
	fmt.Fprintln(w, "  tag         Alias for 'dump' (backward-compatible)")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Global flags:")
	fmt.Fprintln(w, "  -h, --help  Show this help")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Examples:")
	fmt.Fprintln(w, "  xk-geodat tags --kind geosite --path /opt/etc/xray/geosite.dat")
	fmt.Fprintln(w, "  xk-geodat dump --kind geosite --path /opt/etc/xray/geosite.dat --tag google --offset 0 --limit 200")
}

func main() {
	if len(os.Args) < 2 {
		printRootUsage(os.Stderr)
		os.Exit(2)
	}

	cmd := os.Args[1]
	if isHelpToken(cmd) {
		printRootUsage(os.Stdout)
		os.Exit(0)
	}

	switch cmd {
	case "tags":
		fs := flag.NewFlagSet("tags", flag.ContinueOnError)
		// We fully control output (JSON + help). Silence flag's own printing.
		fs.SetOutput(io.Discard)

		kind := fs.String("kind", "", "geosite|geoip")
		path := fs.String("path", "", "path to .dat")
		pretty := fs.Bool("pretty", false, "pretty JSON")

		if hasHelp(os.Args[2:]) {
			fs.SetOutput(os.Stdout)
			fmt.Fprintln(os.Stdout, "usage: xk-geodat tags --kind geosite|geoip --path /path/file.dat [--pretty]")
			fmt.Fprintln(os.Stdout, "")
			fs.PrintDefaults()
			os.Exit(0)
		}

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

	case "dump", "tag": // 'tag' kept for backward-compatibility with older UI/backend
		fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
		fs.SetOutput(io.Discard)

		kind := fs.String("kind", "", "geosite|geoip")
		path := fs.String("path", "", "path to .dat")
		tag := fs.String("tag", "", "tag/country_code")
		offset := fs.Int("offset", 0, "offset")
		limit := fs.Int("limit", 200, "limit (max 2000)")
		pretty := fs.Bool("pretty", false, "pretty JSON")

		if hasHelp(os.Args[2:]) {
			fs.SetOutput(os.Stdout)
			fmt.Fprintln(os.Stdout, "usage: xk-geodat dump --kind geosite|geoip --path /path/file.dat --tag NAME [--offset N] [--limit N] [--pretty]")
			fmt.Fprintln(os.Stdout, "       xk-geodat tag  (alias of dump) ...")
			fmt.Fprintln(os.Stdout, "")
			fs.PrintDefaults()
			os.Exit(0)
		}

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
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		printRootUsage(os.Stderr)
		os.Exit(2)
	}
}
