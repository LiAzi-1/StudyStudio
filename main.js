const { app, BrowserWindow, nativeTheme, ipcMain, nativeImage, protocol, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const database = require("./src/main/database.js");
const paperExport = require("./src/main/paperExport.js");
const updater = require("./src/main/updater.js");
const questionAssets = require("./src/main/questionAssets.js");
const dataBackup = require("./src/main/dataBackup.js");
const databaseBackup = require("./src/main/databaseBackup.js");
const noteTutor = require("./src/main/noteTutor.js");
const noteAssets = require("./src/main/noteAssets.js");
const wrongAssets = require("./src/main/wrongAssets.js");
const obsidianSync = require("./src/main/obsidian/index.js");
const runtimeEnv = require("./src/main/runtimeEnv.js");
const subjectClassify = require("./src/main/subjectClassify.js");
const analysisPlugins = require("./src/main/plugins/index.js");
const { validateCitations } = require("./src/main/materialContext.js");
const parseProcesses = require("./src/main/parseProcesses.js");
const { parseKnowledgeSummaryTaxonomy, MODULE_LABELS } = require("./src/shared/knowledgeTaxonomy");
const { formatAIResult } = require("./src/shared/textbookFormat.js");

const APP_ICON_PATH = path.join(__dirname, "src", "renderer", "assets", "openexam-app-icon.png");
const APP_ICON = nativeImage.createFromPath(APP_ICON_PATH);

protocol.registerSchemesAsPrivileged([{
  scheme: questionAssets.ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true,
  },
}]);

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 680,
    minWidth: 1000,
    minHeight: 580,
    backgroundColor: "#ffffff",
    show: false,
    icon: APP_ICON_PATH,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.once("ready-to-show", () => win.show());

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
    if (['1', 'true', 'yes'].includes(String(process.env.OPENEXAM_DEVTOOLS || '').toLowerCase())) {
      win.webContents.openDevTools({ mode: "detach" });
    }

    // Forward renderer console errors to terminal
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (level >= 2) { // warnings and errors
        console.error(`[Renderer] ${message}`);
      }
    });

    // Do not fs.watch + app.exit() here: under `concurrently -k` that kills Vite and leaves a blank Electron window.
    return;
  }

  win.loadFile(path.join(__dirname, "dist", "index.html"));
};

app.whenReady().then(() => {
  nativeTheme.themeSource = "light";

  if (!APP_ICON.isEmpty()) {
    app.setName("StudyStudio");
    if (process.platform === "darwin" && app.dock?.setIcon) {
      app.dock.setIcon(APP_ICON);
    }
  }

  questionAssets.registerProtocol();

  // 学科分析插件：扫描内置/用户插件目录；启用状态存 app_settings
  analysisPlugins.attach({ app, database });

  // 初始化数据库
  // 失败时不能让 whenReady 链静默 reject：那样窗口永远不会创建，进程却一直挂着，
  // 用户看到的就是「应用打不开」。
  try {
    database.initDatabase();
  } catch (error) {
    console.error("[DB] 初始化失败:", error);
    dialog.showErrorBox(
      "StudyStudio 无法启动",
      `本地数据库打不开：${error?.message || error}\n\n`
      + "如果后台还有 StudyStudio 进程没退出，请先在任务管理器里结束它再重试；"
      + "仍然失败时，可以把数据目录下的 openexam.db-wal、openexam.db-shm 改名或删除后再打开。"
    );
    app.quit();
    return;
  }

  // WP-07 本地自动备份：启动先检查当天是否已备份，运行中每小时再检查一次（同一天不会重复）
  const runAutoBackup = () => databaseBackup.maybeAutoBackup(database.getDatabase())
    .then((result) => {
      if (result?.backup && !result.skipped) {
        console.log(`[Backup] 已自动备份：${result.backup.name}`);
      }
    })
    .catch((error) => console.error('[Backup] 自动备份失败:', error?.message || error));
  runAutoBackup();
  const autoBackupTimer = setInterval(runAutoBackup, 60 * 60 * 1000);
  if (typeof autoBackupTimer.unref === 'function') autoBackupTimer.unref();

  // 启动对账：把清单笔记正文同步回 subjects.knowledge_summary，
  // 修正历史版本里「笔记改了、答疑/分类仍读旧快照」的分叉
  try {
    const reconciled = database.reconcileKnowledgeSummaries();
    if (reconciled.updated > 0) {
      console.log(`[Knowledge] 已同步 ${reconciled.updated} 个科目的知识清单快照`);
    }
  } catch (error) {
    console.error('[Knowledge] 启动同步知识清单失败:', error?.message || error);
  }

  // 笔记分类迁移：补齐 学科笔记 / 答疑笔记 / 知识清单 三类与章节归属
  // 必须在 Obsidian 同步前跑，否则首轮会按旧分类把笔记推进「未归类」
  try {
    const migratedNotes = database.migrateNoteTree();
    if (migratedNotes.updated > 0) {
      console.log(`[Notes] 已归类 ${migratedNotes.updated} 篇笔记（学科/清单/答疑）`);
    }
  } catch (error) {
    console.error('[Notes] 笔记分类迁移失败:', error?.message || error);
  }

  // Obsidian 联动：接管上下文、迁移旧仓库、跑一次同步、挂上自动拉取
  try {
    obsidianSync.attach({
      app,
      database,
      subjectManager: require("./src/main/subjectManager.js"),
      onNotesPulled: (pulled) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("obsidian:notesPulled", pulled);
        }
      },
    });
    const ready = obsidianSync.ensureReady();
    if (ready.migration?.migrated) {
      console.log(`[Obsidian] 已从旧位置迁移 ${ready.migration.copied} 个文件 → ${ready.vaultDir}`);
    }
    // 启动先拉后推：应用关着的时候用户在 Obsidian 里改的内容要先收进来，
    // 否则紧接着的推送会把它覆盖掉
    obsidianSync.refresh();
    obsidianSync.startAutoSync();
    console.log(`[Obsidian] 仓库：${ready.vaultDir}`);
  } catch (error) {
    console.error('[Obsidian] 初始化失败:', error?.message || error);
  }

  // 启动即补写上次中断/崩溃时未入库的暂存题目，确保用户传的题不会丢
  try {
    const recovered = database.recoverStagedImports();
    if (recovered.recovered > 0 || recovered.duplicates > 0) {
      console.log(`[Import] 启动恢复：补写 ${recovered.recovered} 道，跳过重复 ${recovered.duplicates} 道`);
    }
  } catch (error) {
    console.error('[Import] 启动恢复暂存题目失败:', error);
  }

  createWindow();
  updater.initUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  // 启动阶段任何未捕获异常都不能让应用「静默不显示」：记录日志并给出可见提示
  console.error("[App] 启动失败:", error);
  dialog.showErrorBox("StudyStudio 启动失败", String(error?.stack || error?.message || error));
  app.quit();
});

// IPC 处理器 - 数据库操作
ipcMain.handle("db:getPapers", () => {
  return database.getPapers();
});

ipcMain.handle("db:getQuestions", (event, paperId, limit) => {
  return database.getQuestionsByPaperId(paperId, limit);
});

ipcMain.handle("db:getQuestionsByIds", (event, ids) => {
  return database.getQuestionsByIds(ids || []);
});

// 题目补答案：文字答案与图片答案分开走，图片先落盘再写引用
ipcMain.handle("question:updateAnswer", (event, input = {}) => {
  return database.updateQuestionAnswer(input.questionId, input);
});

// 缺答案题目让 AI 先给参考答案：只返回结果，是否入库由用户在答案面板确认
ipcMain.handle("question:aiAnswer", async (event, input = {}) => {
  const settings = input.settings || null;
  if (!settings?.apiKey) return { success: false, error: "还没配置 AI 模型，请先到「设置 → AI 模型」完成配置" };
  return aiService.solveQuestionAnswer(settings, input.question || {});
});

ipcMain.handle("question:addAnswerImage", (event, input = {}) => {
  const questionId = String(input.questionId || "").trim();
  if (!questionId) return { success: false, error: "题目 ID 不能为空" };
  const saved = questionAssets.saveAnswerImage({ questionId, dataUrl: input.dataUrl });
  if (!saved.success) return saved;
  try {
    const question = database.addQuestionAnswerImage(questionId, saved.url);
    return { ...saved, question };
  } catch (error) {
    // 写库失败时把刚落的文件删掉，避免留下无人引用的图片
    try { questionAssets.removeAnswerImage(saved.url); } catch { /* ignore */ }
    return { success: false, error: error?.message || "保存答案图片失败" };
  }
});

ipcMain.handle("question:removeAnswerImage", (event, input = {}) => {
  const questionId = String(input.questionId || "").trim();
  const url = String(input.url || "").trim();
  if (!questionId || !url) return { success: false, error: "题目 ID 和图片地址不能为空" };
  const removed = questionAssets.removeAnswerImage(url);
  if (!removed.success && removed.error === "不是有效的答案图片地址") return removed;
  try {
    const question = database.removeQuestionAnswerImage(questionId, url);
    return { success: true, question, fileRemoved: Boolean(removed.success) };
  } catch (error) {
    return { success: false, error: error?.message || "删除答案图片失败" };
  }
});

ipcMain.handle("db:savePracticeRecord", (event, record) => {
  database.savePracticeRecord(record);
  return true;
});

ipcMain.handle("db:getPracticeRecords", () => {
  return database.getPracticeRecords();
});

ipcMain.handle("db:addWrongQuestion", (event, input) => {
  database.addWrongQuestion(
    input?.questionId,
    input?.paperId,
    input?.userAnswer,
    input?.correctAnswer,
    input?.snapshot || null
  );
  return true;
});

ipcMain.handle("db:getWrongQuestions", (event, options) => {
  return database.getWrongQuestions(options || {});
});

ipcMain.handle("db:getWrongQuestionById", (event, id) => {
  return database.getWrongQuestionById(id);
});

ipcMain.handle("db:saveCustomWrongQuestion", (event, input) => {
  return database.saveCustomWrongQuestion(input || {});
});

ipcMain.handle("db:reviewWrongQuestion", (event, input) => {
  return database.reviewWrongQuestion(input?.id || input?.questionId, input?.outcome);
});

ipcMain.handle("db:removeWrongQuestion", (event, input) => {
  return database.removeWrongQuestion(input || "");
});

// 今日复习队列：错题阶梯到期 + 主动加入
ipcMain.handle("review:getTodayQueue", () => {
  return database.getTodayReviewQueue();
});

ipcMain.handle("review:addToday", (event, id) => {
  return database.addWrongQuestionToTodayReview(id);
});

// 每日一练：当天固定题组 / 断点续做 / 完成结果
ipcMain.handle("daily:get", (event, date) => {
  return database.getDailyPractice(date);
});

ipcMain.handle("daily:ensure", (event, input) => {
  return database.ensureDailyPractice(input || {});
});

ipcMain.handle("daily:complete", (event, input) => {
  return database.completeDailyPractice(input || {});
});

// 错题图片：存 userData/wrong-assets/<wrongId>/，返回 openexam-asset:// 引用
ipcMain.handle("wrong:addImage", (event, input) => {
  return wrongAssets.saveImage(input || {});
});

ipcMain.handle("wrong:removeImage", (event, input) => {
  return wrongAssets.removeImage(input || {});
});

ipcMain.handle("db:updatePracticeRecordScore", (event, input) => {
  return database.updatePracticeRecordScore(input || {});
});

ipcMain.handle("db:getCategoryStats", () => {
  return database.getCategoryStats();
});

ipcMain.handle("db:getKnowledgeGraph", () => {
  return database.getKnowledgeGraph();
});

ipcMain.handle("db:getReclassifyBatches", () => {
  return database.getReclassifyBatches();
});

// 知识图谱底层节点 → 该知识点下的题目
ipcMain.handle("db:getQuestionsByKnowledge", (event, options) => {
  return database.getQuestionsByKnowledge(options || {});
});

ipcMain.handle("db:getSmartRecommend", (event, options) => {
  return database.getSmartRecommend(options || {});
});

ipcMain.handle("db:getSubCategoryStats", (event, category) => {
  return database.getSubCategoryStats(category);
});

ipcMain.handle("db:getPracticeStats", () => {
  return database.getPracticeStats();
});

ipcMain.handle("db:resetStudyProgress", (event, category) => {
  return database.resetStudyProgress(category);
});

ipcMain.handle("db:importPaper", (event, { paperData, questions }) => {
  return database.importPaper(paperData, questions);
});

ipcMain.handle("db:appendImportedQuestions", (event, { paperId, questions } = {}) => {
  return database.appendImportedQuestions(paperId, questions);
});

ipcMain.handle("db:stageImportedQuestions", (event, input = {}) => {
  return database.stageImportedQuestions(input);
});

ipcMain.handle("db:updateStagedQuestions", (event, input = {}) => {
  return database.updateStagedQuestions(input);
});

ipcMain.handle("db:getPendingStagedQuestions", (event, input = {}) => {
  return database.getPendingStagedQuestions(input);
});

ipcMain.handle("db:getStagingSummary", (event, input = {}) => {
  return database.getStagingSummary(input);
});

ipcMain.handle("db:recoverStagedImports", (event, input = {}) => {
  return database.recoverStagedImports(input);
});

ipcMain.handle("db:clearStagedQuestions", (event, input = {}) => {
  return database.clearStagedQuestions(input);
});

ipcMain.handle("db:saveAIPaper", (event, { paperData, questions }) => {
  return database.saveAIPaper(paperData, questions);
});

ipcMain.handle("db:getImportedPapers", () => {
  return database.getImportedPapers();
});

ipcMain.handle("db:getSavedAIPapers", () => {
  return database.getSavedAIPapers();
});

ipcMain.handle("db:renameSavedPaper", (event, { paperId, title }) => {
  return database.renameSavedPaper(paperId, title);
});

ipcMain.handle("db:deleteSavedPaper", (event, { paperId }) => {
  return database.deleteSavedPaper(paperId);
});

ipcMain.handle("db:getQuestionsByCategory", (event, { category, subCategory, limit, shuffle } = {}) => {
  return database.getQuestionsByCategory(category, subCategory, limit, shuffle);
});

ipcMain.handle("db:getCategoryMaterialStats", (event, category) => {
  return database.getCategoryMaterialStats(category || "ziliao");
});

ipcMain.handle("db:getDailyStats", (event, days) => {
  return database.getDailyStats(days || 7);
});

ipcMain.handle("db:getStreakDays", () => {
  return database.getStreakDays();
});

ipcMain.handle("db:getTodayStats", () => {
  return database.getTodayStats();
});

ipcMain.handle("db:getHeatmapData", (event, days) => {
  return database.getHeatmapData(days || 90);
});

ipcMain.handle("db:getGrowthData", () => {
  return database.getGrowthData();
});

ipcMain.handle("db:getAppSetting", (event, key) => {
  return database.getAppPreference(key);
});

ipcMain.handle("db:setAppSetting", (event, { key, value } = {}) => {
  return database.setAppPreference(key, value);
});

ipcMain.handle("db:getAISettings", () => {
  return database.getAISettings();
});

ipcMain.handle("db:saveAISettings", (event, settings) => {
  return database.saveAISettings(settings);
});

ipcMain.handle("db:getAIConnectionState", () => {
  return database.getAIConnectionState();
});

ipcMain.handle("db:saveAIConnectionState", (event, state) => {
  return database.saveAIConnectionState(state);
});

ipcMain.handle("db:createAIChatSession", (event, input) => {
  return database.createAIChatSession(input || {});
});

ipcMain.handle("db:getAIChatSessions", (event, limit) => {
  return database.getAIChatSessions(limit || 30);
});

ipcMain.handle("db:getAIChatMessages", (event, sessionId, limit) => {
  return database.getAIChatMessages(sessionId, limit || 300);
});

ipcMain.handle("db:addAIChatMessage", (event, input) => {
  return database.addAIChatMessage(input || {});
});

ipcMain.handle("db:renameAIChatSession", (event, sessionId, title) => {
  return database.renameAIChatSession(sessionId, title);
});

// 对话体验补充：会话搜索（标题 + 消息正文）与置顶
ipcMain.handle("db:searchAIChatSessions", (event, query, limit) => {
  return database.searchAIChatSessions(query, limit || 100);
});

ipcMain.handle("db:setAIChatSessionPinned", (event, sessionId, pinned) => {
  return database.setAIChatSessionPinned(sessionId, Boolean(pinned));
});

ipcMain.handle("db:deleteAIChatSession", (event, sessionId) => {
  const result = database.deleteAIChatSession(sessionId);
  // 会话删掉后，图片目录也一并清理，避免 userData 越用越大
  try { require("./src/main/aiAssets.js").cleanupSession(sessionId); } catch { /* 忽略 */ }
  return result;
});

ipcMain.handle("db:exportAllData", () => {
  return database.exportAllData();
});

ipcMain.handle("db:exportBackupFile", async (event, clientState) => {
  const snapshot = database.exportAllData();
  const payload = {
    ...snapshot,
    kind: "openexam-backup",
    version: 2,
    app: { name: "OpenExam", version: app.getVersion() },
    client_state: clientState && typeof clientState === "object" ? clientState : {},
  };
  const result = await dataBackup.saveBackupFile(BrowserWindow.fromWebContents(event.sender), payload);
  return result?.canceled ? { canceled: true } : { ...result, stats: snapshot.stats };
});

ipcMain.handle("db:importBackupFile", async (event) => {
  const opened = await dataBackup.openBackupFile(BrowserWindow.fromWebContents(event.sender));
  if (opened?.canceled) return { canceled: true };

  const result = database.importAllData(opened.payload || {});
  return {
    canceled: false,
    filePath: opened.filePath,
    importedAt: result.imported_at,
    stats: result.stats,
    clientState: opened.payload?.client_state && typeof opened.payload.client_state === "object"
      ? opened.payload.client_state
      : {},
  };
});

ipcMain.handle("db:resetUserData", () => {
  return database.resetUserData();
});

ipcMain.handle("db:clearAllData", () => {
  return database.clearAllData();
});

// 本地数据库备份：在线快照 → userData/backups；恢复前先做完整性与结构校验
ipcMain.handle("db:listLocalBackups", () => {
  return databaseBackup.listBackups();
});

ipcMain.handle("db:createLocalBackup", async () => {
  return databaseBackup.createBackup(database.getDatabase(), "manual");
});

ipcMain.handle("db:restoreLocalBackup", async (event, name) => {
  const checked = databaseBackup.validateBackup(name);
  if (!checked.success) return checked;

  database.closeDatabase();
  try {
    databaseBackup.replaceDatabaseWithBackup(name);
    database.initDatabase();
    // 渲染层会先提示结果再刷新页面；这里只负责把主进程连接切到备份数据
    return { success: true, restored: checked, reloaded: false };
  } catch (error) {
    // 换库失败时尽量把旧库重新打开，避免应用处于无数据库状态
    try { database.initDatabase(); } catch (_) { /* 已尽力恢复 */ }
    return { success: false, error: error?.message || "恢复备份失败" };
  }
});

// IPC 处理器 - 备考待办 / 笔记
ipcMain.handle("todo:getTemplates", () => {
  return database.getTodoTemplates();
});

ipcMain.handle("todo:saveTemplate", (event, input) => {
  return database.saveTodoTemplate(input || {});
});

ipcMain.handle("todo:deleteTemplate", (event, templateId) => {
  return database.deleteTodoTemplate(templateId);
});

ipcMain.handle("todo:reorderTemplates", (event, ids) => {
  return database.reorderTodoTemplates(ids || []);
});

ipcMain.handle("todo:getDaily", (event, date) => {
  return database.getDailyTodos(date);
});

ipcMain.handle("todo:addInstance", (event, input) => {
  return database.addTodoInstance(input || {});
});

ipcMain.handle("todo:updateInstance", (event, input) => {
  return database.updateTodoInstance(input || {});
});

ipcMain.handle("todo:deleteInstance", (event, id) => {
  return database.deleteTodoInstance(id);
});

ipcMain.handle("todo:bumpProgress", (event, { kind, amount, date } = {}) => {
  return database.bumpTodoProgress(kind, amount, date);
});

ipcMain.handle("todo:carryOver", (event, { ids, date } = {}) => {
  return database.carryOverTodos(ids, date);
});

ipcMain.handle("todo:getStreak", (event, days) => {
  return database.getTodoStreak(days);
});

ipcMain.handle("note:save", (event, input) => {
  const saved = database.saveNote(input || {});
  // 保存即同步到 Obsidian（防抖，连续编辑不会反复写盘）
  obsidianSync.schedulePush();
  return saved;
});

ipcMain.handle("note:list", (event, options) => {
  return database.getNotes(options || {});
});

ipcMain.handle("note:get", (event, id) => {
  return database.getNote(id);
});

ipcMain.handle("note:delete", (event, id) => {
  const result = database.deleteNote(id);
  // 图片跟着笔记一起清掉，避免 userData 里留孤儿文件
  noteAssets.removeNoteAssets(id);
  obsidianSync.schedulePush(200);
  return result;
});

ipcMain.handle("note:search", (event, { keyword, options } = {}) => {
  return database.searchNotes(keyword, options || {});
});

ipcMain.handle("note:tags", () => {
  return database.getNoteTags();
});

// 笔记树：学科 → 知识清单 / 学科笔记 / 答疑笔记 → 模块 → 笔记
ipcMain.handle("note:tree", () => {
  const subjectManager = require("./src/main/subjectManager.js");
  return database.buildNoteTree(subjectManager.getSubjects());
});

/** 笔记候选：按标题/关键词列出，带科目、更新时间、字数 */
ipcMain.handle("note:candidates", (event, options = {}) => {
  try {
    const noteEditor = require("./src/main/noteEditor.js");
    return { success: true, items: noteEditor.listNoteCandidates(database, options || {}) };
  } catch (error) {
    return { success: false, error: error?.message || "读取笔记候选失败", items: [] };
  }
});

/** 修改已有笔记：先出只读计划（目标、小节、差异范围），用户确认后再写 */
ipcMain.handle("note:planEdit", (event, input = {}) => {
  try {
    const noteEditor = require("./src/main/noteEditor.js");
    return { success: true, ...noteEditor.planNoteEdit(database, input || {}) };
  } catch (error) {
    return { success: false, ok: false, message: error?.message || "生成笔记修改计划失败" };
  }
});

ipcMain.handle("note:applyEdit", (event, input = {}) => {
  try {
    const noteEditor = require("./src/main/noteEditor.js");
    const result = noteEditor.applyNoteEdit(database, input || {});
    if (result?.success) obsidianSync.schedulePush();
    return result;
  } catch (error) {
    return { success: false, ok: false, message: error?.message || "笔记修改失败", error: error?.message || "笔记修改失败" };
  }
});

/* --------------------------------------------- 笔记 AI 助教 / Obsidian 桥接 */

ipcMain.handle("note:tutor", (event, input) => {
  return noteTutor.tutorNote(input || {});
});

ipcMain.handle("note:addImage", (event, input) => {
  return noteAssets.saveImage(input || {});
});

ipcMain.handle("note:removeImage", (event, input) => {
  return noteAssets.removeImage(input || {});
});

/* --------------------------------------------- Obsidian 联动（Node 引擎） */

/**
 * 笔记 ↔ Obsidian 主链路已经改由 src/main/obsidian 用 Node 实现：
 * 不依赖 Python、vault 落在 userData、保存笔记即同步。
 * 下面保留 bridge.py 的调用能力，只用于「收件箱识图整理」这类可选增强功能。
 */
const OBSIDIAN_DIR = [
  process.resourcesPath ? path.join(process.resourcesPath, "obsidian") : null,
  path.join(__dirname, "obsidian"),
].filter(Boolean)
  .find((candidate) => fs.existsSync(path.join(candidate, "bridge.py")))
  || path.join(__dirname, "obsidian");

/** 调 obsidian/bridge.py（可选增强，需要本机 Python 3） */
function runBridge(command, args = [], timeoutMs = 180000) {
  return new Promise(async (resolve) => {
    const script = path.join(OBSIDIAN_DIR, "bridge.py");
    if (!fs.existsSync(script)) {
      resolve({ success: false, error: "这台机器上没有 obsidian/ 增强套件，该功能不可用（笔记同步不受影响）" });
      return;
    }
    const detected = await obsidianSync.detectPython();
    if (!detected.available) {
      resolve({ success: false, error: "没检测到 Python 3，装好后再试（笔记同步不受影响）" });
      return;
    }
    const python = process.env.OPENEXAM_PYTHON || detected.command;

    let child;
    try {
      child = spawn(python, [...(detected.baseArgs || []), script, command, ...args], {
        cwd: path.dirname(OBSIDIAN_DIR),
        windowsHide: true,
        env: { ...process.env, OPENEXAM_VAULT: obsidianSync.resolveVaultDir() },
      });
    } catch (error) {
      resolve({ success: false, error: `启动 Python 失败：${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* 进程可能已退出 */ }
      finish({ success: false, error: `${command} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已中断` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ success: false, error: `调用 Python 失败：${error.message}` }));
    child.on("close", (code) => finish({
      success: code === 0,
      code,
      stdout: stdout.slice(-6000),
      stderr: stderr.slice(-3000),
      error: code === 0
        ? ""
        : (stderr.trim().split("\n").filter(Boolean).pop() || `bridge.py ${command} 退出码 ${code}`),
    }));
  });
}

ipcMain.handle("obsidian:status", () => obsidianSync.status());

ipcMain.handle("obsidian:sync", () => {
  try {
    const result = obsidianSync.refresh({ mindmap: true });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:refresh", () => {
  try {
    const result = obsidianSync.refresh();
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:mindmap", () => {
  try {
    const result = obsidianSync.refresh({ pull: false });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:setVault", async (event, dir) => {
  try {
    const vaultDir = obsidianSync.setVaultDir(dir);
    const { migration } = obsidianSync.ensureReady();
    const registration = obsidianSync.registerVault();
    const result = obsidianSync.refresh();
    return { success: true, vaultDir, migration, registration, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:chooseVault", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 Obsidian 仓库目录",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "用这个目录",
  });
  if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
  const dir = result.filePaths[0];
  try {
    const vaultDir = obsidianSync.setVaultDir(dir);
    obsidianSync.ensureReady();
    const registration = obsidianSync.registerVault();
    const refreshed = obsidianSync.refresh();
    return { success: true, vaultDir, registration, result: refreshed };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:setAutoSync", (event, enabled) => {
  try {
    return { success: true, enabled: obsidianSync.setAutoSync(Boolean(enabled)) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:openMap", async () => {
  const vaultDir = obsidianSync.resolveVaultDir();
  const canvas = path.join(vaultDir, "20-思维导图", "知识地图.canvas");
  if (!fs.existsSync(canvas)) {
    return { success: false, error: "知识地图还没生成，先点一次「同步到 Obsidian」" };
  }
  const obsidianApp = await runtimeEnv.detectObsidian();

  // 没装 Obsidian：先看系统里有没有别的程序能打开 .canvas，否则给可读提示 + 下载入口
  if (!obsidianApp.installed) {
    const opened = await shell.openPath(canvas);
    if (!opened) {
      return { success: true, via: "system", fallback: "obsidian-missing", message: "本机没装 Obsidian，已用系统默认程序打开知识地图文件。" };
    }
    return {
      success: false,
      code: "obsidian-missing",
      error: "知识地图文件已生成，但本机没有能打开 .canvas 的程序。安装 Obsidian 后即可查看；这不影响笔记与题库使用。",
      downloadUrl: obsidianApp.downloadUrl,
    };
  }

  // 优先交给系统默认程序（装了 Obsidian 就会用 Obsidian 打开 .canvas）
  const directError = await shell.openPath(canvas);
  if (!directError) return { success: true, via: "system" };

  // 没有文件关联时退回 obsidian:// 协议
  const uri = `obsidian://open?vault=${encodeURIComponent(obsidianSync.vaultKey())}`
    + `&file=${encodeURIComponent("20-思维导图/知识地图.canvas")}`;
  try {
    await shell.openExternal(uri);
    return { success: true, via: "obsidian-uri" };
  } catch (error) {
    return { success: false, error: directError || error.message };
  }
});

ipcMain.handle("obsidian:openVault", async () => {
  const vaultDir = obsidianSync.resolveVaultDir();
  if (!fs.existsSync(vaultDir)) {
    return { success: false, error: "仓库目录还没建好，先同步一次" };
  }
  const obsidianApp = await runtimeEnv.detectObsidian();

  // 没装 Obsidian：回落到系统默认程序打开仓库文件夹，并明确告诉用户
  if (!obsidianApp.installed) {
    const fallbackError = await shell.openPath(vaultDir);
    return fallbackError
      ? {
        success: false,
        code: "obsidian-missing",
        error: "本机没装 Obsidian，也打不开仓库文件夹。笔记仍保存在应用里，可以从笔记页正常查看。",
        downloadUrl: obsidianApp.downloadUrl,
      }
      : {
        success: true,
        via: "system",
        fallback: "obsidian-missing",
        message: "本机没装 Obsidian，已用系统默认程序打开仓库文件夹。安装后可在 Obsidian 里直接看到这些笔记。",
      };
  }

  const uri = `obsidian://open?vault=${encodeURIComponent(obsidianSync.vaultKey())}`;
  try {
    await shell.openExternal(uri);
    return { success: true };
  } catch (error) {
    const fallbackError = await shell.openPath(vaultDir);
    return fallbackError ? { success: false, error: fallbackError } : { success: true, via: "system" };
  }
});

ipcMain.handle("obsidian:openNote", async (event, noteId) => {
  let info;
  try {
    info = obsidianSync.resolveNoteFile(noteId);
  } catch (error) {
    return { success: false, error: error.message };
  }
  if (!info.ok) return { success: false, error: info.error };

  const obsidianApp = await runtimeEnv.detectObsidian();

  // 仓库已经登记在 Obsidian 里 → 用 obsidian://open 直接定位到这一篇，
  // 而不是开整个仓库再让用户自己找。file 参数用相对路径（不带 .md 也可以）。
  if (obsidianApp.installed && obsidianSync.isVaultRegistered()) {
    const uri = `obsidian://open?vault=${encodeURIComponent(obsidianSync.vaultKey())}`
      + `&file=${encodeURIComponent(info.obsidianFile)}`;
    try {
      await shell.openExternal(uri);
      return { success: true, via: "obsidian-uri", file: info.file, synced: info.synced };
    } catch (error) {
      console.warn('[Obsidian] obsidian:// 打开失败，改用系统默认程序:', error?.message || error);
    }
  }

  // 没装 Obsidian / 协议没注册 → 交给系统默认程序打开这个 .md
  const directError = await shell.openPath(info.absolute);
  if (directError) {
    return {
      success: false,
      code: obsidianApp.installed ? 'open-failed' : 'obsidian-missing',
      error: obsidianApp.installed
        ? `打开笔记文件失败：${directError}`
        : "本机没装 Obsidian，也没有能打开 Markdown 的默认程序。笔记内容仍保存在应用内，可以直接在笔记页阅读。",
      downloadUrl: obsidianApp.installed ? '' : obsidianApp.downloadUrl,
    };
  }
  return {
    success: true,
    via: "system",
    file: info.file,
    synced: info.synced,
    fallback: obsidianApp.installed ? '' : 'obsidian-missing',
    message: obsidianApp.installed ? '' : "本机没装 Obsidian，已用系统默认程序打开这篇笔记。",
  };
});

ipcMain.handle("obsidian:revealNote", (event, noteId) => {
  try {
    const info = obsidianSync.resolveNoteFile(noteId);
    if (!info.ok) return { success: false, error: info.error };
    shell.showItemInFolder(info.absolute);
    return { success: true, file: info.file };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:notePath", (event, noteId) => {
  try {
    const info = obsidianSync.resolveNoteFile(noteId);
    return info.ok
      ? { success: true, file: info.file, absolute: info.absolute }
      : { success: false, error: info.error };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("obsidian:openFolder", async () => {
  const vaultDir = obsidianSync.resolveVaultDir();
  fs.mkdirSync(vaultDir, { recursive: true });
  const error = await shell.openPath(vaultDir);
  return error ? { success: false, error } : { success: true };
});

/** 收件箱识图整理等可选增强（需要 Python） */
ipcMain.handle("obsidian:advanced", (event, command) => {
  // sync / all 会调 Python 的 oe_bank.sync，把整套行测题库镜像重新生成进 90-题库/。
  // 用户当前科目（自动控制原理等）跟行测无关，那 78 篇镜像是噪声，清掉后不能再让它们复活。
  const allowed = new Set(["format", "import", "status"]);
  if (String(command) === "sync" || String(command) === "all") {
    return { success: false, error: "题库镜像同步已停用：当前只保留与科目相关的笔记。需要整套行测题库镜像时再开启。" };
  }
  if (!allowed.has(String(command))) return { success: false, error: "不支持的增强命令" };
  return runBridge(String(command), [], 300000);
});

// IPC 处理器 - 申论
ipcMain.handle("essay:savePrompt", (event, input) => database.saveEssayPrompt(input || {}));
ipcMain.handle("essay:listPrompts", (event, options) => database.getEssayPrompts(options || {}));
ipcMain.handle("essay:getPrompt", (event, id) => database.getEssayPrompt(id));
ipcMain.handle("essay:deletePrompt", (event, id) => database.deleteEssayPrompt(id));
ipcMain.handle("essay:saveAttempt", (event, input) => database.saveEssayAttempt(input || {}));
ipcMain.handle("essay:listAttempts", (event, options) => database.getEssayAttempts(options || {}));
ipcMain.handle("essay:getAttempt", (event, id) => database.getEssayAttempt(id));
ipcMain.handle("essay:deleteAttempt", (event, id) => database.deleteEssayAttempt(id));
ipcMain.handle("essay:recommend", (event, options) => database.getEssayRecommendation(options || {}));

/**
 * 细粒度重新分类：只重跑勾选的题目。
 * 取题方式由「按试卷」换成「按 id」，其余分批 / 并发 / 分类 / 回写逻辑与
 * ai:reclassifyPaper 完全一致，复用 aiService.classifyQuestions 与
 * database.applyQuestionClassifications，不改题干和答案。
 * 进度复用 ai:reclassify:progress，渲染层可共用同一套监听与取消。
 */
ipcMain.handle("ai:reclassifyQuestions", async (event, { settings, questionIds, onlyMissing, requestId } = {}) => {
  const { controller } = getRecognitionController(requestId);
  const signal = controller?.signal;
  const sender = event.sender;
  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("ai:reclassify:progress", { requestId, ...payload });
  };

  const ids = Array.from(new Set(
    (Array.isArray(questionIds) ? questionIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  ));
  if (!ids.length) return { total: 0, classified: 0, failed: 0, changed: 0, cancelled: false };

  // 与 getQuestionsForReclassify 相同的精简题干，只把「按试卷取题」换成「按 id 取题」
  const rows = database.getQuestionsByIds(ids);
  const subjectMap = database.getSubjectsForPaperIds(rows.map((row) => row.paper_id));
  const subjectOf = (row) => subjectMap[String(row.paper_id || '')] || null;
  const questions = rows
    .filter((row) => {
      if (!onlyMissing) return true;
      const subject = subjectOf(row);
      const isCustomSubject = Boolean(subject) && !String(subject.categoryKey || '').trim();
      const subCategory = String(row.sub_category || '').trim();
      if (isCustomSubject && (!subCategory || subCategory === 'general' || Boolean(MODULE_LABELS[subCategory]))) {
        return true;
      }
      const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').filter(Boolean);
      return database.isMissingChapter(row.chapter) || tags.length === 0;
    })
    .map((row) => ({
      id: row.id,
      paperId: row.paper_id,
      category: String(row.category || ''),
      subCategory: String(row.sub_category || ''),
      chapter: String(row.chapter || ''),
      content: String(row.content || '').replace(/\s+/g, ' ').slice(0, 240),
      options: (Array.isArray(row.options) ? row.options : [])
        .map((option) => `${option.key}.${String(option.content || '').replace(/\s+/g, ' ').slice(0, 40)}`)
        .join(' ')
        .slice(0, 200),
    }))
    .filter((row) => row.content);

  return subjectClassify.reclassifyQuestions({
    database,
    settings,
    questions,
    resolveSubject: (question) => subjectMap[String(question.paperId || '')] || null,
    signal,
    requestId,
    onProgress: send,
  });
});

ipcMain.handle("app:getInfo", () => {
  return updater.getAppInfo();
});

ipcMain.handle("app:getUpdateState", () => {
  return updater.getUpdateState();
});

ipcMain.handle("app:checkForUpdates", async () => {
  return updater.checkForUpdates();
});

ipcMain.handle("app:quitAndInstallUpdate", () => {
  return updater.quitAndInstallUpdate();
});

ipcMain.handle("app:openReleasePage", async () => {
  return updater.openReleasePage();
});

ipcMain.handle("app:openExternal", async (event, targetUrl) => {
  return updater.openExternal(targetUrl);
});

ipcMain.handle("app:getProfile", () => {
  return database.getUserProfile();
});

ipcMain.handle("app:saveProfile", (event, input) => {
  return database.saveUserProfile(input || {});
});

ipcMain.handle("paper:exportPdf", async (event, payload) => {
  return paperExport.exportPaperPdf(BrowserWindow.fromWebContents(event.sender), payload || {});
});

// AI 相关 IPC 处理器
const aiService = require("./src/main/ai/index.js");
const { buildSubjectBlock } = require("./src/main/subjectContext.js");
const activeRecognitionTasks = new Map();

function getRecognitionController(requestId) {
  const id = String(requestId || "").trim();
  if (!id) return { id: "", controller: null };
  let controller = activeRecognitionTasks.get(id);
  if (!controller) {
    controller = new AbortController();
    activeRecognitionTasks.set(id, controller);
    const timer = setTimeout(() => {
      if (activeRecognitionTasks.get(id) === controller) activeRecognitionTasks.delete(id);
    }, 10 * 60 * 1000);
    timer.unref?.();
  }
  return { id, controller };
}

ipcMain.handle("ai:testConnection", async (event, settings) => {
  return aiService.testConnection(settings);
});

ipcMain.handle("ai:recognizeQuestions", async (event, { settings, imageBase64, mimeType, requestId }) => {
  const { controller } = getRecognitionController(requestId);
  const startedAt = Date.now();
  console.info(`[AI][Import][${requestId || 'no-request'}] question recognition start`, { provider: settings?.aiProvider || '', model: settings?.model || settings?.customModel || '', mimeType });
  try {
    const result = await aiService.recognizeQuestions(settings, imageBase64, mimeType, { signal: controller?.signal });
    console.info(`[AI][Import][${requestId || 'no-request'}] question recognition done`, { ms: Date.now() - startedAt, questions: result?.questions?.length || 0 });
    // AI 结果返回渲染层之前统一走教材格式层，避免 OCR 半成品直接进暂存 / 预览
    return formatAIResult(result);
  } catch (error) {
    console.warn(`[AI][Import][${requestId || 'no-request'}] question recognition failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    throw error;
  }
});

ipcMain.handle("ai:recognizeAnswers", async (event, { settings, imageBase64, mimeType, requestId }) => {
  const { controller } = getRecognitionController(requestId);
  const startedAt = Date.now();
  console.info(`[AI][Import][${requestId || 'no-request'}] answer recognition start`, { provider: settings?.aiProvider || '', model: settings?.model || settings?.customModel || '', mimeType });
  try {
    const result = await aiService.recognizeAnswers(settings, imageBase64, mimeType, { signal: controller?.signal });
    console.info(`[AI][Import][${requestId || 'no-request'}] answer recognition done`, { ms: Date.now() - startedAt, answers: result?.answers?.length || 0 });
    return formatAIResult(result);
  } catch (error) {
    console.warn(`[AI][Import][${requestId || 'no-request'}] answer recognition failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    throw error;
  }
});

ipcMain.handle("ai:structureQuestionsFromText", async (event, { settings, text, options, requestId }) => {
  const { controller } = getRecognitionController(requestId);
  const startedAt = Date.now();
  console.info(`[AI][Import][${requestId || 'no-request'}] text question recognition start`, { provider: settings?.aiProvider || '', model: settings?.model || settings?.customModel || '', chars: String(text || '').length });
  try {
    const raw = await aiService.structureQuestionsFromText(settings, text, { ...(options || {}), signal: controller?.signal });
    const parsed = aiService.parseAIJson ? aiService.parseAIJson(raw, ['questions']) : raw;
    const result = formatAIResult(parsed);
    console.info(`[AI][Import][${requestId || 'no-request'}] text question recognition done`, { ms: Date.now() - startedAt, questions: result?.questions?.length || 0 });
    return result;
  } catch (error) {
    console.warn(`[AI][Import][${requestId || 'no-request'}] text question recognition failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    return { questions: [], error: error.message || '文本题目解析失败' };
  }
});

ipcMain.handle("ai:structureAnswersFromText", async (event, { settings, text, options, requestId }) => {
  const { controller } = getRecognitionController(requestId);
  const startedAt = Date.now();
  console.info(`[AI][Import][${requestId || 'no-request'}] text answer recognition start`, { provider: settings?.aiProvider || '', model: settings?.model || settings?.customModel || '', chars: String(text || '').length });
  try {
    const raw = await aiService.structureAnswersFromText(settings, text, { ...(options || {}), signal: controller?.signal });
    const parsed = aiService.parseAIJson ? aiService.parseAIJson(raw, ['answers']) : raw;
    const result = formatAIResult(parsed);
    console.info(`[AI][Import][${requestId || 'no-request'}] text answer recognition done`, { ms: Date.now() - startedAt, answers: result?.answers?.length || 0 });
    return result;
  } catch (error) {
    console.warn(`[AI][Import][${requestId || 'no-request'}] text answer recognition failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    return { answers: [], error: error.message || '文本答案解析失败' };
  }
});

ipcMain.handle("ai:matchQuestionAnswers", async (event, { settings, questions, answers, options, requestId }) => {
  const { controller } = getRecognitionController(requestId);
  const startedAt = Date.now();
  console.info(`[AI][Import][${requestId || 'no-request'}] answer matching start`, { questions: questions?.length || 0, answers: answers?.length || 0 });
  try {
    const result = await aiService.matchQuestionAnswers(settings, questions, answers, { ...(options || {}), signal: controller?.signal });
    console.info(`[AI][Import][${requestId || 'no-request'}] answer matching done`, { ms: Date.now() - startedAt, matches: result?.matches?.length || 0 });
    return formatAIResult(result);
  } catch (error) {
    console.warn(`[AI][Import][${requestId || 'no-request'}] answer matching failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    throw error;
  }
});

/**
 * 题库重新分类：按「上传批次」重跑分类，只改分类字段，不动题干/答案。
 *
 * 分批 12 道一轮并发 2 路，进度通过 ai:reclassify:progress 推给渲染层；
 * 单批失败只记错并继续，最后一次性回写，避免半途写入导致分类状态割裂。
 */
ipcMain.handle("ai:reclassifyPaper", async (event, { settings, paperId, options, requestId } = {}) => {
  const { controller } = getRecognitionController(requestId);
  const signal = controller?.signal;
  const sender = event.sender;
  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("ai:reclassify:progress", { requestId, ...payload });
  };

  const subject = database.getSubjectsForPaperIds([paperId])[String(paperId || '').trim()] || null;
  const isCustomSubject = Boolean(subject) && !String(subject.categoryKey || '').trim();
  const allQuestions = database.getQuestionsForReclassify(paperId, { ...(options || {}), onlyMissing: false });

  // 自建科目残留旧 key（major 等）时，整批题都还没归到真实子类别，不能按「只补缺失」跳过
  const hasLegacyModule = isCustomSubject && allQuestions.some((row) => (
    !row.subCategory || row.subCategory === 'general' || Boolean(MODULE_LABELS[row.subCategory])
  ));
  const questions = (options?.onlyMissing && !hasLegacyModule)
    ? allQuestions.filter((row) => database.isMissingChapter(row.chapter) || !String(row.tags || '').trim())
    : allQuestions;

  return subjectClassify.reclassifyQuestions({
    database,
    settings,
    questions,
    resolveSubject: () => subject,
    signal,
    requestId,
    onProgress: send,
  });
});

/**
 * 按科目范围重新分类：助教「按知识图谱分类」动作的执行入口。
 *
 * 自建科目用教材知识清单解析出的「子类别 → 章节 → 知识点」目录约束模型，
 * 预置四科沿用共享题库大纲；无法判断的题不回写，结果里单独统计跳过数量。
 * 进度复用 ai:reclassify:progress。
 */
ipcMain.handle("ai:classifySubject", async (event, { settings, subjectId, options, requestId, confirmed } = {}) => {
  // 分类会写库，必须由确认卡片显式带上 confirmed，避免任何自动路径误触发
  if (confirmed !== true) throw new Error("分类需要用户确认后才能执行");
  const { controller } = getRecognitionController(requestId);
  const signal = controller?.signal;
  const sender = event.sender;
  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("ai:reclassify:progress", { requestId, ...payload });
  };

  const scope = database.getSubjectQuestionsForClassification(subjectId, options || {});
  const subject = subjectManager.getSubject(scope.subject.id);
  if (!subject) throw new Error("科目不存在");

  const categoryKey = String(subject.categoryKey || "").trim();
  const taxonomy = categoryKey ? null : parseKnowledgeSummaryTaxonomy(database.getSubjectKnowledgeContent(subject.id));
  if (!categoryKey && !taxonomy) {
    return {
      subject: scope.subject,
      total: 0,
      classified: 0,
      changed: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
      chapterDistribution: [],
      error: "该科目还没有可用的知识清单（教材未解析完成），无法按教材章节分类。",
    };
  }

  if (!scope.rows.length) {
    return {
      subject: scope.subject,
      total: 0,
      classified: 0,
      changed: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
      chapterDistribution: database.getSubjectChapterDistribution(scope.subject.id),
    };
  }

  const outcome = await subjectClassify.classifySubjectQuestions({
    database,
    settings,
    subject,
    questions: scope.rows,
    taxonomy,
    signal,
    requestId,
    onProgress: send,
  });

  return {
    subject: scope.subject,
    ...outcome,
    chapterDistribution: database.getSubjectChapterDistribution(scope.subject.id),
  };
});

ipcMain.handle("ai:cancelRecognition", async (event, requestId) => {
  const id = String(requestId || "").trim();
  const controller = activeRecognitionTasks.get(id);
  if (!controller) return { success: false };
  controller.abort();
  activeRecognitionTasks.delete(id);
  return { success: true };
});

ipcMain.handle("ai:chat", async (event, { settings, messages, subjectId }) => {
  // 绑定科目的对话：AI 老师也加载 Good Learning 方法论与科目现状
  const subjectBlock = buildSubjectBlock(subjectId, { digestOnly: false, messages });
  const options = subjectBlock.text ? { system: `You are a patient, rigorous AI teacher for a Chinese learning platform. 用中文讲解。${subjectBlock.text}` } : {};
  const result = await aiService.chat(settings, messages, options);
  const cited = validateCitations(result?.content || "", subjectBlock.citations);
  return { ...result, content: cited.content, citations: cited.citations };
});

ipcMain.handle("ai:gradeEssay", async (event, { settings, payload }) => {
  return aiService.gradeEssay(settings, payload || {});
});

ipcMain.handle("ai:recognizeEssay", async (event, { settings, imageBase64, mimeType }) => {
  return aiService.recognizeEssay(settings, imageBase64, mimeType);
});

ipcMain.handle("ai:gradeHandwrittenAnswer", async (event, { settings, payload, imageBase64, mimeType } = {}) => {
  const requestId = `ipc_grade_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  console.info(`[IPC][GradeHandwritten][${requestId}] start`, { mimeType, hasImage: Boolean(imageBase64) });
  try {
    const result = await aiService.gradeHandwrittenAnswer(settings, payload || {}, imageBase64, mimeType);
    console.info(`[IPC][GradeHandwritten][${requestId}] done`, { ms: Date.now() - startedAt, success: result?.success });
    return result;
  } catch (error) {
    console.warn(`[IPC][GradeHandwritten][${requestId}] failed`, { ms: Date.now() - startedAt, error: error?.message || String(error) });
    return { success: false, error: error?.message || '手写答案批改失败' };
  }
});

ipcMain.handle("ai:generatePaper", async (event, { settings, config }) => {
  const requestId = `ipc_gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  console.info(`[IPC][Generate][${requestId}] start`, {
    provider: settings?.aiProvider || "",
    model: settings?.model || settings?.customModel || "",
    apiFormat: settings?.apiFormat || "",
    track: config?.track,
    focus: config?.focus,
    mode: config?.mode,
    count: config?.count,
    category: config?.category,
    mixedCategories: Array.isArray(config?.mixedCategories) ? config.mixedCategories.join(",") : "",
    difficulty: config?.difficulty,
  });

  const result = formatAIResult(await aiService.generatePaper(settings, config));

  console.info(`[IPC][Generate][${requestId}] done`, {
    elapsedMs: Date.now() - startedAt,
    success: Boolean(result?.success),
    questions: Array.isArray(result?.questions) ? result.questions.length : 0,
    debugId: result?.debugId || "",
    error: result?.success ? "" : String(result?.error || ""),
  });

  return result;
});

/* --------------------------------------------- AI 助教 Agent（左侧面板） */

const assistantAgent = require("./src/main/assistantAgent.js");
const subjectManager = require("./src/main/subjectManager.js");
const subjectTextbook = require("./src/main/subjectTextbook.js");
const activeAssistantStreams = new Map();

/* ------------------------------------------------ AI 助教（合并后的统一入口） */

const aiChat = require("./src/main/aiChat.js");
const aiAssets = require("./src/main/aiAssets.js");
const phoneUpload = require("./src/main/phoneUpload.js");
const shareImport = require("./src/main/shareImport.js");

function emitAiChatEvent(sender, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send("aiChat:event", payload);
}

ipcMain.handle("aiChat:getContext", () => {
  try { return assistantAgent.buildContextSnapshot(database); } catch { return null; }
});

/** 非流式：外部导入结构化、以及需要一次性结果的场景 */
ipcMain.handle("aiChat:chat", async (event, payload = {}) => {
  try {
    return await aiChat.chat({
      settings: payload.settings,
      database,
      messages: payload.messages,
      images: payload.images,
      subjectId: payload.subjectId,
      sessionId: payload.sessionId,
      questionContext: payload.questionContext,
    });
  } catch (error) {
    return { success: false, error: error?.message || 'AI 请求失败' };
  }
});

/** 外部对话导入：把粘贴文本 / 文件内容 / 截图整理成结构化对话（不落库） */
ipcMain.handle("aiChat:structureChatLog", async (event, payload = {}) => {
  try {
    return await aiChat.structureChatLog({
      settings: payload.settings,
      text: payload.text,
      images: payload.images,
    });
  } catch (error) {
    return { success: false, error: error?.message || "整理对话失败" };
  }
});

/** 预览确认后落库：建「导入」会话并写入消息 */
ipcMain.handle("aiChat:importChatLog", (event, payload = {}) => {
  try {
    return aiChat.importChatLog({
      database,
      title: payload.title,
      subjectId: payload.subjectId,
      messages: payload.messages,
    });
  } catch (error) {
    return { success: false, error: error?.message || "导入失败" };
  }
});

/**
 * 分享链接导入（DeepSeek 未公开接口，脆弱能力）
 * 只负责读取并当场下载附件；确认入库仍走现有预览流程。
 */
ipcMain.handle("aiChat:importShareLink", async (event, payload = {}) => {
  try {
    return await shareImport.fetchAndPrepare({
      url: payload.url,
      includeThinking: Boolean(payload.includeThinking),
    });
  } catch (error) {
    return {
      success: false,
      code: "UNKNOWN",
      error: error?.message || "读取分享失败",
      hint: "请改用复制全文或截图导入。",
    };
  }
});

ipcMain.handle("aiChat:commitShareImport", (event, payload = {}) => {
  try {
    return shareImport.commit({
      database,
      importId: payload.importId,
      title: payload.title,
      subjectId: payload.subjectId,
      messages: payload.messages,
    });
  } catch (error) {
    return { success: false, code: "UNKNOWN", error: error?.message || "导入失败", hint: "" };
  }
});

/**
 * 手机扫码传图：只在用户点开时临时监听局域网端口，关闭 / 超时 / 退出应用即停止。
 * 事件走 phoneUpload:event（opened / images / closed）。
 */
ipcMain.handle("phoneUpload:start", async (event, options = {}) => {
  const sender = event.sender;
  try {
    return await phoneUpload.start({
      ttlMs: options.ttlMs,
      idleMs: options.idleMs,
      title: options.title,
      lead: options.lead,
      onEvent: (payload) => {
        if (sender && !sender.isDestroyed()) sender.send("phoneUpload:event", payload);
      },
    });
  } catch (error) {
    return {
      success: false,
      code: "START_FAILED",
      error: error?.message || "启动手机传图失败",
      hint: "请重试；如果反复失败，检查是否有安全软件拦截本地端口监听。",
    };
  }
});

ipcMain.handle("phoneUpload:stop", () => phoneUpload.stop("user"));

ipcMain.handle("phoneUpload:status", () => phoneUpload.status());

/** 流式：答疑与做事共用；事件走 aiChat:event（delta / done / error / cancelled） */
ipcMain.handle("aiChat:chatStreamStart", async (event, payload = {}) => {
  const requestId = String(payload.requestId || "").trim();
  if (!requestId) return { success: false, error: "requestId 不能为空" };

  const sender = event.sender;
  const previous = activeAssistantStreams.get(requestId);
  if (previous) {
    try { previous.abortController.abort(); } catch { /* 忽略 */ }
    activeAssistantStreams.delete(requestId);
  }

  const abortController = new AbortController();
  activeAssistantStreams.set(requestId, { abortController, senderId: sender.id });

  (async () => {
    try {
      const result = await aiChat.chatStream({
        settings: payload.settings,
        database,
        messages: payload.messages,
        images: payload.images,
        subjectId: payload.subjectId,
        sessionId: payload.sessionId,
        questionContext: payload.questionContext,
        signal: abortController.signal,
        onDelta: (delta) => emitAiChatEvent(sender, { requestId, type: "delta", delta }),
      });
      if (abortController.signal.aborted) {
        emitAiChatEvent(sender, { requestId, type: "cancelled" });
        return;
      }
      emitAiChatEvent(sender, { requestId, type: "done", ...result });
    } catch (error) {
      if (abortController.signal.aborted) {
        emitAiChatEvent(sender, { requestId, type: "cancelled" });
      } else {
        emitAiChatEvent(sender, { requestId, type: "error", error: error?.message || "AI 请求失败" });
      }
    } finally {
      activeAssistantStreams.delete(requestId);
    }
  })();

  return { success: true };
});

ipcMain.handle("aiChat:chatStreamCancel", (event, requestId) => {
  const id = String(requestId || "").trim();
  const holder = activeAssistantStreams.get(id);
  if (!holder) return { success: false };
  try { holder.abortController.abort(); } catch { /* 忽略 */ }
  activeAssistantStreams.delete(id);
  return { success: true };
});

ipcMain.handle("aiChat:saveMessageImages", (event, input = {}) => aiAssets.saveImages(input || {}));
ipcMain.handle("aiChat:readImage", (event, relativePath) => aiAssets.readImage(relativePath));
ipcMain.handle("aiChat:imageStats", (event, sessionId) => aiAssets.stats(sessionId));
ipcMain.handle("aiChat:cleanupImages", () => aiAssets.cleanupAll());
ipcMain.handle("aiChat:updateMessageMeta", (event, { messageId, meta } = {}) => database.updateAIChatMessageMeta(messageId, meta));
ipcMain.handle("aiChat:setSessionContext", (event, { sessionId, context } = {}) => {
  // 发新消息时用题目上下文覆盖 context_json，但要保留工作台写入的分析记忆
  try {
    const prev = database.getAIChatSession(sessionId);
    const prevContext = prev?.context_json ? JSON.parse(prev.context_json) : null;
    if (prevContext?.analysis && context && typeof context === 'object' && !Array.isArray(context)) {
      return database.updateAIChatSessionContext(sessionId, { ...context, analysis: prevContext.analysis });
    }
  } catch { /* 解析失败按原逻辑覆盖 */ }
  return database.updateAIChatSessionContext(sessionId, context);
});

/** 学科分析工作台：把结果并入会话上下文，供后续追问引用 */
ipcMain.handle("aiChat:saveSessionAnalysis", (event, { sessionId, analysis } = {}) => {
  try {
    return database.saveAIChatSessionAnalysis(sessionId, analysis);
  } catch (error) {
    return { success: false, error: error?.message || '保存分析结果失败' };
  }
});

/** 题目级分析缓存：同一道题在新会话里重开工作台时直接复用，避免重新读题 / 重新求解 */
ipcMain.handle("analysis:getCache", (event, payload = {}) => {
  try {
    return database.getQuestionAnalysisCache(payload || {});
  } catch (error) {
    return { success: false, cache: null, error: error?.message || '读取分析缓存失败' };
  }
});

ipcMain.handle("analysis:saveCache", (event, payload = {}) => {
  try {
    return database.saveQuestionAnalysisCache(payload || {});
  } catch (error) {
    return { success: false, error: error?.message || '写入分析缓存失败' };
  }
});

/* --------------------------------------------- 科目体系（学习平台） */

ipcMain.handle("subject:save", (event, input) => {
  const subject = subjectManager.saveSubject(input || {});
  return subject;
});

ipcMain.handle("subject:list", () => {
  return subjectManager.getSubjects();
});

ipcMain.handle("subject:get", (event, id) => {
  return subjectManager.getSubject(id);
});

/* --------------------------------------------- 学科分析插件 */

ipcMain.handle("plugins:list", () => analysisPlugins.listPlugins());

ipcMain.handle("plugins:devMode", () => ({ allowThirdParty: analysisPlugins.allowThirdParty() }));

ipcMain.handle("plugins:detail", (event, id) => analysisPlugins.getDetail(id));

ipcMain.handle("plugins:forSubject", (event, subjectId) => analysisPlugins.forSubject(subjectId));

ipcMain.handle("plugins:setEnabled", (event, { id, enabled } = {}) =>
  analysisPlugins.setEnabled(id, enabled));

ipcMain.handle("plugins:import", async () => {
  const picked = await dialog.showOpenDialog({
    title: "导入学科分析插件",
    properties: ["openFile"],
    filters: [
      { name: "插件清单", extensions: ["json", "ssplugin"] },
    ],
  });
  if (picked.canceled || !picked.filePaths?.length) return { success: false, canceled: true };
  return analysisPlugins.importFromFile(picked.filePaths[0]);
});

ipcMain.handle("plugins:importFile", (event, filePath) => analysisPlugins.importFromFile(filePath));

ipcMain.handle("plugins:remove", (event, id) => analysisPlugins.removePlugin(id));

ipcMain.handle("plugins:extract", (event, payload = {}) => analysisPlugins.extract(payload));

ipcMain.handle("plugins:solve", (event, payload = {}) => analysisPlugins.solve(payload));

ipcMain.handle("plugins:explain", (event, payload = {}) => analysisPlugins.explain(payload));

/** 工作台左下角答疑：就当前相量图关系追问，可返回补充显示关系 */
ipcMain.handle("plugins:assist", (event, payload = {}) => analysisPlugins.assist(payload || {}));

/** 科目学习数据统计（题库/错题，含预置科目的分类联动） */
ipcMain.handle("subject:stats", (event, id) => {
  try {
    return subjectManager.getSubjectStats(id);
  } catch (error) {
    console.warn("[Subjects] 统计失败:", error?.message || error);
    return { papers: 0, questions: 0, wrong: 0 };
  }
});

ipcMain.handle("subject:delete", (event, id) => {
  return subjectManager.deleteSubject(id);
});

/** 读取教材某一页原文（引用溯源弹窗用，只读，不写用户数据） */
ipcMain.handle("subject:textbookPage", (event, { subjectId, page } = {}) => {
  const materialContext = require("./src/main/materialContext.js");
  return materialContext.readTextbookPage(subjectId, page);
});

ipcMain.handle("subject:saveTextbook", (event, { subjectId, pages, fileName, totalPages } = {}) => {
  return subjectTextbook.saveTranscription({ subjectId, pages, fileName, totalPages });
});

/** 单页结果即时落盘：中断/关闭应用后可以按页码续传，不必整本重来 */
ipcMain.handle("subject:saveTextbookPage", (event, payload = {}) => {
  try {
    return { success: true, ...subjectTextbook.saveTextbookPage(payload) };
  } catch (error) {
    console.warn("[Subjects] 单页落盘失败:", error?.message || error);
    return { success: false, error: error?.message || "单页落盘失败" };
  }
});

/** 教材页图落盘（整页兜底 + Obsidian 翻页） */
ipcMain.handle("subject:saveTextbookPageImage", (event, payload = {}) => {
  try {
    const textbookFigures = require("./src/main/textbookFigures.js");
    return { success: true, ...textbookFigures.savePageImage(payload) };
  } catch (error) {
    console.warn("[Subjects] 页图落盘失败:", error?.message || error);
    return { success: false, error: error?.message || "页图落盘失败" };
  }
});

/** 页内精确裁出的插图落盘并更新图号索引 */
ipcMain.handle("subject:saveTextbookFigures", (event, payload = {}) => {
  try {
    const textbookFigures = require("./src/main/textbookFigures.js");
    return { success: true, ...textbookFigures.saveFigures(payload) };
  } catch (error) {
    console.warn("[Subjects] 插图落盘失败:", error?.message || error);
    return { success: false, error: error?.message || "插图落盘失败" };
  }
});

/** 本地解析引擎探测（MinerU）：真实执行 Python / import mineru，不再返回假阳性 */
ipcMain.handle("subject:mineruDetect", async () => {
  try {
    return await require("./src/main/textbookMineru.js").detectMineru();
  } catch (error) {
    return { available: false, reason: error?.message || "探测失败" };
  }
});

/* ------------------------------------------------ 运行环境（MinerU / Python / Obsidian） */

/** 分项检测：Python 真执行、mineru 真 import、目录可写、模型字节数、脚本存在 */
ipcMain.handle("runtimeEnv:detect", (event, options = {}) => {
  return runtimeEnv.detectAll({ force: Boolean(options?.force) });
});

/** 一键安装：建 venv → pip install mineru → 下载模型；进度走 mineruEnv:progress */
ipcMain.handle("runtimeEnv:install", (event, input = {}) => {
  return runtimeEnv.installMineru(input || {});
});

ipcMain.handle("runtimeEnv:cancel", () => runtimeEnv.cancelInstall());
ipcMain.handle("runtimeEnv:state", () => runtimeEnv.getInstallState());

/** 手动指定 Python 解释器（已装过 Python 但不在 PATH 时用） */
ipcMain.handle("runtimeEnv:choosePython", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "选择 Python 解释器",
      buttonLabel: "使用这个 Python",
      properties: ["openFile"],
      filters: process.platform === "win32"
        ? [{ name: "Python 解释器", extensions: ["exe"] }]
        : [],
    });
    if (result.canceled || !result.filePaths?.[0]) return { success: false, canceled: true };
    return runtimeEnv.choosePython(result.filePaths[0]);
  } catch (error) {
    return { success: false, error: error?.message || "选择失败" };
  }
});

/** 复用本机旧的 D 盘环境（只改配置，不复制模型） */
ipcMain.handle("runtimeEnv:useLegacy", (event, input = {}) => {
  return runtimeEnv.useLegacyEnv(input || {});
});

/** 本地整本解析：MinerU 分批转写 → 逐批落盘 → 教材全文 */
ipcMain.handle("subject:parseTextbookLocal", (event, payload = {}) => {
  const textbookMineru = require("./src/main/textbookMineru.js");
  return textbookMineru.parseTextbookLocal({
    ...payload,
    onProgress: (progress) => {
      // 广播到所有窗口：资料管理页发起解析时，科目卡片也同步显示进度
      broadcastProgress({ subjectId: payload.subjectId, ...progress });
    },
  }).catch((error) => {
    console.error("[Subjects] 本地解析失败:", error?.message || error);
    return { error: error?.message || "本地解析失败" };
  });
});

/** 已完成的页码（断点续传） */
ipcMain.handle("subject:textbookProgress", (event, subjectId) => {
  try {
    return subjectTextbook.getTextbookProgress(subjectId);
  } catch (error) {
    console.warn("[Subjects] 读取解析进度失败:", error?.message || error);
    return { pages: [], fileName: null, total: 0, status: "none" };
  }
});

/** 解析中断：把状态从 parsing 落到 failed，避免卡片一直转圈 */
ipcMain.handle("subject:failTextbook", (event, { subjectId, error } = {}) => {
  return subjectTextbook.markTextbookFailed(subjectId, error);
});

/** 清空教材解析结果 */
ipcMain.handle("subject:resetTextbook", (event, subjectId) => {
  return subjectTextbook.resetTextbook(subjectId);
});

/* --------------------------------------------- 资料管理（主教材 + 补充资料） */

const materialManager = require("./src/main/materialManager.js");
const materialParser = require("./src/main/materialParser.js");
const materialParseQueue = require("./src/main/materialParseQueue.js");

/** 广播给所有渲染窗口（应用内资料管理页与科目卡片都需要同步状态） */
const broadcastToWindows = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
};
const changed = (subjectId) => broadcastToWindows("materials:changed", { subjectId });
const broadcastProgress = (payload) => broadcastToWindows("subject:mineruProgress", payload);

ipcMain.handle("materials:list", (event, subjectId) => {
  try {
    const data = materialManager.listMaterials(subjectId);
    const active = new Map(materialParseQueue.listTasks(subjectId).map((task) => [task.id, task]));
    data.supplementary = (data.supplementary || []).map((item) => {
      const task = active.get(item.id);
      if (task) return { ...item, parseTask: task };
      // 上次应用退出时中断的任务：队列里已不存在，回到「待解析」而不是永久显示解析中
      if (item.status === "parsing") {
        materialManager.patchSupplementary(subjectId, item.id, { status: "pending", error: null });
        return { ...item, status: "pending", error: null };
      }
      return item;
    });
    return { success: true, ...data };
  } catch (error) {
    return { success: false, error: error?.message || "读取资料清单失败", supplementary: [] };
  }
});

/** 系统文件对话框选学习资料（避免 file.path 在新版 Electron 里为空） */
ipcMain.handle("materials:pickFiles", async (event) => {
  try {
    const result = await dialog.showOpenDialog({
      title: "添加学习资料",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "学习资料", extensions: ["pdf", "pptx", "ppt", "md", "markdown", "txt", "png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (result.canceled) return { success: true, files: [] };
    return { success: true, files: result.filePaths };
  } catch (error) {
    return { success: false, error: error?.message || "选择文件失败" };
  }
});

ipcMain.handle("materials:add", (event, { subjectId, filePath, name } = {}) => {
  try {
    const entry = materialManager.addSupplementary({ subjectId, filePath, name });
    changed(subjectId);
    return { success: true, entry };
  } catch (error) {
    return { success: false, error: error?.message || "添加资料失败" };
  }
});

ipcMain.handle("materials:remove", (event, { subjectId, id } = {}) => {
  try {
    if (materialParseQueue.hasTask(subjectId, id)) {
      return { success: false, error: "资料正在解析，完成后再移除" };
    }
    const result = materialManager.removeSupplementary({ subjectId, id });
    if (result.success) changed(subjectId);
    return result;
  } catch (error) {
    return { success: false, error: error?.message || "删除资料失败" };
  }
});

/** 解析补充资料：主进程队列执行，页面切走也不中断；最多同时解析 2 份 */
ipcMain.handle("materials:parse", async (event, { subjectId, id } = {}) => {
  try {
    const item = materialManager.listMaterials(subjectId).supplementary.find((entry) => entry.id === id);
    if (!item) return { success: false, error: "资料不存在" };
    if (!["pdf", "pptx"].includes(item.kind)) {
      return { success: false, error: "该格式暂不支持自动转写" };
    }
    // 已解析完成且页数齐全的直接复用；有缺页时允许重新解析补齐
    if (item.status === "ready" && !(item.missingPages || []).length) return { success: true, already: true, chars: item.chars };

    // PDF 入队前先确认解析环境；缺项直接返回可操作提示，不用等任务失败
    if (item.kind === "pdf") {
      const env = await runtimeEnv.detectMineru();
      if (!env.ready) {
        return {
          success: false,
          code: "mineru-not-ready",
          error: env.message || "本地解析环境未就绪",
          missing: env.missing,
        };
      }
    }

    const { task, reused } = materialParseQueue.enqueue({
      subjectId,
      id,
      name: item.name,
      onStateChange: () => changed(subjectId),
      onProgress: (next) => broadcastProgress({
        subjectId, materialId: id, stage: "material", percent: next.percent, detail: next.detail,
      }),
      run: async (report) => {
        materialManager.patchSupplementary(subjectId, id, { status: "parsing", error: null });
        changed(subjectId);
        try {
          return await materialParser.parseSupplementary({
            subjectId,
            id,
            onProgress: (progress) => report(progress.percent, progress.detail),
          });
        } catch (error) {
          try { materialManager.patchSupplementary(subjectId, id, { status: "failed", error: error.message }); } catch { /* 忽略 */ }
          throw error;
        } finally {
          changed(subjectId);
        }
      },
    });
    changed(subjectId);
    return {
      success: true,
      queued: true,
      reused,
      task,
      concurrency: materialParseQueue.MAX_CONCURRENT,
    };
  } catch (error) {
    return { success: false, error: error?.message || "资料解析失败" };
  }
});

/**
 * 上传/更换主教材：纯本地 MinerU，不依赖 AI 配置。
 * 资料管理页里点「上传主教材」走这里，解析完成后知识清单/题目可在设置好 AI 后再补。
 */
ipcMain.handle("materials:uploadPrimary", async (event, { subjectId, pdfPath, fileName } = {}) => {
  if (!pdfPath || !fs.existsSync(pdfPath)) return { success: false, error: "PDF 路径无效" };

  // 预检：缺 Python / MinerU / 模型时直接返回可操作提示，不进入「解析中」，
  // 也不再把「下载模型」当成真正的解析进度先显示一遍。
  const env = await runtimeEnv.detectMineru();
  if (!env.ready) {
    return {
      success: false,
      code: "mineru-not-ready",
      error: env.message || "本地解析环境未就绪",
      missing: env.missing,
      action: { section: "runtime" },
    };
  }

  try {
    subjectManager.saveSubject({ id: subjectId, textbookName: fileName, textbookStatus: 'parsing' });
    changed(subjectId);
  } catch (error) {
    return { success: false, error: error?.message || "更新科目状态失败" };
  }
  // 探测器阶段（缺 Python、D 盘不可写）是同步抛错，必须和异步失败走同一条落盘路径，
  // 否则科目会永久停在「解析中」
  const markFailed = (error) => {
    try { subjectTextbook.markTextbookFailed(subjectId, error?.message || "解析失败"); } catch { /* 忽略 */ }
    changed(subjectId);
    return { success: false, error: error?.message || "主教材解析失败" };
  };

  let pending;
  try {
    pending = require("./src/main/textbookMineru.js").parseTextbookLocal({
      subjectId, pdfPath, fileName,
      onProgress: (progress) => broadcastProgress({ subjectId, ...progress }),
    });
  } catch (error) {
    return markFailed(error);
  }

  return pending.then((result) => {
    changed(subjectId);
    return { success: true, ...result };
  }).catch(markFailed);
});

/** 停止主教材解析：杀掉该科目的 MinerU 子进程，保留已落盘的批次供下次续传 */
ipcMain.handle("materials:cancelPrimary", async (event, subjectId) => {
  try {
    const cancelled = require("./src/main/textbookMineru.js").cancelTextbook(subjectId);
    return { success: true, cancelled };
  } catch (error) {
    return { success: false, error: error?.message || "停止解析失败" };
  }
});

/** 系统文件对话框选主教材 PDF */
ipcMain.handle("materials:pickPrimary", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "选择主教材 PDF", buttonLabel: "开始解析",
      properties: ["openFile"],
      filters: [{ name: "PDF 教材", extensions: ["pdf"] }],
    });
    if (result.canceled) return { success: true, path: null };
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    return { success: false, error: error?.message || "选择文件失败" };
  }
});

/** 章节结构表：读取（没有则现场识别并落盘） */
ipcMain.handle("subject:chapterStructure", (event, { subjectId, source = "auto" } = {}) => {
  try {
    const chapterStructure = require("./src/main/chapterStructure.js");
    const { structure, file, created, refreshed, backupPath } = chapterStructure.getStructure({ subjectId, source });
    return { success: true, structure, file, created, refreshed, backupPath };
  } catch (error) {
    return { success: false, error: error?.message || "读取章节结构失败" };
  }
});

/** 章节结构表：用户手动校正后保存 */
ipcMain.handle("subject:saveChapterStructure", (event, { subjectId, source = "auto", chapters } = {}) => {
  try {
    const chapterStructure = require("./src/main/chapterStructure.js");
    const { structure, file } = chapterStructure.saveStructure({ subjectId, source, chapters });
    return { success: true, structure, file };
  } catch (error) {
    return { success: false, error: error?.message || "保存章节结构失败" };
  }
});

/** 章节结构表：按原文重新识别（覆盖手工校正） */
ipcMain.handle("subject:rebuildChapterStructure", (event, { subjectId, source = "auto" } = {}) => {
  try {
    const chapterStructure = require("./src/main/chapterStructure.js");
    const { structure, file, backupPath } = chapterStructure.rebuildStructure({ subjectId, source });
    return { success: true, structure, file, backupPath };
  } catch (error) {
    return { success: false, error: error?.message || "重新识别章节结构失败" };
  }
});

/** 知识清单计划（只读）：章节范围、保留章节、批次数、续跑复用 */
ipcMain.handle("subject:planInventory", (event, payload = {}) => {
  try {
    const knowledgeInventory = require("./src/main/knowledgeInventory.js");
    const result = knowledgeInventory.planKnowledgeInventory(payload || {});
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error?.message || "生成知识清单计划失败" };
  }
});

/** 生成知识清单：按章分批，写进笔记库；支持起始章节 / 已学章节 / 补充资料来源 */
ipcMain.handle("subject:generateInventory", async (event, payload = {}) => {
  const {
    subjectId,
    settings,
    source,
    materialId,
    startChapter,
    learnedChapters,
    fromPage,
    toPage,
    modules,
    keepExisting,
    forceRerun,
    concurrency,
  } = payload;
  const requestId = `subj_inv_${Date.now()}`;
  const startedAt = Date.now();
  const sender = event.sender;
  console.info(`[Subjects][Inventory][${requestId}] start`, { subjectId, source, startChapter, fromPage, toPage });
  try {
    const result = await subjectTextbook.generateKnowledgeInventory({
      subjectId,
      settings,
      source,
      materialId,
      startChapter,
      learnedChapters,
      fromPage,
      toPage,
      modules,
      keepExisting,
      forceRerun,
      concurrency,
      onProgress: (progress) => {
        if (!sender || sender.isDestroyed()) return;
        sender.send("subject:inventory:progress", { requestId, ...progress });
      },
    });
    console.info(`[Subjects][Inventory][${requestId}] done`, {
      ms: Date.now() - startedAt,
      chars: result?.chars,
      chapters: result?.chapterCount,
      batches: result?.batches,
      truncated: result?.truncated,
      failed: result?.failedChapters?.length || 0,
      resumed: result?.resumedChapters?.length || 0,
      concurrency: result?.concurrency,
      elapsedMs: result?.elapsedMs,
    });
    return { success: true, ...result };
  } catch (error) {
    console.warn(`[Subjects][Inventory][${requestId}] failed`, { error: error?.message || String(error) });
    return { success: false, error: error?.message || "知识清单生成失败" };
  }
});

/** 教材例题习题提取进题库（逐块进行，进度推给渲染层） */
ipcMain.handle("subject:generateQuestions", async (event, { subjectId, settings, requestId, pages, title, paperId, source, materialIds } = {}) => {
  const { controller } = getRecognitionController(requestId);
  const sender = event.sender;
  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("subject:questions:progress", { requestId, ...payload });
  };
  try {
    const result = await subjectTextbook.generateTextbookQuestions({
      subjectId,
      settings,
      signal: controller?.signal,
      onProgress: (progress) => send({ stage: "progress", ...progress }),
      pages: pages || null,
      title: title || "",
      paperId: paperId || null,
      // 来源：有主教材时主进程会优先主教材；没有主教材时可用 materialIds 限定补充资料
      source: source || "auto",
      materialIds: Array.isArray(materialIds) ? materialIds : [],
    });
    send({ stage: "done", ...result });
    return { success: true, ...result };
  } catch (error) {
    console.warn("[Subjects][Questions] failed:", error?.message || error);
    return { success: false, error: error?.message || "题目提取失败" };
  }
});

/** API 额度/余额耗尽：必须让整本解析停下来，不能把剩下的几百页写成「转写失败」 */
function isInsufficientBalance(error) {
  const text = String(error?.message || error || '');
  return /insufficient[_\s-]?balance|余额不足|余额不够|out of (?:credits|quota)|quota exceeded|402\b|payment required/i.test(text);
}

ipcMain.handle("ai:transcribePage", async (event, { settings, imageBase64, mimeType, requestId, withFigures } = {}) => {
  const { controller } = getRecognitionController(requestId);
  try {
    const options = { signal: controller?.signal };
    const result = withFigures
      ? await aiService.transcribePageWithFigures(settings, imageBase64, mimeType || "image/jpeg", options)
      : { markdown: await aiService.transcribePage(settings, imageBase64, mimeType, options), figures: [], degraded: false };
    return { success: true, ...result };
  } catch (error) {
    console.warn("[AI][Transcribe] page failed:", error?.message || error);
    return {
      success: false,
      error: error?.message || "教材页转写失败",
      insufficientBalance: isInsufficientBalance(error),
    };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 数据库只在真正退出时关闭：macOS 关掉所有窗口后应用仍存活，
// 从 Dock 重新激活窗口时还要继续用同一个连接
app.on("will-quit", () => {
  phoneUpload.stop("quit");
  // 解析中途退出：结束仍在跑的 MinerU 提取器，避免留下孤儿进程
  try { parseProcesses.killAll(); } catch (error) { console.warn("[Parse] 结束解析子进程失败:", error?.message || error); }
  database.closeDatabase();
});
