const demoInput = document.querySelector("#demoInput");
const highlightLayer = document.querySelector("#highlightLayer");
const suggestionList = document.querySelector("#suggestionList");
const issueCount = document.querySelector("#issueCount");
const demoStatus = document.querySelector("#demoStatus");
const fixAllButton = document.querySelector("#fixAll");
const resetButton = document.querySelector("#resetDemo");
const replayButton = document.querySelector("#replayHero");

const sampleText = "This are a product update. I has a draft in order to publish it faster.";
const rules = [
  {
    original: "This are",
    replacement: "This is",
    title: "Subject-verb agreement",
    explanation: "Use \"is\" with the singular subject \"This\"."
  },
  {
    original: "I has",
    replacement: "I have",
    title: "Verb agreement",
    explanation: "Use \"have\" with \"I\"."
  },
  {
    original: "in order to",
    replacement: "to",
    title: "Concise wording",
    explanation: "Use the shorter form when the meaning stays the same."
  }
];

let animationTimer = 0;
let isAutoplaying = false;

function findIssues(text) {
  const issues = [];
  rules.forEach((rule) => {
    let start = text.indexOf(rule.original);
    while (start >= 0) {
      issues.push({
        ...rule,
        start,
        end: start + rule.original.length
      });
      start = text.indexOf(rule.original, start + rule.original.length);
    }
  });
  return issues.sort((a, b) => a.start - b.start);
}

function renderSuggestions() {
  const text = demoInput.value;
  const issues = findIssues(text);
  renderHighlights(text, issues);
  issueCount.textContent = String(issues.length);
  suggestionList.textContent = "";

  if (!issues.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No demo issues found. Try \"This are\" or replay the sample.";
    suggestionList.append(empty);
    demoStatus.textContent = text.trim() ? "Ready" : "Type or replay sample";
    return issues;
  }

  issues.forEach((issue) => {
    const item = document.createElement("button");
    item.className = "suggestion-item";
    item.type = "button";
    item.innerHTML = `<strong>${escapeHtml(issue.original)} -> ${escapeHtml(issue.replacement)}</strong><span>${escapeHtml(issue.explanation)}</span>`;
    item.addEventListener("click", () => applyIssue(issue));
    suggestionList.append(item);
  });

  demoStatus.textContent = `${issues.length} suggestion${issues.length === 1 ? "" : "s"} ready`;
  return issues;
}

function applyIssue(issue) {
  const value = demoInput.value;
  demoInput.value = `${value.slice(0, issue.start)}${issue.replacement}${value.slice(issue.end)}`;
  renderSuggestions();
  demoInput.focus();
}

function applyAllIssues() {
  const issues = findIssues(demoInput.value).sort((a, b) => b.start - a.start);
  if (!issues.length) {
    return;
  }

  let next = demoInput.value;
  issues.forEach((issue) => {
    next = `${next.slice(0, issue.start)}${issue.replacement}${next.slice(issue.end)}`;
  });
  demoInput.value = next;
  renderSuggestions();
  demoStatus.textContent = "All demo fixes applied";
}

function renderHighlights(text, issues) {
  if (!text) {
    highlightLayer.textContent = "";
    return;
  }

  let cursor = 0;
  let html = "";

  issues.forEach((issue) => {
    html += escapeHtml(text.slice(cursor, issue.start));
    html += `<mark>${escapeHtml(text.slice(issue.start, issue.end))}</mark>`;
    cursor = issue.end;
  });

  html += escapeHtml(text.slice(cursor));
  highlightLayer.innerHTML = html;
  syncHighlightScroll();
}

function syncHighlightScroll() {
  highlightLayer.scrollTop = demoInput.scrollTop;
  highlightLayer.scrollLeft = demoInput.scrollLeft;
}

function resetDemo() {
  clearTimeout(animationTimer);
  isAutoplaying = false;
  demoInput.value = "";
  renderSuggestions();
}

function replayDemo() {
  clearTimeout(animationTimer);
  isAutoplaying = true;
  demoInput.value = "";
  suggestionList.textContent = "";
  issueCount.textContent = "0";
  demoStatus.textContent = "Typing sample...";
  typeNextCharacter(0);
}

function typeNextCharacter(index) {
  if (!isAutoplaying) {
    return;
  }

  demoInput.value = sampleText.slice(0, index);
  renderSuggestions();

  if (index <= sampleText.length) {
    animationTimer = setTimeout(() => typeNextCharacter(index + 1), index % 7 === 0 ? 64 : 28);
    return;
  }

  demoStatus.textContent = "Auto-fixing demo...";
  animationTimer = setTimeout(() => {
    applyAllIssues();
    isAutoplaying = false;
  }, 900);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

demoInput.addEventListener("input", () => {
  isAutoplaying = false;
  clearTimeout(animationTimer);
  renderSuggestions();
});
demoInput.addEventListener("scroll", syncHighlightScroll);

fixAllButton.addEventListener("click", applyAllIssues);
resetButton.addEventListener("click", resetDemo);
replayButton.addEventListener("click", replayDemo);

replayDemo();
