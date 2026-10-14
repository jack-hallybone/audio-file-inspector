// Blocks this page from running framed by another site: GitHub Pages can't send a frame-ancestors header or carry one in a <meta> CSP.

// Imported for its side effect before any control is built: an app that has rendered has already run in the framing page.

// A cross-origin `top` won't throw for this comparison, but a hostile parent is exactly where a surprise would come from, so any throw reads as "framed".
function inSomebodyElsesFrame() {
  try {
    return self !== self.top;
  } catch {
    return true;
  }
}

const FRAMED = inSomebodyElsesFrame();

// Best effort, and nothing rests on it: a stricter policy may refuse this too, leaving the notice as unstyled text.
function dress(node, rules) {
  try {
    for (const [property, value] of Object.entries(rules))
      node.style[property] = value;
  } catch {
    // A policy that refuses decoration does not refuse the refusal.
  }
}

function notice() {
  const box = document.createElement("div");
  box.id = "framerefusal";
  dress(box, {
    position: "fixed",
    inset: "0",
    margin: "0",
    padding: "24px",
    background: "#111",
    color: "#eee",
    font: "16px/1.5 system-ui, sans-serif",
  });
  const line = document.createElement("p");
  // Said out loud: a blank rectangle in a stranger's page looks like a broken app, to exactly the person being targeted.
  line.textContent =
    "This page will not run inside another site's frame. Open it directly.";
  const link = document.createElement("a");
  // Origin and path only, read from where this is actually served: a query or fragment could be whatever the framing page put there.
  const here = location.origin + location.pathname;
  link.href = here;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = here;
  dress(link, { color: "inherit" });
  box.append(line, link);
  return box;
}

function refuse() {
  const box = notice();
  // REMOVED, not hidden: style-src 'self' refuses an injected <style>, so hiding by CSS could leave the app rendered and clickable under the notice.
  document.body.replaceChildren(box);
  // Whatever arrives later is removed on arrival too: a framework mounting its own body, or a lazily-loaded module appending a dialog.
  try {
    new MutationObserver(() => {
      for (const child of [...document.body.children])
        if (child !== box) child.remove();
    }).observe(document.body, { childList: true });
  } catch {
    // Without an observer the removal above still stands, as do the capture listeners.
  }
}

if (FRAMED) {
  // Window capture is the first step of event propagation, so stopping it here means no handler ever runs.
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "keydown",
    "keyup",
    "touchstart",
    "touchend",
    "contextmenu",
    "submit",
  ])
    addEventListener(type, stop, true);

  // A module script is deferred, so <body> exists by now; loaded another way, this waits instead of silently no-oping.
  if (document.body) refuse();
  else addEventListener("DOMContentLoaded", refuse, { once: true });
}
