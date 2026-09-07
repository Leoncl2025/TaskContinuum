# Third-party notices

Task Continuum uses independently packaged components. It does not contain a fork
of the Code-OSS workbench or Copilot Chat. Integration identifiers do not imply
product affiliation or grant permission to use hosted Copilot services.

## Microsoft Codicons

- Source: https://github.com/microsoft/vscode-codicons
- Package: `@vscode/codicons` 0.0.45.
- Attribution: Microsoft Corporation and contributors.
- Icon assets: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
- Package code: [MIT license](https://github.com/microsoft/vscode-codicons/blob/main/LICENSE-CODE).
- The icon font is used without modification. Application CSS changes only its
  displayed color and size. No Microsoft product logo is used as the app logo.

## React, React DOM, and Scheduler

- Source: https://github.com/facebook/react
- License: MIT.
- Copyright (c) Meta Platforms, Inc. and affiliates.

## Electron

- Source: https://github.com/electron/electron
- License: MIT; bundled Chromium, Node.js, and other components have their own notices.
- Electron's installed distribution retains its license and Chromium credits.
- Any future installer must include the applicable Electron and dependency notices.

## GitHub Copilot SDK

- Source: https://github.com/github/copilot-sdk
- Package: `@github/copilot-sdk` 1.0.13; SDK code license: MIT.
- The installed platform package includes Copilot runtime 1.0.83. Its notices and
  applicable GitHub service terms remain in effect; use requires an authorized account.
- SDK dependencies, including vscode-jsonrpc, Zod, and Koffi, retain their upstream
  notices in the dependency installation. Include the complete license inventory
  before distributing any installer.

## Markdown and workspace parsing

- `react-markdown` 10.1.0: https://github.com/remarkjs/react-markdown (MIT).
- `unified` 11.0.5: https://github.com/unifiedjs/unified (MIT).
- `remark-parse` 11.0.0, `remark-gfm` 4.0.1, and `remark-frontmatter` 5.0.0:
  https://github.com/remarkjs (MIT).
- `mdast-util-to-string` 4.0.0: https://github.com/syntax-tree/mdast-util-to-string (MIT).
- `zod` 4.3.6: https://github.com/colinhacks/zod (MIT).
- Transitive dependencies retain their upstream notices in the dependency installation.
  Markdown parser modules are included in the main-process bundle for ESM compatibility.

## MIT permission notice

The following permission text accompanies the MIT-licensed components above;
their respective copyright notices remain applicable.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Development dependencies

`ssh2` 1.17.0 (https://github.com/mscdex/ssh2, MIT) supplies only the isolated
SSH test server; `@types/ssh2` retains its upstream DefinitelyTyped MIT notice.
Production forwarding uses the operating system's OpenSSH executable, which is
not bundled by this application and retains its own license notices.

Vite, electron-vite, TypeScript, ESLint, Vitest, Playwright, Testing Library,
and other development dependencies retain their upstream licenses in the
dependency installation. The locked dependency manifest records exact versions.
Review the complete dependency license inventory before distributing an installer.