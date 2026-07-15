class Bucket
  class << self
    def method_missing name, *args, &block
      @bucket ||= setup_bucket
      @bucket.send name, *args, &block
    end

    private
    def setup_bucket
      require 'aws-sdk-s3'

      s3_config = Rails.application.credentials[:s3] || {}

      access_key_id = s3_config[:access_key_id]
      secret_access_key = s3_config[:secret_access_key]
      bucket_name = s3_config[:bucket]
      endpoint = s3_config[:endpoint]
      region = s3_config[:region] || 'us-east-1'
      force_path_style = s3_config.key?(:force_path_style) ? s3_config[:force_path_style] : true

      if Rails.env.development?
        access_key_id ||= 'minioadmin'
        secret_access_key ||= 'minioadmin'
        bucket_name ||= 'hypercheese'
        endpoint ||= 'http://localhost:9000'
      end

      if Rails.env.production?
        missing = []
        missing << 's3.access_key_id' if access_key_id.blank?
        missing << 's3.secret_access_key' if secret_access_key.blank?
        missing << 's3.bucket' if bucket_name.blank?

        if missing.any?
          raise KeyError, "Missing Rails credentials: #{missing.join(', ')}"
        end
      end

      Aws.config.update({
        region: region,
        credentials: Aws::Credentials.new(access_key_id, secret_access_key),
        endpoint: endpoint,
        force_path_style: force_path_style,
      })

      bucket = Aws::S3::Resource.new.bucket bucket_name

      # Ensure bucket exists in development
      if Rails.env.development?
        bucket.create unless bucket.exists?
      end

      bucket
    end
  end
end
