class AddNanosecondPrecisionToCheeseBlobsMtime < ActiveRecord::Migration[7.2]
  def up
    change_column :cheese_blobs, :mtime, :datetime, precision: datetime_precision, null: false
  end

  def down
    change_column :cheese_blobs, :mtime, :datetime, precision: nil, null: false
  end

  private

  def datetime_precision
    return 6 if mysql?

    9
  end

  def mysql?
    ActiveRecord::Base.connection.adapter_name.downcase.include? 'mysql'
  end
end
