/**
 * Electron 桩模块：仅在 scripts 验证脚本里用。
 * 通过 Module._resolveFilename 钩子把 require('electron') 重定向到这里，
 * 让 database.js / wrongAssets.js 能在 ELECTRON_RUN_AS_NODE=1 的普通 Node 环境跑测试。
 */
const path = require('path');
const os = require('os');

let userData = path.join(os.tmpdir(), 'openexam-electron-stub-userdata');

module.exports = {
  app: {
    setPath(name, value) {
      if (name === 'userData') userData = value;
    },
    getPath(name) {
      if (name === 'userData') return userData;
      throw new Error(`electron-stub: getPath("${name}") 不支持`);
    },
    setName() {},
    whenReady() { return Promise.resolve(); },
  },
};
