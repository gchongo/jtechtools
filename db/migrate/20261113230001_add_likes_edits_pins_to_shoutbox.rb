# frozen_string_literal: true

class AddLikesEditsPinsToShoutbox < ActiveRecord::Migration[6.1]
  def change
    add_column :shoutbox_messages, :like_count, :integer, default: 0, null: false
    add_column :shoutbox_messages, :edited_at, :datetime
    add_column :shoutbox_messages, :pinned, :boolean, default: false, null: false
    add_index :shoutbox_messages, :pinned

    create_table :shoutbox_likes do |t|
      t.integer :user_id, null: false
      t.integer :shoutbox_message_id, null: false
      t.timestamps
    end

    add_index :shoutbox_likes, [:shoutbox_message_id, :user_id], unique: true
    add_index :shoutbox_likes, :user_id
  end
end
