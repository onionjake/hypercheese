# Pushes a notification to every registered device and browser (except the
# bullhorner's own) when someone bullhorns an item.
class BullhornPushJob < ApplicationJob
  queue_as :default

  def perform bullhorn_id
    return unless Fcm.configured? || WebPushSender.configured?

    bullhorn = Bullhorn.find_by id: bullhorn_id
    # Un-bullhorned before the job ran
    return unless bullhorn

    actor = bullhorn.user
    noun = bullhorn.item.variety == 'video' ? 'video' : 'photo'
    title = 'InstaCheese'
    body = "#{actor.name.presence || actor.username} \u{1F4E2} bullhorned a #{noun}"

    if Fcm.configured?
      PushToken.where.not(user_id: actor.id).find_each do |push_token|
        result = Fcm.send_notification(
          token: push_token.token,
          title: title,
          body: body,
          data: { item_id: bullhorn.item_id }
        )
        push_token.destroy if result == :unregistered
      end
    end

    if WebPushSender.configured?
      WebPushSubscription.where.not(user_id: actor.id).find_each do |subscription|
        result = WebPushSender.send_notification(
          subscription,
          title: title,
          body: body,
          data: { url: "/items/#{bullhorn.item_id}" }
        )
        subscription.destroy if result == :unregistered
      end
    end
  end
end
