# Lets a signed-in browser register its Web Push subscription so the server
# can send it notifications.  Browser-only, so plain Devise session + CSRF
# like the rest of the web app.
class WebPushSubscriptionsController < ApplicationController
  # Register (or reassign) a subscription.  The body is the JSON form of a
  # PushSubscription: { endpoint, keys: { p256dh, auth } }.
  def create
    subscription = WebPushSubscription.find_or_initialize_by endpoint: params.require(:endpoint)
    keys = params.require :keys
    subscription.user = current_user
    subscription.p256dh = keys.require :p256dh
    subscription.auth = keys.require :auth
    subscription.save!
    render json: { ok: true }
  end

  # Called when the user turns notifications off.
  def destroy
    WebPushSubscription.where(user: current_user, endpoint: params.require(:endpoint)).destroy_all
    render json: { ok: true }
  end
end
