class CreateWebPushSubscriptions < ActiveRecord::Migration[7.2]
  def change
    create_table :web_push_subscriptions do |t|
      t.integer :user_id, null: false
      t.string :endpoint, null: false, limit: 512
      t.string :p256dh, null: false
      t.string :auth, null: false

      t.timestamps
    end

    add_index :web_push_subscriptions, :user_id
    add_index :web_push_subscriptions, :endpoint, unique: true
  end
end
