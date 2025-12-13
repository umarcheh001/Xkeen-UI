// Indent guides overlay for CodeMirror 5.
// Draws vertical guides for each indentation level at the start of the line.
// Works with spaces and tabs and exposes the CSS class "cm-indent-guide".

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") { // CommonJS
    mod(require("codemirror"));
  } else if (typeof define == "function" && define.amd) { // AMD
    define(["codemirror"], mod);
  } else { // Plain browser env
    mod(CodeMirror);
  }
})(function(CodeMirror) {
  "use strict";

  function makeOverlay(cm) {
    var indentUnit = cm.getOption("indentUnit") || 2;

    return {
      token: function(stream) {
        // Work only at the start of the line.
        if (stream.sol()) {
          var col = 0;
          var ch;

          while ((ch = stream.peek()) != null && (ch === " " || ch === "\t")) {
            stream.next(); // consume one whitespace char

            // Advance "virtual" column taking tabs into account.
            col += (ch === "\t") ? indentUnit : 1;

            // At each full indent step mark this position.
            if (col % indentUnit === 0) {
              return "indent-guide"; // -> CSS class "cm-indent-guide"
            }
          }
        }

        // Skip the rest of the line.
        stream.skipToEnd();
        return null;
      }
    };
  }

  CodeMirror.defineOption("showIndentGuides", false, function(cm, val, old) {
    if (old && old !== CodeMirror.Init && cm.state.indentGuides) {
      cm.removeOverlay(cm.state.indentGuides);
      cm.state.indentGuides = null;
    }

    if (val) {
      var overlay = makeOverlay(cm);
      cm.state.indentGuides = overlay;
      cm.addOverlay(overlay);
    }
  });
});
