# frozen_string_literal: true

class ShoutboxMessage < ActiveRecord::Base
  belongs_to :user
  belongs_to :reply_to,
             class_name: "ShoutboxMessage",
             optional: true,
             counter_cache: :replies_count
  has_many :shoutbox_replies,
           class_name: "ShoutboxMessage",
           foreign_key: "reply_to_id",
           dependent: :delete_all
  has_many :shoutbox_likes, dependent: :delete_all

  validates :user_id, presence: true
  validates :message, presence: true
  validate :message_length_within_limit
  validates :color,
            format: { with: /\A#[0-9a-fA-F]{3,8}\z/, allow_nil: true, allow_blank: true }

  # Newest first; the controller reverses for display.
  scope :recent, -> { order(id: :desc) }

  # #tags are parsed out of the message text itself (memos-style): the text
  # keeps them, the column powers the tag filter and the tags side card.
  before_validation :extract_tags

  TAG_RE = /#([a-zA-Z0-9_\-]{1,40})/

  # ![alt](upload://… / https://…) image markdown — doesn't count toward the
  # visible-text length limit
  IMAGE_MD_RE = /!\[[^\]\n]*\]\([^)\s]+(?:\s[^)]*)?\)/

  def self.extract_tags(text)
    text.to_s.scan(TAG_RE).flatten.map(&:downcase).uniq.first(10)
  end

  private

  def message_length_within_limit
    visible = message.to_s.gsub(IMAGE_MD_RE, "")
    if visible.length > SiteSetting.shoutbox_max_length
      errors.add(:message, :too_long, count: SiteSetting.shoutbox_max_length)
    end
  end

  def extract_tags
    self.tags = self.class.extract_tags(message)
  end

  # Keeps the table bounded: removes everything below the newest N messages.
  def self.trim_overflow!
    max = SiteSetting.shoutbox_max_stored
    return if max <= 0

    cutoff_id = ShoutboxMessage.order(id: :desc).limit(1).offset(max - 1).pick(:id)
    ShoutboxMessage.where("id < ?", cutoff_id).delete_all if cutoff_id
  end
end
