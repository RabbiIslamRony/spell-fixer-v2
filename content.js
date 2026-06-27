(() => {
  if (window.__selfHostedGrammarAssistantLoaded) {
    return;
  }
  window.__selfHostedGrammarAssistantLoaded = true;

  const ASSISTANT_ELEMENT_SELECTOR = [
    ".shga-button",
    ".shga-panel",
    ".shga-inline-overlay",
    ".shga-issue-bubble",
    ".shga-page-notice",
    ".shga-issue-tray"
  ].join(",");
  const AUTO_CHECK_DELAY = 350;
  const INLINE_FAST_CHECK_DELAY = 300;
  const INLINE_WORD_CHECK_DELAY = 600;
  const INLINE_PASTE_CHECK_DELAY = 250;
  const INLINE_STATUS_DELAY = 180;
  const INLINE_SLOW_STATUS_DELAY = 2000;
  const INLINE_MIN_TEXT_LENGTH = 3;
  const BADGE_SHOW_DELAY = 500;
  const BADGE_SIZE = 34;
  const BADGE_VIEWPORT_GAP = 8;
  const BADGE_EDITOR_GAP = 10;
  const BADGE_RIGHT_RESERVE = 76;
  const INLINE_TEXT_LIMIT = 800;
  const CONTENT_DEFAULT_SETTINGS = {
    apiProvider: "qwen",
    language: "en",
    extensionEnabled: true,
    siteAccessMode: "all",
    siteAccessList: "",
    settingsVersion: 5
  };

  const state = {
    editor: null,
    lastRead: null,
    mode: "grammar",
    busy: false,
    inlineBusy: false,
    extensionEnabled: true,
    siteAccessMode: "all",
    siteAccessList: "",
    siteAllowed: true,
    apiProvider: "qwen",
    language: "en",
    button: null,
    panel: null,
    resultNode: null,
    statusNode: null,
    overlay: null,
    overlayInner: null,
    bubble: null,
    tray: null,
    notice: null,
    lastNoticeAt: 0,
    lastNoticeMessage: "",
    inlineIssues: [],
    inlineText: "",
    lastCheckedText: "",
    checkCache: new Map(),
    suppressNextInputClear: false,
    badgeReady: false,
    badgeTimer: null,
    checkTimer: null,
    inlineStatusTimer: null,
    inlineSlowTimer: null,
    requestId: 0,
    activeInlineRequestId: 0,
    lastInlineCheckKey: "",
    isComposing: false
  };

  const MODES = [
    { id: "grammar", label: "Fix" },
    { id: "rewrite", label: "Rewrite" },
    { id: "shorten", label: "Shorten" }
  ];

  init();

  function init() {
    removeExistingAssistantUi();
    state.button = createButton();
    state.panel = createPanel();
    state.overlay = createOverlay();
    state.bubble = createBubble();
    state.tray = createTray();
    state.notice = createNotice();
    document.documentElement.append(state.overlay, state.bubble, state.tray, state.notice, state.button, state.panel);

    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("compositionstart", handleCompositionStart, true);
    document.addEventListener("compositionend", handleCompositionEnd, true);
    document.addEventListener("mousedown", handleOutsidePointer, true);
    document.addEventListener("click", handleEditorClick, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", refreshInlineUi);
    document.addEventListener("keydown", handleShortcut, true);
    loadContentSettings();
  }

  function createButton() {
    const button = document.createElement("button");
    button.className = "shga-button";
    button.type = "button";
    button.title = "Check text";
    const icon = document.createElement("img");
    icon.className = "shga-button-icon";
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    icon.src = chrome.runtime.getURL("icons/icon-48.png");
    icon.addEventListener("error", () => {
      icon.remove();
      button.textContent = "GA";
    }, { once: true });
    button.append(icon);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      openPanel();
      runCheck(state.mode, { inline: false });
    });
    return button;
  }

  function createPanel() {
    const panel = document.createElement("section");
    panel.className = "shga-panel";
    panel.setAttribute("aria-label", "Grammar assistant");
    panel.innerHTML = `
      <div class="shga-panel-header">
        <p class="shga-title">Grammar Assistant</p>
        <button class="shga-close" type="button" aria-label="Close">x</button>
      </div>
      <div class="shga-panel-body">
        <div class="shga-mode-row"></div>
        <p class="shga-status">Focus a text box. Issues will be underlined automatically.</p>
        <div class="shga-result"></div>
      </div>
    `;

    state.statusNode = panel.querySelector(".shga-status");
    state.resultNode = panel.querySelector(".shga-result");

    panel.querySelector(".shga-close").addEventListener("click", closePanel);
    const modeRow = panel.querySelector(".shga-mode-row");

    MODES.forEach((mode) => {
      const button = document.createElement("button");
      button.className = "shga-mode";
      button.type = "button";
      button.dataset.mode = mode.id;
      button.textContent = mode.label;
      button.addEventListener("click", () => {
        state.mode = mode.id;
        updateModeButtons();
        runCheck(mode.id, { inline: false });
      });
      modeRow.append(button);
    });

    updateModeButtons();
    return panel;
  }

  function createOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "shga-inline-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const inner = document.createElement("div");
    inner.className = "shga-inline-overlay-inner";
    overlay.append(inner);
    state.overlayInner = inner;
    return overlay;
  }

  function createBubble() {
    const bubble = document.createElement("div");
    bubble.className = "shga-issue-bubble";
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "Writing suggestion");
    return bubble;
  }

  function createTray() {
    const tray = document.createElement("div");
    tray.className = "shga-issue-tray";
    tray.setAttribute("aria-label", "Writing issues");
    return tray;
  }

  function createNotice() {
    const notice = document.createElement("div");
    notice.className = "shga-page-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    return notice;
  }

  function loadContentSettings() {
    chrome.storage.sync.get(CONTENT_DEFAULT_SETTINGS, applyContentSettings);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      if (
        changes.extensionEnabled ||
        changes.apiProvider ||
        changes.language ||
        changes.siteAccessMode ||
        changes.siteAccessList ||
        changes.settingsVersion
      ) {
        chrome.storage.sync.get(CONTENT_DEFAULT_SETTINGS, applyContentSettings);
      }
    });
  }

  function applyContentSettings(settings) {
    const nextEnabled = settings.extensionEnabled !== false;
    state.extensionEnabled = nextEnabled;
    state.apiProvider = normalizeApiProvider(settings.apiProvider);
    state.language = String(settings.language || "en").trim() || "en";
    state.siteAccessMode = normalizeSiteAccessMode(settings.siteAccessMode);
    state.siteAccessList = settings.siteAccessList || "";
    state.siteAllowed = isCurrentSiteAllowed();

    if (!assistantActive()) {
      pauseAssistantUi();
      return;
    }

    if (state.editor && editorHasText(state.editor)) {
      refreshInlineUi();
    }
  }

  function pauseAssistantUi() {
    clearTimeout(state.checkTimer);
    clearInlineStatus();
    cancelActiveInlineCheck();
    cancelBadgePlacement();
    state.requestId += 1;
    state.inlineBusy = false;
    hideButton();
    clearInlineIssues();
    hidePageNotice();
    closePanel();
  }

  function handleFocusIn(event) {
    const editor = findEditor(event.target);
    if (!editor) {
      return;
    }
    const editorChanged = state.editor !== editor;
    state.editor = editor;
    if (editorChanged) {
      cancelActiveInlineCheck();
      cancelBadgePlacement();
      clearInlineIssues();
    }
    if (!assistantActive()) {
      pauseAssistantUi();
      return;
    }
    if (!editorHasText(editor)) {
      clearInlineIssues();
      hideButton();
      return;
    }
    refreshInlineUi();
  }

  function handleFocusOut(event) {
    if (!state.editor || !isInsideEditor(event.target, state.editor)) {
      return;
    }

    setTimeout(() => {
      const active = document.activeElement;
      if (isEditorActive(state.editor) || isAssistantElement(active)) {
        return;
      }

      cancelBadgePlacement();
      cancelActiveInlineCheck();
    }, 0);
  }

  function handleInput(event) {
    if (state.isComposing || event.isComposing) {
      return;
    }

    const editor = findEditor(event.target);
    if (!editor) {
      return;
    }
    state.editor = editor;
    if (!state.extensionEnabled) {
      pauseAssistantUi();
      return;
    }
    if (!state.siteAllowed) {
      clearInlineIssues();
      cancelBadgePlacement();
      showPageNotice("Suggestions are disabled for this site.");
      return;
    }
    if (!editorHasText(editor)) {
      clearInlineIssues();
      cancelBadgePlacement();
      cancelActiveInlineCheck();
      return;
    }
    if (state.suppressNextInputClear) {
      state.suppressNextInputClear = false;
      state.badgeReady = true;
      placeButton();
      refreshInlineUi();
      return;
    }
    hideBubble();
    clearInlineIssuesInCurrentSegment(editor);
    scheduleBadgePlacement();
    scheduleInlineCheck(event);
  }

  function handleCompositionStart() {
    state.isComposing = true;
    clearTimeout(state.checkTimer);
    cancelActiveInlineCheck();
  }

  function handleCompositionEnd(event) {
    state.isComposing = false;
    const editor = findEditor(event.target);
    if (!editor || !assistantActive() || !editorHasText(editor)) {
      return;
    }

    state.editor = editor;
    scheduleBadgePlacement();
    scheduleInlineCheck(event);
  }

  function handleOutsidePointer(event) {
    if (isAssistantElement(event.target)) {
      return;
    }

    if (!state.editor || !isInsideEditor(event.target, state.editor)) {
      cancelBadgePlacement();
      hidePageNotice();
    }

    hideBubble();
    closePanel();
  }

  function handleEditorClick(event) {
    if (!assistantActive()) {
      return;
    }
    if (!state.editor || !isInsideEditor(event.target, state.editor)) {
      hideBubble();
      return;
    }
    setTimeout(showIssueForCaret, 0);
  }

  function handleKeyUp(event) {
    if (!assistantActive()) {
      return;
    }
    if (!state.editor || !isInsideEditor(event.target, state.editor)) {
      return;
    }

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      showIssueForCaret();
    }
  }

  function handleSelectionChange() {
    if (!assistantActive()) {
      return;
    }
    const editor = findEditor(document.activeElement);
    if (editor) {
      state.editor = editor;
      placeButton();
      syncOverlayScroll();
      showIssueForSelectionOrCaret();
    }
  }

  function handleScroll(event) {
    if (!assistantActive()) {
      return;
    }
    if (event.target === state.editor) {
      syncOverlayScroll();
      return;
    }
    refreshInlineUi();
  }

  function handleShortcut(event) {
    if (!assistantActive()) {
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "g") {
      const editor = findEditor(document.activeElement);
      if (editor) {
        event.preventDefault();
        state.editor = editor;
        openPanel();
        runCheck(state.mode, { inline: false });
      }
    }
  }

  function findEditor(target) {
    if (!target || target === document || target === document.body) {
      return null;
    }

    if (isTextInput(target)) {
      return target;
    }

    if (target.isContentEditable) {
      return target.closest("[contenteditable='true'],[contenteditable='plaintext-only']") || target;
    }

    if (target.closest) {
      const editable = target.closest("[contenteditable='true'],[contenteditable='plaintext-only'],[role='textbox']");
      if (editable) {
        return editable;
      }
    }

    return null;
  }

  function isInsideEditor(target, editor) {
    return target === editor || Boolean(editor?.contains && editor.contains(target));
  }

  function isEditorActive(editor) {
    const active = document.activeElement;
    return active === editor || Boolean(active && isInsideEditor(active, editor));
  }

  function isAssistantElement(target) {
    return Boolean(
      target?.closest?.(".shga-button, .shga-panel, .shga-issue-bubble, .shga-issue-tray")
    );
  }

  function assistantActive() {
    return state.extensionEnabled && state.siteAllowed;
  }

  function normalizeSiteAccessMode(value) {
    return ["all", "blocklist", "allowlist"].includes(value) ? value : "all";
  }

  function normalizeApiProvider(value) {
    return ["qwen", "gemini", "external"].includes(value) ? value : "qwen";
  }

  function isCurrentSiteAllowed() {
    if (state.siteAccessMode === "all") {
      return true;
    }

    const hostname = location.hostname.replace(/^www\./, "").toLowerCase();
    if (!hostname) {
      return state.siteAccessMode !== "allowlist";
    }

    const entries = parseSiteList(state.siteAccessList);
    if (!entries.length) {
      return state.siteAccessMode !== "allowlist";
    }

    const matched = entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
    return state.siteAccessMode === "allowlist" ? matched : !matched;
  }

  function parseSiteList(value) {
    return String(value || "")
      .split(/[\n,]+/)
      .map((item) => item.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase())
      .filter(Boolean);
  }

  function isTextInput(node) {
    if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) {
      return false;
    }

    if (node instanceof HTMLTextAreaElement) {
      return true;
    }

    const blocked = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "number",
      "password",
      "radio",
      "range",
      "reset",
      "submit"
    ]);
    return !blocked.has((node.type || "text").toLowerCase());
  }

  function placeButton() {
    if (
      !state.extensionEnabled ||
      !state.siteAllowed ||
      !state.badgeReady ||
      !state.editor ||
      !document.documentElement.contains(state.editor) ||
      !editorHasText(state.editor) ||
      !isEditorActive(state.editor)
    ) {
      hideButton();
      return;
    }

    const rect = state.editor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideButton();
      return;
    }

    const outsideRight = rect.right + BADGE_EDITOR_GAP;
    const canPlaceOutsideRight = outsideRight + BADGE_SIZE <= window.innerWidth - BADGE_VIEWPORT_GAP;
    const preferredLeft = canPlaceOutsideRight
      ? outsideRight
      : rect.right - BADGE_SIZE - BADGE_RIGHT_RESERVE;
    const minLeft = Math.max(rect.left + BADGE_EDITOR_GAP, BADGE_VIEWPORT_GAP);
    const maxLeft = window.innerWidth - BADGE_SIZE - BADGE_VIEWPORT_GAP;
    const left = Math.min(Math.max(preferredLeft, minLeft), maxLeft);

    const verticalOffset =
      rect.height > BADGE_SIZE + BADGE_EDITOR_GAP
        ? Math.min(Math.max((rect.height - BADGE_SIZE) / 2, 6), 14)
        : 4;
    const top = Math.min(
      Math.max(rect.top + verticalOffset, BADGE_VIEWPORT_GAP),
      window.innerHeight - BADGE_SIZE - BADGE_VIEWPORT_GAP
    );
    state.button.style.left = `${left}px`;
    state.button.style.top = `${top}px`;
    state.button.style.display = "flex";
  }

  function hideButton() {
    state.button.style.display = "none";
  }

  function scheduleBadgePlacement() {
    cancelBadgePlacement();
    if (!assistantActive() || !state.editor || !editorHasText(state.editor)) {
      return;
    }

    const editor = state.editor;
    state.badgeTimer = setTimeout(() => {
      state.badgeTimer = null;
      if (
        !state.extensionEnabled ||
        !state.siteAllowed ||
        state.editor !== editor ||
        !editorHasText(editor) ||
        !isEditorActive(editor)
      ) {
        hideButton();
        return;
      }

      state.badgeReady = true;
      placeButton();
    }, BADGE_SHOW_DELAY);
  }

  function cancelBadgePlacement() {
    clearTimeout(state.badgeTimer);
    state.badgeTimer = null;
    state.badgeReady = false;
    hideButton();
  }

  function scheduleInlineCheck(event) {
    if (!assistantActive() || !editorHasText(state.editor)) {
      clearInlineIssues();
      cancelBadgePlacement();
      cancelActiveInlineCheck();
      return;
    }

    clearTimeout(state.checkTimer);
    state.checkTimer = setTimeout(
      () => runCheck("grammar", { inline: true }),
      getInlineCheckDelay(event)
    );
  }

  function getInlineCheckDelay(event) {
    if (!event) {
      return AUTO_CHECK_DELAY;
    }

    if (String(event.inputType || "").startsWith("insertFromPaste")) {
      return INLINE_PASTE_CHECK_DELAY;
    }

    const data = typeof event.data === "string" ? event.data : "";
    if (!data) {
      return AUTO_CHECK_DELAY;
    }

    if (/[\s.!?,;:)]/.test(data)) {
      return INLINE_FAST_CHECK_DELAY;
    }

    return INLINE_WORD_CHECK_DELAY;
  }

  async function runCheck(mode, options = {}) {
    if (!assistantActive()) {
      return;
    }
    const inline = Boolean(options.inline);
    const read = inline ? readInlineEditorText(state.editor) : readEditorText(state.editor);
    const scope = inline ? "inline" : "panel";

    if (!read.text.trim()) {
      if (!inline) {
        openPanel();
        setStatus("No text found in the active editor.");
        renderEmpty();
      }
      if (inline) {
        cancelActiveInlineCheck();
      } else {
        clearInlineIssues();
      }
      return;
    }

    if (inline && read.text.trim().length < INLINE_MIN_TEXT_LENGTH) {
      return;
    }

    const requestId = ++state.requestId;
    const cacheKey = getCheckCacheKey(mode, read.text);

    if (inline) {
      state.inlineBusy = true;
      state.activeInlineRequestId = requestId;
      startInlineStatus(requestId);
    } else {
      if (state.busy) {
        return;
      }
      state.busy = true;
      state.lastRead = read;
      openPanel();
      setStatus(`Checking ${read.scope === "selection" ? "selected text" : "full text"}...`);
      renderLoading();
    }

    if (inline && state.checkCache.has(cacheKey)) {
      state.lastInlineCheckKey = cacheKey;
      applyInlineResult(state.checkCache.get(cacheKey), read);
      clearInlineStatus();
      state.inlineBusy = false;
      state.activeInlineRequestId = 0;
      return;
    }

    try {
      const response = await sendMessage({
        type: "shga.check",
        payload: {
          text: read.text,
          mode,
          pageUrl: location.href,
          scope,
          requestId,
          baseOffset: read.baseOffset || 0
        }
      });

      if (inline && requestId !== state.activeInlineRequestId) {
        return;
      }

      if (!response?.ok) {
        throw new Error(response?.error || "The API returned an error.");
      }

      if (inline) {
        const current = readFullEditorText(state.editor);
        if (current.text !== read.fullText) {
          return;
        }
        rememberCheck(cacheKey, response.data);
        state.lastInlineCheckKey = cacheKey;
        applyInlineResult(response.data, read);
      } else {
        state.lastCheckedText = read.text;
        applyInlineResult(response.data, read);
        renderResult(response.data);
        setStatus("Ready.");
      }
    } catch (error) {
      const message = normalizeRuntimeError(error instanceof Error ? error.message : String(error));
      if (inline) {
        if (requestId !== state.activeInlineRequestId || isCanceledInlineError(message)) {
          return;
        }
        showPageNotice(normalizePageError(message));
      } else {
        renderError(message);
        setStatus("Could not check the text.");
      }
    } finally {
      if (inline) {
        if (requestId === state.activeInlineRequestId) {
          state.inlineBusy = false;
          state.activeInlineRequestId = 0;
          clearInlineStatus();
        }
      } else {
        state.busy = false;
      }
    }
  }

  function rememberCheck(key, data) {
    state.checkCache.set(key, data);
    if (state.checkCache.size > 40) {
      const firstKey = state.checkCache.keys().next().value;
      state.checkCache.delete(firstKey);
    }
  }

  function getCheckCacheKey(mode, text) {
    return [
      normalizeApiProvider(state.apiProvider),
      mode || "grammar",
      state.language || "en",
      normalizeCacheText(text)
    ].join(":");
  }

  function normalizeCacheText(text) {
    return String(text || "");
  }

  function readFullEditorText(editor) {
    if (!editor) {
      return { text: "", scope: "none", editor: null, start: 0, end: 0 };
    }

    if (isTextInput(editor)) {
      return {
        text: editor.value,
        scope: "all",
        editor,
        start: 0,
        end: editor.value.length
      };
    }

    return {
      text: editor.innerText || editor.textContent || "",
      scope: "all",
      editor,
      start: 0,
      end: (editor.innerText || editor.textContent || "").length
    };
  }

  function editorHasText(editor) {
    return Boolean(readFullEditorText(editor).text.trim());
  }

  function readInlineEditorText(editor) {
    const fullRead = readFullEditorText(editor);
    const text = fullRead.text || "";
    if (!text) {
      return { ...fullRead, fullText: "", baseOffset: 0 };
    }

    const caret = getCaretOffset(editor);
    const segment = getActiveSentenceSegment(text, Number.isInteger(caret) ? caret : text.length);

    return {
      ...fullRead,
      scope: "inline",
      text: segment.text,
      fullText: text,
      baseOffset: segment.start,
      start: segment.start,
      end: segment.end
    };
  }

  function getActiveSentenceSegment(text, caret) {
    const left = Math.max(
      text.lastIndexOf(".", caret - 1),
      text.lastIndexOf("?", caret - 1),
      text.lastIndexOf("!", caret - 1),
      text.lastIndexOf("\n", caret - 1)
    );
    const rightCandidates = [".", "?", "!", "\n"]
      .map((mark) => text.indexOf(mark, caret))
      .filter((index) => index >= 0);

    let start = left >= 0 ? left + 1 : 0;
    let end = rightCandidates.length ? Math.min(...rightCandidates) + 1 : text.length;

    if (end - start > INLINE_TEXT_LIMIT) {
      start = Math.max(0, caret - Math.floor(INLINE_TEXT_LIMIT / 2));
      end = Math.min(text.length, start + INLINE_TEXT_LIMIT);
    }

    while (start < end && /\s/.test(text[start])) {
      start += 1;
    }

    return {
      start,
      end,
      text: text.slice(start, end)
    };
  }

  function readEditorText(editor) {
    if (!editor) {
      return { text: "", scope: "none", editor: null };
    }

    if (isTextInput(editor)) {
      const start = Number.isInteger(editor.selectionStart) ? editor.selectionStart : 0;
      const end = Number.isInteger(editor.selectionEnd) ? editor.selectionEnd : 0;
      const selected = end > start ? editor.value.slice(start, end) : "";

      return {
        text: selected || editor.value,
        scope: selected ? "selection" : "all",
        editor,
        start: selected ? start : 0,
        end: selected ? end : editor.value.length
      };
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) {
        return {
          text: selection.toString(),
          scope: "selection",
          editor,
          range: range.cloneRange()
        };
      }
    }

    return readFullEditorText(editor);
  }

  function applyInlineResult(data, read) {
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const baseOffset = Number.isInteger(read.baseOffset) ? read.baseOffset : 0;
    const fullText = read.fullText || read.text;
    const nextIssues = issues
      .map((issue) => ({
        ...issue,
        start: issue.start + baseOffset,
        end: issue.end + baseOffset
      }))
      .filter((issue) => issue.end <= fullText.length && issue.end > issue.start);

    if (read.scope === "inline") {
      const preserved = state.inlineIssues.filter(
        (issue) => issue.end <= fullText.length && !rangesOverlap(issue.start, issue.end, read.start, read.end)
      );
      state.inlineIssues = [...preserved, ...nextIssues].sort((a, b) => a.start - b.start);
    } else {
      state.inlineIssues = nextIssues;
    }

    state.inlineText = fullText;
    renderInlineOverlay(fullText, state.inlineIssues);
    renderIssueTray(state.inlineIssues);

    if (state.panel?.dataset.open === "true") {
      const count = state.inlineIssues.length;
      setStatus(count ? `${count} issue${count === 1 ? "" : "s"} found.` : "No inline issues found.");
    }
  }

  function clearInlineIssues() {
    state.inlineIssues = [];
    state.inlineText = "";
    hideBubble();
    hideOverlay();
    hideIssueTray();
  }

  function clearInlineIssuesInCurrentSegment(editor) {
    if (!state.inlineIssues.length) {
      hideOverlay();
      hideIssueTray();
      return;
    }

    const read = readInlineEditorText(editor);
    const fullText = read.fullText || read.text;
    const lengthChanged = state.inlineText && state.inlineText.length !== fullText.length;
    const preserved = state.inlineIssues.filter(
      (issue) =>
        issue.end <= fullText.length &&
        !rangesOverlap(issue.start, issue.end, read.start, read.end) &&
        (!lengthChanged || issue.end <= read.start)
    );

    if (!preserved.length) {
      clearInlineIssues();
      return;
    }

    state.inlineIssues = preserved;
    state.inlineText = fullText;
    renderInlineOverlay(fullText, preserved);
    renderIssueTray(preserved);
  }

  function rangesOverlap(startA, endA, startB, endB) {
    return startA < endB && endA > startB;
  }

  function renderInlineOverlay(text, issues) {
    if (!state.editor || !issues.length || !text) {
      hideOverlay();
      return;
    }

    state.overlayInner.textContent = "";
    let cursor = 0;

    issues.forEach((issue, index) => {
      if (issue.start > cursor) {
        state.overlayInner.append(document.createTextNode(text.slice(cursor, issue.start)));
      }

      const span = document.createElement("span");
      span.className = `shga-inline-issue shga-inline-${issue.severity || "grammar"}`;
      span.dataset.index = String(index);
      span.textContent = text.slice(issue.start, issue.end);
      state.overlayInner.append(span);
      cursor = issue.end;
    });

    if (cursor < text.length) {
      state.overlayInner.append(document.createTextNode(text.slice(cursor)));
    }

    refreshInlineUi();
  }

  function renderIssueTray(issues) {
    if (!state.editor || !issues.length) {
      hideIssueTray();
      return;
    }

    const rect = state.editor.getBoundingClientRect();
    const hasBottomRoom = rect.bottom + 54 <= window.innerHeight;
    const top = hasBottomRoom
      ? Math.max(rect.bottom + 8, 8)
      : Math.min(Math.max(rect.top - 46, 8), window.innerHeight - 46);
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 390);

    state.tray.textContent = "";

    const count = document.createElement("span");
    count.className = "shga-tray-count";
    count.textContent = String(issues.length);
    count.title = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
    state.tray.append(count);

    issues.slice(0, 6).forEach((issue) => {
      const chip = document.createElement("button");
      chip.className = "shga-tray-chip";
      chip.type = "button";
      chip.title = issue.explanation || issue.title || "Apply suggestion";
      chip.textContent = issue.replacement || "Fix";
      chip.addEventListener("mousedown", (event) => event.preventDefault());
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        applyIssue(issue, { keepFocus: true });
      });
      state.tray.append(chip);
    });

    const fixAll = document.createElement("button");
    fixAll.className = "shga-tray-all";
    fixAll.type = "button";
    fixAll.textContent = "Fix all";
    fixAll.addEventListener("mousedown", (event) => event.preventDefault());
    fixAll.addEventListener("click", (event) => {
      event.preventDefault();
      applyAllIssues();
    });
    state.tray.append(fixAll);

    state.tray.style.left = `${left}px`;
    state.tray.style.top = `${top}px`;
    state.tray.dataset.open = "true";
  }

  function hideIssueTray() {
    state.tray.dataset.open = "false";
    state.tray.textContent = "";
  }

  function showPageNotice(message) {
    if (!message || !state.editor) {
      return;
    }

    const now = Date.now();
    if (state.lastNoticeMessage === message && now - state.lastNoticeAt < 5000) {
      return;
    }

    state.lastNoticeMessage = message;
    state.lastNoticeAt = now;
    state.notice.textContent = message;
    placePageNotice();
    state.notice.dataset.open = "true";
  }

  function hidePageNotice() {
    state.notice.dataset.open = "false";
  }

  function placePageNotice() {
    if (!state.editor) {
      hidePageNotice();
      return;
    }

    const rect = state.editor.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 326);
    const top = Math.min(Math.max(rect.bottom + 8, 8), window.innerHeight - 74);
    state.notice.style.left = `${left}px`;
    state.notice.style.top = `${top}px`;
  }

  function normalizePageError(message) {
    if (isExtensionContextError(message)) {
      return "Extension was updated. Refresh this page, then try again.";
    }

    if (/api key|401|403|unauthorized|invalid api/i.test(message)) {
      return "Setup needed: open the extension popup and update your API key.";
    }

    if (/disabled in the extension settings/i.test(message)) {
      return "Suggestions are disabled for this site.";
    }

    if (/timed out|fetch|network|failed/i.test(message)) {
      return "Could not reach the grammar API. Check your setup.";
    }

    return "";
  }

  function normalizeRuntimeError(message) {
    if (isExtensionContextError(message)) {
      return "Extension was updated or reloaded. Refresh this page, then try again.";
    }

    return message;
  }

  function isExtensionContextError(message) {
    return /extension context invalidated|receiving end does not exist|extension runtime is not available|context invalidated/i.test(
      message || ""
    );
  }

  function isCanceledInlineError(message) {
    return /aborted|canceled|cancelled|replaced by newer typing/i.test(message || "");
  }

  function startInlineStatus(requestId) {
    clearInlineStatus();
    state.badgeReady = true;
    placeButton();

    state.inlineStatusTimer = setTimeout(() => {
      if (requestId !== state.activeInlineRequestId) {
        return;
      }

      setButtonState("checking", "Checking suggestions...");
      if (state.panel?.dataset.open === "true") {
        setStatus("Checking...");
      }
    }, INLINE_STATUS_DELAY);

    state.inlineSlowTimer = setTimeout(() => {
      if (requestId !== state.activeInlineRequestId) {
        return;
      }

      setButtonState("slow", "Still checking suggestions...");
      if (state.panel?.dataset.open === "true") {
        setStatus("Still checking...");
      }
    }, INLINE_SLOW_STATUS_DELAY);
  }

  function clearInlineStatus() {
    clearTimeout(state.inlineStatusTimer);
    clearTimeout(state.inlineSlowTimer);
    state.inlineStatusTimer = null;
    state.inlineSlowTimer = null;
    setButtonState("", "Check text");
  }

  function setButtonState(value, title) {
    if (!state.button) {
      return;
    }

    if (value) {
      state.button.dataset.state = value;
      state.button.dataset.label = "...";
    } else {
      delete state.button.dataset.state;
      delete state.button.dataset.label;
    }
    state.button.title = title;
  }

  function cancelActiveInlineCheck() {
    if (!state.activeInlineRequestId) {
      return;
    }

    const requestId = state.activeInlineRequestId;
    state.activeInlineRequestId = 0;
    state.inlineBusy = false;
    clearInlineStatus();
    sendMessage({
      type: "shga.cancelInlineCheck",
      payload: { requestId }
    }).catch(() => {});
  }

  function refreshInlineUi() {
    placeButton();
    if (state.notice?.dataset.open === "true") {
      placePageNotice();
    }
    if (!state.editor || !state.inlineIssues.length) {
      hideOverlay();
      hideIssueTray();
      return;
    }

    const rect = state.editor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
      hideOverlay();
      hideIssueTray();
      return;
    }

    const style = window.getComputedStyle(state.editor);
    Object.assign(state.overlay.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      padding: style.padding,
      borderWidth: style.borderWidth,
      borderStyle: "solid",
      borderColor: "transparent",
      borderRadius: style.borderRadius,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: style.lineHeight,
      textAlign: style.textAlign,
      letterSpacing: style.letterSpacing,
      whiteSpace: state.editor instanceof HTMLInputElement ? "pre" : "pre-wrap",
      overflowWrap: "break-word"
    });

    state.overlayInner.style.minWidth = state.editor.scrollWidth ? `${state.editor.scrollWidth}px` : "100%";
    syncOverlayScroll();
    renderIssueTray(state.inlineIssues);
  }

  function syncOverlayScroll() {
    if (!state.editor || state.overlay.style.display === "none") {
      return;
    }

    const scrollLeft = state.editor.scrollLeft || 0;
    const scrollTop = state.editor.scrollTop || 0;
    state.overlayInner.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  }

  function hideOverlay() {
    state.overlay.style.display = "none";
    state.overlayInner.textContent = "";
  }

  function showIssueForCaret() {
    const offset = getCaretOffset(state.editor);
    if (!Number.isInteger(offset)) {
      hideBubble();
      return;
    }

    const issue = state.inlineIssues.find((item) => offset >= item.start && offset <= item.end);
    if (!issue) {
      hideBubble();
      return;
    }

    showIssueBubble(issue);
  }

  function showIssueForSelectionOrCaret() {
    const range = getSelectionOffsets(state.editor);
    if (!range) {
      showIssueForCaret();
      return;
    }

    const issue = state.inlineIssues.find(
      (item) => range.start < item.end && range.end > item.start
    );
    if (issue) {
      showIssueBubble(issue);
      return;
    }

    showIssueForCaret();
  }

  function showIssueBubble(issue) {
    const rect = getBubbleAnchorRect(issue);
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 326);
    const top = Math.min(Math.max(rect.bottom + 8, 8), window.innerHeight - 190);

    state.bubble.textContent = "";

    const title = document.createElement("strong");
    title.textContent = issue.title || "Suggestion";

    const change = document.createElement("button");
    change.className = "shga-issue-apply";
    change.type = "button";
    change.textContent = issue.replacement || "Apply suggestion";
    change.addEventListener("click", () => applyIssue(issue));

    const detail = document.createElement("p");
    detail.textContent = issue.explanation || `${issue.original || "Text"} -> ${issue.replacement || ""}`;

    const close = document.createElement("button");
    close.className = "shga-issue-close";
    close.type = "button";
    close.textContent = "x";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", hideBubble);

    state.bubble.append(close, title, change, detail);
    state.bubble.style.left = `${left}px`;
    state.bubble.style.top = `${top}px`;
    state.bubble.dataset.open = "true";
  }

  function getBubbleAnchorRect(issue) {
    if (!state.editor) {
      return { left: 16, right: 16, top: 16, bottom: 16 };
    }

    if (!isTextInput(state.editor)) {
      const range = createContentEditableRange(state.editor, issue.start, issue.end);
      const rect = range?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }

    const rect = state.editor.getBoundingClientRect();
    return {
      left: Math.min(rect.left + 12, rect.right - 24),
      right: rect.right,
      top: rect.top,
      bottom: rect.top + 28
    };
  }

  function hideBubble() {
    state.bubble.dataset.open = "false";
  }

  function getCaretOffset(editor) {
    if (!editor) {
      return null;
    }

    if (isTextInput(editor)) {
      return Number.isInteger(editor.selectionStart) ? editor.selectionStart : null;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) {
      return null;
    }

    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }

  function getSelectionOffsets(editor) {
    if (!editor) {
      return null;
    }

    if (isTextInput(editor)) {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        return null;
      }
      return { start, end };
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return null;
    }

    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return { start, end: start + range.toString().length };
  }

  function applyIssue(issue, options = {}) {
    if (!state.editor || !issue.replacement) {
      return;
    }

    state.editor.focus();
    const originalLength = issue.end - issue.start;
    const delta = issue.replacement.length - originalLength;
    state.suppressNextInputClear = true;

    if (isTextInput(state.editor)) {
      state.editor.setSelectionRange(issue.start, issue.end);
      state.editor.setRangeText(issue.replacement, issue.start, issue.end, "end");
      dispatchInput(state.editor);
    } else {
      replaceContentEditableRange(state.editor, issue.start, issue.end, issue.replacement);
      dispatchInput(state.editor);
    }

    hideBubble();
    preserveRemainingIssues(issue, delta);
    if (options.keepFocus) {
      state.editor.focus();
    }
  }

  function applyAllIssues() {
    if (!state.editor || !state.inlineIssues.length) {
      return;
    }

    const issues = [...state.inlineIssues]
      .filter((issue) => issue.replacement && issue.end > issue.start)
      .sort((a, b) => b.start - a.start);

    state.editor.focus();
    state.suppressNextInputClear = true;

    if (isTextInput(state.editor)) {
      let value = state.editor.value;
      issues.forEach((issue) => {
        value = replaceSlice(value, issue.start, issue.end, issue.replacement);
      });
      state.editor.value = value;
      state.editor.setSelectionRange(value.length, value.length);
      dispatchInput(state.editor);
    } else {
      issues.forEach((issue) => {
        replaceContentEditableRange(state.editor, issue.start, issue.end, issue.replacement);
      });
      dispatchInput(state.editor);
    }

    hideBubble();
    state.inlineIssues = [];
    state.inlineText = readFullEditorText(state.editor).text;
    state.lastCheckedText = state.inlineText;
    hideOverlay();
    hideIssueTray();

    if (state.panel?.dataset.open === "true") {
      setStatus("All visible issues fixed.");
    }
  }

  function preserveRemainingIssues(appliedIssue, delta) {
    const text = readFullEditorText(state.editor).text;
    state.inlineText = text;
    state.lastCheckedText = text;
    state.inlineIssues = state.inlineIssues
      .filter((issue) => !sameIssue(issue, appliedIssue))
      .map((issue) => {
        if (issue.end <= appliedIssue.start) {
          return issue;
        }

        if (issue.start >= appliedIssue.end) {
          return {
            ...issue,
            start: issue.start + delta,
            end: issue.end + delta
          };
        }

        return null;
      })
      .filter((issue) => issue && issue.end <= text.length && issue.end > issue.start);

    if (state.inlineIssues.length) {
      renderInlineOverlay(text, state.inlineIssues);
      refreshInlineUi();
    } else {
      hideOverlay();
      hideIssueTray();
    }

    if (state.panel?.dataset.open === "true") {
      const count = state.inlineIssues.length;
      setStatus(count ? `${count} issue${count === 1 ? "" : "s"} remaining.` : "All visible issues fixed.");
    }
  }

  function sameIssue(a, b) {
    return (
      a === b ||
      (a.start === b.start &&
        a.end === b.end &&
        a.original === b.original &&
        a.replacement === b.replacement)
    );
  }

  function applyReplacement(replacement) {
    const read = state.lastRead;
    if (!read || !read.editor || !replacement) {
      return;
    }

    const editor = read.editor;
    editor.focus();

    if (isTextInput(editor)) {
      editor.setSelectionRange(read.start, read.end);
      editor.setRangeText(replacement, read.start, read.end, "end");
      dispatchInput(editor);
      return;
    }

    if (read.scope === "selection" && read.range) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(read.range);
      document.execCommand("insertText", false, replacement);
      dispatchInput(editor);
      return;
    }

    editor.textContent = replacement;
    dispatchInput(editor);
  }

  function replaceContentEditableRange(editor, start, end, replacement) {
    const range = createContentEditableRange(editor, start, end);
    if (!range) {
      editor.textContent = replaceSlice(editor.innerText || editor.textContent || "", start, end, replacement);
      return;
    }

    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
  }

  function createContentEditableRange(editor, start, end) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    while (node) {
      const nextOffset = offset + node.nodeValue.length;

      if (!startNode && start >= offset && start <= nextOffset) {
        startNode = node;
        startOffset = start - offset;
      }

      if (!endNode && end >= offset && end <= nextOffset) {
        endNode = node;
        endOffset = end - offset;
        break;
      }

      offset = nextOffset;
      node = walker.nextNode();
    }

    if (!startNode || !endNode) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function replaceSlice(value, start, end, replacement) {
    return `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  }

  function renderResult(data) {
    const correctedText = data?.correctedText || "";
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
    state.resultNode.textContent = "";

    if (issues.length) {
      const list = document.createElement("div");
      list.className = "shga-suggestion-list";

      issues.forEach((issue) => {
        const item = document.createElement("article");
        item.className = "shga-suggestion";
        const title = document.createElement("strong");
        title.textContent = issue.title || "Suggestion";
        const explanation = document.createElement("p");
        explanation.textContent = issue.explanation || `${issue.original || "Text"} -> ${issue.replacement || ""}`;
        const action = document.createElement("button");
        action.className = "shga-secondary";
        action.type = "button";
        action.textContent = issue.replacement || "Apply";
        action.addEventListener("click", () => applyIssue(issue));
        item.append(title, explanation, action);
        list.append(item);
      });

      state.resultNode.append(list);
      return;
    }

    if (correctedText) {
      const correction = document.createElement("div");
      correction.className = "shga-correction";

      const label = document.createElement("div");
      label.className = "shga-label";
      label.textContent = "Suggested text";

      const output = document.createElement("textarea");
      output.className = "shga-output";
      output.value = correctedText;

      const actions = document.createElement("div");
      actions.className = "shga-actions";

      const applyButton = document.createElement("button");
      applyButton.className = "shga-primary";
      applyButton.type = "button";
      applyButton.textContent = "Apply";
      applyButton.addEventListener("click", () => applyReplacement(output.value));

      const copyButton = document.createElement("button");
      copyButton.className = "shga-secondary";
      copyButton.type = "button";
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText(output.value);
        setStatus("Copied.");
      });

      actions.append(applyButton, copyButton);
      correction.append(label, output, actions);
      state.resultNode.append(correction);
    }

    if (suggestions.length) {
      const list = document.createElement("div");
      list.className = "shga-suggestion-list";

      suggestions.forEach((suggestion) => {
        const item = document.createElement("article");
        item.className = "shga-suggestion";
        const title = document.createElement("strong");
        title.textContent = suggestion.title || "Suggestion";
        const explanation = document.createElement("p");
        explanation.textContent = suggestion.explanation || suggestion.replacement || "";
        item.append(title, explanation);

        if (suggestion.replacement) {
          const action = document.createElement("button");
          action.className = "shga-secondary";
          action.type = "button";
          action.textContent = "Apply this";
          action.addEventListener("click", () => applyReplacement(suggestion.replacement));
          item.append(action);
        }

        list.append(item);
      });

      state.resultNode.append(list);
    }

    if (!correctedText && !suggestions.length) {
      renderEmpty("No correction found.");
    }
  }

  function renderLoading() {
    state.resultNode.textContent = "";
    const item = document.createElement("div");
    item.className = "shga-suggestion";
    item.textContent = "Checking...";
    state.resultNode.append(item);
  }

  function renderError(message) {
    state.resultNode.textContent = "";
    const item = document.createElement("div");
    item.className = "shga-suggestion";
    const title = document.createElement("strong");
    title.textContent = "Error";
    const text = document.createElement("p");
    text.textContent = message;
    item.append(title, text);
    state.resultNode.append(item);
  }

  function renderEmpty(message = "Nothing to show yet.") {
    state.resultNode.textContent = "";
    const item = document.createElement("div");
    item.className = "shga-suggestion";
    item.textContent = message;
    state.resultNode.append(item);
  }

  function updateModeButtons() {
    state.panel?.querySelectorAll(".shga-mode").forEach((button) => {
      button.dataset.active = String(button.dataset.mode === state.mode);
    });
  }

  function setStatus(message) {
    state.statusNode.textContent = message;
  }

  function openPanel() {
    state.panel.dataset.open = "true";
    updateModeButtons();
  }

  function closePanel() {
    state.panel.dataset.open = "false";
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) {
        reject(new Error("Extension runtime is not available."));
        return;
      }

      runtime.sendMessage(message, (response) => {
        const error = runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function removeExistingAssistantUi() {
    document.querySelectorAll(ASSISTANT_ELEMENT_SELECTOR).forEach((node) => node.remove());
  }

  function dispatchInput(node) {
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
})();
