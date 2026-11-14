// Picked up by core's mapping-router (any module ending in "route-map").
// Registers the full-page message board at /shoutbox and the per-message
// detail page at /shoutbox/m/:id; the server route renders the Ember app
// shell for HTML requests (see ShoutboxMessagesController#index/show).
export default function () {
  this.route("shoutbox", { path: "/shoutbox" });
  this.route("shoutboxMessage", { path: "/shoutbox/m/:id" });
}
