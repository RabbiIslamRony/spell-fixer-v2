"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const sampleText = "This are a product update. I has a draft in order to publish it faster.";
const rules = [
  {
    original: "This are",
    replacement: "This is",
    explanation: 'Use "is" with the singular subject "This".'
  },
  {
    original: "I has",
    replacement: "I have",
    explanation: 'Use "have" with "I".'
  },
  {
    original: "in order to",
    replacement: "to",
    explanation: "Use the shorter form when the meaning stays the same."
  }
];

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

function highlightedText(text, issues) {
  const parts = [];
  let cursor = 0;

  issues.forEach((issue) => {
    if (issue.start > cursor) {
      parts.push(text.slice(cursor, issue.start));
    }
    parts.push(
      <mark key={`${issue.start}-${issue.end}`}>
        {text.slice(issue.start, issue.end)}
      </mark>
    );
    cursor = issue.end;
  });

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts;
}

export function LiveDemo() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("Typing sample...");
  const [isAutoplaying, setIsAutoplaying] = useState(false);
  const timerRef = useRef(0);
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const issues = useMemo(() => findIssues(text), [text]);

  const syncScroll = () => {
    if (!textareaRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
  };

  const applyIssue = (issue) => {
    setText((current) => `${current.slice(0, issue.start)}${issue.replacement}${current.slice(issue.end)}`);
    setStatus("Suggestion applied");
    textareaRef.current?.focus();
  };

  const applyAllIssues = () => {
    const currentIssues = findIssues(text).sort((a, b) => b.start - a.start);
    if (!currentIssues.length) return;

    let next = text;
    currentIssues.forEach((issue) => {
      next = `${next.slice(0, issue.start)}${issue.replacement}${next.slice(issue.end)}`;
    });
    setText(next);
    setStatus("All demo fixes applied");
  };

  const resetDemo = () => {
    window.clearTimeout(timerRef.current);
    setIsAutoplaying(false);
    setText("");
    setStatus("Type or replay sample");
  };

  const replayDemo = () => {
    window.clearTimeout(timerRef.current);
    setIsAutoplaying(true);
    setText("");
    setStatus("Typing sample...");
  };

  useEffect(() => {
    replayDemo();
    return () => window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!isAutoplaying) return undefined;

    let index = 0;
    const typeNext = () => {
      setText(sampleText.slice(0, index));

      if (index <= sampleText.length) {
        timerRef.current = window.setTimeout(typeNext, index % 7 === 0 ? 64 : 28);
        index += 1;
        return;
      }

      setStatus("Auto-fixing demo...");
      timerRef.current = window.setTimeout(() => {
        let next = sampleText;
        findIssues(sampleText).sort((a, b) => b.start - a.start).forEach((issue) => {
          next = `${next.slice(0, issue.start)}${issue.replacement}${next.slice(issue.end)}`;
        });
        setText(next);
        setStatus("All demo fixes applied");
        setIsAutoplaying(false);
      }, 900);
    };

    typeNext();
    return () => window.clearTimeout(timerRef.current);
  }, [isAutoplaying]);

  useEffect(() => {
    if (isAutoplaying) return;
    setStatus(text.trim() ? `${issues.length} suggestion${issues.length === 1 ? "" : "s"} ready` : "Type or replay sample");
  }, [issues.length, isAutoplaying, text]);

  return (
    <section className="demo-shell" aria-label="Live browser demo">
      <div className="demo-toolbar">
        <div className="toolbar-title">
          <img src="/assets/logo-48.png" width="28" height="28" alt="" />
          <span>Live demo</span>
        </div>
        <div className="toolbar-status" aria-live="polite">{status}</div>
      </div>

      <div className="demo-layout">
        <div className="editor-pane">
          <label htmlFor="demoInput">Try the editor</label>
          <div className="editor-wrap">
            <div className="highlight-layer" ref={highlightRef} aria-hidden="true">
              {highlightedText(text, issues)}
            </div>
            <textarea
              id="demoInput"
              ref={textareaRef}
              value={text}
              spellCheck="false"
              autoComplete="off"
              aria-describedby="demoHelp"
              onChange={(event) => {
                window.clearTimeout(timerRef.current);
                setIsAutoplaying(false);
                setText(event.target.value);
              }}
              onScroll={syncScroll}
            />
            <div className="demo-badge" aria-hidden="true">
              <img src="/assets/logo-48.png" width="34" height="34" alt="" />
            </div>
          </div>
          <p id="demoHelp">Type text like "This are" or "I has" to see suggestions instantly.</p>
        </div>

        <aside className="suggestion-pane" aria-label="Suggestions">
          <div className="suggestion-header">
            <span className="issue-count">{issues.length}</span>
            <span>suggestions</span>
          </div>
          <div className="suggestion-list">
            {issues.length ? issues.map((issue) => (
              <button
                className="suggestion-item"
                key={`${issue.start}-${issue.original}`}
                type="button"
                onClick={() => applyIssue(issue)}
              >
                <strong>{issue.original} -&gt; {issue.replacement}</strong>
                <span>{issue.explanation}</span>
              </button>
            )) : (
              <div className="empty-state">No demo issues found. Try "This are" or replay the sample.</div>
            )}
          </div>
          <div className="demo-actions">
            <button className="button primary compact" type="button" onClick={applyAllIssues}>Fix all</button>
            <button className="button secondary compact" type="button" onClick={resetDemo}>Reset</button>
            <button className="button secondary compact" type="button" onClick={replayDemo}>Replay</button>
          </div>
        </aside>
      </div>
    </section>
  );
}
