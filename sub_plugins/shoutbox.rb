# frozen_string_literal: true
# Jtech sub-plugin: Shoutbox — a real message board (memos/X style).
#
# Plugin-backed storage (shoutbox_messages table), MessageBus live updates,
# and three mount points: a homepage panel above the topic list, a sidebar
# community-section link to the full /shoutbox page, and a
# [data-shoutbox-mount] contract for arbitrary placements.
#
# Notes carried over from the standalone discourse-shoutbox plugin:
#   * routes live in the bundle's central config/routes.rb (scoped, no engine)
#   * the migration 20261113000001_create_shoutbox_messages.rb keeps its
#     original timestamp so installs that ran the standalone plugin skip it
#     and keep their data

register_asset "stylesheets/common/shoutbox.scss"

%w[
  paper-plane
  face-smile
  plus
  xmark
  arrow-up-right-from-square
  compass
  reply
  heart
  far-heart
  quote-right
  link
  ellipsis-vertical
  thumbtack
  pencil
  far-comment
  repeat
  chart-column
  share
].each { |name| register_svg_icon(name) }

module ::DiscourseShoutbox
  MESSAGE_BUS_CHANNEL = "/shoutbox"

  def self.enabled?
    SiteSetting.jtech_enabled && SiteSetting.shoutbox_enabled
  end
end

after_initialize do
  add_to_class(:guardian, :can_post_shoutbox?) do
    authenticated? && user.trust_level.to_i >= SiteSetting.shoutbox_min_trust_level
  end

  add_to_class(:guardian, :can_delete_shoutbox_message?) do |message|
    user&.staff? || message.user_id == user&.id
  end
end
