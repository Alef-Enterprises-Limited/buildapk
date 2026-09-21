# BuildAPK

BuildAPK compiles one npm-based Expo/React Native Android app per container invocation. It preserves the mounted source, builds a release variant, signs and verifies the APK with your external keystore, and writes an APK, logs, and a JSON result. The container then exits.

Run BuildAPK locally with Docker. Java, Gradle, the Android SDK/NDK, and the build tools run inside the container instead of being installed on your host. No Expo account, EAS Build, Android Studio, emulator, or host Android SDK is required.

Local builds are the main workflow. GitHub Actions packages the engine for optional distribution through GHCR; you can also build the image yourself. A VPS, domain, or HTTP API is not required. Remote hosting and an API remain possible future extensions, not requirements for using this tool.

## Supported baseline and status

Implementation includes the build pipeline, CLI, Compose configuration, tests, and GHCR workflow. See the verification record below for actual checks performed. A passing unit test is not proof of an APK build or device launch.

Input must be a **single npm project** with a version 2 or 3 `package-lock.json` resolving the exact core packages below. Additional native dependencies must fit the toolchain. Workspaces, linked local dependencies, other package managers, product flavors, multiple app modules, APK splits, and symlinks in submitted source are unsupported.

| Component | Pin |
| --- | --- |
| Container platform | `linux/amd64` |
| Base | Ubuntu 22.04, `eclipse-temurin:17.0.18_8-jdk-jammy`, digest pinned in Dockerfile |
| Java | Temurin JDK `17.0.18+8` |
| Node / npm | `22.23.2` / `10.9.8` |
| Android command-line tools | Build `13114758`, version `19.0`, SHA-256 pinned |
| Android platform / build tools | API `36`, package revision `2` / app `36.0.0`, library modules `35.0.0` |
| Android platform-tools | `37.0.1`, versioned download and SHA-256 pinned |
| NDK / CMake | `27.1.12297006` / `3.22.1` |
| Expo / React Native / React | `54.0.37` / `0.81.5` / `19.1.0` |
| Expo native template | `expo-template-bare-minimum@54.0.53`, checksum pinned |
| Gradle wrapper / Android Gradle Plugin | `8.14.3` / `8.11.0` |
| Fixture APK ABI / minimum Android | `arm64-v8a` / Android 7 (API 24) |

The fixture explicitly selects arm64 in its Expo configuration. The engine does not override another app's ABI selection. Actual APK ABIs appear in `result.json`. Container architecture and APK ABIs are separate. Existing native projects must fit this baseline; an Expo native-path test does not establish arbitrary bare React Native compatibility.

Pins are recorded in `toolchain.json`. SDK/NDK/CMake are installed in the image; npm, Gradle, and Maven retrieval still need network access. Caches do not guarantee offline builds. OS packages receive repository patches when rebuilding; this is not a bit-for-bit reproducibility claim. The downloaded Expo template is checksum-verified, then repacked without its public debug keystore or unused iOS files; the image ships no app signing key.

## Quick start

Install Docker with Linux-container support. Windows users can use Docker Desktop with WSL 2. From this repository, build the image and check its toolchain (the commands work in PowerShell and POSIX shells):

```sh
docker build --platform linux/amd64 -t buildapk:local .
docker run --rm buildapk:local doctor
```

Then follow [Your application and signing setup](#your-application-and-signing-setup) to build your app. Host Node.js is not required for normal Docker builds.

### Optional contributor checks and sample builds

With Node.js 22.13+ installed on the host, run:

```sh
npm ci --ignore-scripts
npm test
npm run smoke
```

The smoke driver generates a temporary test key **outside the image build context**, builds the read-only fixture through Expo and native paths, checks signatures, hashes, JS bundle inclusion, source preservation, mount permissions, and missing-signing failure metadata. It removes its keys and temporary native volume, retaining `output/smoke-<id>/` and the `buildapk-smoke-cache` volume. These disposable keys are never appropriate for real app releases. Set `BUILDAPK_TEST_IMAGE` to test another image.

Building the image accepts the [Android SDK license terms](https://developer.android.com/studio#downloads) through `sdkmanager --licenses`. Those tools retain their own terms; see [License](#license) for BuildAPK's license.

### Local storage and resources

The image holds the engine and toolchain. Each build runs in a disposable container; Compose keeps npm and Gradle downloads in a named cache volume. Your source and signing files stay in host folders, and APKs, logs, and results are written to `output/` by default. The `--rm` option removes the finished container while retaining the cache and outputs.

Docker Desktop manages image and named-volume storage. On Windows with WSL 2, you can relocate it through **Settings > Resources > Advanced > Disk image location**, for example to a larger D: drive. This does not move your repository or bind-mounted source, output, and signing folders. No project configuration changes are needed when only Docker's internal storage location changes.

Toolchains, Docker layers, Gradle caches, and native intermediates require substantial disk and memory. Run one build at a time and leave memory for your other applications, Node, Kotlin, native compilers, and the OS. Docker CPU/memory limits are separate from Java heap settings. The measurements below describe the tested fixture, not universal requirements for every app.

## Your application and signing setup

Create `output/` and `secrets/`, copy `.env.example` to `.env`, and set `BUILDAPK_SOURCE` to your app directory. Supply `secrets/release.jks`, `secrets/store-password`, and `secrets/key-password`; each password file contains one nonempty line. Set the correct key alias in `.env`. Keep secure backups of your release key and passwords.

PowerShell:

```powershell
New-Item -ItemType Directory -Force output,secrets
Copy-Item .env.example .env
# Supply signing files and edit .env before continuing.
docker compose run --rm builder doctor --mounts
docker compose run --rm builder build
```

POSIX shell:

```sh
mkdir -p output secrets
cp .env.example .env
# Supply signing files and edit .env before continuing.
docker compose run --rm --user 0 --entrypoint sh builder -c 'chown 10001:10001 /output /cache'
sudo chgrp 10001 secrets secrets/*
chmod 750 secrets
chmod 640 secrets/*
docker compose run --rm builder doctor --mounts
docker compose run --rm builder build
```

The image runs as UID/GID `10001:10001`. Named cache volumes inherit writable ownership. POSIX output mounts must be writable and source/signing files readable by that user. The root override is only for volume initialization. Docker Desktop normally provides bind-mount access via file sharing; check drive sharing and Windows folder permissions if denied. Do not use blanket `chmod 777`.

Compose publishes no port and has no restart policy. `.env` configures Compose; it does not automatically forward arbitrary app variables. Pass app configuration explicitly, for example `docker compose run --rm -e EXPO_PUBLIC_API_URL=https://example.org builder build`.

### Direct Docker mounts

POSIX, after preparing output permissions and signing files:

```sh
docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$(pwd)/fixtures/expo-minimal,target=/input,readonly" \
  --mount "type=bind,source=$(pwd)/output,target=/output" \
  --mount "type=bind,source=$(pwd)/secrets,target=/secrets,readonly" \
  --mount type=volume,source=buildapk-cache,target=/cache \
  -e BUILDAPK_KEYSTORE_PATH=/secrets/release.jks \
  -e BUILDAPK_KEY_ALIAS=release \
  -e BUILDAPK_STORE_PASSWORD_FILE=/secrets/store-password \
  -e BUILDAPK_KEY_PASSWORD_FILE=/secrets/key-password \
  buildapk:local build
```

PowerShell (backticks must be the final character on their lines):

```powershell
$projectRoot = (Get-Location).Path
docker run --rm --platform linux/amd64 `
  --mount "type=bind,source=$projectRoot/fixtures/expo-minimal,target=/input,readonly" `
  --mount "type=bind,source=$projectRoot/output,target=/output" `
  --mount "type=bind,source=$projectRoot/secrets,target=/secrets,readonly" `
  --mount type=volume,source=buildapk-cache,target=/cache `
  -e BUILDAPK_KEYSTORE_PATH=/secrets/release.jks `
  -e BUILDAPK_KEY_ALIAS=release `
  -e BUILDAPK_STORE_PASSWORD_FILE=/secrets/store-password `
  -e BUILDAPK_KEY_PASSWORD_FILE=/secrets/key-password `
  buildapk:local build
```

Replace the fixture mount with your app. Quoted arguments support spaces. If a raw Docker named cache needs initialization: `docker run --rm --user 0 --mount type=volume,source=buildapk-cache,target=/cache --entrypoint chown buildapk:local 10001:10001 /cache`.

## CLI and build contract

```text
buildapk --help
buildapk --version
buildapk doctor [--mounts]
buildapk build --source /input --output /output --cache /cache --work /work --mode auto
```

All four path flags also apply to `doctor --mounts`. Paths must exist and be separate, non-nested directories. `doctor` checks installed tools and SDK files without source/signing mounts. `doctor --mounts` additionally checks permissions and signing-file accessibility, but does not compile or validate passwords against the key.

| Path | Purpose |
| --- | --- |
| `/input` | Read-only project source |
| `/output` | Persistent, uniquely identified job directories |
| `/cache` | Persistent npm and Gradle caches |
| `/secrets` | Read-only keystore and password files |
| `/work` | Disposable working copy, cleaned at completion/failure |

`auto` uses an existing valid Android project or generates one for supported Expo input. `native` requires existing Android source and never prebuilds it. `expo` requires no existing `android/` directory, preventing accidental loss of native customizations. Plain React Native without Android source fails.

The working copy excludes Git history, node_modules, old APK/AAB files, native build outputs/caches, local.properties, `.env*`, `.npmrc`, standard private-key files, and `secrets/`. App sources, assets, lockfile, and native source are preserved. Dependencies install with `npm ci --include=dev`; Expo runs from the app's installed CLI with the pinned template and `--no-install`. Changed dependency requirements or lockfiles fail with reconciliation instructions. There is no silent npm-install or fetched-CLI fallback.

Provide build-time configuration explicitly via runtime environment variables. `EXPO_PUBLIC_*` values can be embedded in APKs and must not contain private credentials. npm scripts, Expo plugins, and Gradle execute application code: BuildAPK supports trusted projects, not a hostile multi-tenant sandbox. They share the container's mounts. Builder configuration is removed from child environments; signing passwords are redacted from logs. Do not print unrelated app secrets.

An init script disables release signing in the disposable Gradle build and rejects unsupported variants/toolchain settings. The engine builds `:app:assembleRelease` with the project's wrapper, aligns for 16 KB native-library pages, signs with password-file inputs, verifies the certificate against the requested keystore, checks alignment and non-debuggable status, and confirms `assets/index.android.bundle` exists. Only then is the APK published. Package ID, version code, and ABI selection remain app-controlled.

| Runtime variable | Default / meaning |
| --- | --- |
| `BUILDAPK_KEYSTORE_PATH` | Required keystore path |
| `BUILDAPK_KEY_ALIAS` | Required alias |
| `BUILDAPK_STORE_PASSWORD_FILE` | Required store-password file |
| `BUILDAPK_KEY_PASSWORD_FILE` | Required key-password file |
| `BUILDAPK_TIMEOUT_SECONDS` | `3600`, whole job timeout, 1–86400 seconds |
| `BUILDAPK_GRADLE_WORKERS` | `2`, 1–32 workers; also bounds Metro workers |
| `BUILDAPK_GRADLE_HEAP_MB` | `2048`, 256–65536 MiB; metaspace separately capped at 512 MiB |

Missing signing inputs fail; no debug-key fallback exists. Updates need the same appropriate signing identity and increasing version code. Never commit real signing material or bake it into the image. Fixture debug keys are not used for final APK signing.

SIGINT/SIGTERM and timeouts cancel subprocess groups, preserve failure information, clean work, and exit nonzero. Allow cleanup with `docker stop --time 15 CONTAINER`. SIGKILL/host failure may leave `running` metadata and temporary work; full or unavailable output storage can also prevent a final metadata write. There is no restart recovery. Run one job per container invocation, not concurrent calls inside one container.

## Results and cleanup

```text
output/<build-id>/
  app-release.apk   # verified successes only
  build.log
  result.json
```

Metadata is replaced atomically at each stage. This is an **illustrative example**, not an actual result; `toolchain` contains all fields from toolchain.json, abbreviated here:

```json
{
  "schemaVersion": 1,
  "buildId": "2026-09-21T00-00-00-000Z-example-uuid",
  "engineVersion": "0.1.0",
  "status": "succeeded",
  "stage": "complete",
  "startedAt": "2026-09-21T00:00:00.000Z",
  "finishedAt": "2026-09-21T00:10:00.000Z",
  "durationMs": 600000,
  "mode": "expo",
  "toolchain": { "id": "expo54-rn081-node22-android36-v1" },
  "artifact": { "path": "app-release.apk", "bytes": 12345678, "sha256": "<64 hex characters>", "abis": ["arm64-v8a"] },
  "signingCertificateSha256": "<64 hex characters>",
  "error": null
}
```

Statuses: running, succeeded, failed, cancelled. Stages: validate, copy, dependencies, native, compile, sign, verify, publish, complete. Failures have null artifact/certificate fields and `error: { "stage": "...", "message": "...", "childExitCode": 1 }`; code is null if unavailable. Cleanup failures use error stage `cleanup`. CLI exit codes: 0 success, 1 failure, 130 cancellation/timeout. Errors preventing job-directory creation appear on the terminal without metadata.

Logs stream to disk and terminal. Small diagnostic responses have a 1 MiB capture cap. Old job outputs are never automatically deleted. Remove selected old job folders manually. `docker compose down --volumes` clears that Compose project's cache; `docker volume rm buildapk-smoke-cache` clears the unused smoke cache. Keep signing backups separate from cleanup.

## Optional image publishing and pulling

The workflow runs lightweight checks on pushes/PRs. PRs, default-branch pushes, release tags, and manual dispatch build the image and run real fixture smoke tests. Publication requires those checks to pass:

- Default branch: `sha-<full-commit-sha>` and `edge`.
- `vMAJOR.MINOR.PATCH` matching package.json: commit tag and `MAJOR.MINOR.PATCH`.
- Manual dispatch follows those rules on the default branch or a release tag; arbitrary branches validate without publishing.

The lowercase image identity is derived from the repository; here it is `ghcr.io/alef-enterprises-limited/buildapk`. The workflow uses scoped GITHUB_TOKEN permissions, pinned action SHAs, and build-layer caching. It contains no production keys, VPS credentials, or SSH deployment. Fixture apps and smoke keys stay outside publishable image layers.

After the first publication, set the **GHCR package visibility to Public** in its package settings. A public repository alone does not make its package public. Public images allow users to pull without registry credentials. Publishing is optional for local builds.

After a 0.1.0 release exists:

```sh
docker pull ghcr.io/alef-enterprises-limited/buildapk:0.1.0
```

Set `BUILDAPK_IMAGE=ghcr.io/alef-enterprises-limited/buildapk:0.1.0` in your local `.env`, configure paths/permissions, then use the same Compose doctor/build commands. Do not add `--build` when using a published image. Prefer version tags or `ghcr.io/alef-enterprises-limited/buildapk@sha256:<published-digest>` over moving `edge` for repeatable image selection. Keep `BUILDAPK_IMAGE=buildapk:local` to use your locally built image.

## Troubleshooting and physical-device acceptance

| Failure | Check |
| --- | --- |
| Java/SDK/NDK/Gradle mismatch | Run doctor; use the pinned image and supported baseline. |
| Missing/inconsistent lockfile | Reconcile in the source app, run npm install there, commit its lockfile, and retry. |
| Prebuild changes dependencies | Prebuild/reconcile/relock in the source app, then submit Android source in native mode. |
| Dependency retrieval failure | Read build.log; check network/DNS, package availability, and cache permissions. |
| Signing failure | Check four signing variables, readable files, alias, and passwords. No APK is accepted on failure. |
| Out of disk | Check host and Docker storage; remove identified old outputs/caches only. |
| Exit 137 / lost Gradle daemon | Check memory pressure, worker count, Docker limits, and JVM heap together. |
| Permission denied | Check UID/GID 10001 access, bind mounts, and Docker Desktop file sharing. |
| Missing/multiple APKs | Use standard :app release without flavors/splits; stale outputs are excluded. |
| C/C++ hard-link warning | Cache and work can be on different filesystems; Gradle copies the library instead. This is not a failed build. |

Final functional acceptance needs a physical **arm64 Android 7+** device. You can copy `output/<build-id>/app-release.apk` to your phone and install it using the phone's file manager, allowing installation from that source when prompted. This requires no Android tools on your computer.

Alternatively, if you already use host Android platform-tools, enable USB debugging, approve the host, and substitute the actual APK path:

```sh
adb devices
adb install -r output/<build-id>/app-release.apk
adb reverse --remove-all
adb shell am force-stop tech.adsvps.buildapk.smoke
adb shell monkey -p tech.adsvps.buildapk.smoke -c android.intent.category.LAUNCHER 1
```

Stop Metro (the development server started by commands such as `npx expo start`) with Ctrl+C if it is running, and disconnect the phone from the development computer. The app must display **BuildAPK works** without a development server. An old smoke app may need uninstalling because each smoke run uses a new signing key; uninstalling removes its data. Signature and bundled-JS checks are not equivalent to a successful device launch.

## Verification record

- Host: Windows, Node 24.13.0, npm 11.6.2, Docker Desktop engine 29.3.0; container VM reports 12 CPUs and about 7.65 GiB RAM.
- Verified on 2026-09-21: all 14 Node tests passed inside Linux; 13 passed on Windows with the Linux-only process-group test skipped. Compose configuration, JavaScript syntax, Git whitespace checks, and GitHub Actions configuration passed (actionlint 1.7.12).
- Fixture installation and native prebuild succeeded without dependency changes. Inspected native configuration confirms the SDK/NDK/Gradle/AGP pins and arm64 ABI above.
- Android command-line tools and platform-tools download SHA-256 values were independently checked against the Dockerfile pins.
- The final image built successfully and doctor passed, including mounted source/output/cache/signing permissions under UID 10001. Both Expo generation and existing-native builds produced signed, non-debuggable arm64 APKs with verified certificates, alignment, hashes, and bundled JavaScript. Source/lockfile preservation, native-source preservation, secret-safe logs, and missing-signing failure metadata passed the automated smoke driver. Earlier real compilation failure also produced nonzero exit and failure metadata without publishing an APK.
- Each final APK was 20,366,216 bytes. Final warm-cache job durations were 81.7 seconds (Expo) and 79.8 seconds (native). An earlier successful build took 653 seconds after an initial failed run had already populated some caches; this is not a clean cold-build benchmark. Sampled container memory reached about 3.1 GiB during testing, not a continuously measured peak or a recommended memory limit.
- Docker reported final image size `.Size = 1,317,171,815` bytes (about 1.32 GB); this is not total required disk space. Unpacked SDK files, Docker build layers, caches, and temporary compilation files consume additional space. Each smoke run writes exact results and the tested image ID to `output/smoke-<id>/verification.json`.
- Physical-device launch and GHCR publication have not been verified in this record.

## License

BuildAPK's original source code is free and open source under the [MIT License](LICENSE), copyright 2026 Alef Enterprises Limited. You may use, modify, and redistribute it, including commercially, subject to retaining the license notice. It is provided without warranty. See the [OSI MIT license reference](https://opensource.org/license/mit).

Bundled third-party tools and dependencies, including the Android SDK, retain their respective licenses and terms. BuildAPK's license does not change the license of applications you build. The package's `private` flag prevents accidental npm publication; it does not restrict the MIT license or public Docker image distribution.

Primary references: [Expo SDK 54](https://docs.expo.dev/versions/v54.0.0/), [native generation](https://docs.expo.dev/workflow/continuous-native-generation/), [React Native setup](https://reactnative.dev/docs/0.81/set-up-your-environment), [Node releases](https://nodejs.org/en/about/previous-releases), [apksigner](https://developer.android.com/tools/apksigner), [zipalign](https://developer.android.com/tools/zipalign), [Docker test-before-push](https://docs.docker.com/build/ci/github-actions/test-before-push/), [GitHub publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
