{
  description = "HyperCheese — Rails photo organizer + InstaCheese (Expo/React Native) mobile app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true; # Android SDK
            android_sdk.accept_license = true;
          };
        };

        ruby = pkgs.ruby_3_3;

        # Native libraries the Rails gems compile against.
        #   mysql2      -> libmysqlclient (mariadb connector)
        #   rgeo        -> geos
        #   psych/yaml  -> libyaml
        #   various     -> openssl, zlib
        rubyNativeLibs = with pkgs; [
          libmysqlclient
          geos
          libyaml
          openssl
          zlib
        ];

        # Tools invoked at runtime (not just build time).
        #   mini_magick -> imagemagick (`magick`/`convert` on PATH)
        #   RubyInline  -> a C compiler on PATH
        #   Procfile.dev -> foreman/overmind, run via `bin/dev`
        runtimeTools = with pkgs; [
          imagemagick
          gcc
        ];

        # JavaScript toolchain shared by the Rails asset build (esbuild via
        # yarn) and the InstaCheese Expo app (npm).
        jsTools = with pkgs; [
          nodejs_22
          yarn
          watchman # Metro / Expo file watching
        ];

        # For `expo prebuild` / building the Android APK locally, matching the
        # GitHub Action (JDK 17, npm ci, expo prebuild, gradlew assembleRelease).
        # Versions come from react-native's gradle/libs.versions.toml
        # (compileSdk/buildTools 36, NDK 27.1) plus AGP's default CMake 3.22.1.
        androidComposition = pkgs.androidenv.composeAndroidPackages {
          # Third-party RN libraries lag behind core: gesture-handler still
          # pins build-tools 35, so ship both.
          platformVersions = [ "35" "36" ];
          buildToolsVersions = [ "35.0.0" "36.0.0" ];
          ndkVersions = [ "27.1.12297006" ];
          cmakeVersions = [ "3.22.1" ];
          includeNDK = true;
          includeEmulator = false;
          includeSystemImages = false;
        };
        androidSdk = androidComposition.androidsdk;
        androidSdkRoot = "${androidSdk}/libexec/android-sdk";

        mobileTools = [
          pkgs.jdk17
          androidSdk
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            [ ruby pkgs.bundler pkgs.pkg-config ]
            ++ rubyNativeLibs
            ++ runtimeTools
            ++ jsTools
            ++ mobileTools;

          # Help gems with native extensions find headers/libs via pkg-config.
          env = {
            PKG_CONFIG_PATH = pkgs.lib.makeSearchPathOutput "dev" "lib/pkgconfig" rubyNativeLibs;
            # Install gems into the (gitignored) project tree, no sudo needed.
            BUNDLE_PATH = "vendor/bundle";
            JAVA_HOME = "${pkgs.jdk17}";
            ANDROID_HOME = androidSdkRoot;
            ANDROID_SDK_ROOT = androidSdkRoot;
            ANDROID_NDK_ROOT = "${androidSdkRoot}/ndk-bundle";
            # Gradle normally downloads aapt2 from Maven; that binary is linked
            # against FHS paths and won't run on NixOS, so point it at the
            # nix-patched one from the SDK instead. AGP reads this as a project
            # property, hence the org.gradle.project. prefix.
            GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdkRoot}/build-tools/36.0.0/aapt2";
          };

          shellHook = ''
            echo "HyperCheese dev shell"
            echo "  ruby   $(ruby --version | cut -d' ' -f2)   node $(node --version)   yarn $(yarn --version)"
            echo ""
            echo "Rails app:"
            echo "  bundle install && yarn install       # deps"
            echo "  docker compose up -d mariadb minio    # database + object store"
            echo "  bin/rails db:setup                    # first run"
            echo "  bin/dev  (or: foreman start -f Procfile.dev)"
            echo ""
            echo "InstaCheese mobile app (cd instacheese):"
            echo "  npm install"
            echo "  npx expo start        # dev server / QR for Expo Go"
            echo "  npx expo run:android  # native build (SDK/NDK/JDK provided by this shell)"
            echo ""
            echo "The Python face-recognition service (ai/) runs via docker compose."

            # mysql2 needs to be told where the mariadb connector lives.
            bundle config set --local build.mysql2 \
              "--with-mysql-config=${pkgs.libmysqlclient.dev}/bin/mysql_config" >/dev/null 2>&1 || true
          '';
        };
      });
}
