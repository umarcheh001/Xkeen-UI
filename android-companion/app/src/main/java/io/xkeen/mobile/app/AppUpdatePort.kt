package io.xkeen.mobile.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal const val GITHUB_MOBILE_REPOSITORY = "umarcheh001/Xkeen-UI"
internal const val GITHUB_MOBILE_RELEASES_URL =
    "https://api.github.com/repos/$GITHUB_MOBILE_REPOSITORY/releases?per_page=100"
internal const val GITHUB_MOBILE_REPOSITORY_URL =
    "https://github.com/$GITHUB_MOBILE_REPOSITORY"
private const val UPDATE_CONNECT_TIMEOUT_MILLIS = 12_000
private const val UPDATE_READ_TIMEOUT_MILLIS = 45_000
private const val MAX_RELEASES_RESPONSE_BYTES = 5_000_000L
private const val MAX_APK_BYTES = 250L * 1024L * 1024L
private const val MAX_UPDATE_REDIRECTS = 5
private const val PROGRESS_REPORT_BYTES = 256L * 1024L

internal sealed interface AppUpdateCheckResult {
    data object UpToDate : AppUpdateCheckResult

    data class Available(val release: AppUpdateRelease) : AppUpdateCheckResult

    data class Unavailable(val message: String) : AppUpdateCheckResult
}

internal data class AppUpdateDownload(
    val file: File,
    val release: AppUpdateRelease,
    val sha256: String,
)

internal enum class AppUpdateInstallResult {
    Started,
    PermissionRequired,
    Failed,
}

internal interface AppUpdatePort {
    suspend fun check(currentVersion: String): AppUpdateCheckResult

    suspend fun download(
        release: AppUpdateRelease,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): AppUpdateDownload

    fun install(download: AppUpdateDownload): AppUpdateInstallResult
}

/** Used by JVM controller tests and previews where no Android Context is available. */
internal class InMemoryAppUpdatePort : AppUpdatePort {
    override suspend fun check(currentVersion: String): AppUpdateCheckResult =
        AppUpdateCheckResult.UpToDate

    override suspend fun download(
        release: AppUpdateRelease,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): AppUpdateDownload = error("Обновление недоступно в демонстрационном окружении")

    override fun install(download: AppUpdateDownload): AppUpdateInstallResult =
        AppUpdateInstallResult.Failed
}

/** Public GitHub Releases implementation. No Xkeen session or router credentials are involved. */
internal class GitHubAppUpdatePort(
    context: Context,
    private val releasesUrl: String = GITHUB_MOBILE_RELEASES_URL,
) : AppUpdatePort {
    private val appContext = context.applicationContext

    override suspend fun check(currentVersion: String): AppUpdateCheckResult = withContext(Dispatchers.IO) {
        try {
            val response = fetchText(releasesUrl, MAX_RELEASES_RESPONSE_BYTES)
            parseLatestCompatibleRelease(response, currentVersion)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            AppUpdateCheckResult.Unavailable(
                error.message?.takeIf(String::isNotBlank) ?: "Не удалось проверить GitHub Releases",
            )
        }
    }

    override suspend fun download(
        release: AppUpdateRelease,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit,
    ): AppUpdateDownload = withContext(Dispatchers.IO) {
        requireAllowedGitHubUrl(release.apkUrl, "APK")
        val checksumUrl = release.checksumUrl
            ?: throw IOException("В релизе отсутствует SHA-256 для APK")
        requireAllowedGitHubUrl(checksumUrl, "контрольной суммы")

        val updatesDir = File(appContext.cacheDir, "updates").apply { mkdirs() }
        if (!updatesDir.isDirectory) throw IOException("Не удалось создать кэш обновлений")
        val safeVersion = release.version.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val target = File(updatesDir, "xkeen-mobile-$safeVersion.apk")
        val temporary = File(updatesDir, ".${target.name}.part")
        temporary.delete()
        target.delete()

        val connection = openGitHubConnection(
            urlValue = release.apkUrl,
            accept = "application/octet-stream",
            userAgent = "Xkeen-Mobile/${currentBuildVersion()}",
        )
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("GitHub не отдал APK (HTTP $code)")
            val expectedLength = connection.contentLengthLong.takeIf { it > 0 } ?: release.apkSizeBytes
            if (expectedLength > MAX_APK_BYTES) throw IOException("Размер APK превышает лимит 250 МБ")

            val digest = MessageDigest.getInstance("SHA-256")
            var downloaded = 0L
            var lastReportedBytes = 0L
            var lastReportedPercent = -1
            connection.inputStream.use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        downloaded += count
                        if (downloaded > MAX_APK_BYTES) {
                            throw IOException("Размер APK превышает лимит 250 МБ")
                        }
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        val percent = if (expectedLength > 0) {
                            ((downloaded * 100L) / expectedLength).toInt().coerceIn(0, 100)
                        } else {
                            -1
                        }
                        if (percent > lastReportedPercent ||
                            downloaded - lastReportedBytes >= PROGRESS_REPORT_BYTES
                        ) {
                            onProgress(downloaded, expectedLength)
                            lastReportedBytes = downloaded
                            lastReportedPercent = percent
                        }
                    }
                }
            }
            if (downloaded == 0L) throw IOException("GitHub вернул пустой APK")
            if (release.apkSizeBytes > 0 && downloaded != release.apkSizeBytes) {
                throw IOException("Размер загруженного APK не совпадает с данными релиза")
            }
            if (downloaded != lastReportedBytes) onProgress(downloaded, expectedLength)
            val actualSha256 = digest.digest().toHexString()
            val expectedSha256 = Regex("(?i)\\b[0-9a-f]{64}\\b")
                .find(fetchText(checksumUrl, 8_192L))
                ?.value
                ?.lowercase(Locale.ROOT)
                ?: throw IOException("Не удалось прочитать SHA-256 обновления")
            if (actualSha256 != expectedSha256) {
                throw IOException("SHA-256 загруженного APK не совпадает с релизом")
            }
            if (!temporary.renameTo(target)) throw IOException("Не удалось подготовить APK к установке")
            verifyDownloadedApk(target, release)
            AppUpdateDownload(target, release, actualSha256)
        } catch (error: Throwable) {
            temporary.delete()
            target.delete()
            throw error
        } finally {
            connection.disconnect()
        }
    }

    override fun install(download: AppUpdateDownload): AppUpdateInstallResult {
        if (!download.file.isFile || download.file.length() == 0L) return AppUpdateInstallResult.Failed
        return runCatching {
            verifyDownloadedApk(download.file, download.release)
            if (!appContext.packageManager.canRequestPackageInstalls()) {
                appContext.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        "package:${appContext.packageName}".toUri(),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                return@runCatching AppUpdateInstallResult.PermissionRequired
            }
            val uri = FileProvider.getUriForFile(
                appContext,
                "${appContext.packageName}.fileprovider",
                download.file,
            )
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            appContext.startActivity(installIntent)
            AppUpdateInstallResult.Started
        }.getOrDefault(AppUpdateInstallResult.Failed)
    }

    private fun currentBuildVersion(): String =
        appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName.orEmpty()

    @Suppress("DEPRECATION")
    private fun verifyDownloadedApk(file: File, release: AppUpdateRelease) {
        val packageManager = appContext.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val archive = packageManager.getPackageArchiveInfo(file.absolutePath, flags)
            ?: throw IOException("Загруженный файл не является корректным APK")
        val installed = packageManager.getPackageInfo(appContext.packageName, flags)
        if (archive.packageName != appContext.packageName) {
            throw IOException("APK из релиза предназначен для другого приложения")
        }
        if (archive.longVersionCode <= installed.longVersionCode) {
            throw IOException("versionCode обновления должен быть больше установленного")
        }
        val archiveVersion = archive.versionName?.let(::normalizeMobileVersion)
        if (archiveVersion == null || compareMobileVersions(archiveVersion, release.version) != 0) {
            throw IOException("Версия внутри APK не совпадает с данными релиза")
        }
        val installedSigners = installed.signingInfo?.apkContentsSigners.orEmpty()
        val archiveHistory = archive.signingInfo?.signingCertificateHistory.orEmpty()
        if (installedSigners.isEmpty() || archiveHistory.isEmpty() ||
            installedSigners.any { installedSigner ->
                archiveHistory.none { archiveSigner ->
                    installedSigner.toByteArray().contentEquals(archiveSigner.toByteArray())
                }
            }
        ) {
            throw IOException("APK подписан не тем ключом, что установленное приложение")
        }
    }
}

internal fun parseLatestCompatibleRelease(
    response: String,
    currentVersion: String,
): AppUpdateCheckResult {
    if (normalizeMobileVersion(currentVersion) == null) {
        return AppUpdateCheckResult.Unavailable("Не удалось определить установленную версию приложения")
    }
    val releases = JSONArray(response)
    val compatibleReleases = mutableListOf<AppUpdateRelease>()
    for (index in 0 until releases.length()) {
        val release = releases.optJSONObject(index) ?: continue
        val parsed = parseAppUpdateRelease(release) ?: continue
        compatibleReleases += parsed
    }
    val latest = compatibleReleases.maxWithOrNull { left, right ->
        compareMobileVersions(left.version, right.version)
    }
    return if (latest == null) {
        AppUpdateCheckResult.Unavailable(
            "В последних GitHub Releases не найден APK приложения с контрольной суммой SHA-256",
        )
    } else if (compareMobileVersions(latest.version, currentVersion) > 0) {
        AppUpdateCheckResult.Available(latest)
    } else {
        AppUpdateCheckResult.UpToDate
    }
}

internal fun parseAppUpdateRelease(release: JSONObject): AppUpdateRelease? {
    if (release.optBoolean("draft", false)) return null
    val tag = release.optString("tag_name").trim()
    val assets = release.optJSONArray("assets") ?: return null
    val apkAssets = mutableListOf<JSONObject>()
    for (index in 0 until assets.length()) {
        val asset = assets.optJSONObject(index) ?: continue
        val name = asset.optString("name").trim()
        if (name.startsWith("xkeen-mobile", ignoreCase = true) &&
            name.endsWith(".apk", ignoreCase = true)
        ) {
            apkAssets += asset
        }
    }
    val versionedApk = apkAssets
        .mapNotNull { asset ->
            normalizeMobileVersion(asset.optString("name"))?.let { version -> version to asset }
        }
        .maxWithOrNull { left, right -> compareMobileVersions(left.first, right.first) }
    val apkAsset = versionedApk?.second
        ?: apkAssets.firstOrNull { it.optString("name").equals("xkeen-mobile-beta.apk", ignoreCase = true) }
        ?: apkAssets.firstOrNull()
        ?: return null
    val body = release.optString("body").trim()
    // Repository tags version the whole Xkeen UI release (for example v2.5.0), not necessarily
    // the Android APK. Prefer a versioned APK name, then the explicit Android heading used by
    // existing release notes; never compare the panel tag with the mobile version.
    val version = versionedApk?.first
        ?: body.lineSequence()
            .filter { it.contains("Android", ignoreCase = true) }
            .mapNotNull(::normalizeMobileVersion)
            .firstOrNull()
        ?: return null
    val checksum = (0 until assets.length())
        .mapNotNull(assets::optJSONObject)
        .firstOrNull { asset ->
            asset.optString("name").equals(
                "${apkAsset.optString("name")}.sha256",
                ignoreCase = true,
            )
        }
        ?: return null
    val apkUrl = apkAsset.optString("browser_download_url").trim()
    val checksumUrl = checksum.optString("browser_download_url").trim()
    if (!isAllowedGitHubUrl(apkUrl) || !isAllowedGitHubUrl(checksumUrl)) return null
    val apkSize = apkAsset.optLong("size", 0L)
    if (apkSize !in 1..MAX_APK_BYTES) return null
    val releaseUrl = release.optString("html_url").trim()
        .takeIf(::isAllowedGitHubUrl)
        ?: GITHUB_MOBILE_REPOSITORY_URL
    return AppUpdateRelease(
        tagName = tag,
        version = version,
        title = release.optString("name").trim().ifBlank { "Xkeen Mobile $version" },
        notes = body.take(8_000),
        releaseUrl = releaseUrl,
        apkUrl = apkUrl,
        apkName = apkAsset.optString("name").trim(),
        apkSizeBytes = apkSize,
        publishedAt = release.optString("published_at").trim(),
        isPrerelease = release.optBoolean("prerelease", false),
        checksumUrl = checksumUrl,
    )
}

internal fun normalizeMobileVersion(raw: String): String? {
    val withoutApkExtension = raw.substringBefore('?')
        .replace(Regex("(?i)\\.apk(?:\\.sha256)?$"), "")
    val match = Regex(
        "(\\d+)\\.(\\d+)(?:\\.(\\d+))?(?:-([0-9A-Za-z.-]+))?(?:\\+([0-9A-Za-z.-]+))?",
    ).find(withoutApkExtension) ?: return null
    val major = match.groupValues[1].toIntOrNull() ?: return null
    val minor = match.groupValues[2].toIntOrNull() ?: return null
    val patch = match.groupValues[3].ifBlank { "0" }.toIntOrNull() ?: return null
    val prerelease = match.groupValues[4].takeIf(String::isNotBlank)?.let { "-$it" }.orEmpty()
    val build = match.groupValues[5].takeIf(String::isNotBlank)?.let { "+$it" }.orEmpty()
    return "$major.$minor.$patch$prerelease$build"
}

/** Semver comparison that keeps beta/rc identifiers ordered below the final release. */
internal fun compareMobileVersions(leftRaw: String, rightRaw: String): Int {
    val left = normalizeMobileVersion(leftRaw) ?: return 0
    val right = normalizeMobileVersion(rightRaw) ?: return 0
    val leftParts = left.substringBefore('+').split('-', limit = 2)
    val rightParts = right.substringBefore('+').split('-', limit = 2)
    val leftNumbers = leftParts[0].split('.').map(String::toInt)
    val rightNumbers = rightParts[0].split('.').map(String::toInt)
    for (index in 0..2) {
        val result = leftNumbers[index].compareTo(rightNumbers[index])
        if (result != 0) return result
    }
    val leftPre = leftParts.getOrNull(1)
    val rightPre = rightParts.getOrNull(1)
    if (leftPre == null && rightPre == null) return 0
    if (leftPre == null) return 1
    if (rightPre == null) return -1
    return comparePrerelease(leftPre, rightPre)
}

private fun comparePrerelease(left: String, right: String): Int {
    val leftParts = left.split('.')
    val rightParts = right.split('.')
    for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
        val l = leftParts.getOrNull(index) ?: return -1
        val r = rightParts.getOrNull(index) ?: return 1
        val lNumber = l.toIntOrNull()
        val rNumber = r.toIntOrNull()
        val result = when {
            lNumber != null && rNumber != null -> lNumber.compareTo(rNumber)
            lNumber != null -> -1
            rNumber != null -> 1
            else -> l.lowercase(Locale.ROOT).compareTo(r.lowercase(Locale.ROOT))
        }
        if (result != 0) return result
    }
    return 0
}

private suspend fun fetchText(urlValue: String, maxBytes: Long): String {
    val connection = openGitHubConnection(
        urlValue = urlValue,
        accept = "application/vnd.github+json",
        userAgent = "Xkeen-Mobile-Update-Checker",
    )
    try {
        val code = connection.responseCode
        if (code !in 200..299) throw IOException("GitHub API недоступен (HTTP $code)")
        val contentLength = connection.contentLengthLong
        if (contentLength > maxBytes) throw IOException("Ответ GitHub API слишком большой")
        val bytes = connection.inputStream.use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8_192)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > maxBytes) throw IOException("Ответ GitHub API слишком большой")
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        return bytes.toString(Charsets.UTF_8)
    } finally {
        connection.disconnect()
    }
}

private fun openGitHubConnection(
    urlValue: String,
    accept: String,
    userAgent: String,
): HttpURLConnection {
    var currentUrl = requireAllowedGitHubUrl(urlValue, "GitHub")
    repeat(MAX_UPDATE_REDIRECTS + 1) { redirectCount ->
        val connection = (currentUrl.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = UPDATE_CONNECT_TIMEOUT_MILLIS
            readTimeout = UPDATE_READ_TIMEOUT_MILLIS
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("User-Agent", userAgent)
            setRequestProperty("Accept", accept)
        }
        val code = connection.responseCode
        if (code !in setOf(301, 302, 303, 307, 308)) return connection
        val location = connection.getHeaderField("Location")?.trim().orEmpty()
        connection.disconnect()
        if (location.isBlank()) throw IOException("GitHub вернул редирект без адреса")
        if (redirectCount >= MAX_UPDATE_REDIRECTS) {
            throw IOException("GitHub вернул слишком много редиректов")
        }
        currentUrl = requireAllowedGitHubUrl(URL(currentUrl, location).toString(), "редиректа")
    }
    throw IOException("GitHub вернул слишком много редиректов")
}

private fun requireAllowedGitHubUrl(urlValue: String, label: String): URL {
    val url = runCatching { URL(urlValue) }
        .getOrElse { throw IOException("GitHub вернул некорректный адрес $label") }
    if (!isAllowedGitHubUrl(urlValue)) {
        throw IOException("GitHub вернул неподдерживаемый адрес $label")
    }
    return url
}

internal fun isAllowedGitHubUrl(urlValue: String): Boolean {
    val url = runCatching { URL(urlValue) }.getOrNull() ?: return false
    if (!url.protocol.equals("https", ignoreCase = true) || url.userInfo != null ||
        (url.port != -1 && url.port != 443)
    ) return false
    val normalized = url.host.lowercase(Locale.ROOT)
    return normalized == "github.com" || normalized.endsWith(".github.com") ||
        normalized == "githubusercontent.com" || normalized.endsWith(".githubusercontent.com")
}

private fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it) }
