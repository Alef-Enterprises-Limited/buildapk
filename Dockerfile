FROM eclipse-temurin:17.0.18_8-jdk-jammy@sha256:978ed38b7785312f7761bee5e24cfcd7ac2fe466c5f07acee7b322e0bae6d0ec

ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip zip xz-utils tini libatomic1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fSL --retry 3 https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && echo 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307  /tmp/node.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=/opt/android-sdk/cmdline-tools/19.0/bin:/opt/android-sdk/build-tools/36.0.0:/opt/android-sdk/cmake/3.22.1/bin:$PATH
RUN mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fSL --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o /tmp/android.zip \
    && echo '7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee  /tmp/android.zip' | sha256sum -c - \
    && unzip -q /tmp/android.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/19.0 \
    && rm /tmp/android.zip
# Building this image accepts Android SDK licenses. See README and Google's terms.
RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'ndk;27.1.12297006' 'cmake;3.22.1' \
    && rm -rf /root/.android /opt/android-sdk/.temp

# AGP's library-module default still requires 35.0.0 alongside the app's 36.0.0.
RUN sdkmanager 'build-tools;35.0.0' && rm -rf /root/.android /opt/android-sdk/.temp

RUN curl -fSL --retry 3 https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip -o /tmp/platform-tools.zip \
    && echo 'd230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1  /tmp/platform-tools.zip' | sha256sum -c - \
    && unzip -q /tmp/platform-tools.zip -d /opt/android-sdk \
    && rm /tmp/platform-tools.zip \
    && sdkmanager --list_installed >/dev/null
ENV PATH=/opt/android-sdk/platform-tools:$PATH

WORKDIR /opt/buildapk
RUN curl -fSL --retry 3 https://registry.npmjs.org/expo-template-bare-minimum/-/expo-template-bare-minimum-54.0.53.tgz -o expo-template.tgz \
    && echo '1bdebb18e813a5e7b526a38350b1ba15d99d313b6e22c42b049db4d9ae97d3d8  expo-template.tgz' | sha256sum -c - \
    && mkdir /tmp/expo-template \
    && tar -xzf expo-template.tgz -C /tmp/expo-template \
    && rm -f /tmp/expo-template/package/android/app/debug.keystore \
    && rm -rf /tmp/expo-template/package/ios \
    && tar -czf expo-template.tgz -C /tmp/expo-template package \
    && rm -rf /tmp/expo-template
COPY package.json package-lock.json toolchain.json ./
COPY src/ ./src/
COPY scripts/release.gradle ./scripts/release.gradle
RUN groupadd --gid 10001 builder && useradd --uid 10001 --gid 10001 --create-home builder \
    && mkdir -p /input /output /cache /secrets /work \
    && chown builder:builder /output /cache /work

ARG VERSION=0.1.0
ARG SOURCE=https://github.com/Alef-Enterprises-Limited/buildapk
ARG REVISION=local
LABEL org.opencontainers.image.title="BuildAPK" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source=$SOURCE \
      org.opencontainers.image.revision=$REVISION
ENV HOME=/home/builder CI=1 EXPO_NO_TELEMETRY=1
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/buildapk/src/cli.mjs"]
CMD ["--help"]
