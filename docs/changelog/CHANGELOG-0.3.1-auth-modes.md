# Obscura Launcher — auth/account changes

This source update adds:

- Microsoft and local/offline launch modes in Settings.
- Configurable local player name (3–16 ASCII letters, digits, or underscores).
- Multiple Microsoft account profiles with account switching, adding, and removing.
- Per-account token-cache identities while preserving migration from the previous single-account profile file.
- Offline UUID/session generation for local mode.
- UI status for the selected local profile and account-management controls.
- Tests for local-mode launch and profile-name validation.

Important: local/offline mode does not grant a Minecraft license and does not authenticate to official online-mode servers. Microsoft account tokens remain encrypted with Electron safeStorage when OS encryption is available.

Validation performed: all JavaScript source files passed `node -c`; `npm test` passed 76/76 tests. A packaged Windows installer has not been built in this environment.
