# frozen_string_literal: true

class AddReplyToToShoutboxMessages < ActiveRecord::Migration[6.1]
  def change
    add_column :shoutbox_messages, :reply_to_id, :integer
    add_column :shoutbox_messages, :replies_count, :integer, default: 0, null: false
    add_index :shoutbox_messages, :reply_to_id
  end
end
