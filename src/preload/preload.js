'use strict';
// Runs in an isolated world with a sandbox. It exposes a small, frozen API
// to the page; the page never receives ipcRenderer, Node.js or the raw event.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('obscura', Object.freeze({
  settings: Object.freeze({
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch)
  }),
  system: Object.freeze({ info: () => call('system:info') }),
  versions: Object.freeze({ list: () => call('versions:list') }),
  background: Object.freeze({
    get: () => call('background:get'),
    select: (id) => call('background:select', id),
    setCustom: (bytes) => call('background:setCustom', bytes),
    clear: () => call('background:clear')
  }),
  auth: Object.freeze({
    status: () => call('auth:status'),
    login: () => call('auth:login'),
    cancel: () => call('auth:cancel'),
    logout: () => call('auth:logout'),
    select: (uuid) => call('auth:select', uuid),
    remove: (uuid) => call('auth:remove', uuid),
    onCode: (callback) => subscribe('auth:code', callback)
  }),
  loaders: Object.freeze({
    list: (loader, mcVersion) => call('loaders:list', loader, mcVersion)
  }),
  java: Object.freeze({
    list: () => call('java:list'),
    install: (major) => call('java:install', major),
    remove: (major) => call('java:remove', major),
    cancel: () => call('java:cancel'),
    onEvent: (callback) => subscribe('java:event', callback)
  }),
  errors: Object.freeze({
    list: () => call('errors:list'),
    openFolder: () => call('errors:openFolder')
  }),
  game: Object.freeze({
    play: (input) => call('game:play', input),
    cancel: () => call('game:cancel'),
    state: () => call('game:state'),
    openFolder: () => call('game:openFolder'),
    openModsFolder: () => call('game:openModsFolder'),
    onEvent: (callback) => subscribe('game:event', callback)
  }),
  visual: Object.freeze({
    info: () => call('visual:info'),
    openFolder: () => call('visual:openFolder')
  }),
  builds: Object.freeze({
    list: () => call('builds:list'),
    create: (input) => call('builds:create', input),
    rename: (id, name) => call('builds:rename', id, name),
    update: (id, patch) => call('builds:update', id, patch),
    duplicate: (id, name) => call('builds:duplicate', id, name),
    delete: (id) => call('builds:delete', id),
    openFolder: (id) => call('builds:openFolder', id),
    openModsFolder: (id) => call('builds:openModsFolder', id)
  }),
  modrinth: Object.freeze({
    search: (input) => call('modrinth:search', input),
    browse: (input) => call('modrinth:browse', input),
    addMod: (input) => call('modrinth:addMod', input),
    listInstalled: (buildId) => call('modrinth:listInstalled', buildId),
    removeMod: (buildId, filename) => call('modrinth:removeMod', buildId, filename)
  }),
  mrpack: Object.freeze({
    importUrl: (input) => call('mrpack:importUrl', input),
    importFile: (bytes, name) => call('mrpack:importFile', bytes, name)
  })
}));
