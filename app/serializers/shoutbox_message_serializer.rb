# frozen_string_literal: true

class ShoutboxMessageSerializer < ::ApplicationSerializer
  attributes :id, :message, :color, :created_at, :can_delete

  has_one :user, serializer: ::BasicUserSerializer, embed: :objects

  def can_delete
    return false if scope.blank? || scope.user.blank?

    scope.can_delete_shoutbox_message?(object)
  end
end
