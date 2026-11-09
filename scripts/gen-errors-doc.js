'use strict';
// Regenerates docs/ERRORS.md from the catalog in src/main/errors.js:  node scripts/gen-errors-doc.js
const fs = require('node:fs');
const path = require('node:path');
const { CATALOG } = require('../src/main/errors');
const cell = (t) => String(t).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
let out = '# Коды ошибок Obscura\n\nКаждая ошибка получает номер `OBS-xxx`, показывается в окне лаунчера и сохраняется файлом в `%APPDATA%\\Obscura\\errors`. Файл содержит причину, способ исправления и технические детали (токены и пароли вырезаются).\n\nДиапазоны: 1xx — сеть и установка (11x — загрузчики), 2xx — аккаунт, 3xx — Java и память, 4xx — процесс игры, 5xx — настройки и файлы, 9xx — внутренние.\n\n| Код | Что случилось | Причина | Что делать |\n|---|---|---|---|\n';
for (const [code, e] of Object.entries(CATALOG)) out += `| ${code} | ${cell(e.title)} | ${cell(e.cause)} | ${cell(e.fix)} |\n`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'ERRORS.md'), out);
console.log(`docs/ERRORS.md: ${Object.keys(CATALOG).length} кодов`);
