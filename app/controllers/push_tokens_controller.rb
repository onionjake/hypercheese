# Lets a signed-in device register its FCM registration token so the server
# can send it push notifications.  Works with either a browser-style Devise
# session (with CSRF token, like the web app) or a device JWT from
# /files/auth sent as an Authorization Bearer header.
class PushTokensController < ApplicationController
  skip_before_action :authenticate_user!
  skip_before_action :verify_approval!
  skip_before_action :verify_authenticity_token, if: :bearer_token
  before_action :authenticate_api_user!

  # Register (or refresh) the calling device's token.  A token that moves
  # between accounts is reassigned to the new account.
  def create
    push_token = PushToken.find_or_initialize_by token: params.require(:token)
    push_token.user = @api_user
    push_token.platform = params[:platform] if params[:platform]
    push_token.save!
    render json: { ok: true }
  end

  # Called on sign-out so the device stops receiving notifications.
  def destroy
    PushToken.where(user: @api_user, token: params.require(:token)).destroy_all
    render json: { ok: true }
  end

  private

  def bearer_token
    request.headers['Authorization']&.match(/\ABearer (.+)\z/)&.captures&.first
  end

  def authenticate_api_user!
    if (token = bearer_token)
      payload = JWT.decode(token, Rails.application.credentials.secret_key_base).first rescue nil
      @api_user = User.find_by id: payload['user_id'] if payload
      head :unauthorized unless @api_user&.approved?
    else
      authenticate_user!
      verify_approval!
      @api_user = current_user
    end
  end
end
