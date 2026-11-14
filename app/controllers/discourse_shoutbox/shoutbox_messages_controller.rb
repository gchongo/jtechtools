# frozen_string_literal: true

module DiscourseShoutbox
  class ShoutboxMessagesController < ::ApplicationController
    requires_plugin "jtech-tools"

    before_action :ensure_shoutbox_enabled
    before_action :ensure_logged_in, only: %i[create update destroy like pin]

    # HTML requests (GET /shoutbox) serve the Ember app shell — the frontend
    # route-map turns the URL into the full-page board. JSON requests get data.
    def index
      if request.format.json?
        list
      else
        render "default/empty"
      end
    end

    def list
      return raise Discourse::InvalidAccess if current_user.blank? && !SiteSetting.shoutbox_anonymous_view

      messages =
        if (after_id = params[:after_id].to_i).positive?
          ShoutboxMessage.where("id > ?", after_id).order(:id).limit(
            SiteSetting.shoutbox_messages_displayed,
          )
        else
          ShoutboxMessage.where(pinned: true).recent.limit(
            SiteSetting.shoutbox_messages_displayed,
          ).reverse +
            ShoutboxMessage.where(pinned: false).recent.limit(
              SiteSetting.shoutbox_messages_displayed,
            ).reverse
        end

      render json: {
        messages: serialize_messages(messages),
        viewer: viewer_payload,
      }
    end

    def create
      return render_json_error(I18n.t("shoutbox.not_allowed")) unless guardian.can_post_shoutbox?

      RateLimiter.new(
        current_user,
        "shoutbox-create",
        SiteSetting.shoutbox_rate_limit_per_minute,
        1.minute,
      ).performed!

      message = ShoutboxMessage.new(user: current_user, message: params[:message].to_s.strip, color: sanitize_color)

      if message.save
        serialized = serialize_messages(message)
        MessageBus.publish(
          DiscourseShoutbox::MESSAGE_BUS_CHANNEL,
          { type: "created", message: serialized },
        )
        ShoutboxMessage.trim_overflow!
        render json: { message: serialized }
      else
        render_json_error(message)
      end
    end

    def update
      message = ShoutboxMessage.find_by(id: params[:id])
      raise Discourse::NotFound unless message
      raise Discourse::InvalidAccess unless message.user_id == current_user.id

      message.message = params[:message].to_s.strip
      message.edited_at = Time.zone.now

      if message.save
        serialized = serialize_messages(message)
        MessageBus.publish(
          DiscourseShoutbox::MESSAGE_BUS_CHANNEL,
          { type: "updated", message: serialized },
        )
        render json: { message: serialized }
      else
        render_json_error(message)
      end
    end

    def like
      message = ShoutboxMessage.find_by(id: params[:id])
      raise Discourse::NotFound unless message

      like = ShoutboxLike.find_by(user: current_user, shoutbox_message: message)
      if like
        like.destroy
        message.decrement!(:like_count)
        liked = false
      else
        ShoutboxLike.create!(user: current_user, shoutbox_message: message)
        message.increment!(:like_count)
        liked = true
      end

      MessageBus.publish(
        DiscourseShoutbox::MESSAGE_BUS_CHANNEL,
        {
          type: "liked",
          id: message.id,
          like_count: message.like_count,
          liked: liked,
        },
      )
      render json: { like_count: message.like_count, liked: liked }
    end

    def pin
      raise Discourse::InvalidAccess unless current_user&.staff?

      message = ShoutboxMessage.find_by(id: params[:id])
      raise Discourse::NotFound unless message

      message.update!(pinned: !message.pinned)
      MessageBus.publish(
        DiscourseShoutbox::MESSAGE_BUS_CHANNEL,
        { type: "pinned", id: message.id, pinned: message.pinned },
      )
      render json: success_json.merge(pinned: message.pinned)
    end

    def destroy
      message = ShoutboxMessage.find_by(id: params[:id])
      raise Discourse::NotFound unless message
      raise Discourse::InvalidAccess unless guardian.can_delete_shoutbox_message?(message)

      message.destroy!
      MessageBus.publish(DiscourseShoutbox::MESSAGE_BUS_CHANNEL, { type: "deleted", id: message.id })
      render json: success_json
    end

    private

    def ensure_shoutbox_enabled
      raise Discourse::InvalidAccess unless DiscourseShoutbox.enabled?
    end

    def viewer_payload
      {
        signed_in: current_user.present?,
        can_post: current_user.present? && guardian.can_post_shoutbox?,
        max_length: SiteSetting.shoutbox_max_length,
        avatar_template: current_user&.avatar_template,
        staff: current_user&.staff? || false,
      }
    end

    def serialize_messages(records)
      list =
        if records.is_a?(Array) || records.is_a?(ActiveRecord::Relation)
          records
        else
          [records]
        end
      result = list.map { |record| ShoutboxMessageSerializer.new(record, scope: guardian, root: false).as_json }
      records.is_a?(Array) || records.is_a?(ActiveRecord::Relation) ? result : result.first
    end

    # Only accept hex color strings; anything else is dropped. Posting with a
    # color is reserved for staff for now — the column and the API stay open
    # for a later "colored messages" feature.
    def sanitize_color
      color = params[:color].to_s
      return nil unless current_user&.staff?
      return nil unless color.match?(/\A#[0-9a-fA-F]{3,8}\z/)

      color
    end
  end
end
