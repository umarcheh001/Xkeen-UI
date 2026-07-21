# Third-party notices

The Android companion packages the following focused upstream asset instead of embedding the
Acode or AcodeX applications:

- **xterm.js** and its fit/search addons, copied from the existing Xkeen-UI vendor bundle under
  `xkeen-ui/static/xterm/`. Copyright (c) 2014 The xterm.js authors and contributors; MIT License.
  The Android core bundle includes the one-line upstream composition fix from xterm.js PR #5024
  to prevent duplicated input when an IME starts a new composition before the previous one settles.

The editor and PTY integration in `io.xkeen.mobile.app` are Xkeen-native implementations. Their
interaction design was informed by the MIT-licensed Acode and AcodeX projects, but their Cordova,
plugin runtime, Termux/AXS backend, AI, VNC, file explorer and general-purpose IDE shell are not
included.
