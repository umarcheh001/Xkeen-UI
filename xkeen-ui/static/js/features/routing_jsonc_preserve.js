(() => {
  "use strict";

  // JSONC preserve helpers (WIP, Level B).
  // This module is intentionally self-contained and unused in early commits.
  // Later commits will use it to patch rules/balancers/domainStrategy directly in JSONC text.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};

  function isWs(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  function getLineIndent(text, pos) {
    const s = String(text || "");
    const i = Math.max(0, Math.min(s.length, Number.isFinite(pos) ? pos : 0));
    const nl = s.lastIndexOf("\n", i - 1);
    const from = nl >= 0 ? nl + 1 : 0;
    let j = from;
    while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
    return s.slice(from, j);
  }

  function skipWsAndComments(text, from, end) {
    const s = String(text || "");
    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);
    let i = Math.max(0, Number.isFinite(from) ? from : 0);

    while (i < to) {
      const ch = s[i];
      const next = (i + 1 < to) ? s[i + 1] : "";

      if (isWs(ch)) {
        i++;
        continue;
      }

      // line comment
      if (ch === "/" && next === "/") {
        i += 2;
        while (i < to && s[i] !== "\n") i++;
        continue;
      }

      // block comment
      if (ch === "/" && next === "*") {
        i += 2;
        while (i + 1 < to) {
          if (s[i] === "*" && s[i + 1] === "/") {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }

      break;
    }

    return i;
  }

  function readQuotedString(text, start, end) {
    const s = String(text || "");
    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);
    const i0 = Number.isFinite(start) ? start : -1;
    if (i0 < 0 || i0 >= to) return null;
    const q = s[i0];
    if (q !== "\"" && q !== "'") return null;
    let i = i0 + 1;
    let esc = false;
    while (i < to) {
      const ch = s[i];
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === q) {
        return { quote: q, start: i0, end: i + 1, raw: s.slice(i0, i + 1) };
      }
      i++;
    }
    return null;
  }

  function rtrimWs(text, from, to) {
    const s = String(text || "");
    let i = Math.max(0, Number.isFinite(to) ? to : s.length);
    const lo = Math.max(0, Number.isFinite(from) ? from : 0);
    while (i > lo && isWs(s[i - 1])) i--;
    return i;
  }

  /**
   * Scan JSON/JSONC text, tracking whether the cursor is currently inside a string or a comment.
   * Calls `onChar(i, ch, state)` for each character.
   *
   * state = {
   *   inString: boolean,
   *   stringQuote: '"' | "'" | '',
   *   inLineComment: boolean,
   *   inBlockComment: boolean,
   * }
   */
  function scanJsonc(text, onChar, start, end) {
    const s = String(text || "");
    const st = {
      inString: false,
      stringQuote: "",
      inLineComment: false,
      inBlockComment: false,
      _escape: false,
    };

    const from = Math.max(0, Number.isFinite(start) ? start : 0);
    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);

    for (let i = from; i < to; i++) {
      const ch = s[i];
      const next = (i + 1 < to) ? s[i + 1] : "";

      // In string
      if (st.inString) {
        if (st._escape) {
          st._escape = false;
        } else if (ch === "\\") {
          st._escape = true;
        } else if (ch === st.stringQuote) {
          st.inString = false;
          st.stringQuote = "";
        }

        if (typeof onChar === "function") {
          onChar(i, ch, {
            inString: st.inString,
            stringQuote: st.stringQuote,
            inLineComment: st.inLineComment,
            inBlockComment: st.inBlockComment,
          });
        }
        continue;
      }

      // In line comment
      if (st.inLineComment) {
        if (ch === "\n") st.inLineComment = false;
        if (typeof onChar === "function") {
          onChar(i, ch, {
            inString: st.inString,
            stringQuote: st.stringQuote,
            inLineComment: st.inLineComment,
            inBlockComment: st.inBlockComment,
          });
        }
        continue;
      }

      // In block comment
      if (st.inBlockComment) {
        if (ch === "*" && next === "/") {
          st.inBlockComment = false;
          // Emit current char, and let the loop emit '/' on next step.
        }
        if (typeof onChar === "function") {
          onChar(i, ch, {
            inString: st.inString,
            stringQuote: st.stringQuote,
            inLineComment: st.inLineComment,
            inBlockComment: st.inBlockComment,
          });
        }
        continue;
      }

      // Enter string
      if (ch === "\"" || ch === "'") {
        st.inString = true;
        st.stringQuote = ch;
        st._escape = false;
      }

      // Enter comment
      if (!st.inString && ch === "/" && next === "/") {
        st.inLineComment = true;
      } else if (!st.inString && ch === "/" && next === "*") {
        st.inBlockComment = true;
      }

      if (typeof onChar === "function") {
        onChar(i, ch, {
          inString: st.inString,
          stringQuote: st.stringQuote,
          inLineComment: st.inLineComment,
          inBlockComment: st.inBlockComment,
        });
      }
    }

    return {
      inString: st.inString,
      stringQuote: st.stringQuote,
      inLineComment: st.inLineComment,
      inBlockComment: st.inBlockComment,
    };
  }

  /**
   * Find matching closing bracket/brace ignoring strings and comments.
   * Returns index of the matching close char, or -1 if not found.
   */
  function findMatchingBracket(text, openPos, openChar, closeChar, end) {
    const s = String(text || "");
    const pos = Number.isFinite(openPos) ? openPos : -1;
    if (pos < 0 || pos >= s.length) return -1;
    if (s[pos] !== openChar) return -1;

    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);
    let depth = 1;
    let inString = false;
    let quote = "";
    let esc = false;
    let inLine = false;
    let inBlock = false;

    for (let i = pos + 1; i < to; i++) {
      const ch = s[i];
      const next = (i + 1 < to) ? s[i + 1] : "";

      if (inString) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === quote) {
          inString = false;
          quote = "";
        }
        continue;
      }
      if (inLine) {
        if (ch === "\n") inLine = false;
        continue;
      }
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i++;
        }
        continue;
      }

      if (ch === "\"" || ch === "'") {
        inString = true;
        quote = ch;
        esc = false;
        continue;
      }
      if (ch === "/" && next === "/") {
        inLine = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i++;
        continue;
      }

      if (ch === openChar) {
        depth++;
        continue;
      }
      if (ch === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function readValueRange(text, valueStart, end) {
    const s = String(text || "");
    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);
    let i = skipWsAndComments(s, valueStart, to);
    if (i < 0 || i >= to) return null;
    const ch = s[i];

    if (ch === "{") {
      const close = findMatchingBracket(s, i, "{", "}", to);
      return close >= 0 ? { type: "object", start: i, end: close + 1 } : null;
    }
    if (ch === "[") {
      const close = findMatchingBracket(s, i, "[", "]", to);
      return close >= 0 ? { type: "array", start: i, end: close + 1 } : null;
    }
    if (ch === "\"" || ch === "'") {
      const qs = readQuotedString(s, i, to);
      return qs ? { type: "string", start: i, end: qs.end } : null;
    }

    // Primitive (true/false/null/number).
    let j = i;
    let inLine = false;
    let inBlock = false;

    while (j < to) {
      const c = s[j];
      const next = (j + 1 < to) ? s[j + 1] : "";

      if (inLine) {
        if (c === "\n") inLine = false;
        j++;
        continue;
      }
      if (inBlock) {
        if (c === "*" && next === "/") {
          inBlock = false;
          j += 2;
          continue;
        }
        j++;
        continue;
      }

      if (c === "/" && next === "/") {
        // Comment after primitive value.
        break;
      }
      if (c === "/" && next === "*") {
        break;
      }

      if (c === "," || c === "}" || c === "]") {
        break;
      }
      j++;
    }

    const endTrim = rtrimWs(s, i, j);
    return { type: "primitive", start: i, end: endTrim };
  }

  function locateRootObject(text) {
    const s = String(text || "");
    const i = skipWsAndComments(s, 0, s.length);
    if (i < 0 || i >= s.length) return null;
    if (s[i] !== "{") return null;
    const close = findMatchingBracket(s, i, "{", "}", s.length);
    if (close < 0) return null;
    return { start: i, end: close + 1 };
  }

  /**
   * Locate a key's value range within an object (top-level keys only).
   * objRange: {start, end} where start points to '{' and end is exclusive.
   */
  function locateValueByKey(text, objRange, key) {
    const s = String(text || "");
    if (!objRange || !Number.isFinite(objRange.start) || !Number.isFinite(objRange.end)) return null;
    const start = objRange.start;
    const end = Math.min(s.length, objRange.end);
    if (start < 0 || end <= start) return null;
    if (s[start] !== "{") return null;

    let i = start + 1;
    let brace = 1;
    let bracket = 0;
    let inString = false;
    let quote = "";
    let esc = false;
    let inLine = false;
    let inBlock = false;

    while (i < end) {
      const ch = s[i];
      const next = (i + 1 < end) ? s[i + 1] : "";

      if (inString) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === quote) {
          inString = false;
          quote = "";
        }
        i++;
        continue;
      }
      if (inLine) {
        if (ch === "\n") inLine = false;
        i++;
        continue;
      }
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (ch === "/" && next === "/") {
        inLine = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 2;
        continue;
      }

      // Only consider top-level keys in this object.
      if ((ch === "\"" || ch === "'") && brace === 1 && bracket === 0) {
        const qs = readQuotedString(s, i, end);
        if (!qs) {
          // Should not happen, but keep scanning.
          inString = true;
          quote = ch;
          esc = false;
          i++;
          continue;
        }

        const keyText = qs.raw.slice(1, -1);
        let j = skipWsAndComments(s, qs.end, end);
        if (j < end && s[j] === ":") {
          const valueStart = skipWsAndComments(s, j + 1, end);
          const vr = readValueRange(s, valueStart, end);
          if (keyText === key && vr) {
            return {
              key: keyText,
              keyStart: qs.start,
              keyEnd: qs.end,
              colonPos: j,
              start: vr.start,
              end: vr.end,
              type: vr.type,
            };
          }

          // Skip over the value to continue searching other keys.
          if (vr) {
            i = vr.end;
            continue;
          }
        }
        i = qs.end;
        continue;
      }

      if (ch === "\"" || ch === "'") {
        inString = true;
        quote = ch;
        esc = false;
        i++;
        continue;
      }

      if (ch === "{") {
        brace++;
      } else if (ch === "}") {
        brace--;
        if (brace <= 0) break;
      } else if (ch === "[") {
        bracket++;
      } else if (ch === "]") {
        bracket--;
      }

      i++;
    }

    return null;
  }

  /**
   * Locate routing object range.
   * If the document is full Xray config: returns the value range of `routing` key.
   * If the document is a routing-only fragment: returns the whole root object range.
   */
  function locateRoutingObject(text) {
    const root = locateRootObject(text);
    if (!root) return null;
    const routing = locateValueByKey(text, root, "routing");
    if (routing && routing.type === "object") {
      return {
        kind: "nestedRouting",
        start: routing.start,
        end: routing.end,
        rootStart: root.start,
        rootEnd: root.end,
      };
    }
    return {
      kind: "rootRouting",
      start: root.start,
      end: root.end,
      rootStart: root.start,
      rootEnd: root.end,
    };
  }

  function locateArrayByKey(text, routingRange, key) {
    const vr = locateValueByKey(text, routingRange, key);
    if (!vr) return null;
    const s = String(text || "");
    if (s[vr.start] !== "[") return null;

    const indent = getLineIndent(s, vr.start);
    let childIndent = indent + "  ";

    // Best-effort: detect indentation of first element line if present.
    let p = vr.start + 1;
    p = skipWsAndComments(s, p, vr.end);
    if (p < vr.end && s[p] !== "]") {
      const ind = getLineIndent(s, p);
      if (ind && ind.length >= indent.length) childIndent = ind;
    }

    return {
      key,
      start: vr.start,
      end: vr.end,
      indent,
      childIndent,
      keyStart: vr.keyStart,
      keyEnd: vr.keyEnd,
      colonPos: vr.colonPos,
    };
  }

  function stripJsoncComments(text) {
    const s = String(text || "");
    let out = "";

    let inString = false;
    let quote = "";
    let esc = false;
    let inLine = false;
    let inBlock = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const next = (i + 1 < s.length) ? s[i + 1] : "";

      if (inString) {
        out += ch;
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === quote) {
          inString = false;
          quote = "";
        }
        continue;
      }

      if (inLine) {
        if (ch === "\n") {
          inLine = false;
          out += ch;
        }
        continue;
      }

      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i++; // skip '/'
          continue;
        }
        // Preserve newlines to keep offsets somewhat stable.
        if (ch === "\n") out += ch;
        continue;
      }

      if (ch === "\"" || ch === "'") {
        inString = true;
        quote = ch;
        esc = false;
        out += ch;
        continue;
      }

      if (ch === "/" && next === "/") {
        inLine = true;
        i++; // skip second '/'
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i++; // skip '*'
        continue;
      }

      out += ch;
    }

    return out;
  }

  function tryParseJsonc(text) {
    try {
      const stripped = stripJsoncComments(text);
      return { ok: true, value: JSON.parse(stripped) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // --- PR5: stable keys + change detection (rules)

  function canonicalize(value) {
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t !== "object") return null; // undefined, function, symbol
    if (Array.isArray(value)) return value.map(canonicalize);

    const out = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }

  function stableStringify(value) {
    try {
      return JSON.stringify(canonicalize(value));
    } catch (e) {
      try {
        return JSON.stringify(value);
      } catch (e2) {
        return "";
      }
    }
  }

  // Simple, deterministic (non-crypto) hash for mapping.
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    const s = String((str === undefined || str === null) ? "" : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // h *= 16777619 (FNV prime)
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function hashString(str) {
    const h = fnv1a32(str);
    return h.toString(16).padStart(8, "0");
  }

  function extractRuleTag(rule) {
    if (!rule || typeof rule !== "object") return null;
    if (typeof rule.ruleTag !== "string") return null;
    const tag = rule.ruleTag.trim();
    return tag ? tag : null;
  }

  function countRuleTags(rules) {
    const counts = Object.create(null);
    const arr = Array.isArray(rules) ? rules : [];
    for (const r of arr) {
      const tag = extractRuleTag(r);
      if (!tag) continue;
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return counts;
  }

  function countSegmentRuleTags(segments) {
    const counts = Object.create(null);
    const arr = Array.isArray(segments) ? segments : [];
    for (const seg of arr) {
      const rule = seg && seg.parsed;
      const tag = extractRuleTag(rule);
      if (!tag) continue;
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return counts;
  }

  function buildRuleKey(rule, idx, tagCounts) {
    const tag = extractRuleTag(rule);
    if (tag && tagCounts && tagCounts[tag] === 1) return `tag:${tag}`;

    const canon = stableStringify(rule);
    if (canon) return `h:${hashString(canon)}`;

    return `idx:${Number.isFinite(idx) ? idx : 0}`;
  }

  function buildRuleKeyFromSegment(segment, idx, tagCounts) {
    const seg = segment || null;
    if (seg && seg.parsed) return buildRuleKey(seg.parsed, idx, tagCounts);

    const hint = (seg && typeof seg.keyHint === "string") ? seg.keyHint.trim() : "";
    if (hint && tagCounts && tagCounts[hint] === 1) return `tag:${hint}`;

    const canon = (seg && typeof seg.canonical === "string" && seg.canonical) ? seg.canonical : stableStringify(seg);
    if (canon) return `h:${hashString(canon)}`;

    return `idx:${Number.isFinite(idx) ? idx : 0}`;
  }

  function isSameRule(a, b) {
    return stableStringify(a) === stableStringify(b);
  }

  function readTopLevelDelimiter(text, from, end) {
    const s = String(text || "");
    const to = Math.min(s.length, Number.isFinite(end) ? end : s.length);
    let i = Math.max(0, Number.isFinite(from) ? from : 0);

    let inString = false;
    let quote = "";
    let esc = false;
    let inLine = false;
    let inBlock = false;

    for (; i < to; i++) {
      const ch = s[i];
      const next = (i + 1 < to) ? s[i + 1] : "";

      if (inString) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === quote) {
          inString = false;
          quote = "";
        }
        continue;
      }
      if (inLine) {
        if (ch === "\n") inLine = false;
        continue;
      }
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i++;
        }
        continue;
      }

      if (ch === "\"" || ch === "'") {
        inString = true;
        quote = ch;
        esc = false;
        continue;
      }
      if (ch === "/" && next === "/") {
        inLine = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i++;
        continue;
      }

      if (ch === ",") return { type: "comma", pos: i };
      if (ch === "]") return { type: "end", pos: i };
    }

    return { type: "eof", pos: i };
  }

  /**
   * Split a JSONC array into raw element segments.
   * arrayRange: {start, end} where start points to '[' and end is exclusive.
   * Returns an array of segments:
   *   { raw, objRaw, objStart, objEnd, keyHint, parsed, canonical, leadingCommentRaw, indent }
   */
  function splitJsoncArrayElements(text, arrayRange) {
    const s = String(text || "");
    if (!arrayRange || !Number.isFinite(arrayRange.start) || !Number.isFinite(arrayRange.end)) return null;
    const start = Math.max(0, arrayRange.start);
    const end = Math.min(s.length, arrayRange.end);
    if (end <= start) return null;
    if (s[start] !== "[") return null;

    const closePos = end - 1;
    if (closePos < start || s[closePos] !== "]") return null;

    const segments = [];
    let i = start + 1;

    while (i < closePos) {
      const segStart = i;
      const valueStart = skipWsAndComments(s, i, closePos);
      if (valueStart >= closePos) break;
      if (s[valueStart] === "]") break;

      const vr = readValueRange(s, valueStart, closePos);
      if (!vr) return null;
      const objStart = vr.start;
      const objEnd = vr.end;

      const delim = readTopLevelDelimiter(s, objEnd, closePos + 1);
      let segEnd = closePos;
      if (delim.type === "comma") segEnd = delim.pos + 1;
      else if (delim.type === "end") segEnd = delim.pos;
      else segEnd = closePos;

      const raw = s.slice(segStart, segEnd);
      const objRaw = s.slice(objStart, objEnd);
      const leadingCommentRaw = s.slice(segStart, objStart);
      const indent = getLineIndent(s, objStart);

      let parsed = null;
      let keyHint = null;
      let canonical = null;
      const p = tryParseJsonc(objRaw);
      if (p.ok) {
        parsed = p.value;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.ruleTag === "string" && parsed.ruleTag) keyHint = parsed.ruleTag;
          else if (typeof parsed.tag === "string" && parsed.tag) keyHint = parsed.tag;
          canonical = stableStringify(parsed);
        }
      }

      segments.push({
        raw,
        objRaw,
        objStart,
        objEnd,
        keyHint,
        parsed,
        canonical,
        leadingCommentRaw,
        indent,
      });

      i = segEnd;

      // Skip whitespace/comments between comma and next element.
      // Keep `i` as-is to preserve that prefix in the next segment.
    }

    return segments;
  }


  // --- PR6: render new routing.rules array preserving attached comments (best-effort)

  function stripTrailingComma(raw) {
    const s = String(raw || "");
    let j = s.length;
    while (j > 0 && isWs(s[j - 1])) j--;
    if (j > 0 && s[j - 1] === ",") {
      return s.slice(0, j - 1) + s.slice(j);
    }
    return s;
  }

  /**
   * Format an object as JSON with 2-space indentation, but do NOT indent the first line.
   * Subsequent lines are prefixed with `indentStr`.
   * Intended to be appended after a prefix that already contains indentation.
   */
  function formatObjectNoFirstIndent(obj, indentStr) {
    let json = "{}";
    try {
      json = JSON.stringify(obj, null, 2) || "{}";
    } catch (e) {
      json = "{}";
    }

    const lines = String(json).split("\n");
    if (lines.length <= 1) return lines[0];

    const base = String(indentStr || "");
    let out = lines[0];
    for (let i = 1; i < lines.length; i++) {
      out += "\n" + base + lines[i];
    }
    return out;
  }

  function mergeTagCountsMax(a, b) {
    const out = Object.create(null);
    const aa = a || Object.create(null);
    const bb = b || Object.create(null);
    for (const k of Object.keys(aa)) out[k] = aa[k] || 0;
    for (const k of Object.keys(bb)) out[k] = Math.max(out[k] || 0, bb[k] || 0);
    return out;
  }

  function buildSegmentQueuesByKey(segments, tagCounts) {
    const map = new Map();
    const arr = Array.isArray(segments) ? segments : [];
    for (let i = 0; i < arr.length; i++) {
      const seg = arr[i];
      const key = buildRuleKeyFromSegment(seg, i, tagCounts);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(seg);
    }
    return map;
  }

  function takeFromQueue(map, key) {
    if (!map || !map.has(key)) return null;
    const q = map.get(key);
    if (!q || q.length === 0) return null;
    const seg = q.shift();
    if (q.length === 0) map.delete(key);
    return seg;
  }

  /**
   * Build a new array text for `routing.rules`:
   * - unchanged items: keep raw segment (without trailing comma) to preserve inner formatting/comments
   * - changed items: preserve leading comment prefix (best-effort), but regenerate object body
   * - new items: generate object body with current array indentation
   *
   * Returns: { ok, text, stats, error }
   */
  function renderRulesArray(text, arrayRange, oldSegments, newRules) {
    try {
      const range = arrayRange || null;
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
        return { ok: false, error: "arrayRange is invalid" };
      }

      const rules = Array.isArray(newRules) ? newRules : [];
      const segs = Array.isArray(oldSegments) ? oldSegments : [];

      const countsOld = countSegmentRuleTags(segs);
      const countsNew = countRuleTags(rules);
      const tagCounts = mergeTagCountsMax(countsOld, countsNew);

      const queues = buildSegmentQueuesByKey(segs, tagCounts);

      const items = [];
      const stats = { unchanged: 0, changed: 0, added: 0, removed: 0 };

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const key = buildRuleKey(rule, i, tagCounts);
        const seg = takeFromQueue(queues, key);

        if (!seg) {
          // New rule
          stats.added++;
          const elemIndent = String(range.childIndent || "");
          const prefix = "\n" + elemIndent;
          const body = formatObjectNoFirstIndent(rule, elemIndent);
          items.push(prefix + body);
          continue;
        }

        // Existing rule segment
        if (seg.parsed && isSameRule(seg.parsed, rule)) {
          stats.unchanged++;
          let raw = stripTrailingComma(seg.raw);
          if (raw && raw[0] !== "\n" && raw[0] !== "\r") {
            raw = "\n" + String(range.childIndent || "") + raw;
          }
          items.push(raw);
          continue;
        }

        stats.changed++;
        const prefix0 = String(seg.leadingCommentRaw || "");
        const suffix0 = String(seg.raw || "").slice(prefix0.length + String(seg.objRaw || "").length);
        const suffix = stripTrailingComma(suffix0);

        const elemIndent = String(seg.indent || range.childIndent || "");
        const body = formatObjectNoFirstIndent(rule, elemIndent);

        let prefix = prefix0;
        // Ensure prefix ends with indentation for the element line.
        if (!prefix.endsWith(elemIndent)) {
          const nl = prefix.lastIndexOf("\n");
          prefix = (nl >= 0) ? prefix.slice(0, nl + 1) + elemIndent : ("\n" + elemIndent);
        }

        let out = prefix + body + suffix;
        if (out && out[0] !== "\n" && out[0] !== "\r") {
          out = "\n" + String(range.childIndent || "") + out;
        }
        items.push(out);
      }

      // Count removed
      let removed = 0;
      for (const q of queues.values()) removed += q.length;
      stats.removed = removed;

      // Render
      if (items.length === 0) {
        return { ok: true, text: "[]", stats };
      }

      let out = "[";
      for (let i = 0; i < items.length; i++) {
        out += items[i];
        if (i !== items.length - 1) out += ",";
      }
      out += "\n" + String(range.indent || "") + "]";

      return { ok: true, text: out, stats };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // --- PR8: balancers + domainStrategy

  function extractBalancerTag(balancer) {
    if (!balancer || typeof balancer !== "object") return null;
    if (typeof balancer.tag !== "string") return null;
    const tag = balancer.tag.trim();
    return tag ? tag : null;
  }

  function countBalancerTags(balancers) {
    const counts = Object.create(null);
    const arr = Array.isArray(balancers) ? balancers : [];
    for (const b of arr) {
      const tag = extractBalancerTag(b);
      if (!tag) continue;
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return counts;
  }

  function countSegmentBalancerTags(segments) {
    const counts = Object.create(null);
    const arr = Array.isArray(segments) ? segments : [];
    for (const seg of arr) {
      const b = seg && seg.parsed;
      const tag = extractBalancerTag(b);
      if (!tag) continue;
      counts[tag] = (counts[tag] || 0) + 1;
    }
    return counts;
  }

  function buildBalancerKey(balancer, idx, tagCounts) {
    const tag = extractBalancerTag(balancer);
    if (tag && tagCounts && tagCounts[tag] === 1) return `tag:${tag}`;

    const canon = stableStringify(balancer);
    if (canon) return `h:${hashString(canon)}`;

    return `idx:${Number.isFinite(idx) ? idx : 0}`;
  }

  function buildBalancerKeyFromSegment(segment, idx, tagCounts) {
    const seg = segment || null;
    if (seg && seg.parsed) return buildBalancerKey(seg.parsed, idx, tagCounts);

    const hint = (seg && typeof seg.keyHint === "string") ? seg.keyHint.trim() : "";
    if (hint && tagCounts && tagCounts[hint] === 1) return `tag:${hint}`;

    const canon = (seg && typeof seg.canonical === "string" && seg.canonical) ? seg.canonical : stableStringify(seg);
    if (canon) return `h:${hashString(canon)}`;

    return `idx:${Number.isFinite(idx) ? idx : 0}`;
  }

  function isSameBalancer(a, b) {
    return stableStringify(a) === stableStringify(b);
  }

  function buildBalancerSegmentQueuesByKey(segments, tagCounts) {
    const map = new Map();
    const arr = Array.isArray(segments) ? segments : [];
    for (let i = 0; i < arr.length; i++) {
      const seg = arr[i];
      const key = buildBalancerKeyFromSegment(seg, i, tagCounts);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(seg);
    }
    return map;
  }

  function renderObjectArrayLiteral(arrayRangeIndent, elementIndent, items) {
    const arr = Array.isArray(items) ? items : [];
    const ind = String(arrayRangeIndent || "");
    const child = String(elementIndent || "");
    if (arr.length === 0) return "[]";
    let out = "[";
    for (let i = 0; i < arr.length; i++) {
      const body = formatObjectNoFirstIndent(arr[i], child);
      out += "\n" + child + body;
      if (i !== arr.length - 1) out += ",";
    }
    out += "\n" + ind + "]";
    return out;
  }

  /**
   * Build a new array text for `routing.balancers` preserving attached comments (best-effort).
   * Returns: { ok, text, stats, error }
   */
  function renderBalancersArray(text, arrayRange, oldSegments, newBalancers) {
    try {
      const range = arrayRange || null;
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
        return { ok: false, error: "arrayRange is invalid" };
      }

      const balancers = Array.isArray(newBalancers) ? newBalancers : [];
      const segs = Array.isArray(oldSegments) ? oldSegments : [];

      const countsOld = countSegmentBalancerTags(segs);
      const countsNew = countBalancerTags(balancers);
      const tagCounts = mergeTagCountsMax(countsOld, countsNew);

      const queues = buildBalancerSegmentQueuesByKey(segs, tagCounts);

      const items = [];
      const stats = { unchanged: 0, changed: 0, added: 0, removed: 0 };

      for (let i = 0; i < balancers.length; i++) {
        const bal = balancers[i];
        const key = buildBalancerKey(bal, i, tagCounts);
        const seg = takeFromQueue(queues, key);

        if (!seg) {
          stats.added++;
          const elemIndent = String(range.childIndent || "");
          const prefix = "\n" + elemIndent;
          const body = formatObjectNoFirstIndent(bal, elemIndent);
          items.push(prefix + body);
          continue;
        }

        if (seg.parsed && isSameBalancer(seg.parsed, bal)) {
          stats.unchanged++;
          let raw = stripTrailingComma(seg.raw);
          if (raw && raw[0] !== "\n" && raw[0] !== "\r") {
            raw = "\n" + String(range.childIndent || "") + raw;
          }
          items.push(raw);
          continue;
        }

        stats.changed++;
        const prefix0 = String(seg.leadingCommentRaw || "");
        const suffix0 = String(seg.raw || "").slice(prefix0.length + String(seg.objRaw || "").length);
        const suffix = stripTrailingComma(suffix0);

        const elemIndent = String(seg.indent || range.childIndent || "");
        const body = formatObjectNoFirstIndent(bal, elemIndent);

        let prefix = prefix0;
        if (!prefix.endsWith(elemIndent)) {
          const nl = prefix.lastIndexOf("\n");
          prefix = (nl >= 0) ? prefix.slice(0, nl + 1) + elemIndent : ("\n" + elemIndent);
        }

        let out = prefix + body + suffix;
        if (out && out[0] !== "\n" && out[0] !== "\r") {
          out = "\n" + String(range.childIndent || "") + out;
        }
        items.push(out);
      }

      let removed = 0;
      for (const q of queues.values()) removed += q.length;
      stats.removed = removed;

      if (items.length === 0) {
        return { ok: true, text: "[]", stats };
      }

      let out = "[";
      for (let i = 0; i < items.length; i++) {
        out += items[i];
        if (i !== items.length - 1) out += ",";
      }
      out += "\n" + String(range.indent || "") + "]";

      return { ok: true, text: out, stats };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  function findLastSignificantChar(text, from, to) {
    const s = String(text || "");
    const lo = Math.max(0, Number.isFinite(from) ? from : 0);
    const hi = Math.min(s.length, Number.isFinite(to) ? to : s.length);
    let last = -1;
    scanJsonc(s, (i, ch, st) => {
      if (i < lo || i >= hi) return;
      if (st && (st.inLineComment || st.inBlockComment)) return;
      // For strings: scanJsonc reports the closing quote with inString=false,
      // so treating inString as "skip" is OK for our purposes.
      if (st && st.inString) return;
      if (!isWs(ch)) last = i;
    }, lo, hi);
    return last;
  }

  function detectObjectIndents(text, objRange) {
    const s = String(text || "");
    const start = objRange && Number.isFinite(objRange.start) ? objRange.start : -1;
    const end = objRange && Number.isFinite(objRange.end) ? objRange.end : -1;
    if (start < 0 || end <= start) return null;
    const closePos = end - 1;
    const indent = getLineIndent(s, closePos);
    let childIndent = indent + "  ";
    const p = skipWsAndComments(s, start + 1, closePos);
    if (p < closePos && s[p] !== "}") {
      const ind = getLineIndent(s, p);
      if (ind && ind.length >= indent.length) childIndent = ind;
    }
    return { indent, childIndent, closePos };
  }

  /**
   * Insert a new key/value pair into an object without rewriting the whole document.
   * `valueText` must be a valid JSON snippet (string/object/array/primitive) WITHOUT trailing comma.
   * Returns: { ok, text, inserted, error }
   */
  function insertKeyValueInObject(text, objRange, key, valueText) {
    try {
      const s = String(text || "");
      const r = objRange || null;
      if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return { ok: false, error: "objRange is invalid" };
      if (s[r.start] !== "{") return { ok: false, error: "objRange must start with '{'" };
      const ind = detectObjectIndents(s, r);
      if (!ind) return { ok: false, error: "failed to detect object indentation" };

      const closePos = ind.closePos;
      const insertNl = s.lastIndexOf("\n", closePos - 1);
      const insertPos = (insertNl > r.start && insertNl < closePos) ? insertNl : closePos;

      const innerFirst = skipWsAndComments(s, r.start + 1, closePos);
      const isEmpty = innerFirst >= closePos;
      const lastSig = isEmpty ? -1 : findLastSignificantChar(s, r.start + 1, closePos);
      const needComma = (!isEmpty && lastSig >= 0 && s[lastSig] !== ",");

      const keyText = JSON.stringify(String(key));
      const prop = `${String(ind.childIndent || "")}${keyText}: ${String(valueText || "null")}`;

      const ins = `${needComma ? "," : ""}\n${prop}`;
      const out = s.slice(0, insertPos) + ins + s.slice(insertPos);
      return { ok: true, text: out, inserted: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  /**
   * Apply routing.domainStrategy change.
   * - If key exists: replace string value.
   * - If key missing and newValue is non-empty: insert key into routing object.
   * - If newValue is empty: best-effort remove key if present.
   */
  function applyDomainStrategy(text, routingRange, newValue) {
    try {
      const s = String(text || "");
      const rr = routingRange || null;
      if (!rr || !Number.isFinite(rr.start) || !Number.isFinite(rr.end)) return { ok: false, error: "routingRange is invalid" };

      const desired = String((newValue === undefined || newValue === null) ? "" : newValue);
      const vr = locateValueByKey(s, rr, "domainStrategy");

      // Remove
      if (!desired) {
        if (!vr) return { ok: true, text: s, action: "noop" };
        // Remove the whole pair (best-effort), keeping surrounding comments/format as much as possible.
        let propStart = vr.keyStart;
        let propEnd = vr.end;

        const closePos = rr.end - 1;
        let after = skipWsAndComments(s, propEnd, closePos);
        if (after < closePos && s[after] === ",") {
          propEnd = after + 1;
        } else {
          // try remove preceding comma
          let before = propStart - 1;
          while (before > rr.start && isWs(s[before])) before--;
          if (before > rr.start && s[before] === ",") propStart = before;
        }

        const out = s.slice(0, propStart) + s.slice(propEnd);
        return { ok: true, text: out, action: "removed" };
      }

      // Replace
      if (vr) {
        const cur = s.slice(vr.start, vr.end);
        const next = JSON.stringify(desired);
        if (cur === next) return { ok: true, text: s, action: "noop" };
        const out = s.slice(0, vr.start) + next + s.slice(vr.end);
        return { ok: true, text: out, action: "replaced" };
      }

      // Insert
      const out2 = insertKeyValueInObject(s, rr, "domainStrategy", JSON.stringify(desired));
      if (!out2 || !out2.ok) return { ok: false, error: (out2 && out2.error) ? out2.error : "insert failed" };
      return { ok: true, text: out2.text, action: "inserted" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  XKeen.features.routingJsoncPreserve = {
    scanJsonc,
    findMatchingBracket,
    // PR3: routing section locators
    locateRootObject,
    locateRoutingObject,
    locateValueByKey,
    locateArrayByKey,
    // PR4: array element raw segments
    splitJsoncArrayElements,
    // PR5: stable keys + change detection
    canonicalize,
    stableStringify,
    hashString,
    extractRuleTag,
    countRuleTags,
    countSegmentRuleTags,
    buildRuleKey,
    buildRuleKeyFromSegment,
    isSameRule,
    // PR6: render rules array
    renderRulesArray,
    // PR8: render balancers array
    renderBalancersArray,
    formatObjectNoFirstIndent,
    // PR8: extra helpers
    extractBalancerTag,
    countBalancerTags,
    countSegmentBalancerTags,
    buildBalancerKey,
    buildBalancerKeyFromSegment,
    isSameBalancer,
    renderObjectArrayLiteral,
    detectObjectIndents,
    insertKeyValueInObject,
    applyDomainStrategy,
  };
})();
