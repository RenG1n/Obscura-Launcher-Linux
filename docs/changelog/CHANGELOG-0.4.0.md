# Obscura 0.4.0

## Добавлено
- Fabric и Forge (`src/main/loaders.js`).
- Автоустановка и менеджер Java 8/17/21/25 (`src/main/runtime.js`), безопасные загрузки (`src/main/net.js`).
- Настройки `loader`, `loaderVersion`, `autoJava`; каналы IPC `loaders:list`, `java:*`.
- Коды ошибок OBS-110, 111, 112, 310, 311.

## Исправлено
- Поиск Java: `JAVA_HOME` в кавычках или на `\bin`, `PATH` с пробелами, установка только для пользователя.

## Не проверено на Windows
Реальное скачивание Java, Fabric и Forge, запуск модифицированной игры. Проверено автотестами с имитацией сети и реальной распаковкой tar.gz.
