# Pushes a notification to every registered device (except the bullhorner's
# own) when someone bullhorns an item.
class BullhornPushJob < ApplicationJob
  queue_as :default

  def perform bullhorn_id
    return unless Fcm.configured?

    bullhorn = Bullhorn.find_by id: bullhorn_id
    # Un-bullhorned before the job ran
    return unless bullhorn

    actor = bullhorn.user
    noun = bullhorn.item.variety == 'video' ? 'video' : 'photo'
    body = "#{actor.name.presence || actor.username} \u{1F4E2} bullhorned a #{noun}"

    PushToken.where.not(user_id: actor.id).find_each do |push_token|
      result = Fcm.send_notification(
        token: push_token.token,
        title: 'InstaCheese',
        body: body,
        data: { item_id: bullhorn.item_id }
      )
      push_token.destroy if result == :unregistered
    end
  end
end
