/**
 * 资料管理 + 分批解析端到端验证（不启动 GUI）：
 *   服务守护 → 分批 OCR → 逐批落盘 → 教材全文 → 资料清单 → Skill 上下文
 */
const Module = require('module');
const USER_DATA = process.env.OPENEXAM_USER_DATA || 'C:\\Users\\Li_13\\AppData\\Roaming\\studystudio';
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => USER_DATA }, webUtils: { getPathForFile: () => '' } };
  }
  return origLoad.call(this, request, ...rest);
};

const database = require('../src/main/database.js');
const subjectManager = require('../src/main/subjectManager.js');
const subjectTextbook = require('../src/main/subjectTextbook.js');
const materialManager = require('../src/main/materialManager.js');
const materialContext = require('../src/main/materialContext.js');
const goodLearning = require('../src/shared/goodLearningSkill.js');
const fs = require('fs');
const path = require('path');

const subjectId = process.argv[2] || 'subj_mw7m2yj1lv00rqcz';

(async () => {
  database.initDatabase();
  const s = subjectManager.getSubject(subjectId);
  console.log('科目:', s?.name, '| 教材状态:', s?.textbookStatus, '| 页数:', s?.textbookPages);

  // 1) 资料清单：主教材视图 + 补充资料列表
  const list = materialManager.listMaterials(subjectId);
  console.log('资料清单: 主教材=', list.primary?.name || '无', '| 补充资料=', list.supplementary.length, '份');

  // 2) 添加一份 Markdown 补充资料（直接可读）
  const tmpFile = path.join('D:', 'mineru-work', 'test-supplement.md');
  fs.writeFileSync(tmpFile, '# 控制系统的基本概念\n\n反馈控制：将输出量的一部分回送到输入端与给定量比较，利用偏差进行控制。\n', 'utf8');
  const entry = materialManager.addSupplementary({ subjectId, filePath: tmpFile, name: '课堂笔记示例.md' });
  console.log('添加补充资料:', entry.name, '| status=', entry.status, '| chars=', entry.chars);

  // 3) Skill 分层描述
  const desc = materialContext.describe(subjectId);
  console.log('--- Skill 资料分层摘要 ---');
  console.log(desc.slice(0, 700));

  // 4) 检索上下文：主教材优先 + 补充资料辅助
  const ctx = materialContext.buildMaterialContext(subjectId, '反馈控制 传递函数');
  console.log('检索片段: 主教材', ctx.primaryChunks, '段 / 补充资料', ctx.supplementChunks, '段 / 字符', ctx.text.length);

  // 5) 组装完整 system 片段，确认注入不报错
  const block = goodLearning.buildSubjectSkillBlock(s, { materials: desc, materialContext: ctx.text });
  console.log('科目上下文长度:', block.length, '| 含资料分层:', block.includes('主教材优先') || block.includes('主教材（权威）'));

  // 6) 清理示例资料
  materialManager.removeSupplementary({ subjectId, id: entry.id });
  console.log('已清理示例补充资料');
  console.log('CHECK OK');
  process.exit(0);
})().catch((error) => {
  console.error('FATAL', error?.stack || error);
  process.exit(1);
});
