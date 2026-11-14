// Picked up by core's mapping-router (any module ending in "route-map").
// Registers the full-page message board at /shoutbox; the server route renders
// the Ember app shell for HTML requests (see ShoutboxMessagesController#index).
export default function () {
  this.route("shoutbox", { path: "/shoutbox" });
}
