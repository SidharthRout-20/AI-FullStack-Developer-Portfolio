# @appcore/web

The shared web core used by the portfolio frontend and by every product's web app. Plain source (JSX / CSS), no build
step: apps alias `@appcore/web` to `packages/web-core/src` and dedupe React and friends to their own copy (see each
app's `vite.config.js`).

| Import | What it gives you |
| --- | --- |
| `@appcore/web/ui` | `ProductShell` and building blocks (`Card`, `Button`, `Tabs`, `Field`, `Steps`, `Answer`, …), plus `ShellProvider`: the host app supplies the backdrop, header controls and home link. |
| `@appcore/web/router` | A tiny History-API router: `usePath`, `navigate` (with view transitions), `Link`. |
| `@appcore/web/http` | `ApiError`, safe error text, `sessionError`, and `createClient(base)` for JSON and SSE calls. |
| `@appcore/web/sse` | A streaming Server-Sent Events parser. |
| `@appcore/web/theme`, `ModeToggle` | One light / auto / dark store per page (`useTheme`, `setThemeMode`), with hooks apps can layer on (the portfolio's skins). |
| `@appcore/web/device` | Location, photo compression, notifications, speech. |
| `styles/core.css`, `styles/theme-light.css` | The design system: colour tokens (dark by default, re-mapped for light), surfaces, Markdown, transitions. |

Runtime libraries (React, motion, lucide-react, react-markdown) are peer dependencies supplied by the app. This folder's
own `package.json` only installs the lint toolchain: `npm ci && npm run lint`.
