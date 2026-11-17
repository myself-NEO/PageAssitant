// Injected into the active tab after vendor/Readability.js.
// The value of this final expression is returned to the side panel.
(() => {
  const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  let text = '';
  let title = document.title;
  let method = 'body';

  try {
    // Readability mutates the document it is given, so hand it a copy.
    const article = new Readability(document.cloneNode(true)).parse();
    if (article && article.textContent && article.textContent.trim().length > 400) {
      text = article.textContent;
      title = article.title || title;
      method = 'article';
    }
  } catch { /* fall through to the whole page */ }

  // Apps, dashboards and short pages have no "article"; use the visible text.
  const bodyText = document.body ? document.body.innerText : '';
  if (!text || bodyText.length > text.length * 4) {
    text = bodyText;
    method = 'body';
  }

  return {
    url: location.href,
    title,
    text: clean(text),
    selection: clean(window.getSelection()?.toString()),
    method,
  };
})();
