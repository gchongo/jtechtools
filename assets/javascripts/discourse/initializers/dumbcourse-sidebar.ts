import { apiInitializer } from "discourse/lib/api";
import getURL from "discourse/lib/get-url";
import type SiteSettingsService from "discourse/services/site-settings";
import { i18n } from "discourse-i18n";

type DumbcourseSiteSettings = SiteSettingsService & {
  dumbcourse_enabled: boolean;
  dumbcourse_sidebar_link_enabled: boolean;
  dumbcourse_base_path: string;
};

// A Dumbcourse icon in the sidebar footer's action row (next to the color
// selector), instead of a text section of its own: easier to reach from the
// chat page and everywhere else. The row re-renders with the sidebar, so a
// MutationObserver keeps the button attached.
export default apiInitializer((api) => {
  const siteSettings: DumbcourseSiteSettings | undefined = api.container.lookup(
    "service:site-settings"
  );
  if (!siteSettings?.dumbcourse_enabled) {
    return;
  }
  if (!siteSettings?.dumbcourse_sidebar_link_enabled) {
    return;
  }

  const basePath = (siteSettings?.dumbcourse_base_path || "dumb").replace(
    /^\/+|\/+$/g,
    ""
  );
  const path = getURL(`/${basePath || "dumb"}`);
  const label = i18n("dumbcourse.sidebar_link_title");

  const addFooterButton = () => {
    const row = document.querySelector(".sidebar-footer-actions");
    if (!row || row.querySelector(".dumbcourse-footer-btn")) {
      return;
    }
    const btn = document.createElement("a");
    btn.className =
      "btn btn-flat btn-icon no-text sidebar-footer-actions-button dumbcourse-footer-btn";
    btn.href = path;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML =
      '<svg class="fa d-icon d-icon-mobile-screen-button svg-icon fa-width-auto svg-string" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><use href="#mobile-screen-button"></use></svg>';
    row.prepend(btn);
  };

  api.onPageChange(() => addFooterButton());
  new MutationObserver(addFooterButton).observe(document.body, {
    childList: true,
    subtree: true,
  });
  addFooterButton();
});
