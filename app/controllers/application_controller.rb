class ApplicationController < ActionController::Base
  protect_from_forgery
  before_action :configure_permitted_parameters, if: :devise_controller?
  before_action :authenticate_user_from_token!
  before_action :authenticate_user!
  before_action :verify_approval!

  # Native clients (e.g. the InstaCheese mobile app) authenticate with the
  # same device JWT issued by /files/auth instead of a session cookie.
  def authenticate_user_from_token!
    return if user_signed_in?
    user, _device = api_token_credentials
    return unless user
    request.env['devise.skip_trackable'] = true
    sign_in user, store: false
  end

  def api_token_credentials
    return @api_token_credentials if defined? @api_token_credentials
    @api_token_credentials = nil
    token = request.headers['Authorization']&.split(' ')&.last
    return nil unless token
    begin
      payload = JWT.decode(token, Rails.application.credentials.secret_key_base).first
      user = User.find_by id: payload['user_id']
      device = Device.find_by uuid: payload['device']
      if user && device && device.user_id == user.id
        @api_token_credentials = [user, device]
      end
    rescue JWT::DecodeError
    end
    @api_token_credentials
  end

  # Token-authenticated requests carry no session, so CSRF does not apply.
  def verified_request?
    super || api_token_credentials.present?
  end

  def verify_approval!
    raise "Attempting to verify before authenticated" unless current_user
    return if current_user.approved?
    redirect_to "/users/pending"
  end

  def handle_unverified_request
    raise "CSRF Failure"
  end

  protected

  include ActionController::Streaming
  include Zipline

  def download_zip items
    if items.size == 1
      return send_file items.first.full_path
    end

    files = items.lazy.map do |item|
      path = File.realpath item.full_path
      [File.open(path, 'rb'), File.basename(item.full_path)]
    end

    zipline files, "#{files.size}-from-hypercheese.zip"
  end

  def convert_to_jpeg item
    path = File.realpath item.full_path
    if path =~ /\.(jpg|jpeg)$/i
      [File.open(path, 'rb'), File.basename(item.full_path)]
    else
      image = MiniMagick::Image.open path
      temp = Tempfile.new ['hypercheese-convert', '.jpg']
      image.format 'jpg'
      image.write temp.path
      fh = File.open temp.path, 'rb'
      [fh, File.basename(item.full_path) + ".JPG"]
    end
  end

  def convert_to_jpeg_and_zip items
    if items.size == 1
      res = convert_to_jpeg items.first
      return send_file res.first
    end

    files = items.lazy.map do |item|
      convert_to_jpeg item
    end

    zipline files, "#{files.size}-converted-from-hypercheese.zip"
  end

  def configure_permitted_parameters
    devise_parameter_sanitizer.permit(:sign_up) do |u|
      u.permit :username, :email, :password, :password_confirmation, :remember_me
    end
    devise_parameter_sanitizer.permit(:sign_in) do |u|
      u.permit :login, :username, :email, :password, :remember_me
    end
    devise_parameter_sanitizer.permit(:account_update) do |u|
      u.permit :username, :email, :password, :password_confirmation, :current_password
    end
  end

  def require_write!
    raise "No write permissions" unless current_user.can_write?
  end
end
