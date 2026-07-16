require "test_helper"

class FilesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @user = users :one
    @password = "password123"
    @user.update! password: @password

    @file_info = {
      path: "/test/file.txt",
      mtime: Time.current.to_f.to_s,
      size: 1024,
      sha256: "a" * 64  # Mock SHA256 hash
    }

    # Stub S3 so uploads don't hit the network.  Bucket is defined by an
    # initializer (config/initializers/s3.rb), so `defined?(Bucket)` is always
    # true and a conditional const_set mock would never install — stub the
    # singleton method instead.
    Bucket.define_singleton_method(:put_object) do |key:, body:, content_type: nil|
      true
    end
  end

  test "authentication flow" do
    # Test authentication
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :success
    response_data = JSON.parse @response.body
    assert response_data["token"].present?
    @token = response_data["token"]

    # Verify device was created
    device = Device.last
    assert_equal @user.id, device.user_id
    assert_equal "Test Device", device.nickname
    assert_equal "Linux", device.os
  end

  test "complete file upload flow" do
    # Step 1: Authenticate
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :success
    response_data = JSON.parse @response.body
    @token = response_data["token"]

    # Step 2: Send manifest
    post "/files/manifest", params: [@file_info].to_json, headers: {
      "CONTENT_TYPE" => "application/json",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "1.0"
    }

    assert_response :success
    manifest_response = JSON.parse @response.body
    assert_equal 1, manifest_response.length
    assert_equal @file_info[:path], manifest_response[0]["path"]

    # Step 3: Send hashes
    post "/files/hashes", params: [@file_info].to_json, headers: {
      "CONTENT_TYPE" => "application/json",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "1.0"
    }

    assert_response :success
    hashes_response = JSON.parse @response.body
    assert_equal 1, hashes_response.length
    assert_equal @file_info[:path], hashes_response[0]["path"]

    # Step 4: Upload file
    content = "test content"
    put "/files/upload", params: content, headers: {
      "CONTENT_TYPE" => "application/octet-stream",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "1.0",
      "X-Path" => @file_info[:path],
      "X-MTime" => @file_info[:mtime],
      "X-SHA256" => Digest::SHA256.hexdigest(content),
      "X-Size" => content.size
    }

    assert_response :success

    # Verify the blob was created
    blob = CheeseBlob.find_by(path: @file_info[:path])
    assert blob.present?
    assert_equal Digest::SHA256.hexdigest(content), blob.sha256
    assert_equal content.size, blob.size
    assert_equal @file_info[:mtime], blob.mtime
  end

  test "invalid authentication" do
    post "/files/auth", params: {
      username: @user.username,
      password: "wrong_password",
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :unauthorized
  end

  test "invalid api version" do
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :success
    response_data = JSON.parse @response.body
    @token = response_data["token"]

    post "/files/manifest", params: [@file_info].to_json, headers: {
      "CONTENT_TYPE" => "application/json",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "2.0"
    }

    assert_response :internal_server_error
  end

  test "size mismatch in upload" do
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :success
    response_data = JSON.parse(@response.body)
    @token = response_data["token"]

    content = "test content"
    put "/files/upload", params: content, headers: {
      "CONTENT_TYPE" => "application/octet-stream",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "1.0",
      "X-Path" => @file_info[:path],
      "X-MTime" => @file_info[:mtime],
      "X-SHA256" => Digest::SHA256.hexdigest(content),
      "X-Size" => content.size + 1  # Intentionally wrong size
    }

    assert_response :bad_request
    assert_match(/\ASize mismatch/, @response.body)
  end

  test "sha256 mismatch in upload" do
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }

    assert_response :success
    response_data = JSON.parse @response.body
    @token = response_data["token"]

    content = "test content"
    put "/files/upload", params: content, headers: {
      "CONTENT_TYPE" => "application/octet-stream",
      "Authorization" => "Bearer #{@token}",
      "X-API-Version" => "1.0",
      "X-Path" => @file_info[:path],
      "X-MTime" => @file_info[:mtime],
      "X-SHA256" => "wrong_hash",
      "X-Size" => content.size
    }

    assert_response :bad_request
    assert_match(/\ASHA256 mismatch/, @response.body)
  end

  test "manifest does not re-request an unchanged file after upload" do
    token = auth_token
    content = "test content"
    file = { path: "photos/IMG_0001.jpg", mtime: "1689123456.789", size: content.size }

    post "/files/manifest", params: [file].to_json, headers: api_headers(token)
    assert_response :success
    assert_equal [file[:path]], JSON.parse(@response.body).map { _1["path"] }

    put "/files/upload", params: content, headers: api_headers(token).merge(
      "CONTENT_TYPE" => "application/octet-stream",
      "X-Path" => file[:path],
      "X-MTime" => file[:mtime],
      "X-SHA256" => Digest::SHA256.hexdigest(content),
      "X-Size" => content.size
    )
    assert_response :success

    # The core promise of the protocol: the client keeps no local state, so an
    # unchanged file must never be asked for (and rehashed) again.
    post "/files/manifest", params: [file].to_json, headers: api_headers(token)
    assert_response :success
    assert_equal [], JSON.parse(@response.body)
  end

  test "hashes matches existing content case-insensitively" do
    token = auth_token
    content = "test content"
    sha = Digest::SHA256.hexdigest content

    put "/files/upload", params: content, headers: api_headers(token).merge(
      "CONTENT_TYPE" => "application/octet-stream",
      "X-Path" => "photos/original.jpg",
      "X-MTime" => "1689123456.789",
      "X-SHA256" => sha,
      "X-Size" => content.size
    )
    assert_response :success

    # Same content under another path, hash sent in uppercase: the server
    # must recognize it and not ask for an upload.
    post "/files/hashes", params: [{
      path: "photos/copy.jpg",
      mtime: "1689999999.5",
      size: content.size,
      sha256: sha.upcase
    }].to_json, headers: api_headers(token)
    assert_response :success
    assert_equal [], JSON.parse(@response.body)
    assert CheeseBlob.exists?(path: "photos/copy.jpg", sha256: sha)
  end

  private

  def auth_token
    post "/files/auth", params: {
      username: @user.username,
      password: @password,
      nickname: "Test Device",
      os: "Linux",
      client_software: "Test Client",
      client_version: "1.0"
    }.to_json, headers: { "CONTENT_TYPE" => "application/json" }
    assert_response :success
    JSON.parse(@response.body)["token"]
  end

  def api_headers token
    {
      "CONTENT_TYPE" => "application/json",
      "Authorization" => "Bearer #{token}",
      "X-API-Version" => "1.0"
    }
  end
end
