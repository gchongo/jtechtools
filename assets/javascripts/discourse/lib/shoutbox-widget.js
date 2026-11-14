// The shoutbox widget: a self-contained vanilla-DOM builder shared by all
// mount points (homepage panel, /shoutbox full page, [data-shoutbox-mount]).
// All user content is rendered through DOM APIs (textContent/createElement) —
// no innerHTML with message data, so the board is XSS-safe by construction.
//
// Data flows through one shared store: the first mount pulls the recent list,
// MessageBus "/shoutbox" pushes live creates/deletes/likes/edits/pins to every
// mounted widget, and a 60s catch-up poll guards against a dropped message.
import { ajax } from "discourse/lib/ajax";
import { iconHTML } from "discourse/lib/icon-library";
import { i18n } from "discourse-i18n";
import { relativeAge } from "discourse/lib/formatter";
import DiscourseURL from "discourse/lib/url";

const container = () => window.Discourse?.__container__;

// The jtech theme's Quick-look expand icon (same markup as jt-card__peek).
const JT_EXPAND_SVG =
  '<svg class="fa d-icon d-icon-expand svg-icon fa-width-auto svg-string" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><use href="#jt-expand"></use></svg>';

// ── shared store ─────────────────────────────────────────────────────────────

const widgets = new Set();
const messages = new Map(); // id → serialized message (ascending iteration)
let viewer = null;
let loaded = false;
let loading = false;
let lastSeenId = 0;
let pollTimer = null;
let permalinkHandled = false;
const viewedInSession = new Set();
let tagFilter = null;
let busStarted = false;
let editing = null; // { id } while a message is being edited
let emojiMap = null;
let emojiPromise = null;
let tagListPromise = null;
let searchQuery = ""; // sidebar search box filters the feed client-side
let whatsNewExpanded = false; // sidebar "What's new" card toggle

const maxId = () => {
  let max = lastSeenId;
  for (const id of messages.keys()) {
    if (id > max) {
      max = id;
    }
  }
  return max;
};

const catchUp = () => {
  if (!loaded || widgets.size === 0) {
    return;
  }
  loadMessages(maxId());
};

function loadMessages(afterId = 0) {
  let qs = afterId > 0 ? `?after_id=${afterId}` : "";
  if (tagFilter) {
    qs += (qs ? "&" : "?") + `tag=${encodeURIComponent(tagFilter)}`;
  }
  return ajax(`/shoutbox/messages.json${qs}`)
    .then((payload) => {
      viewer = payload.viewer || viewer;
      (payload.messages || []).forEach((m) => {
        if (!messages.has(m.id)) {
          messages.set(m.id, m);
        }
      });
      loaded = true;
      widgets.forEach((w) => w.refresh({ animateFromId: afterId > 0 ? afterId : null }));
      if (afterId === 0 && !permalinkHandled) {
        permalinkHandled = true;
        const h = window.location.hash.match(/^#m-(\d+)$/);
        if (h) {
          setTimeout(() => {
            widgets.forEach((w) => {
              const row = w.els.list.querySelector(`[data-id="${h[1]}"]`);
              if (row) {
                row.scrollIntoView({ block: "center" });
                row.classList.add("shoutbox__item--new");
              }
            });
          }, 300);
        }
      }
    })
    .catch((e) => {
      // allow a later mount/poll to retry
      loading = false;
      if (e?.jqXHR?.status !== 403) {
        widgets.forEach((w) => w.showError());
      }
    });
}

const startShared = () => {
  if (!busStarted) {
    busStarted = true;

    const messageBus = container()?.lookup("service:message-bus");
    if (messageBus) {
      messageBus.subscribe("/shoutbox", (data) => {
        if (data?.type === "created" && data.message) {
          const m = data.message;
          if (m.reply_to_id && messages.has(m.reply_to_id)) {
            const pm = messages.get(m.reply_to_id);
            if (pm) {
              pm.reply_count = (pm.reply_count || 0) + 1;
              widgets.forEach((w) => {
                const btn = w.els.list.querySelector(
                  `[data-id="${m.reply_to_id}"] .shoutbox__comment-btn`
                );
                if (btn) {
                  let label = btn.querySelector(".number");
                  if (!label) {
                    label = el("span", "number");
                    btn.appendChild(label);
                  }
                  label.textContent = String(pm.reply_count);
                }
              });
            }
          }
          if (messages.has(m.id)) {
            return;
          }
          messages.set(m.id, m);
          lastSeenId = Math.max(lastSeenId, m.id);
          if (m.reply_to_id && messages.has(m.reply_to_id)) {
            widgets.forEach((w) => w.insertReplyRow(m));
          } else {
            widgets.forEach((w) => w.appendRow(m, { isNew: true }));
          }
        } else if (data?.type === "updated" && data.message) {
          const m = data.message;
          if (!messages.has(m.id)) {
            return;
          }
          messages.set(m.id, m);
          widgets.forEach((w) => w.updateRow(m));
        } else if (data?.type === "liked") {
          const m = messages.get(data.id);
          if (m) {
            m.like_count = data.like_count;
            m.liked = data.liked;
          }
          widgets.forEach((w) => {
            const btn = w.els.list.querySelector(
              `[data-id="${data.id}"] .shoutbox__like`
            );
            if (btn) {
              renderLikeBtn(btn, m || { like_count: data.like_count, liked: data.liked });
            }
          });
        } else if (data?.type === "pinned") {
          const m = messages.get(data.id);
          if (m) {
            m.pinned = data.pinned;
          }
          // pinned ordering changes — refetch the list
          loading = false;
          loaded = false;
          startShared();
        } else if (data?.type === "deleted" && messages.has(data.id)) {
          const dead = messages.get(data.id);
          messages.delete(data.id);
          widgets.forEach((w) => {
            w.removeRow(data.id);
            if (dead?.reply_to_id) {
              const pm = messages.get(dead.reply_to_id);
              if (pm && pm.reply_count > 0) {
                pm.reply_count -= 1;
                const btn = w.els.list.querySelector(
                  `[data-id="${dead.reply_to_id}"] .shoutbox__comment-btn`
                );
                const label = btn?.querySelector(".number");
                if (label) {
                  if (pm.reply_count > 0) {
                    label.textContent = String(pm.reply_count);
                  } else {
                    label.remove();
                  }
                }
              }
            }
          });
        }
      });
    }

    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          catchUp();
        }
      }, 60000);
    }
  }

  if (!loading && !loaded) {
    loading = true;
    loadMessages();
  }
};

// ── rich text rendering ──────────────────────────────────────────────────────

function loadEmojis() {
  emojiPromise ||=
    ajax("/emojis.json")
      .then((groups) => {
        const map = new Map();
        Object.values(groups || {}).forEach((group) =>
          (group || []).forEach((e) => {
            if (e?.name && e.url) {
              map.set(e.name, e.url);
            }
          })
        );
        emojiMap = map;
        return map;
      })
      .catch(() => {
        emojiMap = emojiMap || new Map();
        return emojiMap;
      });
  return emojiPromise;
}

const topicTitles = new Map();
function topicTitle(id) {
  topicTitles.set(
    id,
    topicTitles.get(id) ||
      ajax(`/t/${id}.json`)
        .then((d) => String(d?.title || "").trim())
        .catch(() => "")
  );
  return topicTitles.get(id);
}

const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT = /[)\]}>,.!?;:'"，。！？；：、）》〉】\]]+$/;
const EMOJI_SPLIT = /(:[a-zA-Z0-9_+-]+:)/g;
const MENTION_SPLIT = /(@[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)/g;
const TAG_SPLIT = /(#[a-zA-Z0-9_-]+)/g;
const QUOTE_SPLIT = /(\[quote(?:="([^"]*)")?\]([\s\S]*?)\[\/quote\])/g;
const MD_SPLIT = /(\*\*[^*]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

const makeLink = (href, cls) => {
  const a = document.createElement("a");
  a.href = href;
  a.className = cls;
  a.rel = "noopener noreferrer nofollow ugc";
  return a;
};

function appendUrlNode(parent, raw) {
  const punct = raw.match(TRAILING_PUNCT)?.[0] || "";
  const url = punct ? raw.slice(0, -punct.length) : raw;

  let parsed = null;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    parent.appendChild(document.createTextNode(raw));
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    parent.appendChild(document.createTextNode(raw));
    return;
  }

  const topicMatch = parsed.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?\/?$/);
  if (topicMatch && parsed.origin === window.location.origin) {
    const id = Number(topicMatch[1]);
    const a = makeLink(parsed.href, "shoutbox__link shoutbox__link--topic");
    a.textContent = `🔗 #${id}`;
    a.title = i18n("shoutbox.topic_link");
    topicTitle(id).then((title) => {
      if (a.isConnected && title) {
        a.textContent = `🔗 ${title}`;
        a.title = title;
      }
    });
    parent.appendChild(a);
  } else {
    const a = makeLink(parsed.href, "shoutbox__link shoutbox__link--external");
    a.target = "_blank";
    a.textContent = `🔗 ${parsed.hostname.replace(/^www\./, "")}`;
    a.title = url;
    parent.appendChild(a);
  }
  if (punct) {
    parent.appendChild(document.createTextNode(punct));
  }
}

const appendTextWithMentions = (parent, text) => {
  text.split(MENTION_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)$/);
    if (m) {
      const a = makeLink(`/u/${m[1].toLowerCase()}`, "shoutbox__mention");
      a.textContent = part;
      parent.appendChild(a);
    } else {
      appendTextWithTag(parent, part);
    }
  });
};

function appendTextWithTag(parent, text) {
  text.split(TAG_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^#([a-zA-Z0-9_-]+)$/);
    if (m) {
      const a = makeLink(
        `/shoutbox?tag=${encodeURIComponent(m[1].toLowerCase())}`,
        "shoutbox__tag"
      );
      a.textContent = part;
      parent.appendChild(a);
    } else {
      appendTextWithMD(parent, part);
    }
  });
}

// Inline markdown: bold / inline code / italic.
function appendTextWithMD(parent, text) {
  text.split(MD_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      parent.appendChild(el("strong", null, part.slice(2, -2)));
    } else if (/^`[^`\n]+`$/.test(part)) {
      parent.appendChild(el("code", "shoutbox__code", part.slice(1, -1)));
    } else if (/^\*[^*\n]+\*$/.test(part)) {
      parent.appendChild(el("em", null, part.slice(1, -1)));
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

const appendTextWithEmoji = (parent, text) => {
  text.split(EMOJI_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const m = part.match(/^:([a-zA-Z0-9_+-]+):$/);
    const src = m && emojiMap?.get(m[1]);
    if (src) {
      const img = document.createElement("img");
      img.className = "shoutbox__emoji";
      img.src = src;
      img.alt = part;
      img.title = part;
      img.loading = "lazy";
      parent.appendChild(img);
    } else {
      appendTextWithMentions(parent, part);
    }
  });
};

// Quote blocks first, then line-level markdown, then the inline chain.
function renderRichText(parent, text) {
  text.split(QUOTE_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const q =
      part.match(/^\[quote="([^"]*)"\]([\s\S]*)\[\/quote\]$/) ||
      part.match(/^\[quote\]([\s\S]*)\[\/quote\]$/);
    if (q) {
      const bq = el("blockquote", "shoutbox__quote");
      if (q[1]) {
        bq.appendChild(el("div", "shoutbox__quote-author", `@${q[1]}`));
      }
      const body = el("div", "shoutbox__quote-body");
      renderRichText(body, q[2].trim());
      bq.appendChild(body);
      parent.appendChild(bq);
      return;
    }
    renderLines(parent, part);
  });
}

// Resolve an image markdown URL to a safe src: Discourse upload:// short
// URLs become /uploads/short-url/… (redirects to the stored file); only
// http(s) and same-origin relative URLs are allowed — anything else (e.g.
// javascript:) returns null and the markdown renders as plain text.
function imageSrcFor(raw) {
  const url = String(raw || "");
  if (url.startsWith("upload://")) {
    return "/uploads/short-url/" + url.slice("upload://".length);
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) {
    return url;
  }
  return null;
}

// image markdown, global form — the composer counter, edit parsing and
// submit assembly all strip/extract with this same pattern
const IMAGE_MD_RE_G = /!\[[^\]\n]*\]\([^)\s]+(?:\s[^)]*)?\)/g;

const fmtBytes = (n) => {
  if (n >= 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(n / 1024).toFixed(1)} KB`;
};

// X-style pending-image previews: a grid of large rounded tiles under the
// textarea (text above, images below), each with a floating ✕ remove button
function renderAttachments(widget) {
  const wrap = widget.els.attWrap;
  const list = widget.els.pending || [];
  if (!wrap) {
    return;
  }
  wrap.replaceChildren();
  if (list.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.dataset.count = String(list.length);

  list.forEach((item) => {
    const cell = el("div", "shoutbox__att-preview");
    cell.title = item.status === "done" ? `${item.name}${item.meta ? ` — ${item.meta}` : ""}` : "";

    if (item.status === "done" && item.short_url) {
      const img = el("img", "shoutbox__att-img");
      img.src = imageSrcFor(item.short_url);
      img.alt = item.name;
      cell.appendChild(img);
    } else {
      const ph = el("span", "shoutbox__att-ph");
      ph.textContent = item.status === "failed" ? i18n("shoutbox.upload_failed") : "···";
      if (item.status === "failed") {
        ph.classList.add("shoutbox__att-ph--error");
      }
      cell.appendChild(ph);
    }

    const remove = el("button", "shoutbox__att-remove");
    remove.type = "button";
    remove.title = i18n("shoutbox.attach_remove");
    remove.setAttribute("aria-label", i18n("shoutbox.attach_remove"));
    remove.innerHTML = iconHTML("xmark");
    remove.addEventListener("click", () => {
      widget.els.pending = widget.els.pending.filter((p) => p !== item);
      renderAttachments(widget);
      if (widget.els.sendBtn && widget.els.composer) {
        widget.els.sendBtn.disabled =
          widget.els.composer.value.replace(IMAGE_MD_RE_G, "").trim().length === 0 &&
          !widget.els.pending.some((p) => p.status === "done");
      }
    });
    cell.appendChild(remove);

    wrap.appendChild(cell);
  });
}

// Line-level markdown: headings (# ## ###), bullet lists (- ), paragraphs.
function renderLines(parent, text) {
  const lines = text.split("\n");
  let list = null;
  const flushList = () => {
    if (list) {
      parent.appendChild(list);
      list = null;
    }
  };
  lines.forEach((line) => {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    const li = line.match(/^[-*]\s+(.+)$/);
    const img = line.match(/^!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)$/);
    if (h) {
      flushList();
      const hd = el(
        "div",
        `shoutbox__heading shoutbox__heading--${Math.min(h[1].length + 1, 4)}`
      );
      renderInline(hd, h[2]);
      parent.appendChild(hd);
    } else if (li) {
      if (!list) {
        list = el("div", "shoutbox__list-block");
      }
      const item = el("div", "shoutbox__list-item");
      item.appendChild(document.createTextNode("\u2022 "));
      renderInline(item, li[1]);
      list.appendChild(item);
    } else if (img && imageSrcFor(img[2])) {
      flushList();
      const src = imageSrcFor(img[2]);
      const a = el("a", "shoutbox__image-link");
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow ugc";
      const im = el("img", "shoutbox__image");
      im.src = src;
      im.alt = img[1];
      im.loading = "lazy";
      a.appendChild(im);
      parent.appendChild(a);
    } else {
      flushList();
      const p = el("div", "shoutbox__line");
      if (line) {
        renderInline(p, line);
      }
      parent.appendChild(p);
    }
  });
  flushList();
}

// Inline markdown: bold / italic / inline code, then the existing chain.
function renderInline(parent, text) {
  text.split(MD_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      parent.appendChild(el("strong", null, part.slice(2, -2)));
    } else if (/^`[^`\n]+`$/.test(part)) {
      parent.appendChild(el("code", "shoutbox__code", part.slice(1, -1)));
    } else if (/^\*[^*\n]+\*$/.test(part)) {
      parent.appendChild(el("em", null, part.slice(1, -1)));
    } else {
      appendTextWithEmoji(parent, part);
    }
  });
}

// ── widget ───────────────────────────────────────────────────────────────────

// ── widget ───────────────────────────────────────────────────────────────────

export function mountShoutbox(rootEl, { variant = "panel" } = {}) {
  const widget = { rootEl, variant, els: {}, destroyed: false };

  // Page variant: the host becomes a two-column grid (memos-style) holding
  // the timeline and a sticky side column of info cards. Panel stays a single
  // card.
  let mount;
  if (variant === "page") {
    tagFilter = new URLSearchParams(window.location.search).get("tag");
    tagListPromise = null;
    rootEl.classList.add("shoutbox-page-grid");
    mount = el("div", "shoutbox shoutbox--page");
    rootEl.appendChild(mount);
    widget.els.side = el("aside", "shoutbox-side");
    rootEl.appendChild(widget.els.side);

    const tagsCard = el("div", "shoutbox-side__card shoutbox-side__card--tags");
    tagsCard.hidden = true;
    tagsCard.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_tags")));
    widget.els.tagsList = el("div", "shoutbox-side__tag-list");
    tagsCard.appendChild(widget.els.tagsList);
    widget.els.tagsCard = tagsCard;
    widget.els.side.appendChild(tagsCard);
  } else {
    rootEl.classList.add("shoutbox", "shoutbox--panel");
    mount = rootEl;
  }
  widget.mountEl = mount;

  // head
  const head = el("div", "shoutbox__head");
  if (variant === "panel") {
    head.appendChild(el("span", "shoutbox__title", `📝 ${i18n("shoutbox.title")}`));
    // Full page: the jtech theme's Quick-look expand icon (jt sprite).
    const open = el("button", "btn btn-flat no-text jt-card__peek shoutbox__open");
    open.type = "button";
    open.title = i18n("shoutbox.open");
    open.setAttribute("aria-label", i18n("shoutbox.open"));
    open.innerHTML = JT_EXPAND_SVG;
    open.addEventListener("click", () => DiscourseURL.routeTo("/shoutbox"));
    head.appendChild(open);

    // New message: hidden until the viewer payload proves posting rights.
    const plus = el("button", "btn btn-flat no-text shoutbox__compose-toggle");
    plus.type = "button";
    plus.title = i18n("shoutbox.compose");
    plus.setAttribute("aria-label", i18n("shoutbox.compose"));
    plus.innerHTML = iconHTML("plus");
    plus.hidden = true;
    plus.addEventListener("click", () => {
      const pop = widget.els.composePop;
      pop.hidden = !pop.hidden;
      if (!pop.hidden) {
        widget.els.composer?.focus();
      }
    });
    widget.els.plusBtn = plus;
    head.appendChild(plus);
    mount.appendChild(head);
  }

  // list
  const list = el("ul", "shoutbox__list");
  list.appendChild(el("li", "shoutbox__msg", "…"));
  widget.els.list = list;

  // composer / login area — filled once the viewer payload arrives
  const foot = el("div", "shoutbox__foot jt-card__foot");
  widget.els.foot = foot;

  const popovers = buildPopovers(widget);

  if (variant === "page") {
    // X-style timeline: composer on top, feed below. The zero-height popovers
    // wrap sits right after the composer so the emoji/mention popovers anchor
    // just underneath it.
    mount.appendChild(foot);
    mount.appendChild(popovers);
    mount.appendChild(list);
  } else {
    mount.appendChild(list);
    mount.appendChild(foot);
    mount.appendChild(popovers);
  }

  widget.refresh = ({ animateFromId = null } = {}) => {
    // initial load (null) never animates; catch-up animates what's new
    const cutoff = animateFromId === null ? Infinity : animateFromId;
    widget.els.list.replaceChildren();
    let last = null;
    const topLevel = [];
    const repliesByParent = new Map();
    for (const m of messages.values()) {
      if (m.reply_to_id && messages.has(m.reply_to_id)) {
        const arr = repliesByParent.get(m.reply_to_id) || [];
        arr.push(m);
        repliesByParent.set(m.reply_to_id, arr);
      } else {
        topLevel.push(m);
      }
    }
    // newest first (memos/X style); pinned float to the top
    topLevel.sort(
      (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.id - a.id,
    );
    for (const m of topLevel) {
      const animate = m.id > cutoff;
      widget.els.list.appendChild(buildRow(widget, m, { animate }));
      last = m;
      // replies stay chronological under their parent
      for (const r of (repliesByParent.get(m.id) || []).sort((x, y) => x.id - y.id)) {
        widget.els.list.appendChild(buildRow(widget, r, { animate }));
        last = r;
      }
    }
    if (last) {
      lastSeenId = Math.max(lastSeenId, last.id);
    }
    showEmptyStateIfNeeded(widget);
    renderFoot(widget);
    renderSide(widget);
    applySearchFilter(widget);
    scrollToTop(widget);
  };

  widget.appendRow = (m, { isNew = false, forceScroll = false } = {}) => {
    hideEmptyState(widget);
    const animate = isNew && m.id > lastSeenId;
    lastSeenId = Math.max(lastSeenId, m.id);
    // newest-first feed: new top-level rows go to the very top
    widget.els.list.insertBefore(buildRow(widget, m, { animate }), widget.els.list.firstChild);
    renderSide(widget);
    applySearchFilter(widget);
    if (isNew || forceScroll) {
      scrollToTop(widget);
    }
  };

  widget.insertReplyRow = (m) => {
    hideEmptyState(widget);
    const parent = widget.els.list.querySelector(`[data-id="${m.reply_to_id}"]`);
    const replyRow = buildRow(widget, m, { isReply: true });
    if (parent) {
      const replyRows = [
        ...widget.els.list.querySelectorAll(`[data-reply-to="${m.reply_to_id}"]`),
      ];
      (replyRows.length ? replyRows[replyRows.length - 1] : parent).after(replyRow);
    } else {
      widget.els.list.appendChild(replyRow);
    }
    renderSide(widget);
    applySearchFilter(widget);
  };

  widget.removeRow = (id) => {
    widget.els.list.querySelector(`[data-id="${id}"]`)?.remove();
    showEmptyStateIfNeeded(widget);
    renderSide(widget);
  };

  widget.updateRow = (m) => {
    const old = widget.els.list.querySelector(`[data-id="${m.id}"]`);
    if (!old) {
      return;
    }
    old.replaceWith(buildRow(widget, m, {}));
    applySearchFilter(widget);
  };

  widget.showError = () => {
    widget.els.list.replaceChildren(el("li", "shoutbox__msg", i18n("shoutbox.load_failed")));
  };

  widget.destroy = () => {
    widget.destroyed = true;
    widgets.delete(widget);
  };

  widgets.add(widget);
  startShared();

  if (widget.variant === "page") {
    fillTagsCard(widget);
  }

  if (loaded) {
    widget.refresh();
  } else {
    loadEmojis();
  }

  return widget;
}

export function unmountShoutbox(widget) {
  widget?.destroy();
}

// ── pieces ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "");
const userHref = (m) => `/u/${esc(m.user?.username).toLowerCase()}`;
const avatarSrc = (m, size = 48) =>
  esc(m.user?.avatar_template || "").replace("{size}", String(size));

const insertAtCursor = (textarea, text) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
};

// wrap the selected text with markers (bold / italic / code); empty selection
// inserts the markers and puts the cursor between them
const wrapSelection = (textarea, before, after = before) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const sel = textarea.value.slice(start, end);
  textarea.value =
    textarea.value.slice(0, start) + before + sel + after + textarea.value.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + sel.length;
  textarea.setSelectionRange(selStart, selEnd);
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

// prefix each selected line (headings "# ", bullets "- ")
const prefixLine = (textarea, prefix) => {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  const lines = textarea.value.slice(lineStart, end).split("\n");
  const replaced = lines.map((l) => (l.startsWith(prefix) ? l : prefix + l)).join("\n");
  textarea.value = textarea.value.slice(0, lineStart) + replaced + textarea.value.slice(end);
  const selEnd = lineStart + replaced.length;
  textarea.setSelectionRange(lineStart, selEnd);
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

function buildRow(widget, m, { animate = false, isReply = false } = {}) {
  const li = el("li", "shoutbox__item jt-card");
  li.dataset.id = m.id;
  const replyRow = isReply || !!m.reply_to_id;
  li.classList.toggle("shoutbox__item--reply", replyRow);
  if (m.reply_to_id) {
    li.dataset.replyTo = m.reply_to_id;
  }
  if (m.pinned) {
    li.classList.add("shoutbox__item--pinned");
  }
  if (animate) {
    li.classList.add("shoutbox__item--new");
  }

  // meta: author avatar + dual name, pinned flag + row menu right
  const meta = el("div", "jt-card__meta");
  const author = el("span", "shoutbox__author");
  if (m.user?.avatar_template) {
    const av = el("img", "shoutbox__author-avatar");
    av.src = avatarSrc(m, 48);
    av.alt = "";
    av.loading = "lazy";
    author.appendChild(av);
  }
  const name = makeLink(userHref(m), "shoutbox__name");
  name.textContent = esc(m.user?.name || m.user?.username);
  author.appendChild(name);
  const handle = makeLink(userHref(m), "shoutbox__handle");
  handle.textContent = `@${esc(m.user?.username)}`;
  author.appendChild(handle);
  meta.appendChild(author);
  const flags = el("span", "jt-card__flags");
  if (m.pinned) {
    flags.appendChild(el("span", "jt-pill", `📌 ${i18n("shoutbox.pinned_label")}`));
  }
  const menuBtn = el("button", "jt-card__peek btn btn-flat no-text");
  menuBtn.type = "button";
  menuBtn.innerHTML = iconHTML("ellipsis-vertical");
  menuBtn.title = i18n("shoutbox.menu");
  menuBtn.setAttribute("aria-label", i18n("shoutbox.menu"));
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openRowMenu(widget, m, meta);
  });
  flags.appendChild(menuBtn);
  meta.appendChild(flags);
  li.appendChild(meta);

  // body: content
  const body = el("div", "shoutbox__body");
  const text = el("div", "shoutbox__text");
  if (m.color) {
    text.style.color = m.color;
  }
  renderRichText(text, esc(m.message));
  body.appendChild(text);
  li.appendChild(body);

  // foot: stats (comment / like / views / time)
  const foot = el("div", "shoutbox__foot jt-card__foot");

  const commentBtn = el("button", "shoutbox__stat-btn jt-card__stat shoutbox__comment-btn");
  commentBtn.type = "button";
  commentBtn.innerHTML = iconHTML("far-comment");
  if (m.reply_count > 0) {
    commentBtn.appendChild(el("span", "number", String(m.reply_count)));
  }
  commentBtn.title = i18n("shoutbox.comment");
  commentBtn.setAttribute("aria-label", i18n("shoutbox.comment"));
  commentBtn.addEventListener("click", () => toggleCommentBox(widget, m, li));
  foot.appendChild(commentBtn);

  const likeBtn = el("button", "shoutbox__stat-btn jt-card__stat shoutbox__like");
  likeBtn.type = "button";
  likeBtn.title = i18n("shoutbox.like");
  likeBtn.setAttribute("aria-label", i18n("shoutbox.like"));
  renderLikeBtn(likeBtn, m);
  likeBtn.addEventListener("click", () => toggleLike(widget, m, likeBtn));
  foot.appendChild(likeBtn);

  const views = el("span", "shoutbox__stat-btn jt-card__stat shoutbox__views");
  views.title = i18n("shoutbox.views", { n: m.views || 0 });
  views.innerHTML =
    iconHTML("far-eye") + '<span class="number">' + (m.views || 0) + "</span>";
  foot.appendChild(views);

  const activity = el("span", "shoutbox__stat-btn jt-card__stat --activity");
  const date = new Date(m.created_at);
  if (!isNaN(date.getTime())) {
    const time = el("span", "relative-date");
    time.textContent = relativeAge(date, { format: "tiny" });
    time.title = date.toLocaleString();
    activity.appendChild(time);
    foot.appendChild(activity);
  }

  li.appendChild(foot);

  return li;
}

function renderLikeBtn(btn, m) {
  btn.innerHTML =
    iconHTML("far-heart") +
    (m.like_count > 0 ? '<span class="number">' + m.like_count + "</span>" : "");
  btn.classList.toggle("is-liked", !!m.liked);
}

function toggleLike(widget, m, btn) {
  if (!viewer?.signed_in) {
    window.location.href = "/login";
    return;
  }
  btn.disabled = true;
  ajax(`/shoutbox/messages/${m.id}/like`, { type: "POST" })
    .then((payload) => {
      const msg = messages.get(m.id);
      if (msg) {
        msg.like_count = payload.like_count;
        msg.liked = payload.liked;
      }
      renderLikeBtn(btn, msg || Object.assign({}, m, payload));
    })
    .catch((err) => {
      window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
    })
    .finally(() => {
      btn.disabled = false;
    });
}

function deleteMessage(widget, m) {
  if (!window.confirm(i18n("shoutbox.confirm_delete"))) {
    return;
  }
  ajax(`/shoutbox/messages/${m.id}.json`, { type: "DELETE" }).catch((err) => {
    window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
  });
}

function copyMessageLink(m) {
  const url = `${window.location.origin}/shoutbox#m-${m.id}`;
  navigator.clipboard
    ? navigator.clipboard.writeText(url).catch(() => {})
    : window.prompt(i18n("shoutbox.copy_link"), url);
  window.alert(i18n("shoutbox.copied"));
}

function startEdit(widget, m) {
  editing = { id: m.id };
  if (widget.els.plusBtn) {
    widget.els.composePop.hidden = false;
  }
  widgets.forEach((w) => w.setEditingChip?.(true));
  const ta = widget.els.composer;
  if (!ta) {
    return;
  }
  // existing images move out of the raw text and back into the attachments
  // strip, so they render as previews and can be removed like new ones
  const images = [...m.message.matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g)];
  widget.els.pending = images.map((g, i) => ({
    id: `edit-${g[1] || i}`,
    name: g[1] || "image",
    status: "done",
    short_url: g[2],
  }));
  renderAttachments(widget);
  ta.value = m.message.replace(IMAGE_MD_RE_G, "").replace(/\n{3,}/g, "\n\n").trim();
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}

function cancelEdit(widget) {
  editing = null;
  widgets.forEach((w) => w.setEditingChip?.(false));
  widget.els.pending = [];
  renderAttachments(widget);
  const ta = widget.els.composer;
  if (ta) {
    ta.value = "";
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }
}

function openRowMenu(widget, m, container) {
  container.querySelector(":scope > .shoutbox__menu")?.remove();
  const menu = el("div", "shoutbox__menu");
  const add = (label, cls, fn) => {
    const b = el("button", "shoutbox__menu-item" + (cls ? " " + cls : ""));
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.remove();
      document.removeEventListener("click", close);
      fn();
    });
    menu.appendChild(b);
  };

  if (m.can_edit) {
    add(i18n("shoutbox.edit"), "", () => startEdit(widget, m));
  }
  if (m.can_delete) {
    add(i18n("shoutbox.delete"), "is-danger", () => deleteMessage(widget, m));
  }
  if (viewer?.staff) {
    add(i18n(m.pinned ? "shoutbox.unpin" : "shoutbox.pin"), "", () => {
      ajax(`/shoutbox/messages/${m.id}/pin`, { type: "POST" }).catch((err) => {
        window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
      });
    });
  }
  add(i18n("shoutbox.copy_link"), "", () => copyMessageLink(m));

  container.appendChild(menu);
  const close = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

// memos-style inline comment box under a message row: submit posts the
// message as a reply (reply_to_id), rendered indented under its parent.
function toggleCommentBox(widget, m, row) {
  const existing = row.querySelector(
    `:scope > .shoutbox__comment-box[data-parent="${m.id}"]`
  );
  widget.els.list.querySelectorAll(".shoutbox__comment-box").forEach((b) => {
    if (b !== existing) {
      b.remove();
    }
  });
  if (existing) {
    existing.remove();
    return;
  }

  const box = el("div", "shoutbox__comment-box");
  box.dataset.parent = m.id;

  const ta = el("textarea", "shoutbox__comment-input");
  ta.rows = 1;
  ta.maxLength = viewer?.max_length || 200;
  ta.placeholder = i18n("shoutbox.comment_placeholder");
  box.appendChild(ta);

  const bar = el("div", "shoutbox__comment-bar");
  const count = el("span", "shoutbox__count");
  const actions = el("div", "shoutbox__composer-actions");

  const cancel = el("button", "shoutbox__comment-cancel");
  cancel.type = "button";
  cancel.textContent = i18n("shoutbox.cancel");
  cancel.addEventListener("click", () => box.remove());
  actions.appendChild(cancel);

  const publish = el("button", "shoutbox__send");
  publish.type = "button";
  publish.textContent = i18n("shoutbox.publish");
  publish.disabled = true;
  actions.appendChild(publish);
  bar.appendChild(count);
  bar.appendChild(actions);
  box.appendChild(bar);
  row.appendChild(box);
  ta.focus();

  const update = () => {
    count.textContent = i18n("shoutbox.count", {
      current: ta.value.length,
      max: ta.maxLength,
    });
    publish.disabled = ta.value.trim().length === 0;
  };
  update();
  ta.addEventListener("input", update);

  publish.addEventListener("click", () => {
    const text = ta.value.trim();
    if (!text || publish.disabled) {
      return;
    }
    publish.disabled = true;
    publish.textContent = i18n("shoutbox.posting");
    ajax("/shoutbox/messages.json", {
      type: "POST",
      data: { message: text, reply_to_id: m.id },
    })
      .then((payload) => {
        box.remove();
        if (payload?.message && !messages.has(payload.message.id)) {
          const mr = payload.message;
          messages.set(mr.id, mr);
          lastSeenId = Math.max(lastSeenId, mr.id);
          widgets.forEach((w) => w.insertReplyRow(mr));
        }
      })
      .catch((err) => {
        publish.disabled = false;
        publish.textContent = i18n("shoutbox.publish");
        window.alert(err?.jqXHR?.responseJSON?.errors?.[0] || i18n("shoutbox.send_failed"));
      });
  });

  ta.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      if (!publish.disabled) {
        publish.click();
      }
    } else if (event.key === "Escape") {
      box.remove();
    }
  });
}

function scrollToTop(widget) {
  const list = widget.els.list;
  requestAnimationFrame(() => {
    list.scrollTop = 0;
  });
}

// ── side column (page variant, memos-style cards) ────────────────────────────
function renderSide(widget) {
  const side = widget.els.side;
  if (!side) {
    return;
  }

  const counts = new Map();
  for (const m of messages.values()) {
    const name = m.user?.username;
    if (!name) {
      continue;
    }
    const entry = counts.get(name) || { user: m.user, count: 0 };
    entry.count += 1;
    counts.set(name, entry);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 5);

  // search box — built once per widget; it must survive renderSide rebuilds
  // or typing would wipe focus and text
  if (!widget.els.searchCard) {
    const card = el("div", "shoutbox-side__card shoutbox-side__card--search");
    const box = el("div", "shoutbox-side__search");
    const icon = el("span", "shoutbox-side__search-icon");
    icon.innerHTML = iconHTML("search");
    const input = el("input", "shoutbox-side__search-input");
    input.type = "search";
    input.placeholder = i18n("shoutbox.side_search");
    input.addEventListener("input", () => {
      searchQuery = input.value;
      widgets.forEach(applySearchFilter);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = "";
        searchQuery = "";
        widgets.forEach(applySearchFilter);
      }
    });
    box.appendChild(icon);
    box.appendChild(input);
    card.appendChild(box);
    widget.els.searchCard = card;
  }

  // "What's new": latest moments as one-line excerpts, click jumps to the row
  const latest = [...messages.values()]
    .filter((m) => !m.reply_to_id)
    .sort((a, b) => b.id - a.id);
  const whatsNew = el("div", "shoutbox-side__card");
  whatsNew.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_whats_new")));
  const shown = latest.slice(0, whatsNewExpanded ? 20 : 5);
  if (shown.length === 0) {
    whatsNew.appendChild(el("div", "shoutbox-side__text", i18n("shoutbox.empty")));
  } else {
    shown.forEach((m) => {
      const row = el("button", "shoutbox-side__excerpt-row");
      row.type = "button";
      const main = el("div", "shoutbox-side__excerpt-main");
      main.appendChild(
        el(
          "div",
          "shoutbox-side__excerpt-meta",
          i18n("shoutbox.side_from", { username: m.user?.username || "?" }),
        ),
      );
      main.appendChild(
        el("div", "shoutbox-side__excerpt", excerptFor(m) || i18n("shoutbox.side_photo")),
      );
      row.appendChild(main);
      // trailing ⁝ appears on hover (memos-style)
      const dots = el("span", "shoutbox-side__excerpt-dots");
      dots.innerHTML = iconHTML("ellipsis-vertical");
      row.appendChild(dots);
      row.addEventListener("click", () => jumpToMessage(widget, m.id));
      whatsNew.appendChild(row);
    });
    if (latest.length > 5) {
      const more = el("button", "shoutbox-side__more");
      more.type = "button";
      more.textContent = i18n(
        whatsNewExpanded ? "shoutbox.side_show_less" : "shoutbox.side_show_more",
      );
      more.addEventListener("click", () => {
        whatsNewExpanded = !whatsNewExpanded;
        widgets.forEach(renderSide);
      });
      whatsNew.appendChild(more);
    }
  }

  // suggested members: most active authors the viewer isn't
  const suggested = el("div", "shoutbox-side__card");
  suggested.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_suggested")));
  const recs = ranked
    .filter((e) => e.user?.username && e.user.username !== viewer?.username)
    .slice(0, 5);
  if (recs.length === 0) {
    suggested.appendChild(
      el("div", "shoutbox-side__text", i18n("shoutbox.side_suggested_empty")),
    );
  } else {
    recs.forEach(({ user, count }) => {
      const rowEl = el("div", "shoutbox-side__row");
      if (user?.avatar_template) {
        const img = el("img");
        img.src = user.avatar_template.replace("{size}", "48");
        img.alt = "";
        img.loading = "lazy";
        rowEl.appendChild(img);
      }
      const a = makeLink(`/u/${esc(user?.username).toLowerCase()}`, "shoutbox-side__name");
      a.textContent = esc(user?.username);
      rowEl.appendChild(a);
      rowEl.appendChild(
        el("span", "shoutbox-side__count", i18n("shoutbox.side_count", { n: count })),
      );
      suggested.appendChild(rowEl);
    });
    const more = makeLink("/u", "shoutbox-side__more");
    more.textContent = i18n("shoutbox.side_show_more");
    suggested.appendChild(more);
  }

  const active = el("div", "shoutbox-side__card");
  active.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.side_active")));
  if (top.length === 0) {
    active.appendChild(el("div", "shoutbox-side__text", i18n("shoutbox.empty")));
  } else {
    top.forEach(({ user, count }) => {
      const rowEl = el("div", "shoutbox-side__row");
      if (user?.avatar_template) {
        const img = el("img");
        img.src = user.avatar_template.replace("{size}", "48");
        img.alt = "";
        img.loading = "lazy";
        rowEl.appendChild(img);
      }
      const a = makeLink(`/u/${esc(user?.username).toLowerCase()}`, "shoutbox-side__name");
      a.textContent = esc(user?.username);
      rowEl.appendChild(a);
      rowEl.appendChild(
        el("span", "shoutbox-side__count", i18n("shoutbox.side_count", { n: count })),
      );
      active.appendChild(rowEl);
    });
  }

  const about = el("div", "shoutbox-side__card");
  about.appendChild(el("div", "shoutbox-side__title", i18n("shoutbox.title")));
  about.appendChild(
    el("p", "shoutbox-side__text", i18n("shoutbox.side_about", { n: messages.size })),
  );

  const cards = [widget.els.searchCard, whatsNew, suggested];
  if (widget.els.tagsCard) {
    cards.push(widget.els.tagsCard);
  }
  cards.push(active, about);
  side.replaceChildren(...cards);
}

// One-line plain-text excerpt for the sidebar "What's new" rows.
function excerptFor(m) {
  return (m.message || "")
    .replace(/!\[[^\]\n]*\]\([^)\s]+[^)]*\)/g, "📷")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Scroll a message row into view and flash it (sidebar What's-new clicks).
function jumpToMessage(widget, id) {
  const row = widget.els.list.querySelector(`[data-id="${id}"]`);
  if (!row) {
    return;
  }
  row.scrollIntoView({ block: "center" });
  row.classList.remove("shoutbox__item--new");
  void row.offsetWidth; // restart the animation
  row.classList.add("shoutbox__item--new");
}

// Hide feed rows that don't match the sidebar search box.
function applySearchFilter(widget) {
  const list = widget.els.list;
  if (!list) {
    return;
  }
  const q = searchQuery.trim().toLowerCase();
  let visible = 0;
  if (q) {
    list.querySelectorAll(".shoutbox__item").forEach((li) => {
      const m = messages.get(parseInt(li.dataset.id, 10));
      const hit = (m?.message || "").toLowerCase().includes(q);
      li.classList.toggle("shoutbox--hidden", !hit);
      if (hit) {
        visible++;
      }
    });
  } else {
    list
      .querySelectorAll(".shoutbox__item.shoutbox--hidden")
      .forEach((li) => li.classList.remove("shoutbox--hidden"));
  }
  let empty = widget.els.searchEmpty;
  if (!empty) {
    empty = el("li", "shoutbox__msg shoutbox__search-empty");
    widget.els.searchEmpty = empty;
  }
  empty.textContent = i18n("shoutbox.side_no_results");
  if (q && visible === 0) {
    if (!empty.isConnected) {
      list.appendChild(empty);
    }
    empty.hidden = false;
  } else {
    empty.hidden = true;
    empty.remove();
  }
}

function loadTagList() {
  tagListPromise ||= ajax("/shoutbox/tags.json")
    .then((d) => d.tags || [])
    .catch(() => []);
  return tagListPromise;
}

function fillTagsCard(widget) {
  const card = widget.els.tagsCard;
  if (!card) {
    return;
  }
  loadTagList().then((tags) => {
    if (widget.destroyed) {
      return;
    }
    card.hidden = tags.length === 0;
    const list = widget.els.tagsList;
    if (!list) {
      return;
    }
    list.replaceChildren();
    tags.forEach(({ name, count }) => {
      const a = makeLink(
        `/shoutbox?tag=${encodeURIComponent(name)}`,
        "shoutbox-side__tag"
      );
      a.textContent = `#${name}`;
      a.appendChild(el("span", "shoutbox-side__count", String(count)));
      list.appendChild(a);
    });
  });
}

function showEmptyStateIfNeeded(widget) {
  if (widget.els.list.children.length === 0) {
    widget.els.list.appendChild(el("li", "shoutbox__msg", i18n("shoutbox.empty")));
  }
}

function hideEmptyState(widget) {
  widget.els.list.querySelector(".shoutbox__msg")?.remove();
}

function renderFoot(widget) {
  const foot = widget.els.foot;

  // Rebuilding the composer on every poll would wipe drafts mid-typing — only
  // rebuild when the viewer's capabilities actually change.
  const sig = viewer ? `${viewer.signed_in}|${viewer.can_post}|${viewer.max_length}` : "";
  if (widget.els.footSig === sig) {
    return;
  }
  widget.els.footSig = sig;
  foot.replaceChildren();

  if (viewer && !viewer.signed_in) {
    const prompt = el("a", "shoutbox__login");
    prompt.href = "/login";
    prompt.textContent = i18n("shoutbox.login_prompt");
    foot.appendChild(prompt);
    return;
  }
  if (viewer && !viewer.can_post) {
    foot.appendChild(el("div", "shoutbox__login", i18n("shoutbox.not_allowed")));
    return;
  }

  const row = el("div", "shoutbox__composer-row");

  if (viewer?.avatar_template) {
    const av = el("img", "shoutbox__composer-avatar");
    av.src = viewer.avatar_template.replace("{size}", "96");
    av.alt = "";
    row.appendChild(av);
  }

  const col = el("div", "shoutbox__composer-col");

  const bar = el("div", "shoutbox__composer-bar");
  const icons = el("div", "shoutbox__composer-icons");

  const fmtBtn = (icon, title, onClick) => {
    const b = el("button", "shoutbox__composer-btn");
    b.type = "button";
    b.title = i18n(title);
    b.setAttribute("aria-label", i18n(title));
    b.innerHTML = iconHTML(icon);
    b.addEventListener("click", () => onClick(ta));
    return b;
  };
  icons.appendChild(fmtBtn("bold", "shoutbox.bold", (t) => wrapSelection(t, "**")));
  icons.appendChild(fmtBtn("italic", "shoutbox.italic", (t) => wrapSelection(t, "*")));
  icons.appendChild(fmtBtn("heading", "shoutbox.heading", (t) => prefixLine(t, "## ")));
  icons.appendChild(fmtBtn("list-ul", "shoutbox.list", (t) => prefixLine(t, "- ")));

  const fileInput = el("input", "shoutbox__file-input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  icons.appendChild(fileInput);

  const imageBtn = fmtBtn("far-image", "shoutbox.image", () => fileInput.click());
  icons.appendChild(imageBtn);

  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = "";
    if (files.length === 0 || imageBtn.disabled) {
      return;
    }
    // X-style: uploads become large previews under the textarea (text stays
    // above), up to 4 per message; markdown is assembled at submit time
    imageBtn.disabled = true;
    imageBtn.classList.add("is-busy");
    const room = 4 - widget.els.pending.filter((p) => p.status !== "failed").length;
    const batch = files.slice(0, Math.max(0, room));
    if (batch.length === 0) {
      imageBtn.disabled = false;
      imageBtn.classList.remove("is-busy");
      return;
    }
    let settled = 0;
    batch.forEach((file) => {
      const item = {
        id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        meta: `${(file.type.split("/")[1] || "image").toUpperCase()} · ${fmtBytes(file.size)}`,
        status: "uploading",
      };
      widget.els.pending.push(item);
      const fd = new FormData();
      fd.append("file", file, file.name);
      ajax("/shoutbox/uploads.json", {
        type: "POST",
        data: fd,
        processData: false,
        contentType: false,
      })
        .then((data) => {
          item.short_url = data.short_url || data.url;
          item.status = "done";
        })
        .catch(() => {
          item.status = "failed";
        })
        .finally(() => {
          settled++;
          if (settled === batch.length) {
            imageBtn.disabled = false;
            imageBtn.classList.remove("is-busy");
          }
          updateCount();
          renderAttachments(widget);
        });
    });
    renderAttachments(widget);
  });

  const emojiBtn = el("button", "shoutbox__composer-btn shoutbox__emoji-btn");
  emojiBtn.type = "button";
  emojiBtn.title = i18n("shoutbox.emoji_picker");
  emojiBtn.setAttribute("aria-label", i18n("shoutbox.emoji_picker"));
  emojiBtn.innerHTML = iconHTML("face-smile");
  icons.appendChild(emojiBtn);

  bar.appendChild(icons);

  const ta = el("textarea", "shoutbox__composer");
  ta.rows = 1;
  ta.maxLength = viewer?.max_length || 200;
  ta.placeholder = i18n("shoutbox.placeholder");
  widget.els.composer = ta;
  col.appendChild(ta);

  // memos-style attachments strip between the textarea and the tool bar;
  // pending survives composer rebuilds (capability-gated)
  widget.els.pending = widget.els.pending || [];
  const attWrap = el("div", "shoutbox__attachments");
  attWrap.hidden = true;
  widget.els.attWrap = attWrap;
  col.appendChild(attWrap);

  const actions = el("div", "shoutbox__composer-actions");
  const count = el("span", "shoutbox__count");
  const updateCount = () => {
    // NB: don't name the option "count" — that makes Discourse's i18n look
    // for pluralized key variants (shoutbox.count.one/other). Image markdown
    // doesn't count toward the limit (the server strips it the same way) and
    // pending attachments make Post available with an otherwise-empty text.
    const visible = ta.value.replace(IMAGE_MD_RE_G, "");
    count.textContent = i18n("shoutbox.count", {
      current: visible.length,
      max: ta.maxLength,
    });
    send.disabled =
      visible.trim().length === 0 &&
      !widget.els.pending.some((p) => p.status === "done");
  };
  actions.appendChild(count);

  const send = el("button", "shoutbox__send");
  send.type = "button";
  send.textContent = i18n("shoutbox.publish");
  send.disabled = true;
  widget.els.sendBtn = send;
  actions.appendChild(send);
  bar.appendChild(actions);

  col.appendChild(bar);
  row.appendChild(col);
  foot.appendChild(row);

  const emojiPop = widget.mountEl.querySelector(".shoutbox__emoji-pop");
  emojiBtn.addEventListener("click", () => {
    emojiPop.hidden = !emojiPop.hidden;
    if (emojiPop.hidden) {
      return;
    }
    if (emojiPop.children.length === 0) {
      loadEmojis().then((map) => {
        if (widget.destroyed) {
          return;
        }
        if (map.size === 0) {
          emojiBtn.hidden = true;
          emojiPop.hidden = true;
          return;
        }
        map.forEach((url, name) => {
          const img = el("img", "shoutbox__emoji-option");
          img.src = url;
          img.alt = `:${name}:`;
          img.title = `:${name}:`;
          img.loading = "lazy";
          img.addEventListener("click", () => {
            insertAtCursor(ta, `:${name}:`);
            emojiPop.hidden = true;
            updateCount();
          });
          emojiPop.appendChild(img);
        });
      });
    }
  });

  const mentionPop = widget.mountEl.querySelector(".shoutbox__mention-pop");
  let mentionSeq = 0;
  let mentionItems = [];
  let mentionIndex = -1;

  const closeMention = () => {
    mentionPop.hidden = true;
    mentionItems = [];
    mentionIndex = -1;
  };
  const highlightMention = () => {
    mentionItems.forEach((item, i) => item.classList.toggle("is-active", i === mentionIndex));
  };

  const applyMention = () => {
    const item = mentionItems[mentionIndex];
    if (!item) {
      return;
    }
    const username = item.dataset.username;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos).replace(/@[a-zA-Z0-9_.-]*$/, `@${username} `);
    ta.value = before + ta.value.slice(pos);
    closeMention();
    ta.focus();
  };

  const refreshMentions = () => {
    const pos = ta.selectionStart ?? ta.value.length;
    const term = ta.value.slice(0, pos).match(/@([a-zA-Z0-9_.-]*)$/)?.[1];
    if (term === null || term === undefined) {
      closeMention();
      return;
    }
    const seq = ++mentionSeq;
    ajax(`/u/search/users.json?term=${encodeURIComponent(term)}&include_groups=false`)
      .then((data) => {
        if (seq !== mentionSeq || widget.destroyed) {
          return;
        }
        mentionItems.forEach((item) => item.remove());
        mentionItems = (data.users || []).slice(0, 6).map((user) => {
          const item = el("button", "shoutbox__mention-option");
          item.type = "button";
          item.dataset.username = user.username;

          const img = el("img");
          img.src = (user.avatar_template || "").replace("{size}", "48");
          img.alt = "";
          item.appendChild(img);

          const wrap = el("span");
          wrap.appendChild(el("b", null, user.username));
          if (user.name) {
            wrap.appendChild(el("small", null, user.name));
          }
          item.appendChild(wrap);

          item.addEventListener("click", applyMention);
          mentionPop.appendChild(item);
          return item;
        });
        mentionIndex = mentionItems.length ? 0 : -1;
        highlightMention();
        mentionPop.hidden = mentionItems.length === 0;
      })
      .catch(closeMention);
  };

  ta.addEventListener("input", () => {
    updateCount();
    refreshMentions();
  });
  ta.addEventListener("click", closeMention);
  ta.addEventListener("blur", () => setTimeout(closeMention, 150));
  ta.addEventListener("keydown", (event) => {
    if (!mentionPop.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (mentionItems.length) {
          mentionIndex =
            (mentionIndex + (event.key === "ArrowDown" ? 1 : mentionItems.length - 1)) %
            mentionItems.length;
          highlightMention();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applyMention();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      event.preventDefault();
      submit(widget);
    } else if (event.key === "Escape") {
      ta.blur();
    }
  });

  send.addEventListener("click", () => submit(widget));
}

function submit(widget) {
  const ta = widget.els.composer;
  const send = widget.els.sendBtn;
  // attachments (memos-style) join the message as image markdown lines
  const attachMd = (widget.els.pending || [])
    .filter((p) => p.status === "done" && p.short_url)
    .map((p) => `\n![${p.name.replace(/\.[^.]+$/, "").slice(0, 60) || "image"}](${p.short_url})`)
    .join("");
  const text = (ta.value.trim() + attachMd).trim();
  if (!text || send.disabled) {
    return;
  }
  send.disabled = true;
  send.textContent = i18n("shoutbox.posting");

  const editingId = editing?.id;
  const req = editingId
    ? ajax(`/shoutbox/messages/${editingId}.json`, { type: "PUT", data: { message: text } })
    : ajax("/shoutbox/messages.json", { type: "POST", data: { message: text } });

  req.then((payload) => {
      ta.value = "";
      ta.dispatchEvent(new Event("input"));
      widget.els.pending = [];
      renderAttachments(widget);
      editing = null;
      widgets.forEach((w) => w.setEditingChip?.(false));
      if (payload?.message) {
        const m = payload.message;
        const isNew = !messages.has(m.id);
        messages.set(m.id, m);
        if (isNew) {
          lastSeenId = Math.max(lastSeenId, m.id);
          widgets.forEach((w) => w.appendRow(m, { isNew: true, forceScroll: true }));
        } else {
          widgets.forEach((w) => w.updateRow(m));
        }
      }
    })
    .catch((err) => {
      const msg =
        err?.jqXHR?.responseJSON?.errors?.[0] ||
        (err?.jqXHR?.status === 429 ? i18n("shoutbox.rate_limited") : i18n("shoutbox.send_failed"));
      window.alert(msg);
    })
    .finally(() => {
      send.textContent = i18n("shoutbox.publish");
      const visible = ta.value.replace(IMAGE_MD_RE_G, "");
      send.disabled =
        visible.trim().length === 0 &&
        !(widget.els.pending || []).some((p) => p.status === "done");
      ta.focus();
    });
}

function buildPopovers(widget) {
  const wrap = el("div", "shoutbox__popovers");
  const emojiPop = el("div", "shoutbox__emoji-pop");
  emojiPop.hidden = true;
  const mentionPop = el("div", "shoutbox__mention-pop");
  mentionPop.hidden = true;
  const composePop = el("div", "shoutbox__compose-pop");
  composePop.hidden = true;
  widget.els.composePop = composePop;
  wrap.appendChild(emojiPop);
  wrap.appendChild(mentionPop);
  wrap.appendChild(composePop);

  widget.mountEl.addEventListener("click", (event) => {
    if (
      !emojiPop.hidden &&
      !event.target.closest(".shoutbox__emoji-pop") &&
      !event.target.closest(".shoutbox__emoji-btn")
    ) {
      emojiPop.hidden = true;
    }
    if (
      !composePop.hidden &&
      !event.target.closest(".shoutbox__compose-pop") &&
      !event.target.closest(".shoutbox__compose-toggle")
    ) {
      composePop.hidden = true;
    }
  });

  return wrap;
}
