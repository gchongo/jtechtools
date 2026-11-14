# frozen_string_literal: true

class ShoutboxMessageSerializer < ::ApplicationSerializer
  attributes :id, :message, :color, :created_at, :can_delete, :can_edit,
             :like_count, :liked, :edited, :pinned

  has_one :user, serializer: ::BasicUserSerializer, embed: :objects

  def can_delete
    return false if scope.blank? || scope.user.blank?

    scope.can_delete_shoutbox_message?(object)
  end

  def can_edit
    return false if scope.blank? || scope.user.blank?

    object.user_id == scope.user.id
  end

  def liked
    return false if scope.blank? || scope.user.blank?

    object.shoutbox_likes.exists?(user_id: scope.user.id)
  end

  def edited
    object.edited_at.present?
  end
end
