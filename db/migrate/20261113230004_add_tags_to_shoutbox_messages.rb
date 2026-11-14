# frozen_string_literal: true

class AddTagsToShoutboxMessages < ActiveRecord::Migration[6.1]
  def change
    add_column :shoutbox_messages, :tags, :string, array: true, default: [], null: false
    add_index :shoutbox_messages, :tags, using: "gin"
  end
end
