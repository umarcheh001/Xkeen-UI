package io.xkeen.mobile.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatePortTest {
    @Test
    fun parsesPublishedBetaAssetFromCurrentReleaseNotesLayout() {
        val release = githubRelease(
            version = "0.3.0-beta.1",
            apkName = "xkeen-mobile-beta.apk",
            body = """
                Крупное обновление мобильного направления и первый публичный Android beta-релиз.

                ### Android beta · 0.3.0-beta.1
                - нативный компактный интерфейс для Android 9+.
            """.trimIndent(),
        )

        val parsed = parseAppUpdateRelease(release)

        assertEquals("0.3.0-beta.1", parsed?.version)
        assertEquals("xkeen-mobile-beta.apk", parsed?.apkName)
        assertEquals(
            "https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.5.0/xkeen-mobile-beta.apk.sha256",
            parsed?.checksumUrl,
        )
    }

    @Test
    fun selectsHighestMobileVersionEvenWhenReleaseOrderIsNotReliable() {
        val response = JSONArray()
            .put(githubRelease(version = "0.4.0", tag = "v2.6.0"))
            .put(githubRelease(version = "0.6.0-beta.1", tag = "v2.8.0"))
            .put(githubRelease(version = "0.5.0", tag = "v2.7.0"))
            .toString()

        val result = parseLatestCompatibleRelease(response, currentVersion = "0.3.0-beta.1")

        assertTrue(result is AppUpdateCheckResult.Available)
        assertEquals("0.6.0-beta.1", (result as AppUpdateCheckResult.Available).release.version)
    }

    @Test
    fun selectsHighestVersionedApkWhenAReleaseContainsStaleAssets() {
        val release = githubRelease(version = "0.4.0")
        val assets = release.getJSONArray("assets")
        val base = "https://github.com/umarcheh001/Xkeen-UI/releases/download/v2.5.0"
        assets.put(
            JSONObject()
                .put("name", "xkeen-mobile-0.5.0.apk")
                .put("size", 66_774_270L)
                .put("browser_download_url", "$base/xkeen-mobile-0.5.0.apk"),
        )
        assets.put(
            JSONObject()
                .put("name", "xkeen-mobile-0.5.0.apk.sha256")
                .put("size", 88L)
                .put("browser_download_url", "$base/xkeen-mobile-0.5.0.apk.sha256"),
        )

        val parsed = parseAppUpdateRelease(release)

        assertEquals("0.5.0", parsed?.version)
        assertEquals("xkeen-mobile-0.5.0.apk", parsed?.apkName)
    }

    @Test
    fun reportsUpToDateWhenPublishedMobileVersionIsNotNewer() {
        val response = JSONArray()
            .put(githubRelease(version = "0.3.0-beta.1"))
            .toString()

        assertEquals(
            AppUpdateCheckResult.UpToDate,
            parseLatestCompatibleRelease(response, currentVersion = "0.3.0-beta.1"),
        )
    }

    @Test
    fun rejectsApkWithoutMatchingChecksumOrWithUntrustedUrl() {
        val withoutChecksum = githubRelease(version = "0.4.0").apply {
            getJSONArray("assets").remove(1)
        }
        val untrusted = githubRelease(version = "0.4.0").apply {
            getJSONArray("assets").getJSONObject(0)
                .put("browser_download_url", "https://github.com.attacker.example/xkeen-mobile.apk")
        }

        assertNull(parseAppUpdateRelease(withoutChecksum))
        assertNull(parseAppUpdateRelease(untrusted))
        assertFalse(isAllowedGitHubUrl("http://github.com/owner/repo/file.apk"))
        assertFalse(isAllowedGitHubUrl("https://user@github.com/owner/repo/file.apk"))
        assertFalse(isAllowedGitHubUrl("https://github.com:444/owner/repo/file.apk"))
        assertTrue(isAllowedGitHubUrl("https://release-assets.githubusercontent.com/file.apk"))
    }

    @Test
    fun comparesSemverPrereleasesAndIgnoresBuildMetadata() {
        assertEquals("0.3.0-beta.1", normalizeMobileVersion("xkeen-mobile-0.3.0-beta.1.apk"))
        assertEquals("2.4.0+build.7", normalizeMobileVersion("v2.4+build.7"))
        assertTrue(compareMobileVersions("1.0.0", "1.0.0-rc.2") > 0)
        assertTrue(compareMobileVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0)
        assertEquals(0, compareMobileVersions("1.0.0+build.9", "1.0.0+build.2"))
    }

    @Test
    fun invalidInstalledVersionProducesExplicitUnavailableResult() {
        val result = parseLatestCompatibleRelease(
            JSONArray().put(githubRelease(version = "0.4.0")).toString(),
            currentVersion = "development",
        )

        assertTrue(result is AppUpdateCheckResult.Unavailable)
        assertTrue((result as AppUpdateCheckResult.Unavailable).message.contains("установленную версию"))
    }
}

private fun githubRelease(
    version: String,
    tag: String = "v2.5.0",
    apkName: String = "xkeen-mobile-$version.apk",
    body: String = "### Android · $version\n- Mobile changes",
): JSONObject {
    val base = "https://github.com/umarcheh001/Xkeen-UI/releases/download/$tag"
    return JSONObject()
        .put("tag_name", tag)
        .put("name", "Xkeen UI $tag + Android")
        .put("body", body)
        .put("html_url", "https://github.com/umarcheh001/Xkeen-UI/releases/tag/$tag")
        .put("published_at", "2026-07-22T13:28:28Z")
        .put("draft", false)
        .put("prerelease", '-' in version)
        .put(
            "assets",
            JSONArray()
                .put(
                    JSONObject()
                        .put("name", apkName)
                        .put("size", 66_774_270L)
                        .put("browser_download_url", "$base/$apkName"),
                )
                .put(
                    JSONObject()
                        .put("name", "$apkName.sha256")
                        .put("size", 88L)
                        .put("browser_download_url", "$base/$apkName.sha256"),
                ),
        )
}
