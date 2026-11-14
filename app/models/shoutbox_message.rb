# frozen_string_literal: true

class ShoutboxMessage < ActiveRecord::Base
  belongs_to :user
  has_many :shoutbox_likes, dependent: :delete_all

  validates :user_id, presence: true
  validates :message,
            presence: true,
            length: { maximum: -> { SiteSetting.shoutbox_max_length } }
  validates :color,
            format: { with: /\A#[0-9a-fA-F]{3,8}\z/, allow_nil: true, allow_blank: true }

  # Newest first; the controller reverses for display.
  scope :recent, -> { order(id: :desc) }

  # Keeps the table bounded: removes everything below the newest N messages.
  def self.trim_overflow!
    max = SiteSetting.shoutbox_max_stored
    return if max <= 0

    cutoff_id = ShoutboxMessage.order(id: :desc).limit(1).offset(max - 1).pick(:id)
    ShoutboxMessage.where("id < ?", cutoff_id).delete_all if cutoff_id
  end
end
