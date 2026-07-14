# A browser's Web Push subscription (endpoint plus encryption keys), used to
# notify the web app the same way push_tokens notify the mobile app.  Pruned
# when the push service reports the subscription expired.
class WebPushSubscription < ApplicationRecord
  belongs_to :user

  validates :endpoint, presence: true, uniqueness: true
  validates :p256dh, presence: true
  validates :auth, presence: true
end
