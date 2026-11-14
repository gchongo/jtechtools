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
  bold
  italic
  heading
  list-ul
  far-image
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

  # Notification type ids: well above core's, unique among the plugins on
  # this install. The client registers render directors for these names.
  def self.notify!(user, type, acting_user, message)
    return if user.nil? || acting_user.nil? || user.id == acting_user.id
    Notification.create!(
      user: user,
      notification_type: Notification.types[type],
      data: {
        display_username: acting_user.username,
        topic_title: message.message.to_s[0, 120],
        url: "/shoutbox#m-#{message.id}",
      }.to_json,
    )
  rescue StandardError => e
    Rails.logger.warn("[jtech-tools shoutbox] notification failed: #{e}")
  end

  def self.enabled?
    SiteSetting.jtech_enabled && SiteSetting.shoutbox_enabled
  end
end

after_initialize do
  # notification type ids (client renderers: initializers/shoutbox.js)
  Notification.types[:shoutbox_reply] = 1101
  Notification.types[:shoutbox_like] = 1102
  Notification.types[:shoutbox_mention] = 1103

  add_to_class(:guardian, :can_post_shoutbox?) do
    authenticated? && user.trust_level.to_i >= SiteSetting.shoutbox_min_trust_level
  end

  add_to_class(:guardian, :can_delete_shoutbox_message?) do |message|
    user&.staff? || message.user_id == user&.id
  end
end
