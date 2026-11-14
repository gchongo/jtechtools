# frozen_string_literal: true

class AddViewsToShoutboxMessages < ActiveRecord::Migration[6.1]
  def change
    add_column :shoutbox_messages, :views, :integer, default: 0, null: false
  end
end
