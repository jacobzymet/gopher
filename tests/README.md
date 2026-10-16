# Browser application regressions

`npm run test:ui` runs the browser-controller regressions against compiled
`client/**/*.ts` sources.

Optional coverage uses the installed `playwright-core` package:

- `GOPHER_BROWSER_TESTS=1 npm run test:ui` enables static browser rendering,
  sanitizer, table resizing, sidebar animation, and accessibility checks.
- `GOPHER_E2E=1 npm run test:ui` also runs the app integration flows. Each starts
  the Node.js TypeScript CLI with its own temporary configuration and data.
- `GOPHER_BROWSER_CHANNEL=chrome` selects an installed browser. Windows Chrome
  and Edge are detected automatically; otherwise Playwright's Chromium is used.
- `GOPHER_TEST_ENTRY` can select a built JavaScript CLI instead of the default
  `server/index.ts` entry.

`fixtures/original-ui-sha256.json` contains reference hashes for HTML,
stylesheets, browser behavior, and licensed vendor assets. `ui-parity.test.cjs`
checks these references, with vendor security updates pinned separately in
`fixtures/vendor-security-overrides.json`.
