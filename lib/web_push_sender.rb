require 'web-push'

# Sends browser push notifications using the Web Push protocol (VAPID).
#
# Configure by generating a key pair once:
#
#   bundle exec rails runner 'k = WebPush.generate_key; puts "VAPID_PUBLIC_KEY=#{k.public_key}\nVAPID_PRIVATE_KEY=#{k.private_key}"'
#
# and setting those two environment variables (plus optionally VAPID_SUBJECT,
# a mailto: or https: URL identifying the server operator) for the Rails app
# and its delayed_job workers.  Without them everything no-ops.
class WebPushSender
  def self.configured?
    ENV['VAPID_PUBLIC_KEY'].present? && ENV['VAPID_PRIVATE_KEY'].present?
  end

  def self.public_key
    ENV['VAPID_PUBLIC_KEY']
  end

  # Returns :ok, :unregistered (the subscription is gone, prune it), or
  # :error.  The payload becomes event.data.json() in the service worker.
  def self.send_notification subscription, title:, body:, data: {}
    WebPush.payload_send(
      message: data.merge(title: title, body: body).to_json,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      vapid: {
        subject: ENV['VAPID_SUBJECT'] || 'mailto:hypercheese@example.com',
        public_key: public_key,
        private_key: ENV['VAPID_PRIVATE_KEY'],
      }
    )
    :ok
  rescue WebPush::ExpiredSubscription, WebPush::InvalidSubscription
    :unregistered
  rescue WebPush::ResponseError => e
    Rails.logger.error "Web push send failed: #{e.message}"
    :error
  end
end
