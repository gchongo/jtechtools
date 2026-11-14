# frozen_string_literal: true

class ShoutboxLike < ActiveRecord::Base
  belongs_to :user
  belongs_to :shoutbox_message

  validates :user_id, uniqueness: { scope: :shoutbox_message_id }
end
