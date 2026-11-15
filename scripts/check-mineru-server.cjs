/** 验证主进程的 MinerU 服务守护能自行拉起 doclib server 与 OCR 引擎 */
const Module = require('module');
const USER_DATA = process.env.OPENEXAM_USER_DATA || 'C:\\Users\\Li_13\\AppData\\Roaming\\studystudio';
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => USER_DATA } };
  return origLoad.call(this, request, ...rest);
};

const server = require('../src/main/mineruServer.js');
(async () => {
  const result = await server.ensureRunning({
    onProgress: (p) => console.log(`[server] ${p.detail}`),
  });
  console.log('RESULT:', JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
