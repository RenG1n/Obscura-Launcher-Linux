'use strict';
// `npm run dist` builds for the platform you are on: Windows -> installer + portable, Linux -> AppImage + deb + tar.gz.
// Cross-building is possible only through the explicit scripts (dist:win / dist:linux) and has its own caveats (see README).
const { spawnSync } = require('node:child_process');
const target = process.platform === 'win32' ? 'dist:win' : process.platform === 'linux' ? 'dist:linux' : null;
if (!target) {
  console.error(`Obscura is built for Windows and Linux; ${process.platform} is not supported by "npm run dist".`);
  process.exit(1);
}
console.log(`> npm run ${target}`);
const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', target], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status === null ? 1 : res.status);
