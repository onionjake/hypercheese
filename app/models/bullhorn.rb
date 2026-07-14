class Bullhorn < ActiveRecord::Base
  belongs_to :item
  belongs_to :user

  after_save do |bullhorn|
    UpdateActivityJob.perform_later
  end

  after_create_commit do |bullhorn|
    BullhornPushJob.perform_later bullhorn.id
  end

  after_destroy do |bullhorn|
    UpdateActivityJob.perform_later
  end
end
