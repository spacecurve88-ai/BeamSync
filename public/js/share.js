/* Keep v13 chat wire compatibility and never auto-open links or change the clipboard. */
(() => {
  'use strict';
  const maxText = 4000;
  function validText(text) {
    return typeof text === 'string' && text.length > 0 && text.length <= maxText &&
      text.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
  }
  function safeURL(text) {
    if (!validText(text) || !/^https?:\/\//i.test(text) || /[\s\\\u202a-\u202e\u2066-\u2069]/.test(text)) return null;
    try {
      const url = new URL(text);
      if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
      return url.href;
    } catch { return null; }
  }
  function makeFrame(text, kind = 'text') {
    if (!validText(text)) throw Error('Enter 1 to 4,000 characters of text.');
    if (!['url','text'].includes(kind)) throw Error('Unsupported type of message.');
    if (kind === 'url' && !safeURL(text)) throw Error('Use a full http or https link without sign-in details.');
    return { t: 'chat', kind, text };
  }
  function parseFrame(frame) {
    if (frame?.t !== 'chat' || !validText(frame.text)) return null;
    const url = safeURL(frame.text);
    return { kind: url ? 'url' : 'text', url, text: frame.text };
  }
  async function readClipboard(api = globalThis.navigator?.clipboard) {
    if (!api?.readText) throw Error('Paste into the message box using your browser.');
    let text;
    try { text = await api.readText(); } catch { throw Error('Clipboard access was declined. Paste into the message box.'); }
    if (!validText(text)) throw Error('The clipboard needs 1 to 4,000 characters of text.');
    return text;
  }
  async function copyText(text, api = globalThis.navigator?.clipboard) {
    if (!validText(text)) throw Error('There is no shareable text to copy.');
    if (!api?.writeText) throw Error('Select the message text and use Copy.');
    try { await api.writeText(text); } catch { throw Error('Clipboard access was declined. Select the text and use Copy.'); }
  }
  globalThis.BeamSyncShare = Object.freeze({ makeFrame, parseFrame, safeURL, readClipboard, copyText });
})();
