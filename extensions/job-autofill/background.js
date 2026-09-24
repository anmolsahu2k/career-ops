/**
 * background.js — module service worker. Badge feedback, MAIN-world escape
 * hatch, and a store handle for the headed runner so it can seed answers
 * without opening the options tab (dynamic import() is illegal in workers).
 */

import { setResume, getResumeFor, importData, purgeEphemeralStoredAnswers } from './content/store.js';

self.careerOpsStore = { setResume, getResumeFor, importData, purgeEphemeralStoredAnswers };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'contentReady') return false;
  if (msg?.type === 'fillReport' && sender.tab?.id != null) {
    const { filled = 0, unknown = 0 } = msg.report || {};
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: filled ? String(filled) : '' });
    chrome.action.setBadgeBackgroundColor({
      tabId: sender.tab.id,
      color: unknown > 0 ? '#e08b00' : '#2e9e4f',
    });
    return false;
  }

  // Fallback for controls that ignore an isolated-world value assignment.
  if (msg?.type === 'mainWorldSet' && sender.tab?.id != null) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      world: 'MAIN',
      args: [msg.selector, msg.value],
      func: (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === value;
      },
    }).then(results => sendResponse({ ok: results?.[0]?.result === true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
