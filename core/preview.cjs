"use strict";

// One page from an entry's HTML, CSS and JS. The app serves it through the
// jdebate-preview: scheme into a sandboxed frame, with a CSP that allows the
// entry's own inline code and nothing from the network.

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const safeCss = (css) => String(css || "").replace(/<\/style/gi, "<\\/style");
const safeJs = (js) => String(js || "").replace(/<\/script/gi, "<\\/script");

function compose(entry) {
  const html = String(entry.html || "");
  const style = entry.css ? "<style>\n" + safeCss(entry.css) + "\n</style>\n" : "";
  const script = entry.js ? "<script>\n" + safeJs(entry.js) + "\n</script>\n" : "";
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + style + "</head>\n<body>\n" + html + "\n" + script + "</body>\n</html>\n";
  }
  let out = html;
  if (style) out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => style + "</head>") : style + out;
  if (script) out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => script + "</body>") : out + script;
  return out;
}

module.exports = { compose, CSP };
