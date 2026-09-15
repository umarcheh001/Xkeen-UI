package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"happ-decryptor/internal/happ"
)

// Filled via -ldflags "-X main.version=... -X main.commit=... -X main.date=..."
var (
	version = "dev"
	commit  = ""
	date    = ""
)

const name = "happ-decrypt-universal"

// Exit codes.
const (
	exitOK         = 0
	exitDamaged    = 1 // the link is malformed or does not decrypt
	exitUsage      = 2
	exitNoKeys     = 3 // key files are missing or unreadable
	exitUnknownKey = 4 // the link needs a key the files do not have: update the Happ keys
)

func main() {
	var stdin io.Reader
	// Read stdin only when something is piped in, so a run from a terminal does not wait for input.
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeCharDevice == 0 {
		stdin = os.Stdin
	}
	os.Exit(run(os.Args[1:], stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	assets := fs.String("assets", "", "directory with crypt5-keys.json and legacy_keys.json")
	asJSON := fs.Bool("json", false, "print the result or the error as JSON on stdout")
	selftest := fs.Bool("selftest", false, "describe the key files as JSON and exit")
	showVersion := fs.Bool("version", false, "print the version and exit")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printUsage(stdout, fs)
			return exitOK
		}
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
		printUsage(stderr, fs)
		return exitUsage
	}
	if *showVersion {
		fmt.Fprintln(stdout, versionLine())
		return exitOK
	}
	dir := assetsDir(*assets)
	if *selftest {
		return runSelftest(dir, stdout)
	}

	if fs.NArg() > 1 {
		fmt.Fprintf(stderr, "%s: expected one link, got %d arguments\n", name, fs.NArg())
		printUsage(stderr, fs)
		return exitUsage
	}
	link, err := readLink(fs.Arg(0), stdin)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
		return exitUsage
	}
	if link == "" {
		printUsage(stderr, fs)
		return exitUsage
	}

	res, err := decrypt(dir, link)
	if err != nil {
		return reportError(err, *asJSON, stdout, stderr)
	}
	if *asJSON {
		writeJSON(stdout, struct {
			OK     bool   `json:"ok"`
			Format string `json:"format"`
			Layout string `json:"layout,omitempty"`
			URL    string `json:"url"`
		}{true, res.Format, res.Layout, res.Text})
	} else {
		fmt.Fprintln(stdout, res.Text)
	}
	return exitOK
}

func printUsage(w io.Writer, fs *flag.FlagSet) {
	fmt.Fprintf(w, "usage: %s [flags] <happ://crypt…/ link | @file | ->\n", name)
	fmt.Fprintln(w, "Decrypts a Happ subscription link and prints the URL.")
	fmt.Fprintln(w, "")
	fs.SetOutput(w)
	fs.PrintDefaults()
	fs.SetOutput(io.Discard)
	fmt.Fprintln(w, "")
	fmt.Fprintf(w, "Keys are read from -assets, $HAPP_DECRYPT_ASSETS or <binary>.assets.\n")
	fmt.Fprintln(w, "Exit codes: 0 ok, 1 damaged link, 2 usage, 3 key files missing, 4 unknown key (update the Happ keys).")
}

func versionLine() string {
	switch {
	case commit != "" && date != "":
		return fmt.Sprintf("%s %s (%s, %s)", name, version, commit, date)
	case commit != "":
		return fmt.Sprintf("%s %s (%s)", name, version, commit)
	}
	return fmt.Sprintf("%s %s", name, version)
}

func assetsDir(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if env := os.Getenv("HAPP_DECRYPT_ASSETS"); env != "" {
		return env
	}
	exe, err := os.Executable()
	if err != nil {
		return name + ".assets"
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe + ".assets"
}

// readLink takes the link from the argument, from a file named "@path", or
// from stdin when the argument is "-" or absent.
func readLink(arg string, stdin io.Reader) (string, error) {
	switch {
	case strings.HasPrefix(arg, "@"):
		data, err := os.ReadFile(arg[1:])
		if err != nil {
			return "", fmt.Errorf("read link: %w", err)
		}
		return strings.TrimSpace(string(data)), nil
	case arg != "" && arg != "-":
		return strings.TrimSpace(arg), nil
	case stdin != nil:
		data, err := io.ReadAll(stdin)
		if err != nil {
			return "", fmt.Errorf("read link from stdin: %w", err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return "", nil
}

func decrypt(dir, link string) (happ.Result, error) {
	k, err := happ.LoadKeyring(dir)
	if err != nil {
		return happ.Result{}, err
	}
	return k.Decrypt(link)
}

func runSelftest(dir string, stdout io.Writer) int {
	r := happ.Inspect(dir)
	writeJSON(stdout, struct {
		Version string `json:"version"`
		Commit  string `json:"commit,omitempty"`
		happ.Report
	}{version, commit, r})
	if !r.Usable() {
		return exitNoKeys
	}
	return exitOK
}

func reportError(err error, asJSON bool, stdout, stderr io.Writer) int {
	code, exit := "bad_link", exitDamaged
	switch {
	case errors.Is(err, happ.ErrUnknownKey):
		code, exit = "unknown_key", exitUnknownKey
	case errors.Is(err, happ.ErrNoKeys):
		code, exit = "no_keys", exitNoKeys
	case errors.Is(err, happ.ErrCorrupt):
		code = "corrupt"
	}
	if asJSON {
		writeJSON(stdout, struct {
			OK      bool   `json:"ok"`
			Error   string `json:"error"`
			Message string `json:"message"`
		}{false, code, strings.TrimPrefix(err.Error(), code+": ")})
	} else {
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
	}
	return exit
}

func writeJSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // keep & in subscription URLs readable
	_ = enc.Encode(v)
}
