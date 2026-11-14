# frozen_string_literal: true

class CreateShoutboxMessages < ActiveRecord::Migration[6.1]
  def change
    create_table :shoutbox_messages do |t|
      t.integer :user_id, null: false
      t.text :message, null: false
      t.string :color
      t.timestamps
    end

    add_index :shoutbox_messages, :created_at
    add_index :shoutbox_messages, :user_id
  end
end
