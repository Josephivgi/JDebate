"use strict";

// What the app serves for an entry. Each entry has its own origin,
// jdebate-preview://<entry id>/, so a site's pages, styles, images and video
// load from it by relative path. The CSP allows the entry's inline code and
// its own files, and nothing from the network.

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const origin = (entryId) => "jdebate-preview://" + entryId;

function cspFor(entryId) {
  const o = origin(entryId);
  return "default-src 'none'; script-src 'unsafe-inline' " + o + "; style-src 'unsafe-inline' " + o + "; img-src data: blob: " + o + "; font-src data: " + o + "; media-src data: blob: " + o + "; connect-src 'none'; form-action 'none'; base-uri " + o;
}

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

// Added to every page the app serves (not to exported files): the network is
// blocked anyway, so a link to the web would only leave an error page in the
// frame. Such links do nothing instead.
const GUARD =
  "<script>addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');" +
  "if(a&&!/^jdebate-preview:/i.test(a.href)&&!/^\\s*javascript:/i.test(a.getAttribute('href')))e.preventDefault()},true)</script>";

function guard(html) {
  const s = String(html);
  const at = /<head\b[^>]*>/i.exec(s) || /<!doctype[^>]*>/i.exec(s);
  return at ? s.slice(0, at.index + at[0].length) + GUARD + s.slice(at.index + at[0].length) : GUARD + s;
}

// The page around a video entry's file: plays at once, muted, looping.
function videoPage(file) {
  const src = encodeURI(file);
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>html,body{margin:0;height:100%;background:#000}video{display:block;width:100%;height:100%;object-fit:contain}</style>\n</head>\n<body>\n<video src="' +
    src.replace(/"/g, "%22") + '" autoplay muted loop playsinline controls></video>\n</body>\n</html>\n';
}

module.exports = { compose, videoPage, guard, cspFor, origin, CSP };
