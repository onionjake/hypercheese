class StoreCheeseBlobMtimeAsString < ActiveRecord::Migration[7.2]
  def up
    change_column :cheese_blobs, :mtime, :string, null: false
  end

  def down
    change_column :cheese_blobs, :mtime, :datetime, precision: nil, null: false
  end
end
