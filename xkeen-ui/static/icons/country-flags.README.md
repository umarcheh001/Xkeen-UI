# Country flags

The shared `static/js/ui/country_flags.js` catalogue covers all 249 ISO 3166-1
entries and all 259 two-letter RGI flag sequences in Unicode Emoji 17.0,
plus the tag flags of England, Scotland and Wales (262 pictures in total).
The existing 56 hand-drawn flags, including Moldova and the EU, are preserved.
The remaining 206 flags are in `country-flags.svg`, fetched locally only when used.
Unknown flag sequences use the inline neutral globe; node identifiers are unchanged.

Sources:

- [flag-icons v7.6.0](https://github.com/lipis/flag-icons/tree/v7.6.0/flags/4x3),
  MIT, Copyright (c) 2013 Panayiotis Lipiridis; see `flag-icons.LICENSE`.
  SVG roots were converted to symbols, IDs prefixed, and whitespace compacted.
  Unicode AC uses `sh-ac`, TA uses `sh-ta`, and EA uses the Spanish flag.
- [Flag of Sark](https://commons.wikimedia.org/wiki/File:Flag_of_Sark.svg),
  by Denelson83, released into the public domain. Source image retrieved
  2026-11-13; metadata removed and IDs prefixed for the sprite.
- [Unicode Emoji 17.0 sequences](https://www.unicode.org/Public/17.0.0/emoji/emoji-sequences.txt),
  used to check the complete set of two-letter flag codes.

No runtime dependency, remote image service, or emoji font is required.
