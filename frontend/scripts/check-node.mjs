// Fails fast with a clear message on an unsupported Node version
// (Vite 8 / Rolldown need Node >= 22.12; older Node crashes with cryptic import errors).
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `\n  DocuMind's frontend needs Node.js >= 22.12 (24 LTS recommended). You have ${process.version}.\n` +
      '  Install the LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS),\n' +
      '  then open a NEW terminal and run `node -v` to confirm.\n',
  )
  process.exit(1)
}
