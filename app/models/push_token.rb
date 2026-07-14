# A device's FCM registration token, used to send push notifications.  A user
# can have several (one per signed-in device).  Tokens are pruned when FCM
# reports them as no longer registered.
class PushToken < ApplicationRecord
  belongs_to :user

  validates :token, presence: true, uniqueness: true
end
