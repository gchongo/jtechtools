// Glue between the shoutbox widget (lib/shoutbox-widget.js) and the app:
// 1. homepage panel above the topic list (shoutbox_homepage_panel)
// 2. sidebar community-section link to /shoutbox (shoutbox_sidebar_link)
// 3. [data-shoutbox-mount] auto-mount contract for arbitrary placements
//    (custom sidebar widgets, theme connectors, admin HTML blocks…)
import { apiInitializer } from "discourse/lib/api";
import { i18n } from "discourse-i18n";
import { mountShoutbox, unmountShoutbox } from "../lib/shoutbox-widget";

const HOME_PATHS = new Set(["/", "/latest", "/categories"]);
const mounted = new Map(); // mount element → widget handle (Map: iterated for cleanup)
let homeWidget = null;
let scanQueued = false;

const isHomePage = () => HOME_PATHS.has(window.location.pathname);

const findHomeAnchor = () =>
  document.querySelector(
    [
      "#main-outlet .list-container",
      "#main-outlet .categories-and-latest",
      "#main-outlet .more-topics__container",
    ].join(", "),
  );

const ensureHomePanel = (siteSettings) => {
  if (!siteSettings.shoutbox_homepage_panel || !isHomePage()) {
    removeHomePanel();
    return;
  }
  if (homeWidget && homeWidget.rootEl.isConnected) {
    return;
  }
  const anchor = findHomeAnchor();
  if (!anchor) {
    return;
  }
  if (!homeWidget) {
    const host = document.createElement("div");
    host.className = "shoutbox-home-panel";
    homeWidget = mountShoutbox(host, { variant: "panel" });
    homeWidget.hostEl = host;
  }
  if (!homeWidget.rootEl.isConnected) {
    anchor.insertBefore(homeWidget.hostEl, anchor.firstChild);
  }
};

const removeHomePanel = () => {
  homeWidget?.hostEl?.remove();
};

const scanMounts = (siteSettings) => {
  document.querySelectorAll("[data-shoutbox-mount]").forEach((node) => {
    if (mounted.has(node) || node.querySelector(".shoutbox")) {
      return;
    }
    mounted.set(node, mountShoutbox(node, { variant: "panel" }));
  });

  // clean up widgets whose mount node was removed from the DOM
  mounted.forEach((widget, node) => {
    if (!node.isConnected) {
      unmountShoutbox(widget);
      mounted.delete(node);
    }
  });

  ensureHomePanel(siteSettings);
};

export default apiInitializer("1.8.0", (api) => {
  const siteSettings = api.container.lookup("service:site-settings");
  if (!siteSettings.jtech_enabled || !siteSettings.shoutbox_enabled) {
    return;
  }

  const scheduleScan = () => {
    if (scanQueued) {
      return;
    }
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanMounts(siteSettings);
    });
  };

  api.onPageChange(scheduleScan);

  // Ember re-renders can remove/re-add list containers at any time — watch
  // for it so the homepage panel and custom mounts stay attached.
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  if (siteSettings.shoutbox_sidebar_link) {
    api.addCommunitySectionLink({
      name: "shoutbox",
      title: i18n("shoutbox.title"),
      text: i18n("shoutbox.title"),
      href: "/shoutbox",
      icon: "comment",
    });
  }
});
