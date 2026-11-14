// Rebuilds each suggested-topics row ("New & Unread Topics") into the exact
// native jt-card DOM the homepage uses (td.jt-card > __meta/__body/__foot)
// and tags the table with the jt-cards class, so the theme's own
// jt-cards.scss does all the styling: category meta, excerpt links, poster
// avatars, and the icon stat footer.
//
// Excerpts: core's cached topic excerpts are short and often cut mid-word
// with a trailing ellipsis, which leaves the card's second line half empty.
// Whenever the cached excerpt is missing or truncated, the component pulls
// the topic's first post and clips a longer excerpt at a word boundary —
// the CSS two-line clamp then fills the second line completely and cuts at
// a word itself. No "read more" label.
import { ajax } from "discourse/lib/ajax";
import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";

// page topic id -> Map(suggested topic id -> payload topic object)
const cache = new Map();
const inFlight = new Set();
let stripBox = null;

const pageTopicId = () => {
  const match = location.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/);
  return match ? Number(match[1]) : null;
};

const stripHtml = (html) => {
  stripBox ||= document.createElement("div");
  stripBox.innerHTML = html || "";
  return (stripBox.textContent || "").trim();
};

// Cut at a word boundary so clips never end mid-word
const clipWords = (text, max = 700) => {
  const t = (text || "").trim();
  if (t.length <= max) {
    return t;
  }
  const cut = t.lastIndexOf(" ", max);
  return (cut > 0 ? t.slice(0, cut) : t.slice(0, max)).trimEnd();
};

// core's cached excerpt is usable only when it is complete
const excerptTruncated = (topic) =>
  !topic.excerpt || /(&hellip;|…)\s*$/.test(topic.excerpt);

// d-icon names map onto the jtech sprite through the theme's icon map
const ICON_SPRITE = {
  "far-comment": "message-circle",
  "far-eye": "eye",
  "far-heart": "heart",
  expand: "expand",
};

const iconSvg = (name) =>
  `<svg class="fa d-icon d-icon-${name} svg-icon fa-width-auto svg-string" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><use href="#jt-${ICON_SPRITE[name] || name.replace("far-", "")}"></use></svg>`;

// Opens the theme's own Quick look modal, resolved at runtime so the
// theme id in the module name never matters.
const openQuickLook = (topic) => {
  const container = window.Discourse?.__container__;
  if (!container) {
    return;
  }
  const modal = container.lookup("service:modal");
  const moduleName = Object.keys(window.require.entries || {}).find((name) =>
    /components\/jt-quick-look/.test(name),
  );
  if (!modal || !moduleName) {
    return;
  }
  const JtQuickLook = window.require(moduleName)?.default;
  if (!JtQuickLook) {
    return;
  }
  const site = container.lookup("service:site");
  const category =
    site?.categories?.find?.(
      (c) => Number(c.id) === Number(topic.category_id),
    ) ?? null;
  modal.show(JtQuickLook, {
    model: {
      topic: {
        id: topic.id,
        fancyTitle: topic.fancy_title || topic.title || "",
        category,
        url: `/t/${topic.slug}/${topic.id}`,
      },
    },
  });
};

export default apiInitializer((api) => {
  const inject = () => {
    const topicId = pageTopicId();
    if (!topicId) {
      return;
    }
    const container = document.querySelector(".more-topics__container");
    if (!container) {
      return;
    }

    // the theme's card stylesheet keys off this class
    container.querySelector("table.topic-list")?.classList.add("jt-cards");

    let map = cache.get(topicId);
    if (!map) {
      // One fetch per topic page per session; the payload's suggested_topics
      // carry everything the DOM is missing.
      if (!inFlight.has(topicId)) {
        inFlight.add(topicId);
        ajax(`/t/${topicId}.json`)
          .then((payload) => {
            const m = new Map();
            for (const topic of payload?.suggested_topics || []) {
              m.set(Number(topic.id), topic);
            }
            cache.set(topicId, m);
            if (cache.size > 20) {
              cache.delete(cache.keys().next().value);
            }
          })
          .catch(() => cache.set(topicId, new Map()))
          .finally(() => {
            inFlight.delete(topicId);
            inject();
          });
      }
      return;
    }

    const fullTextIds = [];
    const unknownIds = [];
    container
      .querySelectorAll(".topic-list-item[data-topic-id]")
      .forEach((row) => {
        const id = Number(row.dataset.topicId);
        const topic = map.get(id);
        if (!topic) {
          // the live list swapped this in after page load — fetch it
          if (!inFlight.has(id) && unknownIds.length < 5) {
            unknownIds.push(id);
          }
          return;
        }
        if (topic.noop) {
          return; // its fetch failed earlier; don't build a half card
        }
        // Gather the row's own nodes; stashed ones cover rebuilds after the
        // original tds are gone (e.g. a longer excerpt arrived late). The
        // desktop and mobile topic rows have different structures — try both.
        const category =
          row.querySelector(".link-bottom-line .badge-category__wrapper") ||
          row.querySelector(
            ".topic-item-stats__category-tags .badge-category__wrapper",
          ) ||
          topic._categoryWrap;
        const tags =
          row.querySelector(".link-bottom-line .discourse-tags") ||
          row.querySelector(
            ".topic-item-stats__category-tags .discourse-tags",
          ) ||
          topic._tagsNode;
        const dateSpan =
          row.querySelector("td.activity .relative-date") ||
          row.querySelector(".num.activity .relative-date") ||
          topic._dateSpan;
        const desktopTitle = row.querySelectorAll(".link-top-line > *");
        const mobileTitle = [
          ...row.querySelectorAll(".main-link .topic-statuses"),
          ...row.querySelectorAll(".main-link a.title"),
        ];
        const titleNodes = desktopTitle.length
          ? [...desktopTitle]
          : mobileTitle.length
            ? [...mobileTitle]
            : topic._titleNodes || [];
        const desiredExcerpt =
          topic.firstPostText !== undefined
            ? clipWords(topic.firstPostText)
            : topic.excerpt || "";

        // A card whose excerpt is shorter than the current source is stale:
        // the longer text arrived after the first build — rebuild it.
        const existingCard = row.querySelector(":scope > td.jt-card");
        const existingExcerpt = existingCard?.querySelector(
          ".topic-excerpt span",
        )?.textContent;
        const desiredLen = (
          topic.firstPostText !== undefined
            ? desiredExcerpt
            : stripHtml(topic.excerpt)
        ).length;
        if (existingCard && (existingExcerpt?.length ?? -1) >= desiredLen) {
          return; // up to date
        }
        // stash for the next rebuild
        if (category) {
          topic._categoryWrap = category;
        }
        if (tags) {
          topic._tagsNode = tags;
        }
        if (dateSpan) {
          topic._dateSpan = dateSpan;
        }
        if (desktopTitle.length || mobileTitle.length) {
          topic._titleNodes = titleNodes;
        }

        const card = document.createElement("td");
        card.className = "jt-card";

        // ── meta: category + tags, moved from the original row ──
        const meta = document.createElement("div");
        meta.className = "jt-card__meta";
        if (category) {
          const wrap = document.createElement("span");
          wrap.className = "jt-card__category";
          wrap.appendChild(category);
          meta.appendChild(wrap);
        }
        if (tags) {
          tags.classList.add("jt-card__tags");
          meta.appendChild(tags);
        }
        const flags = document.createElement("span");
        flags.className = "jt-card__flags";
        meta.appendChild(flags);
        card.appendChild(meta);

        // ── body: title, then a full-width two-line excerpt ──
        const body = document.createElement("div");
        body.className = "jt-card__body";
        const text = document.createElement("div");
        text.className = "jt-card__text";
        const title = document.createElement("div");
        title.className = "jt-card__title";
        title.setAttribute("role", "heading");
        title.setAttribute("aria-level", "2");
        titleNodes.forEach((child) => title.appendChild(child));
        text.appendChild(title);
        const excerpt = desiredExcerpt;
        if (excerpt) {
          const link = document.createElement("a");
          link.className = "topic-excerpt";
          link.href = `/t/${topic.slug}/${topic.id}`;
          const span = document.createElement("span");
          if (topic.firstPostText !== undefined) {
            span.textContent = excerpt; // plain text from the cooked post
          } else {
            span.innerHTML = excerpt; // core's escaped excerpt
          }
          link.appendChild(span);
          text.appendChild(link);
        }
        body.appendChild(text);
        card.appendChild(body);

        // ── foot: poster avatars, then the icon stats ──
        const foot = document.createElement("div");
        foot.className = "jt-card__foot";
        const people = document.createElement("span");
        people.className = "jt-card__people";
        for (const poster of topic.posters || []) {
          const user = poster.user || {};
          if (!user.username || !user.avatar_template) {
            continue;
          }
          const link = document.createElement("a");
          link.href = `/u/${user.username.toLowerCase()}`;
          link.setAttribute("data-user-card", user.username);
          link.setAttribute("aria-label", `${user.username}'s profile`);
          link.tabIndex = 0;
          const img = document.createElement("img");
          img.className = "avatar latest single";
          img.width = 24;
          img.height = 24;
          img.loading = "lazy";
          img.alt = "";
          img.title = `${user.username} - ${poster.description || ""}`;
          img.src = user.avatar_template.replace("{size}", "24");
          link.appendChild(img);
          people.appendChild(link);
        }
        foot.appendChild(people);

        const stats = document.createElement("span");
        stats.className = "jt-card__stats";
        const stat = (label, icon, value) => {
          const el = document.createElement("span");
          el.className = "jt-card__stat";
          el.title = label;
          el.innerHTML = `${iconSvg(icon)}<span class="number">${value}</span>`;
          return el;
        };
        // the comment icon stays on even at zero replies: asked-for
        stats.appendChild(
          stat(
            i18n("jt.replies", { count: topic.reply_count }),
            "far-comment",
            topic.reply_count,
          ),
        );
        stats.appendChild(
          stat(
            i18n("jt.views", { count: topic.views }),
            "far-eye",
            topic.views,
          ),
        );
        if (topic.like_count > 0) {
          stats.appendChild(
            stat(
              i18n("jt.likes", { count: topic.like_count }),
              "far-heart",
              topic.like_count,
            ),
          );
        }
        // Quick look: same modal as the homepage cards, signed-in only like
        // the native gate
        if (api.getCurrentUser()) {
          const peek = document.createElement("button");
          peek.type = "button";
          peek.className = "btn btn-flat no-text jt-card__peek";
          peek.setAttribute("aria-label", i18n("jt.quick_look"));
          peek.title = i18n("jt.quick_look");
          peek.innerHTML = iconSvg("expand");
          peek.addEventListener("click", (event) => {
            // keep the row's click-to-open from firing
            event.preventDefault();
            event.stopPropagation();
            openQuickLook(topic);
          });
          stats.appendChild(peek);
        }
        const activity = document.createElement("span");
        activity.className = "jt-card__stat --activity";
        if (dateSpan) {
          activity.appendChild(dateSpan);
        }
        stats.appendChild(activity);
        foot.appendChild(stats);
        card.appendChild(foot);

        row.replaceChildren(card);

        // core's excerpt is missing or cut short — pull the first post and
        // clip a longer, word-boundary-safe excerpt from it
        if (
          excerptTruncated(topic) &&
          topic.firstPostText === undefined &&
          !inFlight.has(id)
        ) {
          fullTextIds.push(id);
        }
      });

    // topics swapped in after page load: fetch their data
    unknownIds.forEach((id) => {
      inFlight.add(id);
      ajax(`/t/${id}.json`)
        .then((payload) => {
          map.set(id, {
            id,
            slug: payload?.slug,
            category_id: payload?.category_id,
            fancy_title: payload?.fancy_title,
            title: payload?.title,
            excerpt: payload?.excerpt || "",
            firstPostText: stripHtml(payload?.post_stream?.posts?.[0]?.cooked),
            posters: payload?.details?.created_by
              ? [
                  {
                    user: payload.details.created_by,
                    description: "Original Poster",
                  },
                ]
              : [],
            reply_count: payload?.reply_count ?? 0,
            views: payload?.views ?? 0,
            like_count: payload?.like_count ?? 0,
          });
        })
        .catch(() => map.set(id, { id, noop: true }))
        .finally(() => {
          inFlight.delete(id);
          inject();
        });
    });

    // truncated/missing core excerpts: fetch the first post for full text
    fullTextIds.forEach((id) => {
      inFlight.add(id);
      ajax(`/t/${id}.json`)
        .then((payload) => {
          const topic = map.get(id);
          if (topic) {
            topic.firstPostText = stripHtml(
              payload?.post_stream?.posts?.[0]?.cooked,
            );
          }
          inject();
        })
        .catch(() => {
          const topic = map.get(id);
          if (topic) {
            topic.firstPostText = ""; // give up; keep the core excerpt
          }
        })
        .finally(() => inFlight.delete(id));
    });
  };

  // The suggested list renders with (or right after) the topic, and Ember
  // re-renders it on updates; the observer catches every version.
  api.onPageChange(() => requestAnimationFrame(inject));

  const observer = new MutationObserver(() => {
    requestAnimationFrame(inject);
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
