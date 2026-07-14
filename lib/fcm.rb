require 'googleauth'

# Sends push notifications through Firebase Cloud Messaging's HTTP v1 API.
#
# Configure by placing a Firebase service account key (Firebase console →
# Project settings → Service accounts → Generate new private key) at
# config/fcm-service-account.json, or point FCM_SERVICE_ACCOUNT at the file.
# Without a key everything no-ops, so servers without Firebase are unaffected.
class Fcm
  SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

  def self.key_path
    ENV['FCM_SERVICE_ACCOUNT'] || Rails.root.join('config/fcm-service-account.json').to_s
  end

  def self.configured?
    File.exist? key_path
  end

  # Returns :ok, :unregistered (the device is gone, prune its token), or
  # :error.  Data values are sent as strings, per FCM's requirements.
  def self.send_notification token:, title:, body:, data: {}
    message = {
      token: token,
      notification: { title: title, body: body },
      data: data.transform_values(&:to_s),
      android: { notification: { channel_id: 'default' } },
    }

    res = HTTParty.post "https://fcm.googleapis.com/v1/projects/#{project_id}/messages:send",
      headers: {
        'Authorization' => "Bearer #{access_token}",
        'Content-Type' => 'application/json',
      },
      body: { message: message }.to_json

    return :ok if res.success?

    return :unregistered if res.code == 404 || error_code(res) == 'UNREGISTERED'

    Rails.logger.error "FCM send failed (#{res.code}): #{res.body}"
    :error
  end

  def self.error_code res
    details = res.parsed_response.dig('error', 'details') or return nil
    details.filter_map { |detail| detail['errorCode'] }.first
  rescue StandardError
    nil
  end

  def self.project_id
    @project_id ||= JSON.parse(File.read(key_path))['project_id']
  end

  def self.access_token
    @authorizer ||= Google::Auth::ServiceAccountCredentials.make_creds(
      json_key_io: File.open(key_path),
      scope: SCOPE
    )
    @authorizer.fetch_access_token! if @authorizer.access_token.nil? || @authorizer.expired?
    @authorizer.access_token
  end
end
