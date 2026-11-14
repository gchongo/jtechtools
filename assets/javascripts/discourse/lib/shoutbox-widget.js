// The shoutbox widget: a self-contained vanilla-DOM builder shared by all
// mount points (homepage panel, /shoutbox full page, [data-shoutbox-mount]).
// All user content is rendered through DOM APIs (textContent/createElement) —
// no innerHTML with message data, so the board is XSS-safe by construction.
//
// Data flows through one shared store: the first mount pulls the recent list,
// MessageBus "/shoutbox" pushes live creates/deletes to every mounted widget,
// and a 60s catch-up poll guards against a dropped bus message.
import { ajax } from "discourse/lib/ajax";
import { iconHTML } from "discourse/lib/icon-library";
import { i18n } from "discourse-i18n";
import { relativeAge } from "discourse/lib/formatter";
import DiscourseURL from "discourse/lib/url";

const container = () => window.Discourse?.__container__;

// The jtech theme's expand icon (same markup as the theme's jt-card__peek).
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

const maxId = () => {
  let max = lastSeenId;
  for (const id of messages.keys()) {
    if (id > max) max = id;
  }
  return max;
};

const catchUp = () => {
  if (!loaded || widgets.size === 0) {
    return;
  }
  loadMessages(maxId());
};

const loadMessages = (afterId = 0) => {
  const qs = afterId > 0 ? `?after_id=${afterId}` : "";
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
    .catch(() => {
      // allow a later mount/poll to retry
      loading = false;
      widgets.forEach((w) => w.showError());
    });
};

let busStarted = false;
let editing = null; // { id } while a message is being edited

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
                  `[data-id="${m.reply_to_id}"] .shoutbox__comment-btn`,
                );
                if (!btn) {
                  return;
                }
                let label = btn.querySelector(".shoutbox__action-label");
                if (!label) {
                  label = el("span", "shoutbox__action-label");
                  btn.appendChild(label);
                }
                label.textContent = String(pm.reply_count);
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
              `[data-id="${data.id}"] .shoutbox__like`,
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
                  `[data-id="${dead.reply_to_id}"] .shoutbox__comment-btn`,
                );
                const label = btn?.querySelector(".shoutbox__action-label");
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
      }, 60_000);
    }
  }

  if (!loading && !loaded) {
    loading = true;
    loadMessages();
  }
};

// ── rich text rendering ──────────────────────────────────────────────────────

let emojiMap = null;
let emojiPromise = null;
const loadEmojis = () => {
  emojiPromise ||=
    ajax("/emojis.json", { dataType: "json" })
      .then((groups) => {
        const map = new Map();
        Object.values(groups || {}).forEach((group) =>
          (group || []).forEach((e) => {
            if (e?.name && e.url) {
              map.set(e.name, e.url);
            }
          }),
        );
        emojiMap = map;
        return map;
      })
      .catch(() => {
        emojiMap = emojiMap || new Map();
        return emojiMap;
      });
  return emojiPromise;
};

const topicTitles = new Map();
const topicTitle = (id) => {
  topicTitles.set(
    id,
    topicTitles.get(id) ||
      ajax(`/t/${id}.json`)
        .then((d) => String(d?.title || "").trim())
        .catch(() => ""),
  );
  return topicTitles.get(id);
};

const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT = /[)\]}>,.!?;:'"，。！？；：、）》〉】\]]+$/;
const EMOJI_SPLIT = /(:[a-zA-Z0-9_+-]+:)/g;
const MENTION_SPLIT = /(@[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?)/g;

const makeLink = (href, cls) => {
  const a = document.createElement("a");
  a.href = href;
  a.className = cls;
  a.rel = "noopener noreferrer nofollow ugc";
  return a;
};

const appendUrlNode = (parent, raw) => {
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
};

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
      parent.appendChild(document.createTextNode(part));
    }
  });
};

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
      // plain text, or an emoji code the site doesn't know
      appendTextWithMentions(parent, part);
    }
  });
};

const QUOTE_SPLIT = /(\[quote="([^"]*)"\]([\s\S]*?)\[\/quote\])/g;

// Splits quote blocks out first, then URLs, so nothing mangles anything else.
const renderRichText = (parent, text) => {
  text.split(QUOTE_SPLIT).forEach((part) => {
    if (!part) {
      return;
    }
    const q = part.match(/^\[quote="([^"]*)"\]([\s\S]*)\[\/quote\]$/);
    if (q) {
      const bq = el("blockquote", "shoutbox__quote");
      bq.appendChild(el("div", "shoutbox__quote-author", `@${q[1]}`));
      const body = el("div", "shoutbox__quote-body");
      renderRichText(body, q[2].trim());
      bq.appendChild(body);
      parent.appendChild(bq);
      return;
    }
    part.split(URL_SPLIT).forEach((seg) => {
      if (!seg) {
        return;
      }
      if (/^https?:\/\//.test(seg)) {
        appendUrlNode(parent, seg);
      } else {
        appendTextWithEmoji(parent, seg);
      }
    });
  });
};

// ── widget ───────────────────────────────────────────────────────────────────

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

export function mountShoutbox(rootEl, { variant = "panel" } = {}) {
  const widget = { rootEl, variant, els: {}, destroyed: false };

  // Page variant: the host becomes a two-column grid (memos-style) holding
  // the timeline and a sticky side column of info cards. Panel stays a single
  // card.
  let mount;
  if (variant === "page") {
    rootEl.classList.add("shoutbox-page-grid");
    mount = el("div", "shoutbox shoutbox--page");
    rootEl.appendChild(mount);
    widget.els.side = el("aside", "shoutbox-side");
    rootEl.appendChild(widget.els.side);
  } else {
    rootEl.classList.add("shoutbox", "shoutbox--panel");
    mount = rootEl;
  }
  widget.mountEl = mount;

  // head
  const head = el("div", "shoutbox__head");
  head.appendChild(el("span", "shoutbox__title", `📝 ${i18n("shoutbox.title")}`));
  if (variant === "panel") {
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
  }
  mount.appendChild(head);

  // list
  const list = el("ul", "shoutbox__list");
  list.appendChild(el("li", "shoutbox__msg", "…"));
  widget.els.list = list;

  // composer / login area — filled once the viewer payload arrives
  const foot = el("div", "shoutbox__foot");
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
    for (const m of topLevel) {
      const animate = m.id > cutoff;
      widget.els.list.appendChild(buildRow(widget, m, { animate }));
      last = m;
      for (const r of repliesByParent.get(m.id) || []) {
        const rAnim = r.id > cutoff;
        widget.els.list.appendChild(buildRow(widget, r, { animate: rAnim, isReply: true }));
        last = r;
      }
    }
    if (last) {
      lastSeenId = Math.max(lastSeenId, last.id);
    }
    showEmptyStateIfNeeded(widget);
    renderFoot(widget);
    renderSide(widget);
    scrollToBottom(widget);
  };

  widget.appendRow = (m, { isNew = false, forceScroll = false } = {}) => {
    hideEmptyState(widget);
    const animate = isNew && m.id > lastSeenId;
    lastSeenId = Math.max(lastSeenId, m.id);
    widget.els.list.appendChild(buildRow(widget, m, { animate }));
    renderSide(widget);
    scrollToBottom(widget, forceScroll);
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
  };

  widget.setEditingChip = (on) => {
    if (widget.els.editingChip) {
      widget.els.editingChip.hidden = !on;
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

  // meta: author + handle, pinned flag right
  const meta = el("div", "jt-card__meta");
  const author = el("span", "shoutbox__author");
  const name = makeLink(userHref(m), "shoutbox__name");
  name.textContent = esc(m.user?.name || m.user?.username);
  author.appendChild(name);
  const handle = makeLink(userHref(m), "shoutbox__handle");
  handle.textContent = `@${esc(m.user?.username)}`;
  author.appendChild(handle);
  meta.appendChild(author);
  const flags = el("span", "jt-card__flags");
  if (m.pinned) {
    flags.appendChild(el("span", "jt-pill", `\u{1F4CC} ${i18n("shoutbox.pinned_label")}`));
  }
  meta.appendChild(flags);
  li.appendChild(meta);

  // body: content
  const body = el("div", "jt-card__body");
  const text = el("div", "jt-card__text");
  if (m.color) {
    text.style.color = m.color;
  }
  renderRichText(text, esc(m.message));
  body.appendChild(text);
  li.appendChild(body);

  // foot: avatar + stats (comment / like / views / time) + row menu
  const foot = el("div", "jt-card__foot");
  const people = el("span", "jt-card__people");
  if (m.user?.avatar_template) {
    const link = el("a", "shoutbox__people-link");
    link.href = userHref(m);
    const avatar = el("img", "avatar");
    avatar.src = avatarSrc(m, 24);
    avatar.alt = "";
    avatar.loading = "lazy";
    link.appendChild(avatar);
    people.appendChild(link);
  }
  foot.appendChild(people);

  const stats = el("span", "jt-card__stats");

  const commentBtn = el("button", "jt-card__stat shoutbox__stat-btn");
  commentBtn.type = "button";
  commentBtn.innerHTML = iconHTML("far-comment");
  if (m.reply_count > 0) {
    commentBtn.appendChild(el("span", "number", String(m.reply_count)));
  }
  commentBtn.title = i18n("shoutbox.comment");
  commentBtn.setAttribute("aria-label", i18n("shoutbox.comment"));
  commentBtn.addEventListener("click", () => toggleCommentBox(widget, m, li));
  stats.appendChild(commentBtn);

  const likeBtn = el("button", "jt-card__stat shoutbox__stat-btn shoutbox__like");
  likeBtn.type = "button";
  likeBtn.title = i18n("shoutbox.like");
  likeBtn.setAttribute("aria-label", i18n("shoutbox.like"));
  renderLikeBtn(likeBtn, m);
  likeBtn.addEventListener("click", () => toggleLike(widget, m, likeBtn));
  stats.appendChild(likeBtn);

  const views = el("span", "jt-card__stat");
  views.title = i18n("shoutbox.views", { n: m.views || 0 });
  views.innerHTML =
    iconHTML("far-eye") +
    '<span class="number">' + (m.views || 0) + "</span>";
  stats.appendChild(views);

  const activity = el("span", "jt-card__stat --activity");
  const time = el("span", "relative-date");
  const date = new Date(m.created_at);
  time.textContent = relativeAge(date, { format: "tiny" });
  time.title = date.toLocaleString();
  activity.appendChild(time);
  stats.appendChild(activity);

  const menuBtn = el("button", "jt-card__peek btn btn-flat no-text");
  menuBtn.type = "button";
  menuBtn.innerHTML = iconHTML("ellipsis-vertical");
  menuBtn.title = i18n("shoutbox.menu");
  menuBtn.setAttribute("aria-label", i18n("shoutbox.menu"));
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openRowMenu(widget, m, li);
  });
  stats.appendChild(menuBtn);

  foot.appendChild(stats);
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
  ta.value = m.message;
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}

function cancelEdit(widget) {
  editing = null;
  widgets.forEach((w) => w.setEditingChip?.(false));
  const ta = widget.els.composer;
  if (ta) {
    ta.value = "";
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }
}

function openRowMenu(widget, m, container) {
  // one menu at a time, per row
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
    `:scope > .shoutbox__comment-box[data-parent="${m.id}"]`,
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

// Fires the view POST when a message row first scrolls into view.
const seenObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }
      seenObserver.unobserve(entry.target);
      const id = Number(entry.target.dataset.id);
      if (!id || viewedInSession.has(id)) {
        return;
      }
      viewedInSession.add(id);
      ajax(`/shoutbox/messages/${id}/view`, { type: "POST" })
        .then((payload) => {
          const m = messages.get(id);
          if (m && payload?.views != null) {
            m.views = payload.views;
            widgets.forEach((w) => {
              const elv = w.els.list.querySelector(
                `[data-id="${id}"] .shoutbox__action--views .shoutbox__action-label`,
              );
              if (elv) {
                elv.textContent = payload.views;
              }
            });
          }
        })
        .catch(() => {});
    });
  },
  { threshold: 0.5 },
);

function scrollToBottom(widget, force = false) {
  const list = widget.els.list;
  requestAnimationFrame(() => {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (force || nearBottom) {
      list.scrollTop = list.scrollHeight;
    }
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
  const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5);

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

  side.replaceChildren(active, about);
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

  // Panel variant: no inline composer at all. The head's ＋ button toggles the
  // compose popup; the expand button goes to the full page. Anon/not-allowed
  // is expressed by hiding ＋ entirely.
  if (widget.variant === "panel") {
    foot.replaceChildren();
    if (widget.els.plusBtn) {
      widget.els.plusBtn.hidden = !(viewer && viewer.can_post);
    }
    if (viewer && viewer.can_post) {
      buildComposerInto(widget, widget.els.composePop);
    }
    return;
  }

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

  buildComposerInto(widget, foot);
}

function buildComposerInto(widget, host) {
  // memos-style composer: avatar + borderless editor, then a hairline bar
  // with the icon strip on the left and the publish pill on the right.
  const row = el("div", "shoutbox__composer-row");

  if (viewer?.avatar_template) {
    const av = el("img", "shoutbox__composer-avatar");
    av.src = viewer.avatar_template.replace("{size}", "96");
    av.alt = "";
    row.appendChild(av);
  }

  const col = el("div", "shoutbox__composer-col");

  const ta = el("textarea", "shoutbox__composer");
  ta.rows = 1;
  ta.maxLength = viewer?.max_length || 200;
  ta.placeholder = i18n("shoutbox.placeholder");
  widget.els.composer = ta;
  col.appendChild(ta);

  const bar = el("div", "shoutbox__composer-bar");
  const icons = el("div", "shoutbox__composer-icons");

  const emojiBtn = el("button", "shoutbox__composer-btn shoutbox__emoji-btn");
  emojiBtn.type = "button";
  emojiBtn.title = i18n("shoutbox.emoji_picker");
  emojiBtn.setAttribute("aria-label", i18n("shoutbox.emoji_picker"));
  emojiBtn.innerHTML = iconHTML("face-smile");
  icons.appendChild(emojiBtn);

  const count = el("span", "shoutbox__count");
  icons.appendChild(count);

  bar.appendChild(icons);

  const actions = el("div", "shoutbox__composer-actions");
  const send = el("button", "shoutbox__send");
  send.type = "button";
  send.textContent = i18n("shoutbox.publish");
  send.disabled = true; // memos-style: grey pill until there is text
  widget.els.sendBtn = send;
  actions.appendChild(send);
  bar.appendChild(actions);

  col.appendChild(bar);
  row.appendChild(col);
  host.appendChild(row);

  const updateCount = () => {
    // NB: don't name the option "count" — that makes Discourse's i18n look
    // for pluralized key variants (shoutbox.count.one/other).
    count.textContent = i18n("shoutbox.count", {
      current: ta.value.length,
      max: ta.maxLength,
    });
    send.disabled = ta.value.trim().length === 0;
  };
  updateCount();
  ta.addEventListener("input", updateCount);

  const emojiPop = widget.rootEl.querySelector(".shoutbox__emoji-pop");
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

  const mentionPop = widget.rootEl.querySelector(".shoutbox__mention-pop");
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

  ta.addEventListener("input", refreshMentions);
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

  // editing indicator (shown while a message is being edited)
  const chip = el("div", "shoutbox__editing");
  chip.hidden = true;
  chip.appendChild(el("span", null, "✎ " + i18n("shoutbox.editing")));
  const chipCancel = el("button", "shoutbox__editing-cancel");
  chipCancel.type = "button";
  chipCancel.textContent = "✕";
  chipCancel.title = i18n("shoutbox.cancel");
  chipCancel.addEventListener("click", () => cancelEdit(widget));
  chip.appendChild(chipCancel);
  host.insertBefore(chip, row);
  widget.els.editingChip = chip;

  send.addEventListener("click", () => submit(widget));
}

function submit(widget) {
  const ta = widget.els.composer;
  const send = widget.els.sendBtn;
  const text = ta.value.trim();
  if (!text || send.disabled) {
    return;
  }
  send.disabled = true;
  send.innerHTML = i18n("shoutbox.posting");

  const editingId = editing?.id;
  const req = editingId
    ? ajax(`/shoutbox/messages/${editingId}.json`, { type: "PUT", data: { message: text } })
    : ajax("/shoutbox/messages.json", { type: "POST", data: { message: text } });

  req.then((payload) => {
      ta.value = "";
      ta.dispatchEvent(new Event("input"));
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
      send.disabled = ta.value.trim().length === 0;
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
