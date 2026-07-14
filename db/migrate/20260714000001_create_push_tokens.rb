class CreatePushTokens < ActiveRecord::Migration[7.2]
  def change
    create_table :push_tokens do |t|
      t.integer :user_id, null: false
      t.string :token, null: false, limit: 512
      t.string :platform, null: false, default: 'android'

      t.timestamps
    end

    add_index :push_tokens, :user_id
    add_index :push_tokens, :token, unique: true
  end
end
