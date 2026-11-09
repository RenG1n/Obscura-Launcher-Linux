'use strict';
// Headless self-check for a real machine (run: npm run doctor).
// It exercises the parts that cannot be verified without internet access and
// the installed libraries, and tells you exactly which one fails.
const os = require('node:os');
const { VersionService } = require('../src/main/versions');
const { getMemoryInfo } = require('../src/main/ram');
const { detectJava } = require('../src/main/java');
const { REQUIRED_EXPORTS } = require('../src/main/adapters/xmcl');
const { describeError } = require('../src/main/logger');

let failed = 0;
const ok = (msg) => console.log(`  [ OK ] ${msg}`);
const bad = (msg) => { failed++; console.log(`  [FAIL] ${msg}`); };
const warn = (msg) => console.log(`  [WARN] ${msg}`);

(async () => {
  console.log(`Obscura doctor — ${os.platform()} ${os.release()}, Node ${process.version}\n`);

  console.log('1. Libraries and the functions Obscura calls');
  for (const [name, exportsNeeded] of Object.entries(REQUIRED_EXPORTS)) {
    try {
      const lib = require(name);
      const version = require(`${name}/package.json`).version;
      const missing = exportsNeeded.filter((n) => typeof lib[n] !== 'function');
      if (missing.length) bad(`${name}@${version}: нет функций ${missing.join(', ')}`);
      else ok(`${name}@${version}`);
      if (name === '@xmcl/installer') {
        if (typeof lib.installTask === 'function') ok('installTask доступна (прогресс и отмена работают)');
        else warn('installTask не найдена — установка будет без прогресса и отмены');
      }
    } catch (err) { bad(`${name}: ${err.message} (выполните npm install)`); }
  }
  try {
    const pa = require('prismarine-auth');
    const version = require('prismarine-auth/package.json').version;
    if (typeof pa.Authflow === 'function' && pa.Titles && pa.Titles.MinecraftNintendoSwitch) ok(`prismarine-auth@${version}`);
    else bad(`prismarine-auth@${version}: нет Authflow/Titles.MinecraftNintendoSwitch`);
  } catch (err) { bad(`prismarine-auth: ${err.message}`); }

  console.log('\n2. Mojang version manifest');
  try {
    const svc = new VersionService({});
    const { manifest, source } = await svc.getManifest();
    ok(`источник: ${source}; последний релиз ${manifest.latest.release}, snapshot ${manifest.latest.snapshot}; версий: ${manifest.versions.length}`);
    for (const v of ['1.21.8', '1.21.5', '1.20.4', '1.19.4']) {
      try { svc.resolve(manifest, v); ok(`версия ${v} есть в манифесте`); } catch { bad(`версия ${v} не найдена`); }
    }
  } catch (err) { bad(`манифест: ${err.message}`); }

  console.log('\n2b. Доступность серверов (любой ответ HTTP = сервер доступен)');
  const hosts = [
    ['версии (манифест)', 'https://piston-meta.mojang.com/'],
    ['клиент игры', 'https://piston-data.mojang.com/'],
    ['библиотеки', 'https://libraries.minecraft.net/'],
    ['ресурсы (звуки, текстуры)', 'https://resources.download.minecraft.net/'],
    ['вход Microsoft', 'https://login.live.com/'],
    ['Xbox Live', 'https://user.auth.xboxlive.com/'],
    ['Minecraft services', 'https://api.minecraftservices.com/'],
    ['Java (Adoptium API)', 'https://api.adoptium.net/v3/info/available_releases'],
    ['Java (файлы, GitHub)', 'https://github.com/adoptium/'],
    ['Fabric (метаданные)', 'https://meta.fabricmc.net/v2/versions/game'],
    ['Fabric (библиотеки)', 'https://maven.fabricmc.net/'],
    ['Forge (список)', 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'],
    ['Forge (файлы)', 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'],
    ['NeoForge (список и файлы)', 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'],
    ['Quilt (метаданные)', 'https://meta.quiltmc.org/v3/versions/game'],
    ['Quilt (библиотеки)', 'https://maven.quiltmc.org/repository/release/'],
    ['Modrinth (моды, Fabric API)', 'https://api.modrinth.com/v2/']
  ];
  for (const [label, url] of hosts) {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12000), redirect: 'manual' });
      ok(`${label}: ${new URL(url).hostname} — HTTP ${res.status}`);
    } catch (err) {
      bad(`${label}: ${new URL(url).hostname} НЕДОСТУПЕН\n${describeError(err)}`);
    }
  }

  console.log('\n3. Memory');
  const mem = getMemoryInfo();
  ok(`всего ${mem.totalGb} GB, свободно ${mem.freeGb} GB; допустимо ${mem.minGb}–${mem.maxGb} GB`);

  console.log('\n4. Java');
  const installs = await detectJava({});
  if (!installs.length) warn('Java не найдена. Игре нужна Java 17/21 (1.18+) или 8 (до 1.16).');
  for (const j of installs) ok(`Java ${j.version} (major ${j.major}, ${j.is64Bit ? '64-bit' : '32-bit'}) — ${j.path} [${j.source}]`);

  const installIdx = process.argv.indexOf('--install');
  if (installIdx !== -1) {
    const want = process.argv[installIdx + 1] || 'release';
    console.log(`\n5. Real install test: ${want} (downloads the game into a temp folder, ~0.5 GB)`);
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const { createInstaller } = require('../src/main/adapters/xmcl');
      const { readRequiredJavaMajor, isInstalled } = require('../src/main/game');
      const svc = new VersionService({});
      const { manifest } = await svc.getManifest();
      const meta = svc.resolve(manifest, want);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-doctor-'));
      let lastPct = -1;
      await createInstaller().install(meta, dir, {
        onProgress: ({ percent }) => { if (percent !== null && percent !== lastPct && percent % 10 === 0) { lastPct = percent; console.log(`       ${percent}%`); } }
      });
      const jar = path.join(dir, 'versions', meta.id, `${meta.id}.jar`);
      if (fs.existsSync(jar)) ok(`установлено: ${jar}`); else bad('jar не найден после установки');
      ok(`нужна Java ${readRequiredJavaMajor(dir, meta.id)}`);
      for (const sub of ['libraries', 'assets']) {
        if (fs.existsSync(path.join(dir, sub))) ok(`папка ${sub} создана`); else bad(`нет папки ${sub}`);
      }
      void isInstalled;
      console.log(`       (временная папка: ${dir} — можно удалить)`);
    } catch (err) { bad(`установка:\n${describeError(err)}`); }
  }

  // node scripts/doctor.js --loader fabric:1.21.11   (also forge:1.20.1, neoforge:21.1, quilt:1.21.1)
  const loaderIdx = process.argv.indexOf('--loader');
  if (loaderIdx !== -1) {
    const [kind, mc] = String(process.argv[loaderIdx + 1] || 'fabric:1.21.11').split(':');
    console.log(`\n6. Real loader test: ${kind} for Minecraft ${mc} (into a temp folder; Forge/NeoForge run their installer and need the vanilla game first)`);
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const { createLoaderService } = require('../src/main/loaders');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-doctor-loader-'));
      const svc = createLoaderService({ gameDir: dir, logger: { info: (m) => console.log(`       ${m}`), warn: (m) => console.log(`       [warn] ${m}`), error() {} } });
      const list = await svc.listVersions(kind, mc);
      if (!list.length) bad(`${kind}: для Minecraft ${mc} нет сборок`); else ok(`${kind}: доступно сборок ${list.length}, лучшая ${list[0].id}`);
      if (list.length) {
        let java = null;
        if (kind === 'forge' || kind === 'neoforge') {
          const need = detected => detected.length ? detected[0] : null;
          java = need(installs);
          if (!java) warn('Java не найдена — установщик Forge/NeoForge пропущен.');
          else {
            const svc2 = new VersionService({});
            const { manifest } = await svc2.getManifest();
            const { createInstaller } = require('../src/main/adapters/xmcl');
            await createInstaller().install(svc2.resolve(manifest, mc), dir, {});
          }
        }
        if (kind === 'fabric' || kind === 'quilt' || java) {
          const id = await svc.ensure(kind, mc, '', { javaPath: java && java.path, onProgress: (p) => { if (typeof p.percent === 'number' && p.percent % 25 === 0) console.log(`       ${p.percent}%`); } });
          ok(`установлено: ${id}`);
          const again = await svc.ensure(kind, mc, '', { javaPath: java && java.path });
          if (again === id) ok('повторная проверка прошла без повторной установки'); else bad(`повторная проверка вернула другой id: ${again}`);
        }
      }
      console.log(`       (временная папка: ${dir} — можно удалить)`);
    } catch (err) { bad(`загрузчик:\n${describeError(err)}`); }
  }

  console.log(`\n${failed ? `Проблем: ${failed}` : 'Критических проблем нет.'}`);
  process.exit(failed ? 1 : 0);
})();
