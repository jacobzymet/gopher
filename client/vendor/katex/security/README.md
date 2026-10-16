# KaTeX security backport

The shipped renderer is `0.16.22+gopher-security.1`, with the original KaTeX
0.16.22 CSS and fonts. It includes the complete own-property hardening from
upstream commit
[`0adf7e77db6915d991803b29699f82b1ccf8d4f4`](https://github.com/KaTeX/KaTeX/commit/0adf7e77db6915d991803b29699f82b1ccf8d4f4)
for [GHSA-238p-pmpm-9mq7 / CVE-2026-103923](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).

The security changes are applied to the official release's readable
`package/dist/katex.js`, before minification. `backport.json` records each
exact, uniquely matched replacement, the npm archive SHA-512, source/output
SHA-256 values, the upstream commit, and the pinned minifier version.
`upstream-security.patch` records the upstream changes for review.
`katex.patched.js` is the resulting readable, patched source.

The four hardened paths are schema defaults; option and schema processor
lookup; namespace built-in lookup; and namespace group restoration.
The additional version-string replacement identifies this downstream build.
Rendering algorithms, metrics, fonts and CSS are unchanged.

After `npm ci`, verify the offline build:

```sh
node client/vendor/katex/security/rebuild.mjs
```

Verify the complete build from the official npm archive as well:

```sh
node client/vendor/katex/security/rebuild.mjs --fetch-upstream
```

An already downloaded archive can be checked with `--archive path/to/package.tgz`.
Pass `--write` to reproduce the vendored minified file after verification.

The security tests exercise all four paths, including an explicit
`trust: false` under polluted processor metadata. A 56-formula corpus compares
rendered markup, bounds and browser pixels with a frozen static pre-patch
reference. It contains no executable copy of the vulnerable renderer.
