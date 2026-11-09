Здесь лежит .jar визуального мода (Minecraft 1.21.11, Fabric).

Сейчас: obscura-visual-2_0_0.jar (Obscura Visual 2.0.0).
  * Требует Fabric Loader 0.19.3+, Java 21+ и **Fabric API** (прописано в самом моде).
    Поэтому в manifest.json стоит "fabricApi": true — не отключайте.
    Лаунчер сам докачает Fabric API с Modrinth перед первым запуском (нужен интернет один раз).

Как обновить мод:
  * Замените .jar в этой папке (имя может быть другим) и пересоберите лаунчер:
      npm run dist:win      — установщик и portable для Windows
      npm run dist:linux    — AppImage, .deb и .tar.gz для Linux
    Папка попадает внутрь приложения (resources/visual-mod).
  * При каждом запуске в режиме «Визуальный мод» лаунчер копирует .jar в папку мода
    (Windows: %APPDATA%\Obscura\visual\mods, Linux: ~/.config/Obscura/visual/mods).
    Старая версия с другим именем удаляется сама. Чужие .jar, которые игрок положил туда
    вручную, лаунчер не трогает.
  * Проверить без сборки: положите .jar в папку visual/mods (кнопка 🧩 рядом с
    переключателем открывает именно её).
  * manifest.json: "fabricApi": false — не скачивать Fabric API (только если мод от него
    не зависит; для текущего мода так делать нельзя).
