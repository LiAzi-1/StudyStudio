const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openexam", {
  setTheme: (theme) => {
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
    }
  },

  // 数据库 API
  db: {
    getPapers: () => ipcRenderer.invoke("db:getPapers"),
    getQuestions: (paperId, limit) => ipcRenderer.invoke("db:getQuestions", paperId, limit),
    getQuestionsByIds: (ids) => ipcRenderer.invoke("db:getQuestionsByIds", ids),
    savePracticeRecord: (record) => ipcRenderer.invoke("db:savePracticeRecord", record),
    getPracticeRecords: () => ipcRenderer.invoke("db:getPracticeRecords"),
    addWrongQuestion: (data) => ipcRenderer.invoke("db:addWrongQuestion", data),
    getWrongQuestions: (options) => ipcRenderer.invoke("db:getWrongQuestions", options),
    getWrongQuestionById: (id) => ipcRenderer.invoke("db:getWrongQuestionById", id),
    saveCustomWrongQuestion: (input) => ipcRenderer.invoke("db:saveCustomWrongQuestion", input),
    reviewWrongQuestion: (input) => ipcRenderer.invoke("db:reviewWrongQuestion", input),
    removeWrongQuestion: (input) => ipcRenderer.invoke("db:removeWrongQuestion", input),
    addWrongImage: (input) => ipcRenderer.invoke("wrong:addImage", input),
    removeWrongImage: (input) => ipcRenderer.invoke("wrong:removeImage", input),
    updatePracticeRecordScore: (input) => ipcRenderer.invoke("db:updatePracticeRecordScore", input),
    getCategoryStats: () => ipcRenderer.invoke("db:getCategoryStats"),
    getKnowledgeGraph: () => ipcRenderer.invoke("db:getKnowledgeGraph"),
    getReclassifyBatches: () => ipcRenderer.invoke("db:getReclassifyBatches"),
    getQuestionsByKnowledge: (options) => ipcRenderer.invoke("db:getQuestionsByKnowledge", options),
    getSmartRecommend: (options) => ipcRenderer.invoke("db:getSmartRecommend", options),
    getSubCategoryStats: (category) => ipcRenderer.invoke("db:getSubCategoryStats", category),
    getPracticeStats: () => ipcRenderer.invoke("db:getPracticeStats"),
    resetStudyProgress: (category) => ipcRenderer.invoke("db:resetStudyProgress", category),
    importPaper: (paperData, questions) => ipcRenderer.invoke("db:importPaper", { paperData, questions }),
    appendImportedQuestions: (paperId, questions) => ipcRenderer.invoke("db:appendImportedQuestions", { paperId, questions }),
    stageImportedQuestions: (input) => ipcRenderer.invoke("db:stageImportedQuestions", input),
    updateStagedQuestions: (input) => ipcRenderer.invoke("db:updateStagedQuestions", input),
    getPendingStagedQuestions: (input) => ipcRenderer.invoke("db:getPendingStagedQuestions", input),
    getStagingSummary: (input) => ipcRenderer.invoke("db:getStagingSummary", input),
    recoverStagedImports: (input) => ipcRenderer.invoke("db:recoverStagedImports", input),
    clearStagedQuestions: (input) => ipcRenderer.invoke("db:clearStagedQuestions", input),
    saveAIPaper: (paperData, questions) => ipcRenderer.invoke("db:saveAIPaper", { paperData, questions }),
    getImportedPapers: () => ipcRenderer.invoke("db:getImportedPapers"),
    getSavedAIPapers: () => ipcRenderer.invoke("db:getSavedAIPapers"),
    renameSavedPaper: (paperId, title) => ipcRenderer.invoke("db:renameSavedPaper", { paperId, title }),
    deleteSavedPaper: (paperId) => ipcRenderer.invoke("db:deleteSavedPaper", { paperId }),
    getQuestionsByCategory: (category, subCategory, limit, shuffle) =>
      ipcRenderer.invoke("db:getQuestionsByCategory", { category, subCategory, limit, shuffle }),
    getCategoryMaterialStats: (category) =>
      ipcRenderer.invoke("db:getCategoryMaterialStats", category || "ziliao"),
    getDailyStats: (days) => ipcRenderer.invoke("db:getDailyStats", days),
    getStreakDays: () => ipcRenderer.invoke("db:getStreakDays"),
    getTodayStats: () => ipcRenderer.invoke("db:getTodayStats"),
    getHeatmapData: (days) => ipcRenderer.invoke("db:getHeatmapData", days),
    getGrowthData: () => ipcRenderer.invoke("db:getGrowthData"),
    getAppSetting: (key) => ipcRenderer.invoke("db:getAppSetting", key),
    setAppSetting: (key, value) => ipcRenderer.invoke("db:setAppSetting", { key, value }),
    getAISettings: () => ipcRenderer.invoke("db:getAISettings"),
    saveAISettings: (settings) => ipcRenderer.invoke("db:saveAISettings", settings),
    getAIConnectionState: () => ipcRenderer.invoke("db:getAIConnectionState"),
    saveAIConnectionState: (state) => ipcRenderer.invoke("db:saveAIConnectionState", state),
    createAIChatSession: (input) => ipcRenderer.invoke("db:createAIChatSession", input),
    getAIChatSessions: (limit) => ipcRenderer.invoke("db:getAIChatSessions", limit),
    getAIChatMessages: (sessionId, limit) => ipcRenderer.invoke("db:getAIChatMessages", sessionId, limit),
    addAIChatMessage: (input) => ipcRenderer.invoke("db:addAIChatMessage", input),
    renameAIChatSession: (sessionId, title) => ipcRenderer.invoke("db:renameAIChatSession", sessionId, title),
    deleteAIChatSession: (sessionId) => ipcRenderer.invoke("db:deleteAIChatSession", sessionId),
    exportAllData: () => ipcRenderer.invoke("db:exportAllData"),
    exportBackupFile: (clientState) => ipcRenderer.invoke("db:exportBackupFile", clientState),
    importBackupFile: () => ipcRenderer.invoke("db:importBackupFile"),
    listLocalBackups: () => ipcRenderer.invoke("db:listLocalBackups"),
    createLocalBackup: () => ipcRenderer.invoke("db:createLocalBackup"),
    restoreLocalBackup: (name) => ipcRenderer.invoke("db:restoreLocalBackup", name),
    resetUserData: () => ipcRenderer.invoke("db:resetUserData"),
    clearAllData: () => ipcRenderer.invoke("db:clearAllData"),
  },

  // 今日复习队列（错题阶梯到期）
  review: {
    getTodayQueue: () => ipcRenderer.invoke("review:getTodayQueue"),
    addToday: (id) => ipcRenderer.invoke("review:addToday", id),
  },

  // 每日一练
  dailyPractice: {
    getToday: (date) => ipcRenderer.invoke("daily:get", date),
    ensure: (input) => ipcRenderer.invoke("daily:ensure", input),
    complete: (input) => ipcRenderer.invoke("daily:complete", input),
  },

  // 备考待办
  todo: {
    getTemplates: () => ipcRenderer.invoke("todo:getTemplates"),
    saveTemplate: (input) => ipcRenderer.invoke("todo:saveTemplate", input),
    deleteTemplate: (templateId) => ipcRenderer.invoke("todo:deleteTemplate", templateId),
    reorderTemplates: (ids) => ipcRenderer.invoke("todo:reorderTemplates", ids),
    getDaily: (date) => ipcRenderer.invoke("todo:getDaily", date),
    addInstance: (input) => ipcRenderer.invoke("todo:addInstance", input),
    updateInstance: (input) => ipcRenderer.invoke("todo:updateInstance", input),
    deleteInstance: (id) => ipcRenderer.invoke("todo:deleteInstance", id),
    bumpProgress: (kind, amount, date) => ipcRenderer.invoke("todo:bumpProgress", { kind, amount, date }),
    carryOver: (ids, date) => ipcRenderer.invoke("todo:carryOver", { ids, date }),
    getStreak: (days) => ipcRenderer.invoke("todo:getStreak", days),
  },

  // 笔记与知识库
  note: {
    save: (input) => ipcRenderer.invoke("note:save", input),
    list: (options) => ipcRenderer.invoke("note:list", options),
    get: (id) => ipcRenderer.invoke("note:get", id),
    remove: (id) => ipcRenderer.invoke("note:delete", id),
    search: (keyword, options) => ipcRenderer.invoke("note:search", { keyword, options }),
    tags: () => ipcRenderer.invoke("note:tags"),
    tutor: (input) => ipcRenderer.invoke("note:tutor", input),
    addImage: (input) => ipcRenderer.invoke("note:addImage", input),
    removeImage: (input) => ipcRenderer.invoke("note:removeImage", input),
  },

  // Obsidian 联动：笔记双向同步 / 知识地图 / 仓库设置
  obsidian: {
    status: () => ipcRenderer.invoke("obsidian:status"),
    sync: () => ipcRenderer.invoke("obsidian:sync"),
    mindmap: () => ipcRenderer.invoke("obsidian:mindmap"),
    refresh: () => ipcRenderer.invoke("obsidian:refresh"),
    openMap: () => ipcRenderer.invoke("obsidian:openMap"),
    openVault: () => ipcRenderer.invoke("obsidian:openVault"),
    openNote: (noteId) => ipcRenderer.invoke("obsidian:openNote", noteId),
    revealNote: (noteId) => ipcRenderer.invoke("obsidian:revealNote", noteId),
    notePath: (noteId) => ipcRenderer.invoke("obsidian:notePath", noteId),
    openFolder: () => ipcRenderer.invoke("obsidian:openFolder"),
    chooseVault: () => ipcRenderer.invoke("obsidian:chooseVault"),
    setVault: (dir) => ipcRenderer.invoke("obsidian:setVault", dir),
    setAutoSync: (enabled) => ipcRenderer.invoke("obsidian:setAutoSync", enabled),
    advanced: (command) => ipcRenderer.invoke("obsidian:advanced", command),
    onNotesPulled: (handler) => {
      const listener = (_event, pulled) => handler(pulled);
      ipcRenderer.on("obsidian:notesPulled", listener);
      return () => ipcRenderer.removeListener("obsidian:notesPulled", listener);
    },
  },

  // 申论
  essay: {
    savePrompt: (input) => ipcRenderer.invoke("essay:savePrompt", input),
    listPrompts: (options) => ipcRenderer.invoke("essay:listPrompts", options),
    getPrompt: (id) => ipcRenderer.invoke("essay:getPrompt", id),
    deletePrompt: (id) => ipcRenderer.invoke("essay:deletePrompt", id),
    saveAttempt: (input) => ipcRenderer.invoke("essay:saveAttempt", input),
    listAttempts: (options) => ipcRenderer.invoke("essay:listAttempts", options),
    getAttempt: (id) => ipcRenderer.invoke("essay:getAttempt", id),
    deleteAttempt: (id) => ipcRenderer.invoke("essay:deleteAttempt", id),
    recommend: (options) => ipcRenderer.invoke("essay:recommend", options),
  },

  app: {
    getInfo: () => ipcRenderer.invoke("app:getInfo"),
    getUpdateState: () => ipcRenderer.invoke("app:getUpdateState"),
    checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
    quitAndInstallUpdate: () => ipcRenderer.invoke("app:quitAndInstallUpdate"),
    openReleasePage: () => ipcRenderer.invoke("app:openReleasePage"),
    openExternal: (targetUrl) => ipcRenderer.invoke("app:openExternal", targetUrl),
    getProfile: () => ipcRenderer.invoke("app:getProfile"),
    saveProfile: (input) => ipcRenderer.invoke("app:saveProfile", input),
    onUpdateState: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("app:update-state", listener);
      return () => ipcRenderer.removeListener("app:update-state", listener);
    },
  },

  paper: {
    exportPdf: (payload) => ipcRenderer.invoke("paper:exportPdf", payload),
  },

  // AI 助教（合并后的统一入口：答疑 + 动作）
  aiChat: {
    getContext: () => ipcRenderer.invoke("aiChat:getContext"),
    chat: (payload = {}) => ipcRenderer.invoke("aiChat:chat", payload),
    structureChatLog: (payload = {}) => ipcRenderer.invoke("aiChat:structureChatLog", payload),
    importChatLog: (payload = {}) => ipcRenderer.invoke("aiChat:importChatLog", payload),
    importShareLink: (payload = {}) => ipcRenderer.invoke("aiChat:importShareLink", payload),
    commitShareImport: (payload = {}) => ipcRenderer.invoke("aiChat:commitShareImport", payload),
    chatStreamStart: (payload = {}) => ipcRenderer.invoke("aiChat:chatStreamStart", payload),
    chatStreamCancel: (requestId) => ipcRenderer.invoke("aiChat:chatStreamCancel", requestId),
    onEvent: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("aiChat:event", listener);
      return () => ipcRenderer.removeListener("aiChat:event", listener);
    },
    saveMessageImages: (input = {}) => ipcRenderer.invoke("aiChat:saveMessageImages", input),
    readImage: (relativePath) => ipcRenderer.invoke("aiChat:readImage", relativePath),
    imageStats: (sessionId) => ipcRenderer.invoke("aiChat:imageStats", sessionId),
    cleanupImages: () => ipcRenderer.invoke("aiChat:cleanupImages"),
    updateMessageMeta: (input = {}) => ipcRenderer.invoke("aiChat:updateMessageMeta", input),
    setSessionContext: (input = {}) => ipcRenderer.invoke("aiChat:setSessionContext", input),
  },

  // 手机扫码传图（临时局域网服务，用完即关）
  phoneUpload: {
    start: (options = {}) => ipcRenderer.invoke("phoneUpload:start", options),
    stop: () => ipcRenderer.invoke("phoneUpload:stop"),
    status: () => ipcRenderer.invoke("phoneUpload:status"),
    onEvent: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("phoneUpload:event", listener);
      return () => ipcRenderer.removeListener("phoneUpload:event", listener);
    },
  },

  // 科目体系（学习平台）
  subject: {
    save: (input) => ipcRenderer.invoke("subject:save", input),
    list: () => ipcRenderer.invoke("subject:list"),
    get: (id) => ipcRenderer.invoke("subject:get", id),
    stats: (id) => ipcRenderer.invoke("subject:stats", id),
    remove: (id) => ipcRenderer.invoke("subject:delete", id),
    textbookPage: (subjectId, page) => ipcRenderer.invoke("subject:textbookPage", { subjectId, page }),
    saveTextbook: (input) => ipcRenderer.invoke("subject:saveTextbook", input),
    saveTextbookPage: (input) => ipcRenderer.invoke("subject:saveTextbookPage", input),
    saveTextbookPageImage: (input) => ipcRenderer.invoke("subject:saveTextbookPageImage", input),
    saveTextbookFigures: (input) => ipcRenderer.invoke("subject:saveTextbookFigures", input),
    mineruDetect: () => ipcRenderer.invoke("subject:mineruDetect"),
    parseTextbookLocal: (input) => ipcRenderer.invoke("subject:parseTextbookLocal", input),
    onMineruProgress: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("subject:mineruProgress", listener);
      return () => ipcRenderer.removeListener("subject:mineruProgress", listener);
    },
    getPathForFile: (file) => {
      try {
        const { webUtils } = require("electron");
        return webUtils.getPathForFile(file);
      } catch {
        return file?.path || "";
      }
    },
    textbookProgress: (subjectId) => ipcRenderer.invoke("subject:textbookProgress", subjectId),
    failTextbook: (input) => ipcRenderer.invoke("subject:failTextbook", input),
    resetTextbook: (subjectId) => ipcRenderer.invoke("subject:resetTextbook", subjectId),
    generateInventory: (input) => ipcRenderer.invoke("subject:generateInventory", input),
    generateQuestions: (input) => ipcRenderer.invoke("subject:generateQuestions", input),
    onQuestionsProgress: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("subject:questions:progress", listener);
      return () => ipcRenderer.removeListener("subject:questions:progress", listener);
    },
  },

  // 运行环境：MinerU / Python 真实检测 + 一键安装，Obsidian 安装状态
  runtimeEnv: {
    detect: (options = {}) => ipcRenderer.invoke("runtimeEnv:detect", options),
    install: (input = {}) => ipcRenderer.invoke("runtimeEnv:install", input),
    cancel: () => ipcRenderer.invoke("runtimeEnv:cancel"),
    getState: () => ipcRenderer.invoke("runtimeEnv:state"),
    choosePython: () => ipcRenderer.invoke("runtimeEnv:choosePython"),
    useLegacy: (input = {}) => ipcRenderer.invoke("runtimeEnv:useLegacy", input),
    onProgress: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("mineruEnv:progress", listener);
      return () => ipcRenderer.removeListener("mineruEnv:progress", listener);
    },
  },

  // 资料管理：主教材（权威）+ 补充资料（辅助）
  materials: {
    list: (subjectId) => ipcRenderer.invoke("materials:list", subjectId),
    pickFiles: () => ipcRenderer.invoke("materials:pickFiles"),
    pickPrimary: () => ipcRenderer.invoke("materials:pickPrimary"),
    add: (input) => ipcRenderer.invoke("materials:add", input),
    remove: (input) => ipcRenderer.invoke("materials:remove", input),
    parse: (input) => ipcRenderer.invoke("materials:parse", input),
    uploadPrimary: (input) => ipcRenderer.invoke("materials:uploadPrimary", input),
    onChanged: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("materials:changed", listener);
      return () => ipcRenderer.removeListener("materials:changed", listener);
    },
  },

  // AI API
  ai: {
    testConnection: (settings) => ipcRenderer.invoke("ai:testConnection", settings),
    transcribePage: (settings, imageBase64, mimeType, requestId, options = {}) =>
      ipcRenderer.invoke("ai:transcribePage", { settings, imageBase64, mimeType, requestId, withFigures: Boolean(options.withFigures) }),
    recognizeQuestions: (settings, imageBase64, mimeType, requestId) =>
      ipcRenderer.invoke("ai:recognizeQuestions", { settings, imageBase64, mimeType, requestId }),
    recognizeAnswers: (settings, imageBase64, mimeType, requestId) =>
      ipcRenderer.invoke("ai:recognizeAnswers", { settings, imageBase64, mimeType, requestId }),
    structureQuestionsFromText: (settings, text, options, requestId) =>
      ipcRenderer.invoke("ai:structureQuestionsFromText", { settings, text, options, requestId }),
    structureAnswersFromText: (settings, text, options, requestId) =>
      ipcRenderer.invoke("ai:structureAnswersFromText", { settings, text, options, requestId }),
    matchQuestionAnswers: (settings, questions, answers, options, requestId) =>
      ipcRenderer.invoke("ai:matchQuestionAnswers", { settings, questions, answers, options, requestId }),
    cancelRecognition: (requestId) => ipcRenderer.invoke("ai:cancelRecognition", requestId),
    reclassifyPaper: (settings, paperId, options, requestId) =>
      ipcRenderer.invoke("ai:reclassifyPaper", { settings, paperId, options, requestId }),
    reclassifyQuestions: (settings, questionIds, options, requestId) =>
      ipcRenderer.invoke("ai:reclassifyQuestions", { settings, questionIds, ...(options || {}), requestId }),
    classifySubject: (settings, payload, requestId) =>
      ipcRenderer.invoke("ai:classifySubject", { settings, ...(payload || {}), requestId }),
    onReclassifyProgress: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("ai:reclassify:progress", listener);
      return () => ipcRenderer.removeListener("ai:reclassify:progress", listener);
    },
    chat: (settings, messages, subjectId) =>
      ipcRenderer.invoke("ai:chat", { settings, messages, subjectId }),
    generatePaper: (settings, config) =>
      ipcRenderer.invoke("ai:generatePaper", { settings, config }),
    gradeEssay: (settings, payload) =>
      ipcRenderer.invoke("ai:gradeEssay", { settings, payload }),
    recognizeEssay: (settings, imageBase64, mimeType) =>
      ipcRenderer.invoke("ai:recognizeEssay", { settings, imageBase64, mimeType }),
    gradeHandwrittenAnswer: (settings, payload, imageBase64, mimeType) =>
      ipcRenderer.invoke("ai:gradeHandwrittenAnswer", { settings, payload, imageBase64, mimeType }),
  }
});
